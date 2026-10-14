import type { Ecosystem } from "@upstream/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { packageCache } from "../db/schema";
import { notFound, resolvePackage, type HttpGetJson, type ResolvedPackage } from "./registry";

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bumped when the lookup changes what it would answer, so answers cached before the change are ignored. */
const LOOKUP_VERSION = 2;

/** Registry lookup with a 7-day cache. Errors fall back to a stale entry or not-found, and are never cached. */
export async function resolveWithCache(
  db: Db,
  ecosystem: Ecosystem,
  name: string,
  http: HttpGetJson,
  now: Date = new Date(),
): Promise<ResolvedPackage> {
  const found = await lookupPackage(db, ecosystem, name, http, now);
  return found === "later" ? notFound(ecosystem, name) : found;
}

/**
 * Like resolveWithCache, but when the registry fails and nothing is cached it answers "later" instead of
 * not-found. Settlement uses it, so an outage makes a funder wait rather than leaving a package unpaid.
 */
export async function lookupPackage(
  db: Db,
  ecosystem: Ecosystem,
  name: string,
  http: HttpGetJson,
  now: Date = new Date(),
): Promise<ResolvedPackage | "later"> {
  const key = `v${LOOKUP_VERSION}:${ecosystem}:${name}`;
  const [row] = await db.select().from(packageCache).where(eq(packageCache.key, key)).limit(1);
  if (row && now.getTime() - row.fetchedAt.getTime() < CACHE_TTL_MS) return row.data;
  try {
    const pkg = await resolvePackage(ecosystem, name, http);
    await db
      .insert(packageCache)
      .values({ key, data: pkg, fetchedAt: now })
      .onConflictDoUpdate({ target: packageCache.key, set: { data: pkg, fetchedAt: now } });
    return pkg;
  } catch {
    return row ? row.data : "later";
  }
}
