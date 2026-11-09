import crypto from 'crypto';
import pg from 'pg';
import { AppConfig } from '../config.js';
import { StructuredToolError } from '../errors.js';
import { PaystackService } from './paystack.js';
import { TokenService } from './token.js';

/**
 * Formats a Date into an ISO-8601 string in Nigeria / West Africa Time (UTC+01:00)
 * so timestamps match the rider's local Lagos clock (e.g. 2026-11-08T21:05:00.000+01:00).
 */
export function toLagosIsoString(input: Date | string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const watMs = date.getTime() + 60 * 60_000; // UTC+1
  return new Date(watMs).toISOString().replace('Z', '+01:00');
}

export interface VerifyRiderOutput {
  exists: boolean;
  rider_id: string;
  display_name?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}

export interface CreateOrderInput {
  rider_id: string;
  quantity: number;
  idempotency_key: string;
}

export interface CreateOrderOutput {
  order_id: string;
  rider_id: string;
  quantity: number;
  amount_ngn: number;
  bank_name: string;
  account_number: string;
  expires_at: string;
  status: 'PENDING_PAYMENT';
}

export type OrderStatusValue =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PASS_ISSUED'
  | 'EXPIRED'
  | 'AMOUNT_MISMATCH'
  | 'FAILED';

export interface GetOrderStatusOutput {
  order_id: string;
  status: OrderStatusValue;
  amount_ngn: number;
  amount_paid_ngn: number;
  passes_purchased: number;
  expires_at?: string;
  pass_id?: string;
  qr_payload?: string;
  qr_image_url?: string;
  remaining_uses?: number;
  pass_expires_at?: string;
}

export interface ActivePassSummary {
  pass_id: string;
  qr_payload: string;
  qr_image_url: string;
  remaining_uses: number;
  total_uses: number;
  expires_at: string;
}

export interface ExhaustedPassSummary {
  pass_id: string;
  total_uses: number;
  remaining_uses: number;
  status: 'EXHAUSTED';
}

export interface RecentRedemptionSummary {
  pass_id: string;
  station_id: string;
  scan_id: string;
  result: string;
  redeemed_at: string;
}

export interface GetPassBalanceOutput {
  rider_id: string;
  active_passes: ActivePassSummary[];
  total_remaining: number;
  exhausted_passes?: ExhaustedPassSummary[];
  recent_redemptions?: RecentRedemptionSummary[];
}

export type RedeemResultCode = 'OK' | 'EXHAUSTED' | 'EXPIRED' | 'INVALID' | 'REVOKED';

export interface RedeemPassInput {
  token: string;
  station_id: string;
  scan_id: string;
}

export interface RedeemPassOutput {
  result: RedeemResultCode;
  remaining: number;
  scan_id: string;
  idempotent_replay?: boolean;
}

export class RidePayService {
  private readonly pool: pg.Pool;
  private readonly config: AppConfig;
  private readonly tokenService: TokenService;
  private readonly paystack: PaystackService;

  // Sliding window timestamps (in ms) for verify_rider rate limiting
  private totalLookupTimestamps: number[] = [];
  private failedLookupTimestamps: number[] = [];

  constructor(
    pool: pg.Pool,
    config: AppConfig,
    tokenService: TokenService,
    paystack: PaystackService
  ) {
    this.pool = pool;
    this.config = config;
    this.tokenService = tokenService;
    this.paystack = paystack;
  }

  public resetRateLimits(): void {
    this.totalLookupTimestamps = [];
    this.failedLookupTimestamps = [];
  }

  private checkVerifyRateLimit(): void {
    const now = Date.now();
    const windowStart = now - 60_000;

    this.totalLookupTimestamps = this.totalLookupTimestamps.filter((ts) => ts > windowStart);
    this.failedLookupTimestamps = this.failedLookupTimestamps.filter((ts) => ts > windowStart);

    if (
      this.failedLookupTimestamps.length >= this.config.verifyRiderMaxFailedPerMin ||
      this.totalLookupTimestamps.length >= this.config.verifyRiderMaxTotalPerMin
    ) {
      throw new StructuredToolError(
        'RATE_LIMITED',
        'Too many rider lookup attempts in the last minute. Please wait a moment and try again.',
        true
      );
    }

    this.totalLookupTimestamps.push(now);
  }

