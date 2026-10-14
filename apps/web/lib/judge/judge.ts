import { fallbackAllocations } from "./fallback";
import { applyGuardrails, parseJudgeOutput } from "./guardrails";
import { buildUserPrompt, PROMPT_VERSION, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";
import type { JudgeModel, JudgeResult, JudgeRow } from "./types";

/** Asks the model for an allocation (one retry), and falls back to fixed scores if it can't get a valid one. */
export async function judgeReceipt(title: string | null, rows: JudgeRow[], model: JudgeModel | null): Promise<JudgeResult> {
  let lastRaw: string | null = null;
  if (model && rows.length > 0) {
    const user = buildUserPrompt(title, rows);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await model.generate(SYSTEM_PROMPT, user, RESPONSE_SCHEMA);
        lastRaw = raw;
        const items = parseJudgeOutput(raw);
        if (items) {
          return { allocations: applyGuardrails(rows, items), source: "ai", modelId: model.id, promptVersion: PROMPT_VERSION, raw };
        }
      } catch {
        // Timeout or API error: retry once, then fall back below.
      }
    }
  }
  return {
    allocations: fallbackAllocations(rows),
    source: "fallback",
    modelId: model?.id ?? null,
    promptVersion: PROMPT_VERSION,
    raw: lastRaw,
  };
}
