import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyDisk, normalizePypiName, parsePackageJsonDeps, parsePyprojectNames, parseRequirementNames, type DiskManifests,
} from "@upstream/core";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Dependencies declared in the project's root manifests, plus the project's own package names. */
export function readDiskManifests(cwd: string): DiskManifests {
  const disk = emptyDisk();
  const pkg = readText(join(cwd, "package.json"));
  if (pkg) {
    const parsed = parsePackageJsonDeps(pkg);
    if (parsed) {
      disk.npmDeps = parsed.deps;
      disk.npmDevDeps = parsed.devDeps;
    }
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name;
      if (typeof name === "string") disk.workspaceNames.add(name.toLowerCase());
    } catch {
      // Not valid JSON: no project name to exclude.
    }
  }
  for (const file of ["requirements.txt", "requirements-dev.txt"]) {
    const text = readText(join(cwd, file));
    if (text) for (const n of parseRequirementNames(text)) disk.pypiDeps.add(n);
  }
  const py = readText(join(cwd, "pyproject.toml"));
  if (py) {
    for (const n of parsePyprojectNames(py)) disk.pypiDeps.add(n);
    const m = py.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m?.[1]) disk.workspaceNames.add(normalizePypiName(m[1]));
  }
  return disk;
}
