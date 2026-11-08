import { loadConfig } from '../src/config.js';
import { clearDevStateSnapshot, createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';

async function main() {
  clearDevStateSnapshot();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await initDatabase(pool);

  const riders = await pool.query('SELECT rider_id, display_name, status FROM riders ORDER BY rider_id');
  console.log('✅ Database reset and seeded. Riders:');
  console.table(riders.rows);

  const orders = await pool.query(
    'SELECT order_id, rider_id, quantity, amount_kobo, status, bank_name, account_number FROM swap_orders'
  );
  console.log('\n🧾 Pre-seeded Test Order (ready for `npm run mock-pay ORD-0001`):');
  console.table(orders.rows);

  const tokenService = new TokenService(config.passHmacSecret);
  const samplePassId = tokenService.generatePassId();
  const sampleToken = tokenService.createToken(samplePassId);
  console.log('\n🔐 Sample QR Token format:', sampleToken);

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
