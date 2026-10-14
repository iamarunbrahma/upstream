import type { Ecosystem } from "./evidence";

export interface InstallHit {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean;
}

type NpmTool = "npm" | "pnpm" | "yarn" | "bun";

// Flags whose next token is a value, not a package. "-w" takes a value in npm (--workspace) but not in pnpm (--workspace-root).
const NPM_VALUE_FLAGS: Record<NpmTool, Set<string>> = {
  npm: new Set(["--prefix", "-C", "--registry", "--workspace", "-w", "--tag", "--loglevel", "--omit", "--include", "--save-prefix", "--cache", "--userconfig"]),
  pnpm: new Set(["--filter", "-F", "--dir", "-C", "--registry", "--reporter", "--loglevel", "--config-dir"]),
  yarn: new Set(["--cwd", "--registry", "--network-timeout"]),
  bun: new Set(["--cwd", "--registry", "--cache-dir"]),
};
const NPM_DEV_FLAGS: Record<NpmTool, Set<string>> = {
  npm: new Set(["-D", "--save-dev", "--dev"]),
  pnpm: new Set(["-D", "--save-dev", "--dev"]),
  yarn: new Set(["-D", "--dev"]),
  bun: new Set(["-d", "-D", "--dev"]),
};
const NPM_ADD: Record<NpmTool, Set<string>> = {
  npm: new Set(["install", "i", "add"]),
  pnpm: new Set(["add", "install", "i"]),
  yarn: new Set(["add"]),
  bun: new Set(["add", "install", "i"]),
};
const PIP_FLAGS_WITH_ARG = new Set([
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url",
  "--extra-index-url", "-f", "--find-links", "-t", "--target", "--python", "-p", "--group", "-G",
  "--optional", "--extra", "--index", "--default-index",
]);
const NOT_A_NAME = /^(\.|\/|~|file:|git\+|git:|https?:|github:|link:|workspace:)/;
// Version parts that point somewhere other than the public registry ("@repo/ui@workspace:*").
const NON_REGISTRY_VERSION = /^(workspace:|file:|link:|portal:|npm:|git\+|git:|github:|https?:)/;
// "2>&1", "> out.log", "1>/dev/null", "< input": shell redirections, never package names.
const REDIRECTION = /^(\d*|&)(>>?|<)(.*)$/;

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function npmNameFromSpec(spec: string): string | null {
  if (NOT_A_NAME.test(spec)) return null;
  const m = spec.startsWith("@")
    ? spec.match(/^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i)
    : spec.match(/^([a-z0-9][\w.-]*)/i);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Package name from an install argument; null for paths, GitHub shorthands, tarballs and non-registry versions. */
export function npmInstallName(spec: string): string | null {
  if (NOT_A_NAME.test(spec) || /\.(tgz|tar\.gz|tar)$/i.test(spec)) return null;
  const name = npmNameFromSpec(spec);
  if (!name) return null;
  const rest = spec.slice(name.length);
  if (rest.startsWith("/")) return null; // "user/repo" GitHub shorthand
  if (rest.startsWith("@") && NON_REGISTRY_VERSION.test(rest.slice(1))) return null;
  return name;
}

function pypiNameFromSpec(spec: string): string | null {
  if (NOT_A_NAME.test(spec) || spec.includes("/") || /\.(whl|tar\.gz|zip)$/i.test(spec)) return null;
  const m = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m?.[1] ? normalizePypiName(m[1]) : null;
}

function tokenize(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

function stripRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i]!.match(REDIRECTION);
    if (m) {
      if (m[3] === "") i++; // "> out.log": the target is the next token
      continue;
    }
    out.push(tokens[i]!);
  }
  return out;
}

function npmFamily(tool: NpmTool, rest: string[]): InstallHit[] {
  let i = 0;
  // Global flags may come before the subcommand: "pnpm --filter web add zod".
  while (i < rest.length && rest[i]!.startsWith("-")) {
    if (NPM_VALUE_FLAGS[tool].has(rest[i]!)) i++;
    i++;
  }
  if (!NPM_ADD[tool].has(rest[i] ?? "")) return [];
  const args = rest.slice(i + 1);
  if (args.includes("-g") || args.includes("--global")) return [];
  const dev = args.some((a) => NPM_DEV_FLAGS[tool].has(a));
  const hits: InstallHit[] = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (NPM_VALUE_FLAGS[tool].has(a)) {
      j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    const name = npmInstallName(a);
    if (name) hits.push({ ecosystem: "npm", name, dev });
  }
  return hits;
}

function pipArgs(args: string[], dev: boolean): InstallHit[] {
  const hits: InstallHit[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (PIP_FLAGS_WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    const name = pypiNameFromSpec(a);
    if (name) hits.push({ ecosystem: "pypi", name, dev });
  }
  return hits;
}

function poetryIsDev(args: string[]): boolean {
  return args.some(
    (a, i) => a === "-D" || a === "--dev" || a === "--group=dev" ||
      ((a === "--group" || a === "-G") && args[i + 1] === "dev"),
  );
}

function parseSegment(t: string[]): InstallHit[] {
  // Match the program's base name, so ".venv/bin/pip" and "/usr/local/bin/python3.12" count too.
  const a = (t[0] ?? "").split("/").pop() ?? "";
  const [, b, c, d] = t;
  const isPip = /^pip(3(\.\d+)?)?$/.test(a);
  const isPython = /^python(3(\.\d+)?)?$/.test(a);
  if (a === "npm" || a === "pnpm" || a === "yarn" || a === "bun") return npmFamily(a, t.slice(1));
  if (isPip && b === "install") return pipArgs(t.slice(2), false);
  if (isPython && b === "-m" && c === "pip" && d === "install") return pipArgs(t.slice(4), false);
  if (a === "uv" && b === "pip" && c === "install") return pipArgs(t.slice(3), false);
  if (a === "uv" && b === "add") return pipArgs(t.slice(2), t.includes("--dev"));
  if (a === "poetry" && b === "add") return pipArgs(t.slice(2), poetryIsDev(t));
  return [];
}

/** Finds packages installed by shell commands such as `npm i -D vitest && pip install fastapi`. */
export function parseInstallCommands(command: string): InstallHit[] {
  const seen = new Set<string>();
  const hits: InstallHit[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const tokens = stripRedirections(tokenize(segment));
    while (tokens.length && (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!))) tokens.shift();
    for (const hit of parseSegment(tokens)) {
      const key = `${hit.ecosystem}:${hit.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits;
}
