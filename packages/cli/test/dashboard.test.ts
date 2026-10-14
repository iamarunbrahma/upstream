import { describe, expect, it } from "vitest";
import type { Api } from "../src/api";
import { ApiError } from "../src/api";
import { dashboardCommand } from "../src/commands";

describe("dashboardCommand", () => {
  it("prints the one-time link and opens it", async () => {
    const outs: string[] = [];
    const opened: string[] = [];
    const api = { loginLink: async () => ({ url: "http://up.test/connect?code=abc" }) } as unknown as Api;
    expect(await dashboardCommand({ api, out: (m) => outs.push(m), openUrl: (u) => opened.push(u) })).toBe(0);
    expect(opened).toEqual(["http://up.test/connect?code=abc"]);
    expect(outs[0]).toContain("http://up.test/connect?code=abc");
  });

  it("explains a failure and exits 1", async () => {
    const outs: string[] = [];
    const api = { loginLink: async () => { throw new ApiError(401, "unknown token"); } } as unknown as Api;
    expect(await dashboardCommand({ api, out: (m) => outs.push(m), openUrl: () => {} })).toBe(1);
    expect(outs[0]).toContain("unknown token");
  });
});
