import { describe, expect, it } from "vitest";
import { formatUsd } from "../lib/format";

describe("formatUsd", () => {
  it("shows dollars and cents", () => {
    expect(formatUsd(453)).toBe("$4.53");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(123456)).toBe("$1,234.56");
  });
});
