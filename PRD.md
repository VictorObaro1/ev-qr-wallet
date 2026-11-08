# PRD: EV-QR-Wallet Swap-Pass Agent (Chord Build Exercise)

## 1. Summary
An EV bike rider in Lagos messages a WhatsApp agent with their rider ID and asks to buy swap passes (minimum 2, maximum 10). The agent confirms the rider exists and is active, creates a one-time Paystack test bank-transfer order for the exact amount, confirms payment by checking order status through a tool (never trusting the rider's word "I paid"), and then issues a signed QR pass. A swap-station terminal scans the QR code and calls a dedicated REST endpoint that atomically decrements and returns how many swaps remain. After each use, the rider can see the remaining count from the station response or by asking the agent.

### Problem Statement
Prepaid battery-swap operators for electric delivery bikes lose rider time and revenue at the swap station because payment is manual: riders pay by bank transfer, wait for confirmation, and station staff reconcile transfers by hand. This agent lets a rider buy a bundle of swap passes in one WhatsApp conversation and get a scannable pass the station can validate in seconds. It is worth paying for because it removes cash handling and transfer disputes at the point of swap and gives the operator reconciled, per-swap revenue. Card/NFC hardware, physical swap stations, live money, and production rider PII are deliberately excluded; the station terminal and bank transfer trigger are simulated against a real backend and Paystack test mode.

---

## 2. Goals and Non-Goals

### Goals
1. **One complete, honest end-to-end WhatsApp flow**: verify rider, create order, verify payment, issue pass, redeem pass, and check balance.
2. **Real external integration via a custom MCP tool server**: calls Paystack (test mode) and persists state in Postgres.
3. **Visible, deterministic handling of failure modes**: unknown rider, suspended rider, unpaid order, wrong amount paid (`AMOUNT_MISMATCH`), expired transfer window (`EXPIRED`), late payment after expiry, exhausted pass (`EXHAUSTED`), invalid/tampered QR (`INVALID`), and duplicate order requests (idempotency).
4. **Clean evidence**: structured logs and reproducible scripts for the demo recording, README, field notes, and go-live note.

### Non-Goals (Deliberately Excluded)
- Physical hardware, real swap stations, or physical battery inventory management.
- Live Paystack keys or real NIBSS inter-bank transfers.
- Self-service refunds, disputes UI, or an operator web dashboard.
- Production-grade anti-fraud (phone-number-to-rider cryptographic binding and rotating dynamic QR codes are documented as go-live requirements).

---

## 3. Users

| User | Need |
| :--- | :--- |
| **Rider** | Buy swap passes quickly from a phone via WhatsApp, receive a scannable QR pass, and know how many swaps are left. |
| **Station Attendant (simulated)** | Scan a pass QR token and get an instant, authoritative `OK` or deny reason (`EXHAUSTED`, `EXPIRED`, `INVALID`, `REVOKED`) with remaining count. |
| **Operator (go-live note audience)** | Reconciled kobo-accurate revenue, zero station cash handling, no double-issuance or double-spend, and a clear human escalation path. |

---

## 4. Conversation Flow & Guardrails

### Happy Path
1. **Greeting / Intent**: Rider sends a greeting or says *"I want swap passes"*.
2. **Rider Verification**: Agent asks for the Rider ID (e.g., `RDR-0001`) and calls `verify_rider`.
   - If not found: agent asks once more to check for typos, then offers a human handoff.
   - If `SUSPENDED`: agent explains the account is suspended and hands off to a human.
3. **Quantity & Price Confirmation**: Agent asks how many passes the rider wants (`2` to `10` passes at `₦750` each) and explicitly states the total price in Naira before creating an order.
4. **Order Creation**: Once quantity is confirmed, agent calls `create_swap_pass_order` and replies with the bank name, account number, exact amount in Naira, order ID, and the 30-minute expiry time.
5. **Payment Execution (Simulated Bank App)**: Rider completes the transfer outside the chat (simulated via `mock-pay` or Paystack test checkout) and tells the agent *"I have paid"*.
6. **Payment Verification**: Agent calls `get_order_status`. Only `PAID` or `PASS_ISSUED` counts as paid.
7. **Pass Issuance**: Agent sends the QR image link (`qr_image_url`), the copyable fallback token (`qr_payload`: `RPP1.<pass_id>.<mac>`), and states the number of swaps remaining and pass expiry date.
8. **Station Redemption**: Rider presents the QR token at the simulated station (`POST /v1/passes/redeem`). The server validates the HMAC and atomically decrements `remaining`.
9. **Balance Notification**: The station response returns the remaining count immediately, and the rider can ask the agent *"How many swaps left?"* (which calls `get_pass_balance`).

### Rules the Skill Must Enforce
- **Never trust "I paid"**: Never state a payment is received or issue a pass unless `get_order_status` returns `PAID` or `PASS_ISSUED`.
- **Verify and confirm first**: Never call `create_swap_pass_order` before `verify_rider` returns `exists: true, status: "ACTIVE"` and the rider has confirmed the pass quantity/total.
- **Enforce bundle bounds**: Minimum `2` passes, maximum `10` passes per order.
  - *Reason for min 2*: Single-swap purchases do not justify bank-transfer latency; the WhatsApp flow exists for multi-swap prepaid bundles.
  - *Reason for max 10 (₦7,500)*: Caps per-order financial risk over an unauthenticated chat session.
- **Zero secret leakage**: Never reveal API keys, webhook secrets, HMAC secrets, internal database IDs, or another rider's data.
- **Escalate rather than guess**: On `AMOUNT_MISMATCH`, late payment after expiry, `RIDER_SUSPENDED`, or persistent API errors, clearly escalate to a human operator with the `rider_id` and `order_id`.

---

## 5. Architecture & Paystack Test Mode Mechanics

```text
Rider (WhatsApp Simulator in Chord)
        |
        v
Chord Teammate (skill: ridepay-swap-pass)
        |  MCP (Streamable HTTP over public HTTPS, Bearer Auth: MCP_BEARER_TOKEN)
        v
MCP Tool Facade (/mcp)  --[in-process service call, strips sensitive fields]-->
        |
RidePay Backend (Express + Postgres)
        |
        +---> Paystack Test API (POST /charge or /transaction/initialize, GET /transaction/verify/:ref)
        |           ^
        |           |  POST /v1/webhooks/paystack (charge.success, HMAC-SHA512 verified)
        |           +--- mock-pay CLI / endpoint (signs & sends real Paystack webhook in test mode)
        |
Station Simulator ---> POST /v1/passes/redeem (REST, Bearer Auth: STATION_BEARER_TOKEN)
```

### Architectural Decisions & Reasons
1. **Single Deployable Service with Strict Logical Separation**:
   - The MCP Facade (`/mcp`) and the RidePay REST API (`/v1/passes/redeem`, `/v1/webhooks/paystack`, `/v1/passes/:pass_id/qr.png`) run inside one Express + TypeScript service backed by Postgres, exposed over a single public HTTPS URL.
   - *Reason*: Eliminates multi-service deployment and tunnel drift while maintaining strict security boundaries via separate bearer tokens (`MCP_BEARER_TOKEN` vs. `STATION_BEARER_TOKEN`) and DTO sanitizers.
2. **The MCP Facade Security Boundary**:
   - Exposes **only the 4 rider-facing tools**. It strips raw Paystack responses, headers, and secrets, returning only rider-safe JSON fields.
3. **Why Station Redeem (`POST /v1/passes/redeem`) is REST, Not an MCP Tool**:
   - *Reason*: An LLM agent in conversation with a rider must have **zero capability** to decrement/spend a rider's swap passes, even if prompt-injected.
4. **How Paystack Test Mode & `mock-pay` Work Together**:
   - **Order Initialization**: `create_swap_pass_order` calls Paystack's live test API (`POST https://api.paystack.co/charge` with `bank_transfer`, falling back automatically to `POST https://api.paystack.co/transaction/initialize` with `channels: ["bank_transfer"]` if Pay with Transfer is not enabled on the test merchant account). This creates a real transaction on the Paystack Test Dashboard with a genuine `paystack_ref` and returns test virtual account details (`Paystack-Titan`, 10-digit account number, 30-minute expiry).
   - **Why `mock-pay` is Required**: In Paystack test mode, test virtual bank accounts are not connected to NIBSS/real Nigerian mobile banking apps—you cannot send a transfer from a real bank app to a test virtual account. The builder runs `mock-pay` (not an agent tool) to simulate the rider's bank transfer arriving. `mock-pay` constructs a standard Paystack `charge.success` webhook payload for the order's `paystack_ref`, signs it with `HMAC-SHA512(PAYSTACK_SECRET_KEY)`, and sends it to `/v1/webhooks/paystack`. This exercises the exact production webhook verification and database transaction logic, and allows deterministic testing of exact payment, under/overpayment (`AMOUNT_MISMATCH`), and late payment on an expired order.
   - **Why `get_order_status` Also Polls `GET /transaction/verify/:ref`**: If an order is still `PENDING_PAYMENT` locally when `get_order_status` is called (for example, if the payment was completed in Paystack's browser test checkout and the webhook was delayed), the backend queries Paystack's Verify API once to reconcile it. If the local order was already updated by a webhook (`PAID`, `PASS_ISSUED`, `AMOUNT_MISMATCH`, `EXPIRED`), the local database is authoritative and is not overwritten.

---

## 6. MCP Tools (Facade Specification)

All tools return structured JSON text. Tool errors follow a uniform envelope:
`{ "error": { "code": "<ERROR_CODE>", "message": "<human-readable explanation>", "retryable": boolean } }`.
No tool ever returns secret keys or raw Paystack objects.

### 6.1 `verify_rider`
- **Input**: `{ "rider_id": string }` (normalized to uppercase, e.g., `"RDR-0001"`)
- **Output**: `{ "exists": boolean, "rider_id": string, "display_name"?: string, "status"?: "ACTIVE" | "SUSPENDED" }`
- **Rate Limiting**: Max `5` failed lookups per minute (and `15` total lookups per minute) before returning `{ code: "RATE_LIMITED", message: "Too many rider lookup attempts. Please wait a minute.", retryable: true }`.
  - *Reason*: Prevents brute-forcing sequential `RDR-XXXX` IDs from chat while never blocking normal test conversations.
- **Deterministic Seed Roster**:
  - `RDR-0001` — `"Tunde Bakare"` (`ACTIVE`)
  - `RDR-0002` — `"Chinedu Okafor"` (`ACTIVE`)
  - `RDR-0003` — `"Sadiq Bello"` (`SUSPENDED` — used to test suspended-rider escalation)

### 6.2 `create_swap_pass_order`
- **Input**: `{ "rider_id": string, "quantity": integer, "idempotency_key": string }`
- **Validation & Behaviour**:
  1. Checks `rider_id` exists (`RIDER_NOT_FOUND`) and `status === 'ACTIVE'` (`RIDER_SUSPENDED`).
  2. Checks `2 <= quantity <= 10` (`QUANTITY_OUT_OF_RANGE`).
  3. **Idempotency**:
     - If an order with `idempotency_key` already exists and is still active (`PENDING_PAYMENT` and not expired) or was created within the last 10 minutes for the same `rider_id` and `quantity`, returns that existing order without calling Paystack again.
     - If the LLM accidentally reuses an old `idempotency_key` from an already-completed (`PASS_ISSUED`), `EXPIRED`, or `AMOUNT_MISMATCH` order, or if a different `rider_id`/`quantity` is passed with the same key, the backend namespaces/rotates the key so a fresh purchase is not blocked.
  4. Computes `amount_ngn = quantity * SWAP_PRICE_NGN` (`amount_kobo = amount_ngn * 100`).
  5. Calls Paystack test API, stores the row in `swap_orders` with `status = 'PENDING_PAYMENT'` and `expires_at = now() + 30 minutes`.
- **Output**:
  ```json
  {
    "order_id": "ORD-...",
    "rider_id": "RDR-0001",
    "quantity": 2,
    "amount_ngn": 1500,
    "bank_name": "Paystack-Titan",
    "account_number": "0000000000",
    "expires_at": "2026-11-08T01:00:00.000Z",
    "status": "PENDING_PAYMENT"
  }
  ```
- **Structured Errors**: `RIDER_NOT_FOUND` (`retryable: false`), `RIDER_SUSPENDED` (`retryable: false`), `QUANTITY_OUT_OF_RANGE` (`retryable: false`), `PAYSTACK_UNAVAILABLE` (`retryable: true`).

### 6.3 `get_order_status`
- **Input**: `{ "order_id": string }`
- **Behaviour**:
  1. Looks up `order_id` in `swap_orders` (returns `ORDER_NOT_FOUND` if missing).
  2. If `status === 'PENDING_PAYMENT'`:
     - Re-checks Paystack Verify API (`GET /transaction/verify/:paystack_ref`) once if Paystack says `success`.
     - If still unpaid and `now() > expires_at`, transitions `status` to `EXPIRED`.
  3. If `status === 'PAID'`, inside a single Postgres transaction (`SELECT ... FOR UPDATE`), creates the row in `passes` (`INSERT INTO passes ... ON CONFLICT (order_id) DO NOTHING`) with `expires_at = now() + 30 days` and updates `swap_orders.status = 'PASS_ISSUED'`.
- **Output**:
  ```json
  {
    "order_id": "ORD-...",
    "status": "PENDING_PAYMENT | PAID | PASS_ISSUED | EXPIRED | AMOUNT_MISMATCH | FAILED",
    "amount_ngn": 1500,
    "amount_paid_ngn": 1500,
    "passes_purchased": 2,
    "expires_at": "2026-11-08T01:00:00.000Z",
    "pass_id": "p_...",
    "qr_payload": "RPP1.<pass_id>.<mac>",
    "qr_image_url": "https://<host>/v1/passes/<pass_id>/qr.png",
    "remaining_uses": 2,
    "pass_expires_at": "2026-12-08T00:30:00.000Z"
  }
  ```
  *(Note: `pass_id`, `qr_payload`, `qr_image_url`, `remaining_uses`, and `pass_expires_at` are only present when `status === 'PASS_ISSUED'`. `amount_paid_ngn` allows the agent to see the exact discrepancy on `AMOUNT_MISMATCH` or detect when money arrived late on an `EXPIRED` order.)*

### 6.4 `get_pass_balance`
- **Input**: `{ "rider_id": string }`
- **Behaviour**: Validates `rider_id` exists, marks any passes where `expires_at <= now()` as `EXPIRED`, and returns all active passes (`status = 'ACTIVE' AND remaining > 0 AND expires_at > now()`) plus the sum of remaining swaps.
- **Output**:
  ```json
  {
    "rider_id": "RDR-0001",
    "active_passes": [
      {
        "pass_id": " in base64url",
        "qr_payload": "RPP1.<pass_id>.<mac>",
        "qr_image_url": "https://<host>/v1/passes/<pass_id>/qr.png",
        "remaining_uses": 1,
        "total_uses": 2,
        "expires_at": "2026-12-08T00:30:00.000Z"
      }
    ],
    "total_remaining": 1
  }
  ```

---

## 7. Pass and QR Design

### 7.1 Token Format & QR Delivery
- **QR Payload String**: `RPP1.<pass_id>.<mac>`
  - `RPP1`: Protocol version prefix (`RidePay Pass v1`).
  - `pass_id`: Cryptographically random 128-bit (16-byte) identifier, encoded in `base64url` (no padding).
  - `mac`: `HMAC-SHA256(PASS_HMAC_SECRET, pass_id)`, truncated to 16 bytes (128 bits), encoded in `base64url` (no padding), verified using constant-time comparison (`crypto.timingSafeEqual`).
- **Why this format**:
  - The HMAC lets the station endpoint reject malformed, tampered, or guessed pass IDs in memory before touching the database or locking rows.
  - The database `remaining` column is the **single source of truth**; the QR payload never encodes the remaining balance, so an old QR screenshot cannot reset a counter.
- **QR Image + Text Fallback**:
  - `GET /v1/passes/:pass_id/qr.png` renders a scannable PNG image of `RPP1.<pass_id>.<mac>`.
  - Both `qr_image_url` and `qr_payload` are returned to the agent so the rider sees a visual QR image in chat while the station simulator can also accept the copy-pasted `RPP1.<pass_id>.<mac>` string.

### 7.2 Station Redemption: `POST /v1/passes/redeem`
- **Authentication**: `Authorization: Bearer <STATION_BEARER_TOKEN>` (scoped strictly to station terminals; completely separate from `MCP_BEARER_TOKEN`).
- **Request Body**: `{ "token": string, "station_id": string, "scan_id": string }` (`scan_id` is a unique UUID/idempotency key generated per physical scan).
- **Transactional Behaviour**:
  1. **Idempotency Check First**: Query `redemptions` by `scan_id`. If `scan_id` was already processed, immediately return the stored `{ result, remaining: remaining_after, pass_id, scan_id, idempotent_replay: true }`.
     - *Reason*: Swap stations in Lagos operate over spotty 3G/4G; network retries on the same physical scan must never burn a second swap pass.
  2. **Format & HMAC Verification**: Parse `RPP1.<pass_id>.<mac>` and verify the HMAC using `crypto.timingSafeEqual`. If malformed or invalid MAC, insert an audit row in `redemptions` (`pass_id = NULL`, `result = 'INVALID'`, `remaining_after = 0`) and return `{ "result": "INVALID", "remaining": 0 }`.
  3. **Row Lock & State Evaluation (`SELECT ... FROM passes WHERE pass_id = $1 FOR UPDATE`)**:
     - If no row exists: record and return `{ "result": "INVALID", "remaining": 0 }`.
     - If `status === 'REVOKED'`: record and return `{ "result": "REVOKED", "remaining": remaining }`.
     - If `expires_at <= now()`: update `status = 'EXPIRED'` (if not already), record and return `{ "result": "EXPIRED", "remaining": 0 }`.
     - If `remaining <= 0` or `status === 'EXHAUSTED'`: record and return `{ "result": "EXHAUSTED", "remaining": 0 }`.
  4. **Atomic Decrement**:
     ```sql
     UPDATE passes
     SET remaining = remaining - 1,
         status = CASE WHEN remaining - 1 = 0 THEN 'EXHAUSTED' ELSE 'ACTIVE' END
     WHERE pass_id = $1 AND status = 'ACTIVE' AND remaining > 0 AND expires_at > now()
     RETURNING remaining;
     ```
  5. **Audit Record**: Insert into `redemptions (scan_id, pass_id, station_id, result, remaining_after)` and commit.
  6. **Response**: `{ "result": "OK" | "EXHAUSTED" | "EXPIRED" | "INVALID" | "REVOKED", "remaining": number, "scan_id": string }`.

### 7.3 Known Limits (Go-Live Note Material)
- **Static QR Screenshot Sharing**: A rider can screenshot their QR and send it to another rider. The server-side counter prevents creating free swaps (total swaps never exceed `total_uses`), but it does not prove *who* is standing at the station.
- **Production Mitigations**:
  1. Display the rider's registered name and photo/bike plate on the attendant's scanner screen after `POST /v1/passes/redeem`.
  2. Require a 4-digit rider PIN at the terminal or short-lived TOTP QR codes inside a rider mini-app.
  3. Enforce a cooldown window per pass (e.g., max 1 swap every 2 hours per `pass_id`, since a single bike does not deplete a battery in 30 seconds).
- **Offline Stations**: Stations without internet connectivity cannot query the live Postgres counter; offline cryptographic counters require NFC smartcards and are out of scope.

---

## 8. Data Model (Postgres Schema)

```sql
CREATE TABLE riders (
  rider_id       TEXT PRIMARY KEY,               -- e.g. 'RDR-0001'
  display_name   TEXT NOT NULL,
  chat_sender_id TEXT UNIQUE,                    -- Nullable in simulator; used in production to bind WhatsApp phone number to rider_id
  status         TEXT NOT NULL DEFAULT 'ACTIVE'  -- 'ACTIVE' | 'SUSPENDED'
);

CREATE TABLE swap_orders (
  order_id         TEXT PRIMARY KEY,             -- e.g. 'ORD-...'
  rider_id         TEXT NOT NULL REFERENCES riders(rider_id),
  quantity         INT  NOT NULL CHECK (quantity >= 2 AND quantity <= 10),
  amount_kobo      BIGINT NOT NULL,              -- Expected amount in kobo (quantity * SWAP_PRICE_NGN * 100)
  amount_paid_kobo BIGINT NOT NULL DEFAULT 0,    -- Actual amount received via webhook/verify (for AMOUNT_MISMATCH & late payment visibility)
  bank_name        TEXT NOT NULL,                -- Virtual account bank name returned to rider
  account_number   TEXT NOT NULL,                -- Virtual account number returned to rider
  idempotency_key  TEXT NOT NULL UNIQUE,
  paystack_ref     TEXT UNIQUE,
  status           TEXT NOT NULL,                -- 'PENDING_PAYMENT' | 'PAID' | 'PASS_ISSUED' | 'EXPIRED' | 'AMOUNT_MISMATCH' | 'FAILED'
  expires_at       TIMESTAMPTZ NOT NULL,         -- created_at + 30 minutes
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE passes (
  pass_id     TEXT PRIMARY KEY,                  -- 128-bit random base64url
  order_id    TEXT NOT NULL UNIQUE REFERENCES swap_orders(order_id), -- UNIQUE enforces one pass per order (issue-once guarantee)
  rider_id    TEXT NOT NULL REFERENCES riders(rider_id),
  total_uses  INT  NOT NULL CHECK (total_uses >= 2),
  remaining   INT  NOT NULL CHECK (remaining >= 0),
  status      TEXT NOT NULL DEFAULT 'ACTIVE',    -- 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED'
  expires_at  TIMESTAMPTZ NOT NULL,              -- created_at + 30 days
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE redemptions (
  scan_id         TEXT PRIMARY KEY,              -- Idempotency key per physical station scan
  pass_id         TEXT REFERENCES passes(pass_id), -- Nullable so INVALID token scans are still audited without FK errors
  station_id      TEXT NOT NULL,
  result          TEXT NOT NULL,                 -- 'OK' | 'EXHAUSTED' | 'EXPIRED' | 'INVALID' | 'REVOKED'
  remaining_after INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 9. Pricing & Configurable Constants

| Variable | Default | Reason |
| :--- | :--- | :--- |
| `SWAP_PRICE_NGN` | `750` | Standard per-swap tariff (stored as `75000` kobo internally). |
| `MIN_PASS_QUANTITY` | `2` | Minimum bundle size (`₦1,500`) to justify bank transfer overhead. |
| `MAX_PASS_QUANTITY` | `10` | Maximum bundle size (`₦7,500`) to bound risk per unauthenticated chat order. |
| `ORDER_EXPIRY_MINUTES` | `30` | Matches Paystack dynamic virtual account expiration window. |
| `PASS_VALIDITY_DAYS` | `30` | Standard 30-day prepaid pass lifecycle. |

---

## 10. Chord Teammate and Skill Package

### Directory Structure
```text
ridepay-swap-pass/
  SKILL.md
  references/
    pricing-and-limits.md
    payment-problems.md
    escalation.md
```

- **`SKILL.md`**: Business context, tone (clear, concise Nigerian English with optional light Pidgin warmth), strict step-by-step tool-use rules from Section 4, deterministic `idempotency_key` rules, and the ironclad *"never trust 'I paid' without `get_order_status`"* rule.
- **`references/pricing-and-limits.md`**: Swap price (`₦750`), min (`2`) and max (`10`) passes, 30-minute transfer window, and 30-day pass validity.
- **`references/payment-problems.md`**: Exact decision tree for `PENDING_PAYMENT`, `AMOUNT_MISMATCH`, `EXPIRED` (with `amount_paid_ngn == 0` vs `amount_paid_ngn > 0`), and `PAYSTACK_UNAVAILABLE`.
- **`references/escalation.md`**: When to hand off to a human operator and the exact context to collect and display (`rider_id`, `order_id`, expected vs. paid amount, issue summary).

### Chord Setup Protocol
1. Register the MCP server in Chord as **disabled** initially (`https://<public-url>/mcp`).
2. Put `MCP_BEARER_TOKEN` in `auth_token` (**never** in custom headers, which are world-readable via `mcp:read`).
3. Run tool discovery and verify health check (inspect the response body `status` field even on HTTP 200).
4. Set `enabled_tools` explicitly to `["verify_rider", "create_swap_pass_order", "get_order_status", "get_pass_balance"]`.
5. Set the teammate's `mcp_server_ids` explicitly to `[<server_id>]` (an empty array in Chord attaches all enabled workspace servers).
6. Enable the MCP server.
7. Required API key permissions: `mcp:create`, `mcp:read`, `mcp:manage`, `teammate:read`, `teammate:update`.

---

## 11. Notifications After Each Use

**Requirement**: After a station redemption, the rider knows how many swaps remain.

| Option | Mechanism | Status & Rationale |
| :--- | :--- | :--- |
| **B. Pull + Station Receipt (Primary)** | 1. `POST /v1/passes/redeem` returns `remaining` immediately to the station terminal display.<br>2. Rider asks *"How many swaps left?"* in WhatsApp and the agent calls `get_pass_balance`. | **Primary path (always active)**. Zero external webhook dependencies; works reliably in the simulator. |
| **A. Push (Stretch Goal)** | `POST /v1/passes/redeem` emits an event to Chord's outbound/event API if configured (`CHORD_WEBHOOK_URL` / API trigger) to message the rider proactively. | **Optional stretch goal**. Attempted only after Option B and all failure modes are verified; documented in field notes. |

---

## 12. Failure Modes & Expected Behaviour

| Situation | Trigger / Condition | Expected System & Agent Behaviour |
| :--- | :--- | :--- |
| **Rider ID not found** | `verify_rider` returns `{ exists: false }` | Agent asks the rider once more to double-check their ID; if still not found on retry, offers human handoff. No order is created. |
| **Rider suspended** | `verify_rider` returns `{ exists: true, status: "SUSPENDED" }` (e.g. `RDR-0003`) | Agent informs the rider their account is suspended and immediately escalates to a human operator. No order is created. |
| **Quantity below 2 or above 10** | Rider asks for `1` pass or `15` passes | Agent explains the `2` to `10` pass bundle limit, quotes the valid price range (`₦1,500`–`₦7,500`), and asks how many they want. |
| **Rider says "I paid", status still pending** | `get_order_status` returns `PENDING_PAYMENT` | Agent states payment is not confirmed yet, reminds the rider of the exact amount, account number, and `expires_at` time, and offers to check again shortly. |
| **Wrong amount paid** | Webhook receives `amount_paid_kobo != amount_kobo` -> status `AMOUNT_MISMATCH` | **Never issue a pass.** `get_order_status` returns `status: "AMOUNT_MISMATCH"`, `amount_ngn`, and `amount_paid_ngn`. Agent explains the discrepancy (`paid ₦X instead of ₦Y`) and escalates to a human for manual reconciliation/refund. |
| **Transfer window expired (unpaid)** | `now() > expires_at` while still unpaid -> status `EXPIRED`, `amount_paid_ngn: 0` | Agent explains the 30-minute transfer window has expired, warns the rider not to send money to that expired account, and offers to create a fresh order. |
| **Late payment after expiry** | Webhook arrives after `status == 'EXPIRED'` -> status stays `EXPIRED`, `amount_paid_ngn > 0` | **Never issue a pass automatically.** Agent detects `status: "EXPIRED"` with `amount_paid_ngn > 0`, informs the rider their payment arrived after the order expired, and escalates to a human with `order_id`. |
| **Duplicate order request** | Same `idempotency_key` (or active pending order for same rider & quantity) | Backend returns the existing `PENDING_PAYMENT` order; only one Paystack charge is ever created. |
| **Duplicate station scan** | Station retries `POST /v1/passes/redeem` with the same `scan_id` | Backend returns the original redemption result from `redemptions` without decrementing `remaining` a second time. |
| **Pass exhausted** | Station scans a pass with `remaining == 0` (or rider checks balance) | Station receives `{ result: "EXHAUSTED", remaining: 0 }`; in chat, agent tells the rider they have `0` swaps left and offers to buy a new bundle. |
| **Paystack / API down** | Paystack returns 5xx or times out | Tool returns `{ code: "PAYSTACK_UNAVAILABLE", retryable: true }`; agent apologises and offers to retry in a moment or hand off to a human. |
| **Chord turn gated** | `agent_invoked: false` in Chord runtime | Treated as a normal platform turn-gating outcome, not an application error. |

---

## 13. Field Notes Log Template (Populate Only With Real Events)

Record every real issue encountered during build, integration, and testing:
```markdown
### Problem N: <Short Title>
- **What happened**: <Exact error message, HTTP status, or unexpected agent behaviour>
- **How I found the cause**: <Logs, curl reproduction, payload inspection>
- **Fix / workaround**: <Code or configuration change applied>
- **Suggested change to Chord / docs / API**: <Actionable feedback>
```

---

## 14. Go-Live Note Outline (Half-Page, Owner-Readable)

1. **What the agent does and does not do**: Automated WhatsApp swap-pass sales and station QR validation; no cash handling, no self-serve refunds.
2. **What must be true before real customers**:
   - Live Paystack keys with Dedicated Virtual Accounts / Pay with Transfer enabled.
   - Connected production WhatsApp Business number.
   - **Phone-to-rider verification**: bind `riders.chat_sender_id` to the rider's verified WhatsApp phone number so riders cannot type someone else's `rider_id`.
   - Physical station scanner app integrated with `POST /v1/passes/redeem`.
   - Alerting & monitoring on webhook failures and database latency.
3. **What happens when a payment fails, mismatches, or arrives late**: `AMOUNT_MISMATCH` and late payments on `EXPIRED` orders are held without issuing a pass and routed to finance/support with the Paystack reference and order ID.
4. **The QR sharing limit and chosen mitigation**: Static QR codes can be screenshotted; mitigate at launch by displaying the rider's name/bike plate on the attendant's scanner screen and adding a 2-hour per-pass swap cooldown.
5. **Who owns support and refunds**: Station attendants handle scan retries; central operations/finance owns Paystack dashboard refunds and manual pass adjustments.

---

**Reference**: [Chord API Documentation](https://api.chordhq.xyz/docs/)
