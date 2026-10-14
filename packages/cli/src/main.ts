import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createApi } from "./api";
import { dashboardCommand, initCommand, receiptCommand, scanCommand, type CommandDeps } from "./commands";
import { loadConfig } from "./config";
import { detachedLauncher, fileLogger, runSessionEndHook } from "./hook";
import { serveMcp } from "./mcp";
import { latestTranscript, readSessionTranscript } from "./transcripts";

const scriptPath = fileURLToPath(import.meta.url);
const pluginDir = resolve(dirname(scriptPath), "..");

/** Reads stdin with a time limit, and closes it so the process can exit. */
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolveText) => {
    if (process.stdin.isTTY) return resolveText("");
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolveText(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function commandDeps(): CommandDeps {
  const config = loadConfig();
  return {
    api: createApi(config.apiUrl, config.token),
    out: (m) => console.log(m),
    log: fileLogger(),
    readFile: readSessionTranscript,
  };
}

const program = new Command()
  .name("upstream")
  .description("Your AI coding agent pays back the open source it builds with.")
  .version("0.2.0");

program
  .command("init")
  .description("Link this machine to Upstream")
  .option("--api-url <url>", "Upstream server address")
  .option("--label <label>", "a name for this machine")
  .action(async (o: { apiUrl?: string; label?: string }) => {
    process.exitCode = await initCommand(o, (m) => console.log(m), pluginDir);
  });

program
  .command("receipt")
  .description("Build and send the receipt for a Claude Code session transcript")
  .requiredOption("--transcript <path>", "path to the session .jsonl file")
  .option("--cwd <dir>", "project folder", process.cwd())
  .option("--dry-run", "print exactly what would be sent, and send nothing", false)
  .option("--quiet", "log problems to hook.log instead of failing", false)
  .action(async (o: { transcript: string; cwd: string; dryRun: boolean; quiet: boolean }) => {
    process.exitCode = await receiptCommand(o, commandDeps());
  });

program
  .command("scan")
  .description("Build and send a receipt from a git range (works with any coding agent)")
  .requiredOption("--diff <range>", "git range, for example HEAD~3..HEAD")
  .option("--cwd <dir>", "repository folder", process.cwd())
  .option("--dry-run", "print exactly what would be sent, and send nothing", false)
  .action(async (o: { diff: string; cwd: string; dryRun: boolean }) => {
    process.exitCode = await scanCommand(o, commandDeps());
  });

program
  .command("hook")
  .argument("<event>", "hook event, e.g. session-end")
  .description("Entry point for Claude Code hooks")
  .action(async (event: string) => {
    if (event === "session-end") await runSessionEndHook(await readStdin(1000), detachedLauncher(scriptPath), fileLogger());
    process.exit(0);
  });

program
  .command("mcp")
  .description("Run the MCP server that Claude Code talks to")
  .action(async () => {
    const config = loadConfig();
    await serveMcp({
      api: createApi(config.apiUrl, config.token),
      cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      readFile: readSessionTranscript,
      findTranscript: (cwd) => latestTranscript(cwd),
    });
  });

program
  .command("dashboard")
  .description("Open your Upstream dashboard in the browser (budget, subscription, receipts)")
  .action(async () => {
    const config = loadConfig();
    process.exitCode = await dashboardCommand({
      api: createApi(config.apiUrl, config.token),
      out: (m) => console.log(m),
      openUrl: (url) => {
        try {
          spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        } catch {
          // Opening a browser is a convenience; the link is already printed.
        }
      },
    });
  });

await program.parseAsync(process.argv);
