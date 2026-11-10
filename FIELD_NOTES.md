# Deployment & Integration Field Notes

This document records the real technical issues hit while building, deploying, and testing the **EV-QR-Wallet Swap-Pass Agent (`ridepay-swap-pass`)**, grouped into **Section 1: Chord-Related Field Notes** and **Section 2: General Backend, Paystack & Infrastructure Field Notes**.

---

## Section 1: Chord-Related Field Notes

### Problem 1.1: Chord MCP Probe Returning `401 UNAUTHORIZED` When Server is Disabled (`enabled: false`)
- **What happened**: After deploying the MCP server to Railway (`https://ev-qr-wallet-production.up.railway.app/mcp`) and registering it in Chord as disabled initially, running the MCP tool discovery / health probe in Chord failed with:
  ```text
  MCP server error: MCP server returned HTTP 401: {"error":{"code":"UNAUTHORIZED","message":"Missing or invalid Authorization Bearer [REDACTED] for MCP server.","retryable":false}}
  ```
- **How I worked out the cause**: Inspected `createMcpAuthMiddleware` in [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts#L210-L224) (which only returns `"Missing or invalid Authorization Bearer..."` when no `Authorization: Bearer ...` header is sent or the token does not match) and cross-referenced Chord's [MCP Servers documentation](https://api.chordhq.xyz/docs/mcp-servers/) (Sections 1, 2, and 3):
  1. `auth_type` defaults to `"none"` unless explicitly set to `"bearer"`.
  2. Section 3 states: *"Keep a static-auth server enabled while probing: a disabled server or workspace does not supply its stored bearer/API-key credential to these probes."* Because the server was still in `enabled: false` state during the probe, Chord omitted the `Authorization: Bearer <auth_token>` header when probing `/mcp`.
- **How I fixed it or worked around it**:
  1. Configured `"auth_type": "bearer"` and stored `MCP_BEARER_TOKEN` in `"auth_token"` (never in custom headers).
  2. Followed Chord's Section 2 → Section 3 sequence for static-auth servers: attached the server ID to the teammate (`mcp_server_ids`), **enabled the MCP server (`enabled: true`)**, and then ran tool discovery (`/tools`) and health check (`/health`), followed by locking `enabled_tools` to `["verify_rider", "create_swap_pass_order", "get_order_status", "get_pass_balance"]`.
- **What I'd change in Chord, its docs, or its API**:
  1. When an admin triggers `/tools` or `/health` on a disabled static-auth MCP server (`enabled: false`), either supply the stored `auth_token` during the admin probe or return a clear `409 FAILED_PRECONDITION` (`"Enable this static-auth MCP server before running tool discovery so Chord can send its stored auth_token"`), instead of sending an unauthenticated probe that surfaces a confusing remote `401 UNAUTHORIZED` error.
  2. Reconcile the safe rollout checklist (which suggests registering disabled and probing before enabling) with Section 3's requirement that static-auth servers must be `enabled: true` to supply credentials during probes.

---

### Problem 1.2: Chord Test Chat Returning `"The agent didn't answer (Chord returned 502). Try sending again."`
- **What happened**: On the first test message (`"I need swap pass"` at `02:25 PM`) in the Chord Test Chat simulator (`Vendos · TestMate`), the chat UI displayed:
  ```text
  The agent didn't answer (Chord returned 502). Try sending again.
  ```
  After enabling and verifying the MCP server (`02:39 PM`), sending `"hello"` succeeded immediately (`"Hello John! I'd be happy to help you get swap passes. To start, please send me your Rider ID (for example, RDR-0001) so I can verify your account."`).
- **How I worked out the cause**: Correlated the timestamp of the `502` error (`02:25 PM`) in Test Chat with the MCP server configuration state before the MCP server was enabled (`02:39 PM`). When a teammate has an attached MCP server whose tool initialization fails at turn startup (e.g., due to `401` while disabled or upstream connection failure), Chord's turn orchestrator returns a generic `502 Bad Gateway` to the Test Chat UI.
- **How I fixed it or worked around it**: Enabled the MCP server (`enabled: true`) with valid `bearer` `auth_token` and verified `/health` (`status: "ok"`); all subsequent turns succeeded without `502` errors.
- **What I'd change in Chord, its docs, or its API**: In the admin Test Chat simulator UI, surface the specific upstream failure cause on `502` banners (e.g., `"502: Upstream MCP server 'ridepay-mcp' failed tool initialization (HTTP 401)"`) so builders immediately know whether the `502` came from the attached MCP server or the model provider.

---

### Problem 1.3: Operator Replies & Handoff Banners Not Delivered to Customer in Chord "Test Chat" Simulator During Human Takeover
- **What happened**:
  1. When the customer ("John") typed `"speak to someone"` (`04:00 PM`), the thread transitioned to `human_active` and the Operator Thread View showed `TestMate: "One moment — connecting you with a teammate."`
  2. When I clicked **Take over** in the Operator Console and sent `"Hello! John no Promo for now we'll inform you when we have. Thank you for understanding."`, the message appeared in the Operator Thread View (`GET /v1/threads/{id}/turns`), **but never arrived in John's "Test chat" simulator window**.
  3. While in `human_active`, John's follow-up messages (`"hey!"` at `04:01 PM`, `"Hello"` at `04:04 PM`) showed `"No reply yet. If someone has taken over in Chord, their reply will appear here."` in Test Chat (turn-gated with `agent_invoked: false`) while appending repeated `"One moment — connecting you with a teammate."` notices in the Operator View, until control was handed back to the agent (`04:07 PM`).
- **How I worked out the cause**: Compared the Operator Thread View and Test Chat simulator screenshots side-by-side and reviewed Chord's [Threads and human handoff documentation](https://api.chordhq.xyz/docs/threads/) (Sections 4, 5, and 7). Section 7 notes that `POST /v1/threads/{id}/messages` persists the `human_operator` turn on the thread first and then dispatches it over the thread's outbound channel (`channel_id`). However, the in-browser **Test Chat** widget (`"This is a test chat. Messages go to Vendos but never reach WhatsApp"`) only renders synchronous `agent` replies returned directly from the customer's turn request—it does not subscribe to `GET /v1/threads/{id}/events` or poll `GET /v1/threads/{id}/turns` to render asynchronous `human_operator` replies or system handoff turns.
- **How I fixed it or worked around it**:
  1. During human takeover demos, display both the **Test Chat** pane and the **Operator Thread Inbox** pane so the viewer sees the `human_active` state, the `"One moment — connecting you with a teammate."` transition, and the operator's persisted reply in the thread history, then click **Hand back** to return the thread to `agent_active`.
  2. Updated the skill escalation flow (see Problem 1.4) so the agent delivers its full explanation and **Escalation Summary Block** in a synchronous `agent` reply *before* triggering `handover_to_human`.
- **What I'd change in Chord, its docs, or its API**: Subscribe the in-browser Test Chat simulator widget to the thread SSE stream (`GET /v1/threads/{id}/events`) or poll `/v1/threads/{id}/turns` so that `human_operator` replies sent from the Operator Console and `"One moment — connecting you with a teammate."` handoff notices appear live in the Test Chat window (especially since the Test Chat placeholder text explicitly says *"If someone has taken over in Chord, their reply will appear here"*).

---

### Problem 1.4: Calling `handover_to_human` on the Same Turn as `get_order_status` Suppresses the Agent's `AMOUNT_MISMATCH` Explanation
- **What happened**: After simulating an underpayment (`npm run mock-pay ORD-B12FD2ED54 1000` on a 3-pass `₦2,250` order, transitioning the order to `status: 'AMOUNT_MISMATCH'`), I typed `"paid"` and `"I have paid"` in Test Chat. Instead of displaying the agent's explanation of the `₦1,000` vs. `₦2,250` discrepancy, Test Chat showed `"No reply yet. If someone has taken over in Chord, their reply will appear here."` while the Operator Thread View showed `TestMate: "One moment — connecting you with a teammate."`
- **How I worked out the cause**: Checked Chord's [Escalation rules documentation](https://api.chordhq.xyz/docs/escalation-rules/) (*"How a handoff happens"*) and inspected our skill instructions in [`ridepay-swap-pass/SKILL.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md). Because our skill originally told the agent on `AMOUNT_MISMATCH` to *"Escalate immediately to a human operator"*, the LLM called `get_order_status("ORD-B12FD2ED54")` and Chord's built-in `handover_to_human` tool **on the same turn**. When `handover_to_human` is called on a turn, Chord intercepts the turn and replaces the assistant's text output with the static message `"One moment — connecting you with a teammate."`—discarding the agent's explanation of the payment mismatch.
- **How I fixed it or worked around it**: Updated [`ridepay-swap-pass/SKILL.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md), [`references/payment-problems.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/references/payment-problems.md), and [`references/escalation.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/references/escalation.md) to enforce a **Two-Step "Explain First, Hand Off Second" Escalation Rule**:
  1. **Turn 1 (Explain + Summary Block)**: When `get_order_status` returns `AMOUNT_MISMATCH` (or `EXPIRED` with `amount_paid_ngn > 0`, or `verify_rider` returns `SUSPENDED`), the skill forbids calling `handover_to_human` on that same turn. Instead, the agent sends a normal text reply explaining the exact discrepancy (`₦1,000` received vs. `₦2,250` required) along with the structured **Escalation Summary Block**, and asks the rider to reply `"human"` or `"connect me"` to transfer to a support operator.
  2. **Turn 2 (Trigger Handoff)**: Only when the rider replies asking for a human does the agent invoke `handover_to_human`.
- **What I'd change in Chord, its docs, or its API**: When an LLM turn emits both assistant text and a `handover_to_human(reason)` tool call, preserve and deliver the assistant's explanatory text message to the customer *before* appending `"One moment — connecting you with a teammate."`, rather than replacing the assistant's text with the static handoff notice.

---

### Problem 1.5: LLM Claiming Its Earlier Balance Reply Was "Wrong" After an Out-of-Band Station Scan Drops Balance to `0`
- **What happened**:
  1. At `05:07 PM`, I asked `"how many swap do I have RDR-0002"` in Test Chat, and the agent reported `Total remaining swaps: 1` for pass `h8CLpZsFrHj7STb2tSTxMA` (`1 of 2 swaps`).
  2. Next, I ran `npm run station-scan RPP1.h8CLpZsFrHj7STb2tSTxMA.yqHpN3MM3wPKBPpay9jr0A` in PowerShell, which redeemed the last swap at station `STN-LAGOS-01` (`result: "OK"`, `remaining: 0`, `scan_id: "SCAN-CEB479E9"`).
  3. At `05:10 PM`, I asked `"How many left"` in Test Chat. The agent replied: *"Total remaining swaps: 0. There are no active passes on this account. The pass details I showed earlier were wrong."*
  4. Additionally, when I later asked `"Which station did the last scan"` (`05:38 PM`), the agent initially said it couldn't see station scan history, and also flagged that the Test Chat simulator profile name (`"John"`) differed from the rider's registered `display_name` (`"Chinedu Okafor"` / `"Tunde Bakare"`).
- **How I worked out the cause**:
  1. Inspected `getPassBalance` in [`src/services/ridepay.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/ridepay.ts#L563-L654) and the serializer in [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts#L176-L216). Originally, `get_pass_balance` only queried `WHERE status = 'ACTIVE' AND remaining > 0` and returned `{ rider_id, active_passes: [], total_remaining: 0 }`. Once a pass's last swap was redeemed at a station, it transitioned to `status = 'EXHAUSTED'` (`remaining = 0`) and vanished from `active_passes`. With no visibility into `exhausted_passes` or `recent_redemptions`, the LLM saw `active_passes: []` three minutes after reporting an active pass and assumed its own earlier turn had hallucinated!
  2. Second, [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts#L186-L197) had an explicit property whitelist on `get_pass_balance` that initially stripped `exhausted_passes` and `recent_redemptions` before returning the MCP response.
- **How I fixed it or worked around it**:
  1. Updated `getPassBalance` in [`src/services/ridepay.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/ridepay.ts#L563-L654) and the MCP serializer in [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts#L176-L216) to return `exhausted_passes` (`pass_id`, `total_uses`, `remaining_uses: 0`, `status: 'EXHAUSTED'`) and `recent_redemptions` (the **last 5 station scans** from `redemptions` with `pass_id`, `station_id`, `scan_id`, `result`, and `redeemed_at` in Lagos WAT `+01:00`).
  2. Updated [`ridepay-swap-pass/SKILL.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) (Step 1 and Step 5) so the agent displays the last 5 station scans (`station_id`, `result`, `scan_id`, `redeemed_at`), attributes balance decreases to physical station scans rather than apologizing for an "earlier mistake", and never scolds the user when the Test Chat simulator sender name (`"John"`) differs from `display_name`.
- **What I'd change in Chord, its docs, or its API**:
  1. In the exercise specification for `get_pass_balance`, include `exhausted_passes` and `recent_redemptions` (last 5 scans with `station_id` and `redeemed_at`) so the conversational agent has full observability into out-of-band station redemptions.
  2. Allow editing the simulated customer display name in the Chord Test Chat header (currently hardcoded to `"John"`).

---

### Problem 1.6: MCP `StreamableHTTPServerTransport` Rejecting Requests Without Dual `Accept` Header (`406 Not Acceptable`)
- **What happened**: `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` strictly requires incoming `POST /mcp` requests to send `Accept: application/json, text/event-stream`. Standard JSON-RPC HTTP clients, health probes, or `curl` commands that send `Accept: application/json` or `Accept: */*` receive HTTP `406 Not Acceptable`.
- **How I worked out the cause**: Inspected `@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and tested `POST /mcp` requests in [`tests/step3-http-and-mcp.test.ts`](file:///c:/Dev/EV-QR-Wallet/tests/step3-http-and-mcp.test.ts).
- **How I fixed it or worked around it**: In [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts#L248-L273), normalized `req.headers.accept` to include `'application/json, text/event-stream'` before passing the request to `StreamableHTTPServerTransport`, and handled non-SSE `GET /mcp` requests with a `200 OK` JSON health payload (`{ status: "ok", ... }`).
- **What I'd change in Chord, its docs, or its API**: Document in Chord's MCP server guide what HTTP method (`GET /mcp` vs. `POST /mcp` JSON-RPC `initialize` / `tools/list`) and `Accept` headers Chord's `/health` and `/tools` probes send, and mention the `@modelcontextprotocol/sdk` `Accept` header quirk.

---

## Section 2: General Backend, Paystack & Infrastructure Field Notes

### Problem 2.1: `ReferenceError: crypto is not defined` on Railway Nixpacks Default Node 18 Runtime
- **What happened**: Immediately after deploying to Railway (`https://ev-qr-wallet-production.up.railway.app`), `GET /health` and `GET /mcp` returned `200 OK`, but sending a JSON-RPC `POST /mcp` call returned:
  ```json
  {"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error","data":"ReferenceError: crypto is not defined"},"id":null}
  ```
- **How I worked out the cause**: Smoke-tested `POST https://ev-qr-wallet-production.up.railway.app/mcp` right after deployment. `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport` calls `crypto.randomUUID()` on `globalThis.crypto`, which is defined by default in Node 20+/22 (local environment) but `undefined` on `globalThis` in older Node 18 containers when `"engines"` is not pinned in `package.json`.
- **How I fixed it or worked around it**: Added `if (!globalThis.crypto) { (globalThis as any).crypto = crypto.webcrypto; }` in [`src/app.ts`](file:///c:/Dev/EV-QR-Wallet/src/app.ts#L10-L12) and pinned `"engines": { "node": ">=20.0.0" }` in [`package.json`](file:///c:/Dev/EV-QR-Wallet/package.json#L6-L8).
- **What I'd change in Chord, its docs, or its API**: Add a note in the MCP server deployment guide reminding TypeScript builders using `@modelcontextprotocol/sdk` on Railway/Nixpacks to pin `"engines": { "node": ">=20.0.0" }`.

---

### Problem 2.2: Paystack Test Mode `POST /charge` ("Pay with Transfer") Returning HTTP `400` on New Test Accounts
- **What happened**: Calling Paystack's `POST https://api.paystack.co/charge` with `bank_transfer` using a fresh Paystack test secret key (`sk_test_...`) returned HTTP `400` (`"Pay with Transfer is not available"`), whereas `POST https://api.paystack.co/transaction/initialize` succeeded with HTTP `200` and created a real transaction reference on the Paystack Test Dashboard.
- **How I worked out the cause**: Tested Paystack's Charge API vs. Transaction Initialize API in [`src/services/paystack.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/paystack.ts) and [`tests/step2-domain.test.ts`](file:///c:/Dev/EV-QR-Wallet/tests/step2-domain.test.ts). Paystack requires manual merchant activation for Dedicated Virtual Accounts / Pay with Transfer on `/charge`, even in test mode.
- **How I fixed it or worked around it**: Implemented `PaystackService.createBankTransferCharge` in [`src/services/paystack.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/paystack.ts#L45-L131) to attempt `POST /charge` first and automatically fall back to `POST /transaction/initialize` (creating a real transaction on the Paystack Test Dashboard) with deterministic test virtual account details (`Test Bank` / `Paystack-Titan`), paired with `npm run mock-pay` to sign and deliver real `HMAC-SHA512` `charge.success` webhooks to `/v1/webhooks/paystack`.
- **What I'd change in Chord, its docs, or its API**: Note in the exercise documentation that Paystack test accounts without PwT unlocked can use `/transaction/initialize` + signed `charge.success` webhooks to simulate bank transfers against real Paystack test references.

---

### Problem 2.3: Windows PowerShell Stripping `--` and `npm run` Consuming CLI Flags
- **What happened**: Running `npm run mock-pay -- --order ORD-0001 --amount-ngn 1000` in Windows PowerShell resulted in `tsx scripts/mock-pay.ts ORD-0001 1000` with the `--order` and `--amount-ngn` flag names stripped, causing the initial flag-only parser to print usage help instead of executing.
- **How I worked out the cause**: PowerShell treats the first `--` as its own end-of-parameters token and strips it before invoking `npm.cmd`. Without `--`, `npm` consumes `--order` and `--amount-ngn` into `npm_config_*` environment variables and forwards only the bare values as positional arguments.
- **How I fixed it or worked around it**: Updated [`scripts/mock-pay.ts`](file:///c:/Dev/EV-QR-Wallet/scripts/mock-pay.ts), [`scripts/station-scan.ts`](file:///c:/Dev/EV-QR-Wallet/scripts/station-scan.ts), and [`scripts/mcp-call.ts`](file:///c:/Dev/EV-QR-Wallet/scripts/mcp-call.ts) to accept clean positional arguments (`npm run mock-pay ORD-0001 1000`), `process.env.npm_config_*` variables, and `--flag` syntax interchangeably, and pre-seeded `ORD-0001` in [`src/db/index.ts`](file:///c:/Dev/EV-QR-Wallet/src/db/index.ts).
- **What I'd change in Chord, its docs, or its API**: Recommend positional CLI arguments (e.g., `npm run mock-pay ORD-0001 1000`) in cross-platform build exercise examples so Windows PowerShell users don't hit `npm run --` flag-stripping.

---

### Problem 2.4: Foreign Key Violation (`23503`) When Auditing `INVALID` QR Scans in `redemptions`
- **What happened**: The initial PRD schema defined `redemptions.pass_id TEXT NOT NULL REFERENCES passes(pass_id)` while Section 7.2 required writing an audit row to `redemptions` whenever a station scans a pass, including `INVALID` tokens (tampered MAC or unknown `pass_id`). Inserting an `INVALID` scan with a non-existent or forged `pass_id` caused Postgres to throw a foreign key constraint violation (`23503`).
- **How I worked out the cause**: Schema review and database constraint test in [`tests/step1-foundation.test.ts`](file:///c:/Dev/EV-QR-Wallet/tests/step1-foundation.test.ts).
- **How I fixed it or worked around it**: Made `pass_id` nullable (`pass_id TEXT REFERENCES passes(pass_id)`) in [`src/db/schema.sql`](file:///c:/Dev/EV-QR-Wallet/src/db/schema.sql#L36-L43) and stored `NULL` for `pass_id` when `result = 'INVALID'`, preserving full station scan auditing (`scan_id`, `station_id`, `result`, `created_at`) without violating referential integrity.
- **What I'd change in Chord, its docs, or its API**: In the reference data model for `redemptions`, make `pass_id` nullable so invalid/forged token scans can be audited in the same table without foreign-key violations.

---

### Problem 2.5: Missing Bank Account Columns on `swap_orders` & Ambiguous Expiry Timestamps in `get_order_status`
- **What happened**:
  1. `create_swap_pass_order` must return `{ order_id, amount_ngn, bank_name, account_number, expires_at, status }` on idempotent retries without calling Paystack a second time, and `get_order_status` must report the exact amount paid on `AMOUNT_MISMATCH` and late payments, but the initial `swap_orders` schema lacked `bank_name`, `account_number`, and `amount_paid_kobo`.
  2. When `get_order_status` returned both `expires_at` (30-minute transfer window) and `pass_expires_at` (30-day pass validity) in UTC (`Z`) on a `PASS_ISSUED` order, it was easy to confuse which expiry applied to the pass vs. the bank transfer window, and UTC was 1 hour behind Lagos local time (`WAT`, `UTC+01:00`).
- **How I worked out the cause**: Inspecting live `npm run mock-pay` and `get_order_status` outputs during end-to-end testing.
- **How I fixed it or worked around it**:
  1. Added `bank_name TEXT NOT NULL`, `account_number TEXT NOT NULL`, and `amount_paid_kobo BIGINT NOT NULL DEFAULT 0` to `swap_orders` in [`src/db/schema.sql`](file:///c:/Dev/EV-QR-Wallet/src/db/schema.sql#L10-L23).
  2. Formatted all API timestamps in **Lagos Time (`WAT`, `+01:00`)** via `toLagosIsoString()` in [`src/services/ridepay.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/ridepay.ts#L10-L18), and omitted `expires_at` once `status === 'PASS_ISSUED'` so only `pass_expires_at` is shown after pass issuance.
- **What I'd change in Chord, its docs, or its API**: Include `bank_name`, `account_number`, and `amount_paid_kobo` in the base `swap_orders` schema example, and recommend timezone-explicit (`+01:00` WAT) timestamps in tool outputs for Lagos-facing WhatsApp agents.
