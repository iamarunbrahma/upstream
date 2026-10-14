import { describe, expect, it } from "vitest";
import { splitCents } from "../lib/funding/split";

describe("splitCents", () => {
  it("splits in proportion, and the parts always add up to the total", () => {
    expect(splitCents(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(splitCents(1350, [5240, 4090, 670])).toEqual([707, 552, 91]);
    for (const total of [1, 99, 1001, 99_999]) {
      expect(splitCents(total, [3, 7, 11, 13]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("never gives a cent to a zero weight", () => {
    expect(splitCents(5, [0, 1, 1])).toEqual([0, 3, 2]);
  });

  it("gives nothing when there is nothing to split or no weight", () => {
    expect(splitCents(0, [1, 2])).toEqual([0, 0]);
    expect(splitCents(500, [0, 0])).toEqual([0, 0]);
    expect(splitCents(500, [])).toEqual([]);
  });

  it("refuses fractional or negative amounts", () => {
    expect(() => splitCents(1.5, [1])).toThrow();
    expect(() => splitCents(-1, [1])).toThrow();
    expect(() => splitCents(10, [1, -1])).toThrow();
    expect(() => splitCents(10, [0.5])).toThrow();
  });
});
