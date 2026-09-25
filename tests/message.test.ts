import assert from "node:assert/strict";
import { test } from "node:test";
import type { StartTurnInput } from "../src/adapter/types.ts";
import { parseExplicit } from "../src/parser/explicit.ts";
import { createTestStack } from "./helpers.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("one message becomes several assignments; a later one waits for the earlier one it names", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const participants = stack.repos.listActiveParticipants(stack.roomId).map((p) => ({ id: p.id, alias: p.alias }));
  const text = "@sol1 fix the webhook parser. @sol2 check sol1's work";
  const draft = parseExplicit(text, participants, []);
  await stack.run({
    type: "message.create",
    roomId: stack.roomId,
    sourceText: text,
    assignments: draft.assignments.map((a) => ({ recipients: a.recipients, instruction: a.instruction, schedule: a.schedule ?? { mode: "now" }, after: a.after.map((d) => d.index) })),
  });
  const [fix, check] = [stack.task(1), stack.task(2)];
  assert.equal(fix.participantId, stack.participants.sol1);
  assert.equal(check.participantId, stack.participants.sol2);
  assert.equal(fix.sourceEventId, check.sourceEventId, "one room message");
  assert.deepEqual(check.prerequisites, [{ taskId: fix.id, revision: 1 }]);
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running");
  assert.equal(stack.task(2).state, "queued");
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Fixed in src/webhook.ts" });
  await stack.tick(3);
  assert.equal(stack.task(2).state, "running");
  const briefing = stack.repos.listRunsForTask(check.id)[0]!.briefing;
  assert.match(briefing, /== Your assignment \(task2\) ==\ncheck sol1's work/);
  assert.match(briefing, /Fixed in src\/webhook\.ts/);
});

test("message.create rejects forward references and held assignments that also wait", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await assert.rejects(
    stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "x", after: [0] }] }),
    /earlier assignment/,
  );
  await assert.rejects(
    stack.run({
      type: "message.create",
      roomId: stack.roomId,
      assignments: [
        { recipients: [stack.participants.sol1!], instruction: "x" },
        { recipients: [stack.participants.sol2!], instruction: "y", schedule: { mode: "manual" }, after: [0] },
      ],
    }),
    /held assignment/,
  );
});

test("attached images are delivered inline with every turn of the message, and identically on resend", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const image = stack.service.storeAttachment({ roomId: stack.roomId, name: "bug.png", mimeType: "image/png", data: PNG });
  assert.throws(() => stack.service.storeAttachment({ roomId: stack.roomId, name: "x.svg", mimeType: "image/svg+xml", data: PNG }), /PNG, JPEG, GIF, or WebP/);
  await stack.run({
    type: "message.create",
    roomId: stack.roomId,
    attachmentIds: [image.id],
    assignments: [{ recipients: [stack.participants.sol1!, stack.participants.sol2!], instruction: "" }],
  });
  const event = stack.repos.getEvent(stack.task(1).sourceEventId)!;
  assert.deepEqual(event.attachmentIds, [image.id]);
  await stack.tick();
  const starts = stack.fake.commands.filter((c) => c.type === "thread.turn.start").map((c) => c.payload as StartTurnInput);
  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.equal(start.images?.length, 1);
    assert.equal(start.images?.[0]?.dataUrl, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    assert.match(start.text, /Images attached to this message: bug\.png/);
  }
  await assert.rejects(
    stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "" }] }),
    /instruction is empty/,
  );
});

test("the reply is the turn's final message; earlier messages in the turn are kept as progress", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "fix it", schedule: { mode: "now" } });
  await stack.tick(2);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] } });
  // T3 attaches the checkpoint to the message the file changes belong to, which can be a progress note.
  stack.fake.completeTurn(stack.threadOf("sol1"), { progress: ["Reading the parser first.", "Found it; patching."], checkpointOnProgress: 1, text: "Fixed. Handoff: src/parser.ts" });
  await stack.tick(3);
  const reply = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "assistant.reply")!;
  assert.equal(reply.text, "Fixed. Handoff: src/parser.ts");
  assert.deepEqual(reply.progress.map((p) => p.text), ["Reading the parser first.", "Found it; patching."]);
  const briefing = stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing;
  assert.match(briefing, /Fixed\. Handoff/);
  assert.doesNotMatch(briefing, /Reading the parser first/, "dependents receive the final answer, not the progress notes");
});

