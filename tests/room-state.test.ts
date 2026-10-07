/**
 * The room state on the page: its own route, carried in the room snapshot and the overview, and a write through
 * rooms-board reaching an open page through the room's stream.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { roomStateLine } from "../src/app/roomState.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

const appFor = (stack: TestStack) =>
  createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-room-state", ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "secret", command: "rooms-browser" });

/** What `rooms-board <argv> --as <alias's key>` sends. */
const board = (app: ReturnType<typeof appFor>, stack: TestStack, alias: string, argv: string[]) =>
  app.request("/api/board-tools", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ argv, as: agentKey(alias, stack.roomId) }) });

test("a room's state has its own route, rides in the room snapshot and the overview, and says so when there is none", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = appFor(stack);
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.sol1! });

  assert.equal((await app.request("/api/rooms/nope/state")).status, 404);
  const none = (await (await app.request(`/api/rooms/${stack.roomId}/state`)).json()) as { state: unknown; message: string };
  assert.equal(none.state, null);
  assert.match(none.message, /no state yet/);
  assert.equal(((await (await app.request(`/api/rooms/${stack.roomId}`)).json()) as { state: unknown }).state, null);

  // Only the Consigliere writes it.
  const refused = await board(app, stack, "sol2", ["state", "Not mine to write."]);
  assert.equal(refused.status, 403);
  const text = "## Purpose: ship the **parser** fix\n\n- Standing decision: no new dependencies.\n- sol2 holds the tests.";
  assert.equal((await board(app, stack, "sol1", ["state", text])).status, 200);

  const read = (await (await app.request(`/api/rooms/${stack.roomId}/state`)).json()) as { state: { text: string; by: string; at: string; line: string } };
  assert.equal(read.state.text, text);
  assert.equal(read.state.by, "sol1");
  assert.equal(read.state.line, "Purpose: ship the parser fix", "the first line, for the closed panel, comes with it");
  assert.ok(!Number.isNaN(Date.parse(read.state.at)));
  const snapshot = (await (await app.request(`/api/rooms/${stack.roomId}`)).json()) as { state: { text: string; by: string } };
  assert.deepEqual(snapshot.state, read.state);

  // The overview's tile shows the first line, without its markdown.
  const overview = (await (await app.request("/api/overview")).json()) as { rooms: Array<{ id: string; state: { line: string; by: string; at: string } | null }> };
  assert.deepEqual(overview.rooms.find((room) => room.id === stack.roomId)?.state, { line: "Purpose: ship the parser fix", by: "sol1", at: read.state.at });
});

test("the state's first line skips blank lines and list or quote marks, and is cut short when long", () => {
  assert.equal(roomStateLine("\n\n  > Room purpose: make it cheaper.\nSecond line."), "Room purpose: make it cheaper.");
  assert.equal(roomStateLine("1. First item\n2. Second"), "First item");
  assert.equal(roomStateLine(`- ${"x".repeat(400)}`).length, 300);
  assert.ok(roomStateLine("y".repeat(400)).endsWith("…"));
});

test("a state written with rooms-board reaches an open room page through its stream, and a refused one does not", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = appFor(stack);
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.sol1! });

  // The page's EventSource. The stream's 15-second keepalive runs on mocked timers, so nothing is left waiting.
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const response = await app.request(`/api/rooms/${stack.roomId}/stream`);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let received = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${pattern}: ${received}`);
      received += decoder.decode(value);
    }
  };
  await until(/event: hello/);

  let notified = 0;
  t.after(stack.hub.subscribe(stack.roomId, () => (notified += 1)));
  await board(app, stack, "sol2", ["state", "Not mine to write."]);
  assert.equal(notified, 0, "a refused write changes nothing");
  await board(app, stack, "sol1", ["state", "Room purpose: the parser."]);
  assert.equal(notified, 1);
  await until(/event: room\.changed/);
  assert.match(received, new RegExp(`event: room\\.changed\\ndata: \\{"roomId":"${stack.roomId}"`));

  // The page refetches the snapshot on that event: the new state is in it.
  const snapshot = (await (await app.request(`/api/rooms/${stack.roomId}`)).json()) as { state: { text: string; by: string } | null };
  assert.equal(snapshot.state?.text, "Room purpose: the parser.");
});
