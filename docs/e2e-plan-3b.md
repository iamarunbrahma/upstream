# Plan 3b hosted run (14 Oct 2026)

Upstream on Render, from the `render.yaml` Blueprint at commit 6a82702, then 7a9bb6a.

## What was deployed

| Resource | Plan | Notes |
|---|---|---|
| `upstream` web service | Starter | https://upstream-0s2y.onrender.com. The first build and deploy took about 2 minutes |
| `upstream-jobs` workflow | per-second compute | version ready with 3 tasks: `judge`, `settle`, `payouts` |
| `upstream-settle-monthly` cron | Starter | 06:00 UTC on the 1st |
| `upstream-payouts-daily` cron | Starter | 07:00 UTC daily |
| `upstream-db` Postgres | basic_256mb | 1 GB included |
| `upstream-shared` env group | | the demo flags, Gemini model, sandbox API base |

`render blueprints validate` passed before the deploy: 6 actions, valid.

## Checks

- **Pages:** `/`, `/dashboard` and `/maintainer` answer 200, with `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- **Try the demo:** made a fresh demo account and landed on the dashboard. The first click, made before the page had finished loading, did nothing; a second click worked.
- **Run a sample session:** 8.4 s end to end, "Weighed by gemini-2.5-flash-lite". Render's run history shows the matching `judge` task run, which completed in about 6 s. So the judge ran on Render Workflows, not in the web process.
- **GitHub sign-in:** after adding the OAuth app's id and secret, `/maintainer/github/start` answers 302 to GitHub with client `Ov23li8BtRO5eo8mqqxt` and the hosted callback.
- **PayPal webhook:** `09S714176K909483A` was registered through `/v1/notifications/webhooks` for 21 events: subscription, sale, capture, refund and reversal, and payout item. An unsigned event now answers 400 "bad signature" instead of 503 "not set up".

- **Maintainer sign-in:** with the Log in with PayPal return URL saved in the developer dashboard, Arun signed in at `/maintainer` with GitHub as @iamarunbrahma and linked a sandbox PayPal account. The page came back with "PayPal is linked" and "Your first payout can go out from 2026-10-21", the 7-day hold. `/api/maintainer/me` agrees.
- **CLI against the hosted site:** with the default API URL now the hosted one (caed668), `upstream init` registered a machine and `upstream dashboard` returned a one-time connect link that opened the dashboard page.

- **`upstream-pay` on npm:** after Arun turned on two-factor authentication, `npm publish` was approved with his security key. npm held the new package's first version for a few minutes behind a `0.0.0-stage` placeholder, then released `0.1.0`. A fresh `npx upstream-pay@0.1.0` and a global install both run, point at the hosted site, and `upstream init` prints the right `--plugin-dir`.
- **The sample session, recorded again (7f35896):** a helper agent built the same link shortener and added `upstream-pay` as a dev dependency. On the hosted site, a new demo account's Run a sample session took 7.6 s and was judged by gemini-2.5-flash-lite: hono 17.9% down to `upstream-pay` 2.1% (tooling). Run on its own, the resolver takes `upstream-pay` from npm to `iamarunbrahma/upstream`, and that repo's FUNDING.yml to @iamarunbrahma (GitHub id 6504730) at 100%.

## The budget guard

The guard runs every 3 hours in GitHub Actions with the `RENDER_API_KEY` secret.
- **First live run:** it failed and emailed, as designed. Render's bandwidth endpoint differs from its docs in three ways:
  - `startTime` and `endTime` must be ISO 8601, not Unix seconds.
  - A cron job id is "not found", so only web services are queried.
  - The unit is `mb`, not GB.
- **After the fix (7a9bb6a, with tests):** "This month's bandwidth: 0.00 GB of the 30 GB cap. Last day to run: 2026-12-16. Everything is inside the limits."
- **Plan names:** Render reports `starter` for all three services and `basic_256mb` for the database, which matches the guard's allowed plans.

## Money

The $50 "Hackathon Participant" credit is valid until 1 Oct 2027. Expected spend through 16 Dec is about $30. The guard suspends everything on 16 Dec, or at 30 GB of bandwidth in a month, or if a plan changes. A calendar reminder on 16 Dec says to delete the services.

## Still to check

- From 21 Oct, Settle now pays Arun through Payouts, and the webhook moves the line to "Paid".
- A real subscription and a real refund arriving through the webhook.
- `settle-pg.test.ts` against a throwaway Postgres.
