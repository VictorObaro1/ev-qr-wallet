# Deployment Field Notes

Real issues hit while deploying and integrating the **EV-QR-Wallet (`ridepay-swap-pass`)** agent with Chord.

---

### Problem 1: MCP Probe Returned `401 UNAUTHORIZED` While Server Was Disabled
- **What happened**: After registering our Railway MCP server (`https://ev-qr-wallet-production.up.railway.app/mcp`) in Chord as disabled, running the tool discovery probe failed with:
  ```text
  MCP server error: MCP server returned HTTP 401: {"error":{"code":"UNAUTHORIZED","message":"Missing or invalid Authorization Bearer [REDACTED] for MCP server.","retryable":false}}
  ```
- **How I worked out the cause**: Our `/mcp` auth check only returns this `401` message when the `Authorization: Bearer` header is missing or wrong. Checking the Chord MCP docs (Section 3) showed why: *"a disabled server or workspace does not supply its stored bearer/API-key credential to these probes."* Because the server was disabled (`enabled: false`), Chord did not send the bearer token during the probe.
- **How I fixed it or worked around it**: Set `"auth_type": "bearer"`, saved the token in `"auth_token"`, attached the server to the teammate, **enabled the MCP server first**, and then ran tool discovery and health check.
- **What I'd change in Chord, its docs, or its API**:
  1. Send the stored `auth_token` when an admin probes a disabled server, or return a clear error like `"Enable the server before probing static credentials"` instead of sending an unauthenticated request that triggers a remote `401`.
  2. Update the rollout checklist in the docs so it doesn't tell builders to probe a static-auth server while it is still disabled.

---

### Problem 2: Test Chat Returned `502` When MCP Server Failed to Initialize
- **What happened**: Sending `"I need swap pass"` in the Chord Test Chat simulator returned:
  ```text
  The agent didn't answer (Chord returned 502). Try sending again.
  ```
- **How I worked out the cause**: Compared the `502` timestamp (`02:25 PM`) with our MCP setup logs. At `02:25 PM`, the teammate had the MCP server attached, but the MCP server was still failing auth (`401`). When tool initialization fails at the start of a chat turn, Chord returns a generic `502` in Test Chat.
- **How I fixed it or worked around it**: Enabled the MCP server with the valid bearer token and confirmed `/health` returned `status: "ok"`. After that (`02:39 PM`), Test Chat worked right away.
- **What I'd change in Chord, its docs, or its API**: Show the real reason on `502` errors in Test Chat (for example: `"502: Attached MCP server returned 401 during tool setup"`) so builders know right away that the MCP server caused the error.

---

### Problem 3: Human Operator Replies Did Not Appear in the Test Chat Window
- **What happened**:
  1. When the customer ("John") typed `"speak to someone"`, the chat handed off to a human (`human_active`).
  2. I clicked **Take over** in the Operator Inbox and sent `"Hello! John no Promo for now we'll inform you when we have. Thank you for understanding."`
  3. My reply showed up in the Operator Thread View, **but never appeared in John's Test Chat window**. Instead, Test Chat kept showing: `"No reply yet. If someone has taken over in Chord, their reply will appear here."`
- **How I worked out the cause**: Checked Chord's Threads docs and compared both screens. The Test Chat window only shows direct AI replies from the customer's own message request. It does not listen for new messages sent asynchronously from the Operator Inbox (`POST /v1/threads/{id}/messages`) or system handoff notices (`"One moment — connecting you with a teammate."`).
- **How I fixed it or worked around it**: Used the **Operator Thread View** alongside Test Chat during human takeover to show the operator's reply in the thread history, then clicked **Hand back** so the AI could reply in Test Chat again.
- **What I'd change in Chord, its docs, or its API**: Make the Test Chat window poll `/v1/threads/{id}/turns` or listen to `/v1/threads/{id}/events` so operator replies and handoff messages show up live in Test Chat.

---