  /**
   * 6.1 verify_rider
   */
  public async verifyRider(riderId: string): Promise<VerifyRiderOutput> {
    if (!riderId || typeof riderId !== 'string' || !riderId.trim()) {
      throw new StructuredToolError('INVALID_INPUT', 'rider_id is required.', false);
    }

    this.checkVerifyRateLimit();

    const normalizedId = riderId.trim().toUpperCase();
    const res = await this.pool.query(
      'SELECT rider_id, display_name, status FROM riders WHERE rider_id = $1',
      [normalizedId]
    );

    if (res.rowCount === 0) {
      this.failedLookupTimestamps.push(Date.now());
      return {
        exists: false,
        rider_id: normalizedId,
      };
    }

    const row = res.rows[0];
    return {
      exists: true,
      rider_id: row.rider_id,
      display_name: row.display_name,
      status: row.status,
    };
  }

  /**
   * 6.2 create_swap_pass_order
   */
  public async createSwapPassOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
    if (!input.rider_id || typeof input.rider_id !== 'string') {
      throw new StructuredToolError('INVALID_INPUT', 'rider_id is required.', false);
    }
    if (!input.idempotency_key || typeof input.idempotency_key !== 'string') {
      throw new StructuredToolError('INVALID_INPUT', 'idempotency_key is required.', false);
    }

    const normalizedRiderId = input.rider_id.trim().toUpperCase();
    const quantity = Number(input.quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < this.config.minPassQuantity ||
      quantity > this.config.maxPassQuantity
    ) {
      throw new StructuredToolError(
        'QUANTITY_OUT_OF_RANGE',
        `Pass quantity must be a whole number between ${this.config.minPassQuantity} and ${this.config.maxPassQuantity}.`,
        false
      );
    }

    // Verify rider exists and is ACTIVE
    const riderRes = await this.pool.query(
      'SELECT rider_id, status FROM riders WHERE rider_id = $1',
      [normalizedRiderId]
    );

    if (riderRes.rowCount === 0) {
      throw new StructuredToolError(
        'RIDER_NOT_FOUND',
        `Rider ${normalizedRiderId} does not exist.`,
        false
      );
    }

    const rider = riderRes.rows[0];
    if (rider.status !== 'ACTIVE') {
      throw new StructuredToolError(
        'RIDER_SUSPENDED',
        `Rider ${normalizedRiderId} is suspended and cannot purchase swap passes.`,
        false
      );
    }

    const rawIdemKey = input.idempotency_key.trim();
    let effectiveIdemKey = rawIdemKey;

    // Check existing order with this idempotency_key
    const existingRes = await this.pool.query(
      `SELECT order_id, rider_id, quantity, amount_kobo, bank_name, account_number, status, expires_at
       FROM swap_orders
       WHERE idempotency_key = $1`,
      [rawIdemKey]
    );

    if (existingRes.rowCount && existingRes.rowCount > 0) {
      const existing = existingRes.rows[0];
      const isUnexpiredPending =
        existing.status === 'PENDING_PAYMENT' &&
        new Date(existing.expires_at).getTime() > Date.now();

      if (
        isUnexpiredPending &&
        existing.rider_id === normalizedRiderId &&
        Number(existing.quantity) === quantity
      ) {
        return {
          order_id: existing.order_id,
          rider_id: existing.rider_id,
          quantity: Number(existing.quantity),
          amount_ngn: Number(existing.amount_kobo) / 100,
          bank_name: existing.bank_name,
          account_number: existing.account_number,
          expires_at: toLagosIsoString(existing.expires_at),
          status: 'PENDING_PAYMENT',
        };
      }

      // If the LLM reused an idempotency key from an already-completed, expired, or different order,
      // rotate the stored key so a fresh purchase is not blocked by UNIQUE(idempotency_key).
      effectiveIdemKey = `${rawIdemKey}_${crypto.randomBytes(4).toString('hex')}`;
    }

