# Day-1 checks (14 Oct 2026)

What the PayPal sandbox and the Gemini key can do, checked before building on them. No secrets or IDs here; the values live in `apps/web/.env.local` (git-ignored).

## PayPal sandbox

- **Accounts.** The developer account came with two default sandbox accounts, both registered in India (IN). Indian PayPal accounts are restricted for domestic receiving, Payouts and Subscriptions, so three US accounts were added:
  - one US **business** account, which owns the app and acts as the platform that pays out
  - two US **personal** accounts, which play maintainers (`SANDBOX_MAINTAINER_EMAILS`)
- **App.** "Upstream" (Merchant), owned by the US business account. Features on: Subscriptions, Payouts, Log in with PayPal, Payment links and buttons, JS SDK v6.
- **OAuth.** A client-credentials token request with the app's ID and secret succeeds.
- **Payouts: works.** `scripts/paypal-smoke.sh` sent $1.00 to a US personal sandbox account. The batch went `PROCESSING` and then `SUCCESS` within about 20 seconds, and the item status was `SUCCESS`.
- **Log in with PayPal: enabled, return URL deferred.** The email and PayPal account ID (payer_id) scopes are on, with consent-page links set. The dashboard **refuses to save `http://localhost:3000/...` as a return URL** ("Something went wrong saving the application"); the same save without it succeeds. Plan 2 adds the hosted `https://` callback once the app is deployed on Render.

## Gemini (free-tier key)

`pnpm --filter web models` lists Flash models up to `gemini-3.8-flash`. A one-line JSON-schema request to each candidate gave:

| Model | Result |
|---|---|
| gemini-3.8-flash | 503, high demand |
| gemini-3.7-flash | timed out (20 s) |
| gemini-3.5-flash | OK, 7.3 s |
| gemini-flash-latest | 503, high demand |
| gemini-2.5-flash | OK, 1.8 s |

**First choice: `gemini-2.5-flash`.** The judge has a 20 s timeout, and a demo must not fall back to fixed scores, so reliability beats recency on a free key. It scored top-1 10/10 and mean tau 0.87 on the eval.

**Changed later the same day to `GEMINI_MODEL=gemini-2.5-flash-lite`.**
- The free tier allows `gemini-2.5-flash` only **20 requests per day**. The 429 reads `generate_content_free_tier_requests, limit: 20`, with a reset about 17 hours away. That's too few to record a demo or get through judging.
- Quotas are per model. `gemini-2.5-flash-lite` scored the same on the `judge-v2` prompt (top-1 10/10, mean tau 0.87) and is faster.
- Enabling billing on the GCP project removes the limit. That's a decision for the owner.

## Surprises

- The default sandbox accounts are country-locked to the developer's country (India), even though the hackathon is US-centric.
- `http://localhost` return URLs can't be saved for Log in with PayPal.
- Several newer Gemini Flash models were overloaded (503) at 10:45 IST on a weekday.
