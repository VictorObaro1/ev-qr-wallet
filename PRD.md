# PRD: RidePay WhatsApp Swap-Pass Agent (`ridepay-swap-pass`)

## 1. Problem & Goal
**RidePay** operates battery-swap stations for commercial electric delivery bikes in Lagos, Nigeria. Riders lose time at swap stations waiting for staff to manually confirm bank transfers before swapping a battery.

**Goal**: Let a rider buy a bundle of prepaid battery swap passes (`2–10` passes at `₦750` each) on WhatsApp via Paystack bank transfer, verify payment server-side, receive a signed QR pass (`RPP1.<pass_id>.<mac>`), and redeem swaps at station scanners with real-time balance tracking.

**Out of Scope**: Physical swap hardware, live money/NIBSS transfers (uses Paystack Test Mode + webhook simulator), self-service refunds, and production rider PII.

---

## 2. Core User Flow & Business Rules

### Conversation Flow
1. **Verify Rider**: Agent asks for the Rider ID (`RDR-0001`) and calls `verify_rider`.
2. **Confirm Bundle & Price**: Rider chooses `2` to `10` passes (`₦750` per swap = `₦1,500` to `₦7,500`). Agent confirms the total before creating the order.
3. **Create Order**: Agent calls `create_swap_pass_order` and shares the bank name, account number, exact amount, Order ID, and 30-minute expiry time (WAT).
4. **Verify Payment & Issue QR Pass**: When the rider says *"I have paid"*, the agent calls `get_order_status`. Once `PASS_ISSUED`, it sends the QR image link (`qr_image_url`), pass token (`qr_payload`), remaining swaps, and 30-day pass expiry date.
5. **Redeem at Station & Check Balance**: The station terminal scans the QR token via `POST /v1/passes/redeem` (atomically decrementing `remaining`). The rider can check remaining swaps and their last 5 station scans anytime via `get_pass_balance`.

### Guardrails
- **Never trust *"I paid"***: Never issue a pass unless `get_order_status` returns `PAID` or `PASS_ISSUED`.
- **Verify & confirm first**: Only create orders for `ACTIVE` riders after they confirm pass quantity (`2–10`).
- **2-Step Human Escalation**: On `AMOUNT_MISMATCH`, late payment after expiry (`EXPIRED` with `amount_paid_ngn > 0`), `RIDER_SUSPENDED`, or repeated unknown Rider ID, first reply in chat with the exact reason and **Escalation Summary Block**, then call `handover_to_human` when the rider confirms.

---

## 3. Architecture

```text
Rider (Chord WhatsApp Simulator)
   │
   ▼
Chord Teammate (skill: ridepay-swap-pass)
   │  MCP Streamable HTTP (/mcp, Bearer: MCP_BEARER_TOKEN)
   ▼
RidePay Backend (Express + TypeScript + Postgres)
   ├──► Paystack Test API (/charge or /transaction/initialize, /transaction/verify/:ref)
   ├──◄ POST /v1/webhooks/paystack (HMAC-SHA512 signed charge.success)
   └──◄ POST /v1/passes/redeem (Station Scanner REST, Bearer: STATION_BEARER_TOKEN)
```

- **Strict Role Separation**: The MCP server exposes **only** the 4 rider tools (`verify_rider`, `create_swap_pass_order`, `get_order_status`, `get_pass_balance`). Station redemption (`POST /v1/passes/redeem`) is a separate REST endpoint so the chat agent can never spend a rider's swaps.
- **QR Token Security**: `RPP1.<pass_id>.<mac>` uses 128-bit `HMAC-SHA256(PASS_HMAC_SECRET, pass_id)` verified in constant time. The database holds the remaining swap count so screenshots of old QR codes cannot reset balances.

---

## 4. MCP Tools & REST Endpoints

