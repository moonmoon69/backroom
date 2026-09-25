import assert from "node:assert/strict";
import { test } from "node:test";
import type { StartTurnInput } from "../src/adapter/types.ts";
import { createTestStack } from "./helpers.ts";

const starts = (stack: Awaited<ReturnType<typeof createTestStack>>) =>
  stack.fake.commands.filter((c) => c.type === "thread.turn.start").map((c) => c.payload as StartTurnInput);

test("queue (default): a message for a participant mid-turn waits for the turn to end", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "also add tests", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(2).state, "queued");
  assert.equal(stack.fake.steeredMessages, 0);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Built." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "running", "starts its own turn after the first one ends");
});

test("steer: a message is sent into the running turn, and the turn's final answer answers both tasks", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  await stack.run({ type: "message.create", roomId: stack.roomId, sourceText: "@sol1 /steer also add tests", assignments: [{ recipients: [stack.participants.sol1!], instruction: "also add tests", delivery: "steer" }] });
  await stack.tick(2);
  assert.equal(stack.fake.steeredMessages, 1);
  assert.equal(stack.task(2).state, "running");
  const steer = starts(stack)[1]!;
  assert.match(steer.text, /added this to your current turn/);
  assert.doesNotMatch(steer.text, /== Shared room messages/, "no full briefing mid-turn");
  const [first, second] = [stack.repos.getRun(stack.task(1).currentRunId!)!, stack.repos.getRun(stack.task(2).currentRunId!)!];
  assert.equal(second.steered, true);
  assert.equal(second.turnId, first.turnId, "same T3 turn");

  stack.fake.completeTurn(stack.threadOf("sol1"), { progress: ["Building."], text: "Built it and added tests." });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "succeeded");
  const replies = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply");
  assert.equal(replies.length, 1, "one reply");
  assert.equal(stack.repos.getRun(stack.task(1).currentRunId!)!.resultEventId, replies[0]!.id);
  assert.equal(stack.repos.getRun(stack.task(2).currentRunId!)!.resultEventId, replies[0]!.id);
});

test("steer into a turn started directly in T3 makes it a room reply; steer when idle is an ordinary start", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  // Bootstrap the thread first (steering never replaces the first full briefing).
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "warm up", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(thread, { text: "Ready." });
  await stack.tick(3);

  stack.fake.startExternalTurn(thread, "typed in T3");
  await stack.tick();
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "and check the logs", delivery: "steer" }] });
  await stack.tick(2);
  assert.equal(stack.fake.steeredMessages, 1);
  stack.fake.completeTurn(thread, { text: "Done, logs are clean." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "succeeded");
  const events = stack.repos.listEvents(stack.roomId);
  assert.equal(events.filter((e) => e.kind === "t3.turn").length, 0, "the steered turn is the room's now");
  assert.equal(events.filter((e) => e.kind === "assistant.reply").at(-1)?.text, "Done, logs are clean.");

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol2!], instruction: "hello", delivery: "steer" }] });
  await stack.tick(2);
  assert.equal(stack.fake.steeredMessages, 1, "sol2 was idle: no steering");
  assert.match(starts(stack).at(-1)!.text, /== Your assignment/, "idle recipients get the full briefing");
});

test("providers that start a new turn for a mid-turn message (Claude): each message gets its own turn and reply", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null, midTurn: "new-turn" });
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "also add tests", delivery: "steer" }] });
  await stack.tick(2);
  const [first, second] = [stack.repos.getRun(stack.task(1).currentRunId!)!, stack.repos.getRun(stack.task(2).currentRunId!)!];
  assert.ok(second.turnId, "matched by requestedAt");
  assert.notEqual(second.turnId, first.turnId, "its own turn, not the running one");

  stack.fake.completeTurn(thread, { text: "Built." });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "running", "second turn starts after the first");
  stack.fake.completeTurn(thread, { text: "Tests added." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "succeeded");
  const replies = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply").map((e) => e.text);
  assert.deepEqual(replies, ["Built.", "Tests added."]);
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "t3.turn").length, 0);
});
