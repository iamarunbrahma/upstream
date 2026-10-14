# Upstream - design spec

**Date:** 14 Oct 2026
**Event:** PayPal AI Hackathon (Devpost). Submission closes **12 Nov 2026, 12:00 PT** (13 Nov, 01:30 IST). Judging 1-15 Dec 2026.
**Builder:** Arun Brahma, solo. Goal: a top-3 prize plus one honorable mention (Agentic Commerce, Most Creative or PayPal + AI). Time budget 60h+.
**One line:** Your AI coding agent pays back the open source it builds with.

---

## 1. Problem and audience

AI coding agents now write a large share of new code, and they lean on open-source packages constantly. They install them, import them and read their docs. But they never visit a pricing page, never buy the paid tier and never sponsor anyone. The usage goes up while the money goes down.

The clearest public case: in January 2026 Tailwind Labs laid off 75% of its engineering team. Docs traffic had fallen about 40% and revenue about 80%, because AI tools were sending people around the docs that used to sell the paid product (Business Insider, DevClass, Socket, Jan 2026).

**Who it's for:**
- **Funders:** developers and engineering teams who use AI coding agents and are willing to put a small monthly budget toward the code their agents depend on. Companies that already make Open Source Pledge style commitments are the natural early buyers.
- **Recipients:** open-source maintainers, who get paid based on real agent usage instead of GitHub stars or who shouts loudest.

**Why existing tools fall short:** GitHub Sponsors, Open Collective and thanks.dev rely on a human picking a project, or on a static dependency list. None of them know what an agent actually leaned on in a given session. OpenAI's and Anthropic's maintainer programs give credits, not money.

## 2. What the user experiences

1. **Install once.** `npx upstream init` adds the Claude Code plugin (a hook plus an MCP server) and links the machine to an Upstream account.
2. **Fund once.** On the web dashboard, pick a monthly budget ($5 / $15 / $50) and subscribe with the PayPal button (JS SDK v6 subscription session). One-time top-ups go through PayPal Checkout.
3. **Code as usual.** When a Claude Code session ends, the hook builds a usage receipt locally and sends it to Upstream as *proposed*.
4. **See the receipt in the agent.** Running `/upstream:receipt` (or asking the agent) calls the MCP tool, which shows a receipt like this:
   `FastAPI 46% - your whole API layer is built on it. Pydantic 22% - every request model. httpx 9% - the two outbound calls...`
   You approve it, adjust it or skip it. A spending rule ("auto-approve receipts while under budget") can approve for you. The agent can only *propose* payments. The human or the rule they set approves them.
5. **Month end.** The settlement job turns approved receipts into dollars per package, then splits each package's share among its maintainers. Maintainers who have claimed are paid through **PayPal Payouts**.
6. **Maintainers** sign in with GitHub to prove who they are and with **Log in with PayPal** to link a verified PayPal account. After that they see earnings, payout status and a plain summary of how agents use their package.
7. **Public "Agent Usage vs Funding" index.** A chart of the packages agents lean on most, set against what those packages receive. It opens the pitch.

## 3. Architecture (approved 14 Oct)

```
 Developer machine                    Upstream server (Render)                    PayPal sandbox
 Claude Code session
   | SessionEnd hook
   v
 upstream CLI -- evidence only --> POST /api/receipts --> Package resolver (npm / PyPI -> GitHub)
 (no source code leaves                                     |
  the machine)                                              v
                                                    Attribution judge (Gemini)
                                                            |
 MCP tool shows receipt <--------- receipt (proposed) <-----+
 approve -------------------------> receipt (approved) --> Ledger <-- subscription / top-up payments <-- Subscriptions, Orders
                                                            |                    (webhooks)
                                                            v
                                                    Settlement job --> maintainer split
                                                            |
                                                    Payouts batch -----------------------------> Payouts API
                                                    item status <-------- webhooks <------------ SUCCEEDED / UNCLAIMED / RETURNED
```

**Repository layout** (one repo, pnpm workspace):

