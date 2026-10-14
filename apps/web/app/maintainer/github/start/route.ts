import { getDeps } from "../../../../lib/deps";
import { clientKey } from "../../../../lib/http";
import { plainPage, publicOrigin, redirect, secureCookies } from "../../../../lib/maintainers/http";
import { issueOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (deps.signInLimiter && !deps.signInLimiter.take(clientKey(req))) return plainPage("Too many sign-in attempts from here. Please wait a while and try again.", 429);
  if (!deps.githubOAuth) return plainPage("GitHub sign-in isn't set up on this server yet.", 503);
  const state = await issueOAuthState(deps.db, "github", null);
  const to = deps.githubOAuth.authorizeUrl(state, `${publicOrigin(req)}/maintainer/github/callback`);
  return redirect(to, [oauthCookie(state, secureCookies())], 302);
}
