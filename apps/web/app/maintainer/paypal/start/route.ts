import { getDeps } from "../../../../lib/deps";
import { clientKey } from "../../../../lib/http";
import { plainPage, publicOrigin, redirect, secureCookies, signedInMaintainer } from "../../../../lib/maintainers/http";
import { issueOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (deps.signInLimiter && !deps.signInLimiter.take(clientKey(req))) return plainPage("Too many sign-in attempts from here. Please wait a while and try again.", 429);
  if (!deps.paypalIdentity) return plainPage("Linking PayPal isn't set up on this server yet.", 503);
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return plainPage("Sign in with GitHub first, then link PayPal.", 401);
  const state = await issueOAuthState(deps.db, "paypal", me.githubId);
  const to = deps.paypalIdentity.authorizeUrl(state, `${publicOrigin(req)}/maintainer/paypal/callback`);
  return redirect(to, [oauthCookie(state, secureCookies())], 302);
}
