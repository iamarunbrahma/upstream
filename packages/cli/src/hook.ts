import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

export type Launch = (args: string[]) => void;
export type Log = (message: string) => void;

/**
 * Claude Code SessionEnd hook. Hands the work to a detached background process and returns at once,
 * so a slow or unreachable server never delays the end of the session. Never throws.
 */
export async function runSessionEndHook(stdin: string, launch: Launch, log: Log): Promise<void> {
  try {
    const input = JSON.parse(stdin) as { transcript_path?: unknown; cwd?: unknown };
    if (typeof input.transcript_path !== "string") {
      log("session-end: hook input had no transcript_path");
      return;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    launch(["receipt", "--transcript", input.transcript_path, "--cwd", cwd, "--quiet"]);
  } catch (e) {
    log(`session-end: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function detachedLauncher(scriptPath: string): Launch {
  return (args) => {
    spawn(process.execPath, [scriptPath, ...args], { detached: true, stdio: "ignore" }).unref();
  };
}

export function fileLogger(): Log {
  return (message) => {
    try {
      mkdirSync(configDir(), { recursive: true });
      appendFileSync(join(configDir(), "hook.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never break the developer's session.
    }
  };
}
