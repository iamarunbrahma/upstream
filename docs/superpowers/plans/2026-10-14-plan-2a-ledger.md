# SDD ledger — plan: docs/superpowers/plans/2026-10-14-plan-2a-funding.md
Setup: branch plan-2a-funding from main 359f15f (in-place branch, no remote).
Arun (14 Oct): execution = Native; Task 10 sandbox buyer: Claude may log into the PayPal sandbox popup with one of the US sandbox personal TEST accounts it created.
Pre-flight (interfaces; all 10 tasks were applied together in a scratch worktree: 176 pass, tsc clean, next build ok, live sandbox catalog/subscription/order calls ok):
- T1 -> T2/T5/T6/T7: PayPalApi, FakePayPal, PayPalError{status,code}, toCents/fromCents — match.
- T2 -> T3/T5/T9: TIERS, TIER_KEYS, TierKey, planIdsFromEnv — match (schema imports TIER_KEYS).
- T3 -> T4/T5/T7/T8: webSessions, loginCodes, subscriptions, fundingEvents, webhookEvents, accountSettings — match.
- T4 -> T5/T8: withAccount (Bearer or cookie + same-origin) — match; T4 also edits Plan 1 CLI test fake (loginLink).
- T5 -> T6/T7/T8: FundingDeps, FundingError, recordFunding, fundedCents, netCents, reconcileSubscription, withFunding — match.
- T8 -> T9: /api/me shape {fundedCents, subscription, autoApprove, receipts, paymentsReady} — match FundingPanel.
No conflicts found.
Task 1: complete (commits 359f15f..ffad695, tests: pnpm test apps/web/test/paypal-client.test.ts →    Duration  96ms (tests 52%, import 28%, transform 13%, worker 7%))
Task 2: complete (commits ffad695..b83a88a, tests: pnpm test apps/web/test/paypal-plans.test.ts →    Duration  83ms (import 51%, transform 25%, tests 13%, worker 11%))
Task 3: complete (commits b83a88a..1b2b57a, tests: pnpm test apps/web/test/funding-schema.test.ts apps/web/test/db.test.ts →    Duration  2.41s (tests 85%, import 14%, transform 1%))
Task 4: note: my transcription script truncated packages/cli/src/commands.ts (open(p,'w') evaluated before reading it); restored from git and re-appended; caught by typecheck before commit.
Task 4: complete (commits 1b2b57a..013f8ca, tests: pnpm test apps/web/test/web-auth.test.ts packages/cli →    Duration  3.87s (tests 87%, import 11%, transform 2%))
Task 5: complete (commits 013f8ca..2caa166, tests: pnpm test apps/web/test/funding.test.ts →    Duration  5.04s (tests 94%, import 6%))
Task 6: complete (commits 2caa166..917d7a7, tests: pnpm test apps/web/test/topups.test.ts →    Duration  3.89s (tests 93%, import 7%))
Task 7: complete (commits 917d7a7..40fcf17, tests: pnpm test apps/web/test/webhooks.test.ts →    Duration  4.65s (tests 93%, import 6%, transform 1%))
Security (after Task 7): fixed login CSRF / session fixation on /connect (anyone could send a victim their own login link and have the victim fund the attacker's budget) — GET now only shows a confirmation page (peekLoginCode, no cookie, code not consumed); a same-origin POST consumes the code and sets the session; web-auth tests 'asks before signing in...' and 'refuses a sign-in posted from another site' RED->GREEN; suite 171/171 (commit e2bf3ff). Plan deviation: Task 4's /connect was GET-only.
Task 8: complete (commits e2bf3ff..256f907, tests: pnpm test apps/web/test/settings.test.ts apps/web/test/receipts.test.ts →    Duration  7.49s (tests 94%, import 5%, transform 1%))
Task 9: complete (commits 256f907..09bd210, tests: pnpm test apps/web/test/format.test.ts →    Duration  89ms (import 71%, transform 13%, worker 9%, tests 8%))
Security fix (after Task 9, 2ef1c6a): background review found clickjacking on /connect (hidden frame could trick a click on Continue, re-opening login CSRF; same for the dashboard's auto-approve toggle). Site-wide X-Frame-Options DENY + CSP frame-ancestors 'none' in next.config — frame-headers.test.ts RED→GREEN, suite 178/178.
Task 10: Ruling: live run found Continue refused (403) — the confirmation page's Referrer-Policy no-referrer makes Chrome post with Origin: null (captured via CDP: origin=null, sec-fetch-site=same-origin). Changed it to same-origin rather than loosening sameOrigin(): keeps the code-bearing URL off other sites, keeps the Origin check strict — test 'lets the browser send this site's origin when Continue is clicked' RED→GREEN, suite 179/179 (40939ac) — cost if wrong: a browser that still sends null would block sign-in, visible immediately.
Task 10: complete (commits 2ef1c6a..bd180a5, tests: pnpm test →    Duration  15.76s (tests 89%, import 7%, transform 3%))
Task 10: Ruling: used a new dedicated US sandbox buyer (created via a custom account with a self-set password, after the user logged in to developer.paypal.com) instead of a maintainer test account — keeps Plan 2b's self-dealing demo clean and avoids reading a password off the screen — cost if wrong: one extra sandbox account.
Final: review by fresh opus reviewer: no Critical, 6 Important, 12 Minor; Review Focus 1-4 hold, 5 partly.
Final: fixed I2 timeouts/dropped connections became bare 500s — 'turns a timeout or a dropped connection into a PayPalError' RED→GREEN, suite 186/186 (5660313)
Final: fixed I1 (server) SALE.COMPLETED for a sale PayPal doesn't list yet was marked done and never credited — now 503 'payment not listed yet', event id not stored, PayPal retries — 'asks PayPal to send a payment event again while PayPal doesn't list that payment yet' RED→GREEN, suite 186/186 (9f05b2b)
Final: fixed I5 capture webhook stored payer_id null forever (breaks 2b self-dealing check) — now fetches the order and reuses creditCaptures, and refuses an order whose owner differs — 'credits a completed capture from PayPal's order, with who paid, once' + 'credits nothing when a capture event names an account that didn't make the order' RED→GREEN, suite 186/186 (9f05b2b)
Final: fixed I4 /api/me could show a newer abandoned subscription over the ACTIVE one and invite a second — status-first ordering — 'shows the active subscription even when an abandoned one changed more recently' RED→GREEN, suite 186/186 (117fd57)
Final: fixed I1 (page) + I3 dashboard never re-checked an unlisted first payment, and after a failed record its only retry was paying again — recordPayment() keeps checking (12x10s subscription, 3x10s top-up), then 'Check again' repeats the same safe call — record-payment.test.ts 3 tests RED→GREEN, suite 186/186, web build OK (15c331c)
Final: Ruling: I6 refunds/reversals never reduce the budget — deferred to Plan 2b as a hard requirement (negative ledger entries + PAYMENT.SALE.REFUNDED/REVERSED, PAYMENT.CAPTURE.REFUNDED/REVERSED), because 2b introduces balance = funded - allocated and pays money out; in 2a only the displayed figure and auto-approve are affected — cost if wrong: a refunded funder keeps auto-approving receipts in 2a.
Final: Ruling: device token can PATCH /api/settings to enable auto-approve — stands: the same token can already approve receipts directly (Plan 1), so no new power — cost if wrong: an agent with the token approves its own receipts, which it could already do.
Final: Ruling: sending a victim a PayPal approval link for someone else's order/subscription — stands: social engineering outside the app; the money still lands on the creator's account only — cost if wrong: none to the platform.
Final: Ruling: no logout/session revoke/rotation — stands for 2a; sessions already expire; add logout in Plan 3's styled UI — cost if wrong: a shared computer stays signed in until expiry.
Final: Ruling: no upgrade/cancel UI — Plan 3 — cost if wrong: users cancel in PayPal instead, which the BILLING.SUBSCRIPTION.* webhook reflects.
Final: Ruling: auto-approve checks lifetime funded total — stands; 2b turns fundedCents into funded minus allocated — cost if wrong: over-approval only until 2b.
Final: Ruling: payer name/email kept in funding_events.raw — stands: normal payment record keeping; spec's privacy rules cover code and evidence — cost if wrong: revisit with a raw-field allowlist before public launch.
Final: Ruling: no paging/time-range limits on PayPal's transaction list — stands at demo volumes — cost if wrong: a very old subscription misses early payments in one reconcile.
Final: Ruling: webhook_events dedupe table grows forever — stands: operational, tiny at demo scale — cost if wrong: a cleanup job later.
Final: Ruling: PUBLIC_URL fallback behind a proxy — Plan 3 deploy sets PUBLIC_URL — cost if wrong: wrong login link host on Render, caught in Plan 3's live run.
Final: Ruling: no __Host- cookie prefix — stands: HttpOnly+SameSite=Lax+Secure in production already — cost if wrong: weaker against subdomain cookie injection, not applicable on a Render subdomain we control.
Final: minor (deferred): M1 `upstream dashboard` crashes with a stack trace when no browser opener exists (spawn ENOENT is async); add .on('error') and use `start` on win32.
Final: minor (deferred): M2 PayPal-Request-Id is random per attempt, so retries aren't PayPal-idempotent as spec §10 says; use stable ids like capture-${orderId}.
Final: minor (deferred): M3 copy: signed-out visitor sees 'missing token'; '$0.00 was added' possible on PENDING capture (now routed to 'still processing'); PayPal's fee never explained; onError hides clearer server messages; CLI says 'Upstream: missing token' before init.
Final: minor (deferred): M4 credit paths don't check amount bounds or currency; a non-USD capture credits 0 and reads 'already credited'.
Final: minor (deferred): M5 webhook verification sends a re-serialized event, not the original body; verify against a real event in Plan 3.
Final: minor (deferred): M6 no rate limits on POST /api/subscriptions, /api/topups, /api/login-links.
Final: minor (deferred): M7 .env.example lacks PAYPAL_WEBHOOK_ID, PAYPAL_PLAN_*, NEXT_PUBLIC_PAYPAL_CLIENT_ID, NEXT_PUBLIC_PAYPAL_ENV, PAYPAL_API_BASE, PUBLIC_URL.
Final: minor (deferred): M8 product lookup reads only the first 20 products, so setup stops being idempotent on a busy account.
Final: minor (deferred): M9 auto-approve checkbox: a failed PATCH is an unhandled rejection with no message.
Final: minor (deferred): M10 neither /connect nor the dashboard says whose account it is (show device label + created date).
Final: minor (deferred): M11 e2e doc row 2 implied subscribing alone produced $4.34 (row reworded during the I1 fix).
Final: minor (deferred): M12 test gaps: no route tests for capture/webhook routes (planned funding-api.test.ts never created), no concurrent-capture test, ORDER_ALREADY_CAPTURED first-credit net amount unproven live.
