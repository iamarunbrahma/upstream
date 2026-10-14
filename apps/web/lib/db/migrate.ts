import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client";

/** apps/web/drizzle whether the process runs from apps/web (Next) or the repo root (vitest). */
function migrationsFolder(): string {
  const local = join(process.cwd(), "drizzle");
  return existsSync(local) ? local : join(process.cwd(), "apps", "web", "drizzle");
}

export async function migrateDb(db: Db, kind: "pglite" | "pg"): Promise<void> {
  const config = { migrationsFolder: migrationsFolder() };
  if (kind === "pglite") await migratePglite(db as unknown as PgliteDatabase, config);
  else await migratePg(db as unknown as NodePgDatabase, config);
}
