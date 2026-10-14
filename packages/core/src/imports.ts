import type { Ecosystem } from "./evidence";
import { normalizePypiName, npmNameFromSpec } from "./installs";
import { isNodeBuiltin, isPythonStdlib } from "./stdlib";

export interface ImportHit {
  ecosystem: Ecosystem;
  name: string;
  localNames: string[];
}

export type Language = "js" | "py";

export function languageOf(filePath: string): Language | null {
  if (/\.(m|c)?[jt]sx?$/i.test(filePath) || /\.(vue|svelte|astro)$/i.test(filePath)) return "js";
  if (/\.py$/i.test(filePath)) return "py";
  return null;
}

const JS_FROM = /\b(import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
const JS_SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g;
const JS_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_REQUIRE_ASSIGN = /\b(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const PY_FROM = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;

// Import names that differ from the PyPI distribution name.
const PY_ALIASES: Record<string, string> = {
  yaml: "pyyaml", PIL: "pillow", sklearn: "scikit-learn", cv2: "opencv-python", bs4: "beautifulsoup4",
  dotenv: "python-dotenv", jwt: "pyjwt", dateutil: "python-dateutil", attr: "attrs", Crypto: "pycryptodome",
  OpenSSL: "pyopenssl", magic: "python-magic", serial: "pyserial", multipart: "python-multipart",
  docx: "python-docx", pptx: "python-pptx", fitz: "pymupdf", git: "gitpython", skimage: "scikit-image", jose: "python-jose",
};

function jsPackage(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isNodeBuiltin(specifier)) return null;
  return npmNameFromSpec(specifier);
}

function jsLocals(clause: string): string[] {
  const out: string[] = [];
  const rest = clause.replace(/\btype\s+/g, "").trim();
  const star = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (star) out.push(star[1]!);
  const braces = rest.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1]!.split(",")) {
      const m = part.trim().match(/(?:[\w$]+\s+as\s+|[\w$]+\s*:\s*)?([A-Za-z_$][\w$]*)$/);
      if (m) out.push(m[1]!);
    }
  }
  const def = rest.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").split(",")[0]!.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(def)) out.push(def);
  return out;
}

function pyPackage(module: string): string | null {
  const parts = module.split(".");
  const top = parts[0]!;
  if (!top || isPythonStdlib(top)) return null;
  if (top === "google" && parts.length > 1) {
    const take = parts[1] === "cloud" && parts.length > 2 ? 3 : 2;
    return normalizePypiName(parts.slice(0, take).join("-"));
  }
  return normalizePypiName(PY_ALIASES[top] ?? top);
}

/** Third-party packages imported by `content`, with the local names they're bound to. */
export function findImports(filePath: string, content: string): ImportHit[] {
  const lang = languageOf(filePath);
  if (!lang) return [];
  const hits = new Map<string, ImportHit>();
  const add = (ecosystem: Ecosystem, name: string | null, locals: string[]) => {
    if (!name) return;
    const key = `${ecosystem}:${name}`;
    const hit = hits.get(key) ?? { ecosystem, name, localNames: [] };
    for (const l of locals) if (!hit.localNames.includes(l)) hit.localNames.push(l);
    hits.set(key, hit);
  };
  if (lang === "js") {
    for (const m of content.matchAll(JS_FROM)) add("npm", jsPackage(m[3]!), m[1] === "import" ? jsLocals(m[2]!) : []);
    for (const m of content.matchAll(JS_SIDE_EFFECT)) add("npm", jsPackage(m[1]!), []);
    for (const m of content.matchAll(JS_DYNAMIC)) add("npm", jsPackage(m[1]!), []);
    for (const m of content.matchAll(JS_REQUIRE_ASSIGN)) add("npm", jsPackage(m[2]!), jsLocals(m[1]!));
    for (const m of content.matchAll(JS_REQUIRE)) add("npm", jsPackage(m[1]!), []);
  } else {
    for (const m of content.matchAll(PY_IMPORT)) {
      for (const part of m[1]!.split(",")) {
        const [mod, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
        if (!mod) continue;
        add("pypi", pyPackage(mod), [alias || mod.split(".")[0]!]);
      }
    }
    for (const m of content.matchAll(PY_FROM)) {
      const mod = m[1]!;
      const names = m[2]!.replace(/[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        const [orig, alias] = n.split(/\s+as\s+/).map((s) => s.trim());
        if (!orig || orig === "*") {
          add("pypi", pyPackage(mod), []);
          continue;
        }
        const full = mod === "google" || mod === "google.cloud" ? `${mod}.${orig}` : mod;
        add("pypi", pyPackage(full), [alias || orig]);
      }
    }
  }
  return [...hits.values()];
}

function stripImports(text: string, lang: Language): string {
  if (lang === "js") return text.replace(JS_FROM, "").replace(JS_SIDE_EFFECT, "").replace(JS_REQUIRE_ASSIGN, "");
  return text.replace(PY_FROM, "").replace(PY_IMPORT, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines in `text` (import statements removed) that reference any of `localNames` as an identifier. */
export function countUsageLines(text: string, localNames: string[], lang: Language): number {
  if (localNames.length === 0) return 0;
  const pattern = new RegExp(`(^|[^\\w$.])(${localNames.map(escapeRe).join("|")})(?![\\w$])`);
  return stripImports(text, lang).split("\n").filter((line) => pattern.test(line)).length;
}
