---
description: Show this session's Upstream receipt and ask whether to approve it
allowed-tools: ["mcp__plugin_upstream_upstream__upstream_receipt", "mcp__plugin_upstream_upstream__upstream_approve"]
---

Call the `upstream_receipt` tool. Show its output to the user exactly as returned, inside a code block.
Then ask the user, in one short sentence, whether to approve this receipt, skip it, or decide later.

- If they say approve: call `upstream_approve` with the receipt id and `action: "approve"`, and show the result.
- If they say skip: call `upstream_approve` with `action: "skip"`, and show the result.
- If they want to decide later, or the answer isn't clear, stop. The receipt stays waiting.

Never approve or skip without the user's explicit answer.