### Problem 4: `handover_to_human` Replaced the Agent's `AMOUNT_MISMATCH` Explanation
- **What happened**: I simulated an underpayment (`₦1,000` paid on a `₦2,250` order, setting `status: "AMOUNT_MISMATCH"`) and typed `"I have paid"` in Test Chat. Instead of explaining that `₦1,000` was paid instead of `₦2,250`, the bot showed nothing in Test Chat and only posted `"One moment — connecting you with a teammate."` in the Operator View.
- **How I worked out the cause**: Checked Chord's Escalation Rules docs (*"How a handoff happens"*). Because our skill told the bot to *"Escalate immediately to a human operator"* on `AMOUNT_MISMATCH`, the bot called `get_order_status` and `handover_to_human` in the **same turn**. In Chord, calling `handover_to_human` wipes out the bot's text reply for that turn and replaces it with `"One moment — connecting you with a teammate."`
- **How I fixed it or worked around it**: Updated [`ridepay-swap-pass/SKILL.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) to use a **2-step handoff**:
  1. **Turn 1**: Do **not** call `handover_to_human` on the same turn as `get_order_status`. First, send a normal text reply explaining the `₦1,000` vs `₦2,250` mismatch with the Escalation Summary Block, and ask the rider to reply `"human"` to connect to an agent.
  2. **Turn 2**: Call `handover_to_human` on the next turn when the rider replies `"human"`.
- **What I'd change in Chord, its docs, or its API**: If the AI writes a message and calls `handover_to_human` in the same turn, send the AI's message to the user *first* before showing `"One moment — connecting you with a teammate."`

---

### Problem 5: Bot Thought Its Previous Balance Check Was "Wrong" After a Station Scan
- **What happened**:
  1. I checked the balance for `RDR-0002` in Test Chat, and the bot showed `1` swap left on pass `h8CLpZsFrHj7STb2tSTxMA`.
  2. I scanned that pass at the station (`POST /v1/passes/redeem`), which used the last swap (`remaining: 0`, `status: "EXHAUSTED"`).
  3. When I asked `"How many left"` in Test Chat, the bot replied: *"Total remaining swaps: 0. There are no active passes on this account. The pass details I showed earlier were wrong."*
  4. Also, because the Test Chat user is hardcoded as `"John"`, the bot kept warning that `RDR-0002` belongs to `"Chinedu Okafor"`, not `"John"`.
- **How I worked out the cause**: `get_pass_balance` only returned `active_passes` (`remaining > 0`). Once the last swap was used at the station, `active_passes` became empty (`[]`). Because the tool output didn't show exhausted passes or recent station scans, the AI assumed its earlier message was a mistake.
- **How I fixed it or worked around it**:
  1. Updated `get_pass_balance` in [`src/services/ridepay.ts`](file:///c:/Dev/EV-QR-Wallet/src/services/ridepay.ts) and [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts) to also return `exhausted_passes` and `recent_redemptions` (the last 5 station scans with `station_id`, `scan_id`, `result`, and Lagos WAT timestamp).
  2. Updated [`ridepay-swap-pass/SKILL.md`](file:///c:/Dev/EV-QR-Wallet/ridepay-swap-pass/SKILL.md) so the bot knows balance drops come from station scans and ignores the hardcoded `"John"` simulator name.
- **What I'd change in Chord, its docs, or its API**: Let builders change the simulated customer name in Test Chat instead of hardcoding `"John"`.

---

### Problem 6: MCP SDK Rejected Requests Without `Accept: application/json, text/event-stream` (`406`)
- **What happened**: `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` returned HTTP `406 Not Acceptable` whenever an HTTP client or probe called `POST /mcp` with standard `Accept: application/json` or `Accept: */*`.
- **How I worked out the cause**: Checked the SDK transport code and tested `POST /mcp` calls without `text/event-stream` in the `Accept` header.
- **How I fixed it or worked around it**: In [`src/mcp/facade.ts`](file:///c:/Dev/EV-QR-Wallet/src/mcp/facade.ts), set `req.headers.accept = 'application/json, text/event-stream'` if either media type is missing, and added a `200 OK` JSON response on `GET /mcp` for health checks.
- **What I'd change in Chord, its docs, or its API**: Document the exact HTTP method and `Accept` header Chord sends during `/health` and `/tools` probes, and warn builders about the MCP SDK `406` header check.
