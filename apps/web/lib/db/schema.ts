import type { PackageEvidence } from "@upstream/core";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { TIER_KEYS } from "../paypal/plans";
import type { ResolvedPackage } from "../resolver/registry";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: createdAt(),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  createdAt: createdAt(),
});

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    sessionId: text("session_id").notNull(),
    agent: text("agent", { enum: ["claude-code", "git-diff"] }).notNull(),
    title: text("title"),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["proposed", "approved", "skipped", "expired"] }).notNull().default("proposed"),
    source: text("source", { enum: ["ai", "fallback"] }).notNull(),
    modelId: text("model_id"),
    promptVersion: text("prompt_version").notNull(),
    raw: text("raw"),
    judgeCount: integer("judge_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The settlement that spent this receipt's share of the budget; null until then. */
    settlementId: uuid("settlement_id").references(() => settlements.id),
  },
  (t) => [uniqueIndex("receipts_account_session").on(t.accountId, t.sessionId)],
);

export type StoredEvidence = PackageEvidence & { docsReads: number; description: string | null };

export const receiptItems = pgTable(
  "receipt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id").notNull().references(() => receipts.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem", { enum: ["npm", "pypi"] }).notNull(),
    name: text("name").notNull(),
    weightBp: integer("weight_bp").notNull(),
    role: text("role").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<StoredEvidence>().notNull(),
  },
  (t) => [index("receipt_items_receipt").on(t.receiptId)],
);

export const packageCache = pgTable("package_cache", {
  key: text("key").primaryKey(),
  data: jsonb("data").$type<ResolvedPackage>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

const tz = { withTimezone: true } as const;

export const webSessions = pgTable("web_sessions", {
  idHash: text("id_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
});

export const loginCodes = pgTable("login_codes", {
  codeHash: text("code_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  usedAt: timestamp("used_at", tz),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    tier: text("tier", { enum: TIER_KEYS }).notNull(),
    status: text("status").notNull(),
    payerId: text("payer_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_account").on(t.accountId)],
);

export const fundingEvents = pgTable(
  "funding_events",
  {
    paypalId: text("paypal_id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    source: text("source", { enum: ["subscription", "topup", "refund"] }).notNull(),
    /** Refunds and reversals only: the sale or capture id they take money back from. Their amount is negative. */
    refundOf: text("refund_of"),
    amountCents: integer("amount_cents").notNull(),
    payerId: text("payer_id"),
    occurredAt: timestamp("occurred_at", tz).notNull(),
    createdAt: createdAt(),
    raw: jsonb("raw"),
  },
  (t) => [index("funding_events_account").on(t.accountId)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  receivedAt: timestamp("received_at", tz).notNull().defaultNow(),
});

export const accountSettings = pgTable("account_settings", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  autoApprove: boolean("auto_approve").notNull().default(false),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

/** A GitHub account that can receive money. Plan 2c's sign-in sets `paypalPayerId` and `claimedAt`. */
export const maintainers = pgTable("maintainers", {
  login: text("login").primaryKey(),
  /** GitHub's numeric account id: who the maintainer really is, even after they rename their login. */
  githubId: integer("github_id").unique(),
  paypalPayerId: text("paypal_payer_id").unique(),
  claimedAt: timestamp("claimed_at", tz),
  createdAt: createdAt(),
});

export interface RepoRecipients {
  source: "funding" | "committers" | "none";
  /**
   * GitHub accounts with their share in basis points; the shares add up to 10000, or the list is empty.
   * githubId is the account's numeric id, which stays with the person when the login is renamed or reused.
   */
  recipients: Array<{ login: string; githubId?: number | null; shareBp: number }>;
}

export const recipientCache = pgTable("recipient_cache", {
  repo: text("repo").primaryKey(),
  data: jsonb("data").$type<RepoRecipients>().notNull(),
  fetchedAt: timestamp("fetched_at", tz).notNull(),
});

/** One run of the settlement job. Its id is also the Payouts `sender_batch_id`, so a batch is sent once. */
export const settlements = pgTable("settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: createdAt(),
  /** When we first asked PayPal to send this batch. PayPal refuses a repeated sender_batch_id for only 30 days. */
  sendStartedAt: timestamp("send_started_at", tz),
  payoutBatchId: text("payout_batch_id"),
  batchStatus: text("batch_status"),
});

/** One line of a Payouts batch: everything one maintainer is owed in that run. Its id is the `sender_item_id`. */
export const payoutItems = pgTable(
  "payout_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
    login: text("login").notNull(),
    payerId: text("payer_id").notNull(),
    cents: integer("cents").notNull(),
    paypalItemId: text("paypal_item_id"),
    status: text("status").notNull().default("PENDING"),
    feeCents: integer("fee_cents"),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [index("payout_items_settlement").on(t.settlementId)],
);

/**
 * Money a settlement set aside from one funder for one maintainer, for one package.
 * held: waiting (not claimed yet, in the first-payout hold, or under $1 in total)
 * queued: on a Payouts line; paid: PayPal confirmed it; returned: back in the funder's budget.
 */
export const accruals = pgTable(
  "accruals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settlementId: uuid("settlement_id").notNull().references(() => settlements.id),
    funderId: uuid("funder_id").notNull().references(() => accounts.id),
    login: text("login").notNull(),
    /** The GitHub account that earned this money. It, not the login, decides who is paid. Null on rows from before ids were kept. */
    githubId: integer("github_id"),
    ecosystem: text("ecosystem", { enum: ["npm", "pypi"] }).notNull(),
    name: text("name").notNull(),
    cents: integer("cents").notNull(),
    status: text("status", { enum: ["held", "queued", "paid", "returned"] }).notNull().default("held"),
    returnReason: text("return_reason", { enum: ["unclaimed", "same-person", "refunded", "bounced", "not-sent"] }),
    payoutItemId: uuid("payout_item_id").references(() => payoutItems.id),
    createdAt: createdAt(),
  },
  (t) => [index("accruals_funder").on(t.funderId), index("accruals_login_status").on(t.login, t.status)],
);

/** A maintainer signed in with GitHub. Separate from a funder's web session: one person can be both. */
export const maintainerSessions = pgTable("maintainer_sessions", {
  idHash: text("id_hash").primaryKey(),
  githubId: integer("github_id").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
});

/** The `state` of a GitHub or PayPal sign-in that is under way: single use, short-lived, bound to a cookie. */
export const oauthStates = pgTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider", { enum: ["github", "paypal"] }).notNull(),
  /** PayPal linking only: the maintainer who asked. */
  githubId: integer("github_id"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  usedAt: timestamp("used_at", tz),
});
