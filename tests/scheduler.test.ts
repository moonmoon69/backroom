import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack } from "./helpers.ts";

test("parallel work: one message starts two participants without waiting", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!, stack.participants.sol2!], instruction: "independently investigate the timeout", schedule: { mode: "now" } });
  await stack.tick();
  assert.equal(stack.task(1).state, "dispatching");
  assert.equal(stack.task(2).state, "dispatching");
  const starts = stack.fake.commands.filter((c) => c.type === "thread.turn.start");
  assert.equal(starts.length, 2);
  await stack.tick();
  assert.equal(stack.task(1).state, "running");
  assert.equal(stack.task(2).state, "running");
});

test("sequential review waits for the implementation and receives its output exactly once", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "Implement the webhook parser", schedule: { mode: "now" } });
  await stack.tick();
  const implementation = stack.task(1);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "Review the implementation", schedule: { mode: "after_all", prerequisites: [{ taskId: implementation.id, revision: 1 }] } });
  await stack.tick(2);
  assert.equal(stack.task(2).state, "queued");
  assert.match(stack.task(2).stateReason ?? "", /waiting for task1/);
  assert.equal(stack.fake.commands.filter((c) => c.type === "thread.turn.start").length, 1, "review not sent early");

  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Parser implemented in src/parser.ts.\n\nHandoff: branch feature/parser, commit abc123", files: [{ path: "src/parser.ts", kind: "modified", additions: 40, deletions: 2 }] });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "running");
  const reviewRun = stack.repos.listRunsForTask(stack.task(2).id)[0]!;
  assert.match(reviewRun.briefing, /== Completed prerequisites ==\ntask1 by @sol1: Implement the webhook parser/);
  assert.match(reviewRun.briefing, /commit abc123/);
  assert.match(reviewRun.briefing, /modified src\/parser\.ts/);
  assert.equal(reviewRun.briefing.split("Parser implemented in src/parser.ts").length, 2, "delivered once");
  const replies = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.artifacts[0]?.path, "src/parser.ts");
});

test("fan-in waits for both prerequisites; completion of one does not release it", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!, stack.participants.sol2!], instruction: "investigate", schedule: { mode: "now" } });
  await stack.tick();
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.claude!], instruction: "compare their findings", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }, { taskId: stack.task(2).id, revision: 1 }] } });
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "sol1 findings" });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(3).state, "queued");
  assert.match(stack.task(3).stateReason ?? "", /waiting for task2/);
  stack.fake.completeTurn(stack.threadOf("sol2"), { text: "sol2 findings" });
  await stack.tick(3);
  assert.equal(stack.task(3).state, "running");
  const briefing = stack.repos.listRunsForTask(stack.task(3).id)[0]!.briefing;
  assert.match(briefing, /sol1 findings/);
  assert.match(briefing, /sol2 findings/);
  assert.match(briefing, /The room already waited for task1 by @sol1, task2 by @sol2 to finish/);
});

test("run correlation: an unrelated direct T3 turn cannot release a dependency", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  // Someone types directly in T3 on sol1's thread while our turn is "running": in T3 that would queue, but the fake
  // models the observable effect: a different active turn. Our run must not be treated as finished.
  const thread = stack.fake.threads.get(stack.threadOf("sol1"))!;
  const ourTurn = thread.shell.session!.activeTurnId!;
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "our result" });
  const external = stack.fake.startExternalTurn(stack.threadOf("sol1"));
  assert.notEqual(external, ourTurn);
  await stack.tick(2);
  // Our turn completed (checkpoint exists) so task1 succeeds via checkpoint correlation, not via latestTurn.
  assert.equal(stack.task(1).state, "succeeded");
  // But sol1 is busy externally now: the room must not dispatch new work to sol1 while that external turn runs.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "follow-up", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(3).state, "queued");
  assert.match(stack.task(3).stateReason ?? "", /busy in T3/);
  // And the external turn finishing does not satisfy anything for task3.
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "external reply" });
  await stack.tick(2);
  assert.equal(stack.task(3).state, "running");
  const replies = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply");
  assert.deepEqual(replies.map((r) => r.text), ["our result"], "external reply is not imported as a room result");
});

