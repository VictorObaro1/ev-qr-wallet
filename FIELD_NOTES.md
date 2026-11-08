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

