import { accountForToken, bearerToken } from "./auth";
import { getDeps } from "./deps";
import { readCookie, SESSION_COOKIE, accountForSession, sameOrigin } from "./web-auth";
import type { Deps } from "./receipts/service";

/**
 * The caller's address for per-client limits. The hosting proxy (one hop, Render) appends the address it saw
 * to X-Forwarded-For; earlier entries are whatever the client chose to send, so only the last one is trusted.
 */
export function clientKey(req: Request): string {
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Runs `fn` with the caller's account: a device Bearer token (CLI) or the dashboard session cookie. */
export async function withAccount(req: Request, fn: (deps: Deps, accountId: string) => Promise<Response>): Promise<Response> {
  const token = bearerToken(req);
  const session = token ? null : readCookie(req, SESSION_COOKIE);
  if (!token && !session) return json({ error: "missing token" }, 401);
  if (session && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return json({ error: "cross-site request refused" }, 403);
  }
  const deps = await getDeps();
  const accountId = token ? await accountForToken(deps.db, token) : await accountForSession(deps.db, session!);
  if (!accountId) return json({ error: token ? "unknown token" : "your dashboard session has expired" }, 401);
  return fn(deps, accountId);
}
