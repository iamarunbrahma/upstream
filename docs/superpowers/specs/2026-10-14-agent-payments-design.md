# Upstream - paying from the agent (design spec)

**Date:** 14 Oct 2026
**Builds on:** `docs/superpowers/specs/2026-10-14-upstream-design.md` (sections 3 and 7).
**Decided with Arun (14 Oct):** fund the budget from inside the coding agent; Upstream's server uses PayPal's Agent Toolkit for the order (option "Agent + PayPal Agent Toolkit"); Arun approves every payment in PayPal.
**One line:** You tell your coding agent to add money to your Upstream budget, it starts a PayPal payment, you approve it in PayPal, and the agent confirms what was added.

---

## 1. Goal and success

Today a developer funds Upstream only on the dashboard. This adds the same money flow inside the agent they already use, so the agent itself transacts through PayPal, with the human approving each payment.

Success:
- In Claude Code, "add $10 to my Upstream budget" ends with the budget up by the net amount and the agent saying so.
- The agent can never complete a payment without the developer approving it on PayPal's page.
- The PayPal order is created and captured through PayPal's Agent Toolkit (`@paypal/agent-toolkit`), so judges see PayPal's AI tooling in the payment path.
- Everything runs on the PayPal sandbox.

## 2. What the developer experiences

1. In a Claude Code session started with the Upstream plugin, they ask in plain words ("add $10 to my Upstream budget"), or run `/upstream:fund 10`.
2. The agent calls `upstream_add_money` and replies with a PayPal link and one line: "Open this link, approve the payment in PayPal, then tell me when you're done."
3. They open the link, sign in to PayPal (on the demo, the sandbox buyer) and approve.
4. PayPal sends them to `/agent/paid`, a small Upstream page: "Payment approved. Go back to your agent to finish." (On cancel: "You cancelled this payment. Nothing was charged.")
5. They tell the agent they're done. The agent calls `upstream_payment_status`, which captures the payment and answers "Added $9.36 to your budget. Your budget is now $13.70."
6. `upstream_budget` answers "how much is in my Upstream budget?" at any time.

## 3. Why the toolkit runs on Upstream's server

PayPal's Agent Toolkit and its MCP server act for a **merchant**: they hold the merchant's credentials and create orders, invoices and subscriptions for that merchant. In Upstream the merchant is Upstream and the developer is the buyer. Running PayPal's MCP server inside the developer's agent would make the developer the merchant, charging themselves. So the toolkit runs on Upstream's server with Upstream's sandbox app credentials, and the developer's agent reaches it through Upstream's own MCP tools.

## 4. Components

**CLI plugin (`packages/cli`)**
- `src/mcp.ts`: three new tools next to the existing two.
  - `upstream_budget()`: budget, set aside, and the monthly plan if any.
  - `upstream_add_money({ dollars })`: whole or decimal dollars; returns the approval link and the order id.
  - `upstream_payment_status({ orderId })`: captures if approved and reports what was added; otherwise says what's still needed.
  - Each description says: call only when the user has asked to add money (or to check that payment), never on your own initiative, and never retry with a different amount without asking.
- `src/api.ts`: `addMoney(cents)`, `paymentStatus(orderId)`, `budget()` calls with the machine's token.
- `plugin/commands/fund.md`: `/upstream:fund <dollars>` runs the add-money flow and waits for the user before checking the status.

**Web app (`apps/web`)**
- `lib/paypal/agent-toolkit.ts`: builds `PayPalAgentToolkit` from `@paypal/agent-toolkit/ai-sdk` with only `orders: { create, get, pay }` enabled and `context: { sandbox: true }`. Exposes `createOrder(cents, returnUrl, cancelUrl)`, `getOrder(id)` and `captureOrder(id)` by calling the toolkit tools' `execute` directly. No language model is involved on the server: the developer's agent decided, Upstream's code carries it out.
- `lib/funding/agent-payments.ts`: `startAgentPayment(deps, accountId, cents)` and `finishAgentPayment(deps, accountId, orderId)`, with the limits in section 6.
- Routes, authorized with the machine token (`bearerToken` + `accountForToken`):
  - `POST /api/agent/payments` `{ cents }` -> `{ orderId, approveUrl }`
  - `POST /api/agent/payments/:id` -> `{ status: "added" | "waiting" | "cancelled", addedCents?, budgetCents }`
  - `GET /api/agent/budget` -> `{ budgetCents, setAsideCents, plan }`
