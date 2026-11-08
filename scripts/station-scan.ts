import http from 'http';
import crypto from 'crypto';
import { loadConfig } from '../src/config.js';
import { createPool, initDatabase } from '../src/db/index.js';
import { TokenService } from '../src/services/token.js';
import { PaystackService } from '../src/services/paystack.js';
import { RidePayService } from '../src/services/ridepay.js';
import { createApp } from '../src/app.js';

function parseStationArgs(argv: string[]) {
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

  let token = String(
    flags.token || process.env.npm_config_token || ''
  ).trim();
  if (!token || token === 'true') {
    token = positionals.find((p) => p.startsWith('RPP')) || positionals[0] || '';
  }

  let stationId = String(
    flags.station || process.env.npm_config_station || ''
  ).trim();
  if (!stationId || stationId === 'true') {
    stationId =
      positionals.find((p) => p !== token && /^stn-/i.test(p)) || 'STN-LAGOS-01';
  }

  let scanId = String(
    flags['scan-id'] || process.env.npm_config_scan_id || ''
  ).trim();
  if (!scanId || scanId === 'true') {
    scanId =
      positionals.find(
        (p) => p !== token && p !== stationId && /^scan-/i.test(p)
      ) || `SCAN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  const url =
    typeof flags.url === 'string'
      ? flags.url
      : process.env.npm_config_url || undefined;

  return { token, stationId, scanId, url };
}

async function main() {
  const { token, stationId, scanId, url } = parseStationArgs(process.argv.slice(2));

  if (!token) {
    console.error(
      'Usage:\n' +
        '  npm run station-scan RPP1.<pass_id>.<mac> [STN-LAGOS-01] [SCAN-001]'
    );
    process.exit(1);
  }

  const config = loadConfig();
  let baseUrl = (url || `http://localhost:${config.port}`).replace(/\/+$/, '');

  let tempServer: http.Server | null = null;
  let tempPool: Awaited<ReturnType<typeof createPool>> | null = null;

  try {
    const healthCheck = await fetch(`${baseUrl}/health`);
    if (!healthCheck.ok) {
      throw new Error('Health check not ok');
    }
  } catch {
    console.log(
      `ℹ️  No running server detected at ${baseUrl}; starting embedded server instance...`
    );
    tempPool = createPool(config.databaseUrl);
    await initDatabase(tempPool);
    const tokenService = new TokenService(config.passHmacSecret);
    const paystack = new PaystackService(config.paystackSecretKey, config.paystackBaseUrl);
    const ridepay = new RidePayService(tempPool, config, tokenService, paystack);
    const app = createApp(tempPool, config, tokenService, paystack, ridepay);
    tempServer = http.createServer(app);
    await new Promise<void>((resolve) => tempServer!.listen(0, resolve));
    const addr = tempServer.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  }

  try {
    console.log(`🔋 Station [${stationId}] scanning QR token (scan_id: ${scanId})...`);

    const res = await fetch(`${baseUrl}/v1/passes/redeem`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.stationBearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        station_id: stationId,
        scan_id: scanId,
      }),
    });

    const body = await res.json();
    console.log(`📟 Station Terminal Response (HTTP ${res.status}):`);
    console.log(JSON.stringify(body, null, 2));
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
  console.error('station-scan error:', err);
  process.exit(1);
});
