# Paying from the agent: live sandbox run (15 Oct 2026)

Branch `agent-payments` at daf373b, run on a local server (`next dev -p 3100`, `PUBLIC_URL=http://localhost:3100`, a fresh PGlite database) against the real PayPal sandbox and Upstream's sandbox app. The machine was linked with `upstream init --api-url http://localhost:3100`, and the CLI's own API calls (`addMoney`, `paymentStatus`, `me`) drove it. This was done before merging, as the final review recommended, so the real toolkit was checked before anything deployed.

## The payment

| Step | Result | Time |
|---|---|---|
| `addMoney(1000)` | order `6TC64482PS7948045`, approval link `https://www.sandbox.paypal.com/checkoutnow?token=...`, created by PayPal's Agent Toolkit | 2 s |
| Approve in PayPal (sandbox buyer, fresh browser window) | PayPal returned to `http://localhost:3100/agent/paid?token=...&PayerID=...`, which read "Payment approved" | |
| `paymentStatus` | `{"status":"added","addedCents":916,"budgetCents":916}`: $10.00 less PayPal's $0.84 fee, so the capture carries `seller_receivable_breakdown` and the budget gets the net | 4 s |
| `me` | `balanceCents` 916 | |
| `paymentStatus` again | the same answer; the budget stayed at 916 (credited once) | |

## Cancelling

| Step | Result |
|---|---|
| `addMoney(500)` | order `545064760A5036613` |
| "Return to Test Store" on PayPal's page | PayPal sent the browser to `/api/agent/cancelled?token=545064760A5036613` (303), then `/agent/paid?cancelled=1`, which read "You cancelled this payment. Nothing was charged." |
| `paymentStatus` | `{"status":"cancelled","budgetCents":916}` |

## Other checks

- A made-up order id through the real toolkit: `PayPalError`, status 404, code `PAYPAL_API_HTTP_ERROR`, so expired orders read as cancelled.
- The server log had no access tokens, no `Bearer` headers and no "injecting env" lines from the toolkit's dotenvx dependency.

## Differences from the dashboard's PayPal flow

- PayPal's button reads "Continue to Review Order", not "Pay", and the page shows the buyer's shipping address. The toolkit's `create_order` sets neither `user_action` nor `shipping_preference`, and doesn't let us set them. The payment still completes; it's cosmetic.
- The cancel link on PayPal's page is named after the sandbox app ("Return to Test Store").

## On the hosted site (after merging, 1e06efa)

Render didn't start a deploy on its own after the push (auto-deploy is on, but no deploy appeared), so the web service was deployed by hand with `render deploys create srv-db7q3mdg1s2s73beth1g --commit 1e06efa`. Then, with a machine linked to https://upstream-0s2y.onrender.com:

| Step | Result |
|---|---|
| Routes without a token | `POST /api/agent/payments` and `POST /api/agent/payments/:id` answer 401; `GET /api/agent/cancelled` redirects (303) to `/agent/paid?cancelled=1` |
| `addMoney(500)` | order `3658137255495520A`, in 1 s |
| Approve in PayPal (sandbox buyer) | back at `/agent/paid`, "Payment approved" |
| `paymentStatus`, twice | `{"status":"added","addedCents":434,"budgetCents":434}` both times: $5.00 less PayPal's $0.66 fee, credited once |
| `addMoney(100)`, then "Return to Test Store" | `/agent/paid?cancelled=1`, "You cancelled this payment"; `paymentStatus` -> `cancelled`, budget still 434 |

## Still to do

- Publish `upstream-pay@0.2.0` (needs Arun's security key).
