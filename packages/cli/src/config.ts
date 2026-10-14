import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  apiUrl: string;
  token: string | null;
}

/** Local dev server until Plan 3 deploys the hosted one; then this becomes the Render URL. */
export const DEFAULT_API_URL = "http://localhost:3000";

export function configDir(): string {
  return process.env.UPSTREAM_CONFIG_DIR ?? join(homedir(), ".config", "upstream");
}

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8")) as Partial<Config>;
  } catch {
    // No config yet: fall through to env and defaults.
  }
  return {
    apiUrl: process.env.UPSTREAM_API_URL ?? file.apiUrl ?? DEFAULT_API_URL,
    token: process.env.UPSTREAM_TOKEN ?? file.token ?? null,
  };
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
