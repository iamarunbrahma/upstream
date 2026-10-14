import { hostname } from "node:os";
import type { ReceiptPayload } from "@upstream/core";
import { createApi, type Api } from "./api";
import { evidenceFromGitDiff, evidenceFromTranscript } from "./collect";
import { loadConfig, saveConfig } from "./config";
import { formatReceipt } from "./format";

export interface CommandDeps {
  api: Api;
  out: (message: string) => void;
  log: (message: string) => void;
  readFile: (path: string) => string;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function submitOrPrint(payload: ReceiptPayload, opts: { dryRun: boolean; quiet: boolean }, deps: CommandDeps): Promise<number> {
  if (opts.dryRun) {
    deps.out(JSON.stringify(payload, null, 2));
    return 0;
  }
  const { receipt } = await deps.api.submit(payload);
  if (!opts.quiet) deps.out(formatReceipt(receipt));
  return 0;
}

/** In quiet mode (the background hook run) failures are logged and exit 0. */
function fail(e: unknown, quiet: boolean, deps: CommandDeps): number {
  if (quiet) {
    deps.log(`receipt: ${reason(e)}`);
    return 0;
  }
  deps.out(`Upstream: ${reason(e)}`);
  return 1;
}

export async function receiptCommand(
  opts: { transcript: string; cwd: string; dryRun: boolean; quiet: boolean },
  deps: CommandDeps,
): Promise<number> {
  try {
    const payload = evidenceFromTranscript(opts.transcript, deps.readFile(opts.transcript), opts.cwd);
    return await submitOrPrint(payload, opts, deps);
  } catch (e) {
    return fail(e, opts.quiet, deps);
  }
}

export async function scanCommand(opts: { diff: string; cwd: string; dryRun: boolean }, deps: CommandDeps): Promise<number> {
  try {
    return await submitOrPrint(evidenceFromGitDiff(opts.diff, opts.cwd), { dryRun: opts.dryRun, quiet: false }, deps);
  } catch (e) {
    return fail(e, false, deps);
  }
}

export async function initCommand(opts: { apiUrl?: string; label?: string }, out: (m: string) => void, pluginDir: string): Promise<number> {
  const apiUrl = opts.apiUrl ?? loadConfig().apiUrl;
  try {
    const { token } = await createApi(apiUrl, null).registerDevice(opts.label ?? hostname());
    saveConfig({ apiUrl, token });
    out(
      [
        "Linked this machine to Upstream.",
        "",
        "Start Claude Code with the plugin turned on:",
        `  claude --plugin-dir ${pluginDir}`,
        "",
        "When a session ends, Upstream sends a receipt. Run /upstream:receipt any time to see it.",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    out(`Upstream couldn't reach ${apiUrl}: ${reason(e)}`);
    return 1;
  }
}
