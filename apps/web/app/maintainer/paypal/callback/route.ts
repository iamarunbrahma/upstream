import { getDeps } from "../../../../lib/deps";
import { linkPayPal } from "../../../../lib/maintainers/claims";
import { plainPage, publicOrigin, redirect, secureCookies, signedInMaintainer } from "../../../../lib/maintainers/http";
import { OAUTH_COOKIE, consumeOAuthState, oauthCookie } from "../../../../lib/maintainers/sessions";
import { readCookie } from "../../../../lib/web-auth";

export const runtime = "nodejs";

const RESULT = { linked: "linked", unchanged: "unchanged", "not verified": "not-verified", "used by another maintainer": "in-use" } as const;

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps();
  if (!deps.paypalIdentity) return plainPage("Linking PayPal isn't set up on this server yet.", 503);
  const clear = oauthCookie(null, secureCookies());
  const me = await signedInMaintainer(req, deps.db);
  if (!me) return plainPage("Sign in with GitHub first, then link PayPal.", 401, [clear]);
  const url = new URL(req.url);
  const started = await consumeOAuthState(deps.db, "paypal", url.searchParams.get("state"), readCookie(req, OAUTH_COOKIE));
  // The state must be one this maintainer started: nobody can finish linking their PayPal to someone else.
  if (!started || started.githubId !== me.githubId) {
    return plainPage("This PayPal link has expired, was already used, or didn't start in this browser. Please start again.", 400, [clear]);
  }
  const code = url.searchParams.get("code");
  if (!code) return redirect("/maintainer?paypal=cancelled", [clear]);
  let account;
  try {
    account = await deps.paypalIdentity.identify(code, `${publicOrigin(req)}/maintainer/paypal/callback`);
  } catch {
    return plainPage("Couldn't reach PayPal. Please try again.", 502, [clear]);
  }
  if (!account) return plainPage("PayPal didn't confirm your account. Please try again.", 400, [clear]);
  const result = await linkPayPal(deps.db, me.githubId, account);
  return redirect(`/maintainer?paypal=${RESULT[result]}`, [clear]);
}
