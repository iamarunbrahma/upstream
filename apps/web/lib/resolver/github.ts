export interface RepoRef {
  owner: string;
  name: string;
}

/** First path parts that are GitHub's own pages, never an owner: a Sponsors link is not a repo. */
const NOT_OWNERS = new Set(["sponsors", "orgs", "users", "apps", "marketplace", "features", "topics", "collections", "settings", "enterprise"]);

/** Owner/repo from the many ways registries spell a GitHub URL. Lower-cased. */
export function parseGithubRepo(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const s = url.trim();
  const m =
    s.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    (/^[\w.-]+\/[\w.-]+$/.test(s) ? s.match(/^([\w.-]+)\/([\w.-]+)$/) : null);
  if (!m?.[1] || !m[2] || NOT_OWNERS.has(m[1].toLowerCase())) return null;
  return { owner: m[1].toLowerCase(), name: m[2].toLowerCase() };
}
