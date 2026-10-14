import { describe, expect, it } from "vitest";
import { createPgliteDb } from "../lib/db/client";
import { migrateDb } from "../lib/db/migrate";
import { fundingGithubLogins, recipientsFor, resolveRecipients, type GithubGet } from "../lib/resolver/recipients";

const NOW = new Date("2026-10-14T10:00:00Z");
const DAY = 86_400_000;
const repo = { owner: "acme", name: "widget" };
const base = "/repos/acme/widget";

const fundingFile = (text: string) => ({ status: 200, body: { encoding: "base64", content: Buffer.from(text).toString("base64") } });
const commit = (login: string, type = "User") => ({ author: { login, type } });
const commits = (...entries: Array<[string, number, string?]>) => ({
  status: 200,
  body: entries.flatMap(([login, n, type]) => Array.from({ length: n }, () => commit(login, type))),
});

/** A fake GitHub API: exact paths, or a path prefix ending in "*". Anything else is a 404. */
function github(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const get: GithubGet = async (path) => {
    calls.push(path);
    const hit = routes[path] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && path.startsWith(k.slice(0, -1)))?.[1];
    return hit ?? { status: 404, body: { message: "Not Found" } };
  };
  return { get, calls };
}

describe("fundingGithubLogins", () => {
  it("reads every way a FUNDING.yml names GitHub accounts", () => {
    expect(fundingGithubLogins("github: samuelcolvin\n")).toEqual(["samuelcolvin"]);
    expect(fundingGithubLogins("github: [vitest-dev]\nopen_collective: vitest\n")).toEqual(["vitest-dev"]);
    expect(fundingGithubLogins("github: [Alice, 'bob' , \"carol\"]")).toEqual(["alice", "bob", "carol"]);
    expect(fundingGithubLogins("ko_fi: x\ngithub:\n  - alice\n  - Bob # lead\npatreon: y\n")).toEqual(["alice", "bob"]);
    expect(fundingGithubLogins("# These are supported funding model platforms\n\ngithub: drizzle-team\npatreon: # Replace with a single Patreon username\n")).toEqual(["drizzle-team"]);
  });

  it("ignores the template's placeholder and anything that isn't a GitHub login", () => {
    expect(fundingGithubLogins("github: # Replace with up to 4 GitHub Sponsors-enabled usernames\n")).toEqual([]);
    expect(fundingGithubLogins("github: [ok-name, bad name, -dash, https://evil.example]")).toEqual(["ok-name"]);
    expect(fundingGithubLogins("open_collective: x\n")).toEqual([]);
  });
});

describe("resolveRecipients", () => {
  it("pays the people a FUNDING.yml names, in equal shares", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: [alice, bob]\n"),
      "/users/alice": { status: 200, body: { type: "User" } },
      "/users/bob": { status: 200, body: { type: "User" } },
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({
      source: "funding",
      recipients: [
        { login: "alice", shareBp: 5000 },
        { login: "bob", shareBp: 5000 },
      ],
    });
    expect(gh.calls.some((c) => c.includes("/commits"))).toBe(false);
  });

  it("gives an organisation's share to the repo's recent human committers, by commit count", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: [carol, acme]\n"),
      "/users/carol": { status: 200, body: { type: "User" } },
      "/users/acme": { status: 200, body: { type: "Organization" } },
      [`${base}/commits*`]: commits(["alice", 3], ["bob", 1], ["dependabot[bot]", 5, "Bot"], ["renovate-bot", 4, "Bot"]),
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({
      source: "funding",
      recipients: [
        { login: "carol", shareBp: 5000 },
        { login: "alice", shareBp: 3750 },
        { login: "bob", shareBp: 1250 },
      ],
    });
    expect(gh.calls).toContain(`${base}/commits?since=${encodeURIComponent(new Date(NOW.getTime() - 90 * DAY).toISOString())}&per_page=100`);
  });

  it("without a FUNDING.yml, pays the top 5 committers of the last 90 days", async () => {
    const gh = github({ [`${base}/commits*`]: commits(["a", 6], ["b", 5], ["c", 4], ["d", 3], ["e", 2], ["f", 1]) });
    const r = await resolveRecipients(repo, gh.get, NOW);
    expect(r).not.toBe("later");
    if (r === "later") return;
    expect(r.source).toBe("committers");
    expect(r.recipients.map((x) => x.login)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.recipients.reduce((s, x) => s + x.shareBp, 0)).toBe(10_000);
  });

  it("falls back to committers when every FUNDING.yml account is gone", async () => {
    const gh = github({
      [`${base}/contents/.github/FUNDING.yml`]: fundingFile("github: ghost\n"),
      [`${base}/commits*`]: commits(["alice", 1]),
    });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
  });

  it("finds nobody for a repo with no FUNDING.yml and no human commits", async () => {
    const gh = github({ [`${base}/commits*`]: commits(["renovate[bot]", 3, "Bot"]) });
    expect(await resolveRecipients(repo, gh.get, NOW)).toEqual({ source: "none", recipients: [] });
  });

  it("asks to try later when GitHub is rate-limiting or failing, and refuses a bad token loudly", async () => {
    expect(await resolveRecipients(repo, github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 403, body: {} } }).get, NOW)).toBe("later");
    expect(await resolveRecipients(repo, github({ [`${base}/commits*`]: { status: 502, body: {} } }).get, NOW)).toBe("later");
    await expect(resolveRecipients(repo, github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 401, body: {} } }).get, NOW)).rejects.toThrow(/GitHub token/);
  });
});

describe("recipientsFor", () => {
  it("remembers a repo's recipients for 7 days, and uses the old answer while GitHub says try later", async () => {
    const db = createPgliteDb();
    await migrateDb(db, "pglite");
    const gh = github({ [`${base}/commits*`]: commits(["alice", 1]) });
    const first = await recipientsFor(db, gh.get, repo, NOW);
    expect(first).toEqual({ source: "committers", recipients: [{ login: "alice", shareBp: 10_000 }] });
    const calls = gh.calls.length;
    expect(await recipientsFor(db, gh.get, repo, new Date(NOW.getTime() + 6 * DAY))).toEqual(first);
    expect(gh.calls.length).toBe(calls);

    const limited = github({ [`${base}/contents/.github/FUNDING.yml`]: { status: 403, body: {} } });
    expect(await recipientsFor(db, limited.get, repo, new Date(NOW.getTime() + 8 * DAY))).toEqual(first);
    const fresh = createPgliteDb();
    await migrateDb(fresh, "pglite");
    expect(await recipientsFor(fresh, limited.get, repo, NOW)).toBe("later");
  });
});
