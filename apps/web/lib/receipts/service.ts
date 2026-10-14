import { hostKey, packageKey, type ReceiptPayload, type ReceiptStatus, type ReceiptView } from "@upstream/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { receiptItems, receipts, type StoredEvidence } from "../db/schema";
import { judgeReceipt } from "../judge/judge";
import type { JudgeModel, JudgeRow } from "../judge/types";
import { resolveWithCache } from "../resolver/cache";
import type { HttpGetJson } from "../resolver/registry";
import { toView } from "./view";

export interface Deps {
  db: Db;
  http: HttpGetJson;
  model: JudgeModel | null;
}

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
    .select({ id: receipts.id, status: receipts.status })
    .from(receipts)
    .where(and(eq(receipts.accountId, accountId), eq(receipts.sessionId, sessionId)))
    .limit(1);
  return row ?? null;
}

async function buildRows(deps: Deps, payload: ReceiptPayload): Promise<JudgeRow[]> {
  const resolved = await mapLimit(payload.packages, 6, (p) => resolveWithCache(deps.db, p.ecosystem, p.name, deps.http));
  return payload.packages.map((p, i) => {
    const meta = resolved[i]!;
    const docsReads = meta.docsHosts.reduce((sum, host) => sum + (payload.docsHostKeys[hostKey(host)] ?? 0), 0);
    return { ...p, description: meta.description, docsReads };
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
  if (existing && existing.status !== "proposed") {
    return { view: (await loadView(deps.db, accountId, existing.id))!, changed: false };
  }

  const rows = await buildRows(deps, payload);
  const judged = await judgeReceipt(payload.title, rows, deps.model);
  const rowByKey = new Map(rows.map((r) => [packageKey(r), r]));
  const fields = {
    agent: payload.agent,
    title: payload.title,
    endedAt: new Date(payload.endedAt),
    source: judged.source,
    modelId: judged.modelId,
    promptVersion: judged.promptVersion,
    raw: judged.raw,
    docsHostKeys: payload.docsHostKeys,
    updatedAt: new Date(),
  };

  const id = await deps.db.transaction(async (tx) => {
    // setWhere keeps a receipt decided by a concurrent request frozen: no row comes back in that case.
    const [row] = await tx
      .insert(receipts)
      .values({ accountId, sessionId: payload.sessionId, ...fields })
      .onConflictDoUpdate({
        target: [receipts.accountId, receipts.sessionId],
        set: fields,
        setWhere: eq(receipts.status, "proposed"),
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
  return { view: (await loadView(deps.db, accountId, id))!, changed: true };
}

export function getReceipt(deps: Deps, accountId: string, id: string): Promise<ReceiptView | null> {
  return loadView(deps.db, accountId, id);
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