| Path | Job | Depends on |
|---|---|---|
| `packages/cli` | `upstream` CLI: `init`, `scan`, `receipt`. Builds evidence from a Claude Code transcript or a git diff. | Node 20+, no network except the Upstream API |
| `packages/plugin` | Claude Code plugin: `SessionEnd` hook, MCP server (`upstream_receipt`, `upstream_approve`), `/upstream:receipt` command | `packages/cli` |
| `apps/web` | Next.js app (UI and API routes) | the libs below |
| `apps/web/lib/evidence` | Evidence schema (zod), shared with the CLI | none |
| `apps/web/lib/resolver` | Package to repo to maintainers, cached in the DB | npm, PyPI and GitHub APIs |
| `apps/web/lib/judge` | Attribution judge: prompt, Gemini call, guardrails, fallback | `@google/genai` |
| `apps/web/lib/ledger` | Integer-cent ledger, settlement maths | Postgres (Drizzle) |
| `apps/web/lib/paypal` | Token cache, plans, subscriptions, orders, payouts, webhook verification, Log in with PayPal | PayPal REST |
| `apps/web/jobs/settle.ts` | Settlement run, called by Render cron or the demo "Settle now" button | ledger, paypal |

**Stack:** TypeScript throughout. Next.js (App Router), Drizzle and Postgres, `@paypal/react-paypal-js/sdk-v6` on the client, PayPal REST from the server, `@google/genai` for Gemini, `@modelcontextprotocol/sdk` for the plugin, and vitest. Hosted on Render (web service, Postgres, cron job), defined in `render.yaml`.

## 4. Evidence extraction (local, deterministic)

Input is the session transcript (`transcript_path` from the hook input) plus the repo's git diff for the session. The output is an evidence object per package. This object, the session title and some counts are the only things sent to the server.

| Signal | Source |
|---|---|
| `installed` | Bash `command` matching `npm i / install / add`, `pnpm add`, `yarn add`, `pip install`, `uv add`, `poetry add` |
| `manifestAdded` | Diff of `package.json`, `requirements*.txt` or `pyproject.toml` |
| `importFiles` | Files the agent wrote or edited (Write `content`, Edit `new_string`) that import the package |
| `usageLines` | Lines in agent-written code that reference the imported name (regex, JS/TS and Python) |
| `docsReads` | WebFetch / WebSearch URLs whose host matches the package's homepage or docs domain |
| `kind` | `dependency` or `devDependency` (from the manifest) |

**Excluded:** standard-library modules, workspace and local packages, and packages with no public repo. Transitive dependencies are out of v1 (see section 11).

**Task summary:** the session's `ai-title` entry. If there isn't one, nothing is sent. The user's prompts are never sent. `upstream receipt --dry-run` prints the exact payload before anything leaves the machine.

`upstream scan --diff <range>` builds the same evidence from a git diff alone. This covers Codex, Cursor and anyone without Claude Code. The `installed` and `docsReads` signals are missing in that mode.

## 5. Attribution judge (AI)

**Model:** Gemini, the Flash tier for the judge. The exact model id is pinned after listing the models available to the key. Temperature 0, JSON-schema output, a 20 s timeout.

**Input:** the evidence table, the session title and registry metadata (name, one-line description, homepage). READMEs are never fed in. All package-supplied text sits in a delimited data block, and the prompt says to treat it as data, not instructions.

**Output per package:** `{ package, weight: 0-100, role: "foundation" | "feature" | "helper" | "tooling", reason: string <= 140 chars }`.

**Rubric given to the model:**
- A *foundation* is a package the delivered work is structurally built on (framework, ORM, UI library).
- A *feature* package delivers one capability.
- A *helper* is a small utility.
- *Tooling* covers test runners, linters and bundlers.
- Weight follows how much of the delivered work would have to be rewritten without the package, not how often its name appears.

**Guardrails (deterministic, applied after the model):**
1. The judge cannot add packages. Any package missing from the evidence is dropped.
2. A package with evidence can't go below 1%. The weights are then normalised to 100.
3. If output is invalid or the call times out, retry once. Failing that, fall back to a fixed score (`3*installed + 2*importFiles + sqrt(usageLines) + docsReads`, with tooling halved), and label the receipt "estimated without AI".
4. Every receipt stores the model id, prompt version and raw output, so any allocation can be audited.

