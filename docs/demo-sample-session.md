# The demo's sample session

"Run a sample session" on the hosted demo replays `apps/web/lib/demo/sample-session.json` through the same
evidence builder the upstream CLI uses, then through the real receipt pipeline: the package registries, the AI
judge and the spending rule. Nothing about the receipt is written by hand.

## How it was recorded (14 Oct 2026)

- A Claude Code agent was asked to build a small link-shortener API in TypeScript in an empty folder: Hono with
  `@hono/node-server`, zod through `@hono/zod-validator`, nanoid for the codes, and vitest tests. It was also asked
  to add `upstream-pay` as a dev dependency, with an `upstream` script that runs `upstream receipt`, and not to run
  it. It looked `upstream-pay` up on npm, installed the packages with npm, wrote the code and tests, and ran them
  (8 passing).
- The transcript Claude Code saved for that agent was then cut down to what a receipt can use and what is safe to publish:
  - Kept: the task as typed, the agent's text and tool calls, and the tool results.
  - Dropped: everything Claude Code attaches to a session for its own use (instructions, memory, settings,
    request metadata, thinking).
  - Anonymised: the project folder is shown as `/home/dev/linkshort`, the user name as `dev`, the email in npm's
    maintainer line as `<email hidden>`, and the session id is a new random one. The npm user name and the GitHub
    repository of `upstream-pay` stay as npm shows them, because they are public and are what the demo pays.
- The session has no title. Claude Code adds one only to interactive sessions, and the CLI never sends prompts.

`upstream-pay` shows up in the receipt as an installed dev tool with no imports, so the judge gives it a small share.
Its npm entry links to this repository, whose `.github/FUNDING.yml` names @iamarunbrahma, so that share is set aside for him.
