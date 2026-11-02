/** What finished since you last looked: news on the room and thread lists, and marks that clear it on every device. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

// Marks and finishes are times to the millisecond: let one pass between a mark and what should count after it.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a seen mark refuses a key that is not a room's or a thread's, a room's mark by time, a time that is not one, and a sequence that is not one", async (t) => {
  // A room's news itself is counted from its journal (tests/engine-view.test.ts); its mark is a journal sequence.
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-seen", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const seen = (body: Record<string, unknown>) => app.request("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await seen({ key: "room:../etc", at: "2026-10-09T00:00:00.000Z" })).status, 400);
  assert.equal((await seen({ key: `room:${stack.roomId}`, at: "2026-10-09T00:00:00.000Z" })).status, 400, "a room's mark is a sequence, not a time");
  assert.equal((await seen({ key: `thread:${stack.threadOf("sol1")}`, at: "yesterday" })).status, 400);
  assert.equal((await seen({ key: `room:${stack.roomId}`, seq: "three" })).status, 400);
  assert.equal((await seen({ key: `room:${stack.roomId}`, seq: 0 })).status, 200);
});

test("a thread outside rooms has news when its turn finishes after it was last seen; seated threads do not", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-seen", ROOMS_PORT: "0" }), "/nonexistent/dist");
  // The overview's threads outside rooms carry their news: the tiles, the tab's count and the finish notifications (App.tsx).
  // Each read follows a change of T3's threads, as the page's reads do (the push that has it read again).
  const threads = async () => {
    stack.changes.shellChanged();
    return ((await (await app.request("/api/overview")).json()) as { threads: Array<{ id: string; news: { at: string; state: string } | null }> }).threads;
  };

  await later();
  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "hi", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } })) as { threadId: string };
  assert.equal((await threads()).find((x) => x.id === threadId)?.news, null, "still running");
  stack.fake.completeRun(threadId, { text: "hello" });
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "go" }] });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "done" });
  await stack.tick(2);

  const list = await threads();
  const loose = list.find((x) => x.id === threadId)?.news;
  assert.equal(loose?.state, "completed");
  assert.equal(list.find((x) => x.id === stack.threadOf("sol1")), undefined, "a seated thread's turns are the room's news");

  await app.request("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `thread:${threadId}`, at: loose!.at }) });
  assert.equal((await threads()).find((x) => x.id === threadId)?.news, null);
});
