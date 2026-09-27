/** What finished since you last looked: news on the room and thread lists, and marks that clear it on every device. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

type News = { unseen: number; latest: { at: string; alias: string | null; kind: string; preview: string } | null };
// Marks and finishes are times to the millisecond: let one pass between a mark and what should count after it.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a room's news counts replies and failed runs since it was last seen", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-seen", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const news = async () => ((await (await app.request("/api/rooms")).json()) as Array<{ id: string; news: News }>).find((r) => r.id === stack.roomId)?.news;
  const seen = (key: string, at: string) => app.request("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, at }) });
  assert.deepEqual(await news(), { unseen: 0, latest: null });

  await later();
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!, stack.participants.sol2!], instruction: "fix it", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Fixed the parser." });
  await stack.tick(2);
  const first = await news();
  assert.equal(first?.unseen, 1);
  assert.deepEqual([first?.latest?.alias, first?.latest?.kind, first?.latest?.preview], ["sol1", "reply", "Fixed the parser."]);

  // Seen up to that reply; a device behind it cannot move the mark back.
  assert.equal((await seen(`room:${stack.roomId}`, first!.latest!.at)).status, 200);
  assert.deepEqual(await news(), { unseen: 0, latest: null });
  const back = (await (await seen(`room:${stack.roomId}`, "2000-01-01T00:00:00.000Z")).json()) as { at: string };
  assert.equal(back.at, first!.latest!.at);

  // A run that fails without a reply is news too.
  await later();
  stack.fake.completeTurn(stack.threadOf("sol2"), { text: "", outcome: "error" });
  await stack.tick(2);
  const failed = await news();
  assert.equal(failed?.unseen, 1);
  assert.deepEqual([failed?.latest?.alias, failed?.latest?.kind], ["sol2", "failed"]);

  assert.equal((await seen("room:../etc", first!.latest!.at)).status, 400);
  assert.equal((await seen(`room:${stack.roomId}`, "yesterday")).status, 400);
});

test("a thread outside rooms has news when its turn finishes after it was last seen; seated threads do not", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-seen", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const threads = async () => (await (await app.request("/api/t3/threads")).json()) as Array<{ id: string; news: { at: string; state: string } | null }>;

  await later();
  const { threadId } = (await stack.run({ type: "thread.start", projectId: "project_demo", text: "hi", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } })) as { threadId: string };
  assert.equal((await threads()).find((x) => x.id === threadId)?.news, null, "still running");
  stack.fake.completeTurn(threadId, { text: "hello" });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "go", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "done" });
  await stack.tick(2);

  const list = await threads();
  const loose = list.find((x) => x.id === threadId)?.news;
  assert.equal(loose?.state, "completed");
  assert.equal(list.find((x) => x.id === stack.threadOf("sol1"))?.news, null, "a seated thread's turns are the room's news");

  await app.request("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `thread:${threadId}`, at: loose!.at }) });
  assert.equal((await threads()).find((x) => x.id === threadId)?.news, null);
});