test("turns typed directly in T3 appear in the timeline once, display only; room turns are not duplicated", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  stack.fake.startExternalTurn(thread, "what does the parser do?");
  await stack.tick();
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "t3.turn").length, 0, "nothing while running");
  stack.fake.completeTurn(thread, { progress: ["Reading src/parser.ts."], text: "It splits messages into assignments." });
  await stack.tick(3);
  const direct = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "t3.turn");
  assert.equal(direct.length, 1);
  assert.equal(direct[0]!.text, "It splits messages into assignments.");
  assert.equal(direct[0]!.prompt, "what does the parser do?");
  assert.deepEqual(direct[0]!.progress.map((p) => p.text), ["Reading src/parser.ts."]);

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "fix it", schedule: { mode: "now" } });
  await stack.tick(2);
  stack.fake.completeTurn(thread, { text: "Fixed." });
  await stack.tick(3);
  const events = stack.repos.listEvents(stack.roomId);
  assert.equal(events.filter((e) => e.kind === "t3.turn").length, 1, "the room's own turn is a reply, not a direct turn");
  assert.equal(events.filter((e) => e.kind === "assistant.reply").length, 1);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "next", schedule: { mode: "now" } });
  await stack.tick(2);
  const briefing = stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing;
  assert.doesNotMatch(briefing, /splits messages into assignments/, "direct T3 turns are never briefed");
});

test("a turn the agent starts itself (background task finished) has no prompt, not an earlier one", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const thread = stack.threadOf("sol1");
  stack.fake.startExternalTurn(thread, "continue to implement");
  stack.fake.completeTurn(thread, { text: "Checks running; waiting for the notification." });
  await stack.tick(2);
  stack.fake.startSelfTurn(thread);
  stack.fake.completeTurn(thread, { text: "Checks green. Done." });
  await stack.tick(2);
  const direct = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "t3.turn");
  assert.deepEqual(direct.map((e) => [e.prompt, e.text]), [
    ["continue to implement", "Checks running; waiting for the notification."],
    [null, "Checks green. Done."],
  ]);
});

test("a message that is only this participant's assignment is not repeated in the briefing; a split message is", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "check the logs", sourceText: "@sol1 check the logs", schedule: { mode: "now" } });
  await stack.tick();
  const solo = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.equal(solo.split("check the logs").length, 2, "once, in the assignment");
  assert.doesNotMatch(solo, /== Shared room messages/);

  await stack.run({
    type: "message.create",
    roomId: stack.roomId,
    sourceText: "@sol2 fix the parser. @claude update the docs",
    assignments: [
      { recipients: [stack.participants.sol2!], instruction: "fix the parser." },
      { recipients: [stack.participants.claude!], instruction: "update the docs" },
    ],
  });
  await stack.tick();
  const split = stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing;
  assert.match(split, /\[#\d+ user\]\n@sol2 fix the parser\. @claude update the docs/, "the whole message stays as context");
});

test("a turn that just started is not declared gone when T3's thread list lags behind its detail read", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  // Freeze the list read as it is now (no turn), like T3's list lagging the detail read by a moment.
  stack.fake.staleShellList = [...stack.fake.threads.values()].map((thread) => structuredClone(thread.shell));
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "go", schedule: { mode: "now" } });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "running", "not failed with 'T3 no longer reports this turn'");
  stack.fake.staleShellList = null;
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Done." });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
});

test("a run wrongly failed as 'no longer reported' is revived when its turn shows up, and a queued retry is not sent twice", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "go", schedule: { mode: "now" } });
  await stack.tick(2);
  const task = stack.task(1);
  const run = stack.repos.getRun(task.currentRunId!)!;
  // The false alarm, as it happened on 2026-09-24: the run marked failed while its T3 turn was still running.
  stack.repos.updateRun({ ...run, status: "failed", error: "T3 no longer reports this turn (thread may have been reverted or history rewritten)", completedAt: new Date().toISOString() });
  stack.service.setTaskState(task, "failed", "T3 no longer reports this turn", { currentRunId: run.id });
  // The user presses Retry.
  await stack.run({ type: "task.retry", taskId: task.id, revision: task.revision, reattachDependents: true });
  assert.equal(stack.task(1).state, "queued");
  await stack.tick(2);
  assert.equal(stack.task(1).state, "running", "tracking the original turn again");
  assert.equal(stack.task(1).currentRunId, run.id);
  assert.equal(stack.fake.commands.filter((c) => c.type === "thread.turn.start").length, 1, "the retry was not delivered");
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Done." });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "assistant.reply").at(-1)?.text, "Done.");
});

test("a T3 slash command is sent verbatim (no briefing), and unknown commands are refused", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await assert.rejects(
    stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "/frobnicate", slashCommand: true }] }),
    /no \/frobnicate command/,
  );
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "/compact focus on the parser", slashCommand: true }] });
  await stack.tick();
  const start = stack.fake.commands.filter((c) => c.type === "thread.turn.start").at(-1)!.payload as StartTurnInput;
  assert.equal(start.text, "/compact focus on the parser");
  stack.fake.completeTurn(stack.threadOf("sol1"), { text: "Compacted." });
  await stack.tick(3);
  assert.equal(stack.task(1).state, "succeeded");
  // The next ordinary assignment still gets the room briefing (the command did not consume it).
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "now review", schedule: { mode: "now" } });
  await stack.tick();
  assert.match(stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing, /T3 Rooms briefing/);
});
