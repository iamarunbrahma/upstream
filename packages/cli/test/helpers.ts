import type { ReceiptView } from "@upstream/core";

export const view: ReceiptView = {
  id: "7f1e2c3a-0000-4000-8000-000000000001",
  sessionId: "sess-1",
  title: "Build a todo API with FastAPI",
  status: "proposed",
  source: "ai",
  modelId: "gemini-test",
  promptVersion: "judge-v1",
  updatedAt: "2026-10-14T10:00:00.000Z",
  items: [
    { ecosystem: "pypi", name: "fastapi", weightBp: 7940, percent: "79.4%", role: "foundation", reason: "Your whole API layer is built on it.",
      evidence: { ecosystem: "pypi", name: "fastapi", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, kind: "dependency", docsReads: 1, description: null } },
    { ecosystem: "pypi", name: "pydantic", weightBp: 2060, percent: "20.6%", role: "feature", reason: "Every request model.",
      evidence: { ecosystem: "pypi", name: "pydantic", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, kind: "dependency", docsReads: 0, description: null } },
  ],
};
