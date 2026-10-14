import data from "./sessions.json" with { type: "json" };
import type { Allocation, JudgeRow } from "../types";
import { kendallTau } from "./kendall";

export interface EvalFixture {
  id: string;
  title: string;
  expectedOrder: string[];
  rows: JudgeRow[];
}

const DEFAULTS = {
  installed: false, manifestAdded: false, importFiles: 0, usageLines: 0,
  kind: "dependency" as const, description: null, docsReads: 0,
};

export function loadFixtures(): EvalFixture[] {
  return (data as Array<{ id: string; title: string; expectedOrder: string[]; rows: Array<Partial<JudgeRow>> }>).map((f) => ({
    id: f.id,
    title: f.title,
    expectedOrder: f.expectedOrder,
    rows: f.rows.map((r) => ({ ...DEFAULTS, ...r }) as JudgeRow),
  }));
}

export function scoreFixture(f: EvalFixture, allocations: Allocation[]): { top: string; topOk: boolean; tau: number } {
  const scores = Object.fromEntries(allocations.map((a) => [a.name, a.weightBp]));
  const top = [...allocations].sort((a, b) => b.weightBp - a.weightBp)[0]?.name ?? "";
  return { top, topOk: top === f.expectedOrder[0], tau: kendallTau(f.expectedOrder, scores) };
}
