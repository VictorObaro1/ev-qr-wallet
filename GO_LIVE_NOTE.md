# Go-Live Note: RidePay Swap-Pass WhatsApp Agent

**Audience**: Fleet Operations & Business Owner  
**Scope**: Pre-launch readiness assessment for moving `ridepay-swap-pass` from the Paystack Test / Simulator environment to production EV riders in Lagos.

---

## 1. What the Agent Does and Does Not Do
- **What it does**:
  - Verifies active riders (`verify_rider`), quotes bundle pricing (`2–10` passes at `₦750` each), and creates a one-time Paystack bank-transfer order (`create_swap_pass_order`).
  - Confirms payment strictly via server-side status (`get_order_status` backed by HMAC-SHA512 Paystack webhooks and Paystack Verify API—never trusting *"I paid"*).
  - Issues a cryptographically signed QR pass (`RPP1.<pass_id>.<mac>`) exactly once per paid order and lets riders check their remaining swaps (`get_pass_balance`).
  - Validates and atomically decrements swap passes at the station via a separate REST endpoint (`POST /v1/passes/redeem`) with per-scan idempotency (`scan_id`).
- **What it deliberately does NOT do**:
  - Cannot spend/decrement a rider's passes from chat (station redemption is isolated to REST).
  - Does not issue automatic refunds, partial-payment credits, or late-payment passes without human review.

## 2. What Must Be True Before Real Customers
1. **Live Paystack Keys & Dedicated Virtual Accounts**: Replace `sk_test_...` with live `sk_live_...` credentials and enable **Pay with Transfer / Dedicated Virtual Accounts (Titan/Wema)** on the production Paystack merchant account.
2. **Connected Production WhatsApp Business Number**: Connect the Chord teammate to the verified WhatsApp Business API sender.
3. **Phone-to-Rider Identity Binding (`chat_sender_id`)**: Bind the rider's verified WhatsApp phone number (`chat_sender_id`) to `riders.rider_id` so a rider cannot type another rider's ID to check their balance or generate orders on their account.
4. **Station Scanner App Integration**: Provision each physical swap station with a unique `station_id` and scoped `STATION_BEARER_TOKEN` pointing to `POST /v1/passes/redeem`.
5. **Monitoring & Alerting**: Configure alerts on 5xx webhook errors, `AMOUNT_MISMATCH` events, late payments on expired orders, and Postgres connection saturation.

## 3. When a Payment Fails, Mismatches, or Arrives Late
- **Unpaid & Pending (`PENDING_PAYMENT`)**: No pass is issued; the rider is reminded of the account number and 30-minute expiry window.
- **Wrong Amount Paid (`AMOUNT_MISMATCH`)**: The webhook records `amount_paid_kobo` and locks the order in `AMOUNT_MISMATCH`. No pass is issued. The agent quotes the exact difference (`paid ₦X vs expected ₦Y`) and escalates to **Finance/Support** with the `order_id`.
- **Late Payment After 30-Minute Expiry (`EXPIRED` with `amount_paid_ngn > 0`)**: The webhook records the late payment amount on the expired order without issuing a pass. The agent detects `amount_paid_ngn > 0` on the expired order and escalates immediately to **Finance/Support** for manual refund or credit.

## 4. The QR Sharing Limit and Chosen Mitigation
- **The Limit**: A static QR image can be screenshotted and forwarded to another rider. While the server-side Postgres counter guarantees no extra swaps are ever created (`remaining` cannot go below `0`), a static QR alone does not prove which rider is physically at the station.
- **Chosen Launch Mitigation**:
  1. **Attendant Screen Verification**: Include the rider's registered `display_name` and bike plate number in the station terminal display upon `POST /v1/passes/redeem` so the station attendant visually confirms the rider.
  2. **Per-Pass Swap Cooldown**: Enforce a minimum 90-minute cooldown between redemptions on the same `pass_id` (since a single delivery bike cannot deplete a full battery in minutes).

## 5. Ownership of Support and Refunds
- **Station Attendants**: Handle physical scan retries (safe due to `scan_id` idempotency) and direct riders with `EXPIRED` or `EXHAUSTED` passes back to WhatsApp.
- **Central Operations & Finance**: Own all human escalations from Chord (`AMOUNT_MISMATCH`, late payments on expired orders, and `RIDER_SUSPENDED` inquiries) and execute refunds via the Paystack Dashboard.
