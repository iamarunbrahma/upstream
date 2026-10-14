import { describe, expect, it } from "vitest";
import config from "../next.config";

describe("framing", () => {
  it("refuses to be shown inside another site's frame, on every route", async () => {
    const rules = (await config.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    const headers = Object.fromEntries((all?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
});
