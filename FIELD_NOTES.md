# Field Notes Log

This document records real technical issues discovered and resolved while designing, building, and testing the EV-QR-Wallet Swap-Pass system.

---

### Problem 1: Foreign Key Violation When Auditing `INVALID` QR Scans in `redemptions`
- **What happened**: The initial PRD schema defined `redemptions.pass_id TEXT NOT NULL REFERENCES passes(pass_id)` while Section 7.2 required writing an audit row to `redemptions` whenever a station scans a pass, including `INVALID` tokens (tampered MAC or unknown `pass_id`). Inserting an `INVALID` scan with a non-existent or forged `pass_id` causes Postgres to throw a foreign key constraint violation (`23503`).
- **How I found the cause**: Schema review and database constraint test (`tests/step1-foundation.test.ts`).
- **Fix / workaround**: Made `pass_id` nullable (`pass_id TEXT REFERENCES passes(pass_id)`) in `src/db/schema.sql` and stored `NULL` for `pass_id` when `result = 'INVALID'`, preserving full station scan auditing (`scan_id`, `station_id`, `result`, `created_at`) without violating referential integrity.
- **Suggested change to Chord / docs / API**: Update the reference data model in the exercise spec so `redemptions.pass_id` is nullable when auditing invalid token scans.

---

### Problem 2: Missing Bank Account Columns on `swap_orders` for Idempotent Retries
- **What happened**: `create_swap_pass_order` must return `{ order_id, amount_ngn, bank_name, account_number, expires_at, status }` and when called again with the same `idempotency_key`, must return the existing order without calling Paystack a second time. However, the original `swap_orders` schema did not have `bank_name`, `account_number`, or `amount_paid_kobo` columns.
- **How I found the cause**: Reviewing the `create_swap_pass_order` output contract against `swap_orders` columns in `PRD.md`.
- **Fix / workaround**: Added `bank_name TEXT NOT NULL`, `account_number TEXT NOT NULL`, and `amount_paid_kobo BIGINT NOT NULL DEFAULT 0` to `swap_orders`. This also enabled `get_order_status` to report the exact `amount_paid_ngn` on `AMOUNT_MISMATCH` and late payments after expiry.
- **Suggested change to Chord / docs / API**: Include `bank_name`, `account_number`, and `amount_paid_kobo` in the base `swap_orders` table definition.

---

