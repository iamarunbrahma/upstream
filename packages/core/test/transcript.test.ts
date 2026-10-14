import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/transcript";

const jsonl = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

describe("parseTranscript", () => {
  it("reads session id, last aiTitle and tool events, skipping bad lines", () => {
    const t = parseTranscript(jsonl);
    expect(t.sessionId).toBe("sess-1");
    expect(t.title).toBe("Build a todo API with FastAPI");
    expect(t.events.map((e) => e.tool)).toEqual(["Bash", "Write", "Edit", "WebFetch"]);
  });

  it("never carries user prompt text", () => {
    const t = parseTranscript(jsonl);
    expect(JSON.stringify(t)).not.toContain("secret prompt text");
  });

  it("maps Edit and WebFetch inputs", () => {
    const t = parseTranscript(jsonl);
    expect(t.events[2]).toEqual({
      tool: "Edit",
      filePath: "/repo/api/main.py",
      oldString: "app = FastAPI()",
      newString: "app = FastAPI()\n\nclass Todo(BaseModel):\n    title: str",
    });
    expect(t.events[3]).toEqual({ tool: "WebFetch", url: "https://fastapi.tiangolo.com/tutorial/body/" });
  });

  it("returns empty results for an empty transcript", () => {
    expect(parseTranscript("")).toEqual({ sessionId: null, title: null, events: [] });
  });
});
