/**
 * "Busy" read from the journal (src/runtime/work.ts seatsWithLiveRuns): a seat with a run the journal has not ended.
 * Z4 moved two checks to it that read the old runtime's tables, always empty on the engine: the parse route's alias
 * pools (POST /api/rooms/:id/parse) and the browser idle stop (src/browser/catalog.ts browserBusy, RoomBrowsers'
 * isBusy in src/server/index.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentKey, browserBusy, threadKey } from "../src/browser/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { seatsWithLiveRuns } from "../src/runtime/index.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

const seatOf = (stack: TestStack, alias: string) => stack.repos.currentBinding(stack.participants[alias]!)!.id;
const live = (stack: TestStack) => [...seatsWithLiveRuns(stack.engine.view(stack.roomId))];

test("a seat is busy from the run the room sends it until that run ends", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  assert.deepEqual(live(stack), []);
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "build it" }] });
  assert.deepEqual(live(stack), [], "a request not yet sent is no run");
  await stack.tick();
  assert.deepEqual(live(stack), [seatOf(stack, "sol1")]);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Built." });
  await stack.tick(2);
  assert.deepEqual(live(stack), []);
});

test("the parse route's alias pool picks a free member: not one whose seat has a live run", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-busy", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const pick = async () => {
    const draft = (await (await app.request(`/api/rooms/${stack.roomId}/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "@sol check it" }) })).json()) as { assignments: Array<{ recipients: string[] }> };
    return draft.assignments[0]!.recipients;
  };
  assert.deepEqual(await pick(), [stack.participants.sol1], "both free: the first of the pool");
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "build it" }] });
  await stack.tick();
  assert.deepEqual(await pick(), [stack.participants.sol2], "sol1 is mid-run");
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Built." });
  await stack.tick(2);
  assert.deepEqual(await pick(), [stack.participants.sol1]);
});

test("a room's browser is busy while a seat of the room has a live run, and not otherwise", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const used = ((await stack.run({ type: "browser.create", name: "testing", description: "Staging" })) as { browserId: string }).browserId;
  const unused = ((await stack.run({ type: "browser.create", name: "spare", description: "" })) as { browserId: string }).browserId;
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: used });
  const busy = (browserId: string) =>
    browserBusy(stack.repos, browserId, { roomBusy: (roomId) => seatsWithLiveRuns(stack.engine.view(roomId)).size > 0, threadBusy: async () => false, agentsWithTabs: async () => [] });
  assert.equal(await busy(used), false);
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.claude!], instruction: "check the page" }] });
  await stack.tick();
  assert.equal(await busy(used), true, "work in flight in the room that uses it");
  assert.equal(await busy(unused), false, "no room uses it");
  stack.fake.completeRun(stack.threadOf("claude"), { text: "Checked." });
  await stack.tick(2);
  assert.equal(await busy(used), false);
});

test("a browser besides the default is busy while an agent with work in flight has a tab of its own open in it (#598)", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const other = ((await stack.run({ type: "browser.create", name: "testing", description: "Staging" })) as { browserId: string }).browserId;
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  const threadId = "1a2b3c4d-0000-4000-8000-000000000000";
  await stack.run({ type: "thread.browser", threadId, enabled: true });
  const tabs = new Map<string, string[]>();
  let threadWorking = false;
  const busy = (browserId: string) =>
    browserBusy(stack.repos, browserId, {
      roomBusy: (roomId) => seatsWithLiveRuns(stack.engine.view(roomId)).size > 0,
      threadBusy: async (id) => id === threadId && threadWorking,
      agentsWithTabs: async (id) => tabs.get(id) ?? [],
    });
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.claude!], instruction: "check staging" }] });
  await stack.tick();
  assert.equal(await busy(other), false, "the room works, but nobody of it has a tab in this browser, which is not its default");
  tabs.set(other, [agentKey("claude", stack.roomId)]);
  assert.equal(await busy(other), true, "the room's agent has its tab open in it");
  stack.fake.completeRun(stack.threadOf("claude"), { text: "Checked." });
  await stack.tick(2);
  assert.equal(await busy(other), false, "the tab is still open, but its room has nothing in flight");

  // A thread outside rooms: its agent's tab counts while the thread works.
  tabs.set(other, [threadKey(threadId)]);
  assert.equal(await busy(other), false);
  threadWorking = true;
  assert.equal(await busy(other), true);
  tabs.set(other, ["thread.ffffffff", "nobody.00000000"]);
  assert.equal(await busy(other), false, "keys that name no thread or room count for nothing");
});
