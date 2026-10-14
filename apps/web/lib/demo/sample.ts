import { buildEvidence, changesFromEvents, emptyDisk, parseTranscript, type ReceiptPayload } from "@upstream/core";
import sample from "./sample-session.json" with { type: "json" };

/**
 * A real Claude Code session, recorded for the demo: its transcript entries as Claude Code wrote them, with the
 * project folder's path anonymised. docs/demo-sample-session.md says how it was recorded.
 */
interface SampleFile {
  recordedAt: string;
  entries: unknown[];
}

/**
 * The receipt the upstream CLI would send for the recorded session, built the same way on the server. The project
 * folder isn't here, so its manifests are only what the transcript shows the agent installing and writing.
 */
export function samplePayload(now: Date = new Date()): ReceiptPayload {
  const transcript = parseTranscript((sample as SampleFile).entries.map((e) => JSON.stringify(e)).join("\n"));
  const { changes, installs, docsUrls } = changesFromEvents(transcript.events);
  const built = buildEvidence({ changes, installs, docsUrls, disk: emptyDisk() });
  return {
    sessionId: `sample:${transcript.sessionId}`,
    agent: "claude-code",
    title: transcript.title,
    endedAt: now.toISOString(),
    packages: built.packages,
  };
}
