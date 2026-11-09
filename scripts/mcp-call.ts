import crypto from 'crypto';
import { loadConfig } from '../src/config.js';

async function main() {
  const argv = process.argv.slice(2);
  const toolName = argv[0];

  if (
    !toolName ||
    ![
      'tools/list',
      'verify_rider',
      'create_swap_pass_order',
      'get_order_status',
      'get_pass_balance',
    ].includes(toolName)
  ) {
    console.log(
      'Usage:\n' +
        '  npm run mcp tools/list\n' +
        '  npm run mcp verify_rider <RDR-0001>\n' +
        '  npm run mcp create_swap_pass_order <RDR-0001> <quantity> [idempotency_key]\n' +
        '  npm run mcp get_order_status <ORD-0001>\n' +
        '  npm run mcp get_pass_balance <RDR-0001>'
    );
    process.exit(1);
  }

  const config = loadConfig();
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, '');
  const mcpUrl = `${baseUrl}/mcp`;

  let rpcBody: Record<string, unknown>;

  if (toolName === 'tools/list') {
    rpcBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    };
  } else if (toolName === 'verify_rider') {
    const rider_id = argv[1] || 'RDR-0001';
    rpcBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'verify_rider',
        arguments: { rider_id },
      },
    };
  } else if (toolName === 'create_swap_pass_order') {
    const rider_id = argv[1] || 'RDR-0001';
    const quantity = Number(argv[2] || 2);
    const idempotency_key =
      argv[3] || `${rider_id}-${quantity}-${crypto.randomBytes(3).toString('hex')}`;
    rpcBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_swap_pass_order',
        arguments: { rider_id, quantity, idempotency_key },
      },
    };
  } else if (toolName === 'get_order_status') {
    const order_id = argv[1] || 'ORD-0001';
    rpcBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_order_status',
        arguments: { order_id },
      },
    };
  } else {
    const rider_id = argv[1] || 'RDR-0001';
    rpcBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_pass_balance',
        arguments: { rider_id },
      },
    };
  }

  console.log(`🌐 Calling MCP (${mcpUrl}) -> ${toolName}...`);

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.mcpBearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  });

  const body = (await res.json()) as any;
  const textContent = body?.result?.content?.[0]?.text;

  if (textContent) {
    console.log(`✅ Result (isError: ${Boolean(body?.result?.isError)}):`);
    console.log(JSON.stringify(JSON.parse(textContent), null, 2));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
}

main().catch((err) => {
  console.error('MCP call failed:', err);
  process.exit(1);
});
