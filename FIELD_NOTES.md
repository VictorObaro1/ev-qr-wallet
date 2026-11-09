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

---

### Problem 8: Chord Test Chat Returning `"The agent didn't answer (Chord returned 502). Try sending again."`
- **What happened**: On the first message (`"I need swap pass"`) in the Chord Test Chat simulator (`Vendos · TestMate`), the chat UI returned: `The agent didn't answer (Chord returned 502). Try sending again.` Sending `"hello"` after enabling and verifying the MCP server succeeded immediately (`"Hello John! I'd be happy to help you get swap passes. To start, please send me your Rider ID (for example, RDR-0001) so I can verify your account."`).
- **How I found the cause**: Correlating the timestamp of the 502 (`02:25 PM`) with the MCP server configuration state before enabling the MCP server (`02:39 PM`). When a teammate has an attached MCP server whose tool discovery/connection fails at turn startup (or experiences a cold-start timeout), Chord's turn orchestrator surfaces a generic `502 Bad Gateway` to the chat simulator rather than degrading gracefully or surfacing the upstream MCP error reason.
- **Fix / workaround**: Verified the MCP server was enabled (`enabled: true`) with valid `bearer` `auth_token` and healthy `/health` probe; subsequent turns in the same thread succeeded immediately.
- **Suggested change to Chord / docs / API**: In the Test Chat simulator UI (for admins/builders), include a diagnostic detail on `502` banners (e.g., `"502: Upstream MCP server <name> returned 401/timeout during tool initialization"`) so builders immediately know whether the 502 came from the LLM provider or the attached MCP server.

---

### Problem 9: Operator Replies & Handoff Banners Not Delivered to Customer in Chord "Test Chat" Simulator During Human Takeover
- **What happened**:
  1. When the customer ("John") typed `"speak to someone"` (`04:00 PM`), the thread transitioned to `human_active` and the Operator Thread View showed `TestMate: "One moment — connecting you with a teammate."`
  2. When the human operator took over and sent `"Hello! John no Promo for now we'll inform you when we have. Thank you for understanding."`, the message was saved in the Operator Thread View (`GET /v1/threads/{id}/turns`), **but never arrived in John's "Test chat" simulator window**.
  3. While in `human_active`, John's follow-up messages (`"hey!"` at `04:01 PM`, `"Hello"` at `04:04 PM`) received no response in the Test Chat window (turn-gated with `agent_invoked: false`) while showing repeated `"One moment — connecting you with a teammate."` banners in the operator view, until control was handed back to the agent (`04:07 PM`: `"I want to purchase"` -> agent replied `"Happy to help, Chinedu! Your account RDR-0002 is active..."`).
- **How I found the cause**: Comparing the Operator Thread View screenshot against the Test Chat simulator screenshot and reviewing Chord's [Threads and human handoff documentation](https://api.chordhq.xyz/docs/threads/) (Sections 4, 5, and 7):
  - Section 7 notes that `POST /v1/threads/{id}/messages` persists the `human_operator` turn on the thread first and then dispatches it over the thread's outbound channel (`channel_id`).
  - However, the in-browser **Test Chat** simulator (`"This is a test chat. Messages go to Vendos but never reach WhatsApp"`) only renders synchronous `agent` replies returned directly from the customer's turn request. It does not subscribe to the thread SSE stream (`GET /v1/threads/{id}/events`) or poll `GET /v1/threads/{id}/turns` to display asynchronous `human_operator` replies or the `"One moment — connecting you with a teammate."` system handoff message.
- **Fix / workaround**:
  1. For the demo recording, show **both** panes side-by-side (or switch to the Operator Thread Inbox view during human handoff) so the viewer sees the `human_active` state, the `"One moment — connecting you with a teammate."` transition, and the operator's persisted reply in the thread history, then click **Hand back** to return to `agent_active` so the customer can continue in Test Chat.
  2. When the agent itself escalates on a domain rule (e.g., `RDR-0003` suspended rider or `AMOUNT_MISMATCH`), the agent includes the full Escalation Summary directly in its synchronous `agent` reply *before* handoff so the customer sees the explanation in Test Chat.
- **Suggested change to Chord / docs / API**: Connect the in-browser Test Chat simulator widget to `GET /v1/threads/{id}/events` (or poll `/v1/threads/{id}/turns`) so that `system` handoff notices (`"One moment — connecting you with a teammate."`) and `human_operator` replies sent from the Operator Console render live inside the Test Chat customer window.

---

