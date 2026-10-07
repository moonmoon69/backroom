/** rooms-board reseat: a checkpoint post from the member, then a fresh seat of the same crew member takes over with it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";
import { Board } from "../src/app/board.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { readReseats } from "../src/app/reseat.ts";
import type { Participant } from "../src/domain/types.ts";
import { T3Unavailable } from "../src/adapter/types.ts";

const board = (stack: TestStack) =>
  new Board({
    repos: stack.repos,
    execute: (command) => stack.service.execute(parseCommand(command)),
    afterSeat: () => stack.tick(2),
    statusOf: (participantId) => stack.scheduler.participantStatus(participantId),
  });
const key = (stack: TestStack, alias: string) => agentKey(alias, stack.roomId);
const member = (stack: TestStack, alias: string): Participant => {
  const found = stack.repos.listParticipants(stack.roomId).find((p) => p.alias === alias);
  if (!found) throw new Error(`no member ${alias}`);
  return found;
};
const threadOf = (stack: TestStack, alias: string) => stack.repos.currentBinding(member(stack, alias).id)!.threadId;
const tasksOf = (stack: TestStack, alias: string) => stack.repos.listTasks(stack.roomId).filter((t) => t.participantId === member(stack, alias).id);
const runOf = (stack: TestStack, taskId: string) => stack.repos.listRunsForTask(taskId)[0];
const finish = async (stack: TestStack, alias: string, text: string, outcome?: "error") => {
  stack.fake.completeRun(threadOf(stack, alias), outcome ? { text, outcome } : { text });
  await stack.tick(3);
};

/** A room with a Consigliere (alice) who seated a saved crew member (carol); every seat briefing answered. */
async function room() {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice"]);
  await stack.run({ type: "preset.create", name: "carol", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } });
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await board(stack).run(["seat", "carol"], key(stack, "alice"));
  await finish(stack, "carol", "Seated.");
  return stack;
}

