/**
 * Asks the server to record a payment the buyer just approved. PayPal can take a little while to list a new
 * payment, so while nothing has been credited it asks again, up to `tries` times; the server makes repeats safe.
 * Returns the last answer, or null when every try failed.
 */
export async function recordPayment(
  record: () => Promise<{ credited: number }>,
  opts: { tries: number; waitMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ credited: number } | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: { credited: number } | null = null;
  for (let i = 0; i < opts.tries; i++) {
    if (i > 0) await sleep(opts.waitMs);
    try {
      last = await record();
      if (last.credited > 0) return last;
    } catch {
      // PayPal or the network failed this time; the next try is safe.
    }
  }
  return last;
}
