import type { Ecosystem } from "@upstream/core";
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accruals, receiptItems, receipts, settlements, type RepoRecipients } from "../db/schema";
import type { RepoRef } from "../resolver/github";
import { balanceCents } from "./ledger";
import { withSettleLock } from "./lock";
import { queuePayouts, type QueueSummary } from "./payouts";
import { splitCents } from "./split";

const DAY = 24 * 60 * 60 * 1000;
/** Proposed receipts nobody approved within this long are dropped (spec section 7, spending rule). */
export const PROPOSED_EXPIRY_MS = 14 * DAY;
/** Self-dealing control: one funder sets aside at most this much for one maintainer per calendar month (UTC). */
export const MONTHLY_CAP_CENTS = 10_000;

export interface SettleDeps {
  db: Db;
  /** The package's GitHub repo, null when it has none, or "later" while its registry can't be reached. */
  repoFor: (ecosystem: Ecosystem, name: string) => Promise<RepoRef | null | "later">;
  /** Who gets the repo's share, or "later" while GitHub is rate-limiting (cached GitHub lookup). */
  recipients: (repo: RepoRef) => Promise<RepoRecipients | "later">;
  now?: () => Date;
  /** Pay a maintainer once they're owed this much; $1 unless the server sets it lower (the sandbox demo). */
  minPayoutCents?: number;
}

export interface SettleSummary extends QueueSummary {
  settlementId: string;
  expiredReceipts: number;
  /** Funders whose approved receipts were settled in this run. */
  settledFunders: number;
  /** Funders left for a later run: GitHub said "later", or their budget was empty. */
  waitingFunders: number;
  setAsideCents: number;
}

export interface SettleOptions {
  /** Settle only this funder's budget ("Settle now" in the demo); everyone else waits for the scheduled run. */
  funderId?: string;
}

type Lookup = RepoRecipients | "later" | null;
const keyOf = (ecosystem: string, name: string) => `${ecosystem}:${name}`;
const forFunder = (opts: SettleOptions) => (opts.funderId ? eq(receipts.accountId, opts.funderId) : undefined);

/** Looks up every package that unsettled approved receipts mention. Network calls happen here, outside the lock. */
async function lookUpPackages(deps: SettleDeps, opts: SettleOptions): Promise<Map<string, Lookup>> {
  const pkgs = await deps.db
    .selectDistinct({ ecosystem: receiptItems.ecosystem, name: receiptItems.name })
    .from(receiptItems)
    .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
    .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId), forFunder(opts)));
  const found = new Map<string, Lookup>();
  for (const p of pkgs) {
    const repo = await deps.repoFor(p.ecosystem, p.name);
    found.set(keyOf(p.ecosystem, p.name), repo === "later" ? "later" : repo ? await deps.recipients(repo) : null);
  }
  return found;
}

/**
 * Spends one funder's whole unspent budget on their approved, not-yet-settled receipts:
 * across packages by summed receipt weight, then across each package's recipients by share,
 * both with largest-remainder rounding. A share with nobody to receive it, or over the monthly cap,
 * stays in the budget. Returns null when the funder has to wait for a later run.
 */
async function settleFunder(tx: Db, settlementId: string, funderId: string, found: Map<string, Lookup>, now: Date): Promise<number | null> {
  const open = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.accountId, funderId), eq(receipts.status, "approved"), isNull(receipts.settlementId)));
  if (open.length === 0) return 0;
  const items = await tx
    .select({ ecosystem: receiptItems.ecosystem, name: receiptItems.name, weightBp: receiptItems.weightBp })
    .from(receiptItems)
    .where(inArray(receiptItems.receiptId, open.map((r) => r.id)));
  const weights = new Map<string, { ecosystem: Ecosystem; name: string; bp: number }>();
  for (const i of items) {
    const k = keyOf(i.ecosystem, i.name);
    const w = weights.get(k) ?? { ecosystem: i.ecosystem, name: i.name, bp: 0 };
    w.bp += i.weightBp;
    weights.set(k, w);
  }
  const pkgs = [...weights.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (pkgs.some(([k]) => !found.has(k) || found.get(k) === "later")) return null;
  const budget = await balanceCents(tx, funderId);
  if (budget <= 0) return null;

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sofar = await tx
    .select({ login: accruals.login, cents: sql<string>`sum(${accruals.cents})` })
    .from(accruals)
    .where(and(eq(accruals.funderId, funderId), gte(accruals.createdAt, monthStart), ne(accruals.status, "returned")))
    .groupBy(accruals.login);
  const given = new Map(sofar.map((r) => [r.login, Number(r.cents)]));

  const perPkg = splitCents(budget, pkgs.map(([, w]) => w.bp));
  const rows: Array<typeof accruals.$inferInsert> = [];
  pkgs.forEach(([k, w], i) => {
    const who = found.get(k) as RepoRecipients | null;
    if (!who || who.recipients.length === 0 || perPkg[i] === 0) return;
    const parts = splitCents(perPkg[i]!, who.recipients.map((r) => r.shareBp));
    who.recipients.forEach((r, j) => {
      // Money is filed by GitHub account; a recipient GitHub gave no account id for can't be paid safely.
      if (typeof r.githubId !== "number") return;
      const room = Math.max(0, MONTHLY_CAP_CENTS - (given.get(r.login) ?? 0));
      const cents = Math.min(parts[j]!, room);
      if (cents <= 0) return;
      given.set(r.login, (given.get(r.login) ?? 0) + cents);
      rows.push({ settlementId, funderId, login: r.login, githubId: r.githubId, ecosystem: w.ecosystem, name: w.name, cents, createdAt: now });
    });
  });
  if (rows.length > 0) await tx.insert(accruals).values(rows);
  await tx.update(receipts).set({ settlementId }).where(inArray(receipts.id, open.map((r) => r.id)));
  return rows.reduce((sum, r) => sum + r.cents, 0);
}

/**
 * One settlement run: drops stale proposals, settles every funder with approved receipts, then puts what's
 * owed on payout lines (sent by payOut). Safe to run twice: each receipt and each accrual is spent once.
 */
export async function settle(deps: SettleDeps, opts: SettleOptions = {}): Promise<SettleSummary> {
  const now = deps.now?.() ?? new Date();
  const found = await lookUpPackages(deps, opts);
  // The lock keeps two settlement runs from spending the same budget.
  return withSettleLock(deps.db, async (tx) => {
    const [run] = await tx.insert(settlements).values({ createdAt: now }).returning({ id: settlements.id });
    const expired = await tx
      .update(receipts)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(receipts.status, "proposed"), lt(receipts.createdAt, new Date(now.getTime() - PROPOSED_EXPIRY_MS))))
      .returning({ id: receipts.id });
    const funders = await tx
      .selectDistinct({ id: receipts.accountId })
      .from(receipts)
      .where(and(eq(receipts.status, "approved"), isNull(receipts.settlementId), forFunder(opts)));
    const summary = { settlementId: run!.id, expiredReceipts: expired.length, settledFunders: 0, waitingFunders: 0, setAsideCents: 0 };
    for (const f of funders) {
      const cents = await settleFunder(tx, run!.id, f.id, found, now);
      if (cents === null) summary.waitingFunders += 1;
      else {
        summary.settledFunders += 1;
        summary.setAsideCents += cents;
      }
    }
    return { ...summary, ...(await queuePayouts(tx, run!.id, now, deps.minPayoutCents, opts.funderId)) };
  });
}
