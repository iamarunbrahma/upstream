import { describe, expect, it } from "vitest";
import { manifestAdditions, parsePackageJsonDeps, parsePyprojectNames, parseRequirementNames } from "../src/manifests";

describe("manifestAdditions", () => {
  it("reads a whole package.json write and marks devDependencies", () => {
    const added = JSON.stringify({ name: "app", dependencies: { next: "16.4.0" }, devDependencies: { vitest: "5.0.4" } });
    expect(manifestAdditions("/r/package.json", added, "")).toEqual([
      { ecosystem: "npm", name: "next", dev: false },
      { ecosystem: "npm", name: "vitest", dev: true },
    ]);
  });

  it("reads package.json fragment edits as unknown-kind candidates", () => {
    expect(manifestAdditions("/r/package.json", '    "zod": "^4.6.7",\n    "version": "1.0.0"', '    "version": "1.0.0"')).toEqual([
      { ecosystem: "npm", name: "zod", dev: null },
    ]);
  });

  it("reads requirements files, skipping comments, flags and lines already present", () => {
    expect(manifestAdditions("requirements-dev.txt", "pytest==8\n# comment\n-r base.txt\nruff\n", "ruff\n")).toEqual([
      { ecosystem: "pypi", name: "pytest", dev: true },
    ]);
  });

  it("reads PEP 621 and Poetry dependency lines from pyproject.toml", () => {
    const added = [
      "dependencies = [",
      '    "fastapi[standard]>=0.115",',
      '    "httpx",',
      "]",
      "[tool.poetry.dependencies]",
      'python = "^3.11"',
      'requests = "^2.32"',
    ].join("\n");
    expect(manifestAdditions("pyproject.toml", added, "").map((a) => a.name)).toEqual(["fastapi", "httpx", "requests"]);
  });

  it("leaves workspace, file, link, git and path dependencies out", () => {
    const added = JSON.stringify({
      dependencies: { "@repo/ui": "workspace:*", local: "file:../local", linked: "link:../x", gitdep: "git+https://github.com/a/b.git", gh: "a/b", zod: "^4" },
    });
    expect(manifestAdditions("/r/package.json", added, "").map((a) => a.name)).toEqual(["zod"]);
    expect(manifestAdditions("/r/package.json", '"@repo/ui": "workspace:*",\n"zod": "^4"', "").map((a) => a.name)).toEqual(["zod"]);
    expect([...parsePyprojectNames('[tool.poetry.dependencies]\nmylib = { path = "../mylib", develop = true }\nrequests = "^2"\n')]).toEqual(["requests"]);
    expect([...parsePyprojectNames('dependencies = ["mypkg @ file:///home/me/mypkg", "httpx"]\n')]).toEqual(["httpx"]);
    expect([...parseRequirementNames("mypkg @ file:///home/me/mypkg\n-e ./local\nhttpx\n")]).toEqual(["httpx"]);
  });

  it("reports local dependency names so they can be excluded", () => {
    const parsed = parsePackageJsonDeps(JSON.stringify({ dependencies: { "@repo/ui": "workspace:*", zod: "^4" }, devDependencies: { tools: "file:./tools" } }));
    expect(parsed).toEqual({ deps: new Set(["zod"]), devDeps: new Set(), local: new Set(["@repo/ui", "tools"]) });
  });

  it("ignores files that aren't manifests", () => {
    expect(manifestAdditions("README.md", '"zod": "^4"', "")).toEqual([]);
  });
});

describe("disk parsers", () => {
  it("parses package.json dependency sections", () => {
    const parsed = parsePackageJsonDeps(JSON.stringify({ dependencies: { Next: "1" }, devDependencies: { vitest: "5" } }));
    expect(parsed).toEqual({ deps: new Set(["next"]), devDeps: new Set(["vitest"]), local: new Set() });
    expect(parsePackageJsonDeps("not json")).toBeNull();
  });

  it("parses requirement and pyproject names", () => {
    expect(parseRequirementNames("Django_Rest.Framework>=3\n")).toEqual(new Set(["django-rest-framework"]));
    expect(parsePyprojectNames('dependencies = ["pydantic"]\n    "uvicorn",\n')).toEqual(new Set(["pydantic", "uvicorn"]));
  });
});
