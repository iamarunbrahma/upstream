# Upstream

**Your AI coding agent pays back the open source it builds with.**

AI coding agents now write a large share of new code, and they lean on open-source packages all the time. They install them, import them and read their docs. But they never visit a pricing page or sponsor anyone. In January 2026, Tailwind Labs laid off 75% of its engineers after AI tools sent people around the docs that used to sell its paid product.

Upstream turns what an agent actually used into money for the people who maintain it, through PayPal.

## How it works

1. **Install once.** A Claude Code plugin (a session-end hook and an MCP server) links your machine to an Upstream account.
2. **Fund a budget.** Subscribe for $5, $15 or $50 a month with PayPal, or add money once.
3. **Code as usual.** When a session ends, the plugin builds a receipt on your machine from what the agent installed, imported and used. Only package names and counts leave the machine, never source code. An AI judge (Gemini) weighs how much the work depended on each package, inside fixed limits.
4. **Approve.** You see the receipt in the agent (`/upstream:receipt`) and approve it, or let a rule approve it while you have money in the budget.
5. **Settle.** Each month, your budget is split across your approved receipts, then across each package's maintainers (the people its FUNDING.yml names, or its recent committers), to the cent.
6. **Get paid.** Maintainers sign in with GitHub and link a verified PayPal account with Log in with PayPal. They are paid through PayPal Payouts.

Safeguards built in:
- No payout to a funder's own PayPal account.
- At most $100 a month from one funder to one maintainer.
- A week's wait before a new maintainer's first payout.
- Refunds come back out of the budget.
- Money is tracked by GitHub account, so a renamed or reused username can't redirect it.

## PayPal and AI used

- **PayPal:** Subscriptions and billing plans, Catalog products, Orders v2, the JavaScript SDK v6, Payouts, Webhooks, and Log in with PayPal, all in the sandbox.
- **AI:** Gemini (`gemini-2.5-flash-lite`) as the attribution judge, with guardrails and a fallback when it's unavailable. Claude Code is both what Upstream instruments and the tool it was built with.

## Run it locally

You need Node 24+, pnpm 11, a PayPal sandbox app (developer.paypal.com) and, optionally, a Gemini API key.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local     # fill in the PayPal sandbox app's id and secret, and a Gemini key
pnpm --filter web paypal:setup --write           # creates the product and the three plans, writes their ids
pnpm --filter web dev                            # http://localhost:3000, with a local database in apps/web/.data

pnpm --filter upstream-pay build
node packages/cli/plugin/dist/upstream.mjs init  # links this machine to your local Upstream
node packages/cli/plugin/dist/upstream.mjs dashboard
```

Then:
- **Use it from Claude Code:** start Claude Code with the plugin, `claude --plugin-dir packages/cli/plugin`.
- **Run the tests:** `pnpm test`.
- **Run a settlement:** `curl -X POST localhost:3000/api/settle -H "authorization: Bearer $SETTLE_TOKEN"`.

`apps/web/.env.example` lists every setting, with what it's for.

## Layout

```
packages/core   evidence schema shared by the CLI and the server
packages/cli    the upstream command, the session-end hook, the MCP server and the Claude Code plugin
apps/web        Next.js app: receipts, the AI judge, funding, settlement, payouts, maintainer sign-in
docs            the design spec, the implementation plans and their ledgers, and records of live sandbox runs
```

## Status

A PayPal AI Hackathon entry. Everything runs against the PayPal sandbox.

Running this with real money would need PayPal's approval for live Payouts. Holding funds for others also raises money-transmission questions, and the production route is PayPal's multiparty (marketplace) setup.

## License

MIT
