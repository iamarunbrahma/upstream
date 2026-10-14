import { getDeps } from "../../../../lib/deps";
import { signInMaintainer } from "../../../../lib/maintainers/claims";
import { plainPage, publicOrigin, redirect, secureCookies } from "../../../../lib/maintainers/http";
import { OAUTH_COOKIE, consumeOAuthState, maintainerCookie, oauthCookie } from "../../../../lib/maintainers/sessions";
import { readCookie } from "../../../../lib/web-auth";

export const runtime = "nodejs";

const EXPIRED = "This sign-in has expired, was already used, or didn't start in this browser. Please start again.";
const NOT_CONFIRMED = "GitHub didn't confirm who you are. Please try again.";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.githubOAuth) return plainPage("GitHub sign-in isn't set up on this server yet.", 503);
  const url = new URL(req.url);
  const clear = oauthCookie(null, secureCookies());
  if (!(await consumeOAuthState(deps.db, "github", url.searchParams.get("state"), readCookie(req, OAUTH_COOKIE)))) return plainPage(EXPIRED, 400, [clear]);
  const code = url.searchParams.get("code");
  if (!code) return plainPage("You didn't finish signing in with GitHub.", 400, [clear]);
  let user;
  try {
    user = await deps.githubOAuth.identify(code, `${publicOrigin(req)}/maintainer/github/callback`);
  } catch {
    return plainPage("Couldn't reach GitHub. Please try again.", 502, [clear]);
  }
  if (!user) return plainPage(NOT_CONFIRMED, 400, [clear]);
  const session = await signInMaintainer(deps.db, user);
  return redirect("/maintainer", [clear, maintainerCookie(session, secureCookies())]);
}
