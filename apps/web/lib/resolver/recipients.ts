import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { recipientCache, type RepoRecipients } from "../db/schema";
import { splitCents } from "../funding/split";
import type { RepoRef } from "./github";

export type GithubGet = (path: string) => Promise<{ status: number; body: unknown }>;

const DAY = 24 * 60 * 60 * 1000;
export const RECIPIENT_TTL_MS = 7 * DAY;
const COMMIT_WINDOW_MS = 90 * DAY;
const MAX_COMMITTERS = 5;
const LOGIN = /^[a-z\d][a-z\d-]{0,38}$/;

/** GitHub's REST API. The token is optional; without one GitHub allows 60 requests an hour. */
export function createGithubGet(token: string | undefined, fetchImpl: typeof fetch = fetch): GithubGet {
  return async (path) => {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "upstream-pay (+https://github.com/iamarunbrahma/upstream)",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // A dropped connection or a timeout is GitHub being unavailable: try later, like a 5xx.
      return { status: 503, body: null };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

/** The GitHub accounts a FUNDING.yml names: `github: alice`, `github: [alice, bob]`, or a `- alice` list. Lower-cased. */
export function fundingGithubLogins(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^github\s*:/.test(l));
  if (at < 0) return [];
  const value = lines[at]!.replace(/^github\s*:/, "").replace(/#.*$/, "").trim();
  let names: string[] = [];
  if (value.startsWith("[")) names = value.replace(/^\[|\]$/g, "").split(",");
  else if (value) names = [value];
  else {
    for (const line of lines.slice(at + 1)) {
      const m = line.match(/^\s+-\s*([^#]+?)\s*(?:#.*)?$/);
      if (!m) break;
      names.push(m[1]!);
    }
  }
  const clean = names.map((n) => n.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter((n) => LOGIN.test(n));
  return [...new Set(clean)];
}

class TryLater extends Error {}

/** Rate limits and GitHub outages mean "try later"; a refused token is a setup mistake that must not stay quiet. */
function usable(r: { status: number; body: unknown }) {
  if (r.status === 401) throw new Error("GitHub refused the GitHub token (GITHUB_TOKEN). Replace it, or remove it to use GitHub without one.");
  if (r.status === 403 || r.status === 429 || r.status >= 500) throw new TryLater();
  return r;
}

function fileText(body: unknown): string {
  const b = body as { encoding?: string; content?: string } | null;
  return b?.encoding === "base64" && typeof b.content === "string" ? Buffer.from(b.content, "base64").toString("utf8") : "";
}

async function topCommitters(base: string, gh: GithubGet, now: Date): Promise<Array<{ login: string; githubId: number | null; commits: number }>> {
  const since = new Date(now.getTime() - COMMIT_WINDOW_MS).toISOString();
  const r = usable(await gh(`${base}/commits?since=${encodeURIComponent(since)}&per_page=100`));
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  const counts = new Map<string, number>();
  const ids = new Map<string, number>();
  for (const c of r.body as Array<{ author?: { login?: string; type?: string; id?: number } | null }>) {
    const login = c.author?.login?.toLowerCase();
    if (!login || c.author?.type !== "User" || login.endsWith("[bot]")) continue;
    counts.set(login, (counts.get(login) ?? 0) + 1);
    if (typeof c.author?.id === "number") ids.set(login, c.author.id);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMMITTERS)
    .map(([login, commits]) => ({ login, githubId: ids.get(login) ?? null, commits }));
}

/**
 * Who gets a repo's share (spec section 6): the people its FUNDING.yml names, in equal shares, with an
 * organisation's share going to the repo's top 5 human committers of the last 90 days by commit count.
 * Without a usable FUNDING.yml, those committers get it all. "later" means GitHub is rate-limiting or failing.
 */
export async function resolveRecipients(repo: RepoRef, gh: GithubGet, now: Date): Promise<RepoRecipients | "later"> {
  try {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const funding = usable(await gh(`${base}/contents/.github/FUNDING.yml`));
    const named = funding.status === 200 ? fundingGithubLogins(fileText(funding.body)) : [];
    const people: string[] = [];
    const ids = new Map<string, number>();
    let orgShares = 0;
    for (const login of named) {
      const account = usable(await gh(`/users/${encodeURIComponent(login)}`));
      if (account.status !== 200) continue; // renamed or deleted
      const body = account.body as { type?: string; id?: number } | null;
      if (body?.type === "Organization") orgShares += 1;
      else {
        people.push(login);
        if (typeof body?.id === "number") ids.set(login, body.id);
      }
    }
    const fromFunding = people.length + orgShares > 0;
    const committers = !fromFunding || orgShares > 0 ? await topCommitters(base, gh, now) : [];
    for (const c of committers) if (c.githubId !== null && !ids.has(c.login)) ids.set(c.login, c.githubId);
    const commitTotal = committers.reduce((sum, c) => sum + c.commits, 0);

    // Everything on one integer scale: a named person weighs as much as one organisation's whole share.
    const weights = new Map<string, number>();
    const add = (login: string, w: number) => weights.set(login, (weights.get(login) ?? 0) + w);
    if (fromFunding) {
      for (const p of people) add(p, Math.max(commitTotal, 1));
      for (const c of committers) add(c.login, c.commits * orgShares);
    } else {
      for (const c of committers) add(c.login, c.commits);
    }
    const logins = [...weights.keys()];
    const shares = splitCents(10_000, logins.map((l) => weights.get(l)!));
    const recipients = logins.map((login, i) => ({ login, githubId: ids.get(login) ?? null, shareBp: shares[i]! })).filter((r) => r.shareBp > 0);
    if (recipients.length === 0) return { source: "none", recipients: [] };
    return { source: fromFunding ? "funding" : "committers", recipients };
  } catch (e) {
    if (e instanceof TryLater) return "later";
    throw e;
  }
}

/**
 * resolveRecipients, remembered for 7 days per repo. While GitHub says "later", an older answer is better than
 * none, unless it predates GitHub ids: money can't be filed safely without them.
 */
export async function recipientsFor(db: Db, gh: GithubGet, repo: RepoRef, now: Date): Promise<RepoRecipients | "later"> {
  const key = `${repo.owner}/${repo.name}`;
  const [hit] = await db.select().from(recipientCache).where(eq(recipientCache.repo, key)).limit(1);
  // An answer saved before GitHub ids were kept is looked up again, so new money is filed by GitHub account.
  const withIds = hit?.data.recipients.every((r) => typeof r.githubId === "number") ?? false;
  if (hit && withIds && now.getTime() - hit.fetchedAt.getTime() < RECIPIENT_TTL_MS) return hit.data;
  const fresh = await resolveRecipients(repo, gh, now);
  if (fresh === "later") return hit && withIds ? hit.data : "later";
  await db
    .insert(recipientCache)
    .values({ repo: key, data: fresh, fetchedAt: now })
    .onConflictDoUpdate({ target: recipientCache.repo, set: { data: fresh, fetchedAt: now } });
  return fresh;
}
