import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "upstream-config-"));
    process.env.UPSTREAM_CONFIG_DIR = dir;
    delete process.env.UPSTREAM_API_URL;
    delete process.env.UPSTREAM_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it("talks to the hosted Upstream when nothing else is set", () => {
    expect(loadConfig()).toEqual({ apiUrl: "https://upstream-0s2y.onrender.com", token: null });
  });

  it("still lets UPSTREAM_API_URL point at a local server", () => {
    process.env.UPSTREAM_API_URL = "http://localhost:3000";
    expect(loadConfig().apiUrl).toBe("http://localhost:3000");
  });
});
