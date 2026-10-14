# Plan 2b sandbox run (14 Oct 2026)

Real PayPal sandbox payouts, real GitHub data and the real settlement code, against the local dev server and its PGlite database. The funder is Plan 2a's sandbox funder: $13.50 in the budget and one approved receipt (fastapi, pydantic, vitest).

- **GitHub:** no token. `GITHUB_TOKEN` was empty, and 60 requests an hour was plenty.
- **Maintainer claims:** recorded with `claim-maintainer`, **only in the local sandbox database**, as stand-ins until Plan 2c's sign-in.
  - fastapi's top committer was pointed at a second sandbox PayPal account (a maintainer test account).
  - pydantic's FUNDING.yml person was pointed at **the funder's own** PayPal account, to exercise the self-dealing check.
  - No real person was paid or contacted. Everything is PayPal sandbox money.

## What each run said

| Run | How | Summary | Budget / set aside |
|---|---|---|---|
| 1 | `pnpm --filter web settle` (dev server stopped) | "Settled 1 developer's budget: $13.50 set aside for open-source maintainers." | $0.00 / $13.50 |
| 2 | after the two claims, `POST /api/settle` on the dev server | "Gave $5.53 back to developers' budgets (...)", "Put $4.86 on 1 payout line.", "PayPal took the payout batch." | $5.53 / $7.97 |
| 3 | `POST /api/settle`, about 75 s later | "Checked 1 payout line with PayPal." | $5.53 / $7.97 |
| 4 | `POST /api/settle` again | nothing new, and no second batch | $5.53 / $7.97 |

Every run also reported "1 developer will be settled on a later run". That's Plan 1's test account: approved receipts, but an empty budget.

## Who got what (run 1)

The $13.50 was split by the receipt's weights, then by each repo's recipients, to the cent:

| Package | Recipients | Amounts |
|---|---|---|
| pydantic | the person its FUNDING.yml names | $5.53 |
| fastapi | no FUNDING.yml, so its top 2 human committers of the last 90 days | $4.86 and $2.21 |
| vitest | FUNDING.yml names the vitest-dev organisation, so its top 5 human committers | $0.55, $0.23, $0.08, $0.03, $0.01 |

pydantic resolved to `pydantic/pydantic`. Before Task 2's fix, the dry run had resolved it to its GitHub Sponsors link (`github.com/sponsors/...`). That left its $5.53 with nobody to pay. The versioned cache key made the dev database ignore that stale answer.

## The payout

- **Self-dealing:** the pydantic $5.53 was returned to the funder ("same-person") and never sent.
- **The line:**
  - Sent: one line, $4.86 to the second sandbox account, as `PAYPAL_ID`.
  - PayPal's status was `SUCCESS` within about 75 seconds of sending.
  - The line recorded `fee_cents = 25`, and PayPal's batch read back `SUCCESS` with 1 item, item fee $0.25, batch fees $0.25.
  - The fee is charged to the platform on top of the $4.86, not taken out of it.
- **Below $1:** the other committers' amounts (under $1, unclaimed) stay held. They return to the funder after 90 days if nobody claims them.
- **No second batch:** runs 3 and 4 created no new batch. Only the run-2 settlement has a batch id.

## Overlapping settlements on Postgres (Review Focus 1)

Docker wasn't running, so Arun pointed me to his Supabase organisation. I created a **new, dedicated** project, `upstream-overlap-test` (free tier, Sydney, Data API off), because the test wipes the database it runs against. His existing projects were not touched.

- `TEST_DATABASE_URL=<session pooler URL> pnpm test apps/web/test/settle-pg.test.ts` passed: three overlapping settlements set aside the $10 budget exactly once.
- With the `pg_advisory_xact_lock` line removed, it **failed**: `expected 3000 to be 1000`. All three runs spent the same budget. The lock was restored.
- Each query crosses the network to Sydney, so the test took about 32 s. Its timeout is now 240 s.

## Found and fixed along the way

Background security reviews of the Plan 2b commits found four problems. Each was fixed test-first. Details are in `docs/superpowers/plans/2026-10-14-plan-2b-ledger.md`.

1. **A payout batch could go out twice.** PayPal refuses a repeated `sender_batch_id` for 30 days only, and its `PayPal-Request-Id` gives Payouts no idempotency at all (both checked live).
   - A send that failed ambiguously is now retried for 25 days at most, then flagged for a person to check.
   - A "batch already exists" answer now yields the batch's id, from the link PayPal includes.
2. **A payout could be paid twice.** Payout webhooks trusted the event's body, and PayPal doesn't deliver them in order.
   - They now re-read the line from PayPal (`/v1/payments/payouts-item/{id}`).
   - Money PayPal has paid stays paid unless PayPal says it came back.
   - Blocked, denied, refunded or reversed money goes back to the funder instead of looping.
3. **A refund could be lost.** It was marked as handled when it arrived before its payment was recorded, or couldn't be read. Those cases now ask PayPal to resend (503), or show as a failed delivery (422).
4. **A pending refund could also be lost.** PayPal resends the same event body on every retry, so a refund first reported pending would never be seen to complete. Refund webhooks now re-read the refund from PayPal (`/v2/payments/refunds/{id}`, `/v1/payments/refund/{id}`).

## Surprises worth remembering

- Payouts' `PayPal-Request-Id` does nothing for idempotency: the same request id with the same `sender_batch_id` still gets "Batch with given sender_batch_id already exists". Only `sender_batch_id` protects you, and only for 30 days.
- PayPal charges $0.25 per payout line to the sender. A $1 payout costs the platform $1.25.
- A capture refund keeps PayPal's original fee (`paypal_fee: 0.00` on the refund), so the platform loses the whole refunded amount.
- Every settlement run records a settlement row, even when it has nothing to pay. That's harmless, but the table grows.
- Probing the refund APIs refunded $1 of the funder's top-up and $1 of their subscription payment in the sandbox. Webhooks can't reach `localhost`, so the local budget doesn't show those refunds. This is the same gap as below.

## Not covered here

**Webhooks.** Payout-item, refund and reversal events can't reach `localhost`. Their live check happens after the Render deploy in Plan 3, through the dashboard's Webhooks simulator and a real refund, with the webhook registered for funding, payout-item and refund events.
