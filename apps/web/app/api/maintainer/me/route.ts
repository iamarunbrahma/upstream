import { getDeps } from "../../../../lib/deps";
import { json } from "../../../../lib/http";
import { signedInMaintainer } from "../../../../lib/maintainers/http";
import { maintainerSummary } from "../../../../lib/maintainers/summary";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return json({ error: "not signed in" }, 401);
  return json(await maintainerSummary(deps.db, me));
}
