import { z } from "zod";
import { createDevice } from "../../../lib/auth";
import { getDeps } from "../../../lib/deps";
import { json } from "../../../lib/http";

export const runtime = "nodejs";

const Body = z.object({ label: z.string().max(100).nullable().optional() });

export async function POST(req: Request): Promise<Response> {
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return json({ error: "invalid body" }, 400);
  const deps = await getDeps();
  return json(await createDevice(deps.db, body.data.label ?? null), 201);
}
