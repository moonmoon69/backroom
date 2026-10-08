/**
 * "Busy" read from the journal (src/runtime/work.ts seatsWithLiveRuns): a seat with a run the journal has not ended.
 * Z4 moved two checks to it that read the old runtime's tables, always empty on the engine: the parse route's alias
 * pools (POST /api/rooms/:id/parse) and the browser idle stop (src/browser/catalog.ts browserBusy, RoomBrowsers'
 * isBusy in src/server/index.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserBusy } from "../src/browser/catalog.ts";
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
  const busy = (browserId: string) => browserBusy(stack.repos, browserId, (roomId) => seatsWithLiveRuns(stack.engine.view(roomId)).size > 0);
  assert.equal(busy(used), false);
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.claude!], instruction: "check the page" }] });
  await stack.tick();
  assert.equal(busy(used), true, "work in flight in the room that uses it");
  assert.equal(busy(unused), false, "no room uses it");
  stack.fake.completeRun(stack.threadOf("claude"), { text: "Checked." });
  await stack.tick(2);
  assert.equal(busy(used), false);
});
