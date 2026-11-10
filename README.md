# EV-QR-Wallet Swap-Pass Agent (`ridepay-swap-pass`)

---

## Live Links & Submission Deliverables
- **Live Deployment (Railway)**: `https://ev-qr-wallet-production.up.railway.app`
- **Health Endpoint**: `https://ev-qr-wallet-production.up.railway.app/health`
- **MCP Server Endpoint**: `https://ev-qr-wallet-production.up.railway.app/mcp`
- **Deliverables**:
  - [ridepay-swap-pass/SKILL.md](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) — Custom Chord Skill & Reference Guides (`pricing-and-limits.md`, `payment-problems.md`, `escalation.md`)
  - [FIELD_NOTES.md](file:///c:/Dev/EV-QR-Wallet/FIELD_NOTES.md) — Chord Deployment Field Notes
  - [GO_LIVE_NOTE.md](file:///c:/Dev/EV-QR-Wallet/GO_LIVE_NOTE.md) — Half-Page Go-Live Note for the Business Owner
  - [PRD.md](file:///c:/Dev/EV-QR-Wallet/PRD.md) — Product Requirements Document
  - [postman_collection.json](file:///c:/Dev/EV-QR-Wallet/postman_collection.json) — Ready-to-Import Postman Collection

## Architecture Overview

```text
Rider (WhatsApp Simulator in Chord)
        |
        v
Chord Teammate (skill: ridepay-swap-pass/)
        |  MCP (Streamable HTTP over HTTPS, Bearer Auth: MCP_BEARER_TOKEN)
        v
MCP Tool Facade (/mcp)  --[strictly 4 rider tools, sanitized JSON DTOs]-->
        |
RidePay Backend (Express + TypeScript + Postgres / pg-mem)
        |
        +---> Paystack Test API (POST /charge -> fallback /transaction/initialize, GET /transaction/verify/:ref)
        |           ^
        |           |  POST /v1/webhooks/paystack (charge.success, HMAC-SHA512 verified)
        |           +--- npm run mock-pay (CLI payment simulator, signs & sends real webhook)
        |
Station Simulator (npm run station-scan) ---> POST /v1/passes/redeem (REST, Bearer Auth: STATION_BEARER_TOKEN)
```

### Key Repository Files
- [PRD.md](file:///c:/Dev/EV-QR-Wallet/PRD.md) — Complete Product Requirements Document.
- [src/db/schema.sql](file:///c:/Dev/EV-QR-Wallet/src/db/schema.sql) & [src/db/index.ts](file:///c:/Dev/EV-QR-Wallet/src/db/index.ts) — Postgres schema (`riders`, `swap_orders`, `passes`, `redemptions`) and seeded rider roster (`RDR-0001`, `RDR-0002`, `RDR-0003`).
- [src/services/token.ts](file:///c:/Dev/EV-QR-Wallet/src/services/token.ts) — `RPP1.<pass_id>.<mac>` token generation, constant-time `HMAC-SHA256` verification, and QR PNG rendering.
- [src/services/paystack.ts](file:///c:/Dev/EV-QR-Wallet/src/services/paystack.ts) — Paystack Test API client and `HMAC-SHA512` webhook verification.
- [src/services/ridepay.ts](file:///c:/Dev/EV-QR-Wallet/src/services/ridepay.ts) — Core domain logic, rate limiting, smart idempotency, transactional single-pass issuance, and atomic station redemption.
- [src/mcp/facade.ts](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts) — Streamable HTTP MCP server (`/mcp`) exposing strictly `verify_rider`, `create_swap_pass_order`, `get_order_status`, and `get_pass_balance`.
- [src/app.ts](file:///c:/Dev/EV-QR-Wallet/src/app.ts) & [src/index.ts](file:///c:/Dev/EV-QR-Wallet/src/index.ts) — Express HTTP server.
- [scripts/mock-pay.ts](file:///c:/Dev/EV-QR-Wallet/scripts/mock-pay.ts) — Builder CLI tool to simulate exact bank transfers, wrong-amount transfers (`AMOUNT_MISMATCH`), expired transfers, and late payments after expiry.
- [scripts/station-scan.ts](file:///c:/Dev/EV-QR-Wallet/scripts/station-scan.ts) — Builder CLI tool simulating the swap-station QR scanner (`POST /v1/passes/redeem`).
- [scripts/mcp-call.ts](file:///c:/Dev/EV-QR-Wallet/scripts/mcp-call.ts) — Builder CLI tool to invoke MCP tools (`verify_rider`, `create_swap_pass_order`, `get_order_status`, `get_pass_balance`) directly against local or live `/mcp`.
- [scripts/demo-walkthrough.ts](file:///c:/Dev/EV-QR-Wallet/scripts/demo-walkthrough.ts) — Automated end-to-end walkthrough of all 3 demo scenarios (`npm run demo`).
- [ridepay-swap-pass/SKILL.md](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) — Chord skill package and reference guides (`pricing-and-limits.md`, `payment-problems.md`, `escalation.md`).
- [GO_LIVE_NOTE.md](file:///c:/Dev/EV-QR-Wallet/GO_LIVE_NOTE.md) — Owner-readable production readiness note.
- [FIELD_NOTES.md](file:///c:/Dev/EV-QR-Wallet/FIELD_NOTES.md) — Engineering field notes log.

---

## Quick Start

### 1. Install Dependencies & Configure Environment
```powershell
npm install
Copy-Item .env.example .env
```
Edit `.env` to add your Paystack test secret key (`PAYSTACK_SECRET_KEY=sk_test_...`) and optional `DATABASE_URL` (if `DATABASE_URL` is left empty, the server automatically runs an embedded in-memory Postgres instance seeded with the test roster).

### 2. Run Automated Tests (All 3 Steps / 13 Tests)
```powershell
npm test
```

### 3. Start the Server
```powershell
npm run dev
```
The server starts on `http://localhost:3000`:
- Health check: `GET http://localhost:3000/health`
- MCP Facade: `POST http://localhost:3000/mcp` (Bearer token: `MCP_BEARER_TOKEN`)
- Station Redeem: `POST http://localhost:3000/v1/passes/redeem` (Bearer token: `STATION_BEARER_TOKEN`)
- Paystack Webhook: `POST http://localhost:3000/v1/webhooks/paystack` (`x-paystack-signature`)
- QR Image: `GET http://localhost:3000/v1/passes/:pass_id/qr.png`

---

## Testing Scenarios (Happy Path & Failure Modes)

### Seeded Rider Roster
| Rider ID | Display Name | Status | Purpose |
| :--- | :--- | :--- | :--- |
| `RDR-0001` | Tunde Bakare | `ACTIVE` | Happy path & payment failure tests |
| `RDR-0002` | Chinedu Okafor | `ACTIVE` | Secondary active rider |
| `RDR-0003` | Sadiq Bello | `SUSPENDED` | Tests `RIDER_SUSPENDED` human escalation |
| `RDR-9999` | *(Not in DB)* | — | Tests `exists: false` retry & escalation |

### Calling MCP Tools Directly (`npm run mcp`)
You can invoke any of the 4 MCP facade tools directly from your terminal against the live server:

```powershell
npm run mcp tools/list
npm run mcp verify_rider RDR-0001
npm run mcp create_swap_pass_order RDR-0001 2
npm run mcp get_order_status ORD-0001
npm run mcp get_pass_balance RDR-0001
```

### Simulating Payments (`npm run mock-pay`)
`ORD-0001` (`RDR-0001`, 2 passes = `₦1,500`) is pre-seeded out of the box, or you can pass any `ORD-XXXX` created by the agent:

1. **Exact Payment (Happy Path — ₦1,500)**:
   ```powershell
   npm run mock-pay ORD-0001
   ```
2. **Wrong Amount Paid (`AMOUNT_MISMATCH` — e.g. ₦1,000 instead of ₦1,500)**:
   ```powershell
   npm run mock-pay ORD-0001 1000
   ```
3. **Transfer Window Expired Without Payment (`EXPIRED`, `amount_paid_ngn: 0`)**:
   ```powershell
   npm run mock-pay ORD-0001 expire-only
   ```
4. **Late Payment Arriving After Expiry (`EXPIRED`, `amount_paid_ngn > 0`)**:
   ```powershell
   npm run mock-pay ORD-0001 expire-first
   ```

### Simulating Station QR Scans (`npm run station-scan`)
Once `get_order_status` issues the pass (`RPP1.<pass_id>.<mac>`), scan it at the simulated station terminal:

```powershell
# Normal scan (decrements remaining count)
npm run station-scan RPP1.<pass_id>.<mac> STN-LAGOS-01 SCAN-001

# Replay same scan_id (idempotent — returns same result without burning a second swap)
npm run station-scan RPP1.<pass_id>.<mac> STN-LAGOS-01 SCAN-001

# Tampered/invalid QR token (returns INVALID and logs audit row)
npm run station-scan RPP1.fake_pass_id.bad_mac
```

---

## Connecting to Chord

1. Deploy the server over public HTTPS (live at `https://ev-qr-wallet-production.up.railway.app`) and set `PUBLIC_BASE_URL=https://ev-qr-wallet-production.up.railway.app` in `.env`.
2. Upload the skill package in [ridepay-swap-pass/](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) (`SKILL.md` and `references/`) to your Chord teammate and publish the skill.
3. Follow the Chord MCP registration sequence:
   - Register the MCP server URL (`https://ev-qr-wallet-production.up.railway.app/mcp`) with `"auth_type": "bearer"` and `"auth_token": "<MCP_BEARER_TOKEN>"` (never in custom headers).
   - Set the teammate's `mcp_server_ids` explicitly to `[<mcp_server_id>]`.
   - Enable the MCP server (`"enabled": true`) so Chord supplies its stored `auth_token` during static-auth probes.
   - Run tool discovery (`/tools`) and health check (`/health`, confirming `status: "ok"` in the JSON response body).
   - Set `enabled_tools` explicitly to `["verify_rider", "create_swap_pass_order", "get_order_status", "get_pass_balance"]`.

---

## How AI Tools Were Used

I used **Antigravity (AI pair-programming assistant)** during this build to:
1. **Scaffold & test the TypeScript backend and MCP server**: Accelerated writing boilerplate for the Express + Postgres schema, `HMAC-SHA256` QR token signing, and Vitest test suite (`tests/`).
2. **Debug live integration edge cases**: Used AI to cross-referencing while debugging MCP static-auth probe behavior (`401` when `enabled: false`), `handover_to_human` turn replacement on `AMOUNT_MISMATCH`, and enriching `get_pass_balance` with the last 5 station scans (`recent_redemptions`).
3. **Architectural choices, business rules, Railway deployment.**
