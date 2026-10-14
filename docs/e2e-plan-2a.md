# Plan 2a sandbox run (14 Oct 2026)

Real PayPal sandbox money, through the real dashboard, against the local dev server.

- **Server:** `pnpm --filter web dev` with PGlite, sandbox app "Upstream" on the US business account
- **CLI:** the rebuilt plugin bundle, with its own config dir so the real `~/.config/upstream` stayed untouched
- **Browser:** Chrome, driven through CDP (browser-harness)
- **Buyer:** a dedicated US sandbox personal account, created for this run. The two maintainer test accounts were kept out of funding, so Plan 2b's self-dealing check can be shown cleanly later.

## Budget after each step

| Step | What happened | Budget |
|---|---|---|
| 1 | `upstream dashboard` printed a one-time link; "Continue" opened the dashboard | $0.00 |
| 2 | Subscribed to the $5 plan | $4.34 |
| 3 | Topped up $10 | $13.50 |
| 4 | Captured the same order again, reconciled the subscription again | $13.50 (`credited: 0` both times) |
| 5 | Ticked auto-approve, sent a receipt from the fixture session | $13.50, receipt ends with `Approved.` |

The dashboard ended on "$13.50 in your budget", "You give $5 a month. Thank you." and "0 waiting for you, 1 approved."

## 1. Sign-in

The first click on "Continue to my dashboard" was **refused** with "This sign-in didn't come from this site". Captured over CDP, the form post carried `Origin: null` with `Sec-Fetch-Site: same-origin`. The confirmation page sent `Referrer-Policy: no-referrer`, and under that policy Chrome serializes a POST's origin as `null`. The page now sends `same-origin`, which keeps the code-bearing URL off other sites and lets the strict origin check pass. Fixed with a failing test first (commit "Let the sign-in page send its origin on Continue"). The second click signed in and landed on the dashboard.

Every route now also sends `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, checked live with `curl -I`. This came from a background security review between Tasks 9 and 10: a hidden frame could otherwise trick a click on "Continue" or on the auto-approve box.

## 2. Subscription

PayPal's popup took the sandbox login, showed $5.00 USD, and the buyer agreed. The page said "Thanks. Your first payment will show up here in a few minutes." and the plan section switched to "You give $5 a month."

- **Time to first payment:** PayPal stamped the transaction seconds after approval, but it was not yet in the transaction list when the SDK's `onApprove` ran its reconcile. A reconcile about 30 seconds later returned `{"status":"ACTIVE","credited":434}`.
- **Response shape:** as the code expects. The subscription transaction has `amount_with_breakdown.gross_amount` 5.00, `fee_amount` 0.66 and `net_amount` 4.34, plus `payer_name`, `payer_email` and `time`. No code change.
- The popup did not close after approval. It went to the sandbox home page and was closed by hand. The approval itself had already reached the page.

## 3. Top-up

The first click on "Pay with PayPal" showed "PayPal couldn't take the payment. Please try again." with no popup. The console said "Cannot show PaymentRequest UI in a preview page or a background tab." In Chrome, the v6 SDK tries Chrome's built-in payment sheet first, and the tab being driven was behind another tab. With the tab brought forward, the popup opened. The buyer was still logged in from Step 2, chose "Pay in full", and the page said "Thanks. $9.16 was added to your budget."

- **Response shape:** the capture has `seller_receivable_breakdown.gross_amount` 10.00, `paypal_fee` 0.84 and `net_amount` 9.16, with `custom_id` set to the Upstream account id. No code change.
- The two failed clicks each created an order that was never approved. Upstream stores nothing when an order is created, and credits only on capture, so they leave no trace in the budget.

## 4. Nothing double-counted

```
capture again:   {"credited":0,"fundedCents":1350}
reconcile again: {"status":"ACTIVE","credited":0,"fundedCents":1350}
```

## 5. Auto-approve

Ticking the box sent `PATCH /api/settings` (200), and `/api/me` showed `autoApprove: true`. Then:

```
Upstream receipt - Build a todo API with FastAPI

  fastapi    52.4%  Your whole API is built on this framework.
  pydantic   40.9%  Data validation and serialization for your API models.
  vitest      6.7%  Testing your code is important for reliability.

Approved.  (receipt b78b4499-...)
```

## Not covered here

- **Webhooks.** PayPal can't reach `localhost`. The live check happens after the Render deploy in Plan 3: register the webhook, set `PAYPAL_WEBHOOK_ID`, and fire `PAYMENT.SALE.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED` and `BILLING.SUBSCRIPTION.*` from the dashboard's Webhooks simulator.

## Surprises worth remembering

- Creating sandbox accounts, or reading their passwords, needs a real PayPal login on developer.paypal.com. A custom account lets you set the password yourself.
- The sandbox login popup pre-filled the developer's own email from an earlier sandbox login. Replace it with the test buyer's.
- The sandbox review page showed "You have $NaN.00 USD waiting" for the new buyer. That's PayPal's banner, not ours.
- Automation must drive the dashboard in the foreground tab, or the top-up button fails before any popup appears.