test("reseat: the member writes its checkpoint after the work in hand; a fresh seat of the same crew member takes over with it and its pending tasks", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  await board(stack).run(["post", "@carol Build the parser."], key(stack, "alice"));
  await board(stack).run(["state", "Parser first, then its tests."], key(stack, "alice"));
  await stack.tick(2);
  const build = tasksOf(stack, "carol").find((task) => task.instruction === "Build the parser.")!;
  assert.equal(stack.repos.getTask(build.id)!.state, "running");

  await assert.rejects(board(stack).run(["reseat", "alice"], key(stack, "carol")), /only this room's Consigliere \(@alice\) reseats members/);
  await assert.rejects(board(stack).run(["reseat", "nobody"], key(stack, "alice")), /nobody called @nobody/);
  const out = await board(stack).run(["reseat", "@carol", "item", "2", "of", "docs/plan.md"], key(stack, "alice"));
  assert.match(out, /Asked @carol for its checkpoint: task\d+ \(post #\d+\)\. It runs when @carol has finished the work in hand\./);
  assert.match(out, /a fresh seat of the same crew member takes over @carol's work and pending tasks with it and your plan/);
  await assert.rejects(board(stack).run(["reseat", "carol"], key(stack, "alice")), /being reseated already/);
  assert.match(await board(stack).run(["members"], key(stack, "alice")), /@carol · gpt-6-sol · .* · being reseated \(checkpoint task\d+\)/);
  const checkpoint = tasksOf(stack, "carol").find((task) => task.instruction.startsWith("Reseat:"))!;
  assert.match(checkpoint.instruction, /Stop at a commit boundary/);
  assert.match(checkpoint.instruction, /the state of the code: folder, branch, last commit/);
  assert.match(checkpoint.instruction, /What the fresh seat will carry on with: item 2 of docs\/plan\.md/);
  const request = stack.repos.getEvent(checkpoint.sourceEventId)!;
  assert.equal(request.kind, "member.message", "the request is a post on the board, from the Consigliere");
  assert.equal(request.to, member(stack, "carol").id);
  // Work posted after the reseat waits behind the checkpoint, and goes to the fresh seat.
  await board(stack).run(["post", "@carol Then write its tests."], key(stack, "alice"));

  // Never mid-edit: the checkpoint waits for the work in hand.
  await stack.tick(2);
  assert.equal(stack.repos.getTask(checkpoint.id)!.state, "queued");
  await finish(stack, "carol", "Parser built.\n\nHandoff: src/parser.ts.");
  await finish(stack, "alice", "Noted.");
  assert.equal(stack.repos.getTask(checkpoint.id)!.state, "running");
  const wakesBefore = tasksOf(stack, "alice").filter((task) => task.kind === "wake").length;
  await finish(stack, "carol", "Checkpoint: decisions A and B; dead end C; branch main at abc123; next step: tests.");

  // The same tick: carol has left, carol2 is seated where she worked and has her pending task and the takeover.
  const old = member(stack, "carol");
  assert.ok(old.retiredAt, "the old seat left the room");
  const fresh = member(stack, "carol2");
  assert.equal(fresh.retiredAt, null);
  assert.equal(fresh.presetId, old.presetId, "the same saved crew member");
  assert.deepEqual(readReseats(stack.repos, stack.roomId), [], "nothing left in progress");
  const checkpointPost = stack.repos.getEvent(stack.repos.getRun(stack.repos.getTask(checkpoint.id)!.currentRunId!)!.resultEventId!)!;
  const takeover = tasksOf(stack, "carol2").find((task) => task.instruction.startsWith("You take over"))!;
  assert.match(takeover.instruction, new RegExp(`You take over @carol's work: .* Its pending tasks are yours now\\.`));
  assert.match(takeover.instruction, new RegExp(`Its checkpoint is post #${checkpointPost.postNumber}, above in full`));
  assert.match(takeover.instruction, /What to carry on with: item 2 of docs\/plan\.md/);
  assert.match(takeover.instruction, /Your answer goes to @alice, as @carol's would have\./);
  assert.deepEqual(takeover.prerequisites, [{ taskId: checkpoint.id, revision: 1 }]);
  const tests = stack.repos.listTasks(stack.roomId).find((task) => task.instruction === "Then write its tests.")!;
  assert.equal(tests.participantId, fresh.id, "the pending task moved to the fresh seat");
  assert.deepEqual(tests.prerequisites.at(-1), { taskId: takeover.id, revision: 1 }, "and runs after the takeover");
  assert.equal(tasksOf(stack, "alice").filter((task) => task.kind === "wake").length, wakesBefore + 1, "the Consigliere is not woken by the checkpoint, only after the takeover");
  assert.ok(stack.repos.listEvents(stack.roomId).some((e) => e.kind === "system" && /@carol reseated: @carol2 takes over from its checkpoint #\d+/.test(e.text)));

  // The fresh seat gets the seat briefing first, then the takeover with the checkpoint in full.
  const seat = tasksOf(stack, "carol2").find((task) => task.kind === "seat")!;
  assert.ok(runOf(stack, seat.id), "the seat briefing went out");
  assert.match(runOf(stack, seat.id)!.briefing, /Parser first, then its tests\./, "with the room state");
  await finish(stack, "carol2", "Seated.");
  const takeoverRun = runOf(stack, takeover.id)!;
  assert.ok(takeoverRun);
  assert.match(takeoverRun.briefing, /Checkpoint: decisions A and B; dead end C; branch main at abc123; next step: tests\./);
  assert.match(takeoverRun.briefing, /You take over @carol's work/);
  assert.equal(runOf(stack, tests.id), undefined, "the moved task waits for the takeover");
  await finish(stack, "carol2", "Tests are next; started.");
  assert.ok(runOf(stack, tests.id), "then the moved task goes out");
  const wake = tasksOf(stack, "alice").filter((task) => task.kind === "wake").find((task) => task.prerequisites.some((p) => p.taskId === takeover.id))!;
  assert.deepEqual(wake.prerequisites, [{ taskId: takeover.id, revision: 1 }]);
  assert.ok(runOf(stack, wake.id), "the Consigliere is woken when the takeover ends");
});

test("reseat of the Consigliere himself: his checkpoint, then a fresh seat takes the mark, his pending wakes, and no member's seat briefing", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  // alice was not seated from a saved crew member: the fresh seat takes her settings and her alias with a number.
  await board(stack).run(["post", "@carol Long job."], key(stack, "alice"));
  await stack.run({ type: "room.note.create", roomId: stack.roomId, text: "old history the fresh seat should not be fed" });
  await board(stack).run(["state", "Plan item 3 of 7; carol is on the long job."], key(stack, "alice"));
  const out = await board(stack).run(["reseat", "alice", "the plan is in post 1"], key(stack, "alice"));
  assert.match(out, /takes over as this room's Consigliere with it and your plan, and you leave the room/);
  assert.match(out, /End your turn now: the checkpoint is your next task\./);
  await stack.tick(2);
  const checkpoint = tasksOf(stack, "alice").find((task) => task.instruction.startsWith("Reseat:"))!;
  assert.match(checkpoint.instruction, /takes over as this room's Consigliere/);
  assert.match(checkpoint.instruction, /what is in flight: each member's task and what you are waiting for/);
  assert.equal(stack.repos.getTask(checkpoint.id)!.state, "running");
  const pendingWake = tasksOf(stack, "alice").find((task) => task.kind === "wake" && task.state === "queued")!;

  await finish(stack, "alice", "Checkpoint: carol is on the long job; the user wants X.");
  const fresh = member(stack, "alice2");
  assert.ok(member(stack, "alice").retiredAt);
  assert.equal(stack.repos.getRoom(stack.roomId)!.consigliereId, fresh.id, "the mark moved to the fresh seat");
  assert.equal(stack.repos.getTask(pendingWake.id)!.participantId, fresh.id, "his pending wake is the fresh seat's now");
  assert.ok(!tasksOf(stack, "alice2").some((task) => task.kind === "seat"), "no member's seat briefing for a Consigliere");
  const moved = tasksOf(stack, "carol").filter((task) => task.kind === "seat" && /now @alice2/.test(task.instruction));
  assert.equal(moved.length, 1, "the members are told who the Consigliere is now");
  assert.ok(!tasksOf(stack, "alice").some((task) => task.kind === "seat" && task.state === "queued"), "the old seat is not told");

  const takeover = tasksOf(stack, "alice2").find((task) => task.instruction.startsWith("You take over as this room's Consigliere from @alice"))!;
  assert.match(takeover.instruction, /The members have been told you are the Consigliere now\./);
  assert.doesNotMatch(takeover.instruction, /Your answer goes to/, "a Consigliere's answer goes to the user");
  assert.equal(stack.repos.getEvent(takeover.sourceEventId)!.kind, "system");
  const run = runOf(stack, takeover.id)!;
  assert.ok(run, "his first task went out in the same tick");
  assert.match(run.briefing, /You are "alice2", the Consigliere/);
  assert.match(run.briefing, /Checkpoint: carol is on the long job; the user wants X\./);
  assert.match(run.briefing, /Plan item 3 of 7; carol is on the long job\./, "a new seat's first delivery carries the room state");
  assert.doesNotMatch(run.briefing, /old history the fresh seat should not be fed/, "the room's history is on the board, not in his first delivery");
});

test("a reseat whose checkpoint fails is called off: the member stays and the Consigliere is woken", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  await board(stack).run(["reseat", "carol"], key(stack, "alice"));
  await stack.tick(2);
  await finish(stack, "carol", "(crashed)", "error");
  assert.equal(member(stack, "carol").retiredAt, null, "carol stays");
  assert.ok(!stack.repos.listParticipants(stack.roomId).some((p) => p.alias === "carol2"), "no fresh seat");
  assert.deepEqual(readReseats(stack.repos, stack.roomId), []);
  assert.ok(stack.repos.listEvents(stack.roomId).some((e) => e.kind === "system" && /Reseat of @carol called off: its checkpoint task\d+ failed/.test(e.text)));
  const wake = tasksOf(stack, "alice").filter((task) => task.kind === "wake").at(-1)!;
  assert.match(wake.instruction, /The reseat of @carol was called off: its checkpoint task\d+ failed.*@carol stays seated as it was\./);
});

test("members shows each member's context meter, and says when there is none", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  const meters = new Board({
    repos: stack.repos,
    execute: (command) => stack.service.execute(parseCommand(command)),
    contextOf: (participant) =>
      participant.alias === "carol"
        ? { available: true, reason: null, tokens: 575_000, peak: 930_000, compactions: 6, lastCompactionAt: null, window: 1_000_000, windowSource: "manifest", nearCompaction: false, at: null }
        : { available: false, reason: "not_claude", tokens: null, peak: null, compactions: 0, lastCompactionAt: null, window: null, windowSource: null, nearCompaction: false, at: null },
  });
  const members = await meters.run(["members"], key(stack, "alice"));
  assert.match(members, /@carol · gpt-6-sol · ready · context ≈ 575k, 6 compactions · thread /);
  assert.match(members, /@alice \(the Consigliere\) · gpt-6-sol · ready · no meter · thread /);
});

test("a reseat is called off when T3 cannot say where the member worked; T3 being away only delays it", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  const carolThread = threadOf(stack, "carol");
  // Only the reseat's own look at the old thread is affected: the scheduler still sees it.
  let inReseat = false;
  let away = 1;
  const shellOf = stack.fake.getThreadShell.bind(stack.fake);
  stack.fake.getThreadShell = async (threadId: string) => {
    if (!inReseat || threadId !== carolThread) return shellOf(threadId);
    if (away > 0) {
      away -= 1;
      throw new T3Unavailable("T3 is restarting");
    }
    return null;
  };
  const advance = stack.service.advanceReseats.bind(stack.service);
  stack.service.advanceReseats = async (touched: Set<string>) => {
    inReseat = true;
    try {
      await advance(touched);
    } finally {
      inReseat = false;
    }
  };
  await board(stack).run(["reseat", "carol"], key(stack, "alice"));
  await stack.tick(2);
  stack.fake.completeRun(carolThread, { text: "Checkpoint: all of it." });
  await stack.tick(1);
  assert.equal(readReseats(stack.repos, stack.roomId).length, 1, "T3 away: still in progress, tried again next tick");
  assert.equal(member(stack, "carol").retiredAt, null);
  await stack.tick(2);
  assert.deepEqual(readReseats(stack.repos, stack.roomId), []);
  assert.equal(member(stack, "carol").retiredAt, null, "carol stays");
  assert.ok(!stack.repos.listParticipants(stack.roomId).some((p) => p.alias === "carol2"), "no fresh seat in another folder");
  const wake = tasksOf(stack, "alice").filter((task) => task.kind === "wake").at(-1)!;
  assert.match(wake.instruction, /The reseat of @carol was called off: the fresh seat could not be made: T3 no longer has @carol's thread, so where it worked is unknown/);
});

test("a reseat whose checkpoint is blocked (its thread gone from T3) is called off, and the member can be reseated again", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  const carolThread = threadOf(stack, "carol");
  let gone = true;
  const list = stack.fake.listThreads.bind(stack.fake);
  stack.fake.listThreads = async () => (await list()).filter((shell) => !gone || shell.id !== carolThread);
  await board(stack).run(["reseat", "carol"], key(stack, "alice"));
  const checkpoint = tasksOf(stack, "carol").find((task) => task.instruction.startsWith("Reseat:"))!;
  await stack.tick(3);
  assert.equal(member(stack, "carol").retiredAt, null);
  assert.deepEqual(readReseats(stack.repos, stack.roomId), [], "no longer 'being reseated'");
  assert.ok(stack.repos.listEvents(stack.roomId).some((e) => e.kind === "system" && /Reseat of @carol called off: its checkpoint task\d+ blocked \(T3 thread for @carol was deleted/.test(e.text)));
  assert.equal(stack.repos.getTask(checkpoint.id)!.state, "cancelled", "the blocked checkpoint will not run later for nothing");
  const wake = tasksOf(stack, "alice").filter((task) => task.kind === "wake").at(-1)!;
  assert.match(wake.instruction, /The reseat of @carol was called off: its checkpoint task\d+ blocked/);
  gone = false;
  assert.match(await board(stack).run(["reseat", "carol"], key(stack, "alice")), /Asked @carol for its checkpoint/, "a second reseat is not refused");
});
