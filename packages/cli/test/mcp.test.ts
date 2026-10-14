import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Api } from "../src/api";
import { approveTool, receiptTool } from "../src/mcp";
import { view } from "./helpers";

const fixturePath = new URL("./fixtures/session.jsonl", import.meta.url).pathname;
const decided: Array<[string, string]> = [];
const api = {
  submit: async () => ({ receipt: view, changed: true }),
  decide: async (id: string, action: "approve" | "skip") => {
    decided.push([id, action]);
    return { receipt: { ...view, status: action === "approve" ? "approved" : "skipped" } };
  },
} as unknown as Api;
const base = { api, cwd: "/work/app", readFile: (p: string) => readFileSync(p, "utf8") };

describe("MCP tools", () => {
  it("upstream_receipt builds, submits and shows the receipt with how to approve it", async () => {
    const res = await receiptTool({ ...base, findTranscript: () => fixturePath });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain("Upstream receipt - Build a todo API with FastAPI");
    expect(res.content[0]!.text).toContain(`receiptId ${view.id}`);
  });

  it("upstream_receipt reports a clear error when no transcript exists", async () => {
    const res = await receiptTool({ ...base, findTranscript: () => null });
    expect(res.isError).toBe(true);
  });

  it("upstream_approve passes the decision through", async () => {
    const res = await approveTool(base, { receiptId: view.id, action: "approve" });
    expect(decided).toEqual([[view.id, "approve"]]);
    expect(res.content[0]!.text).toContain("Approved.");
  });
});
