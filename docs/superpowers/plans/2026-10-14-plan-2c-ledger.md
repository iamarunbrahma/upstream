# SDD ledger — plan: docs/superpowers/plans/2026-10-14-plan-2c-maintainer-signin.md
Spec: docs/superpowers/specs/2026-10-14-upstream-design.md (read). Executor: Native (executing-plans). Branch plan-2c-maintainer-signin from main d505a78.
Pre-flight: T1→T2 createMaintainerSession, maintainers.githubId UNIQUE — plan code from the same compiled scratch run — consistent.
Pre-flight: T1/T2/T3→T4 sessions, claims, GithubOAuth/PayPalIdentity used by the routes; T4→T5 signedInMaintainer; T4→T6 start routes and Deps edited by T6 — consistent.
Pre-flight: Ruling: Task 7 (live sign-in on the hosted app) can't run until the Render deploy; the plan says Tasks 1-6 can merge without it — it runs in Plan 3 after deploy — cost if wrong: the real OAuth round trips stay untested until then.
Task 1: complete (commits d505a78..99fa7bc, tests: pnpm test →    Duration  31.18s (tests 96%, import 4%, transform 1%))
Task 2: complete (commits 99fa7bc..1b47dce, tests: pnpm test →    Duration  34.42s (tests 95%, import 4%))
Task 3: complete (commits 1b47dce..79614a7, tests: pnpm test →    Duration  35.68s (tests 96%, import 4%))
Task 4: complete (commits 79614a7..e7fc468, tests: pnpm test →    Duration  32.10s (tests 96%, import 4%))
Task 5: complete (commits e7fc468..97aef6d, tests: pnpm test →    Duration  37.05s (tests 95%, import 4%))
Task 6: complete (commits 97aef6d..5d1be27, tests: pnpm test →    Duration  40.14s (tests 96%, import 4%))
Final: fixed I1 a stale row kept receiving a reused login's money and locked out the current holder (409) — GitHub sign-in proves who holds the login now, so the old holder's row, accruals and payout lines move to '~<their id>' (theirs again when they sign in under the new name), a seeded row in the way moves to '~seeded:<login>', and cached recipients naming the old login are cleared; signInMaintainer now always signs in and returns the session — 'gives a login to whoever GitHub says holds it now...', 'lets a maintainer rename into a login that only a sandbox claim used', route test now expects the reused login to sign in — RED→GREEN, suite 289/289 (09e2d9c)
Final: fixed I3 a missing verified_account read as 'not verified' and blamed the maintainer — identify now returns null for an attribute PayPal leaves out, the callback answers 503 'isn't fully set up' and logs which field (no tokens), .env.example and Task 7 list the two Log in with PayPal attributes to turn on and to record whether state is echoed — 'reports an attribute PayPal left out as missing...', 'explain a server setup problem, not the maintainer's...' RED→GREEN, suite 291/291 (ff10d49)
Final: review by fresh opus reviewer: no Critical, 3 Important (I1 fixed, I3 fixed, I2 ruled), 12 Minor; Review Focus 1, 2, 4, 5 hold, 3 partly; source matched the plan exactly.
Final: Ruling: I2 a never-signed-in maintainer's held money (up to 90 days) goes to whoever next registers their freed GitHub login — accruals are keyed by login (Plan 2b), so 'money follows the GitHub id' only holds once someone has signed in; the full fix carries GitHub ids from the resolver (FUNDING.yml /users lookup, commit author.id) through RepoRecipients into accruals and the payout join, which crosses into Plan 2b's resolver; deferred to a follow-up plan, and the rename path already clears cached recipients naming the old login — cost if wrong: a squatter on a freed login can collect that maintainer's unclaimed money after the 7-day hold.
Final: Ruling: claim-maintainer is kept (Plan 2b's ledger said 'removed in Plan 2c') because Plan 3's demo needs a seeded sandbox maintainer; it stays sandbox-only, and a later sign-in for that login adopts the seeded row — cost if wrong: an operator seeding a real maintainer's login would hand that row's PayPal id to whoever signs in with it (see M1).
Final: Ruling: resolver trusting stale FUNDING.yml logins (a squatter gets the share) — Plan 2b's resolver, part of the I2 follow-up — cost if wrong: as I2.
Final: Ruling: no notification when a session relinks PayPal — the spec has no notification channel; the 7-day hold is the mitigation — cost if wrong: a stolen session gets paid after a week unnoticed.
Final: Ruling: PayPal verified status is checked only at link time — as the spec asks — cost if wrong: an account that later loses verification keeps receiving payouts.
Final: Ruling: self-dealing through a second PayPal account — standing Plan 2b ruling — cost if wrong: up to $100/month per funder per maintainer.
Final: Ruling: in-memory rate limiter on more than one server — known Plan 1/2a design limit; one Render instance — cost if wrong: limits per instance, not global.
Final: Ruling: live OAuth round trips (state echo, scope encoding, GET return, attribute set) — Task 7 after the Render deploy — cost if wrong: an unverified detail of PayPal's flow.
Final: Ruling: cookie injection via a sibling domain or http MITM — out of scope; onrender.com is on the Public Suffix List and the site is https — cost if wrong: a planted state cookie.
Final: Ruling: app/api/login-links uses PUBLIC_URL ?? (Plan 2a code outside this diff) — noted for the Plan 3 deploy pass alongside M11 — cost if wrong: relative login links if PUBLIC_URL is set empty.
Final: Ruling: maintainer page styling — Plan 3 — cost if wrong: none now.
Final: Ruling: session titles left out of 'how agents use your package' — privacy, a title can identify a funder's project; reviewer agrees — cost if wrong: a thinner page.
Final: Ruling: GitHub ids stored as 4-byte integer — current ids are far below 2^31 — cost if wrong: a migration to bigint someday.
Final: minor (deferred): M1 claim-maintainer upserts without the lock or a github_id check (can overwrite a signed-in maintainer's PayPal and skip the hold); refuse rows with a github_id and seed only a login the operator controls.
Final: minor (deferred): M2 a crafted multi-byte state crashes timingSafeEqual (generic 500, not a bypass); compare byte lengths or hashes.
Final: minor (deferred): M3 linkPayPal can throw a UNIQUE violation past the route (500); map it to in-use.
Final: minor (deferred): M4 linking PayPal starts from a GET, so a cross-site page can start a relink; make it a same-origin POST.
Final: minor (deferred): M5 no PKCE on either flow (defense in depth).
Final: minor (deferred): M6 maintainer page copy: raw PayPal statuses lowercased, ISO dates, 'first payout from' stays after the date, no note that unlinked money returns after 90 days or that payouts need $1, relink doesn't warn about the week's wait.
Final: minor (deferred): M7 any non-401 failure shows the signed-out view; a JSON error body would crash the panel.
Final: minor (deferred): M8 test gaps: queued lines keep their payer_id after a relink, cancel path, in-use mapping, identify throwing/null at route level, expired state at route level, sign-out without Origin, the UNIQUE race.
Final: minor (deferred): M9 signing in again doesn't end the old session; maintainer_sessions is never pruned.
Final: minor (deferred): M10 sandbox detection is an exact string match on the API base (an older sandbox host or a trailing slash sends people to live PayPal).
Final: minor (deferred): M11 PUBLIC_URL is effectively required for sign-in behind Render's proxy but documented only for CLI links.
Final: minor (deferred): M12 callback catch blocks log nothing, so failed sign-ins can't be diagnosed (log the HTTP status only).
