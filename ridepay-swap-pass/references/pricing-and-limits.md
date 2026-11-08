# RidePay Pricing and Limits Reference

## 1. Pricing
- **Price per Swap Pass (`SWAP_PRICE_NGN`)**: **₦750**
- All totals are calculated as `quantity × ₦750`:
  - **2 passes**: ₦1,500 *(Minimum order)*
  - **3 passes**: ₦2,250
  - **4 passes**: ₦3,000
  - **5 passes**: ₦3,750
  - **6 passes**: ₦4,500
  - **7 passes**: ₦5,250
  - **8 passes**: ₦6,000
  - **9 passes**: ₦6,750
  - **10 passes**: ₦7,500 *(Maximum order)*

## 2. Quantity Limits
- **Minimum per order**: `2` passes (`₦1,500`).
  - *Why*: Single-swap purchases do not justify bank transfer delays; the WhatsApp agent sells prepaid multi-swap bundles.
- **Maximum per order**: `10` passes (`₦7,500`).
  - *Why*: Caps financial exposure per order in WhatsApp chat.
- **If a rider requests `< 2` or `> 10` passes**:
  - Do **not** call `create_swap_pass_order`.
  - Politely explain that bundles must be between **2 and 10 passes** (`₦1,500` to `₦7,500`) and ask how many passes within that range they would like.

## 3. Expiry Windows
- **Bank Transfer Order Expiry (`ORDER_EXPIRY_MINUTES`)**: **30 minutes** from order creation (`expires_at` on the order).
  - Riders must complete the bank transfer before `expires_at`.
  - Once expired, the virtual bank account should not be paid into.
- **Swap Pass Validity (`PASS_VALIDITY_DAYS`)**: **30 days** from pass issuance (`pass_expires_at`).
  - Any unused swaps on a pass expire 30 days after issuance.
