/** The running turn as the room shows it: compaction lines, and which tools of a burst are still running. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { T3ThreadDetail, T3TurnItem } from "../src/adapter/types.ts";
import { liveFeed } from "../src/app/threadView.ts";

const RUN = "run-1";
const AT = "2026-10-03T00:00:01.000Z";
let ordinal = 0;
const item = (fields: Record<string, unknown>): T3TurnItem =>
  ({ id: `item-${++ordinal}`, runId: RUN, nodeId: null, providerTurnId: null, ordinal, status: "completed", title: null, startedAt: AT, completedAt: AT, updatedAt: AT, ...fields }) as T3TurnItem;
const detail = (turnItems: T3TurnItem[], runStatus = "running"): T3ThreadDetail => ({ runs: [{ id: RUN, status: runStatus }], turnItems }) as unknown as T3ThreadDetail;
const userMessage = (text: string) => item({ type: "user_message", messageId: "m", text, attachments: [], inputIntent: "turn_start" });
const command = (status: string) => item({ type: "command_execution", status, title: "Command", input: "ls", output: null, exitCode: null, outputIndicatesFailure: false });

test("a /compact run reads as compacting until T3 records the compaction", () => {
  const feed = liveFeed(detail([userMessage(" /Compact ")]), RUN);
  assert.equal(feed.length, 1);
  assert.deepEqual({ kind: feed[0]!.kind, text: (feed[0] as { text: string }).text, active: (feed[0] as { active: boolean }).active }, { kind: "notice", text: "Compacting context…", active: true });

  assert.deepEqual(liveFeed(detail([userMessage("/compact")], "completed"), RUN), [], "a run that ended without a compaction is not compacting");
  assert.deepEqual(liveFeed(detail([userMessage("/compact keep the plan")]), RUN), [], "only the bare command, as in T3");
});

test("a compaction is one line: running, then what it saved", () => {
  const running = liveFeed(detail([userMessage("/compact"), item({ type: "compaction", status: "running", summary: null, beforeTokenCount: null, afterTokenCount: null })]), RUN);
  assert.deepEqual(running.map((i) => (i.kind === "notice" ? [i.text, i.active] : null)), [["Compacting context…", true]]);

  const done = liveFeed(detail([item({ type: "compaction", summary: null, beforeTokenCount: 264274, afterTokenCount: 7703 })], "completed"), RUN);
  assert.deepEqual(done.map((i) => (i.kind === "notice" ? [i.text, i.active] : null)), [["Context compacted 264k → 8k tokens", false]]);

  const failed = liveFeed(detail([item({ type: "compaction", status: "failed", summary: null, beforeTokenCount: null, afterTokenCount: null })]), RUN);
  assert.equal((failed[0] as { text: string }).text, "Context compaction failed");
});

test("a burst of tools names the ones still running", () => {
  const feed = liveFeed(detail([command("completed"), command("completed"), command("running")]), RUN);
  assert.deepEqual(feed.map((i) => (i.kind === "tools" ? { count: i.count, running: i.running } : null)), [{ count: 3, running: ["Command"] }]);
  const finished = liveFeed(detail([command("completed")]), RUN);
  assert.deepEqual(finished.map((i) => (i.kind === "tools" ? i.running : null)), [[]]);
});