- `app/agent/paid/page.tsx`: the return page.
- Migration `0009`: table `agent_payments` (`order_id` primary key, `account_id`, `cents`, `status` created | captured | cancelled, `created_at`, `captured_at`).

## 5. Data flow

1. `startAgentPayment` checks the limits, calls the toolkit's `create_order` with one item ("Upstream open-source budget", the amount), `returnUrl` = `${PUBLIC_URL}/agent/paid` and `cancelUrl` = `${PUBLIC_URL}/agent/paid?cancelled=1`, inserts the `agent_payments` row, and returns PayPal's `payer-action` (or `approve`) link.
2. `finishAgentPayment` loads the row for this account (404 if it belongs to another account or doesn't exist), reads the order with `get_order`, and:
   - APPROVED: captures with `pay_order`, then credits through the existing `creditCaptures` (net of PayPal's fee, keyed by capture id, so a retry never credits twice), marks the row captured.
   - COMPLETED: credits through `creditCaptures` again (a no-op if already credited) and answers "added".
   - CREATED / PAYER_ACTION_REQUIRED: answers "waiting".
   - VOIDED or expired: marks the row cancelled and answers "cancelled".
3. The toolkit's orders carry no `custom_id`, so ownership comes from `agent_payments`, not from the order. The webhook handler ignores captures without `custom_id` as it does today; the capture in step 2 is what credits the budget. Refunds keep working, because the funding record stores the capture id.

## 6. Safety rules

- **Human approval is the only way money moves.** The agent can create an order and check it; only PayPal's approval page, signed in by the developer, makes it payable.
- **Amounts:** $1 to $500 per payment, the existing top-up limits.
- **At most 3 unfinished agent payments** per account (status created, younger than 6 hours), and **at most $100 a day** of agent payments per account, counted on created payments in the last 24 hours that weren't cancelled. Over a limit, the tool says which limit and what to do.
- **Ownership:** an order id is only ever checked or captured for the account that created it.
- **Sandbox only:** `lib/paypal/agent-toolkit.ts` refuses to build unless `PAYPAL_API_BASE` is the sandbox address.
- **Rate limit:** the agent routes share the existing per-device submit limiter.
- **Logs:** never log the toolkit's access token or full order bodies.

## 7. Errors

- PayPal or toolkit failure on create: 502 "PayPal couldn't start the payment. Try again in a minute." No row is inserted.
- Capture says not approved: "waiting", with "Approve the payment in PayPal first."
- Capture fails for another reason: 502, the row stays created, and a retry is safe.
- Unknown or foreign order id: 404 "No such payment for this machine."
- The CLI turns every non-2xx into one plain sentence for the agent to show.

## 8. Testing

- Unit (`apps/web/test/agent-payments.test.ts`) with a fake toolkit: limits (amount, 3 unfinished, $100 a day), ownership, waiting / added / cancelled paths, crediting once across retries, nothing inserted when create fails, sandbox guard.
- Routes: token required, bodies validated, answers as in section 4.
- CLI (`packages/cli/test/mcp.test.ts`): the three tools call the API and word the answers; non-2xx becomes a sentence.
- Live sandbox run, recorded in `docs/e2e-agent-payments.md`: the toolkit creates the order on Upstream's sandbox app, the sandbox buyer approves, the capture credits the budget, and the dashboard shows it.

## 9. Video

Line 9 gets an agent scene: a Claude Code terminal where the developer asks for $10, the agent shows the PayPal link, PayPal's approval page, then "Added $9.36 to your budget." Filmed with the payout scenes after 21 Oct. The narration line may change to mention the agent paying.

## 10. Out of scope

- Subscriptions from the agent (create, change or cancel a plan). The dashboard keeps that.
- Running PayPal's MCP server in the developer's agent (section 3).
- A server-side language model choosing PayPal actions.
- Live (non-sandbox) payments.

## 11. Risks

- **Dependency weight:** the toolkit pulls in `ai` 4, `openai`, `@langchain/core`, axios and zod 3. Plan task 1 installs it alone, checks the web build and the Render build minutes, and stops if it conflicts with the app's zod 4 or Next 16.
- **Toolkit behaviour drift:** pin `@paypal/agent-toolkit@1.11.0`.
- **Approval link shape:** PayPal returns `payer-action` when `experience_context` is set; fall back to `approve`. Covered by a test with both shapes.
