import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptPayload } from "@upstream/core";
import { describe, expect, it } from "vitest";
import { evidenceFromGitDiff, evidenceFromTranscript, parseUnifiedDiff } from "../src/collect";
import { readDiskManifests } from "../src/disk";
import { latestTranscript, projectSlug } from "../src/transcripts";

const fixture = new URL("./fixtures/session.jsonl", import.meta.url);

describe("evidenceFromTranscript", () => {
  it("builds a valid payload with session id, title and packages, and no prompt text", () => {
    const cwd = mkdtempSync(join(tmpdir(), "upstream-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "my-app", devDependencies: { vitest: "5.0.4" } }));
    const jsonl = readFileSync(fixture, "utf8");
    const payload = evidenceFromTranscript(fixture.pathname, jsonl, cwd, new Date("2026-10-14T10:00:00Z"));
    expect(ReceiptPayload.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({ sessionId: "sess-1", agent: "claude-code", title: "Build a todo API with FastAPI", endedAt: "2026-10-14T10:00:00.000Z" });
    expect(payload.packages.map((p) => `${p.ecosystem}:${p.name}:${p.kind}`)).toEqual([
      "npm:vitest:devDependency", "pypi:fastapi:dependency", "pypi:pydantic:dependency",
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret prompt text");
  });

  it("falls back to the transcript file name when the transcript has no session id", () => {
    const payload = evidenceFromTranscript("/x/abc-123.jsonl", "", "/nonexistent");
    expect(payload.sessionId).toBe("abc-123");
    expect(payload.packages).toEqual([]);
  });
});

describe("evidenceFromTranscript in a repo with nested manifests", () => {
  it("credits packages declared next to the changed files and leaves workspace packages out", () => {
    const root = mkdtempSync(join(tmpdir(), "upstream-mono-"));
    mkdirSync(join(root, "frontend", "src"), { recursive: true });
    mkdirSync(join(root, "backend"), { recursive: true });
    writeFileSync(join(root, "frontend", "package.json"), JSON.stringify({ name: "frontend", dependencies: { react: "19", "@repo/ui": "workspace:*" } }));
    writeFileSync(join(root, "backend", "requirements.txt"), "fastapi\n");
    const write = (id: string, file: string, content: string) =>
      JSON.stringify({ type: "assistant", sessionId: "m", message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: file, content } }] } });
    const jsonl = [
      write("1", join(root, "frontend", "src", "App.tsx"), 'import { useState } from "react";\nimport { Button } from "@repo/ui";\nconst [a] = useState(0);\n'),
      write("2", join(root, "backend", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n"),
    ].join("\n");
    const payload = evidenceFromTranscript("/x/m.jsonl", jsonl, root);
    expect(payload.packages.map((p) => `${p.ecosystem}:${p.name}`)).toEqual(["npm:react", "pypi:fastapi"]);
  });
});

describe("parseUnifiedDiff", () => {
  it("collects added and removed lines per file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      "-const old = 1;",
      '+import { z } from "zod";',
      "+z.string();",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { filePath: "src/a.ts", added: 'import { z } from "zod";\nz.string();', removed: "const old = 1;", fullContent: null },
      { filePath: "README.md", added: "hello", removed: "", fullContent: null },
    ]);
  });
});

describe("evidenceFromGitDiff", () => {
  it("builds evidence from a commit range in a real repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "upstream-git-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { zod: "4.6.7" } }));
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(join(dir, "a.ts"), 'import { z } from "zod";\nexport const x = z.number();\n');
    git("commit", "-qam", "two");
    const payload = evidenceFromGitDiff("HEAD~1..HEAD", dir);
    expect(payload.agent).toBe("git-diff");
    expect(payload.title).toBeNull();
    expect(payload.sessionId).toMatch(/^git-diff:[0-9a-f]{12}\.\.[0-9a-f]{12}$/);
    expect(payload.packages.map((p) => [p.name, p.importFiles, p.usageLines])).toEqual([["zod", 1, 1]]);
  });
});

describe("readDiskManifests", () => {
  it("reads package.json, requirements and pyproject, including the project's own names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "upstream-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "My-App", dependencies: { next: "16" }, devDependencies: { vitest: "5" } }));
    writeFileSync(join(cwd, "requirements.txt"), "fastapi>=0.1\n");
    writeFileSync(join(cwd, "pyproject.toml"), '[project]\nname = "my_tool"\ndependencies = ["httpx"]\n');
    const disk = readDiskManifests(cwd);
    expect(disk.npmDeps).toEqual(new Set(["next"]));
    expect(disk.npmDevDeps).toEqual(new Set(["vitest"]));
    expect(disk.pypiDeps).toEqual(new Set(["fastapi", "httpx"]));
    expect(disk.workspaceNames).toEqual(new Set(["my-app", "my-tool"]));
  });
});

describe("transcripts", () => {
  it("maps a cwd to Claude Code's project folder name", () => {
    expect(projectSlug("/Users/a/hackathons/youcam_api")).toBe("-Users-a-hackathons-youcam-api");
  });

  it("finds the newest transcript for a project", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
    const dir = join(claudeDir, "projects", projectSlug("/work/app"));
    const { mkdirSync, utimesSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), "");
    writeFileSync(join(dir, "new.jsonl"), "");
    utimesSync(join(dir, "old.jsonl"), new Date(1000), new Date(1000));
    expect(latestTranscript("/work/app", claudeDir)).toBe(join(dir, "new.jsonl"));
    expect(latestTranscript("/elsewhere", claudeDir)).toBeNull();
  });
});
