import type { Ecosystem } from "./evidence";

export interface InstallHit {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean;
}

const NPM_FLAGS_WITH_ARG = new Set(["--prefix", "--registry", "--workspace", "-w", "--filter", "-F", "--cwd", "-C", "--dir"]);
const PIP_FLAGS_WITH_ARG = new Set([
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url",
  "--extra-index-url", "-f", "--find-links", "-t", "--target", "--python", "-p", "--group", "-G",
]);
const NOT_A_NAME = /^(\.|\/|~|file:|git\+|git:|https?:|github:|link:|workspace:)/;

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

function pypiNameFromSpec(spec: string): string | null {
  if (NOT_A_NAME.test(spec) || spec.includes("/") || /\.(whl|tar\.gz|zip)$/i.test(spec)) return null;
  const m = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m?.[1] ? normalizePypiName(m[1]) : null;
}

function tokenize(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

function npmArgs(args: string[]): InstallHit[] {
  if (args.includes("-g") || args.includes("--global")) return [];
  const dev = args.some((a) => a === "-D" || a === "--save-dev" || a === "--dev");
  const hits: InstallHit[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (NPM_FLAGS_WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    const name = npmNameFromSpec(a);
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
  if (a === "npm" && (b === "install" || b === "i" || b === "add")) return npmArgs(t.slice(2));
  if ((a === "pnpm" || a === "bun") && (b === "add" || b === "install" || b === "i")) return npmArgs(t.slice(2));
  if (a === "yarn" && b === "add") return npmArgs(t.slice(2));
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
    const tokens = tokenize(segment);
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
