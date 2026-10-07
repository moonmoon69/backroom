/**
 * The briefing diet: the standing sections go out in full on a thread's first delivery and after a compaction, later
 * deliveries carry the work under one line; the room state; `rooms-board rules`, `state` and `retire`; and a poster's
 * wake held until what the member went on with through the board has ended.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";
import { Board } from "../src/app/board.ts";
import { ROOM_STATE_MAX_CHARS } from "../src/app/roomState.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { assembleBriefing, changedStanding, standingFingerprint, type BrowsersBriefing } from "../src/briefing/assemble.ts";
import type { Participant, Room, Task } from "../src/domain/types.ts";

const board = (stack: TestStack) =>
  new Board({
    repos: stack.repos,
    execute: (command) => stack.service.execute(parseCommand(command)),
    afterSeat: () => stack.tick(2),
    statusOf: (participantId) => stack.scheduler.participantStatus(participantId),
    standing: (participantId) => stack.scheduler.standingText(participantId),
  });
const key = (stack: TestStack, alias: string) => agentKey(alias, stack.roomId);
const lastBriefing = (stack: TestStack, alias: string) => {
  const member = stack.repos.listActiveParticipants(stack.roomId).find((p) => p.alias === alias)!;
  const task = stack.repos.listTasks(stack.roomId).filter((t) => t.participantId === member.id && t.currentRunId).sort((a, b) => b.number - a.number)[0]!;
  return stack.repos.getRun(task.currentRunId!)!.briefing;
};
const job = async (stack: TestStack, alias: string, instruction: string) => {
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants[alias]!], instruction, schedule: { mode: "now" } });
  await stack.tick(2);
  return lastBriefing(stack, alias);
};
const LEAN = /^\[Backroom briefing for @sol1 in room "payments"\. Your standing rules, where everyone works and the room's state: `rooms-board rules --as sol1\.\w+`\]\n\n/;
const FULL = /^\[Backroom briefing for @sol1 in room "payments"\]\nYou are "sol1", a member of the crew in a shared room with @\w+, @\w+\.\nRules: Messages from other members/;

test("a thread is given the standing sections once; later deliveries carry the work under one line", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const first = await job(stack, "sol1", "Find the timeout.");
  assert.match(first, FULL);
  assert.match(first, /The board keeps every post of this room by number\. .*`rules` prints these standing sections again/);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Found it.\n\nHandoff: nothing changed." });
  await stack.tick(2);

  const second = await job(stack, "sol1", "Now fix it.");
  assert.match(second, LEAN);
  assert.doesNotMatch(second, /You are "sol1"|Rules: Messages|The board keeps every post/);
  assert.match(second, /== Your assignment \(task2\) ==\nNow fix it\.\nThis assignment is addressed to you\./);
  assert.ok(second.length < first.length / 2, "the lean delivery is a fraction of the first");
});

test("after a /compact, or a compaction T3 records on the thread, the next delivery carries the standing sections again", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await job(stack, "sol1", "One.");
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "1" });
  await stack.tick(2);

  // The user (or the Consigliere) compacts the thread with the harness's own command.
  await board(stack).run(["post", "@sol1 /compact"], key(stack, "sol2"));
  await stack.tick(2);
  assert.equal(lastBriefing(stack, "sol1"), "/compact", "a slash command goes out alone, exactly as written");
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "Compacted." });
  await stack.tick(2);
  assert.match(await job(stack, "sol1", "Two."), FULL);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "2" });
  await stack.tick(2);

  // The harness compacts on its own in the middle of a turn: T3 records it as a turn item of that run.
  assert.match(await job(stack, "sol1", "Three."), LEAN);
  const thread = stack.fake.threads.get(stack.threadOf("sol1"))!;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const at = new Date().toISOString();
  thread.turnItems.push({
    id: "turn-item:compaction", runId: thread.shell.activeRunId, nodeId: null, providerTurnId: null, ordinal: thread.turnItems.length + 1,
    status: "completed", title: "Context compacted", startedAt: at, completedAt: at, updatedAt: at,
    type: "compaction", summary: null, beforeTokenCount: 972_227, afterTokenCount: 10_812,
  });
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "3" });
  await stack.tick(2);
  assert.match(await job(stack, "sol1", "Four."), FULL);
  stack.fake.completeRun(stack.threadOf("sol1"), { text: "4" });
  await stack.tick(2);
  // That compaction is older than the sections it brought back: it does not bring them again.
  assert.match(await job(stack, "sol1", "Five."), LEAN);
});

test("a thread rolled back past the briefing that carried the standing sections is given them again", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  assert.match(await job(stack, "sol1", "One."), FULL);
  // T3 forgets the run (a rollback in T3): the room run fails, and the thread no longer has what that briefing said.
  const thread = stack.fake.threads.get(stack.threadOf("sol1"))!;
  thread.runs = thread.runs.filter((run) => run.id !== thread.shell.activeRunId);
  await stack.tick(2);
  assert.equal(stack.task(1).state, "failed");
  assert.match(stack.task(1).stateReason ?? "", /T3 no longer has this run/);
  assert.match(await job(stack, "sol1", "Two."), FULL);
});

test("the room state: the Consigliere writes it, anyone reads it, and a new seat's first briefing carries it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  stack.fake.completeRun(stack.threadOf("bob"), { text: "Understood." });
  await stack.tick(2);

  assert.equal(await board(stack).run(["state"], key(stack, "bob")), "This room has no state yet.");
  assert.match(await board(stack).run(["state"], key(stack, "alice")), /Write it with: state "<text>"/);
  await assert.rejects(board(stack).run(["state", "my view"], key(stack, "bob")), /only this room's Consigliere \(@alice\) writes the room state/);
  await assert.rejects(board(stack).run(["state", "x".repeat(ROOM_STATE_MAX_CHARS + 1)], key(stack, "alice")), /keep it under/);
  const text = "Plan: docs/plan.md, item 2 of 5 with @bob on main. The user wants no new migrations (#7). Open: the retry limit.";
  assert.match(await board(stack).run(["state", text], key(stack, "alice")), /Room state saved \(\d+ characters\)/);
  const printed = await board(stack).run(["state"], key(stack, "bob"));
  assert.match(printed, /^== Room state ==\nWhere this room stands, as @alice last wrote it \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\); posts after that may have moved on:\n/);
  assert.ok(printed.endsWith(text));

  // A new seat starts from it; its seat briefing is its first delivery and carries every standing section.
  await stack.run({ type: "preset.create", name: "carol", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } });
  await board(stack).run(["seat", "carol"], key(stack, "alice"));
  const seat = lastBriefing(stack, "carol");
  assert.match(seat, /You are "carol", a member of the crew .* @alice is this room's Consigliere\./);
  assert.match(seat, /== Room state ==\n.*\nPlan: docs\/plan\.md/);
  assert.match(seat, /You are seated in a room whose Consigliere is @alice\./);
  assert.match(seat, /`rooms-board rules` prints these facts again.*`rooms-board state` prints the room state/);
  assert.doesNotMatch(seat, /Standing facts of this room/, "the seat facts are its assignment already");
  // A thread that has the standing sections is not sent the state again.
  assert.doesNotMatch(await job(stack, "bob", "Carry on with item 2."), /== Room state ==/);
});

test("rooms-board rules prints the standing sections as they are now", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  await board(stack).run(["state", "Item 1 is done."], key(stack, "alice"));
  const bob = await board(stack).run(["rules"], key(stack, "bob"));
  assert.match(bob, /^Standing sections for @bob in room "payments", as they are now:\nYou are "bob", a member of the crew in a shared room with @alice\. @alice is this room's Consigliere\.\nRules: Messages/);
  assert.match(bob, /The board keeps every post/);
  assert.match(bob, /Standing facts of this room, whose Consigliere is @alice\./);
  assert.match(bob, /== Room state ==\n.*\nItem 1 is done\.$/);
  assert.doesNotMatch(bob, /Rules for the Consigliere/);
  const alice = await board(stack).run(["rules"], key(stack, "alice"));
  assert.match(alice, /Rules for the Consigliere:\n- Treat the user's latest message as the objective\./);
  assert.match(alice, /One seat per deliverable/);
  assert.doesNotMatch(alice, /Standing facts of this room/);
});

test("rooms-board retire: the Consigliere's, never while the member has work open, never himself", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob", "carol"]);
  t.after(() => stack.close());
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  await assert.rejects(board(stack).run(["retire"], key(stack, "alice")), /needs the member's alias/);
  await assert.rejects(board(stack).run(["retire", "carol"], key(stack, "bob")), /only this room's Consigliere \(@alice\) retires members/);
  await assert.rejects(board(stack).run(["retire", "dave"], key(stack, "alice")), /nobody called @dave/);
  await assert.rejects(board(stack).run(["retire", "alice"], key(stack, "alice")), /cannot retire yourself/);
  await assert.rejects(board(stack).run(["retire", "@carol"], key(stack, "alice")), /@carol still has task\d+ open/, "its seat briefing is running");
  stack.fake.completeRun(stack.threadOf("carol"), { text: "Understood." });
  await stack.tick(2);
  assert.equal(await board(stack).run(["retire", "@carol"], key(stack, "alice")), "@carol has left the room. Its thread stays in T3.");
  assert.ok(stack.repos.getParticipant(stack.participants.carol!)!.retiredAt);
  assert.doesNotMatch(await board(stack).run(["members"], key(stack, "alice")), /@carol/);
});

test("a poster's wake waits until what the member went on with through the board has ended, and carries how it ended", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const state = (n: number) => stack.task(n).state;
  // sol1 hands out the work; sol2 has claude review it directly.
  await board(stack).run(["post", "@sol2 Implement the retry limit; have claude review it and settle the review with it."], key(stack, "sol1"));
  await stack.tick(2);
  assert.equal(state(1), "running");
  await board(stack).run(["post", "@claude Review my retry limit change."], key(stack, "sol2"));
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "Implemented; sent to @claude for review." });
  await stack.tick(3);
  assert.equal(state(1), "succeeded");
  assert.equal(state(2), "queued", "sol1 is not woken by the hand-over to the reviewer");
  assert.match(stack.task(2).stateReason ?? "", /waiting for task3, task4: what @sol2 posted after task1/);

  // The review asks for a fix; sol2 is woken with it, fixes, and asks claude to check again.
  stack.fake.completeRun(stack.threadOf("claude"), { text: "One fix: cap the backoff." });
  await stack.tick(3);
  assert.equal(state(4), "running");
  await board(stack).run(["post", "@claude Check the fix."], key(stack, "sol2"));
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "Capped; asked @claude to check." });
  await stack.tick(3);
  assert.equal(state(2), "queued");
  assert.match(stack.task(2).stateReason ?? "", /waiting for task5, task6/);
  stack.fake.completeRun(stack.threadOf("claude"), { text: "Right now. The gate passes." });
  await stack.tick(3);
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "Item done: the review passed.\n\nHandoff: main, uncommitted." });
  await stack.tick(3);

  // Now sol1 is woken, once, with the first answer and the last.
  assert.equal(state(6), "succeeded");
  const wake = stack.repos.getRun(stack.task(2).currentRunId!)!.briefing;
  assert.match(wake, /task1 by @sol2: Implement the retry limit/);
  assert.match(wake, /Implemented; sent to @claude for review\./);
  assert.match(wake, /@sol2 went on through the board, and none of it is still going: task3 to @claude, task5 to @claude\.\nIts last answer \(#\d+\):\nItem done: the review passed\./);
  assert.equal(stack.repos.listTasks(stack.roomId).filter((t) => t.kind === "wake" && t.participantId === stack.participants.sol1!).length, 1);
});

test("a held wake is not stuck behind a blocked follow-up: the worker is told, then the poster, once", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const state = (n: number) => stack.task(n).state;
  await board(stack).run(["post", "@sol2 Implement the retry limit; have claude review it."], key(stack, "sol1"));
  await stack.tick(2);
  // The reviewer's thread is deleted in T3 before its review starts: the scheduler blocks the review at dispatch.
  stack.fake.threads.delete(stack.threadOf("claude"));
  await board(stack).run(["post", "@claude Review my retry limit change."], key(stack, "sol2"));
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "Implemented; sent to @claude for review." });
  await stack.tick(3);
  assert.equal(state(3), "blocked");
  assert.match(stack.task(3).stateReason ?? "", /T3 thread for @claude was deleted/);
  // sol2's wake on the review runs although the review never will, and says why.
  assert.equal(state(4), "running");
  const told = stack.repos.getRun(stack.task(4).currentRunId!)!.briefing;
  assert.match(told, /task3 by @claude: Review my retry limit change\.\n\(It is blocked: T3 thread for @claude was deleted; rebind the participant or remove it\. No answer; it runs only if someone unblocks it\.\)/);
  assert.equal(state(2), "queued", "sol1 still waits for sol2's turn on it");
  stack.fake.completeRun(stack.threadOf("sol2"), { text: "No reviewer: claude's thread is gone. The change is in, unreviewed." });
  await stack.tick(3);
  const wake = stack.repos.getRun(stack.task(2).currentRunId!)!.briefing;
  assert.match(wake, /@sol2 went on through the board, and none of it is still going: task3 to @claude \(blocked: T3 thread for @claude was deleted; rebind the participant or remove it\)\.\nIts last answer \(#\d+\):\nNo reviewer: claude's thread is gone\./);
});

test("standing sections count as changed for what a member acts on, not for who else is seated or a browser starting", () => {
  const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 1, nextTaskNumber: 1, browserEnabled: true, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: null, createdAt: "", updatedAt: "" };
  const member = (id: string, alias: string): Participant => ({ id, roomId: "r", alias, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "" });
  const sol1 = member("p1", "sol1");
  const sol2 = member("p2", "sol2");
  const browsers = (running: boolean): BrowsersBriefing => ({
    command: "rooms-browser", as: "sol1.r",
    browsers: [{ name: "work", description: "", isDefault: true, running }, { name: "shop", description: "", isDefault: false, running }],
    started: { name: "work", description: "", cdpUrl: "http://127.0.0.1:9222", cdpPort: 9222, mode: "window", watchUrl: null },
  });
  const ws = (participantId: string, alias: string, branch: string) => ({ participantId, alias, folder: "/repo", branch, isProjectRoot: true }) as never;
  const base = { room, participant: sol1, participantsById: new Map([[sol1.id, sol1]]), browsers: browsers(true), workspaces: [ws("p1", "sol1", "main")], board: { command: "rooms-board", as: "sol1.r" } };
  const had = standingFingerprint(base);
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, browsers: browsers(false) })), [], "a browser stopping is not news");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, participantsById: new Map([[sol1.id, sol1], [sol2.id, sol2]]) })), [], "nor a seat");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: null })), [], "T3 not answering is not a change");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: [ws("p1", "sol1", "feature")] })), ["workspaces"]);
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: [ws("p1", "sol1", "main"), ws("p2", "sol2", "main")] })), ["workspaces"], "someone now shares the folder");
  const off = { ...base, room: { ...room, browserEnabled: false }, browsers: null };
  assert.deepEqual(changedStanding(had, standingFingerprint(off)), ["browsers"]);

  const task: Task = { id: "t", roomId: "r", number: 4, revision: 1, sourceEventId: "e", participantId: "p1", instruction: "Go on.", sourceText: null, attachmentIds: [], delivery: "queue", slashCommand: false, kind: "assignment", scheduleMode: "now", prerequisites: [], state: "queued", stateReason: null, currentRunId: null, userOutcome: null, dismissedAt: null, createdAt: "", updatedAt: "" };
  const briefing = assembleBriefing({ ...off, task, unseenEvents: [], prerequisiteResults: [], standing: ["browsers"], budgetChars: 60_000 }).text;
  assert.equal(
    briefing,
    '[Backroom briefing for @sol1 in room "payments". Your standing rules, where everyone works and the room\'s state: `rooms-board rules --as sol1.r`]\n' +
      "Changed since your last briefing:\n== Browsers ==\nThis room's shared browsers are off now: don't use a browser for its work.\n\n" +
      "== Your assignment (task4) ==\nGo on.\nThis assignment is addressed to you. Perform only the part addressed to you.",
  );
});
