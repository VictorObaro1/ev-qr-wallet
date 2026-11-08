import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import { loadConfig, AppConfig } from '../src/config.js';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import { PaystackService } from '../src/services/paystack.js';
import { RidePayService } from '../src/services/ridepay.js';

describe('Step 2: Core RidePay Domain Service & Paystack Integration', () => {
  let pool: pg.Pool;
  let config: AppConfig;
  let tokenService: TokenService;
  let paystack: PaystackService;
  let ridepay: RidePayService;

  beforeEach(async () => {
    config = {
      ...loadConfig(),
      databaseUrl: 'memory',
      swapPriceNgn: 750,
      minPassQuantity: 2,
      maxPassQuantity: 10,
      orderExpiryMinutes: 30,
      passValidityDays: 30,
      verifyRiderMaxFailedPerMin: 5,
      verifyRiderMaxTotalPerMin: 15,
    };
    pool = createPool('memory');
    await initDatabase(pool);
    tokenService = new TokenService(config.passHmacSecret);
    paystack = new PaystackService('sk_test_mock_secret_key', config.paystackBaseUrl);
    ridepay = new RidePayService(pool, config, tokenService, paystack);
  });

  it('verifies active, suspended, and unknown riders and enforces rate limiting', async () => {
    const active = await ridepay.verifyRider('rdr-0001');
    expect(active).toEqual({
      exists: true,
      rider_id: 'RDR-0001',
      display_name: 'Tunde Bakare',
      status: 'ACTIVE',
    });

    const suspended = await ridepay.verifyRider('RDR-0003');
    expect(suspended).toEqual({
      exists: true,
      rider_id: 'RDR-0003',
      display_name: 'Sadiq Bello',
      status: 'SUSPENDED',
    });

    // 5 failed lookups allowed, 6th failed lookup triggers RATE_LIMITED
    for (let i = 1; i <= 5; i++) {
      const unknown = await ridepay.verifyRider(`RDR-999${i}`);
      expect(unknown.exists).toBe(false);
    }

    await expect(ridepay.verifyRider('RDR-9999')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });

  it('enforces order creation rules (unknown rider, suspended rider, quantity bounds, idempotency)', async () => {
    // Unknown rider
    await expect(
      ridepay.createSwapPassOrder({
        rider_id: 'RDR-9999',
        quantity: 2,
        idempotency_key: 'idem-unknown',
      })
    ).rejects.toMatchObject({ code: 'RIDER_NOT_FOUND', retryable: false });

    // Suspended rider
    await expect(
      ridepay.createSwapPassOrder({
        rider_id: 'RDR-0003',
        quantity: 2,
        idempotency_key: 'idem-suspended',
      })
    ).rejects.toMatchObject({ code: 'RIDER_SUSPENDED', retryable: false });

    // Quantity below 2
    await expect(
      ridepay.createSwapPassOrder({
        rider_id: 'RDR-0001',
        quantity: 1,
        idempotency_key: 'idem-qty-low',
      })
    ).rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE', retryable: false });

    // Quantity above 10
    await expect(
      ridepay.createSwapPassOrder({
        rider_id: 'RDR-0001',
        quantity: 11,
        idempotency_key: 'idem-qty-high',
      })
    ).rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE', retryable: false });

    // Valid order & idempotency retry returns exact same order_id and account_number
    const order1 = await ridepay.createSwapPassOrder({
      rider_id: 'RDR-0001',
      quantity: 3,
      idempotency_key: 'idem-valid-3',
    });
    expect(order1.amount_ngn).toBe(2250);
    expect(order1.status).toBe('PENDING_PAYMENT');

    const order1Duplicate = await ridepay.createSwapPassOrder({
      rider_id: 'RDR-0001',
      quantity: 3,
      idempotency_key: 'idem-valid-3',
    });
    expect(order1Duplicate.order_id).toBe(order1.order_id);
    expect(order1Duplicate.account_number).toBe(order1.account_number);
  });

  it('completes the full happy path: order -> webhook payment -> issue pass once -> redeem -> balance', async () => {
    const order = await ridepay.createSwapPassOrder({
      rider_id: 'RDR-0001',
      quantity: 2,
      idempotency_key: 'happy-1',
    });

    // Before payment, get_order_status returns PENDING_PAYMENT (never trusts "I paid")
    const pendingStatus = await ridepay.getOrderStatus(order.order_id);
    expect(pendingStatus.status).toBe('PENDING_PAYMENT');
    expect(pendingStatus.pass_id).toBeUndefined();

    // Simulate Paystack charge.success webhook for exact amount (1500 NGN = 150000 kobo)
    const webhookRes = await ridepay.handlePaystackWebhook({
      event: 'charge.success',
      data: {
        reference: `rp_${order.order_id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
        amount: 150000,
        metadata: { order_id: order.order_id },
      },
    });
    expect(webhookRes.status).toBe('PAID');

    // Calling get_order_status issues the pass transactionally and moves to PASS_ISSUED
    const issuedStatus1 = await ridepay.getOrderStatus(order.order_id);
    expect(issuedStatus1.status).toBe('PASS_ISSUED');
    expect(issuedStatus1.pass_id).toBeDefined();
    expect(issuedStatus1.qr_payload?.startsWith('RPP1.')).toBe(true);
    expect(issuedStatus1.remaining_uses).toBe(2);

    // Calling get_order_status a second time returns the exact same pass (issue-once guarantee)
    const issuedStatus2 = await ridepay.getOrderStatus(order.order_id);
    expect(issuedStatus2.pass_id).toBe(issuedStatus1.pass_id);
    expect(issuedStatus2.qr_payload).toBe(issuedStatus1.qr_payload);

    const qrToken = issuedStatus1.qr_payload!;

    // First station scan -> OK, 1 remaining
    const scan1 = await ridepay.redeemPass({
      token: qrToken,
      station_id: 'STN-LAGOS-01',
      scan_id: 'SCAN-001',
    });
    expect(scan1).toEqual({
      result: 'OK',
      remaining: 1,
      scan_id: 'SCAN-001',
    });

    // Retrying the exact same scan_id is idempotent (does not decrement again!)
    const scan1Retry = await ridepay.redeemPass({
      token: qrToken,
      station_id: 'STN-LAGOS-01',
      scan_id: 'SCAN-001',
    });
    expect(scan1Retry).toEqual({
      result: 'OK',
      remaining: 1,
      scan_id: 'SCAN-001',
      idempotent_replay: true,
    });

    // Check rider pass balance via get_pass_balance -> 1 remaining
    const balanceMid = await ridepay.getPassBalance('RDR-0001');
    expect(balanceMid.total_remaining).toBe(1);
    expect(balanceMid.active_passes).toHaveLength(1);

    // Second station scan -> OK, 0 remaining
    const scan2 = await ridepay.redeemPass({
      token: qrToken,
      station_id: 'STN-LAGOS-01',
      scan_id: 'SCAN-002',
    });
    expect(scan2).toEqual({
      result: 'OK',
      remaining: 0,
      scan_id: 'SCAN-002',
    });

    // Third station scan -> EXHAUSTED, 0 remaining
    const scan3 = await ridepay.redeemPass({
      token: qrToken,
      station_id: 'STN-LAGOS-01',
      scan_id: 'SCAN-003',
    });
    expect(scan3).toEqual({
      result: 'EXHAUSTED',
      remaining: 0,
      scan_id: 'SCAN-003',
    });

    // Balance now shows 0 active passes and 0 total_remaining
    const balanceEnd = await ridepay.getPassBalance('RDR-0001');
    expect(balanceEnd.total_remaining).toBe(0);
    expect(balanceEnd.active_passes).toHaveLength(0);
  });

  it('handles AMOUNT_MISMATCH, EXPIRED orders, late payments after expiry, and INVALID/REVOKED tokens', async () => {
    // 1. AMOUNT_MISMATCH: Rider pays 1000 NGN instead of 1500 NGN
    const mismatchOrder = await ridepay.createSwapPassOrder({
      rider_id: 'RDR-0001',
      quantity: 2,
      idempotency_key: 'mismatch-1',
    });

    await ridepay.handlePaystackWebhook({
      event: 'charge.success',
      data: {
        reference: 'any',
        amount: 100000, // 1000 NGN instead of 1500 NGN
        metadata: { order_id: mismatchOrder.order_id },
      },
    });

    const mismatchStatus = await ridepay.getOrderStatus(mismatchOrder.order_id);
    expect(mismatchStatus.status).toBe('AMOUNT_MISMATCH');
    expect(mismatchStatus.amount_ngn).toBe(1500);
    expect(mismatchStatus.amount_paid_ngn).toBe(1000);
    expect(mismatchStatus.pass_id).toBeUndefined();

    // 2. EXPIRED order & late payment after expiry
    const expiredOrder = await ridepay.createSwapPassOrder({
      rider_id: 'RDR-0002',
      quantity: 2,
      idempotency_key: 'expired-1',
    });

    // Force order expires_at into the past
    await pool.query(
      `UPDATE swap_orders SET expires_at = $1 WHERE order_id = $2`,
      [new Date(Date.now() - 60_000).toISOString(), expiredOrder.order_id]
    );

    const unpaidExpiredStatus = await ridepay.getOrderStatus(expiredOrder.order_id);
    expect(unpaidExpiredStatus.status).toBe('EXPIRED');
    expect(unpaidExpiredStatus.amount_paid_ngn).toBe(0);

    // Now money arrives late via webhook on the expired order
    const lateWebhook = await ridepay.handlePaystackWebhook({
      event: 'charge.success',
      data: {
        reference: 'any',
        amount: 150000,
        metadata: { order_id: expiredOrder.order_id },
      },
    });
    expect(lateWebhook.status).toBe('EXPIRED');
    expect(lateWebhook.reason).toBe('LATE_PAYMENT_AFTER_EXPIRY');

    const latePaidExpiredStatus = await ridepay.getOrderStatus(expiredOrder.order_id);
    expect(latePaidExpiredStatus.status).toBe('EXPIRED');
    expect(latePaidExpiredStatus.amount_paid_ngn).toBe(1500);
    expect(latePaidExpiredStatus.pass_id).toBeUndefined();

    // 3. INVALID token scan at station
    const invalidScan = await ridepay.redeemPass({
      token: 'RPP1.fake_pass_id.invalid_mac_1234',
      station_id: 'STN-LAGOS-01',
      scan_id: 'SCAN-BAD-1',
    });
    expect(invalidScan).toEqual({
      result: 'INVALID',
      remaining: 0,
      scan_id: 'SCAN-BAD-1',
    });
  });

  it('handles Paystack API fallback (/charge 400 -> /transaction/initialize 200) and 503 PAYSTACK_UNAVAILABLE', async () => {
    // Mock fetch where /charge returns 400 and /transaction/initialize returns 200
    const mockFetchFallback = (async (url: string) => {
      if (url.endsWith('/charge')) {
        return new Response(JSON.stringify({ status: false, message: 'Pay with Transfer not enabled' }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          status: true,
          data: { reference: 'pstk_real_ref_001', authorization_url: 'https://checkout.paystack.com/test' },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const livePaystack = new PaystackService('sk_test_real_key_12345', 'https://api.paystack.co', mockFetchFallback);
    const charge = await livePaystack.createBankTransferCharge({
      orderId: 'ORD-TEST1',
      riderId: 'RDR-0001',
      amountKobo: 150000,
      expiresAt: new Date(Date.now() + 1800_000),
    });
    expect(charge.paystackRef).toBe('pstk_real_ref_001');
    expect(charge.bankName).toBe('Paystack-Titan');
    expect(charge.accountNumber).toHaveLength(10);

    // Mock fetch where Paystack returns 503 Service Unavailable
    const mockFetch503 = (async () => {
      return new Response('Service Unavailable', { status: 503 });
    }) as unknown as typeof fetch;

    const downPaystack = new PaystackService('sk_test_real_key_12345', 'https://api.paystack.co', mockFetch503);
    await expect(
      downPaystack.createBankTransferCharge({
        orderId: 'ORD-TEST2',
        riderId: 'RDR-0001',
        amountKobo: 150000,
        expiresAt: new Date(Date.now() + 1800_000),
      })
    ).rejects.toMatchObject({
      code: 'PAYSTACK_UNAVAILABLE',
      retryable: true,
    });
  });
});
