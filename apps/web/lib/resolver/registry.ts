import type { Ecosystem } from "@upstream/core";
import { parseGithubRepo, type RepoRef } from "./github";

export interface ResolvedPackage {
  ecosystem: Ecosystem;
  name: string;
  found: boolean;
  description: string | null;
  homepage: string | null;
  repo: RepoRef | null;
  docsHosts: string[];
  fundingUrls: string[];
}

export type HttpGetJson = (url: string) => Promise<{ status: number; body: unknown }>;

export const fetchJson: HttpGetJson = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "upstream-pay (+https://github.com/iamarunbrahma/upstream)" },
    // PyPI JSON for big projects is 1-2 MB; a cold connection from a slow network can take several seconds.
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: res.ok ? await res.json() : null };
};

const NOT_DOCS = new Set(["github.com", "gitlab.com", "pypi.org", "npmjs.com", "npmjs.org"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function docsHostsOf(urls: (string | null)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const h = u ? hostOf(u) : null;
    if (h && !NOT_DOCS.has(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

function fundingList(funding: unknown): string[] {
  const items = Array.isArray(funding) ? funding : [funding];
  return items
    .map((f) => (typeof f === "string" ? f : isObj(f) ? strOrNull(f.url) : null))
    .filter((u): u is string => !!u);
}

export function notFound(ecosystem: Ecosystem, name: string): ResolvedPackage {
  return { ecosystem, name, found: false, description: null, homepage: null, repo: null, docsHosts: [], fundingUrls: [] };
}

async function getOrThrow(http: HttpGetJson, url: string): Promise<unknown | null> {
  const { status, body } = await http(url);
  if (status === 404) return null;
  if (status >= 400) throw new Error(`registry returned ${status} for ${url}`);
  return body;
}

async function resolveNpm(name: string, http: HttpGetJson): Promise<ResolvedPackage> {
  const body = await getOrThrow(http, `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`);
  if (!isObj(body)) return notFound("npm", name);
  const repoField = body.repository;
  const repoUrl = typeof repoField === "string" ? repoField : isObj(repoField) ? strOrNull(repoField.url) : null;
  const homepage = strOrNull(body.homepage);
  return {
    ecosystem: "npm",
    name,
    found: true,
    description: strOrNull(body.description),
    homepage,
    repo: parseGithubRepo(repoUrl) ?? parseGithubRepo(homepage),
    docsHosts: docsHostsOf([homepage]),
    fundingUrls: fundingList(body.funding),
  };
}

async function resolvePypi(name: string, http: HttpGetJson): Promise<ResolvedPackage> {
  const body = await getOrThrow(http, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const info = isObj(body) && isObj(body.info) ? body.info : null;
  if (!info) return notFound("pypi", name);
  const urls = isObj(info.project_urls) ? info.project_urls : {};
  const entries = Object.entries(urls).filter((e): e is [string, string] => typeof e[1] === "string");
  const pick = (re: RegExp) => entries.filter(([k]) => re.test(k)).map(([, v]) => v);
  const homepage = strOrNull(info.home_page) ?? pick(/^home/i)[0] ?? null;
  // A Source or Repository link names the repo; any other GitHub link (a changelog, a Sponsors page) only might.
  const linked = [...pick(/source|repo|code|github/i), ...entries.filter(([k]) => !/fund|sponsor|donat/i.test(k)).map(([, v]) => v)];
  const repo = linked.map((v) => parseGithubRepo(v)).find((r) => r !== null) ?? null;
  return {
    ecosystem: "pypi",
    name,
    found: true,
    description: strOrNull(info.summary),
    homepage,
    repo,
    docsHosts: docsHostsOf([...pick(/doc/i), homepage]),
    fundingUrls: pick(/fund|sponsor|donat/i),
  };
}

/** Registry metadata for one package. 404 -> found:false. Network errors and 5xx reject. */
export async function resolvePackage(ecosystem: Ecosystem, name: string, http: HttpGetJson): Promise<ResolvedPackage> {
  return ecosystem === "npm" ? resolveNpm(name, http) : resolvePypi(name, http);
}
