import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { AppConfig } from './config.js';
import { savePoolSnapshot } from './db/index.js';
import { StructuredToolError } from './errors.js';
import { TokenService } from './services/token.js';
import { PaystackService } from './services/paystack.js';
import { RidePayService } from './services/ridepay.js';
import { createMcpAuthMiddleware, createMcpHttpHandler } from './mcp/facade.js';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

function createBearerMiddleware(expectedToken: string, scopeName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: `Missing or invalid Bearer token for ${scopeName}.`,
          retryable: false,
        },
      });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const providedBuf = Buffer.from(token, 'utf-8');
    const expectedBuf = Buffer.from(expectedToken, 'utf-8');

    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: `Invalid Bearer token for ${scopeName}.`,
          retryable: false,
        },
      });
      return;
    }

    next();
  };
}

export function createApp(
  pool: pg.Pool,
  config: AppConfig,
  tokenService: TokenService,
  paystack: PaystackService,
  ridepay: RidePayService
) {
  const app = express();

  // Capture raw request body for HMAC-SHA512 webhook signature verification
  app.use(
    express.json({
      verify: (req: RequestWithRawBody, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    })
  );

  // 1. Health endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'ridepay-swap-pass',
      timestamp: new Date().toISOString(),
    });
  });

  // 2. MCP Facade endpoint (/mcp) - Protected by MCP_BEARER_TOKEN
  const mcpAuth = createMcpAuthMiddleware(config.mcpBearerToken);
  const mcpHandler = createMcpHttpHandler(ridepay);
  app.all('/mcp', mcpAuth, async (req: Request, res: Response) => {
    try {
      await mcpHandler(req, res);
      await savePoolSnapshot(pool);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'MCP request handling failed.',
            retryable: true,
          },
        });
      }
    }
  });

  // 3. Paystack Webhook endpoint - Verified by HMAC-SHA512 (x-paystack-signature)
  app.post('/v1/webhooks/paystack', async (req: RequestWithRawBody, res: Response) => {
    const signature = req.headers['x-paystack-signature'];
    const sigStr = Array.isArray(signature) ? signature[0] : signature;
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf-8');

    if (!paystack.verifyWebhookSignature(rawBody, sigStr)) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid Paystack webhook signature.',
          retryable: false,
        },
      });
      return;
    }

    try {
      const outcome = await ridepay.handlePaystackWebhook(req.body);
      await savePoolSnapshot(pool);
      res.status(200).json({ status: 'ok', ...outcome });
    } catch (err) {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to process webhook.',
          retryable: true,
        },
      });
    }
  });

  // 4. Station Redemption REST endpoint - Protected by STATION_BEARER_TOKEN (Never an MCP tool)
  const stationAuth = createBearerMiddleware(config.stationBearerToken, 'station');
  app.post('/v1/passes/redeem', stationAuth, async (req: Request, res: Response) => {
    try {
      const result = await ridepay.redeemPass({
        token: req.body?.token,
        station_id: req.body?.station_id,
        scan_id: req.body?.scan_id,
      });
      await savePoolSnapshot(pool);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof StructuredToolError) {
        res.status(400).json(err.toJSON());
        return;
      }
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Station redemption failed.',
          retryable: true,
        },
      });
    }
  });

  // 5. Public QR Code PNG endpoint for a given pass_id
  app.get('/v1/passes/:pass_id/qr.png', async (req: Request, res: Response) => {
    const passId = String(req.params.pass_id || '').trim();
    const passRes = await pool.query('SELECT pass_id FROM passes WHERE pass_id = $1', [passId]);

    if (passRes.rowCount === 0) {
      res.status(404).json({
        error: {
          code: 'PASS_NOT_FOUND',
          message: 'Pass not found.',
          retryable: false,
        },
      });
      return;
    }

    const qrPayload = tokenService.createToken(passId);
    const pngBuffer = await tokenService.generateQrPngBuffer(qrPayload);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(pngBuffer);
  });

  // 6. Builder Simulator Helper Endpoints (Protected by STATION_BEARER_TOKEN, NOT exposed to MCP)
  // Allows the CLI `npm run mock-pay` script to look up order metadata and test expiry against a running server.
  app.get('/v1/internal/orders/:order_id', stationAuth, async (req: Request, res: Response) => {
    const orderId = String(req.params.order_id || '').trim().toUpperCase();
    const orderRes = await pool.query(
      `SELECT order_id, rider_id, quantity, amount_kobo, amount_paid_kobo, paystack_ref, status, expires_at
       FROM swap_orders
       WHERE order_id = $1`,
      [orderId]
    );
    if (orderRes.rowCount === 0) {
      res.status(404).json({
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Order ${orderId} not found.`,
          retryable: false,
        },
      });
      return;
    }
    res.status(200).json(orderRes.rows[0]);
  });

  app.post(
    '/v1/internal/orders/:order_id/expire',
    stationAuth,
    async (req: Request, res: Response) => {
      const orderId = String(req.params.order_id || '').trim().toUpperCase();
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      const upd = await pool.query(
        `UPDATE swap_orders
         SET expires_at = $1
         WHERE order_id = $2
         RETURNING order_id, status, expires_at`,
        [pastIso, orderId]
      );
      if (upd.rowCount === 0) {
        res.status(404).json({
          error: {
            code: 'ORDER_NOT_FOUND',
            message: `Order ${orderId} not found.`,
            retryable: false,
          },
        });
        return;
      }
      await savePoolSnapshot(pool);
      res.status(200).json(upd.rows[0]);
    }
  );

  return app;
}
