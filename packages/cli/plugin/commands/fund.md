---
description: Add money to your Upstream budget through PayPal
argument-hint: <dollars>
allowed-tools: ["mcp__plugin_upstream_upstream__upstream_add_money", "mcp__plugin_upstream_upstream__upstream_payment_status", "mcp__plugin_upstream_upstream__upstream_budget"]
---

The user wants to add $ARGUMENTS dollars to their Upstream budget.

1. If $ARGUMENTS isn't an amount between 1 and 500 dollars, ask how much, and stop.
2. Call `upstream_add_money` with that amount. Show the user the PayPal link exactly as returned, and say nothing is charged until they approve it.
3. Wait until the user says they've approved it. Then call `upstream_payment_status` with the payment id, and show its answer.
4. If PayPal is still waiting, say so and stop. Never start another payment unless the user asks.
