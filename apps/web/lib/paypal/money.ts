/** "4.53" -> 453. Only plain non-negative decimals with at most two places are accepted. */
export function toCents(value: string): number {
  const m = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`not a money amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 453 -> "4.53". */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`not a whole number of cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
