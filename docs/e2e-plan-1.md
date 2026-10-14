# Plan 1 end-to-end run (14 Oct 2026)

A real Claude Code session, with Upstream loaded through `--plugin-dir`, against the local dev server.

- **Judge model:** `gemini-2.5-flash` (free-tier key)
- **Claude Code:** 2.1.299, headless (`claude -p`) sessions in a scratch project
- **Plugin loaded:** the session's init event lists MCP server `plugin:upstream:upstream` as connected, both tools (`mcp__plugin_upstream_upstream__upstream_receipt` and `..._approve`) and the `/upstream:receipt` command

## 1. The session

The prompt was: *"Create a tiny FastAPI app in main.py with one GET /todos endpoint ... using pydantic models. Create a virtualenv in .venv and install what you need into it ... Also write a requirements.txt."*

Claude wrote `main.py` (a FastAPI app with a pydantic `Todo` model) and `requirements.txt`, and created `.venv`. Its `pip install` was **blocked** because the session wasn't allowed to run it, which made a useful test case.

## 2. SessionEnd hook

The hook fired when the headless session ended, and a background process submitted the receipt. The receipt was on the server within about 8 seconds, after the registry lookups and the Gemini call. My first check came too early and found nothing.

## 3. Receipt in the agent

`/upstream:receipt`, run in the resumed session, printed:

```
Upstream receipt - untitled session

  fastapi    52.7%  Your entire API is built on FastAPI, handling all routing, requests, and responses.
  pydantic   47.3%  It defines your API's data models and ensures robust data validation for all incoming and outgoing data.

Waiting for your approval.  (receipt af328a2f-...)
```

Claude then asked whether to approve, skip or decide later. Answering "approve" called `upstream_approve`, and the receipt came back ending in `Approved.`

The title is "untitled session" because headless sessions don't get an `aiTitle`. Interactive sessions do.

## 4. An approved receipt stays approved

The SessionEnd hook fired again when the approve turn ended. The receipt stayed `approved`, with the same two items and shares. `hook.log` had no errors.

## 5. Server down

With the dev server stopped, a one-line session exited normally in 6 seconds. Within a second `hook.log` had:

```
2026-10-14T05:52:57.456Z receipt: fetch failed
```

The session itself showed nothing.

## Bugs this run found (each fixed with a failing test first)

- **A blocked install counted as installed.** The transcript records the attempted `pip install` even though it was denied. `parseTranscript` now drops tool calls whose result has `is_error: true`.
- **Virtualenv installs were invisible.** Claude Code installs with `.venv/bin/pip` and absolute interpreter paths, and only a bare `pip`/`python` was recognized. The command's base name is now matched. This matters because, since the security pass, only packages backed by an install or a manifest are credited.
