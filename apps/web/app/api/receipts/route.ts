import { ReceiptPayload } from "@upstream/core";
import { z } from "zod";
import { json, withAccount } from "../../../lib/http";
import { listReceipts, submitReceipt } from "../../../lib/receipts/service";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const parsed = ReceiptPayload.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid receipt", issues: parsed.error.issues.slice(0, 5) }, 400);
    const { view, changed } = await submitReceipt(deps, accountId, parsed.data);
    return json({ receipt: view, changed });
  });
}

const Query = z.object({
  status: z.enum(["proposed", "approved", "skipped"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: Request): Promise<Response> {
  return withAccount(req, async (deps, accountId) => {
    const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) return json({ error: "invalid query" }, 400);
    return json({ receipts: await listReceipts(deps, accountId, q.data.status, q.data.limit) });
  });
}
