import type { Db } from "../db/client";
import { readCookie } from "../web-auth";
import { MAINTAINER_COOKIE, maintainerForSession } from "./sessions";

export const secureCookies = () => process.env.NODE_ENV === "production";

/** This server's public address, for the return addresses GitHub and PayPal send people back to. */
export function publicOrigin(req: Request): string {
  return (process.env.PUBLIC_URL?.trim() || new URL(req.url).origin).replace(/\/+$/, "");
}

export function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

/** The message sits in element text, so &, < and > (and " for good measure) are all that need escaping. */
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A short page in plain words, with a way back. */
export function plainPage(message: string, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin" });
  for (const c of cookies) headers.append("set-cookie", c);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Upstream for maintainers</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<p>${escapeHtml(message)}</p>
<p><a href="/maintainer">Back to the maintainer page</a></p>
</body>
</html>`;
  return new Response(html, { status, headers });
}

export async function signedInMaintainer(req: Request, db: Db): Promise<{ login: string; githubId: number } | null> {
  const value = readCookie(req, MAINTAINER_COOKIE);
  return value ? maintainerForSession(db, value) : null;
}
