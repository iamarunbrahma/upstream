import type { Ecosystem } from "./evidence";
import { normalizePypiName } from "./installs";

export interface ManifestAddition {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean | null;
}

export function manifestType(filePath: string): "package.json" | "requirements" | "pyproject" | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (base === "package.json") return "package.json";
  if (/^requirements.*\.(txt|in)$/i.test(base)) return "requirements";
  if (base === "pyproject.toml") return "pyproject";
  return null;
}

const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const NPM_FRAGMENT = /"(@?[a-z0-9][\w./-]*)"\s*:\s*"(?:[\^~<>=*]|\d|workspace:|npm:|latest|next)/gi;
const REQ = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@].*)?$/;
const POETRY_NON_DEPS = new Set([
  "name", "version", "description", "python", "readme", "license", "authors", "maintainers", "homepage",
  "repository", "documentation", "keywords", "packages", "include", "exclude", "requires-python",
  "build-backend", "requires", "classifiers", "urls", "scripts",
]);

/** name -> isDev for every dependency section, or null when `text` isn't a JSON object. */
function npmDepsFromJson(text: string): Map<string, boolean> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const out = new Map<string, boolean>();
  for (const section of NPM_SECTIONS) {
    const deps = (json as Record<string, unknown>)[section];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) out.set(name.toLowerCase(), section === "devDependencies");
    }
  }
  return out;
}

function npmFragmentNames(text: string): Set<string> {
  return new Set([...text.matchAll(NPM_FRAGMENT)].map((m) => m[1]!.toLowerCase()));
}

function reqName(spec: string): string | null {
  const m = spec.trim().match(REQ);
  return m?.[1] ? normalizePypiName(m[1]) : null;
}

function quoted(s: string): string[] {
  return [...s.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

export function parsePackageJsonDeps(text: string): { deps: Set<string>; devDeps: Set<string> } | null {
  const all = npmDepsFromJson(text);
  if (!all) return null;
  const deps = new Set<string>();
  const devDeps = new Set<string>();
  for (const [name, dev] of all) (dev ? devDeps : deps).add(name);
  return { deps, devDeps };
}

export function parseRequirementNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-") || line.startsWith(".") || line.includes("://")) continue;
    const name = reqName(line);
    if (name) out.add(name);
  }
  return out;
}

/** Dependency names in a pyproject.toml or a fragment of one (PEP 621 arrays and Poetry tables). */
export function parsePyprojectNames(text: string): Set<string> {
  const out = new Set<string>();
  let section: string | null = null; // null = no header seen yet, e.g. an Edit fragment
  let inArray = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      section = header[1]!.trim();
      inArray = false;
      continue;
    }
    const outsideQuotes = line.replace(/["'][^"']*["']/g, "");
    if (inArray) {
      for (const q of quoted(line)) {
        const n = reqName(q);
        if (n) out.add(n);
      }
      if (outsideQuotes.includes("]")) inArray = false;
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) {
      if (section === null && /^\s*["']/.test(line)) {
        for (const q of quoted(line)) {
          const n = reqName(q);
          if (n) out.add(n);
        }
      }
      continue;
    }
    const key = kv[1]!;
    const value = kv[2]!.trim();
    const arrayOfDeps =
      section === null
        ? key === "dependencies"
        : (section === "project" && key === "dependencies") ||
          section === "project.optional-dependencies" ||
          section === "dependency-groups";
    const poetryDep =
      section === null
        ? !POETRY_NON_DEPS.has(key) && /^["{]/.test(value)
        : /^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section) && key !== "python";
    if (arrayOfDeps && value.startsWith("[")) {
      for (const q of quoted(value)) {
        const n = reqName(q);
        if (n) out.add(n);
      }
      inArray = !value.replace(/["'][^"']*["']/g, "").includes("]");
    } else if (poetryDep) {
      out.add(normalizePypiName(key));
    }
  }
  return out;
}

/** Packages newly declared by an edit to a manifest file. `dev` is null when the edit doesn't say. */
export function manifestAdditions(filePath: string, added: string, removed: string): ManifestAddition[] {
  const type = manifestType(filePath);
  if (type === "package.json") {
    const now = npmDepsFromJson(added);
    if (now) {
      const before = npmDepsFromJson(removed) ?? new Map<string, boolean>();
      return [...now].filter(([n]) => !before.has(n)).map(([name, dev]) => ({ ecosystem: "npm" as const, name, dev }));
    }
    const before = npmFragmentNames(removed);
    return [...npmFragmentNames(added)].filter((n) => !before.has(n)).map((name) => ({ ecosystem: "npm" as const, name, dev: null }));
  }
  if (type === "requirements" || type === "pyproject") {
    const parse = type === "requirements" ? parseRequirementNames : parsePyprojectNames;
    const base = filePath.split(/[\\/]/).pop() ?? "";
    const dev = type === "requirements" && /dev|test/i.test(base) ? true : null;
    const before = parse(removed);
    return [...parse(added)].filter((n) => !before.has(n)).map((name) => ({ ecosystem: "pypi" as const, name, dev }));
  }
  return [];
}
