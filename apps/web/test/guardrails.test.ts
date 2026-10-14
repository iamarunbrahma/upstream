import { describe, expect, it } from "vitest";
import { applyGuardrails, largestRemainder, parseJudgeOutput, toBasisPoints } from "../lib/judge/guardrails";
import { fallbackAllocations } from "../lib/judge/fallback";
import type { JudgeRow } from "../lib/judge/types";

const row = (name: string, over: Partial<JudgeRow> = {}): JudgeRow => ({
  ecosystem: "npm", name, installed: false, manifestAdded: false, importFiles: 1, usageLines: 1,
  kind: "dependency", description: null, docsReads: 0, ...over,
});

describe("largestRemainder", () => {
  it("returns integers that sum to the total exactly", () => {
    const out = largestRemainder([1, 1, 1], 10000);
    expect(out).toEqual([3334, 3333, 3333]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("splits evenly when every weight is zero", () => {
    expect(largestRemainder([0, 0], 100)).toEqual([50, 50]);
  });
});

describe("toBasisPoints", () => {
  it("gives every package at least 1% and sums to 10000", () => {
    const bp = toBasisPoints([100, 0, 0]);
    expect(bp).toEqual([9800, 100, 100]);
  });

  it("lowers the floor when there are more than 100 packages", () => {
    const bp = toBasisPoints(new Array(150).fill(1));
    expect(bp.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.min(...bp)).toBeGreaterThanOrEqual(66);
  });
});

describe("parseJudgeOutput", () => {
  it("accepts schema-valid JSON and rejects anything else", () => {
    expect(parseJudgeOutput('{"packages":[{"package":"a","weight":60,"role":"feature","reason":"r"}]}')).toEqual([
      { package: "a", weight: 60, role: "feature", reason: "r" },
    ]);
    expect(parseJudgeOutput("not json")).toBeNull();
    expect(parseJudgeOutput('{"packages":[{"package":"a","weight":500,"role":"feature","reason":"r"}]}')).toBeNull();
    expect(parseJudgeOutput('{"packages":[{"package":"a","weight":5,"role":"boss","reason":"r"}]}')).toBeNull();
  });
});

describe("applyGuardrails", () => {
  it("drops packages the evidence doesn't contain and fills ones the model skipped", () => {
    const rows = [row("next"), row("zod")];
    const out = applyGuardrails(rows, [
      { package: "next", weight: 80, role: "foundation", reason: "Your whole app is built on it." },
      { package: "ghost-pkg", weight: 100, role: "foundation", reason: "Invented." },
    ]);
    expect(out.map((a) => a.name)).toEqual(["next", "zod"]);
    expect(out[0]).toMatchObject({ role: "foundation", reason: "Your whole app is built on it." });
    expect(out[1]!.weightBp).toBe(100);
    expect(out[1]!.reason).toBe("Used in 1 file, 1 line of new code");
    expect(out.reduce((s, a) => s + a.weightBp, 0)).toBe(10000);
  });

  it("matches names case-insensitively and trims reasons to 140 characters", () => {
    const out = applyGuardrails([row("react")], [{ package: "React", weight: 50, role: "foundation", reason: "x".repeat(300) }]);
    expect(out[0]!.weightBp).toBe(10000);
    expect(out[0]!.reason).toHaveLength(140);
  });

  it("returns nothing for an empty evidence set", () => {
    expect(applyGuardrails([], [])).toEqual([]);
  });
});

describe("fallbackAllocations", () => {
  it("ranks by fixed score and halves tooling", () => {
    const out = fallbackAllocations([
      row("fastapi", { ecosystem: "pypi", installed: true, importFiles: 3, usageLines: 16 }),
      row("pytest", { ecosystem: "pypi", installed: true, importFiles: 3, usageLines: 16, kind: "devDependency" }),
      row("httpx", { ecosystem: "pypi", importFiles: 0, usageLines: 0 }),
    ]);
    expect(out.map((a) => [a.name, a.role])).toEqual([["fastapi", "foundation"], ["pytest", "tooling"], ["httpx", "helper"]]);
    expect(out[0]!.weightBp).toBeGreaterThan(out[1]!.weightBp);
    expect(out[2]!.weightBp).toBe(100);
  });
});
