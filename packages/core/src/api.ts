import type { PackageEvidence } from "./evidence";

export type ReceiptStatus = "proposed" | "approved" | "skipped" | "expired";

export interface ReceiptItemView {
  ecosystem: PackageEvidence["ecosystem"];
  name: string;
  weightBp: number;
  /** For display, e.g. "46.3%". */
  percent: string;
  role: string;
  reason: string;
  evidence: PackageEvidence & { docsReads: number; description: string | null };
}

export interface ReceiptView {
  id: string;
  sessionId: string;
  title: string | null;
  status: ReceiptStatus;
  source: "ai" | "fallback";
  modelId: string | null;
  promptVersion: string;
  updatedAt: string;
  /** Sorted by weight, largest first. */
  items: ReceiptItemView[];
}

export interface SubmitResponse {
  receipt: ReceiptView;
  changed: boolean;
}

export interface ListResponse {
  receipts: ReceiptView[];
}

export interface DeviceResponse {
  token: string;
  accountId: string;
}
