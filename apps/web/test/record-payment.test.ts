import { describe, expect, it } from "vitest";
import { recordPayment } from "../app/dashboard/record-payment";

const answers = (...steps: Array<number | Error>) => {
  let calls = 0;
  const record = async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return { credited: step };
  };
  return { record, calls: () => calls };
};
const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

describe("recordPayment", () => {
  it("asks again while PayPal hasn't listed the payment, and stops once it's credited", async () => {
    waits.length = 0;
    const a = answers(0, 0, 434);
    expect(await recordPayment(a.record, { tries: 5, waitMs: 10_000, sleep })).toEqual({ credited: 434 });
    expect(a.calls()).toBe(3);
    expect(waits).toEqual([10_000, 10_000]);
  });

  it("gives up after the last try when nothing was credited", async () => {
    const a = answers(0);
    expect(await recordPayment(a.record, { tries: 3, waitMs: 1, sleep })).toEqual({ credited: 0 });
    expect(a.calls()).toBe(3);
  });

  it("keeps trying after an error, and returns null when every try failed", async () => {
    expect(await recordPayment(answers(new Error("timeout"), 916).record, { tries: 3, waitMs: 1, sleep })).toEqual({ credited: 916 });
    expect(await recordPayment(answers(new Error("timeout")).record, { tries: 3, waitMs: 1, sleep })).toBeNull();
  });
});