test("failed and interrupted prerequisites keep dependents blocked with the reason visible", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "API Error: 529 Overloaded", outcome: "error" });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "failed");
  assert.equal(stack.task(2).state, "blocked");
  assert.match(stack.task(2).stateReason ?? "", /prerequisite task1 failed/);
  // Retry with reattach: dependents follow the new attempt and the briefing is rebuilt with fresh context.
  await stack.run({ type: "task.retry", taskId: stack.task(1).id, revision: 1, reattachDependents: true });
  assert.equal(stack.task(2).state, "queued");
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  const runs = stack.repos.listRunsForTask(stack.task(1).id);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0]!.commandId, runs[1]!.commandId, "a user retry is a new attempt with a new identity");
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "second attempt done" });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.task(2).state, "running");
});

test("interrupt requests go through T3 and the observed outcome is recorded", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "long job", schedule: { mode: "now" } });
  await stack.tick(2);
  const task = stack.task(1);
  assert.equal(task.state, "running");
  await stack.run({ type: "task.interrupt", taskId: task.id, runId: task.currentRunId! });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "interrupted");
  await stack.run({ type: "task.retry", taskId: task.id, revision: 1, reattachDependents: false });
  assert.equal(stack.task(1).state, "queued");
});

test("editing pending work creates a new revision and does not silently retarget dependents", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "manual" } });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  await stack.run({ type: "task.update", taskId: stack.task(1).id, revision: 1, instruction: "implement v2" });
  assert.equal(stack.task(1).revision, 2);
  assert.equal(stack.task(1).state, "held");
  assert.equal(stack.task(2).state, "blocked");
  assert.match(stack.task(2).stateReason ?? "", /revision 2/);
  // Stale revision is rejected.
  await assert.rejects(stack.run({ type: "task.release", taskId: stack.task(1).id, revision: 1 }), /stale/);
  // Carrying dependents re-points them explicitly.
  await stack.run({ type: "task.unblock", taskId: stack.task(2).id, revision: 1 });
  await stack.run({ type: "task.update", taskId: stack.task(1).id, revision: 2, instruction: "implement v3", carryDependents: true });
  assert.deepEqual(stack.task(2).prerequisites, [{ taskId: stack.task(1).id, revision: 3 }]);
  assert.equal(stack.task(2).revision, 2);
  await stack.run({ type: "task.release", taskId: stack.task(1).id, revision: 3 });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  assert.equal(stack.task(2).state, "queued");
});

test("cancel blocks dependents; accepted work cannot be cancelled", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "a", schedule: { mode: "manual" } });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "b", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  await stack.run({ type: "task.cancel", taskId: stack.task(1).id, revision: 1 });
  assert.equal(stack.task(1).state, "cancelled");
  assert.equal(stack.task(2).state, "blocked");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.claude!], instruction: "c", schedule: { mode: "now" } });
  await stack.tick(2);
  await assert.rejects(stack.run({ type: "task.cancel", taskId: stack.task(3).id, revision: 1 }), /cannot cancel/);
});

test("restart safety: a lost acknowledgement is resent with the same command id, never duplicated", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  stack.fake.dropAcks = true;
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.tick();
  const run = stack.repos.listRunsForTask(stack.task(1).id)[0]!;
  assert.equal(run.status, "dispatched", "ack unknown");
  stack.fake.dropAcks = false;
  await stack.tick(2);
  const starts = stack.fake.commands.filter((c) => c.type === "thread.turn.start");
  assert.ok(starts.length >= 1);
  assert.equal(new Set(starts.map((c) => c.commandId)).size, 1, "identical command id on resend");
  assert.equal(stack.fake.threads.get(stack.threadOf("sol1"))!.messages.filter((m) => m.role === "user").length, 1, "T3 received one prompt");
  assert.equal(stack.task(1).state, "running");
  assert.equal(stack.repos.listRunsForTask(stack.task(1).id).length, 1);
});

