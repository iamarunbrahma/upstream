import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { buildEvidence, changesFromEvents, languageOf, parseTranscript, type FileChange, type ReceiptPayload } from "@upstream/core";
import { readDiskManifests } from "./disk";

const MAX_FILE_BYTES = 512 * 1024;

/** Current content of a code file, read locally to find its imports. Never sent anywhere. */
function readSmallFile(path: string): string | null {
  if (!languageOf(path)) return null;
  try {
    return statSync(path).size > MAX_FILE_BYTES ? null : readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function evidenceFromTranscript(transcriptPath: string, jsonl: string, cwd: string, now: Date = new Date()): ReceiptPayload {
  const t = parseTranscript(jsonl);
  const { changes, installs, docsUrls } = changesFromEvents(t.events);
  const withContent = changes.map((c) => ({ ...c, fullContent: readSmallFile(c.filePath) }));
  const built = buildEvidence({ changes: withContent, installs, docsUrls, disk: readDiskManifests(cwd) });
  return {
    sessionId: t.sessionId ?? basename(transcriptPath, ".jsonl"),
    agent: "claude-code",
    title: t.title,
    endedAt: now.toISOString(),
    packages: built.packages,
    docsHostKeys: built.docsHostKeys,
  };
}

export function parseUnifiedDiff(diff: string): FileChange[] {
  const out: FileChange[] = [];
  let current: { filePath: string; added: string[]; removed: string[] } | null = null;
  const flush = () => {
    if (current) out.push({ filePath: current.filePath, added: current.added.join("\n"), removed: current.removed.join("\n"), fullContent: null });
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { filePath: line.match(/ b\/(.+)$/)?.[1] ?? "", added: [], removed: [] };
      continue;
    }
    if (!current || line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  flush();
  return out;
}

/** Evidence from a git range, for agents without a Claude Code transcript. No installs or docs signals in this mode. */
export function evidenceFromGitDiff(range: string, cwd: string, now: Date = new Date()): ReceiptPayload {
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const top = git("rev-parse", "--show-toplevel").trim();
  const diff = git("diff", "--unified=0", "--no-color", range);
  const changes = parseUnifiedDiff(diff).map((c) => ({
    ...c,
    fullContent: readSmallFile(isAbsolute(c.filePath) ? c.filePath : join(top, c.filePath)),
  }));
  const built = buildEvidence({ changes, installs: [], docsUrls: [], disk: readDiskManifests(top) });
  const ids = range.split(/\.{2,3}/).filter(Boolean).map((ref) => git("rev-parse", "--short=12", ref).trim());
  const id = ids.length ? ids.join("..") : createHash("sha256").update(diff).digest("hex").slice(0, 12);
  return {
    sessionId: `git-diff:${id}`,
    agent: "git-diff",
    title: null,
    endedAt: now.toISOString(),
    packages: built.packages,
    docsHostKeys: built.docsHostKeys,
  };
}
