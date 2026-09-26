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
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "done", files: [{ path: "src/parser.ts", kind: "modified", additions: 10, deletions: 2 }] });
  stack.fake.completeTurn(stack.threadOf("sol2"), { text: "done too", files: [{ path: "src/parser.ts", kind: "modified", additions: 1, deletions: 1 }, { path: "docs/notes.md", kind: "added", additions: 5, deletions: 0 }] });
  await stack.tick(2);
  // Second turn on sol1 touching the same file again, to exercise aggregation across checkpoints.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "touch it again", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "again", files: [{ path: "src/parser.ts", kind: "modified", additions: 3, deletions: 3 }] });
  await stack.tick(2);

  const response = await app.request(`/api/rooms/${stack.roomId}/desk`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { participants: Record<string, any>; errors: Record<string, string> };
  assert.deepEqual(body.errors, {});
  const sol1 = body.participants[stack.participants.sol1!];
  const sol2 = body.participants[stack.participants.sol2!];
  assert.equal(sol1.session.status, "ready");
  assert.equal(sol1.latestTurn.state, "completed");
  assert.ok(sol1.contextWindow && sol1.contextWindow.maxTokens === 200000 && sol1.contextWindow.percent > 0);
  assert.equal(sol1.toolSummary.completed, 2, "two simulated turns, one completed tool each");
  assert.equal(sol1.toolSummary.lastTool, "Read");
  assert.equal(sol1.checkpoints.length, 2);
  assert.equal(sol1.checkpoints[1].additions, 3);
  assert.deepEqual(sol1.changedFiles, [{ path: "src/parser.ts", kind: "modified", additions: 13, deletions: 5, turns: 2, lastAt: sol1.checkpoints[1].completedAt }]);
  assert.equal(sol2.changedFiles.length, 2);
  assert.equal(sol1.modelSelection.model, "gpt-6-sol");
  assert.equal(sol1.runtimeMode, "full-access");
  assert.equal(sol1.partial, true);

  const single = await app.request(`/api/rooms/${stack.roomId}/participants/${stack.participants.claude!}/live`);
  const claude = (await single.json()) as { session: unknown; changedFiles: unknown[]; partial: boolean };
  assert.equal(claude.session, null, "no turns yet");
  assert.deepEqual(claude.changedFiles, []);
  assert.equal(claude.partial, false);
});

test("a turn the room just sent is the room's from the first read, before the scheduler matches it to its task", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-desk", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "look at the screenshot", schedule: { mode: "now" } });
  // One tick sends the task; T3 starts the turn at once, but the scheduler has not seen it yet.
  await stack.tick(1);
  const live = (await (await app.request(`/api/rooms/${stack.roomId}/participants/${stack.participants.sol1!}/live`)).json()) as { runningTurn: { startedByRoom: boolean; prompt: string | null } | null };
  assert.ok(live.runningTurn, "the turn is running");
  assert.equal(live.runningTurn.startedByRoom, true, "the room's own turn, not one typed in T3");
  assert.equal(live.runningTurn.prompt, null, "so its briefing is never shown as a message typed in T3");
});