### MCP Tools (`POST /mcp`)
| Tool | Input | Output Summary |
| :--- | :--- | :--- |
| **`verify_rider`** | `{ rider_id }` | `{ exists, rider_id, display_name?, status?: "ACTIVE" \| "SUSPENDED" }` |
| **`create_swap_pass_order`** | `{ rider_id, quantity, idempotency_key }` | `{ order_id, rider_id, quantity, amount_ngn, bank_name, account_number, expires_at, status: "PENDING_PAYMENT" }` |
| **`get_order_status`** | `{ order_id }` | `{ order_id, status, amount_ngn, amount_paid_ngn, passes_purchased, expires_at?, pass_id?, qr_payload?, qr_image_url?, remaining_uses?, pass_expires_at? }` |
| **`get_pass_balance`** | `{ rider_id }` | `{ rider_id, active_passes, total_remaining, exhausted_passes, recent_redemptions }` (includes last 5 station scans & WAT timestamps) |

### REST Endpoints
- **`POST /v1/webhooks/paystack`**: Verifies `x-paystack-signature` (`HMAC-SHA512`) and updates order to `PAID`, `AMOUNT_MISMATCH`, or `EXPIRED` (late payment).
- **`POST /v1/passes/redeem`**: Verifies `STATION_BEARER_TOKEN` and `RPP1` HMAC, enforces `scan_id` idempotency, locks the pass row (`FOR UPDATE`), and decrements `remaining`. Returns `{ result: "OK" | "EXHAUSTED" | "EXPIRED" | "INVALID" | "REVOKED", remaining, scan_id }`.
- **`GET /v1/passes/:pass_id/qr.png`**: Renders the scannable PNG QR code for the pass.
- **`GET /health`**: Health check (`200 OK`).

---

## 5. Data Model (Postgres)

- **`riders`**: `rider_id` (PK), `display_name`, `chat_sender_id`, `status` (`ACTIVE` | `SUSPENDED`).
  - *Seeded Roster*: `RDR-0001` (Tunde Bakare, `ACTIVE`), `RDR-0002` (Chinedu Okafor, `ACTIVE`), `RDR-0003` (Sadiq Bello, `SUSPENDED`).
- **`swap_orders`**: `order_id` (PK), `rider_id` (FK), `quantity` (`2–10`), `amount_kobo`, `amount_paid_kobo`, `bank_name`, `account_number`, `idempotency_key` (UNIQUE), `paystack_ref`, `status` (`PENDING_PAYMENT` | `PAID` | `PASS_ISSUED` | `EXPIRED` | `AMOUNT_MISMATCH`), `expires_at` (`+30m`).
- **`passes`**: `pass_id` (PK), `order_id` (UNIQUE FK — guarantees 1 pass issued per paid order), `rider_id` (FK), `total_uses`, `remaining`, `status` (`ACTIVE` | `EXHAUSTED` | `EXPIRED` | `REVOKED`), `expires_at` (`+30d`).
- **`redemptions`**: `scan_id` (PK — idempotency per scan), `pass_id` (nullable FK), `station_id`, `result`, `remaining_after`, `created_at`.

---

## 6. Failure Modes & Expected Behaviour

| Scenario | System & Agent Behaviour |
| :--- | :--- |
| **Unknown Rider ID (`exists: false`)** | Ask once to check for typos; if still not found on retry, offer human handoff. |
| **Suspended Rider (`RDR-0003`)** | Refuse order creation, explain account is suspended, send Escalation Summary Block, and offer human handoff. |
| **Invalid Quantity (`< 2` or `> 10`)** | Reject and ask the rider to pick between `2` (`₦1,500`) and `10` (`₦7,500`) passes. |
| **Rider says *"I paid"*, still `PENDING_PAYMENT`** | Do not issue pass; remind rider of bank account, exact amount, and expiry time. |
| **Wrong Amount Paid (`AMOUNT_MISMATCH`)** | Never issue pass; state `amount_paid_ngn` vs `amount_ngn`, send Escalation Summary Block, and offer human handoff. |
| **Expired Order (`amount_paid_ngn === 0`)** | Warn rider not to transfer to the expired account and offer to create a fresh order. |
| **Late Payment After Expiry (`amount_paid_ngn > 0`)** | Never issue pass automatically; acknowledge the late payment, send Escalation Summary Block, and escalate to support. |
| **Duplicate Order / Duplicate Scan** | `idempotency_key` on orders and `scan_id` on station scans return the original result without double-charging or double-decrementing. |
