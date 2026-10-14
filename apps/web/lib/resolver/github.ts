export interface RepoRef {
  owner: string;
  name: string;
}

/** Owner/repo from the many ways registries spell a GitHub URL. Lower-cased. */
export function parseGithubRepo(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const s = url.trim();
  const m =
    s.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    (/^[\w.-]+\/[\w.-]+$/.test(s) ? s.match(/^([\w.-]+)\/([\w.-]+)$/) : null);
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1].toLowerCase(), name: m[2].toLowerCase() };
}