### Problem 10: Calling `handover_to_human` on the Same Turn as `get_order_status` Suppresses the Agent's `AMOUNT_MISMATCH` Explanation
- **What happened**: After simulating an underpayment (`npm run mock-pay ORD-B12FD2ED54 1000` on a `₦2,250` order, setting `status: 'AMOUNT_MISMATCH'`), the customer typed `"paid"` and `"I have paid"` in Test Chat. Instead of displaying the agent's explanation of the `₦1,000` vs `₦2,250` mismatch, Test Chat showed `"No reply yet. If someone has taken over in Chord, their reply will appear here."` while the Operator Thread View showed `TestMate: "One moment — connecting you with a teammate."`
- **How I found the cause**: Checked Chord's [Escalation rules documentation](https://api.chordhq.xyz/docs/escalation-rules/) (Section "How a handoff happens") and our skill instructions (`SKILL.md` / `references/payment-problems.md`). Because our skill originally instructed the agent on `AMOUNT_MISMATCH` to *"Escalate immediately to a human operator"*, the LLM called `get_order_status(ORD-B12FD2ED54)` and `handover_to_human` **in the same turn**. When `handover_to_human` is invoked during a turn, Chord intercepts the turn and replaces the LLM's text response with the static handoff notice `"One moment — connecting you with a teammate."` (which, per Problem 9, does not render in the Test Chat customer pane).
- **Fix / workaround**: Updated `ridepay-swap-pass/SKILL.md`, `references/payment-problems.md`, and `references/escalation.md` to enforce a **Two-Step "Explain First, Hand Off Second" Escalation Rule**:
  1. **Turn 1**: When `get_order_status` returns `AMOUNT_MISMATCH` (or `EXPIRED` with `amount_paid_ngn > 0`, or `verify_rider` returns `SUSPENDED`), the agent **must not** call `handover_to_human` on that turn. Instead, it sends a normal text reply explaining the exact discrepancy (`₦1,000` received vs `₦2,250` required) along with the structured **Escalation Summary Block**, and asks the rider to reply `"human"` or `"connect me"` to transfer to a support operator.
  2. **Turn 2**: When the rider replies confirming they want a human operator, the agent calls `handover_to_human`.
- **Suggested change to Chord / docs / API**: When a teammate calls `handover_to_human(reason)` and also emits explanatory text in the same assistant turn, deliver the assistant's explanatory text to the user *first* before appending `"One moment — connecting you with a teammate."` instead of discarding the assistant's text reply.

---

### Problem 11: LLM Assuming Previous Balance Was "Wrong" When `get_pass_balance` Drops to `0` After an Out-of-Band Station Scan
- **What happened**: The rider checked their balance on `RDR-0002` at `05:07 PM` (`total_remaining: 1`, `active_passes: [{ pass_id: "h8CLpZsFrHj7STb2tSTxMA", remaining_uses: 1 }]`). Then the rider ran `npm run station-scan RPP1.h8CLpZsFrHj7STb2tSTxMA.yqHpN3MM3wPKBPpay9jr0A` at `STN-LAGOS-01` (consuming the last swap -> `remaining: 0`, `status: 'EXHAUSTED'`) and asked `"How many left"` at `05:10 PM`. Because `get_pass_balance` only returned `active_passes: []` and `total_remaining: 0` with no record of the exhausted pass or station redemption, the LLM assumed its own `05:07 PM` reply had hallucinated the pass and told the user: *"There are no active passes on this account. The pass details I showed earlier were wrong."*
- **How I found the cause**: Inspecting the `get_pass_balance` query in `src/services/ridepay.ts` (`WHERE status = 'ACTIVE' AND remaining > 0`). Once the final swap on a pass is redeemed via `POST /v1/passes/redeem`, the pass transitions to `EXHAUSTED` (`remaining = 0`) and disappears from `active_passes`. Without visibility into `exhausted_passes` or `recent_redemptions`, the LLM had no way to know an out-of-band physical station scan had just occurred.
- **Fix / workaround**:
  1. Enriched `get_pass_balance` in `src/services/ridepay.ts` to also return `exhausted_passes` (`pass_id`, `total_uses`, `remaining_uses: 0`, `status: 'EXHAUSTED'`) and `recent_redemptions` (`pass_id`, `station_id`, `scan_id`, `result`, `redeemed_at` in Lagos WAT) joined from the `redemptions` table.
  2. Updated `ridepay-swap-pass/SKILL.md` (Step 5) to explicitly instruct the agent that decreases in `total_remaining` are caused by physical station scans (`recent_redemptions`), and **never** to claim its earlier balance reading was "wrong". Also added a rule in Step 1 not to flag differences between the Test Chat simulator profile name (`"John"`) and the database `display_name`.
- **Suggested change to Chord / docs / API**: In the exercise spec for `get_pass_balance`, include `exhausted_passes` or `recent_redemptions` alongside `active_passes` so the conversational agent has full observability when a pass transitions from `1` remaining swap to `0` (`EXHAUSTED`) via the station REST endpoint.







