// Builds lib/index/usage.json, the usage side of the landing page's "Agent Usage vs Funding" chart, from this
// machine's past Claude Code sessions. Each session goes through the real upstream CLI (`receipt --dry-run`), so
// only what a receipt would carry is kept: package names and counts, never code, prompts or paths. Shares use the
// judge's evidence-only scores (no AI). Kept: packages on the public npm or PyPI registry, used in 3+ sessions.
//   pnpm --filter web usage-index            prints the list, for review before it's published
//   pnpm --filter web usage-index --write    writes lib/index/usage.json
// Needs the CLI built first: pnpm --filter upstream-pay build
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReceiptPayload } from "@upstream/core";
import { aggregateUsage, type UsageIndex } from "../lib/index/usage";
import { fallbackAllocations } from "../lib/judge/fallback";
import { fetchJson, resolvePackage } from "../lib/resolver/registry";

const MIN_SESSIONS = 3;
const KEEP = 30;
/** Bigger transcripts are skipped: the CLI reads a transcript whole, and Node can't hold one past 512 MB as text. */
const MAX_BYTES = 200 * 1024 * 1024;
const root = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const cli = new URL("../../../packages/cli/plugin/dist/upstream.mjs", import.meta.url).pathname;
if (!existsSync(cli)) throw new Error("Build the CLI first: pnpm --filter upstream-pay build");

/** The folder the session ran in, from the first entries of the transcript. */
function sessionCwd(path: string): string | null {
  const head = Buffer.alloc(256 * 1024);
  const fd = openSync(path, "r");
  const n = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  for (const line of head.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd === "string") return entry.cwd;
    } catch {
      // Not a JSON line; keep looking.
    }
  }
  return null;
}

const transcripts = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d.name, f)));

const sessions: Array<ReturnType<typeof fallbackAllocations>> = [];
let skipped = 0;
for (const path of transcripts) {
  const cwd = statSync(path).size <= MAX_BYTES ? sessionCwd(path) : null;
  const run = cwd ? spawnSync("node", [cli, "receipt", "--transcript", path, "--cwd", cwd, "--dry-run"], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }) : null;
  if (!run || run.status !== 0) {
    skipped += 1;
    continue;
  }
  const payload = JSON.parse(run.stdout) as ReceiptPayload;
  sessions.push(fallbackAllocations(payload.packages.map((p) => ({ ...p, description: null }))));
}

const all = aggregateUsage(sessions, { minSessions: MIN_SESSIONS, top: KEEP * 2 });
const packages = [];
for (const p of all.packages) {
  if (packages.length === KEEP) break;
  if ((await resolvePackage(p.ecosystem, p.name, fetchJson)).found) packages.push(p);
}
const index: UsageIndex = { generatedAt: new Date().toISOString().slice(0, 10), sessions: all.sessions, packages };

console.log(`${transcripts.length} transcripts, ${skipped} skipped, ${index.sessions} used at least one package.`);
packages.forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. ${p.ecosystem.padEnd(4)} ${p.name.padEnd(32)} ${String(p.sessions).padStart(4)} sessions  ${(p.shareBp / 100).toFixed(1)}%`));
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../lib/index/usage.json", import.meta.url), JSON.stringify(index, null, 2) + "\n");
  console.log("Wrote lib/index/usage.json");
}
