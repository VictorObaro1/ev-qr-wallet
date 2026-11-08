import http from 'http';
import { loadConfig } from '../src/config.js';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import { PaystackService } from '../src/services/paystack.js';
import { RidePayService } from '../src/services/ridepay.js';
import { createApp } from '../src/app.js';

async function callMcpTool(
  baseUrl: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mcpToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }),
  });
  const body = (await res.json()) as any;
  const text = body?.result?.content?.[0]?.text;
  return {
    isError: Boolean(body?.result?.isError),
    data: text ? JSON.parse(text) : body,
  };
}

async function runDemo() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await initDatabase(pool);

  const tokenService = new TokenService(config.passHmacSecret);
  const paystack = new PaystackService(config.paystackSecretKey, config.paystackBaseUrl);
  const ridepay = new RidePayService(pool, config, tokenService, paystack);
  const app = createApp(pool, config, tokenService, paystack, ridepay);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://localhost:${addr.port}`;

  console.log('================================================================');
  console.log('🚲 EV-QR-Wallet Live End-to-End Walkthrough (MCP + Webhook + Station)');
  console.log('================================================================\n');

  try {
    // 1. Verify Rider
    console.log('1️⃣  [MCP] verify_rider("RDR-0001")');
    const rider = await callMcpTool(baseUrl, config.mcpBearerToken, 'verify_rider', {
      rider_id: 'RDR-0001',
    });
    console.log('   ->', JSON.stringify(rider.data));

    // 2. Create Swap Pass Order (2 passes = 1500 NGN)
    console.log('\n2️⃣  [MCP] create_swap_pass_order(RDR-0001, quantity=2)');
    const order = await callMcpTool(baseUrl, config.mcpBearerToken, 'create_swap_pass_order', {
      rider_id: 'RDR-0001',
      quantity: 2,
      idempotency_key: 'demo-happy-order-1',
    });
    console.log('   ->', JSON.stringify(order.data));
    const orderId = order.data.order_id;

    // 3. Rider claims "I have paid" BEFORE paying -> must still be PENDING_PAYMENT
    console.log(`\n3️⃣  [MCP] Rider says "I paid" early -> get_order_status("${orderId}")`);
    const earlyCheck = await callMcpTool(baseUrl, config.mcpBearerToken, 'get_order_status', {
      order_id: orderId,
    });
    console.log('   -> Status (must be PENDING_PAYMENT):', JSON.stringify(earlyCheck.data));

    // 4. Simulate Paystack charge.success webhook (HMAC-SHA512 signed)
    console.log(`\n4️⃣  [Webhook] Simulating signed Paystack charge.success for ${orderId} (₦1,500)`);
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: `rp_${orderId.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
        amount: 150000,
        metadata: { order_id: orderId, rider_id: 'RDR-0001' },
      },
    });
    const sig = paystack.computeWebhookSignature(webhookPayload);
    const whRes = await fetch(`${baseUrl}/v1/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': sig,
      },
      body: webhookPayload,
    });
    console.log('   -> Webhook outcome:', JSON.stringify(await whRes.json()));

    // 5. Check order status -> issues pass once (PASS_ISSUED)
    console.log(`\n5️⃣  [MCP] get_order_status("${orderId}") -> Issues QR Pass`);
    const issued = await callMcpTool(baseUrl, config.mcpBearerToken, 'get_order_status', {
      order_id: orderId,
    });
    console.log('   ->', JSON.stringify(issued.data, null, 2));
    const qrToken = issued.data.qr_payload;

    // 6. Station Terminal scans the QR code (POST /v1/passes/redeem)
    console.log(`\n6️⃣  [Station REST] POST /v1/passes/redeem (scan_id: SCAN-DEMO-1)`);
    const redeem1 = await fetch(`${baseUrl}/v1/passes/redeem`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.stationBearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: qrToken,
        station_id: 'STN-LAGOS-01',
        scan_id: 'SCAN-DEMO-1',
      }),
    });
    console.log('   -> Station display:', JSON.stringify(await redeem1.json()));

    // 7. Rider asks "How many swaps left?" -> get_pass_balance
    console.log('\n7️⃣  [MCP] get_pass_balance("RDR-0001")');
    const balance = await callMcpTool(baseUrl, config.mcpBearerToken, 'get_pass_balance', {
      rider_id: 'RDR-0001',
    });
    console.log('   ->', JSON.stringify(balance.data));

    console.log('\n✅ End-to-End Demo Walkthrough Completed Successfully!');
  } finally {
    server.close();
    await pool.end();
  }
}

runDemo().catch((err) => {
  console.error('Demo walkthrough failed:', err);
  process.exit(1);
});
