/**
 * Splits `total` cents in proportion to non-negative integer `weights`, so the parts add up to `total` exactly.
 * Largest-remainder method; ties go to the earlier weight, so the same input always gives the same split.
 */
export function splitCents(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be a whole, non-negative number of cents");
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error("weights must be whole, non-negative numbers");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ i, rem: (total * w) % sum })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}
