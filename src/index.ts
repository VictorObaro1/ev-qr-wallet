import { loadConfig } from './config.js';
import { createPool, initDatabase } from './db/index.js';
import { TokenService } from './services/token.js';
import { PaystackService } from './services/paystack.js';
import { RidePayService } from './services/ridepay.js';
import { createApp } from './app.js';

async function startServer() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await initDatabase(pool);

  const tokenService = new TokenService(config.passHmacSecret);
  const paystack = new PaystackService(config.paystackSecretKey, config.paystackBaseUrl);
  const ridepay = new RidePayService(pool, config, tokenService, paystack);

  const app = createApp(pool, config, tokenService, paystack, ridepay);

  app.listen(config.port, () => {
    const dbMode =
      config.databaseUrl && config.databaseUrl !== 'memory'
        ? 'Postgres (DATABASE_URL)'
        : 'Embedded In-Memory Postgres (pg-mem)';
    console.log(`🚀 RidePay Swap-Pass Server listening on port ${config.port}`);
    console.log(`   Public Base URL : ${config.publicBaseUrl}`);
    console.log(`   Database Mode   : ${dbMode}`);
    console.log(`   Health Check    : ${config.publicBaseUrl}/health`);
    console.log(`   MCP Endpoint    : ${config.publicBaseUrl}/mcp`);
    console.log(`   Station Redeem  : ${config.publicBaseUrl}/v1/passes/redeem`);
    console.log(`   Paystack Webhook: ${config.publicBaseUrl}/v1/webhooks/paystack`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
