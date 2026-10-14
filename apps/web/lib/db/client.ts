import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** PGlite database: in-memory when `dataDir` is undefined (tests), on disk otherwise (local dev). */
export function createPgliteDb(dataDir?: string): Db {
  return drizzlePglite(new PGlite(dataDir), { schema }) as unknown as Db;
}

export function createPgDb(url: string): Db {
  return drizzlePg(new pg.Pool({ connectionString: url, max: 5 }), { schema }) as unknown as Db;
}
