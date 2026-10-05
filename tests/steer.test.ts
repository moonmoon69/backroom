import assert from "node:assert/strict";
import { test } from "node:test";
import { T3Unavailable, type SendMessageInput } from "../src/adapter/types.ts";
import { createTestStack } from "./helpers.ts";

const starts = (stack: Awaited<ReturnType<typeof createTestStack>>) =>
  stack.fake.commands.filter((c) => c.type === "message.dispatch").map((c) => c.payload as SendMessageInput);

test("queue (default): a message for a participant mid-turn waits for the turn to end", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "also add tests", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(2).state, "queued");
  assert.equal(stack.fake.steeredMessages, 0);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Built." });
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
  assert.ok(first.t3RunId);
  assert.equal(second.t3RunId, first.t3RunId, "same T3 run");
  assert.deepEqual(steer.mode, { type: "steer", runId: first.t3RunId }, "steered explicitly into the thread's active run");
  assert.deepEqual(starts(stack)[0]!.mode, { type: "start" });
  const t3 = stack.fake.threads.get(stack.threadOf("sol1"))!;
  assert.equal(t3.runs.length, 1, "no new run in T3");
  assert.equal(t3.messages.find((m) => m.id === second.messageId)?.runId, first.t3RunId, "T3 put the message into the running run");

  stack.fake.completeRun(stack.threadOf("sol1"), { progress: ["Building."], text: "Built it and added tests." });
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
  stack.fake.completeRun(thread, { text: "Ready." });
  await stack.tick(3);

  stack.fake.startExternalRun(thread, "typed in T3");
  await stack.tick();
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "and check the logs", delivery: "steer" }] });
  await stack.tick(2);
  assert.equal(stack.fake.steeredMessages, 1);
  stack.fake.completeRun(thread, { text: "Done, logs are clean." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "succeeded");
  const events = stack.repos.listEvents(stack.roomId);
  assert.equal(events.filter((e) => e.kind === "t3.turn").length, 0, "the steered turn is the room's now");
  assert.equal(events.filter((e) => e.kind === "assistant.reply").at(-1)?.text, "Done, logs are clean.");

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol2!], instruction: "hello", delivery: "steer" }] });
  await stack.tick(2);
  assert.equal(stack.fake.steeredMessages, 1, "sol2 was idle: no steering");
  assert.match(starts(stack).at(-1)!.text, /== Your assignment/, "idle recipients get the full briefing");
  assert.deepEqual(starts(stack).at(-1)!.mode, { type: "start" });
});

test("a steer whose target run ended before it was sent is sent as an ordinary start, and gets its own run and reply", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");

  // T3 is unreachable just as the steer is sent; the running run ends before the room can send it again.
  const sendMessage = stack.fake.sendMessage.bind(stack.fake);
  const attempts: SendMessageInput[] = [];
  stack.fake.sendMessage = async (input) => {
    attempts.push(input);
    if (attempts.length === 1) throw new T3Unavailable("simulated outage");
    return sendMessage(input);
  };
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "also add tests", delivery: "steer" }] });
  await stack.tick();
  const first = stack.repos.getRun(stack.task(1).currentRunId!)!;
  assert.deepEqual(attempts.map((a) => a.mode), [{ type: "steer", runId: first.t3RunId }], "meant for the running run");
  assert.equal(starts(stack).length, 1, "the steer did not reach T3");
  stack.fake.completeRun(thread, { text: "Built." });
  await stack.tick(3);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]!.messageId, attempts[0]!.messageId, "the same message, resent");
  assert.equal(attempts[1]!.commandId, attempts[0]!.commandId);
  assert.deepEqual(attempts[1]!.mode, { type: "start" }, "the run it was meant for ended: an ordinary start");
  assert.equal(stack.fake.steeredMessages, 0);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "running", "its own run, after the first");
  const second = stack.repos.getRun(stack.task(2).currentRunId!)!;
  assert.ok(second.t3RunId, "found by the message id the room chose");
  assert.notEqual(second.t3RunId, first.t3RunId, "its own run, not the one that ended");
  assert.equal(stack.fake.threads.get(thread)!.runs.find((r) => r.id === second.t3RunId)?.userMessageId, second.messageId);

  stack.fake.completeRun(thread, { text: "Tests added." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "succeeded");
  const replies = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply");
  assert.deepEqual(replies.map((e) => e.text), ["Built.", "Tests added."]);
  assert.equal(stack.repos.getRun(stack.task(2).currentRunId!)!.resultEventId, replies[1]!.id);
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "t3.turn").length, 0);
});

