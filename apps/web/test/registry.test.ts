import { describe, expect, it } from "vitest";
import { resolvePackage, type HttpGetJson } from "../lib/resolver/registry";

const fake = (routes: Record<string, { status: number; body: unknown }>): HttpGetJson =>
  async (url) => routes[url] ?? { status: 404, body: null };

describe("resolvePackage (npm)", () => {
  it("reads description, homepage, repo, docs host and funding", async () => {
    const http = fake({
      "https://registry.npmjs.org/zod/latest": {
        status: 200,
        body: {
          name: "zod",
          description: "TypeScript-first schema validation",
          homepage: "https://zod.dev",
          repository: { type: "git", url: "git+https://github.com/colinhacks/zod.git" },
          funding: "https://github.com/sponsors/colinhacks",
        },
      },
    });
    expect(await resolvePackage("npm", "zod", http)).toEqual({
      ecosystem: "npm",
      name: "zod",
      found: true,
      description: "TypeScript-first schema validation",
      homepage: "https://zod.dev",
      repo: { owner: "colinhacks", name: "zod" },
      docsHosts: ["zod.dev"],
      fundingUrls: ["https://github.com/sponsors/colinhacks"],
    });
  });

  it("encodes scoped names and accepts string repository and array funding", async () => {
    const http = fake({
      "https://registry.npmjs.org/@scope%2Fpkg/latest": {
        status: 200,
        body: { repository: "github:scope/pkg", funding: [{ url: "https://opencollective.com/pkg" }, "https://github.com/sponsors/a"] },
      },
    });
    const pkg = await resolvePackage("npm", "@scope/pkg", http);
    expect(pkg.repo).toEqual({ owner: "scope", name: "pkg" });
    expect(pkg.fundingUrls).toEqual(["https://opencollective.com/pkg", "https://github.com/sponsors/a"]);
    expect(pkg.docsHosts).toEqual([]);
  });
});

describe("resolvePackage (PyPI)", () => {
  it("reads project_urls for repo, docs and funding", async () => {
    const http = fake({
      "https://pypi.org/pypi/fastapi/json": {
        status: 200,
        body: {
          info: {
            summary: "FastAPI framework, high performance",
            home_page: null,
            project_urls: {
              Documentation: "https://fastapi.tiangolo.com/",
              Homepage: "https://github.com/fastapi/fastapi",
              Repository: "https://github.com/fastapi/fastapi",
              Funding: "https://github.com/sponsors/tiangolo",
            },
          },
        },
      },
    });
    expect(await resolvePackage("pypi", "fastapi", http)).toEqual({
      ecosystem: "pypi",
      name: "fastapi",
      found: true,
      description: "FastAPI framework, high performance",
      homepage: "https://github.com/fastapi/fastapi",
      repo: { owner: "fastapi", name: "fastapi" },
      docsHosts: ["fastapi.tiangolo.com"],
      fundingUrls: ["https://github.com/sponsors/tiangolo"],
    });
  });
});

describe("resolvePackage failures", () => {
  it("returns found:false for a package no registry knows", async () => {
    const pkg = await resolvePackage("npm", "no-such-pkg-xyz", fake({}));
    expect(pkg).toEqual({
      ecosystem: "npm", name: "no-such-pkg-xyz", found: false, description: null, homepage: null, repo: null, docsHosts: [], fundingUrls: [],
    });
  });

  it("rejects on server errors so the caller won't cache them", async () => {
    const http: HttpGetJson = async () => ({ status: 503, body: null });
    await expect(resolvePackage("pypi", "requests", http)).rejects.toThrow("503");
  });

  it("treats a malformed body as not found", async () => {
    const http = fake({ "https://registry.npmjs.org/weird/latest": { status: 200, body: "not an object" } });
    expect((await resolvePackage("npm", "weird", http)).found).toBe(false);
  });
});
