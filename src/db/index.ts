import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { newDb } from 'pg-mem';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.resolve(__dirname, '../../.data/dev-state.json');

export interface SeedRider {
  rider_id: string;
  display_name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

export const SEED_RIDERS: SeedRider[] = [
  { rider_id: 'RDR-0001', display_name: 'Tunde Bakare', status: 'ACTIVE' },
  { rider_id: 'RDR-0002', display_name: 'Chinedu Okafor', status: 'ACTIVE' },
  { rider_id: 'RDR-0003', display_name: 'Sadiq Bello', status: 'SUSPENDED' },
];

interface DevStateSnapshot {
  riders: any[];
  swap_orders: any[];
  passes: any[];
  redemptions: any[];
}

export async function savePoolSnapshot(pool: pg.Pool): Promise<void> {
  if (!(pool as any).__persistToDisk) {
    return;
  }
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const riders = (await pool.query('SELECT * FROM riders')).rows;
    const swap_orders = (await pool.query('SELECT * FROM swap_orders')).rows;
    const passes = (await pool.query('SELECT * FROM passes')).rows;
    const redemptions = (await pool.query('SELECT * FROM redemptions')).rows;

    const snapshot: DevStateSnapshot = { riders, swap_orders, passes, redemptions };
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch {
    // Ignore snapshot errors
  }
}

export function clearDevStateSnapshot(): void {
  if (fs.existsSync(STATE_FILE_PATH)) {
    fs.unlinkSync(STATE_FILE_PATH);
  }
}

export function createPool(databaseUrl?: string): pg.Pool {
  if (databaseUrl && databaseUrl !== 'memory' && !databaseUrl.startsWith('memory://')) {
    return new pg.Pool({
      connectionString: databaseUrl,
    });
  }

  // Embedded in-memory Postgres engine for instant zero-setup local testing
  const mem = newDb();
  mem.public.registerFunction({
    name: 'now',
    returns: mem.public.getType('timestamptz' as any),
    implementation: () => new Date(),
    impure: true,
  });

  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;

  // Persist state across CLI invocations when running in default local dev mode (not unit tests)
  if (!databaseUrl && !process.env.VITEST) {
    (pool as any).__persistToDisk = true;
  }

  return pool;
}

export async function initDatabase(pool: pg.Pool): Promise<void> {
  const localSchemaPath = path.join(__dirname, 'schema.sql');
  const rootSchemaPath = path.resolve(process.cwd(), 'src/db/schema.sql');
  const schemaPath = fs.existsSync(localSchemaPath) ? localSchemaPath : rootSchemaPath;
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  await pool.query(schemaSql);

  for (const rider of SEED_RIDERS) {
    await pool.query(
      `INSERT INTO riders (rider_id, display_name, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (rider_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           status = EXCLUDED.status`,
      [rider.rider_id, rider.display_name, rider.status]
    );
  }

  // Restore saved local dev state if present
  if ((pool as any).__persistToDisk && fs.existsSync(STATE_FILE_PATH)) {
    try {
      const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      const snapshot = JSON.parse(raw) as DevStateSnapshot;

      for (const o of snapshot.swap_orders || []) {
        await pool.query(
          `INSERT INTO swap_orders (
            order_id, rider_id, quantity, amount_kobo, amount_paid_kobo,
            bank_name, account_number, idempotency_key, paystack_ref, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (order_id) DO UPDATE SET
            amount_paid_kobo = EXCLUDED.amount_paid_kobo,
            status = EXCLUDED.status,
            expires_at = EXCLUDED.expires_at`,
          [
            o.order_id,
            o.rider_id,
            Number(o.quantity),
            Number(o.amount_kobo),
            Number(o.amount_paid_kobo || 0),
            o.bank_name,
            o.account_number,
            o.idempotency_key,
            o.paystack_ref,
            o.status,
            new Date(o.expires_at).toISOString(),
            new Date(o.created_at || Date.now()).toISOString(),
          ]
        );
      }

      for (const p of snapshot.passes || []) {
        await pool.query(
          `INSERT INTO passes (
            pass_id, order_id, rider_id, total_uses, remaining, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (pass_id) DO UPDATE SET
            remaining = EXCLUDED.remaining,
            status = EXCLUDED.status,
            expires_at = EXCLUDED.expires_at`,
          [
            p.pass_id,
            p.order_id,
            p.rider_id,
            Number(p.total_uses),
            Number(p.remaining),
            p.status,
            new Date(p.expires_at).toISOString(),
            new Date(p.created_at || Date.now()).toISOString(),
          ]
        );
      }

      for (const r of snapshot.redemptions || []) {
        await pool.query(
          `INSERT INTO redemptions (
            scan_id, pass_id, station_id, result, remaining_after, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (scan_id) DO NOTHING`,
          [
            r.scan_id,
            r.pass_id || null,
            r.station_id,
            r.result,
            r.remaining_after !== null && r.remaining_after !== undefined
              ? Number(r.remaining_after)
              : null,
            new Date(r.created_at || Date.now()).toISOString(),
          ]
        );
      }
    } catch {
      // Ignore corrupt snapshot and fall through to default seed
    }
  }

  // Ensure default test order ORD-0001 (2 passes = 1500 NGN for RDR-0001) exists and has a fresh window if unpaid
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  await pool.query(
    `INSERT INTO swap_orders (
      order_id, rider_id, quantity, amount_kobo, amount_paid_kobo,
      bank_name, account_number, idempotency_key, paystack_ref, status, expires_at
    ) VALUES (
      'ORD-0001', 'RDR-0001', 2, 150000, 0,
      'Paystack-Titan', '0012345678', 'seed-ord-0001', 'rp_ord_0001', 'PENDING_PAYMENT', $1
    )
    ON CONFLICT (order_id) DO UPDATE SET
      status = CASE WHEN swap_orders.status = 'EXPIRED' AND swap_orders.amount_paid_kobo = 0 THEN 'PENDING_PAYMENT' ELSE swap_orders.status END,
      expires_at = CASE WHEN swap_orders.status IN ('PENDING_PAYMENT', 'EXPIRED') AND swap_orders.amount_paid_kobo = 0 THEN EXCLUDED.expires_at ELSE swap_orders.expires_at END`,
    [expiresAt]
  );

  await savePoolSnapshot(pool);
}
