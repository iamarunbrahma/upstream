import { writeFileSync } from "node:fs";
import { loadFixtures, scoreFixture } from "../lib/judge/eval/fixtures";
import { createGeminiModel } from "../lib/judge/gemini";
import { judgeReceipt } from "../lib/judge/judge";
import { PROMPT_VERSION } from "../lib/judge/prompt";

const apiKey = process.env.GEMINI_API_KEY;
const modelId = process.env.GEMINI_MODEL;
if (!apiKey || !modelId) {
  console.error("Set GEMINI_API_KEY and GEMINI_MODEL in apps/web/.env.local first.");
  process.exit(1);
}
const model = createGeminiModel(apiKey, modelId);
const fixtures = loadFixtures();
const responses: Record<string, string> = {};
let tops = 0;
let tauSum = 0;
// Free-tier Gemini keys allow only a few requests per minute; pace the calls.
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 7000);
for (const [i, f] of fixtures.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
  const r = await judgeReceipt(f.title, f.rows, model);
  if (r.source !== "ai" || !r.raw) {
    console.log(`${f.id}: the model failed twice, fallback used (not recorded)`);
    continue;
  }
  responses[f.id] = r.raw;
  const s = scoreFixture(f, r.allocations);
  tops += Number(s.topOk);
  tauSum += s.tau;
  console.log(`${f.id}: top=${s.top} ${s.topOk ? "ok" : "MISS"} tau=${s.tau.toFixed(2)}`);
}
console.log(`top-1 ${tops}/${fixtures.length}, mean tau ${(tauSum / fixtures.length).toFixed(2)}`);
writeFileSync(
  new URL("../lib/judge/eval/recorded.json", import.meta.url),
  JSON.stringify({ modelId, promptVersion: PROMPT_VERSION, responses }, null, 2) + "\n",
);
