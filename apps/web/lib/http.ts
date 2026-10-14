import { accountForToken, bearerToken } from "./auth";
import { getDeps } from "./deps";
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

/** Runs `fn` with the caller's account, or answers 401. */
export async function withAccount(req: Request, fn: (deps: Deps, accountId: string) => Promise<Response>): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return json({ error: "missing token" }, 401);
  const deps = await getDeps();
  const accountId = await accountForToken(deps.db, token);
  if (!accountId) return json({ error: "unknown token" }, 401);
  return fn(deps, accountId);
}
