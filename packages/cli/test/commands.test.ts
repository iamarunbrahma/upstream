import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, type Api } from "../src/api";
import { receiptCommand, type CommandDeps } from "../src/commands";
import { formatReceipt } from "../src/format";
import { view } from "./helpers";

const fixturePath = new URL("./fixtures/session.jsonl", import.meta.url).pathname;

const fakeApi = (submit: Api["submit"]): Api =>
  ({ submit, registerDevice: async () => ({ token: "t", accountId: "a" }), list: async () => ({ receipts: [] }),
     get: async () => ({ receipt: view }), decide: async () => ({ receipt: view }),
     loginLink: async () => ({ url: "http://up.test/connect?code=x" }) }) as Api;

function deps(api: Api): CommandDeps & { outs: string[]; logs: string[] } {
  const outs: string[] = [];
  const logs: string[] = [];
  return { api, out: (m) => outs.push(m), log: (m) => logs.push(m), readFile: (p) => readFileSync(p, "utf8"), outs, logs };
}

describe("receiptCommand", () => {
  it("prints the dry-run payload without calling the API", async () => {
    const d = deps(fakeApi(async () => { throw new Error("must not be called"); }));
    expect(await receiptCommand({ transcript: fixturePath, cwd: "/nonexistent", dryRun: true, quiet: false }, d)).toBe(0);
    expect(JSON.parse(d.outs[0]!).sessionId).toBe("sess-1");
  });

  it("submits and prints the formatted receipt", async () => {
    const d = deps(fakeApi(async () => ({ receipt: view, changed: true })));
    expect(await receiptCommand({ transcript: fixturePath, cwd: "/nonexistent", dryRun: false, quiet: false }, d)).toBe(0);
    expect(d.outs[0]).toBe(formatReceipt(view));
  });

  it("in quiet mode, a failing server or a missing transcript logs and exits 0", async () => {
    const d = deps(fakeApi(async () => { throw new ApiError(503, "server down"); }));
    expect(await receiptCommand({ transcript: fixturePath, cwd: "/nonexistent", dryRun: false, quiet: true }, d)).toBe(0);
    expect(await receiptCommand({ transcript: "/missing.jsonl", cwd: "/nonexistent", dryRun: false, quiet: true }, d)).toBe(0);
    expect(d.logs).toHaveLength(2);
    expect(d.outs).toEqual([]);
  });

  it("without quiet, a failure prints the reason and exits 1", async () => {
    const d = deps(fakeApi(async () => { throw new ApiError(401, "unknown token"); }));
    expect(await receiptCommand({ transcript: fixturePath, cwd: "/nonexistent", dryRun: false, quiet: false }, d)).toBe(1);
    expect(d.outs[0]).toContain("unknown token");
  });
});

describe("formatReceipt", () => {
  it("shows each package with its share and reason, and the approval state", () => {
    expect(formatReceipt(view)).toBe(
      [
        "Upstream receipt - Build a todo API with FastAPI",
        "",
        "  fastapi    79.4%  Your whole API layer is built on it.",
        "  pydantic   20.6%  Every request model.",
        "",
        "Waiting for your approval.  (receipt 7f1e2c3a-0000-4000-8000-000000000001)",
      ].join("\n"),
    );
  });

  it("says so when the AI wasn't used or nothing was found", () => {
    const text = formatReceipt({ ...view, source: "fallback", items: [] });
    expect(text).toContain("(estimated without AI)");
    expect(text).toContain("No open-source packages found in this session.");
  });
});
