import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "./auth";
import type { Db } from "./db/client";
import { loginCodes, webSessions } from "./db/schema";

export const SESSION_COOKIE = "upstream_session";
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const secret = () => randomBytes(32).toString("base64url");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

export async function createLoginCode(db: Db, accountId: string, now: Date = new Date()): Promise<string> {
  const code = secret();
  await db.insert(loginCodes).values({ codeHash: hashToken(code), accountId, expiresAt: later(now, LOGIN_CODE_TTL_MS) });
  return code;
}

/** Single use: the first call within 10 minutes returns the account; every later call returns null. */
export async function consumeLoginCode(db: Db, code: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .update(loginCodes)
    .set({ usedAt: now })
    .where(and(eq(loginCodes.codeHash, hashToken(code)), isNull(loginCodes.usedAt), gt(loginCodes.expiresAt, now)))
    .returning({ accountId: loginCodes.accountId });
  return row?.accountId ?? null;
}

/** The account a still-usable login code belongs to, without using the code up. */
export async function peekLoginCode(db: Db, code: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ accountId: loginCodes.accountId })
    .from(loginCodes)
    .where(and(eq(loginCodes.codeHash, hashToken(code)), isNull(loginCodes.usedAt), gt(loginCodes.expiresAt, now)))
    .limit(1);
  return row?.accountId ?? null;
}

export async function createSession(db: Db, accountId: string, now: Date = new Date()): Promise<string> {
  const value = secret();
  await db.insert(webSessions).values({ idHash: hashToken(value), accountId, expiresAt: later(now, SESSION_TTL_MS) });
  return value;
}

export async function accountForSession(db: Db, value: string, now: Date = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ accountId: webSessions.accountId })
    .from(webSessions)
    .where(and(eq(webSessions.idHash, hashToken(value)), gt(webSessions.expiresAt, now)))
    .limit(1);
  return row?.accountId ?? null;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

/** True when a browser request comes from this site's own pages (guards cookie-authenticated writes). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
