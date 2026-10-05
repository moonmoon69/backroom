/** Desk aggregation through the HTTP app: context window, tool summary, checkpoints, and changed-file rollups. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
import { createTestStack } from "./helpers.ts";

test("desk view aggregates T3 thread data per participant and across the room", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-desk", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!, stack.participants.sol2!], instruction: "touch the parser", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "done", files: [{ path: "src/parser.ts", kind: "modified", additions: 10, deletions: 2 }] });
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "done too", files: [{ path: "src/parser.ts", kind: "modified", additions: 1, deletions: 1 }, { path: "docs/notes.md", kind: "added", additions: 5, deletions: 0 }] });
  await stack.tick(2);
  // Second run on sol1 touching the same file again, to exercise aggregation across checkpoints.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "touch it again", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "again", files: [{ path: "src/parser.ts", kind: "modified", additions: 3, deletions: 3 }] });
  await stack.tick(2);

  const response = await app.request(`/api/rooms/${stack.roomId}/desk`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { participants: Record<string, any>; errors: Record<string, string> };
  assert.deepEqual(body.errors, {});
  const sol1 = body.participants[stack.participants.sol1!];
  const sol2 = body.participants[stack.participants.sol2!];
  const sol1Runs = stack.fake.threads.get(stack.threadOf("sol1"))!.runs;
  assert.equal(sol1.status, "completed");
  assert.equal(sol1.activeRunId, null);
  assert.deepEqual(sol1.latestRun, { runId: sol1Runs[1]!.id, status: "completed", completedAt: sol1Runs[1]!.completedAt });
  assert.equal(sol1.lastError, null);
  assert.equal(sol1.runningRun, null);
  assert.ok(sol1.contextWindow && sol1.contextWindow.maxTokens === 200000 && sol1.contextWindow.percent > 0);
  assert.equal(sol1.toolSummary.completed, 2, "two simulated runs, one completed tool each");
  assert.equal(sol1.toolSummary.lastTool, "Read");
  assert.equal(sol1.checkpoints.length, 2);
  assert.equal(sol1.checkpoints[1].additions, 3);
  assert.deepEqual(sol1.checkpoints.map((c: { runId: string }) => c.runId), sol1Runs.map((r) => r.id));
  const tools = sol1.activities.filter((a: { tone: string }) => a.tone === "tool");
  assert.deepEqual(tools.map((a: { kind: string; summary: string; runId: string }) => [a.kind, a.summary, a.runId]), sol1Runs.map((r) => ["dynamic_tool", "Read", r.id]), "activities come from the runs' items");
  assert.deepEqual(sol1.changedFiles, [{ path: "src/parser.ts", kind: "modified", additions: 13, deletions: 5, turns: 2, lastAt: sol1.checkpoints[1].completedAt }]);
  assert.equal(sol2.changedFiles.length, 2);
  assert.equal(sol1.modelSelection.model, "gpt-6-sol");
  assert.equal(sol1.runtimeMode, "full-access");
  // T3 says whether its read left older items out; the fake always reads the whole thread.
  assert.equal(sol1.partial, false);

  const single = await app.request(`/api/rooms/${stack.roomId}/participants/${stack.participants.claude!}/live`);
  const claude = (await single.json()) as { status: string | null; activeRunId: string | null; latestRun: unknown; changedFiles: unknown[]; partial: boolean };
  assert.deepEqual([claude.status, claude.activeRunId, claude.latestRun], ["idle", null, null], "no runs yet");
  assert.deepEqual(claude.changedFiles, []);
  assert.equal(claude.partial, false);
});

test("a run the room just sent is the room's from the first read, before the scheduler matches it to its task", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-desk", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "look at the screenshot", schedule: { mode: "now" } });
  // One tick sends the task; T3 starts the run at once, but the scheduler has not seen it yet.
  await stack.tick(1);
  const live = (await (await app.request(`/api/rooms/${stack.roomId}/participants/${stack.participants.sol1!}/live`)).json()) as { runningRun: { runId: string; startedByRoom: boolean; prompt: string | null; promptImages: string[] } | null };
  assert.ok(live.runningRun, "the run is running");
  assert.equal(live.runningRun.runId, stack.fake.threads.get(stack.threadOf("sol1"))!.shell.activeRunId);
  assert.equal(live.runningRun.startedByRoom, true, "the room's own run, not one typed in T3");
  assert.equal(live.runningRun.prompt, null, "so its briefing is never shown as a message typed in T3");
  assert.deepEqual(live.runningRun.promptImages, []);
});
