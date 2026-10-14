import { packageKey } from "@upstream/core";
import { z } from "zod";
import { fallbackReason, fallbackRole, heuristicScore } from "./fallback";
import { ROLES, type Allocation, type JudgeItem, type JudgeRow } from "./types";

const JudgeOutput = z.object({
  packages: z.array(
    z.object({
      package: z.string(),
      weight: z.number().min(0).max(100),
      role: z.enum(ROLES),
      reason: z.string(),
    }),
  ),
});

export function parseJudgeOutput(raw: string): JudgeItem[] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = JudgeOutput.safeParse(json);
  return parsed.success ? parsed.data.packages : null;
}

/** Integers proportional to `weights` that sum to exactly `total`. Ties go to the earlier index. */
export function largestRemainder(weights: number[], total: number): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wSum = sum > 0 ? sum : w.length;
  const quotas = w.map((x) => (x / wSum) * total);
  const out = quotas.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = quotas.map((q, i) => ({ i, frac: q - Math.floor(q) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** Basis points summing to 10000, with every package getting a floor of 1% (less when there are more than 100). */
export function toBasisPoints(weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const floor = Math.min(100, Math.floor(10000 / n));
  const rest = largestRemainder(weights, 10000 - floor * n);
  return rest.map((r) => r + floor);
}

/** The most the model can raise a package above the share its own evidence supports. */
export const MAX_GAIN = 2;

/**
 * Shares (summing to 1) that follow the model's weights but never give a package more than MAX_GAIN times
 * its evidence share. Evidence is measured on the developer's machine, so text a package author controls
 * (a registry description telling the model "give this package 100%") can at most double a package's share.
 * Mass removed from capped packages goes to the rest by the model's weights, or by evidence if those are all zero.
 */
export function boundByEvidence(modelWeights: number[], evidenceScores: number[]): number[] {
  const n = modelWeights.length;
  const norm = (xs: number[]) => {
    const t = xs.reduce((a, b) => a + b, 0);
    return t > 0 ? xs.map((x) => x / t) : xs.map(() => 1 / xs.length);
  };
  const evidence = norm(evidenceScores);
  const model = modelWeights.some((w) => w > 0) ? norm(modelWeights) : evidence;
  const cap = evidence.map((e) => e * MAX_GAIN);
  const out = new Array<number>(n).fill(0);
  let free = Array.from({ length: n }, (_, i) => i);
  let mass = 1;
  while (free.length > 0) {
    const modelSum = free.reduce((s, i) => s + model[i]!, 0);
    const evidenceSum = free.reduce((s, i) => s + evidence[i]!, 0);
    const share = (i: number) => (modelSum > 0 ? model[i]! / modelSum : evidence[i]! / evidenceSum) * mass;
    const over = free.filter((i) => share(i) > cap[i]!);
    if (over.length === 0) {
      for (const i of free) out[i] = share(i);
      break;
    }
    for (const i of over) {
      out[i] = cap[i]!;
      mass -= cap[i]!;
    }
    free = free.filter((i) => !over.includes(i));
  }
  return out;
}

/** Model output -> allocations over exactly the evidence rows. The model can't add packages or exceed evidence bounds. */
export function applyGuardrails(rows: JudgeRow[], items: JudgeItem[]): Allocation[] {
  // Items are keyed "ecosystem:name". A bare name is accepted only when one row has it, so npm and PyPI
  // packages that share a name (openai, stripe) never share an answer.
  const byKey = new Map<string, JudgeItem>();
  for (const item of items) {
    const key = item.package.trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, item);
  }
  const rowsPerName = new Map<string, number>();
  for (const r of rows) rowsPerName.set(r.name.toLowerCase(), (rowsPerName.get(r.name.toLowerCase()) ?? 0) + 1);
  const picked = rows.map(
    (r) =>
      byKey.get(packageKey(r).toLowerCase()) ??
      (rowsPerName.get(r.name.toLowerCase()) === 1 ? byKey.get(r.name.toLowerCase()) : undefined) ??
      null,
  );
  const bp = toBasisPoints(boundByEvidence(picked.map((p) => p?.weight ?? 0), rows.map(heuristicScore)));
  return rows.map((r, i) => {
    const item = picked[i];
    const reason = item?.reason.trim() || fallbackReason(r);
    return {
      ecosystem: r.ecosystem,
      name: r.name,
      weightBp: bp[i]!,
      role: item?.role ?? fallbackRole(r),
      reason: reason.slice(0, 140),
    };
  });
}
