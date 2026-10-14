import type { ReceiptView } from "@upstream/core";
import type { InferSelectModel } from "drizzle-orm";
import type { receiptItems, receipts } from "../db/schema";

export function formatPercent(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;
}

export function toView(r: InferSelectModel<typeof receipts>, items: InferSelectModel<typeof receiptItems>[]): ReceiptView {
  return {
    id: r.id,
    sessionId: r.sessionId,
    title: r.title,
    status: r.status,
    source: r.source,
    modelId: r.modelId,
    promptVersion: r.promptVersion,
    updatedAt: r.updatedAt.toISOString(),
    items: [...items]
      .sort((a, b) => b.weightBp - a.weightBp || a.name.localeCompare(b.name))
      .map((i) => ({
        ecosystem: i.ecosystem,
        name: i.name,
        weightBp: i.weightBp,
        percent: formatPercent(i.weightBp),
        role: i.role,
        reason: i.reason,
        evidence: i.evidence,
      })),
  };
}
