import type { AgentOrders } from "../paypal/agent-toolkit";
import { packageKey, type ReceiptPayload, type ReceiptStatus, type ReceiptView } from "@upstream/core";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { receiptItems, receipts, type StoredEvidence } from "../db/schema";
import { judgeWith } from "../jobs/run";
import type { Workflows } from "../jobs/workflows";
import type { JudgeModel, JudgeRow } from "../judge/types";
import { resolveWithCache } from "../resolver/cache";
import { RateLimitError, type RateLimiter } from "../limits";
import type { PayPalApi } from "../paypal/api";
import type { TierKey } from "../paypal/plans";
import type { HttpGetJson } from "../resolver/registry";
import { shouldAutoApprove } from "../funding/settings";
import { toView } from "./view";
import type { GithubOAuth } from "../maintainers/github-oauth";
import type { PayPalIdentity } from "../maintainers/paypal-identity";

export interface Deps {
  db: Db;
  http: HttpGetJson;
  model: JudgeModel | null;
  /** Per-account cap on submissions that trigger judging. */
  submitLimiter?: RateLimiter;
  /** Per-client cap on device sign-ups. */
  deviceLimiter?: RateLimiter;
  /** Per-client cap on starting a maintainer sign-in or PayPal link. */
  signInLimiter?: RateLimiter;
  /** Per-client cap on "Try the demo" accounts. */
  demoStartLimiter?: RateLimiter;
  /** Per-account cap on the demo's "Settle now". */
  demoSettleLimiter?: RateLimiter;
  /** Cap on AI judging for the demo's sample session, shared by every demo account. */
  demoJudgeLimiter?: RateLimiter;
  /** Render Workflows, which run the judge, settlements and payout checks; null runs them in this process. */
  workflows?: Workflows | null;
  /** PayPal REST client; null when the server has no PayPal credentials. */
  paypal?: PayPalApi | null;
  planIds?: Partial<Record<TierKey, string>>;
  /** The id PayPal gave our webhook, needed to verify webhook signatures. */
  webhookId?: string | null;
  /** GitHub sign-in for maintainers; null when the server has no GitHub OAuth app. */
  githubOAuth?: GithubOAuth | null;
  /** Log in with PayPal, for maintainers linking where they're paid; null without PayPal credentials. */
  paypalIdentity?: PayPalIdentity | null;
  /** PayPal's Agent Toolkit, for payments a developer's coding agent starts; null without PayPal credentials or off the sandbox. */
  agentOrders?: AgentOrders | null;
}

/** A session's receipt is re-judged at most this many times, so re-submitting can't burn model quota. */
export const MAX_JUDGES_PER_SESSION = 10;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function loadView(db: Db, accountId: string, id: string): Promise<ReceiptView | null> {
  const [r] = await db.select().from(receipts).where(and(eq(receipts.id, id), eq(receipts.accountId, accountId))).limit(1);
  if (!r) return null;
  const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id));
  return toView(r, items);
}

async function findBySession(db: Db, accountId: string, sessionId: string) {
  const [row] = await db
    .select({ id: receipts.id, status: receipts.status, judgeCount: receipts.judgeCount })
    .from(receipts)
    .where(and(eq(receipts.accountId, accountId), eq(receipts.sessionId, sessionId)))
    .limit(1);
  return row ?? null;
}

async function buildRows(deps: Deps, payload: ReceiptPayload): Promise<JudgeRow[]> {
  const resolved = await mapLimit(payload.packages, 6, (p) => resolveWithCache(deps.db, p.ecosystem, p.name, deps.http));
  return payload.packages.map((p, i) => {
    const meta = resolved[i]!;
    return { ...p, description: meta.description };
  });
}

/**
 * Creates the session's receipt, or rebuilds it while it is still proposed.
 * An approved or skipped receipt is never changed (changed: false).
 */
