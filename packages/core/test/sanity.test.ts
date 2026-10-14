import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "@upstream/core";

describe("workspace", () => {
  it("resolves @upstream/core by package name", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });
});
