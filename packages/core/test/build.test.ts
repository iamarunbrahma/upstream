import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addedLines, buildEvidence, changesFromEvents, emptyDisk } from "../src/build";
import { parseTranscript } from "../src/transcript";

const jsonl = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

describe("addedLines", () => {
  it("keeps only lines that are new, respecting repeats", () => {
    expect(addedLines("a\nb\nb\nc", "b\na")).toBe("b\nc");
  });
});

describe("buildEvidence", () => {
  it("turns the fixture session into package evidence", () => {
    const { events } = parseTranscript(jsonl);
    const { changes, installs, docsUrls } = changesFromEvents(events);
    const out = buildEvidence({ changes, installs, docsUrls, disk: emptyDisk() });
    expect(out.packages).toEqual([
      { ecosystem: "npm", name: "vitest", installed: true, manifestAdded: false, importFiles: 0, usageLines: 0, kind: "devDependency" },
      { ecosystem: "pypi", name: "fastapi", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, kind: "dependency" },
      { ecosystem: "pypi", name: "pydantic", installed: true, manifestAdded: false, importFiles: 1, usageLines: 1, kind: "dependency" },
    ]);
    expect(out.docsHosts).toEqual({ "fastapi.tiangolo.com": 1 });
  });

  it("drops the project's own packages, unknown package.json fragments and local docs hosts", () => {
    const disk = { ...emptyDisk(), npmDeps: new Set(["zod"]), workspaceNames: new Set(["my-app"]) };
    const out = buildEvidence({
      changes: [
        { filePath: "/r/package.json", added: '"zod": "^4",\n"version": "1.0.0"', removed: "", fullContent: null },
        { filePath: "/r/src/a.ts", added: 'import { x } from "my-app";\nimport { z } from "zod";\nz.string();', removed: "", fullContent: null },
      ],
      installs: [],
      docsUrls: ["http://localhost:3000/x", "https://www.zod.dev/api", "not a url"],
      disk,
    });
    expect(out.packages).toEqual([
      { ecosystem: "npm", name: "zod", installed: false, manifestAdded: true, importFiles: 1, usageLines: 1, kind: "dependency" },
    ]);
    expect(out.docsHosts).toEqual({ "zod.dev": 1 });
  });

  it("credits usage in edited files whose imports were already there", () => {
    const full = 'import express from "express";\nconst app = express();\n';
    const out = buildEvidence({
      changes: [{ filePath: "/r/server.js", added: "app.use(express.json());", removed: "", fullContent: full }],
      installs: [],
      docsUrls: [],
      disk: emptyDisk(),
    });
    expect(out.packages).toEqual([
      { ecosystem: "npm", name: "express", installed: false, manifestAdded: false, importFiles: 0, usageLines: 1, kind: "unknown" },
    ]);
  });
});
