import { toBasisPoints } from "./guardrails";
import type { Allocation, JudgeRow, Role } from "./types";

export function heuristicScore(r: JudgeRow): number {
  const s = 3 * Number(r.installed) + 2 * r.importFiles + Math.sqrt(r.usageLines) + r.docsReads + Number(r.manifestAdded);
  return r.kind === "devDependency" ? s / 2 : s;
}

export function fallbackRole(r: JudgeRow): Role {
  if (r.kind === "devDependency" || r.name.startsWith("@types/")) return "tooling";
  if (r.importFiles >= 3) return "foundation";
  if (r.importFiles >= 1) return "feature";
  return "helper";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function fallbackReason(r: JudgeRow): string {
  const parts: string[] = [];
  if (r.importFiles) parts.push(`used in ${plural(r.importFiles, "file")}`);
  if (r.usageLines) parts.push(`${plural(r.usageLines, "line")} of new code`);
  if (r.installed) parts.push("installed this session");
  if (r.docsReads) parts.push(`docs read ${plural(r.docsReads, "time")}`);
  const text = parts.length ? parts.join(", ") : "used this session";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fallbackAllocations(rows: JudgeRow[]): Allocation[] {
  const bp = toBasisPoints(rows.map(heuristicScore));
  return rows.map((r, i) => ({
    ecosystem: r.ecosystem,
    name: r.name,
    weightBp: bp[i]!,
    role: fallbackRole(r),
    reason: fallbackReason(r),
  }));
}
