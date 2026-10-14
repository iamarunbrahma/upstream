import { createHash, timingSafeEqual } from "node:crypto";
import { bearerToken } from "../../../lib/auth";
import { getDeps } from "../../../lib/deps";
import { describeRun, runSettlement, settlementDeps } from "../../../lib/funding/run";
import { json } from "../../../lib/http";
import { createGithubGet } from "../../../lib/resolver/recipients";

export const runtime = "nodejs";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** "Settle now": runs the settlement job in this process. Needs the SETTLE_TOKEN; without one set, it's off. */
export async function POST(req: Request): Promise<Response> {
  const expected = process.env.SETTLE_TOKEN;
  const given = bearerToken(req);
  if (!expected || !given || !timingSafeEqual(digest(given), digest(expected))) return json({ error: "not allowed" }, 401);
  const deps = await getDeps();
  if (!deps.paypal) return json({ error: "Payments aren't set up on this server yet" }, 503);
  const report = await runSettlement(settlementDeps({ ...deps, paypal: deps.paypal }, createGithubGet(process.env.GITHUB_TOKEN)));
  return json({ report, summary: describeRun(report) });
}
