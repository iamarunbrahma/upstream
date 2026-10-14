import { hostKey, type PackageEvidence, type ReceiptPayload } from "@upstream/core";
import type { HttpGetJson } from "../lib/resolver/registry";

export const ev = (name: string, over: Partial<PackageEvidence> = {}): PackageEvidence => ({
  ecosystem: "pypi", name, installed: false, manifestAdded: false, importFiles: 1, usageLines: 1, kind: "dependency", ...over,
});

export const payload = (over: Partial<ReceiptPayload> = {}): ReceiptPayload => ({
  sessionId: "sess-1",
  agent: "claude-code",
  title: "Build a todo API",
  endedAt: "2026-10-14T10:00:00.000Z",
  docsHostKeys: { [hostKey("fastapi.tiangolo.com")]: 2 },
  packages: [ev("fastapi", { installed: true, importFiles: 2, usageLines: 9 }), ev("pydantic")],
  ...over,
});

export const fakeRegistry: HttpGetJson = async (url) => {
  if (url.includes("/fastapi/"))
    return { status: 200, body: { info: { summary: "FastAPI framework", project_urls: { Documentation: "https://fastapi.tiangolo.com/" } } } };
  if (url.includes("/pydantic/")) return { status: 200, body: { info: { summary: "Data validation" } } };
  if (url.includes("/httpx/")) return { status: 200, body: { info: { summary: "HTTP client" } } };
  return { status: 404, body: null };
};
