import { describe, expect, it } from "vitest";
import { parseGithubRepo } from "../lib/resolver/github";

describe("parseGithubRepo", () => {
  it.each([
    ["git+https://github.com/colinhacks/zod.git", { owner: "colinhacks", name: "zod" }],
    ["https://github.com/fastapi/fastapi", { owner: "fastapi", name: "fastapi" }],
    ["git@github.com:Owner/Repo.git", { owner: "owner", name: "repo" }],
    ["https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node", { owner: "definitelytyped", name: "definitelytyped" }],
    ["github:sindresorhus/chalk", { owner: "sindresorhus", name: "chalk" }],
    ["vercel/next.js", { owner: "vercel", name: "next.js" }],
  ])("parses %s", (url, expected) => {
    expect(parseGithubRepo(url)).toEqual(expected);
  });

  it("rejects non-GitHub and empty values", () => {
    expect(parseGithubRepo("https://gitlab.com/a/b")).toBeNull();
    expect(parseGithubRepo("")).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
  });
});
