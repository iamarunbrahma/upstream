import { mkdirSync } from "node:fs";
import { createPgDb, createPgliteDb } from "./db/client";
import { migrateDb } from "./db/migrate";
import { createGeminiModel } from "./judge/gemini";
import { createRateLimiter } from "./limits";
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
    };
  })();
  return depsPromise;
}
