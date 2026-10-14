import { hostKey, type Ecosystem, type PackageEvidence } from "./evidence";
import { countUsageLines, findImports, languageOf, type ImportHit } from "./imports";
import { parseInstallCommands, type InstallHit } from "./installs";
import { manifestAdditions, manifestType } from "./manifests";
import type { ToolEvent } from "./transcript";

export interface FileChange {
  filePath: string;
  added: string;
  removed: string;
  /** Current file content when the caller could read it, so edits to pre-existing files still find imports. */
  fullContent: string | null;
}

export interface DiskManifests {
  npmDeps: Set<string>;
  npmDevDeps: Set<string>;
  pypiDeps: Set<string>;
  /** The project's own package names; never credited. */
  workspaceNames: Set<string>;
}

export interface EvidenceInput {
  changes: FileChange[];
  installs: InstallHit[];
  docsUrls: string[];
  disk: DiskManifests;
}

export interface BuiltEvidence {
  packages: PackageEvidence[];
  /** hostKey(host) -> pages read. */
  docsHostKeys: Record<string, number>;
}

export function emptyDisk(): DiskManifests {
  return { npmDeps: new Set(), npmDevDeps: new Set(), pypiDeps: new Set(), workspaceNames: new Set() };
}

/** Lines of `next` that aren't in `prev`, counting repeats. */
export function addedLines(next: string, prev: string): string {
  const counts = new Map<string, number>();
  for (const l of prev.split("\n")) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of next.split("\n")) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else out.push(l);
  }
  return out.join("\n");
}

export function changesFromEvents(events: ToolEvent[]): { changes: FileChange[]; installs: InstallHit[]; docsUrls: string[] } {
  const changes: FileChange[] = [];
  const installs: InstallHit[] = [];
  const docsUrls: string[] = [];
  for (const e of events) {
    if (e.tool === "Write") changes.push({ filePath: e.filePath, added: e.content, removed: "", fullContent: null });
    else if (e.tool === "Edit")
      changes.push({
        filePath: e.filePath,
        added: addedLines(e.newString, e.oldString),
        removed: addedLines(e.oldString, e.newString),
        fullContent: null,
      });
    else if (e.tool === "Bash") installs.push(...parseInstallCommands(e.command));
    else docsUrls.push(e.url);
  }
  return { changes, installs, docsUrls };
}

interface Acc {
  ecosystem: Ecosystem;
  name: string;
  installed: boolean;
  manifestAdded: boolean;
  importFiles: Set<string>;
  usageLines: number;
  dev: boolean | null;
}

function kindOf(a: Acc, disk: DiskManifests): PackageEvidence["kind"] {
  if (a.ecosystem === "npm") {
    if (disk.npmDevDeps.has(a.name)) return "devDependency";
    if (disk.npmDeps.has(a.name)) return "dependency";
  } else if (disk.pypiDeps.has(a.name)) return "dependency";
  if (a.dev === true) return "devDependency";
  if (a.dev === false) return "dependency";
  return "unknown";
}

function docsHostKeyCounts(urls: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") || host.endsWith(".local")) continue;
    const key = hostKey(host);
    if (!(key in out) && Object.keys(out).length >= 100) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Combines file changes, installs and docs reads into per-package evidence. Pure. */
export function buildEvidence(input: EvidenceInput): BuiltEvidence {
  const acc = new Map<string, Acc>();
  const get = (ecosystem: Ecosystem, name: string): Acc => {
    const key = `${ecosystem}:${name}`;
    let a = acc.get(key);
    if (!a) {
      a = { ecosystem, name, installed: false, manifestAdded: false, importFiles: new Set(), usageLines: 0, dev: null };
      acc.set(key, a);
    }
    return a;
  };
  const localsByFile = new Map<string, Map<string, { hit: ImportHit; locals: string[] }>>();
  const remember = (filePath: string, hits: ImportHit[]) => {
    const m = localsByFile.get(filePath) ?? new Map();
    for (const hit of hits) {
      const key = `${hit.ecosystem}:${hit.name}`;
      const prev = m.get(key)?.locals ?? [];
      m.set(key, { hit, locals: [...new Set([...prev, ...hit.localNames])] });
    }
    localsByFile.set(filePath, m);
  };

  for (const ch of input.changes) {
    if (ch.fullContent && languageOf(ch.filePath)) remember(ch.filePath, findImports(ch.filePath, ch.fullContent));
  }

  for (const ch of input.changes) {
    if (manifestType(ch.filePath)) {
      for (const add of manifestAdditions(ch.filePath, ch.added, ch.removed)) {
        // Fragment edits can't tell a dependency from "version"; trust them only if the on-disk manifest agrees.
        if (add.ecosystem === "npm" && add.dev === null && !input.disk.npmDeps.has(add.name) && !input.disk.npmDevDeps.has(add.name)) continue;
        const a = get(add.ecosystem, add.name);
        a.manifestAdded = true;
        if (add.dev !== null && a.dev === null) a.dev = add.dev;
      }
      continue;
    }
    const lang = languageOf(ch.filePath);
    if (!lang) continue;
    const newImports = findImports(ch.filePath, ch.added);
    remember(ch.filePath, newImports);
    for (const hit of newImports) get(hit.ecosystem, hit.name).importFiles.add(ch.filePath);
    for (const { hit, locals } of localsByFile.get(ch.filePath)?.values() ?? []) {
      const n = countUsageLines(ch.added, locals, lang);
      if (n > 0) get(hit.ecosystem, hit.name).usageLines += n;
    }
  }

  for (const hit of input.installs) {
    const a = get(hit.ecosystem, hit.name);
    a.installed = true;
    if (hit.dev) a.dev = true;
    else if (a.dev === null) a.dev = false;
  }

  const declared = (a: Acc) =>
    a.ecosystem === "npm" ? input.disk.npmDeps.has(a.name) || input.disk.npmDevDeps.has(a.name) : input.disk.pypiDeps.has(a.name);
  const packages = [...acc.values()]
    .filter((a) => !input.disk.workspaceNames.has(a.name))
    // An import alone can be a first-party module ("app.routers") or a path alias ("lib/db"). Only credit, and only
    // ever send, packages that an install, a manifest edit or the on-disk manifest backs.
    .filter((a) => a.installed || a.manifestAdded || declared(a))
    .sort((x, y) => y.importFiles.size - x.importFiles.size || y.usageLines - x.usageLines)
    .slice(0, 200)
    .map<PackageEvidence>((a) => ({
      ecosystem: a.ecosystem,
      name: a.name,
      installed: a.installed,
      manifestAdded: a.manifestAdded,
      importFiles: a.importFiles.size,
      usageLines: a.usageLines,
      kind: kindOf(a, input.disk),
    }))
    .sort((x, y) => (x.ecosystem + ":" + x.name).localeCompare(y.ecosystem + ":" + y.name));

  return { packages, docsHostKeys: docsHostKeyCounts(input.docsUrls) };
}
