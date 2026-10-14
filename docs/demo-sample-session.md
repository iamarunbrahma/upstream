# The demo's sample session

"Run a sample session" on the hosted demo replays `apps/web/lib/demo/sample-session.json` through the same
evidence builder the upstream CLI uses, then through the real receipt pipeline: the package registries, the AI
judge and the spending rule. Nothing about the receipt is written by hand.

## How it was recorded (14 Oct 2026)

- A Claude Code agent was asked to build a small link-shortener API in TypeScript in an empty folder: Hono with
  `@hono/node-server`, zod through `@hono/zod-validator`, nanoid for the codes, and vitest tests. It installed the
  packages with npm, wrote the code and tests, and ran them (10 passing).
- The transcript Claude Code saved for that agent was then cut down to what a receipt can use and what is safe to publish:
  - Kept: the task as typed, the agent's text and tool calls, and the tool results.
  - Dropped: everything Claude Code attaches to a session for its own use (instructions, memory, settings,
    request metadata, thinking), and one directory listing of an unrelated folder.
  - Anonymised: the project folder is shown as `/home/dev/linkshort`, the user name as `dev`, and the session id
    is a new random one.
- The session has no title. Claude Code adds one only to interactive sessions, and the CLI never sends prompts.

Plan 3b records it again as an interactive session once `upstream-pay` is on npm. Then the agent can add it as a dev
dependency, and the session gets a title.
