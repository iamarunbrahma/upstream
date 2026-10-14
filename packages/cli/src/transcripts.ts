import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code stores transcripts in ~/.claude/projects/<cwd with every non-alphanumeric character as "-">. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The most recently written transcript for `cwd`, which is the live session when called from inside one. */
export function latestTranscript(cwd: string, claudeDir: string = join(homedir(), ".claude")): string | null {
  const dir = join(claudeDir, "projects", projectSlug(cwd));
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}