export async function submitReceipt(
  deps: Deps,
  accountId: string,
  payload: ReceiptPayload,
): Promise<{ view: ReceiptView; changed: boolean }> {
  const existing = await findBySession(deps.db, accountId, payload.sessionId);
  if (existing && (existing.status !== "proposed" || existing.judgeCount >= MAX_JUDGES_PER_SESSION)) {
    return { view: (await loadView(deps.db, accountId, existing.id))!, changed: false };
  }
  if (deps.submitLimiter && !deps.submitLimiter.take(accountId)) throw new RateLimitError();

  const rows = await buildRows(deps, payload);
  const judged = await judgeWith(deps, payload.title, rows);
  const rowByKey = new Map(rows.map((r) => [packageKey(r), r]));
  const fields = {
    agent: payload.agent,
    title: payload.title,
    endedAt: new Date(payload.endedAt),
    source: judged.source,
    modelId: judged.modelId,
    promptVersion: judged.promptVersion,
    raw: judged.raw,
    updatedAt: new Date(),
  };

  const id = await deps.db.transaction(async (tx) => {
    // setWhere keeps a receipt decided by a concurrent request frozen: no row comes back in that case.
    const [row] = await tx
      .insert(receipts)
      .values({ accountId, sessionId: payload.sessionId, ...fields, judgeCount: 1 })
      .onConflictDoUpdate({
        target: [receipts.accountId, receipts.sessionId],
        set: { ...fields, judgeCount: sql`${receipts.judgeCount} + 1` },
        setWhere: and(eq(receipts.status, "proposed"), lt(receipts.judgeCount, MAX_JUDGES_PER_SESSION)),
      })
      .returning({ id: receipts.id });
    if (!row) return null;
    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, row.id));
    if (judged.allocations.length > 0) {
      await tx.insert(receiptItems).values(
        judged.allocations.map((a) => {
          const r = rowByKey.get(packageKey(a))!;
          const evidence: StoredEvidence = {
            ecosystem: r.ecosystem, name: r.name, installed: r.installed, manifestAdded: r.manifestAdded,
            importFiles: r.importFiles, usageLines: r.usageLines, kind: r.kind, docsReads: r.docsReads, description: r.description,
          };
          return { receiptId: row.id, ecosystem: a.ecosystem, name: a.name, weightBp: a.weightBp, role: a.role, reason: a.reason, evidence };
        }),
      );
    }
    return row.id;
  });

  if (id === null) {
    const frozen = (await findBySession(deps.db, accountId, payload.sessionId))!;
    return { view: (await loadView(deps.db, accountId, frozen.id))!, changed: false };
  }
  if (await shouldAutoApprove(deps.db, accountId)) await decideReceipt(deps, accountId, id, "approve");
  return { view: (await loadView(deps.db, accountId, id))!, changed: true };
}

export function getReceipt(deps: Deps, accountId: string, id: string): Promise<ReceiptView | null> {
  return loadView(deps.db, accountId, id);
}

/** This account's receipt for a session, if it has one. */
export async function receiptForSession(deps: Deps, accountId: string, sessionId: string): Promise<ReceiptView | null> {
  const found = await findBySession(deps.db, accountId, sessionId);
  return found ? loadView(deps.db, accountId, found.id) : null;
}

export async function listReceipts(deps: Deps, accountId: string, status?: ReceiptStatus, limit = 20): Promise<ReceiptView[]> {
  const where = status ? and(eq(receipts.accountId, accountId), eq(receipts.status, status)) : eq(receipts.accountId, accountId);
  const rows = await deps.db.select().from(receipts).where(where).orderBy(desc(receipts.updatedAt)).limit(Math.min(limit, 100));
  if (rows.length === 0) return [];
  const items = await deps.db.select().from(receiptItems).where(inArray(receiptItems.receiptId, rows.map((r) => r.id)));
  return rows.map((r) => toView(r, items.filter((i) => i.receiptId === r.id)));
}

/** Approve or skip a proposed receipt. Deciding twice keeps the first decision. Null if not this account's receipt. */
export async function decideReceipt(
  deps: Deps,
  accountId: string,
  id: string,
  action: "approve" | "skip",
): Promise<ReceiptView | null> {
  const now = new Date();
  await deps.db
    .update(receipts)
    .set({ status: action === "approve" ? "approved" : "skipped", decidedAt: now, updatedAt: now })
    .where(and(eq(receipts.id, id), eq(receipts.accountId, accountId), eq(receipts.status, "proposed")));
  return loadView(deps.db, accountId, id);
}
