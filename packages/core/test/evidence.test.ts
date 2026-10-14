import { describe, expect, it } from "vitest";
import { PackageEvidence, ReceiptPayload } from "../src/evidence";

const ev = (over: Record<string, unknown> = {}) => ({
  ecosystem: "npm", name: "zod", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, docsReads: 0, kind: "dependency", ...over,
});

describe("PackageEvidence", () => {
  it("accepts real npm and PyPI names", () => {
    expect(PackageEvidence.safeParse(ev({ name: "@types/node" })).success).toBe(true);
    expect(PackageEvidence.safeParse(ev({ ecosystem: "pypi", name: "scikit-learn" })).success).toBe(true);
  });

  it("rejects names a registry would never serve, so no odd URLs reach npm or PyPI", () => {
    for (const name of ["a/b/c", "../etc", "Zod", "@scope/x/y", "a b"]) {
      expect(PackageEvidence.safeParse(ev({ name })).success, name).toBe(false);
    }
    expect(PackageEvidence.safeParse(ev({ ecosystem: "pypi", name: "Foo_Bar" })).success).toBe(false);
  });

  it("rejects implausible counts", () => {
    expect(PackageEvidence.safeParse(ev({ importFiles: 501 })).success).toBe(false);
    expect(PackageEvidence.safeParse(ev({ usageLines: 20001 })).success).toBe(false);
    expect(PackageEvidence.safeParse(ev({ docsReads: 201 })).success).toBe(false);
  });
});

describe("ReceiptPayload", () => {
  const base = { sessionId: "s", agent: "claude-code", title: null, endedAt: "2026-10-14T10:00:00.000Z" };

  it("allows at most 60 packages and carries no hostnames", () => {
    const pkgs = (n: number) => Array.from({ length: n }, (_, i) => ev({ name: `p${i}` }));
    expect(ReceiptPayload.safeParse({ ...base, packages: pkgs(60) }).success).toBe(true);
    expect(ReceiptPayload.safeParse({ ...base, packages: pkgs(61) }).success).toBe(false);
    expect(Object.keys(ReceiptPayload.shape)).not.toContain("docsHostKeys");
  });
});
