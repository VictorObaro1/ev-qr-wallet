import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { RidePayService } from '../services/ridepay.js';
import { StructuredToolError } from '../errors.js';

/**
 * Strictly sanitizes tool outputs so no internal keys, secrets, or unexpected properties
 * can ever cross the MCP facade boundary.
 */
function formatToolSuccess(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data),
      },
    ],
  };
}

function formatToolError(err: unknown) {
  if (err instanceof StructuredToolError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            code: err.code,
            message: err.message,
            retryable: err.retryable,
          }),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while processing the request.',
          retryable: true,
        }),
      },
    ],
  };
}

/**
 * Creates an McpServer instance configured with strictly the 4 rider-facing tools:
 * 1. verify_rider
 * 2. create_swap_pass_order
 * 3. get_order_status
 * 4. get_pass_balance
 */
export function buildMcpServer(ridepay: RidePayService): McpServer {
  const server = new McpServer({
    name: 'ridepay-swap-pass-mcp',
    version: '1.0.0',
  });

  // 6.1 verify_rider
  server.tool(
    'verify_rider',
    'Verify whether a rider_id exists in the RidePay roster and check if their account status is ACTIVE or SUSPENDED.',
    {
      rider_id: z.string().min(1).describe('Rider ID, e.g. RDR-0001'),
    },
    async ({ rider_id }) => {
      try {
        const result = await ridepay.verifyRider(rider_id);
        const sanitized: Record<string, unknown> = {
          exists: result.exists,
          rider_id: result.rider_id,
        };
        if (result.display_name !== undefined) {
          sanitized.display_name = result.display_name;
        }
        if (result.status !== undefined) {
          sanitized.status = result.status;
        }
        return formatToolSuccess(sanitized);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // 6.2 create_swap_pass_order
  server.tool(
    'create_swap_pass_order',
    'Create a Paystack test bank-transfer order for EV battery swap passes (minimum 2, maximum 10 passes). Only call after verifying the rider is ACTIVE and confirming the quantity and total price with the rider.',
    {
      rider_id: z.string().min(1).describe('Verified ACTIVE rider ID, e.g. RDR-0001'),
      quantity: z
        .number()
        .int()
        .describe('Number of swap passes to purchase (minimum 2, maximum 10)'),
      idempotency_key: z
        .string()
        .min(1)
        .describe('Unique idempotency key for this order request to prevent duplicate charges'),
    },
    async ({ rider_id, quantity, idempotency_key }) => {
      try {
        const result = await ridepay.createSwapPassOrder({
          rider_id,
          quantity,
          idempotency_key,
        });
        return formatToolSuccess({
          order_id: result.order_id,
          rider_id: result.rider_id,
          quantity: result.quantity,
          amount_ngn: result.amount_ngn,
          bank_name: result.bank_name,
          account_number: result.account_number,
          expires_at: result.expires_at,
          status: result.status,
        });
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // 6.3 get_order_status
  server.tool(
    'get_order_status',
    'Check the payment status of a swap pass order. Never trust the rider saying "I paid"—always call this tool. When payment is confirmed (PAID), this tool transactionally issues the QR pass once (PASS_ISSUED).',
    {
      order_id: z.string().min(1).describe('The order ID returned by create_swap_pass_order, e.g. ORD-...'),
    },
    async ({ order_id }) => {
      try {
        const result = await ridepay.getOrderStatus(order_id);
        const sanitized: Record<string, unknown> = {
          order_id: result.order_id,
          status: result.status,
          amount_ngn: result.amount_ngn,
          amount_paid_ngn: result.amount_paid_ngn,
          passes_purchased: result.passes_purchased,
        };
        if (result.expires_at !== undefined) {
          sanitized.expires_at = result.expires_at;
        }
        if (result.pass_id !== undefined) {
          sanitized.pass_id = result.pass_id;
        }
        if (result.qr_payload !== undefined) {
          sanitized.qr_payload = result.qr_payload;
        }
        if (result.qr_image_url !== undefined) {
          sanitized.qr_image_url = result.qr_image_url;
        }
        if (result.remaining_uses !== undefined) {
          sanitized.remaining_uses = result.remaining_uses;
        }
        if (result.pass_expires_at !== undefined) {
          sanitized.pass_expires_at = result.pass_expires_at;
        }
        return formatToolSuccess(sanitized);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // 6.4 get_pass_balance
  server.tool(
    'get_pass_balance',
    'Get all active swap passes, total remaining swaps, exhausted passes, and the last 5 station scans (station_id, scan_id, result, redeemed_at timestamp) for a rider.',
    {
      rider_id: z.string().min(1).describe('Rider ID, e.g. RDR-0001'),
    },
    async ({ rider_id }) => {
      try {
        const result = await ridepay.getPassBalance(rider_id);
        return formatToolSuccess({
          rider_id: result.rider_id,
          active_passes: result.active_passes.map((p) => ({
            pass_id: p.pass_id,
            qr_payload: p.qr_payload,
            qr_image_url: p.qr_image_url,
            remaining_uses: p.remaining_uses,
            total_uses: p.total_uses,
            expires_at: p.expires_at,
          })),
          total_remaining: result.total_remaining,
          exhausted_passes: (result.exhausted_passes ?? []).map((p) => ({
            pass_id: p.pass_id,
            total_uses: p.total_uses,
            remaining_uses: p.remaining_uses,
            status: p.status,
          })),
          recent_redemptions: (result.recent_redemptions ?? []).map((r) => ({
            pass_id: r.pass_id,
            station_id: r.station_id,
            scan_id: r.scan_id,
            result: r.result,
            redeemed_at: r.redeemed_at,
          })),
        });
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  return server;
}

/**
 * Bearer authentication middleware for the MCP Facade (/mcp).
 */
export function createMcpAuthMiddleware(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid Authorization Bearer header for MCP server.',
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
          message: 'Invalid MCP bearer token.',
          retryable: false,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Express handler for /mcp supporting both stateful (session-based) and stateless
 * Streamable HTTP MCP requests.
 */
export function createMcpHttpHandler(ridepay: RidePayService) {
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  return async (req: Request, res: Response) => {
    // If a GET request does not ask for text/event-stream, return a JSON health summary
    const acceptHeader = String(req.headers.accept || '');
    if (req.method === 'GET' && !acceptHeader.includes('text/event-stream')) {
      res.status(200).json({
        status: 'ok',
        service: 'ridepay-swap-pass-mcp',
        protocol: 'streamable-http',
        tools: [
          'verify_rider',
          'create_swap_pass_order',
          'get_order_status',
          'get_pass_balance',
        ],
      });
      return;
    }

    // Ensure Accept header includes both application/json and text/event-stream
    // so StreamableHTTPServerTransport accepts both strict MCP clients and standard JSON clients.
    if (
      !acceptHeader.includes('application/json') ||
      !acceptHeader.includes('text/event-stream')
    ) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;

    // 1. Existing active session
    if (sessionId && sessions.has(sessionId)) {
      const existing = sessions.get(sessionId)!;
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // 2. New session initialization request
    const isInitRequest =
      req.method === 'POST' &&
      req.body &&
      typeof req.body === 'object' &&
      req.body.method === 'initialize';

    if (isInitRequest) {
      const server = buildMcpServer(ridepay);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
        onsessionclosed: (closedId) => {
          sessions.delete(closedId);
        },
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // 3. Stateless request (or request with an expired/unknown session ID after a restart)
    if (sessionId) {
      delete req.headers['mcp-session-id'];
    }

    const statelessServer = buildMcpServer(ridepay);
    const statelessTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await statelessServer.connect(statelessTransport);
    await statelessTransport.handleRequest(req, res, req.body);
  };
}
