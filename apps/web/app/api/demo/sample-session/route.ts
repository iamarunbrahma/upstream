import { demoEnabled, isDemoAccount } from "../../../../lib/demo/accounts";
import { samplePayload } from "../../../../lib/demo/sample";
import { json, withAccount } from "../../../../lib/http";
import { RateLimitError } from "../../../../lib/limits";
import { receiptForSession, submitReceipt } from "../../../../lib/receipts/service";

export const runtime = "nodejs";

/** "Run a sample session": sends the recorded Claude Code session through the real receipt pipeline, once per demo account. */
export async function POST(req: Request): Promise<Response> {
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  return withAccount(req, async (deps, accountId) => {
    if (!(await isDemoAccount(deps.db, accountId))) return json({ error: "The sample session is only for demo accounts." }, 403);
    const payload = samplePayload();
    const existing = await receiptForSession(deps, accountId, payload.sessionId);
    if (existing) return json({ receipt: existing, changed: false });
    // The AI judge runs for real, within a daily budget for the whole demo. Past it, the receipt is estimated without AI.
    const model = deps.demoJudgeLimiter && !deps.demoJudgeLimiter.take("demo") ? null : deps.model;
    try {
      const { view, changed } = await submitReceipt({ ...deps, model }, accountId, payload);
      return json({ receipt: view, changed });
    } catch (e) {
      if (e instanceof RateLimitError) return json({ error: e.message }, 429);
      throw e;
    }
  });
}
