import { z } from "zod";

export const Ecosystem = z.enum(["npm", "pypi"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

/** Registry naming rules, so only real-looking package names reach the server or a registry URL. */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const PYPI_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Upper bounds on what one coding session can plausibly produce. */
export const LIMITS = { packages: 60, importFiles: 500, usageLines: 20000, docsReads: 200 } as const;

export function isValidPackageName(ecosystem: Ecosystem, name: string): boolean {
  return name.length <= 214 && (ecosystem === "npm" ? NPM_NAME : PYPI_NAME).test(name);
}

export const PackageEvidence = z
  .object({
    ecosystem: Ecosystem,
    name: z.string().min(1).max(214),
    installed: z.boolean(),
    manifestAdded: z.boolean(),
    importFiles: z.number().int().min(0).max(LIMITS.importFiles),
    usageLines: z.number().int().min(0).max(LIMITS.usageLines),
    /** Docs pages read for this package, counted on the developer's machine. No URL or hostname is sent. */
    docsReads: z.number().int().min(0).max(LIMITS.docsReads),
    kind: z.enum(["dependency", "devDependency", "unknown"]),
  })
  .refine((p) => isValidPackageName(p.ecosystem, p.name), { message: "not a valid package name", path: ["name"] });
export type PackageEvidence = z.infer<typeof PackageEvidence>;

export const ReceiptPayload = z.object({
  sessionId: z.string().min(1).max(200),
  agent: z.enum(["claude-code", "git-diff"]),
  title: z.string().max(200).nullable(),
  endedAt: z.iso.datetime(),
  packages: z.array(PackageEvidence).max(LIMITS.packages),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayload>;

export function packageKey(p: { ecosystem: Ecosystem; name: string }): string {
  return `${p.ecosystem}:${p.name}`;
}
