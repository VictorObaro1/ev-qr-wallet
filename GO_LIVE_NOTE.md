# Go-Live Note: RidePay WhatsApp Swap-Pass Assistant

**For**: RidePay Business Owner & Operations Lead  
**Purpose**: What this WhatsApp assistant does today, its honest limits, and what we must put in place before launching to real riders in Lagos.

---

## 1. What the Assistant Does (and Does Not Do)
- **What it does**:
  - Checks that a rider's account is active, quotes the price for a bundle of 2 to 10 battery swap passes (`₦750` per swap), and gives them a bank account number to pay into via Paystack.
  - Checks with Paystack in the background before issuing anything—it **never** takes a rider's word when they type *"I have paid"*.
  - Once exact payment is confirmed, sends the rider a QR code pass on WhatsApp and tracks how many swaps they have left as they scan at stations.
- **What it does NOT do**:
  - It cannot send automatic refunds or issue passes when a rider pays the wrong amount or pays after the 30-minute payment window expires. Instead, it flags those cases and hands the chat over to your human support team.
  - It cannot deduct swaps inside WhatsApp—only the scanner at the swap station can deduct a swap.

## 2. What Must Be Ready Before Real Customers Use It
1. **Live Paystack Account**: Switch from our test Paystack key to your live Paystack business account with "Pay with Transfer" (dedicated virtual bank accounts) turned on.
2. **Official WhatsApp Business Number**: Connect the assistant in Chord to your registered company WhatsApp Business phone number.
3. **Match Phone Numbers to Rider Accounts**: Right now in test mode, anyone can type `RDR-0001`. Before launch, we must lock each Rider ID to that rider's registered WhatsApp phone number so riders can only check or buy passes for their own account.
4. **Station Scanner Setup**: Give each swap station tablet/scanner its own login token so you can see which station processed every swap.
5. **Breakage & Payment Alerts**: Set up instant WhatsApp/Slack/email alerts to the Operations Lead if Paystack goes down, if a payment webhook fails, or when a rider is waiting for human support in the Chord Inbox.

## 3. What Happens When a Payment Fails or Goes Wrong
- **Transfer hasn't arrived yet**: The assistant tells the rider the money hasn't landed yet, reminds them of the account number and 30-minute deadline, and offers to check again in a minute.
- **Rider pays the wrong amount (e.g., ₦1,000 instead of ₦2,250)**: No pass is issued. The assistant tells the rider the exact difference and hands the conversation to your Finance/Support team in Chord with the Order ID so you can top it up or refund it from the Paystack dashboard.
- **Rider pays late (after the 30-minute window expires)**: No pass is issued automatically. The assistant sees that money arrived late on an expired order and routes the chat to Finance/Support to confirm and resolve manually.

## 4. Who Owns What Day-to-Day
- **Station Attendants**: Scan rider QR codes at the station. If a pass says `0 swaps left` or `Expired`, they direct the rider back to the WhatsApp assistant to buy a new bundle.
- **Operations / Finance Team**: Watch the Chord Inbox for handed-off chats (wrong amount paid, late transfers, or suspended riders) and handle refunds in the Paystack dashboard.
