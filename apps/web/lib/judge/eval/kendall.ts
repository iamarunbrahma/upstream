/** Kendall tau-a between a labelled order and predicted scores (higher score = ranked earlier). Ties count as 0. */
export function kendallTau(expectedOrder: string[], scores: Record<string, number>): number {
  const n = expectedOrder.length;
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = scores[expectedOrder[i]!] ?? 0;
      const b = scores[expectedOrder[j]!] ?? 0;
      if (a > b) concordant++;
      else if (a < b) discordant++;
    }
  }
  return (concordant - discordant) / ((n * (n - 1)) / 2);
}
