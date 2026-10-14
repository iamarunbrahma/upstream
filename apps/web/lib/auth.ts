import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { accounts, devices } from "./db/schema";

export function newToken(): string {
  return `upk_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/** New account + device. The raw token is returned once; only its hash is stored. */
export async function createDevice(db: Db, label: string | null): Promise<{ token: string; accountId: string }> {
  const token = newToken();
  const accountId = await db.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
    await tx.insert(devices).values({ accountId: account!.id, tokenHash: hashToken(token), label });
    return account!.id;
  });
  return { token, accountId };
}

export async function accountForToken(db: Db, token: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: devices.accountId })
    .from(devices)
    .where(eq(devices.tokenHash, hashToken(token)))
    .limit(1);
  return row?.accountId ?? null;
}
