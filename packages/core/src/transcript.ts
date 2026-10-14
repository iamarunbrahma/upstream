export type ToolEvent =
  | { tool: "Bash"; command: string }
  | { tool: "Write"; filePath: string; content: string }
  | { tool: "Edit"; filePath: string; oldString: string; newString: string }
  | { tool: "WebFetch"; url: string };

export interface ParsedTranscript {
  sessionId: string | null;
  title: string | null;
  events: ToolEvent[];
}

type Json = Record<string, unknown>;

function str(input: Json, key: string): string | null {
  const v = input[key];
  return typeof v === "string" ? v : null;
}

function toEvent(name: unknown, input: Json): ToolEvent | null {
  switch (name) {
    case "Bash": {
      const command = str(input, "command");
      return command ? { tool: "Bash", command } : null;
    }
    case "Write": {
      const filePath = str(input, "file_path");
      const content = str(input, "content");
      return filePath && content !== null ? { tool: "Write", filePath, content } : null;
    }
    case "Edit": {
      const filePath = str(input, "file_path");
      const oldString = str(input, "old_string");
      const newString = str(input, "new_string");
      return filePath && oldString !== null && newString !== null
        ? { tool: "Edit", filePath, oldString, newString }
        : null;
    }
    case "WebFetch": {
      const url = str(input, "url");
      return url ? { tool: "WebFetch", url } : null;
    }
    default:
      return null;
  }
}

/**
 * Reads a Claude Code session transcript. Only tool calls and aiTitle are kept; user prompts are ignored.
 * Tool calls whose result came back as an error (a denied or failed command) are dropped.
 */
export function parseTranscript(jsonl: string): ParsedTranscript {
  let sessionId: string | null = null;
  let title: string | null = null;
  const calls: Array<{ id: unknown; event: ToolEvent }> = [];
  const failed = new Set<unknown>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (sessionId === null && typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") title = entry.aiTitle.slice(0, 200);
    const content = (entry.message as Json | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Json[]) {
      if (entry.type === "user" && block?.type === "tool_result" && block.is_error === true) failed.add(block.tool_use_id);
      if (entry.type !== "assistant" || block?.type !== "tool_use") continue;
      const event = toEvent(block.name, (block.input as Json | undefined) ?? {});
      if (event) calls.push({ id: block.id, event });
    }
  }
  return { sessionId, title, events: calls.filter((c) => !failed.has(c.id)).map((c) => c.event) };
}
