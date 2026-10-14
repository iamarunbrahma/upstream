import { describe, expect, it } from "vitest";
import { normalizePypiName, npmNameFromSpec, parseInstallCommands } from "../src/installs";

describe("parseInstallCommands", () => {
  it("handles chained npm and pip installs with flags, extras and -r files", () => {
    expect(
      parseInstallCommands('cd web && npm i -D vitest@5 && pip install "fastapi[standard]>=0.1" -r req.txt'),
    ).toEqual([
      { ecosystem: "npm", name: "vitest", dev: true },
      { ecosystem: "pypi", name: "fastapi", dev: false },
    ]);
  });

  it("handles scoped packages and several names", () => {
    expect(parseInstallCommands("pnpm add @types/node@26 zod")).toEqual([
      { ecosystem: "npm", name: "@types/node", dev: false },
      { ecosystem: "npm", name: "zod", dev: false },
    ]);
  });

  it("ignores bare installs, global installs and echoed text", () => {
    expect(parseInstallCommands("npm install")).toEqual([]);
    expect(parseInstallCommands("npm i -g vercel")).toEqual([]);
    expect(parseInstallCommands('echo "npm install foo"')).toEqual([]);
  });

  it("handles python -m pip, uv and poetry dev groups, skipping local paths", () => {
    expect(parseInstallCommands("python3 -m pip install --upgrade requests==2.32 ./local_pkg")).toEqual([
      { ecosystem: "pypi", name: "requests", dev: false },
    ]);
    expect(parseInstallCommands("uv add --dev pytest")).toEqual([{ ecosystem: "pypi", name: "pytest", dev: true }]);
    expect(parseInstallCommands("poetry add --group dev ruff")).toEqual([{ ecosystem: "pypi", name: "ruff", dev: true }]);
  });

  it("recognises pip, python and npm called by path, as in a virtualenv", () => {
    expect(parseInstallCommands("python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn")).toEqual([
      { ecosystem: "pypi", name: "fastapi", dev: false },
      { ecosystem: "pypi", name: "uvicorn", dev: false },
    ]);
    expect(parseInstallCommands("/usr/local/bin/python3.12 -m pip install httpx")).toEqual([{ ecosystem: "pypi", name: "httpx", dev: false }]);
    expect(parseInstallCommands("./node_modules/.bin/pnpm add zod")).toEqual([{ ecosystem: "npm", name: "zod", dev: false }]);
  });

  it("strips sudo and env assignments and dedupes", () => {
    expect(parseInstallCommands("sudo CI=1 yarn add react react-dom react")).toEqual([
      { ecosystem: "npm", name: "react", dev: false },
      { ecosystem: "npm", name: "react-dom", dev: false },
    ]);
  });
});

describe("name helpers", () => {
  it("normalises PyPI names per PEP 503", () => {
    expect(normalizePypiName("Django_Rest.Framework")).toBe("django-rest-framework");
  });

  it("extracts npm names and rejects paths and URLs", () => {
    expect(npmNameFromSpec("@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(npmNameFromSpec("lodash@^4")).toBe("lodash");
    expect(npmNameFromSpec("./local")).toBeNull();
    expect(npmNameFromSpec("git+https://github.com/a/b.git")).toBeNull();
  });
});
