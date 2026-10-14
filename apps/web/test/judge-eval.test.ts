import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadFixtures, scoreFixture } from "../lib/judge/eval/fixtures";
import { kendallTau } from "../lib/judge/eval/kendall";
import { judgeReceipt } from "../lib/judge/judge";
import { PROMPT_VERSION } from "../lib/judge/prompt";

const recordedUrl = new URL("../lib/judge/eval/recorded.json", import.meta.url);
type Recorded = { modelId: string; promptVersion: string; responses: Record<string, string> };
const recorded: Recorded | null = existsSync(recordedUrl) ? JSON.parse(readFileSync(recordedUrl, "utf8")) : null;

describe("kendallTau", () => {
  it("is 1 for the same order, -1 reversed, 0.67 with one adjacent swap of four", () => {
    expect(kendallTau(["a", "b", "c"], { a: 3, b: 2, c: 1 })).toBe(1);
    expect(kendallTau(["a", "b", "c"], { a: 1, b: 2, c: 3 })).toBe(-1);
    expect(kendallTau(["a", "b", "c", "d"], { a: 4, b: 2, c: 3, d: 1 })).toBeCloseTo(0.667, 2);
  });
});

describe("eval fixtures", () => {
  it("has 10 sessions whose expected order covers exactly their rows", () => {
    const fixtures = loadFixtures();
    expect(fixtures).toHaveLength(10);
    for (const f of fixtures) expect([...f.expectedOrder].sort()).toEqual(f.rows.map((r) => r.name).sort());
  });

  it.skipIf(!recorded)("recorded model responses meet the bar: top-1 >= 8/10 and mean tau >= 0.6", async () => {
    expect(recorded!.promptVersion, "recording is stale: run pnpm --filter web eval:live").toBe(PROMPT_VERSION);
    let tops = 0;
    let tauSum = 0;
    const fixtures = loadFixtures();
    for (const f of fixtures) {
      const raw = recorded!.responses[f.id];
      expect(raw, `no recorded response for ${f.id}`).toBeTypeOf("string");
      const r = await judgeReceipt(f.title, f.rows, { id: recorded!.modelId, generate: async () => raw! });
      expect(r.source).toBe("ai");
      const s = scoreFixture(f, r.allocations);
      tops += Number(s.topOk);
      tauSum += s.tau;
    }
    expect(tops).toBeGreaterThanOrEqual(8);
    expect(tauSum / fixtures.length).toBeGreaterThanOrEqual(0.6);
  });
});
