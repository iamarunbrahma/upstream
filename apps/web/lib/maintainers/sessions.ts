import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { hashToken } from "../auth";
import type { Db } from "../db/client";
import { maintainerSessions, maintainers, oauthStates } from "../db/schema";

export const MAINTAINER_COOKIE = "upstream_maintainer";
export const OAUTH_COOKIE = "upstream_oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MAINTAINER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const secret = () => randomBytes(32).toString("base64url");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Starts a GitHub sign-in or a PayPal link. The returned state goes to the provider and into the OAuth cookie. */
export async function issueOAuthState(db: Db, provider: "github" | "paypal", githubId: number | null, now: Date = new Date()): Promise<string> {
  // Sign-ins nobody finished are cleared out a day after they expire, so they can't pile up.
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  const state = secret();
  await db.insert(oauthStates).values({ stateHash: hashToken(state), provider, githubId, expiresAt: later(now, OAUTH_STATE_TTL_MS) });
  return state;
}

/**
 * Accepts the state a provider sent back once, within 10 minutes, and only from the browser holding it in its
 * cookie: a sign-in another site started can't complete in yours. Returns who asked, or null.
 */
export async function consumeOAuthState(
  db: Db,
  provider: "github" | "paypal",
  state: string | null,
  cookie: string | null,
  now: Date = new Date(),
): Promise<{ githubId: number | null } | null> {
  if (!state || !cookie || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: now })
    .where(and(eq(oauthStates.stateHash, hashToken(state)), eq(oauthStates.provider, provider), isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now)))
    .returning({ githubId: oauthStates.githubId });
  return row ? { githubId: row.githubId } : null;
}

export function oauthCookie(value: string | null, secure: boolean): string {
  const age = value ? OAUTH_STATE_TTL_MS / 1000 : 0;
  return `${OAUTH_COOKIE}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/maintainer; Max-Age=${age}${secure ? "; Secure" : ""}`;
}

export async function createMaintainerSession(db: Db, githubId: number, now: Date = new Date()): Promise<string> {
  const value = secret();
  await db.insert(maintainerSessions).values({ idHash: hashToken(value), githubId, expiresAt: later(now, MAINTAINER_SESSION_TTL_MS) });
  return value;
}

export async function maintainerForSession(db: Db, value: string, now: Date = new Date()): Promise<{ login: string; githubId: number } | null> {
  const [row] = await db
    .select({ login: maintainers.login, githubId: maintainerSessions.githubId })
    .from(maintainerSessions)
    .innerJoin(maintainers, eq(maintainers.githubId, maintainerSessions.githubId))
    .where(and(eq(maintainerSessions.idHash, hashToken(value)), gt(maintainerSessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function endMaintainerSession(db: Db, value: string): Promise<void> {
  await db.delete(maintainerSessions).where(eq(maintainerSessions.idHash, hashToken(value)));
}

export function maintainerCookie(value: string | null, secure: boolean): string {
  const age = value ? MAINTAINER_SESSION_TTL_MS / 1000 : 0;
  return `${MAINTAINER_COOKIE}=${value ?? ""}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`;
}
