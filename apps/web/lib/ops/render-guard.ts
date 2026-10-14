/**
 * Render budget guard: keeps Upstream's Render bill inside the hackathon credit, so the card on file is never
 * charged. Render has no workspace-wide spend cap, so this checks Upstream's services on a schedule and suspends
 * all of them (web, crons and the database) once judging is over, once this month's bandwidth reaches a cap, or
 * if anything is moved to a pricier plan. Suspended services cost nothing and can be resumed in the dashboard.
 */

/** The Render REST API (https://api.render.com/v1), as the guard uses it. */
export interface RenderApi {
  get(path: string): Promise<unknown>;
  post(path: string): Promise<void>;
}

export interface GuardConfig {
  /** From this day (UTC) on, nothing runs: the hackathon's judging is over. YYYY-MM-DD. */
  endDate: string;
  /** This month's outbound bandwidth across Upstream's services, in GB, at which everything is suspended. */
  bandwidthCapGb: number;
  /** Upstream's services by name, each with the one plan it may be on. */
  services: Record<string, string>;
  database: { name: string; plan: string };
}

const DEFAULT_END_DATE = "2026-12-16";
const DEFAULT_CAP_GB = 30;

/** The guard's settings from GUARD_END_DATE and GUARD_BANDWIDTH_CAP_GB. Anything unreadable keeps the strict defaults. */
export function guardConfigFromEnv(env: Record<string, string | undefined>): GuardConfig {
  const end = env.GUARD_END_DATE ?? "";
  const cap = Number(env.GUARD_BANDWIDTH_CAP_GB);
  return {
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(end) && !Number.isNaN(Date.parse(`${end}T00:00:00Z`)) ? end : DEFAULT_END_DATE,
    bandwidthCapGb: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP_GB,
    services: { upstream: "starter", "upstream-settle-monthly": "starter", "upstream-payouts-daily": "starter" },
    database: { name: "upstream-db", plan: "basic_256mb" },
  };
}

export interface GuardReading {
  bandwidthGb: number;
  /** The plan each found service is on, by name. */
  plans: Record<string, string>;
  dbPlan: string | null;
}

/** Whether to suspend everything, and why, in plain words. */
export function decide(now: Date, cfg: GuardConfig, reading: GuardReading): { suspend: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (now.getTime() >= Date.parse(`${cfg.endDate}T00:00:00Z`)) reasons.push(`It is ${cfg.endDate} or later, the last day Upstream needs to run.`);
  if (reading.bandwidthGb >= cfg.bandwidthCapGb) {
    reasons.push(`This month's bandwidth is ${reading.bandwidthGb.toFixed(1)} GB, at or over the ${cfg.bandwidthCapGb} GB cap.`);
  }
  for (const [name, plan] of Object.entries(reading.plans)) {
    const allowed = cfg.services[name];
    if (allowed && plan !== allowed) reasons.push(`${name} is on the "${plan}" plan, but only "${allowed}" is allowed.`);
  }
  if (reading.dbPlan && reading.dbPlan !== cfg.database.plan) {
    reasons.push(`${cfg.database.name} is on the "${reading.dbPlan}" plan, but only "${cfg.database.plan}" is allowed.`);
  }
  return { suspend: reasons.length > 0, reasons };
}

interface ListedService {
  service: { id: string; name: string; type: string; suspended: string; serviceDetails?: { plan?: string } };
}
interface ListedPostgres {
  postgres: { id: string; name: string; plan: string; suspended: string };
}
interface BandwidthSeries {
  unit: string;
  values: Array<{ value: number }>;
}

/** GB per unit Render reports bandwidth in. Decimal, as Render bills, so a megabyte never counts for less. */
const GB_PER: Record<string, number> = { b: 1e-9, kb: 1e-6, mb: 1e-3, gb: 1, tb: 1e3 };

function toGb(series: BandwidthSeries): number {
  const per = GB_PER[series.unit.toLowerCase()];
  // An answer the guard can't read must stop the run (and email), never pass as zero.
  if (per === undefined) throw new Error(`unknown bandwidth unit "${series.unit}"`);
  return series.values.reduce((sum, v) => sum + v.value, 0) * per;
}

const query = (pairs: Array<[string, string | number]>) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

/** Reads Upstream's services, database and this month's bandwidth, decides, and suspends everything if it must. */
export async function runGuard(api: RenderApi, cfg: GuardConfig, now: Date = new Date()) {
  const names = Object.keys(cfg.services);
  const listed = (await api.get(`/services?${query([...names.map((n): [string, string] => ["name", n]), ["limit", 100]])}`)) as ListedService[];
  const services = listed.map((l) => l.service).filter((s) => names.includes(s.name));
  const dbs = ((await api.get(`/postgres?${query([["name", cfg.database.name], ["limit", 20]])}`)) as ListedPostgres[])
    .map((l) => l.postgres)
    .filter((p) => p.name === cfg.database.name);

  // Only web services send bandwidth (Render answers "not found" for a cron job), and times are ISO 8601.
  const web = services.filter((s) => s.type === "web_service");
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let bandwidthGb = 0;
  if (web.length > 0) {
    const series = (await api.get(
      `/metrics/bandwidth?${query([...web.map((s): [string, string] => ["resource", s.id]), ["startTime", monthStart], ["endTime", now.toISOString()]])}`,
    )) as BandwidthSeries[];
    bandwidthGb = series.reduce((sum, s) => sum + toGb(s), 0);
  }

  const plans = Object.fromEntries(services.map((s) => [s.name, s.serviceDetails?.plan ?? "unknown"]));
  const verdict = decide(now, cfg, { bandwidthGb, plans, dbPlan: dbs[0]?.plan ?? null });
  const suspended: string[] = [];
  if (verdict.suspend) {
    for (const s of services) {
      if (s.suspended === "suspended") continue;
      await api.post(`/services/${s.id}/suspend`);
      suspended.push(s.name);
    }
    for (const p of dbs) {
      if (p.suspended === "suspended") continue;
      await api.post(`/postgres/${p.id}/suspend`);
      suspended.push(p.name);
    }
  }
  return { ...verdict, bandwidthGb, suspended };
}

/** The Render REST API with a bearer key. Any answer other than 2xx is an error, so a failed check never passes silently. */
export function createRenderApi(apiKey: string, fetchImpl: typeof fetch = fetch): RenderApi {
  const call = async (method: "GET" | "POST", path: string) => {
    const res = await fetchImpl(`https://api.render.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Render API ${method} ${path.split("?")[0]} answered ${res.status}`);
    return res;
  };
  return {
    get: async (path) => (await call("GET", path)).json(),
    post: async (path) => {
      await call("POST", path);
    },
  };
}
