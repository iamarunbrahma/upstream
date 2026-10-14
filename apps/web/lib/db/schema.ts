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
    status: text("status", { enum: ["proposed", "approved", "skipped"] }).notNull().default("proposed"),
    source: text("source", { enum: ["ai", "fallback"] }).notNull(),
    modelId: text("model_id"),
    promptVersion: text("prompt_version").notNull(),
    raw: text("raw"),
    judgeCount: integer("judge_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
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
    source: text("source", { enum: ["subscription", "topup"] }).notNull(),
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
