import { getDeps } from "../../../lib/deps";
import { plainPage, redirect, secureCookies } from "../../../lib/maintainers/http";
import { MAINTAINER_COOKIE, endMaintainerSession, maintainerCookie } from "../../../lib/maintainers/sessions";
import { readCookie, sameOrigin } from "../../../lib/web-auth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return plainPage("This sign-out didn't come from this site, so it was refused.", 403);
  const deps = await getDeps();
  const value = readCookie(req, MAINTAINER_COOKIE);
  if (value) await endMaintainerSession(deps.db, value);
  return redirect("/maintainer", [maintainerCookie(null, secureCookies())]);
}
