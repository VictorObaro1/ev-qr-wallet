# Payment Problems Decision Tree

Always call `get_order_status({ order_id })` before making any statement about a payment. Never trust a rider's message saying *"I paid"* without verifying via `get_order_status`.

---

## Case 1: `status === "PENDING_PAYMENT"`
- **Meaning**: Paystack has not confirmed the transfer yet, and the 30-minute transfer window is still open (`now < expires_at`).
- **What to do**:
  1. Tell the rider clearly: *"Your payment for order `<order_id>` has not been confirmed yet."*
  2. Repeat the transfer details so they can verify:
     - Bank: `<bank_name>`
     - Account Number: `<account_number>`
     - Exact Amount: `₦<amount_ngn>`
     - Transfer Window Expires At: `<expires_at>`
  3. Let them know bank transfers usually confirm within 1–2 minutes and offer to re-check as soon as they ask.

---

## Case 2: `status === "PASS_ISSUED"` (or `"PAID"`)
- **Meaning**: Exact payment (`₦<amount_ngn>`) is verified and the swap pass has been issued.
- **What to do**:
  1. Confirm payment received (`₦<amount_paid_ngn>`).
  2. Provide the scannable QR image link (`qr_image_url`) **and** the plain-text QR token (`qr_payload`, formatted as `RPP1.<pass_id>.<mac>`).
  3. State the remaining swaps (`remaining_uses`) and expiry (`pass_expires_at`).

---

## Case 3: `status === "AMOUNT_MISMATCH"`
- **Meaning**: The rider transferred the wrong amount (`amount_paid_ngn !== amount_ngn`, e.g. paid ₦1,000 instead of ₦1,500 or ₦2,250).
- **Rule**: **NEVER issue a pass on `AMOUNT_MISMATCH`.**
- **CRITICAL CHORD RULE**: **Do NOT call `handover_to_human` on the same turn where you report `AMOUNT_MISMATCH`**, because calling `handover_to_human` replaces your text explanation with `"One moment — connecting you with a teammate."` and hides the payment discrepancy from the rider!
- **What to do**:
  1. Send a normal text reply explaining the exact discrepancy: *"We received **₦<amount_paid_ngn>** for order `<order_id>`, but the required amount for `<passes_purchased>` passes was **₦<amount_ngn>**."*
  2. Explain that passes cannot be issued automatically when the payment amount does not match.
  3. Include the structured **Escalation Summary Block** (see `references/escalation.md`) with `rider_id`, `order_id`, expected `₦<amount_ngn>`, and paid `₦<amount_paid_ngn>`.
  4. Ask the rider to reply **"human"** (or **"connect me"**) to transfer the chat to a human operator, and call `handover_to_human` on that next turn.

---

## Case 4: `status === "EXPIRED"` with `amount_paid_ngn === 0` (Unpaid Expired Transfer)
- **Meaning**: The 30-minute transfer window (`expires_at`) passed and no payment was received.
- **What to do**:
  1. Inform the rider that order `<order_id>` expired at `<expires_at>` before any payment arrived.
  2. Warn them **not** to send money to that expired account number.
  3. Offer to create a **fresh order** with a new account number if they still want to purchase passes.
  4. Note that if they already sent money right at the deadline and it arrives late, we will escalate it to support for manual handling.

---

## Case 5: `status === "EXPIRED"` with `amount_paid_ngn > 0` (Late Payment After Expiry)
- **Meaning**: The transfer window expired first, and the rider's bank transfer of `₦<amount_paid_ngn>` arrived **after** expiry.
- **Rule**: **Automatic late-payment recovery is not built; NEVER issue a pass automatically on an expired order.**
- **CRITICAL CHORD RULE**: **Do NOT call `handover_to_human` on the same turn where you report a late payment**, or your explanation will be replaced by `"One moment — connecting you with a teammate."`
- **What to do**:
  1. Send a normal text reply acknowledging that we see their late transfer of **₦<amount_paid_ngn>** on expired order `<order_id>`.
  2. Explain that because the transfer arrived after the 30-minute payment window expired, a pass cannot be issued automatically by the bot.
  3. Include the structured **Escalation Summary Block** (follow `references/escalation.md`) with `rider_id`, `order_id`, and `amount_paid_ngn` so finance/support can manually reconcile or refund it.
  4. Ask the rider to reply **"human"** (or **"connect me"**) to transfer to a support operator, and call `handover_to_human` on that next turn.

---

## Case 6: Duplicate Order Requests
- **Meaning**: The rider or network retries the order creation request while an order is already `PENDING_PAYMENT`.
- **What to do**:
  - Pass the same `idempotency_key` to `create_swap_pass_order`. The backend returns the existing `PENDING_PAYMENT` order so only one Paystack charge is ever created. Share the existing order's bank transfer details.

---

## Case 7: `PAYSTACK_UNAVAILABLE` or `RATE_LIMITED` (`retryable: true`)
- **Meaning**: Paystack API timed out/returned 5xx, or too many rider ID lookups occurred in the last minute.
- **What to do**:
  - Apologize clearly for the temporary delay, ask the rider to wait a moment and try again, or offer to hand off to a human operator if the issue persists.
