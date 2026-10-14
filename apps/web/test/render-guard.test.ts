import { describe, expect, it } from "vitest";
import { decide, guardConfigFromEnv, runGuard, type GuardConfig, type RenderApi } from "../lib/ops/render-guard";

const cfg: GuardConfig = {
  endDate: "2026-12-16",
  bandwidthCapGb: 30,
  services: { upstream: "starter", "upstream-settle-monthly": "starter", "upstream-payouts-daily": "starter" },
  database: { name: "upstream-db", plan: "basic_256mb" },
};
const at = (iso: string) => new Date(iso);

describe("decide", () => {
  it("keeps everything running inside the limits", () => {
    expect(decide(at("2026-11-20T00:00:00Z"), cfg, { bandwidthGb: 4.2, plans: { upstream: "starter" }, dbPlan: "basic_256mb" })).toEqual({ suspend: false, reasons: [] });
  });

  it("suspends once judging is over, at the configured end date", () => {
    expect(decide(at("2026-12-16T00:00:00Z"), cfg, { bandwidthGb: 0, plans: {}, dbPlan: "basic_256mb" })).toEqual({
      suspend: true,
      reasons: ["It is 2026-12-16 or later, the last day Upstream needs to run."],
    });
  });

  it("suspends when this month's bandwidth reaches the cap", () => {
    expect(decide(at("2026-11-20T00:00:00Z"), cfg, { bandwidthGb: 30, plans: {}, dbPlan: "basic_256mb" }).reasons).toEqual([
      "This month's bandwidth is 30.0 GB, at or over the 30 GB cap.",
    ]);
  });

  it("suspends when a service or the database is on a pricier plan than allowed", () => {
    const d = decide(at("2026-11-20T00:00:00Z"), cfg, { bandwidthGb: 1, plans: { upstream: "standard" }, dbPlan: "pro_4gb" });
    expect(d.suspend).toBe(true);
    expect(d.reasons).toEqual([
      'upstream is on the "standard" plan, but only "starter" is allowed.',
      'upstream-db is on the "pro_4gb" plan, but only "basic_256mb" is allowed.',
    ]);
  });
});

describe("guardConfigFromEnv", () => {
  it("takes the end date and the cap from the environment, with safe defaults", () => {
    expect(guardConfigFromEnv({}).endDate).toBe("2026-12-16");
    expect(guardConfigFromEnv({}).bandwidthCapGb).toBe(30);
    expect(guardConfigFromEnv({ GUARD_END_DATE: "2026-12-01", GUARD_BANDWIDTH_CAP_GB: "10" })).toMatchObject({ endDate: "2026-12-01", bandwidthCapGb: 10 });
    // A typo can't switch the guard off: anything unreadable keeps the defaults.
    expect(guardConfigFromEnv({ GUARD_END_DATE: "next year", GUARD_BANDWIDTH_CAP_GB: "lots" })).toMatchObject({ endDate: "2026-12-16", bandwidthCapGb: 30 });
  });
});

/** A fake Render API with the shapes Render's REST API answers with. */
function fakeRender(opts: { webPlan?: string; bandwidth?: number[]; suspended?: boolean } = {}) {
  const posts: string[] = [];
  const gets: string[] = [];
  const api: RenderApi = {
    get: async (path) => {
      gets.push(path);
      if (path.startsWith("/services?")) {
        return [
          { service: { id: "srv-web", name: "upstream", type: "web_service", suspended: opts.suspended ? "suspended" : "not_suspended", serviceDetails: { plan: opts.webPlan ?? "starter" } } },
          { service: { id: "crn-1", name: "upstream-settle-monthly", type: "cron_job", suspended: "not_suspended", serviceDetails: { plan: "starter" } } },
          { service: { id: "srv-other", name: "someone-else", type: "web_service", suspended: "not_suspended", serviceDetails: { plan: "pro" } } },
        ];
      }
      if (path.startsWith("/postgres?")) return [{ postgres: { id: "dpg-1", name: "upstream-db", plan: "basic_256mb", suspended: "not_suspended" } }];
      if (path.startsWith("/metrics/bandwidth?")) return [{ labels: [{ field: "service", value: "srv-web" }], values: (opts.bandwidth ?? [0.5]).map((value) => ({ timestamp: "2026-11-01T00:00:00Z", value })), unit: "GB" }];
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path) => {
      posts.push(path);
    },
  };
  return { api, posts, gets };
}

describe("runGuard", () => {
  it("does nothing inside the limits, and asks only about Upstream's own services", async () => {
    const r = fakeRender();
    expect(await runGuard(r.api, cfg, at("2026-11-20T00:00:00Z"))).toMatchObject({ suspend: false, suspended: [] });
    expect(r.posts).toEqual([]);
    const bandwidth = r.gets.find((g) => g.startsWith("/metrics/bandwidth?"))!;
    expect(bandwidth).toContain("resource=srv-web");
    expect(bandwidth).toContain("resource=crn-1");
    expect(bandwidth).not.toContain("srv-other");
    expect(bandwidth).toContain(`startTime=${Date.UTC(2026, 10, 1) / 1000}`);
  });

  it("suspends every Upstream service and the database when a limit is crossed", async () => {
    const r = fakeRender({ bandwidth: [20, 11] });
    const out = await runGuard(r.api, cfg, at("2026-11-20T00:00:00Z"));
    expect(out).toMatchObject({ suspend: true, bandwidthGb: 31 });
    expect(r.posts).toEqual(["/services/srv-web/suspend", "/services/crn-1/suspend", "/postgres/dpg-1/suspend"]);
  });

  it("leaves services that are already suspended alone", async () => {
    const r = fakeRender({ suspended: true });
    await runGuard(r.api, cfg, at("2026-12-20T00:00:00Z"));
    expect(r.posts).toEqual(["/services/crn-1/suspend", "/postgres/dpg-1/suspend"]);
  });
});
