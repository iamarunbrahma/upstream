import { bearerToken } from "../../../lib/auth";
import { json, withAccount } from "../../../lib/http";
import { createLoginCode } from "../../../lib/web-auth";

export const runtime = "nodejs";

/** The CLI trades its device token for a one-time dashboard link. */
export async function POST(req: Request): Promise<Response> {
  if (!bearerToken(req)) return json({ error: "missing token" }, 401);
  return withAccount(req, async (deps, accountId) => {
    const code = await createLoginCode(deps.db, accountId);
    const base = process.env.PUBLIC_URL ?? new URL(req.url).origin;
    return json({ url: `${base}/connect?code=${encodeURIComponent(code)}` }, 201);
  });
}