test("outage: queued work stays persisted and dispatches when T3 returns", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const { T3Unavailable } = await import("../src/adapter/types.ts");
  stack.fake.outage = new T3Unavailable("connection refused");
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "queued");
  assert.ok(stack.scheduler.lastAdapterError?.includes("connection refused"));
  stack.fake.outage = null;
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
});

test("native approval requests surface in the room and are answered through T3", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "run the tests", schedule: { mode: "now" } });
  await stack.tick(2);
  const requestId = stack.fake.raiseApproval(stack.threadOf("sol1"));
  await stack.tick();
  assert.equal(stack.task(1).state, "needs_input");
  const open = stack.repos.listOpenNativeRequests([stack.participants.sol1!]);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.requestId, requestId);
  await stack.run({ type: "native.approval.respond", participantId: stack.participants.sol1!, requestId, decision: "accept" });
  await stack.tick();
  assert.equal(stack.repos.listOpenNativeRequests([stack.participants.sol1!]).length, 0);
  assert.equal(stack.task(1).state, "running");
});

test("context: earlier unseen decisions survive multiple sibling replies and own output is not replayed", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: "Decision: keep the public API stable." });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "first", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "first reply" });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "second", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "second reply" });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review all", schedule: { mode: "now" } });
  await stack.tick(2);
  const sol2Briefing = stack.repos.listRunsForTask(stack.task(3).id)[0]!.briefing;
  assert.match(sol2Briefing, /Decision: keep the public API stable/);
  assert.match(sol2Briefing, /first reply/);
  assert.match(sol2Briefing, /second reply/);
  const sol1Second = stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing;
  assert.doesNotMatch(sol1Second, /first reply/, "a participant's own output is not replayed to it");
  assert.doesNotMatch(sol1Second, /Decision: keep the public API/, "already delivered context is not repeated");
});

test("rebinding requires explicit handling of outstanding tasks", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "later", schedule: { mode: "manual" } });
  await stack.run({ type: "participant.rebind", participantId: stack.participants.sol2!, thread: { mode: "create" }, outstandingTasks: "block" });
  assert.equal(stack.task(1).state, "blocked");
  assert.equal(stack.repos.getParticipant(stack.participants.sol2!)!.bindingGeneration, 2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "busy", schedule: { mode: "now" } });
  await stack.tick(2);
  await assert.rejects(stack.run({ type: "participant.rebind", participantId: stack.participants.sol1!, thread: { mode: "create" }, outstandingTasks: "carry" }), /work in progress/);
});

test("alias uniqueness is case-insensitive", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "SOL1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } }),
    /already used/,
  );
});

test("a provider start failure after acceptance fails the task visibly instead of hanging", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  stack.fake.startFailure = "codex is not signed in";
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "implement", schedule: { mode: "now" } });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "failed");
  assert.match(stack.task(1).stateReason ?? "", /not signed in/);
  assert.equal(stack.task(2).state, "blocked");
  stack.fake.startFailure = null;
  await stack.run({ type: "task.retry", taskId: stack.task(1).id, revision: 1, reattachDependents: true });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
});

test("a thread deleted in T3 is surfaced as missing, blocks new work, and the participant can be removed", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "later", schedule: { mode: "manual" } });
  // Delete sol1's thread on the T3 side.
  stack.fake.threads.delete(stack.threadOf("sol1"));
  await stack.tick();
  assert.equal(stack.scheduler.participantStatus(stack.participants.sol1!).threadMissing, true);
  await stack.run({ type: "task.release", taskId: stack.task(1).id, revision: 1 });
  await stack.tick();
  assert.equal(stack.task(1).state, "blocked");
  assert.match(stack.task(1).stateReason ?? "", /deleted; rebind/);
  // Remove the participant, keeping the task for reassignment.
  await stack.run({ type: "participant.retire", participantId: stack.participants.sol1!, pendingTasks: "keep" });
  const sol1 = stack.repos.getParticipant(stack.participants.sol1!)!;
  assert.ok(sol1.retiredAt);
  assert.equal(stack.repos.listActiveParticipants(stack.roomId).length, 2);
  await assert.rejects(stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "x", schedule: { mode: "now" } }), /removed/);
  // Reassign to sol2 and it runs.
  await stack.run({ type: "task.update", taskId: stack.task(1).id, revision: 1, participantId: stack.participants.sol2!, schedule: { mode: "now" } });
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  // The alias can be reused by a new participant.
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } });
});

