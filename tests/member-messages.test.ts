/** The board's record of what members send each other with T3's tools, and of how turns the room did not start ended. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack } from "./helpers.ts";
import { isSubagentThread } from "../web/src/types.ts";

const events = (stack: Awaited<ReturnType<typeof createTestStack>>, kind: string) => stack.repos.listEvents(stack.roomId).filter((e) => e.kind === kind);

test("a message one member's agent sends another is recorded once, with sender, receiver and text; its turn records how it ended", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.tick();
  const messageId = stack.fake.sendAgentMessage(stack.threadOf("sol2"), stack.threadOf("sol1"), "Research the timeout and report back.");
  await stack.tick();
  const sent = events(stack, "member.message");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.speaker, { type: "participant", participantId: stack.participants.sol1, bindingId: stack.repos.currentBinding(stack.participants.sol1!)!.id });
  assert.equal(sent[0]!.to, stack.participants.sol2);
  assert.equal(sent[0]!.text, "Research the timeout and report back.");
  assert.equal(sent[0]!.sourceRef?.messageId, messageId);
  assert.equal(stack.scheduler.participantStatus(stack.participants.sol2!).externalActivity, true, "the receiver shows as working");
  await stack.tick(2);
  assert.equal(events(stack, "member.message").length, 1, "seeing it again adds nothing");

  stack.fake.completeRun(stack.threadOf("sol2"), { text: "It is the retry loop." });
  await stack.tick(2);
  const turns = events(stack, "t3.turn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "It is the retry loop.");
  assert.equal(turns[0]!.outcome, "completed");
  assert.equal(turns[0]!.prompt, null, "the message that asked is its own post");
  assert.equal(turns[0]!.sourceRef?.t3RunId, sent[0]!.sourceRef?.t3RunId, "the answer and the message share the T3 run");
  assert.ok(sent[0]!.sequence < turns[0]!.sequence);

  // A second turn is interrupted before it answers: still recorded, marked, with empty text.
  stack.fake.sendAgentMessage(stack.threadOf("sol2"), stack.threadOf("sol1"), "Now check the queue.");
  await stack.tick();
  const thread = stack.fake.threads.get(stack.threadOf("sol2"))!;
  const run = thread.runs.find((r) => r.id === thread.shell.activeRunId)!;
  Object.assign(run, { status: "interrupted", completedAt: new Date().toISOString() });
  Object.assign(thread.shell, { status: "interrupted", activeRunId: null, latestRunCompletedAt: run.completedAt });
  await stack.tick(2);
  const after = events(stack, "t3.turn");
  assert.equal(after.length, 2);
  assert.deepEqual([after[1]!.outcome, after[1]!.text], ["interrupted", ""]);
  assert.equal(events(stack, "member.message").length, 2);
});

test("a sender whose thread is not a member of the room is recorded as outside it, with the thread's title", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.fake.launchThread({ commandId: "c-out", threadId: "thread-outside", projectId: "project_demo", title: "Someone else", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  stack.fake.sendAgentMessage(stack.threadOf("sol1"), "thread-outside", "Hello from elsewhere.");
  await stack.tick();
  const sent = events(stack, "member.message");
  assert.deepEqual(sent[0]!.speaker, { type: "outside", threadId: "thread-outside", title: "Someone else" });
  assert.equal(sent[0]!.to, stack.participants.sol1);
});

test("a steer into a turn the room started is recorded; a turn the user typed in T3 is recorded as before", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  stack.fake.sendAgentMessage(stack.threadOf("sol1"), stack.threadOf("claude"), "Use the blue one.", "steer");
  await stack.tick();
  const sent = events(stack, "member.message");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, stack.participants.sol1);
  assert.equal(sent[0]!.sourceRef?.t3RunId, stack.repos.listRunsForTask(stack.task(1).id)[0]!.t3RunId);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "done, in blue" });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(events(stack, "assistant.reply").length, 1);
  assert.equal(events(stack, "t3.turn").length, 0, "the room's own turn is not imported a second time");

  stack.fake.startExternalRun(stack.threadOf("sol2"), "typed in T3");
  await stack.tick();
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "answer" });
  await stack.tick(2);
  const turns = events(stack, "t3.turn");
  assert.deepEqual(turns.map((e) => [e.prompt, e.text, e.outcome]), [["typed in T3", "answer", "completed"]]);
  assert.equal(events(stack, "member.message").length, 1);
});

test("a thread whose lineage says subagent is left out of the sidebar's lists, active or settled", () => {
  const lineage = (relationshipToParent: "fork" | "subagent" | null) => ({ lineage: { parentThreadId: relationshipToParent ? "parent" : null, relationshipToParent, rootThreadId: "root" } });
  assert.equal(isSubagentThread(lineage("subagent")), true);
  assert.equal(isSubagentThread(lineage("fork")), false, "a fork is a thread of its own");
  assert.equal(isSubagentThread(lineage(null)), false);
  assert.equal(isSubagentThread({}), false, "a thread read without its lineage is listed");
});