**Quality check:** `apps/web/lib/judge/eval/` holds 10 hand-labelled session fixtures, each with an expected top package and ordering. The CI test runs on recorded model responses, and asserts that the top package matches and that Kendall tau is at least 0.6. `pnpm eval:live` runs the same fixtures against the real model.

## 6. Maintainer resolution and split (deterministic)

- **Package to repo:** npm `repository` and `funding` fields, or PyPI `project_urls` (Repository, Homepage, Funding). Cached for 7 days.
- **Recipients:**
  - If the repo has a `.github/FUNDING.yml` with `github:` entries, those accounts are the project's stated wish. The package's share is split equally among them. An org entry, such as `github: [vercel]`, isn't paid directly. Its slice falls back to the 90-day committer rule below, applied to that repo.
  - Otherwise, the top 5 human committers of the last 90 days (bots excluded), weighted by commit count.
- **No AI here on purpose.** Who gets paid follows what the project itself says, or plain activity data that anyone can check.

## 7. Money flow (PayPal)

The platform account is an Upstream sandbox business account. All amounts are USD and stored as integer cents.

**Funding:**
- `scripts/paypal-setup.ts` creates a Catalog product and three billing plans ($5 / $15 / $50 monthly). It is idempotent.
- The subscribe button uses a JS SDK v6 subscription session.
- Webhooks:
  - `BILLING.SUBSCRIPTION.ACTIVATED` and `BILLING.SUBSCRIPTION.CANCELLED` set subscription state.
  - `PAYMENT.SALE.COMPLETED` credits the funder's budget for the cycle.
- One-time top-ups use an Orders v2 one-time payment session, capture on the server, and confirm with `PAYMENT.CAPTURE.COMPLETED`.

**Allocation:**
- Receipts carry weights, not dollars.
- At settlement, the funder's budget B for the period is split across their approved receipts: `package_cents = B * sum(session weight for package) / (100 * sessions)`. Rounding uses the largest-remainder method, so the cents always add up to B exactly.
- During the month the dashboard and the agent show a *projected* amount at the current pace.

**Spending rule:** each funder picks either "always ask" or "auto-approve while under budget". Proposed receipts not approved within 14 days are dropped from the period.

**Settlement and payout:**
1. Per-package cents are split per maintainer into accruals.
2. Accruals for claimed maintainers are summed across all funders. A recipient owed at least $1.00 is included in one Payouts batch per run.
   - `sender_batch_id` is the settlement id, so re-running is safe.
   - `sender_item_id` is the accrual group id.
   - Receivers use `recipient_type: PAYPAL_ID`, the verified account id from Log in with PayPal.
3. Below $1.00, the money carries over to the next run.
4. Unclaimed accruals are held for 90 days. After that they go back into the funder's next budget, so money never sits forever.

**Webhooks:**
- Payout item status comes from `PAYMENT.PAYOUTS-ITEM.SUCCEEDED / UNCLAIMED / RETURNED / FAILED`.
- Every webhook is verified with `POST /v1/notifications/verify-webhook-signature` and handled idempotently by event id.

**Production note (stated in the README, not built):** live Payouts needs PayPal approval. Holding funds on behalf of others raises money-transmission questions, and the production route is PayPal's multiparty / marketplace setup.

## 8. Screens

1. **Landing:** the Tailwind hook line and the Agent Usage vs Funding index (bar chart, top 15 packages).
2. **Developer dashboard:** budget and subscription status, the spending rule, sessions with receipt status, the current-period projection, and the "Settle now" button (demo mode only).
3. **Receipt detail:** evidence table, AI role and reason per package, approve or adjust sliders, model and prompt version.
4. **Maintainer page:** sign in with GitHub, link PayPal, claimed packages, earnings by month, payout item statuses, and "how agents use your package" (role mix and common session titles, anonymised).
5. **In the agent:** the `/upstream:receipt` output (plain text table) and approve or skip.

All copy uses everyday words. Charts follow the dataviz skill.

## 9. Judge and demo path

