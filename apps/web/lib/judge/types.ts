import type { PackageEvidence } from "@upstream/core";

export const ROLES = ["foundation", "feature", "helper", "tooling"] as const;
export type Role = (typeof ROLES)[number];

export type JudgeRow = PackageEvidence & { description: string | null; docsReads: number };

export interface JudgeItem {
  package: string;
  weight: number;
  role: Role;
  reason: string;
}

export interface Allocation {
  ecosystem: PackageEvidence["ecosystem"];
  name: string;
  /** Basis points; a receipt's allocations sum to exactly 10000. */
  weightBp: number;
  role: Role;
  reason: string;
}

export interface JudgeModel {
  id: string;
  generate(system: string, user: string, schema: object): Promise<string>;
}

export interface JudgeResult {
  allocations: Allocation[];
  source: "ai" | "fallback";
  modelId: string | null;
  promptVersion: string;
  raw: string | null;
}
