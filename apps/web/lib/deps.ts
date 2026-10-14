import { mkdirSync } from "node:fs";
import { createPgDb, createPgliteDb } from "./db/client";
import { migrateDb } from "./db/migrate";
import { createGeminiModel } from "./judge/gemini";
import { workflowsFromEnv } from "./jobs/workflows";
import { createRateLimiter } from "./limits";
import { createGithubOAuth } from "./maintainers/github-oauth";
import { createPayPalIdentity } from "./maintainers/paypal-identity";
import { createPayPalApi } from "./paypal/api";
import { createPayPalHttp, paypalApiBase } from "./paypal/client";
import { planIdsFromEnv } from "./paypal/plans";
import type { Deps } from "./receipts/service";
import { fetchJson } from "./resolver/registry";

let depsPromise: Promise<Deps> | null = null;

/** Process-wide dependencies from env. Postgres when DATABASE_URL is set, otherwise PGlite in .data/. */
export function getDeps(): Promise<Deps> {
  depsPromise ??= (async () => {
    const url = process.env.DATABASE_URL;
    let db;
    if (url) {
      db = createPgDb(url);
      await migrateDb(db, "pg");
    } else {
      mkdirSync(".data", { recursive: true });
      db = createPgliteDb(".data/pglite");
      await migrateDb(db, "pglite");
    }
    const apiKey = process.env.GEMINI_API_KEY;
    const modelId = process.env.GEMINI_MODEL;
    const hour = 60 * 60 * 1000;
    return {
      db,
      http: fetchJson,
      model: apiKey && modelId ? createGeminiModel(apiKey, modelId) : null,
      submitLimiter: createRateLimiter({ limit: 60, windowMs: hour }),
      deviceLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
      signInLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
      demoStartLimiter: createRateLimiter({ limit: 10, windowMs: hour }),
      demoSettleLimiter: createRateLimiter({ limit: 30, windowMs: hour }),
      demoJudgeLimiter: createRateLimiter({ limit: 300, windowMs: 24 * hour }),
      paypal:
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
          ? createPayPalApi(
              createPayPalHttp({
                clientId: process.env.PAYPAL_CLIENT_ID,
                clientSecret: process.env.PAYPAL_CLIENT_SECRET,
                baseUrl: paypalApiBase(process.env.PAYPAL_API_BASE),
              }),
            )
          : null,
      planIds: planIdsFromEnv(),
      workflows: workflowsFromEnv(),
      webhookId: process.env.PAYPAL_WEBHOOK_ID ?? null,
      githubOAuth:
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ? createGithubOAuth({ clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET })
          : null,
      paypalIdentity:
        process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
          ? createPayPalIdentity({
              clientId: process.env.PAYPAL_CLIENT_ID,
              clientSecret: process.env.PAYPAL_CLIENT_SECRET,
              apiBase: paypalApiBase(process.env.PAYPAL_API_BASE),
            })
          : null,
    };
  })();
  return depsPromise;
}