Judges won't have Claude Code, a Gemini key or PayPal credentials, so the hosted demo has to work on its own:
- **Demo mode** gives a seeded funder account and sandbox buyer login, both listed in the Devpost testing instructions.
- A **"Run a sample session"** button replays a recorded Claude Code transcript through the real pipeline, using real Gemini and the real PayPal sandbox.
- A seeded maintainer with a claimed sandbox PayPal account, so **Settle now** produces a real Payouts batch whose statuses update live from webhooks.
- The README covers running it locally for judges who want to build it.

**Video (under 3 min, public YouTube, Arun's voiceover):**
- 0:00 Tailwind hook
- 0:20 Build a small app with Claude Code
- 0:55 Receipt in the terminal, approve
- 1:15 Dashboard and the AI's reasons
- 1:35 Subscribe with PayPal
- 1:50 Maintainer links GitHub and PayPal
- 2:10 Settle, the Payouts batch goes out, statuses go green
- 2:35 Index chart and close

## 10. Error handling and testing

- **PayPal:** OAuth token cached until 60 s before expiry. Every POST sends a `PayPal-Request-Id`, so retries are safe. A batch with mixed results is handled per item.
- **Gemini:** the retry and fallback in section 5.
- **GitHub:** an authenticated token, resolver results cached, and a 403 rate-limit response turns into a "resolving later" state rather than an error.
- **Tests (vitest):**
  - the evidence extractor on fixture transcripts and diffs
  - judge guardrails and the fallback
  - ledger maths (largest remainder, carry-over, 90-day return)
  - settlement idempotency (same settlement id twice gives one batch)
  - webhook idempotency
- **Sandbox integration tests** run behind `PAYPAL_IT=1`.

## 11. Out of scope for v1

- Transitive dependencies. The pitch acknowledges xz-style deep dependencies and leaves them as the next step.
- Currencies other than USD.
- Native Codex and Cursor plugins (the generic `scan` covers them).
- Team and org accounts, and tax forms.

## 12. Hackathon compliance and sponsor tools

- **PayPal technologies:** Subscriptions and billing plans, Catalog products, Orders v2, JS SDK v6, Payouts, Webhooks and Log in with PayPal.
- **AI:** Gemini (attribution judge). Claude Code is both what Upstream instruments and the tool it was built with.
- **Repo:** public at `github.com/iamarunbrahma/upstream` under the MIT license, shown in the About section. The rules require public and open source, which overrides the usual private default.
- **Secrets:** environment variables only, never committed.
- **Sponsor tools:**
  - Render for hosting, cron and Postgres.
  - The APIMatic PayPal Context Plugin in Claude Code during the build.
  - AG Studio for the dashboards is a stretch goal, worth doing only if the core is done by 4 Nov. A project can win at most one sponsor prize.

## 13. Prerequisites from Arun (blocking)

1. Log in at developer.paypal.com (Face ID or password; Claude can't do this step). Claude then creates the sandbox app, enables Payouts and Log in with PayPal, and creates the sandbox accounts.
2. A Gemini API key (from the existing `gen-lang-client` GCP project), to be put in `.env.local`.
3. A Render account, and the hackathon's $50 credit claimed.
4. A GitHub OAuth app (Claude can create it in the browser while you're logged in to GitHub).
5. Voiceover recording for the demo video.

## 14. Timeline

| Week | Dates | Done when |
|---|---|---|
| 1 | 14-20 Oct | Sandbox app and accounts. CLI evidence extractor passing tests on 3 real transcripts. Resolver working for npm and PyPI. |
| 2 | 21-27 Oct | Judge with guardrails and eval passing. Receipts end to end, CLI to server to MCP approve. Subscriptions live in the sandbox. |
| 3 | 28 Oct-3 Nov | Ledger and settlement, Payouts batch, webhooks, Log in with PayPal maintainer claim. |
| 4 | 4-10 Nov | UI polish, index chart, demo mode, Render deploy, README, video, Devpost draft. |
| Buffer | 11-12 Nov | Fixes and final submit by 11 Nov evening IST. |

## 15. Open risks

- **Sandbox Payouts and Log in with PayPal permissions.** These get verified on day 1. If Log in with PayPal is blocked, the fallback is recipient `EMAIL` with a $0.01 verification payout.
- **Gemini model availability and quota on the key.** Verified on day 1.
- **"Who would pay?"** The pitch answers with opt-in budgets and company pledges. No made-up traction.