test("a steer that reaches T3 just after its target run ended starts a run of its own, with its own reply", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  const first = stack.repos.getRun(stack.task(1).currentRunId!)!;

  // The run ends between the room's look at the thread and the arrival of the steered message.
  const sendMessage = stack.fake.sendMessage.bind(stack.fake);
  stack.fake.sendMessage = async (input) => {
    if (input.mode.type === "steer") stack.fake.completeRun(thread, { text: "Built." });
    return sendMessage(input);
  };
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "also add tests", delivery: "steer" }] });
  await stack.tick(3);
  assert.deepEqual(starts(stack).at(-1)!.mode, { type: "steer", runId: first.t3RunId });
  assert.equal(stack.fake.steeredMessages, 0, "T3 had nothing running to steer into");
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "running");
  const second = stack.repos.getRun(stack.task(2).currentRunId!)!;
  assert.ok(second.t3RunId);
  assert.notEqual(second.t3RunId, first.t3RunId, "its own run");

  stack.fake.completeRun(thread, { text: "Tests added." });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "succeeded");
  const events = stack.repos.listEvents(stack.roomId);
  assert.deepEqual(events.filter((e) => e.kind === "assistant.reply").map((e) => e.text), ["Built.", "Tests added."]);
  assert.equal(events.filter((e) => e.kind === "t3.turn").length, 0);
});

test("a note typed in T3 into a running room turn shows in the timeline with its images, before the reply, and never in briefings", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "build it", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");

  // The user types into the running turn in T3 Code, with a screenshot attached.
  const noteId = stack.fake.sendUserMessage(thread, "also it crashes on phones", [{ id: "thr-abc-img1", name: "IMG_1.png", mimeType: "image/png", sizeBytes: 1234, type: "image" }]);
  await stack.tick(1);
  const events = () => stack.repos.listRecentEvents(stack.roomId, 100);
  const note = events().find((e) => e.kind === "t3.message");
  assert.ok(note, "the note appears while the turn is still running");
  assert.equal(note.text, "also it crashes on phones");
  assert.deepEqual(note.attachmentIds, ["thr-abc-img1"]);
  assert.equal(note.speaker.type, "user");
  assert.equal(note.taskId, stack.task(1).id);
  assert.equal(note.sourceRef?.messageId, noteId);
  assert.equal(note.sourceRef?.t3RunId, stack.repos.getRun(stack.task(1).currentRunId!)!.t3RunId, "steered into the room's run");

  // The turn ends: the reply follows the note, and the note is not recorded twice.
  stack.fake.completeRun(thread, { text: "Built, and fixed the phone crash." });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "succeeded");
  const all = events();
  const notes = all.filter((e) => e.kind === "t3.message");
  assert.equal(notes.length, 1);
  const reply = all.find((e) => e.kind === "assistant.reply");
  assert.ok(reply);
  assert.ok(notes[0]!.sequence < reply.sequence, "note precedes the reply");

  // Another participant's next briefing carries the room exchange but not the note typed in T3.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review it", schedule: { mode: "now" } });
  await stack.tick(2);
  const briefing = stack.fake.commands.filter((c) => c.type === "message.dispatch").at(-1)?.payload as { text: string };
  assert.match(briefing.text, /Built, and fixed the phone crash/);
  assert.doesNotMatch(briefing.text, /also it crashes on phones/);
});
