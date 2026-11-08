import http from 'http';
import { loadConfig } from '../src/config.js';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import { PaystackService } from '../src/services/paystack.js';
import { RidePayService } from '../src/services/ridepay.js';
import { createApp } from '../src/app.js';

interface ParsedMockPayArgs {
  orderId: string;
  amountNgn?: number;
  expireOnly: boolean;
  expireFirst: boolean;
  url?: string;
}

/**
 * Parses CLI arguments resiliently across Windows PowerShell (which strips single `--`
 * and causes npm to consume `--order` / `--amount-ngn`), CMD, and bash.
 */
function parseMockPayArgs(argv: string[]): ParsedMockPayArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }

  // 1. Extract orderId from --order, npm_config_order, or first positional matching ORD-*
  let orderId = String(
    flags.order ||
      flags['order-id'] ||
      process.env.npm_config_order ||
      process.env.npm_config_order_id ||
      ''
  ).trim();

  if (!orderId || orderId === 'true') {
    const ordPos = positionals.find((p) => /^ord-/i.test(p)) || positionals[0] || '';
    orderId = ordPos;
  }

  // 2. Extract amountNgn from --amount-ngn, npm_config_amount_ngn, or numeric positional arg
  let amountNgn: number | undefined;
  const rawFlagAmount =
    flags['amount-ngn'] ??
    flags.amount ??
    process.env.npm_config_amount_ngn ??
    process.env.npm_config_amount;

  if (rawFlagAmount !== undefined && rawFlagAmount !== true && rawFlagAmount !== 'true') {
    const parsed = Number(rawFlagAmount);
    if (!Number.isNaN(parsed) && parsed > 0) {
      amountNgn = parsed;
    }
  }

  if (amountNgn === undefined) {
    const numPos = positionals.find(
      (p) => p !== orderId && /^\d+(\.\d+)?$/.test(p)
    );
    if (numPos) {
      amountNgn = Number(numPos);
    }
  }

  const expireOnly =
    Boolean(flags['expire-only']) ||
    process.env.npm_config_expire_only === 'true' ||
    positionals.includes('expire-only');

  const expireFirst =
    Boolean(flags['expire-first']) ||
    process.env.npm_config_expire_first === 'true' ||
    positionals.includes('expire-first');

  const url =
    typeof flags.url === 'string'
      ? flags.url
      : process.env.npm_config_url || undefined;

  return {
    orderId: orderId.toUpperCase(),
    amountNgn,
    expireOnly,
    expireFirst,
    url,
  };
}

async function main() {
  const parsed = parseMockPayArgs(process.argv.slice(2));

  if (!parsed.orderId) {
    console.error(
      'Usage (works with or without flags in PowerShell):\n' +
        '  npm run mock-pay ORD-0001                       # Exact payment (₦1,500)\n' +
        '  npm run mock-pay ORD-0001 1000                  # Wrong amount (₦1,000 -> AMOUNT_MISMATCH)\n' +
        '  npm run mock-pay ORD-0001 expire-only           # Expire order without paying\n' +
        '  npm run mock-pay ORD-0001 expire-first          # Expire order then send late payment'
    );
    process.exit(1);
  }

  const config = loadConfig();
  let baseUrl = (parsed.url || config.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/+$/, '');
  const paystack = new PaystackService(config.paystackSecretKey, config.paystackBaseUrl);

  let tempServer: http.Server | null = null;
  let tempPool: Awaited<ReturnType<typeof createPool>> | null = null;

  // Check if the server is already running on localhost:PORT; if not, spin up an in-process instance
  try {
    const healthCheck = await fetch(`${baseUrl}/health`);
    if (!healthCheck.ok) {
      throw new Error('Health check not ok');
    }
  } catch {
    console.log(
      `ℹ️  No running server detected at ${baseUrl}; starting embedded server instance for this test...`
    );
    tempPool = createPool(config.databaseUrl);
    await initDatabase(tempPool);
    const tokenService = new TokenService(config.passHmacSecret);
    const ridepay = new RidePayService(tempPool, config, tokenService, paystack);
    const app = createApp(tempPool, config, tokenService, paystack, ridepay);
    tempServer = http.createServer(app);
    await new Promise<void>((resolve) => tempServer!.listen(0, resolve));
    const addr = tempServer.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  }

  try {
    // 1. Fetch order metadata
    const orderRes = await fetch(
      `${baseUrl}/v1/internal/orders/${encodeURIComponent(parsed.orderId)}`,
      {
        headers: {
          Authorization: `Bearer ${config.stationBearerToken}`,
        },
      }
    );

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error(`❌ Failed to find order ${parsed.orderId} on ${baseUrl}:`, errText);
      process.exit(1);
    }

    const order = (await orderRes.json()) as {
      order_id: string;
      rider_id: string;
      quantity: number;
      amount_kobo: number | string;
      paystack_ref: string;
      status: string;
    };

    // 2. Optionally expire the order first
    if (parsed.expireOnly || parsed.expireFirst) {
      const expRes = await fetch(
        `${baseUrl}/v1/internal/orders/${encodeURIComponent(parsed.orderId)}/expire`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.stationBearerToken}`,
          },
        }
      );
      if (!expRes.ok) {
        console.error('❌ Failed to expire order:', await expRes.text());
        process.exit(1);
      }
      console.log(`⏰ Order ${parsed.orderId} transfer window forced to EXPIRED.`);
      if (parsed.expireOnly) {
        console.log('✅ Done (expire-only). Checking get_order_status result:');
        const statusRes = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.mcpBearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'get_order_status',
              arguments: { order_id: parsed.orderId },
            },
          }),
        });
        const statusBody = (await statusRes.json()) as any;
        console.log(
          '🔎 get_order_status:',
          JSON.parse(statusBody.result.content[0].text)
        );
        return;
      }
    }

    // 3. Determine amount in kobo to simulate
    const expectedKobo = Number(order.amount_kobo);
    const amountKobo =
      parsed.amountNgn !== undefined
        ? Math.round(parsed.amountNgn * 100)
        : expectedKobo;

    const webhookPayload = {
      event: 'charge.success',
      data: {
        id: Date.now(),
        domain: 'test',
        status: 'success',
        reference: order.paystack_ref,
        amount: amountKobo,
        currency: 'NGN',
        channel: 'dedicated_nuban',
        paid_at: new Date().toISOString(),
        metadata: {
          order_id: order.order_id,
          rider_id: order.rider_id,
        },
      },
    };

    const rawBody = JSON.stringify(webhookPayload);
    const signature = paystack.computeWebhookSignature(rawBody);

    console.log(
      `💸 Sending signed Paystack charge.success webhook for ${order.order_id} (paid: ₦${
        amountKobo / 100
      } | expected: ₦${expectedKobo / 100})...`
    );

    const webhookRes = await fetch(`${baseUrl}/v1/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature,
      },
      body: rawBody,
    });

    const webhookResult = await webhookRes.json();
    console.log('📬 Webhook response:', webhookResult);

    // Also show what get_order_status now returns!
    const statusRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.mcpBearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_order_status',
          arguments: { order_id: parsed.orderId },
        },
      }),
    });
    const statusBody = (await statusRes.json()) as any;
    console.log(
      '🔎 Resulting get_order_status:',
      JSON.parse(statusBody.result.content[0].text)
    );
  } finally {
    if (tempServer) {
      tempServer.close();
    }
    if (tempPool) {
      await tempPool.end();
    }
  }
}

main().catch((err) => {
  console.error('mock-pay error:', err);
  process.exit(1);
});
