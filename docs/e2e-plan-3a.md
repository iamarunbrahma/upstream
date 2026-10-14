# Plan 3a local run (14 Oct 2026)

The whole demo flow, with real PayPal sandbox money and the real Gemini judge, against the local dev server.

- **Server:** `next dev` with PGlite, `DEMO_MODE=1` and `MIN_PAYOUT_CENTS=1`, the sandbox app "Upstream"
- **Browser:** Chrome, driven through CDP (browser-harness), at 1512 px and at a 390 px phone width
- **Buyer:** the dedicated US sandbox personal account from Plan 2a

## Steps

| Step | What happened |
|---|---|
| Try the demo | `POST /demo/start` made a fresh account and landed on `/dashboard` with the four steps |
| Run a sample session | `POST /api/demo/sample-session` took 3.1 s. Gemini (`gemini-2.5-flash-lite`, prompt `judge-v2`) weighed 9 packages: hono 21.2% ("built on it"), vitest 18.6%, @hono/zod-validator 16.1%, zod 13.6%, typescript 8.8%, nanoid 8.6%, and three smaller ones |
| Add money | A $10 one-time payment through the PayPal popup; the budget showed $9.16 after PayPal's fee |
| Approve | The receipt switched to Approved, and "If we settled today" showed the split |
| Settle now | `POST /api/demo/settle` took 13.3 s, most of it GitHub lookups for the 9 repos. It said "Settled 1 developer's budget: $9.16 set aside for open-source maintainers." (After the security fix that followed, it answers only about the visitor's own budget: "Set aside $9.16 of your budget for open-source maintainers.") |
| Where the money went | $9.16 across 32 maintainers of 9 packages, all "not joined yet", since none of them has signed in to this sandbox |

No payout went out in this run: the 7-day hold for a newly linked maintainer means the payout leg is shown on the hosted demo, with Arun's sandbox account linked a week ahead (Plan 3b). Plan 2b's live run already sent a real sandbox payout.

## Things worth knowing

- **The PayPal popup pre-filled the developer's own email**, remembered by the browser. It had to be replaced with the sandbox buyer's. The Devpost testing notes should say to use the sandbox login even if PayPal suggests another account.
- **The index chart** shows usage from 15 of the 545 local sessions that used any package, and its money side updated live after the settlement (vitest and zod picked up funding).
- **Phone width:** no page scrolls sideways at 390 px. The header drops "How it works" and "Maintainers" there; the footer links to the maintainer page.
