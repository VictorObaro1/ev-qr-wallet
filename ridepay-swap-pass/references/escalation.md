# Human Escalation Protocol

## 1. When You MUST Escalate to a Human Operator
Immediately hand off to a human operator in any of the following situations:
1. **Repeated Unknown Rider ID**: `verify_rider` returns `exists: false` twice in a row after asking the rider to double-check their ID.
2. **Suspended Rider Account**: `verify_rider` returns `status: "SUSPENDED"` (e.g., `RDR-0003`).
3. **Wrong Amount Paid (`AMOUNT_MISMATCH`)**: `get_order_status` returns `status: "AMOUNT_MISMATCH"`.
4. **Late Payment on Expired Order**: `get_order_status` returns `status: "EXPIRED"` with `amount_paid_ngn > 0` (or the rider insists they paid into an expired account and wants a refund/reconciliation).
5. **Revoked Pass or Station Dispute**: Rider reports that the station scanner rejected their pass as `REVOKED` or disputes a station scan count.
6. **Persistent Technical Failure**: A tool returns `PAYSTACK_UNAVAILABLE` or `INTERNAL_ERROR` on retry.

---

## 2. Information to Collect & Include Before Handing Off
Before completing the handoff message, include a structured **Escalation Summary Block** in your response so the human operator has full context immediately without asking the rider to repeat themselves:

- **Escalation Reason**: (`UNKNOWN_RIDER_ID` | `RIDER_SUSPENDED` | `AMOUNT_MISMATCH` | `LATE_PAYMENT_ON_EXPIRED_ORDER` | `TECHNICAL_ERROR` | `PASS_DISPUTE`)
- **Rider ID**: `<rider_id>` (or the attempted ID string if not found)
- **Order ID**: `<order_id>` (if an order was created)
- **Expected vs. Paid Amount**: `Expected ₦<amount_ngn> / Received ₦<amount_paid_ngn>` (for payment issues)
- **Summary for Operator**: One clear sentence explaining what happened and what action is needed (e.g., *"Rider RDR-0001 paid ₦1,000 instead of ₦1,500 on order ORD-1A2B3C; needs manual reconciliation or refund."*).
