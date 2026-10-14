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

  it("ignores files that aren't manifests", () => {
    expect(manifestAdditions("README.md", '"zod": "^4"', "")).toEqual([]);
  });
});

describe("disk parsers", () => {
  it("parses package.json dependency sections", () => {
    const parsed = parsePackageJsonDeps(JSON.stringify({ dependencies: { Next: "1" }, devDependencies: { vitest: "5" } }));
    expect(parsed).toEqual({ deps: new Set(["next"]), devDeps: new Set(["vitest"]) });
    expect(parsePackageJsonDeps("not json")).toBeNull();
  });

  it("parses requirement and pyproject names", () => {
    expect(parseRequirementNames("Django_Rest.Framework>=3\n")).toEqual(new Set(["django-rest-framework"]));
    expect(parsePyprojectNames('dependencies = ["pydantic"]\n    "uvicorn",\n')).toEqual(new Set(["pydantic", "uvicorn"]));
  });
});
