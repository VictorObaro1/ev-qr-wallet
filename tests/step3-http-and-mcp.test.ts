import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { loadConfig, AppConfig } from '../src/config.js';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import { PaystackService } from '../src/services/paystack.js';
import { RidePayService } from '../src/services/ridepay.js';
import { createApp } from '../src/app.js';

describe('Step 3 & Step 4: HTTP REST Endpoints & MCP Facade (/mcp)', () => {
  let pool: pg.Pool;
  let config: AppConfig;
  let tokenService: TokenService;
  let paystack: PaystackService;
  let ridepay: RidePayService;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    config = {
      ...loadConfig(),
      databaseUrl: 'memory',
      publicBaseUrl: 'https://ridepay-demo.example.com',
      mcpBearerToken: 'test_mcp_bearer_secret',
      stationBearerToken: 'test_station_bearer_secret',
      passHmacSecret: 'test_pass_hmac_secret_32_bytes_long',
      paystackSecretKey: 'sk_test_mock_secret_key',
    };
    pool = createPool('memory');
    await initDatabase(pool);
    tokenService = new TokenService(config.passHmacSecret);
    paystack = new PaystackService(config.paystackSecretKey, config.paystackBaseUrl);
    ridepay = new RidePayService(pool, config, tokenService, paystack);
    app = createApp(pool, config, tokenService, paystack, ridepay);
  });

  it('returns 200 status ok on GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('enforces separate bearer tokens for /mcp and /v1/passes/redeem', async () => {
    // Missing auth on /mcp -> 401
    const noAuthMcp = await request(app).get('/mcp');
    expect(noAuthMcp.status).toBe(401);

    // Station token cannot access /mcp -> 401
    const wrongTokenMcp = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${config.stationBearerToken}`);
    expect(wrongTokenMcp.status).toBe(401);

    // MCP token cannot access station redeem -> 401
    const wrongTokenStation = await request(app)
      .post('/v1/passes/redeem')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .send({ token: 'RPP1.a.b', station_id: 'STN-1', scan_id: 'SCAN-1' });
    expect(wrongTokenStation.status).toBe(401);
  });

  it('discovers strictly the 4 rider tools via MCP tools/list and never exposes redeem or secrets', async () => {
    const listRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

    expect(listRes.status).toBe(200);
    const tools = listRes.body?.result?.tools;
    expect(Array.isArray(tools)).toBe(true);
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toEqual([
      'verify_rider',
      'create_swap_pass_order',
      'get_order_status',
      'get_pass_balance',
    ]);
  });

  it('executes the complete end-to-end flow over MCP (/mcp), Paystack Webhook (/v1/webhooks/paystack), QR PNG, and Station REST (/v1/passes/redeem)', async () => {
    // 1. MCP Tool: verify_rider
    const verifyRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'verify_rider',
          arguments: { rider_id: 'RDR-0001' },
        },
      });

    expect(verifyRes.status).toBe(200);
    const verifiedRider = JSON.parse(verifyRes.body.result.content[0].text);
    expect(verifiedRider).toEqual({
      exists: true,
      rider_id: 'RDR-0001',
      display_name: 'Tunde Bakare',
      status: 'ACTIVE',
    });

    // 2. MCP Tool: create_swap_pass_order (2 passes = 1500 NGN)
    const createRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'create_swap_pass_order',
          arguments: {
            rider_id: 'RDR-0001',
            quantity: 2,
            idempotency_key: 'mcp-e2e-order-1',
          },
        },
      });

    expect(createRes.status).toBe(200);
    const orderData = JSON.parse(createRes.body.result.content[0].text);
    expect(orderData.amount_ngn).toBe(1500);
    expect(orderData.status).toBe('PENDING_PAYMENT');
    // Ensure no secret keys or paystack_ref leaked in MCP output
    expect(orderData.paystack_ref).toBeUndefined();

    // 3. Rejects forged webhook signature on POST /v1/webhooks/paystack
    const webhookBodyObj = {
      event: 'charge.success',
      data: {
        reference: `rp_${orderData.order_id.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
        amount: 150000,
        metadata: { order_id: orderData.order_id },
      },
    };
    const rawWebhookBody = JSON.stringify(webhookBodyObj);

    const forgedWebhook = await request(app)
      .post('/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadbeef_invalid_sig')
      .send(rawWebhookBody);
    expect(forgedWebhook.status).toBe(401);

    // 4. Accepts valid HMAC-SHA512 signed Paystack webhook
    const validSig = paystack.computeWebhookSignature(rawWebhookBody);
    const validWebhook = await request(app)
      .post('/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', validSig)
      .send(rawWebhookBody);
    expect(validWebhook.status).toBe(200);
    expect(validWebhook.body.status).toBe('PAID');

    // 5. MCP Tool: get_order_status -> issues pass and returns qr_payload & qr_image_url
    const statusRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'get_order_status',
          arguments: { order_id: orderData.order_id },
        },
      });

    const statusData = JSON.parse(statusRes.body.result.content[0].text);
    expect(statusData.status).toBe('PASS_ISSUED');
    expect(statusData.remaining_uses).toBe(2);
    expect(statusData.qr_payload).toMatch(/^RPP1\./);
    expect(statusData.qr_image_url).toBe(
      `https://ridepay-demo.example.com/v1/passes/${statusData.pass_id}/qr.png`
    );

    // 6. GET /v1/passes/:pass_id/qr.png returns a valid PNG image
    const qrImgRes = await request(app).get(`/v1/passes/${statusData.pass_id}/qr.png`);
    expect(qrImgRes.status).toBe(200);
    expect(qrImgRes.headers['content-type']).toContain('image/png');

    // 7. Station REST: POST /v1/passes/redeem decrements remaining uses
    const redeemRes = await request(app)
      .post('/v1/passes/redeem')
      .set('Authorization', `Bearer ${config.stationBearerToken}`)
      .send({
        token: statusData.qr_payload,
        station_id: 'STN-LAGOS-01',
        scan_id: 'SCAN-HTTP-1',
      });

    expect(redeemRes.status).toBe(200);
    expect(redeemRes.body).toEqual({
      result: 'OK',
      remaining: 1,
      scan_id: 'SCAN-HTTP-1',
    });

    // 8. MCP Tool: get_pass_balance shows 1 remaining swap
    const balanceRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${config.mcpBearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'get_pass_balance',
          arguments: { rider_id: 'RDR-0001' },
        },
      });

    const balanceData = JSON.parse(balanceRes.body.result.content[0].text);
    expect(balanceData.total_remaining).toBe(1);
    expect(balanceData.active_passes[0].remaining_uses).toBe(1);
  });
});
