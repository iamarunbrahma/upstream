import { getDeps } from "../../../lib/deps";
import { createDemoAccount, demoEnabled } from "../../../lib/demo/accounts";
import { clientKey } from "../../../lib/http";
import { createSession, sameOrigin, sessionCookie } from "../../../lib/web-auth";

export const runtime = "nodejs";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** "Try the demo": a fresh, empty funder account for this browser, so visitors never see each other's clicks. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return text("Not found", 404);
  if (!sameOrigin(req)) return text("This didn't come from this site, so it was refused.", 403);
  const deps = await getDeps();
  if (deps.demoStartLimiter && !deps.demoStartLimiter.take(clientKey(req))) {
    return text("That's a lot of demo accounts from here this hour. Please try again later.", 429);
  }
  const accountId = await createDemoAccount(deps.db);
  const session = await createSession(deps.db, accountId);
  return new Response(null, {
    status: 303,
    headers: { location: "/dashboard", "set-cookie": sessionCookie(session, process.env.NODE_ENV === "production") },
  });
}
