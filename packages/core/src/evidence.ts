import { createHash } from "node:crypto";
import { z } from "zod";

export const Ecosystem = z.enum(["npm", "pypi"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

export const PackageEvidence = z.object({
  ecosystem: Ecosystem,
  name: z.string().min(1).max(214),
  installed: z.boolean(),
  manifestAdded: z.boolean(),
  importFiles: z.number().int().min(0),
  usageLines: z.number().int().min(0),
  kind: z.enum(["dependency", "devDependency", "unknown"]),
});
export type PackageEvidence = z.infer<typeof PackageEvidence>;

export const ReceiptPayload = z.object({
  sessionId: z.string().min(1).max(200),
  agent: z.enum(["claude-code", "git-diff"]),
  title: z.string().max(200).nullable(),
  endedAt: z.iso.datetime(),
  packages: z.array(PackageEvidence).max(200),
  /** Docs pages the agent read, keyed by hostKey(host) so hostnames (e.g. internal wikis) never leave the machine. */
  docsHostKeys: z
    .record(z.string().regex(/^[0-9a-f]{16}$/), z.number().int().min(1))
    .refine((r) => Object.keys(r).length <= 100, "too many docs hosts"),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayload>;

export function packageKey(p: { ecosystem: Ecosystem; name: string }): string {
  return `${p.ecosystem}:${p.name}`;
}

/** One-way key for a hostname. The CLI sends keys; the server compares them with hostKey(package docs host). */
export function hostKey(host: string): string {
  const normal = host.trim().toLowerCase().replace(/^www\./, "");
  return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}
