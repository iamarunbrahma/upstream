import { getDeps } from "../../lib/deps";
import { consumeLoginCode, createSession, peekLoginCode, sameOrigin, sessionCookie } from "../../lib/web-auth";

export const runtime = "nodejs";

const EXPIRED = "This link has expired or was already used. Run `upstream dashboard` again for a new one.";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Opening a link only shows a confirmation page. Signing in takes a same-site POST, so a link that someone
 * else created can't silently sign you in to their account (where anything you pay would fund them).
 */
export async function GET(req: Request): Promise<Response> {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const deps = await getDeps();
  if (!code || !(await peekLoginCode(deps.db, code))) return text(EXPIRED, 400);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open your Upstream dashboard</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<h1>Open your Upstream dashboard?</h1>
<p>Only continue if you just ran <code>upstream dashboard</code> in your own terminal. If someone sent you this link, close this page: it would sign you in to their account, and anything you pay would go to their budget.</p>
<form method="post" action="/connect"><input type="hidden" name="code" value="${escapeHtml(code)}"><button type="submit" style="font-size:16px;padding:8px 16px">Continue to my dashboard</button></form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin" },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return text("This sign-in didn't come from this site, so it was refused.", 403);
  const form = await req.formData().catch(() => null);
  const code = form?.get("code");
  const deps = await getDeps();
  const accountId = typeof code === "string" && code ? await consumeLoginCode(deps.db, code) : null;
  if (!accountId) return text(EXPIRED, 400);
  const session = await createSession(deps.db, accountId);
  return new Response(null, {
    status: 303,
    headers: { location: "/dashboard", "set-cookie": sessionCookie(session, process.env.NODE_ENV === "production") },
  });
}
