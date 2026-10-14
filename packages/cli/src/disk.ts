import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
      for (const name of parsed.local) disk.workspaceNames.add(name); // workspace siblings and local paths are first-party
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

const MAX_MANIFEST_DIRS = 64;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Manifests in `root` and in every folder between `root` and each changed file, merged. Monorepos and
 * frontend/backend layouts keep their dependencies next to the code, not at the root.
 */
export function readDiskManifestsFor(root: string, filePaths: string[]): DiskManifests {
  const top = real(root);
  const dirs = new Set<string>([top]);
  for (const file of filePaths) {
    let dir = real(dirname(resolve(top, file)));
    while (dir.startsWith(top + sep) && !dirs.has(dir) && dirs.size < MAX_MANIFEST_DIRS) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const merged = emptyDisk();
  for (const dir of dirs) {
    const d = readDiskManifests(dir);
    for (const key of ["npmDeps", "npmDevDeps", "pypiDeps", "workspaceNames"] as const) for (const n of d[key]) merged[key].add(n);
  }
  return merged;
}
