import { describe, expect, it } from "vitest";
import { runSessionEndHook } from "../src/hook";

describe("runSessionEndHook", () => {
  it("launches a background receipt for a valid hook input and returns at once", async () => {
    const launched: string[][] = [];
    const start = Date.now();
    await runSessionEndHook(
      JSON.stringify({ session_id: "s1", transcript_path: "/t/s1.jsonl", cwd: "/work/app", hook_event_name: "SessionEnd" }),
      (args) => launched.push(args),
      () => {},
    );
    expect(Date.now() - start).toBeLessThan(50);
    expect(launched).toEqual([["receipt", "--transcript", "/t/s1.jsonl", "--cwd", "/work/app", "--quiet"]]);
  });

  it("never throws: garbage input, missing fields or a failing launcher only log", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    await expect(runSessionEndHook("not json", () => {}, log)).resolves.toBeUndefined();
    await expect(runSessionEndHook("{}", () => {}, log)).resolves.toBeUndefined();
    await expect(
      runSessionEndHook(JSON.stringify({ transcript_path: "/t.jsonl" }), () => { throw new Error("spawn failed"); }, log),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(3);
    expect(logs[2]).toContain("spawn failed");
  });
});
