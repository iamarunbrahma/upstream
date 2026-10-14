import { z } from "zod";
import { fallbackReason, fallbackRole } from "./fallback";
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

/** Model output -> allocations over exactly the evidence rows. The model can't add packages. */
export function applyGuardrails(rows: JudgeRow[], items: JudgeItem[]): Allocation[] {
  const byName = new Map<string, JudgeItem>();
  for (const item of items) {
    const key = item.package.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, item);
  }
  const picked = rows.map((r) => byName.get(r.name.toLowerCase()) ?? null);
  const bp = toBasisPoints(picked.map((p) => p?.weight ?? 0));
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
