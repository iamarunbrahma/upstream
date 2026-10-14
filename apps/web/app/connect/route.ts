import { getDeps } from "../../lib/deps";
import { consumeLoginCode, createSession, sessionCookie } from "../../lib/web-auth";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const code = new URL(req.url).searchParams.get("code");
  const deps = await getDeps();
  const accountId = code ? await consumeLoginCode(deps.db, code) : null;
  if (!accountId) {
    return new Response("This link has expired or was already used. Run `upstream dashboard` again for a new one.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const session = await createSession(deps.db, accountId);
  return new Response(null, {
    status: 303,
    headers: { location: "/dashboard", "set-cookie": sessionCookie(session, process.env.NODE_ENV === "production") },
  });
}
