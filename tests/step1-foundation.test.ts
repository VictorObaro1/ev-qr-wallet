import { describe, it, expect, beforeEach } from 'vitest';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import pg from 'pg';

describe('Step 1: Database Schema, Seed Data & QR Token Crypto', () => {
  let pool: pg.Pool;
  const tokenService = new TokenService('test_hmac_secret_32_bytes_minimum_key');

  beforeEach(async () => {
    pool = createPool('memory');
    await initDatabase(pool);
  });

  it('seeds the deterministic rider roster (RDR-0001, RDR-0002, RDR-0003)', async () => {
    const res = await pool.query('SELECT rider_id, display_name, status FROM riders ORDER BY rider_id');
    expect(res.rows).toEqual([
      { rider_id: 'RDR-0001', display_name: 'Tunde Bakare', status: 'ACTIVE' },
      { rider_id: 'RDR-0002', display_name: 'Chinedu Okafor', status: 'ACTIVE' },
      { rider_id: 'RDR-0003', display_name: 'Sadiq Bello', status: 'SUSPENDED' },
    ]);
  });

  it('enforces swap_orders quantity constraints (2..10) and unique idempotency_key', async () => {
    // Valid order (quantity 2)
    await pool.query(
      `INSERT INTO swap_orders (order_id, rider_id, quantity, amount_kobo, bank_name, account_number, idempotency_key, paystack_ref, status, expires_at)
       VALUES ('ORD-1', 'RDR-0001', 2, 150000, 'Paystack-Titan', '0000000000', 'idem-1', 'ref-1', 'PENDING_PAYMENT', now())`
    );

    // Invalid quantity (1 < 2) should fail CHECK constraint
    await expect(
      pool.query(
        `INSERT INTO swap_orders (order_id, rider_id, quantity, amount_kobo, bank_name, account_number, idempotency_key, paystack_ref, status, expires_at)
         VALUES ('ORD-2', 'RDR-0001', 1, 75000, 'Paystack-Titan', '0000000000', 'idem-2', 'ref-2', 'PENDING_PAYMENT', now())`
      )
    ).rejects.toThrow();

    // Duplicate idempotency_key should fail UNIQUE constraint
    await expect(
      pool.query(
        `INSERT INTO swap_orders (order_id, rider_id, quantity, amount_kobo, bank_name, account_number, idempotency_key, paystack_ref, status, expires_at)
         VALUES ('ORD-3', 'RDR-0001', 3, 225000, 'Paystack-Titan', '0000000000', 'idem-1', 'ref-3', 'PENDING_PAYMENT', now())`
      )
    ).rejects.toThrow();
  });

  it('allows auditing INVALID token scans in redemptions with NULL pass_id', async () => {
    await pool.query(
      `INSERT INTO redemptions (scan_id, pass_id, station_id, result, remaining_after)
       VALUES ('SCAN-INVALID-1', NULL, 'STN-LAGOS-01', 'INVALID', 0)`
    );

    const res = await pool.query(`SELECT scan_id, pass_id, result FROM redemptions WHERE scan_id = 'SCAN-INVALID-1'`);
    expect(res.rows[0]).toEqual({
      scan_id: 'SCAN-INVALID-1',
      pass_id: null,
      result: 'INVALID',
    });
  });

  it('creates and verifies RPP1.<pass_id>.<mac> tokens and rejects tampered tokens', async () => {
    const passId = tokenService.generatePassId();
    const token = tokenService.createToken(passId);

    expect(token.startsWith('RPP1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);

    // Valid verification
    const verified = tokenService.verifyToken(token);
    expect(verified).toEqual({ valid: true, passId });

    // Tampered pass_id
    const [, , mac] = token.split('.');
    const tamperedPassToken = `RPP1.${ tokenService.generatePassId() }.${mac}`;
    expect(tokenService.verifyToken(tamperedPassToken)).toEqual({
      valid: false,
      reason: 'INVALID_MAC',
    });

    // Wrong version prefix
    expect(tokenService.verifyToken(`RPP2.${passId}.${mac}`)).toEqual({
      valid: false,
      reason: 'UNSUPPORTED_VERSION',
    });

    // Malformed garbage
    expect(tokenService.verifyToken('not-a-valid-token')).toEqual({
      valid: false,
      reason: 'MALFORMED_TOKEN',
    });

    // Generates valid PNG buffer
    const pngBuffer = await tokenService.generateQrPngBuffer(token);
    expect(pngBuffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic header
    );
  });
});
