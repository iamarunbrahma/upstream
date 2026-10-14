import type { PackageEvidence } from "@upstream/core";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