### Problem 3: MCP `StreamableHTTPServerTransport` Rejecting Requests Without Dual `Accept` Header (`406 Not Acceptable`)
- **What happened**: `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` strictly checks that incoming `POST /mcp` requests include `Accept: application/json, text/event-stream`. Standard JSON-RPC HTTP clients, health checks, or `curl` commands that send `Accept: application/json` or `Accept: */*` receive `406 Not Acceptable`.
- **How I found the cause**: Inspecting `@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and testing HTTP `POST /mcp` calls in `tests/step3-http-and-mcp.test.ts`.
- **Fix / workaround**: In `src/mcp/facade.ts`, normalized `req.headers.accept` to include `'application/json, text/event-stream'` before passing the request to `StreamableHTTPServerTransport`, and handled non-SSE `GET /mcp` requests with a `200 OK` JSON health payload (`{ status: "ok", ... }`).
- **Suggested change to Chord / docs / API**: Document in Chord's MCP guide whether Chord's discovery/health probe sends `GET /mcp` or `POST /mcp` and what `Accept` headers it passes.

---

### Problem 4: Paystack Test Mode `POST /charge` ("Pay with Transfer") Availability on New Test Accounts
- **What happened**: Paystack's `POST /charge` endpoint with `bank_transfer` returns HTTP `400` (`"Pay with Transfer is not available"`) on test merchant accounts that have not had Dedicated Virtual Accounts / PwT manually unlocked by Paystack support, whereas `POST /transaction/initialize` works on all Paystack test keys.
- **How I found the cause**: Verifying Paystack test-mode API behaviour for bank transfers (`src/services/paystack.ts` and `tests/step2-domain.test.ts`).
- **Fix / workaround**: Implemented `PaystackService.createBankTransferCharge` to attempt `POST /charge` first and automatically fall back to `POST /transaction/initialize` (creating a real transaction reference on the Paystack Test Dashboard) with deterministic test virtual account details (`Paystack-Titan`), while pairing it with `npm run mock-pay` to sign and deliver real `HMAC-SHA512` `charge.success` webhooks.
- **Suggested change to Chord / docs / API**: Note in the exercise documentation that Paystack test accounts without PwT enabled can use `/transaction/initialize` + signed `charge.success` webhooks for bank-transfer simulation.

---

### Problem 5: Windows PowerShell Stripping `--` and `npm run` Consuming CLI Flags
- **What happened**: Running `npm run mock-pay -- --order ORD-0001 --amount-ngn 1000` in Windows PowerShell resulted in `tsx scripts/mock-pay.ts ORD-0001 1000` with the `--order` and `--amount-ngn` flag names stripped, causing the flag-only parser to print the usage help instead of executing.
- **How I found the cause**: PowerShell treats the first `--` as its own end-of-parameters token and strips it before invoking `npm.cmd`. Without `--`, `npm` consumes `--order` and `--amount-ngn` into `npm_config_*` environment variables and forwards only the bare values as positional arguments.
- **Fix / workaround**: Updated `scripts/mock-pay.ts` and `scripts/station-scan.ts` to accept positional arguments (`npm run mock-pay ORD-0001 1000`), `process.env.npm_config_*` variables, and `--flag` syntax interchangeably, and pre-seeded `ORD-0001` in `src/db/index.ts`.
- **Suggested change to Chord / docs / API**: Prefer positional CLI arguments (e.g., `npm run mock-pay ORD-0001 1000`) in cross-platform README commands so Windows PowerShell users don't hit `npm run --` flag-stripping.

---

### Problem 6: `ReferenceError: crypto is not defined` on Railway Nixpacks Default Node 18 Runtime
- **What happened**: After deploying to Railway (`https://ev-qr-wallet-production.up.railway.app`), `GET /health` and `GET /mcp` returned `200 OK`, but sending a JSON-RPC `POST /mcp` request returned `{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error","data":"ReferenceError: crypto is not defined"},"id":null}`.
- **How I found the cause**: Live smoke-testing `POST https://ev-qr-wallet-production.up.railway.app/mcp` immediately after deployment. `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport` calls `crypto.randomUUID()` on the global `crypto` object (`globalThis.crypto`), which is available by default in Node 20+/22 (local machine) but undefined on `globalThis` in older Node 18 containers when `"engines"` is not pinned.
- **Fix / workaround**: Added `if (!globalThis.crypto) { (globalThis as any).crypto = crypto.webcrypto; }` in `src/app.ts` and pinned `"engines": { "node": ">=20.0.0" }` in `package.json`.
- **Suggested change to Chord / docs / API**: Remind builders deploying TypeScript MCP servers with `@modelcontextprotocol/sdk` to set `"engines": { "node": ">=20.0.0" }` or polyfill `globalThis.crypto = crypto.webcrypto`.

---

### Problem 7: Chord MCP Probe Returning `401 UNAUTHORIZED` ("Missing or invalid Authorization Bearer header") When Server is Disabled or `auth_type` is Omitted
- **What happened**: Probing the MCP server from Chord returned: `MCP server error: MCP server returned HTTP 401: {"error":{"code":"UNAUTHORIZED","message":"Missing or invalid Authorization Bearer [REDACTED] for MCP server.","retryable":false}}`.
- **How I found the cause**: Checked the exact 401 message from `src/mcp/facade.ts` (which only fires when no `Authorization: Bearer ...` header is sent at all) and cross-referenced Chord's official MCP docs (`https://api.chordhq.xyz/docs/mcp-servers/`), Section 1 & Section 3:
  1. `auth_type` defaults to `"none"` unless explicitly set to `"bearer"`.
  2. Section 3 states: *"Keep a static-auth server enabled while probing: a disabled server or workspace does not supply its stored bearer/API-key credential to these probes."*
- **Fix / workaround**:
  1. Ensure the MCP server in Chord has `"auth_type": "bearer"` and `"auth_token": "mcp_live_token_ridepay_2026"`.
  2. Follow Chord's Section 2 -> Section 3 order: set the teammate's `set_mcp_server_ids` first, **enable the MCP server (`"enabled": true`)**, and *then* run tool discovery (`/tools`) and health check (`/health`), followed by setting `enabled_tools`.
- **Suggested change to Chord / docs / API**: When a user triggers `/tools` or `/health` on a disabled static-auth MCP server (`enabled: false`), return a `409 FAILED_PRECONDITION` ("Enable the server before probing static credentials") or include the stored `auth_token` on admin probes so builders don't see a misleading remote `401 Missing Authorization header` error.