    const amountNgn = quantity * this.config.swapPriceNgn;
    const amountKobo = amountNgn * 100;
    const orderId = `ORD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + this.config.orderExpiryMinutes * 60_000);

    const charge = await this.paystack.createBankTransferCharge({
      orderId,
      riderId: normalizedRiderId,
      amountKobo,
      expiresAt,
    });

    await this.pool.query(
      `INSERT INTO swap_orders (
        order_id, rider_id, quantity, amount_kobo, amount_paid_kobo,
        bank_name, account_number, idempotency_key, paystack_ref, status, expires_at
      ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, 'PENDING_PAYMENT', $9)`,
      [
        orderId,
        normalizedRiderId,
        quantity,
        amountKobo,
        charge.bankName,
        charge.accountNumber,
        effectiveIdemKey,
        charge.paystackRef,
        expiresAt.toISOString(),
      ]
    );

    return {
      order_id: orderId,
      rider_id: normalizedRiderId,
      quantity,
      amount_ngn: amountNgn,
      bank_name: charge.bankName,
      account_number: charge.accountNumber,
      expires_at: toLagosIsoString(expiresAt),
      status: 'PENDING_PAYMENT',
    };
  }

  /**
   * Processes a verified Paystack webhook payload (charge.success).
   */
  public async handlePaystackWebhook(payload: any): Promise<{
    handled: boolean;
    order_id?: string;
    status?: OrderStatusValue;
    reason?: string;
  }> {
    if (!payload || payload.event !== 'charge.success' || !payload.data) {
      return { handled: false, reason: 'UNSUPPORTED_EVENT' };
    }

    const reference = String(payload.data.reference || '');
    const metadataOrderId = String(payload.data.metadata?.order_id || '');
    const amountPaidKobo = Number(payload.data.amount || 0);

    const res = await this.pool.query(
      `SELECT order_id, rider_id, quantity, amount_kobo, status, expires_at
       FROM swap_orders
       WHERE paystack_ref = $1 OR order_id = $2`,
      [reference, metadataOrderId]
    );

    if (res.rowCount === 0) {
      return { handled: false, reason: 'ORDER_NOT_FOUND' };
    }

    const order = res.rows[0];

    // Idempotent if already PAID or PASS_ISSUED
    if (order.status === 'PASS_ISSUED' || order.status === 'PAID') {
      return {
        handled: true,
        order_id: order.order_id,
        status: order.status as OrderStatusValue,
      };
    }

    const isExpired =
      order.status === 'EXPIRED' ||
      new Date(order.expires_at).getTime() <= Date.now();

    // Late payment on an expired transfer window: record amount_paid_kobo and keep EXPIRED (never issue pass)
    if (isExpired) {
      await this.pool.query(
        `UPDATE swap_orders
         SET status = 'EXPIRED', amount_paid_kobo = $1
         WHERE order_id = $2`,
        [amountPaidKobo, order.order_id]
      );
      return {
        handled: true,
        order_id: order.order_id,
        status: 'EXPIRED',
        reason: 'LATE_PAYMENT_AFTER_EXPIRY',
      };
    }

    // Wrong amount paid: transition to AMOUNT_MISMATCH (never issue pass)
    if (amountPaidKobo !== Number(order.amount_kobo)) {
      await this.pool.query(
        `UPDATE swap_orders
         SET status = 'AMOUNT_MISMATCH', amount_paid_kobo = $1
         WHERE order_id = $2`,
        [amountPaidKobo, order.order_id]
      );
      return {
        handled: true,
        order_id: order.order_id,
        status: 'AMOUNT_MISMATCH',
      };
    }

    // Exact payment within valid window -> mark PAID
    await this.pool.query(
      `UPDATE swap_orders
       SET status = 'PAID', amount_paid_kobo = $1
       WHERE order_id = $2`,
      [amountPaidKobo, order.order_id]
    );

    return {
      handled: true,
      order_id: order.order_id,
      status: 'PAID',
    };
  }

  /**
   * 6.3 get_order_status
   * Issues the pass exactly once when status first becomes PAID and transitions to PASS_ISSUED.
   */
  public async getOrderStatus(orderId: string): Promise<GetOrderStatusOutput> {
    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      throw new StructuredToolError('INVALID_INPUT', 'order_id is required.', false);
    }

    const normalizedOrderId = orderId.trim().toUpperCase();
    const res = await this.pool.query(
      `SELECT order_id, rider_id, quantity, amount_kobo, amount_paid_kobo, paystack_ref, status, expires_at
       FROM swap_orders
       WHERE order_id = $1`,
      [normalizedOrderId]
    );

    if (res.rowCount === 0) {
      throw new StructuredToolError(
        'ORDER_NOT_FOUND',
        `Order ${normalizedOrderId} does not exist.`,
        false
      );
    }

    let order = res.rows[0];

    // If still PENDING_PAYMENT, re-check Paystack once (covers delayed/missed webhook)
    if (order.status === 'PENDING_PAYMENT' && order.paystack_ref) {
      const verified = await this.paystack.verifyTransaction(order.paystack_ref);
      if (verified && verified.status === 'success') {
        await this.handlePaystackWebhook({
          event: 'charge.success',
          data: {
            reference: order.paystack_ref,
            amount: verified.amountKobo,
            metadata: { order_id: order.order_id },
          },
        });
        const refreshed = await this.pool.query(
          `SELECT order_id, rider_id, quantity, amount_kobo, amount_paid_kobo, paystack_ref, status, expires_at
           FROM swap_orders
           WHERE order_id = $1`,
          [normalizedOrderId]
        );
        order = refreshed.rows[0];
      }
    }

    // Lazy expiry check if still PENDING_PAYMENT past expires_at
    if (
      order.status === 'PENDING_PAYMENT' &&
      new Date(order.expires_at).getTime() <= Date.now()
    ) {
      await this.pool.query(
        `UPDATE swap_orders
         SET status = 'EXPIRED'
         WHERE order_id = $1 AND status = 'PENDING_PAYMENT'`,
        [order.order_id]
      );
      order.status = 'EXPIRED';
    }

    // If PAID or PASS_ISSUED, ensure pass is issued exactly once (transactional)
    if (order.status === 'PAID' || order.status === 'PASS_ISSUED') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        let passRes = await client.query(
          `SELECT pass_id, total_uses, remaining, status, expires_at
           FROM passes
           WHERE order_id = $1`,
          [order.order_id]
        );

        if (passRes.rowCount === 0) {
          const newPassId = this.tokenService.generatePassId();
          const passExpiresAt = new Date(
            Date.now() + this.config.passValidityDays * 86_400_000
          );

          await client.query(
            `INSERT INTO passes (pass_id, order_id, rider_id, total_uses, remaining, status, expires_at)
             VALUES ($1, $2, $3, $4, $4, 'ACTIVE', $5)
             ON CONFLICT (order_id) DO NOTHING`,
            [
              newPassId,
              order.order_id,
              order.rider_id,
              Number(order.quantity),
              passExpiresAt.toISOString(),
            ]
          );

          passRes = await client.query(
            `SELECT pass_id, total_uses, remaining, status, expires_at
             FROM passes
             WHERE order_id = $1`,
            [order.order_id]
          );
        }

        if (order.status !== 'PASS_ISSUED') {
          await client.query(
            `UPDATE swap_orders SET status = 'PASS_ISSUED' WHERE order_id = $1`,
            [order.order_id]
          );
          order.status = 'PASS_ISSUED';
        }

        await client.query('COMMIT');

        const pass = passRes.rows[0];
        const qrPayload = this.tokenService.createToken(pass.pass_id);
        const qrImageUrl = `${this.config.publicBaseUrl}/v1/passes/${encodeURIComponent(
          pass.pass_id
        )}/qr.png`;

        return {
          order_id: order.order_id,
          status: 'PASS_ISSUED',
          amount_ngn: Number(order.amount_kobo) / 100,
          amount_paid_ngn: Number(order.amount_paid_kobo) / 100,
          passes_purchased: Number(order.quantity),
          pass_id: pass.pass_id,
          qr_payload: qrPayload,
          qr_image_url: qrImageUrl,
          remaining_uses: Number(pass.remaining),
          pass_expires_at: toLagosIsoString(pass.expires_at),
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return {
      order_id: order.order_id,
      status: order.status as OrderStatusValue,
      amount_ngn: Number(order.amount_kobo) / 100,
      amount_paid_ngn: Number(order.amount_paid_kobo) / 100,
      passes_purchased: Number(order.quantity),
      expires_at: toLagosIsoString(order.expires_at),
    };
  }

  /**
   * 6.4 get_pass_balance
   */
  public async getPassBalance(riderId: string): Promise<GetPassBalanceOutput> {
    if (!riderId || typeof riderId !== 'string' || !riderId.trim()) {
      throw new StructuredToolError('INVALID_INPUT', 'rider_id is required.', false);
    }

    const normalizedRiderId = riderId.trim().toUpperCase();
    const riderRes = await this.pool.query(
      'SELECT rider_id FROM riders WHERE rider_id = $1',
      [normalizedRiderId]
    );

    if (riderRes.rowCount === 0) {
      throw new StructuredToolError(
        'RIDER_NOT_FOUND',
        `Rider ${normalizedRiderId} does not exist.`,
        false
      );
    }

    const nowIso = new Date().toISOString();

    // Mark any expired passes for this rider
    await this.pool.query(
      `UPDATE passes
       SET status = 'EXPIRED'
       WHERE rider_id = $1 AND status = 'ACTIVE' AND expires_at <= $2`,
      [normalizedRiderId, nowIso]
    );

    const passesRes = await this.pool.query(
      `SELECT pass_id, total_uses, remaining, expires_at
       FROM passes
       WHERE rider_id = $1 AND status = 'ACTIVE' AND remaining > 0 AND expires_at > $2
       ORDER BY created_at ASC`,
      [normalizedRiderId, nowIso]
    );

    const activePasses: ActivePassSummary[] = passesRes.rows.map((row) => ({
      pass_id: row.pass_id,
      qr_payload: this.tokenService.createToken(row.pass_id),
      qr_image_url: `${this.config.publicBaseUrl}/v1/passes/${encodeURIComponent(
        row.pass_id
      )}/qr.png`,
      remaining_uses: Number(row.remaining),
      total_uses: Number(row.total_uses),
      expires_at: toLagosIsoString(row.expires_at),
    }));

    const totalRemaining = activePasses.reduce((sum, p) => sum + p.remaining_uses, 0);

    const exhaustedRes = await this.pool.query(
      `SELECT pass_id, total_uses, remaining
       FROM passes
       WHERE rider_id = $1 AND (status = 'EXHAUSTED' OR remaining = 0)
       ORDER BY created_at DESC`,
      [normalizedRiderId]
    );

    const exhaustedPasses: ExhaustedPassSummary[] = exhaustedRes.rows.map((row) => ({
      pass_id: row.pass_id,
      total_uses: Number(row.total_uses),
      remaining_uses: Number(row.remaining),
      status: 'EXHAUSTED',
    }));

    const redemptionsRes = await this.pool.query(
      `SELECT r.pass_id, r.station_id, r.scan_id, r.result, r.created_at
       FROM redemptions r
       INNER JOIN passes p ON r.pass_id = p.pass_id
       WHERE p.rider_id = $1 AND r.result = 'OK'
       ORDER BY r.created_at DESC
       LIMIT 5`,
      [normalizedRiderId]
    );

    const recentRedemptions: RecentRedemptionSummary[] = redemptionsRes.rows.map((row) => ({
      pass_id: row.pass_id,
      station_id: row.station_id,
      scan_id: row.scan_id,
      result: row.result,
      redeemed_at: toLagosIsoString(row.created_at),
    }));

    return {
      rider_id: normalizedRiderId,
      active_passes: activePasses,
      total_remaining: totalRemaining,
      exhausted_passes: exhaustedPasses,
      recent_redemptions: recentRedemptions,
    };
  }

  /**
   * 7.2 Station Redemption: POST /v1/passes/redeem
   * Strictly a station REST operation, never exposed as an MCP tool.
   */
  public async redeemPass(input: RedeemPassInput): Promise<RedeemPassOutput> {
    const token = String(input.token || '').trim();
    const stationId = String(input.station_id || '').trim();
    const scanId = String(input.scan_id || '').trim();

    if (!token || !stationId || !scanId) {
      throw new StructuredToolError(
        'INVALID_INPUT',
        'token, station_id, and scan_id are required.',
        false
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Check scan_id idempotency first
      const existingScan = await client.query(
        `SELECT scan_id, result, remaining_after
         FROM redemptions
         WHERE scan_id = $1`,
        [scanId]
      );

      if (existingScan.rowCount && existingScan.rowCount > 0) {
        await client.query('COMMIT');
        const row = existingScan.rows[0];
        return {
          result: row.result as RedeemResultCode,
          remaining: Number(row.remaining_after ?? 0),
          scan_id: row.scan_id,
          idempotent_replay: true,
        };
      }

      // 2. Verify token format and HMAC before looking up pass
      const verified = this.tokenService.verifyToken(token);
      if (!verified.valid || !verified.passId) {
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, NULL, $2, 'INVALID', 0)`,
          [scanId, stationId]
        );
        await client.query('COMMIT');
        return {
          result: 'INVALID',
          remaining: 0,
          scan_id: scanId,
        };
      }

      const passId = verified.passId;

      // 3. Look up pass row
      const passRes = await client.query(
        `SELECT pass_id, remaining, status, expires_at
         FROM passes
         WHERE pass_id = $1`,
        [passId]
      );

      if (passRes.rowCount === 0) {
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, NULL, $2, 'INVALID', 0)`,
          [scanId, stationId]
        );
        await client.query('COMMIT');
        return {
          result: 'INVALID',
          remaining: 0,
          scan_id: scanId,
        };
      }

      const pass = passRes.rows[0];
      const now = new Date();

      if (pass.status === 'REVOKED') {
        const rem = Number(pass.remaining);
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, $2, $3, 'REVOKED', $4)`,
          [scanId, passId, stationId, rem]
        );
        await client.query('COMMIT');
        return {
          result: 'REVOKED',
          remaining: rem,
          scan_id: scanId,
        };
      }

      if (new Date(pass.expires_at).getTime() <= now.getTime() || pass.status === 'EXPIRED') {
        if (pass.status !== 'EXPIRED') {
          await client.query(`UPDATE passes SET status = 'EXPIRED' WHERE pass_id = $1`, [
            passId,
          ]);
        }
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, $2, $3, 'EXPIRED', 0)`,
          [scanId, passId, stationId]
        );
        await client.query('COMMIT');
        return {
          result: 'EXPIRED',
          remaining: 0,
          scan_id: scanId,
        };
      }

      if (Number(pass.remaining) <= 0 || pass.status === 'EXHAUSTED') {
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, $2, $3, 'EXHAUSTED', 0)`,
          [scanId, passId, stationId]
        );
        await client.query('COMMIT');
        return {
          result: 'EXHAUSTED',
          remaining: 0,
          scan_id: scanId,
        };
      }

      // 4. Atomic decrement
      const decRes = await client.query(
        `UPDATE passes
         SET remaining = remaining - 1,
             status = CASE WHEN remaining - 1 = 0 THEN 'EXHAUSTED' ELSE 'ACTIVE' END
         WHERE pass_id = $1 AND status = 'ACTIVE' AND remaining > 0 AND expires_at > $2
         RETURNING remaining`,
        [passId, now.toISOString()]
      );

      if (decRes.rowCount === 0) {
        await client.query(
          `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
           VALUES ($1, $2, $3, 'EXHAUSTED', 0)`,
          [scanId, passId, stationId]
        );
        await client.query('COMMIT');
        return {
          result: 'EXHAUSTED',
          remaining: 0,
          scan_id: scanId,
        };
      }

      const remainingAfter = Number(decRes.rows[0].remaining);

      await client.query(
        `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
         VALUES ($1, $2, $3, 'OK', $4)`,
        [scanId, passId, stationId, remainingAfter]
      );

      await client.query('COMMIT');
      return {
        result: 'OK',
        remaining: remainingAfter,
        scan_id: scanId,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