test("roles: rules travel with every delivery and can change without touching the thread", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const role = (await stack.run({ type: "role.create", name: "accountant", rules: "Reconcile every figure twice." })) as { roleId: string };
  await stack.run({ type: "participant.update", participantId: stack.participants.sol1!, roleId: role.roleId });
  assert.equal(stack.repos.getParticipant(stack.participants.sol1!)!.roleId, role.roleId);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "close the books", schedule: { mode: "now" } });
  await stack.tick(2);
  const firstRun = stack.repos.listRunsForTask(stack.task(1).id)[0]!;
  assert.match(firstRun.briefing, /with the role "accountant"/);
  assert.match(firstRun.briefing, /Reconcile every figure twice\./);
  await stack.run({ type: "role.update", roleId: role.roleId, rules: "Reconcile once; flag anomalies." });
  await stack.run({ type: "role.delete", roleId: role.roleId });
  assert.equal(stack.repos.getParticipant(stack.participants.sol1!)!.roleId, null, "deleting a role clears it from holders");
});

test("the room follows the thread: model changes made in T3 are mirrored, and the room can change options through T3", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  // A participant created without a model gets T3's default for the project.
  const added = (await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "alice", thread: { mode: "create" } })) as { participantId: string };
  assert.equal(stack.repos.getParticipant(added.participantId)!.modelSelection.model, "claude-fable-5-1");
  // Someone changes the effort in T3 Code: the next tick mirrors it.
  const thread = stack.fake.threads.get(stack.repos.currentBinding(added.participantId)!.threadId)!;
  thread.shell.modelSelection = { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "max" }] };
  await stack.tick();
  assert.deepEqual(stack.repos.getParticipant(added.participantId)!.modelSelection.options, [{ id: "effort", value: "max" }]);
  // The room changes options through T3; the provider cannot change.
  await stack.run({ type: "participant.model.set", participantId: added.participantId, modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5", options: [{ id: "effort", value: "low" }] } });
  assert.equal(thread.shell.modelSelection.model, "claude-sonnet-5");
  await assert.rejects(stack.run({ type: "participant.model.set", participantId: added.participantId, modelSelection: { instanceId: "codex", model: "gpt-6-sol" } }), /cannot switch provider/);
  // Dispatch does not pin a model: T3 applies whatever the thread currently has.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [added.participantId], instruction: "hello", schedule: { mode: "now" } });
  await stack.tick();
  const start = stack.fake.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === thread.shell.id)[0]!;
  assert.equal((start.payload as { modelSelection?: unknown }).modelSelection, undefined);
});

test("attaching an existing thread inherits its model, options, and permission mode from T3", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  // A thread that already exists in T3 with its own configuration.
  await stack.fake.createThread({ commandId: "c-ext", threadId: "thread-ext", projectId: "project_demo", title: "Existing work", modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "xhigh" }] }, runtimeMode: "approval-required", interactionMode: "plan" });
  const added = (await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "legacy", thread: { mode: "attach", threadId: "thread-ext" } })) as { participantId: string };
  const participant = stack.repos.getParticipant(added.participantId)!;
  assert.deepEqual(participant.modelSelection, { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "xhigh" }] });
  assert.equal(participant.runtimeMode, "approval-required");
  assert.equal(participant.interactionMode, "plan");
});
