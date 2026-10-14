import type { ReceiptView } from "@upstream/core";

const STATUS = {
  proposed: "Waiting for your approval.",
  approved: "Approved.",
  skipped: "Skipped.",
  expired: "Not approved within 14 days, so it won't be paid.",
} as const;

export function formatReceipt(r: ReceiptView): string {
  const header = `Upstream receipt - ${r.title ?? "untitled session"}${r.source === "ai" ? "" : "  (estimated without AI)"}`;
  const width = Math.min(28, Math.max(7, ...r.items.map((i) => i.name.length)));
  const lines = r.items.length
    ? r.items.map((i) => `  ${i.name.padEnd(width)}  ${i.percent.padStart(6)}  ${i.reason}`)
    : ["  No open-source packages found in this session."];
  return [header, "", ...lines, "", `${STATUS[r.status]}  (receipt ${r.id})`].join("\n");
}
