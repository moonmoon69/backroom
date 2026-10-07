/**
 * "Lean semantics" §2: background work (D#180). A request stays open while T3 lists work the run left behind, or while
 * the member said `working`; it settles by the member's continuation (i), an explicit answer (ii) or a quiet thread
 * (iii), and each settle wakes the requester once.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** A seat asks another directly (outside a turn): the request's answer wakes the asker. */
function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

/** W runs A and ends its turn with a subagent still running: A is held by `bg:<run>`. */
async function leaveSubagentRunning(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "Find which modules src/cli.ts imports, with a subagent.");
  await r.tick();
  assert.equal(r.running("W"), true);
  r.fake.subagent(r.threadOf("W"), "sub-1", "running");
  r.complete("W", "A subagent is reading the imported files.");
  await r.tick();
  return a;
}

test("an open subagent at turn end keeps the request open and wakes nobody", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  assert.equal(room.state(a), "open");
  assert.deepEqual(room.pendingActivities().filter((id) => id.startsWith("bg:")).length, 1);
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(final.claims.map((c) => c.outcome), ["pending_activity"]);
  await room.tick(3);
  assert.equal(room.wakes("C"), 0);
});

test("settle (i): the member's continuation ends with nothing listed and answers the request; the requester wakes once", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  assert.equal(room.state(a), "open", "nothing settles while the continuation runs");
  room.complete("W", "cli.ts imports args.ts and text.ts; text.ts is unused (src/cli.ts:3).");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.deepEqual(room.pendingActivities(), []);
  await room.tick(2);
  assert.equal(room.wakes("C"), 1, "the requester is woken once");
  assert.match(room.prompt("C"), /text\.ts is unused/);
});

test("settle (i) waits while T3 still lists background work: that continuation is progress", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "Still waiting for the subagent.");
  await room.tick(2);
  assert.equal(room.state(a), "open");
  const progress = room.outputs().filter((o) => o.disposition.kind === "progress");
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0]!.recipients, [], "progress wakes nobody");
  assert.equal(room.wakes("C"), 0);
});

test("settle (ii): an explicit answer settles the background activity and wakes the requester once", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background and report.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started in the background.");
  await room.tick();
  assert.equal(room.state(a), "open");
  const claims = room.answer("W", "slow-check passed.", [a]);
  assert.deepEqual(claims.map((c) => c.outcome), ["answered"]);
  assert.deepEqual(room.pendingActivities(), []);
  await room.tick(2);
  assert.equal(room.wakes("C"), 1);
});

test("settle (iii): a quiet thread with nothing listed settles bg: after 30 s with the run's final; the requester wakes once", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background and report.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check is running; it should pass.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 29_000;
  await room.tick();
  assert.equal(room.state(a), "open", "not before 30 s");
  room.clock += 2_000;
  await room.tick();
  assert.equal(room.state(a), "answered");
  const settle = room.outputs().find((o) => o.claims.some((c) => c.requestId === a && c.outcome === "answered"))!;
  assert.match(settle.body, /^\(background work ended without a further turn\)\n\nslow-check is running; it should pass\.$/);
  await room.tick(2);
  assert.equal(room.wakes("C"), 1);
});

test("background work the run did not start does not hold its requests", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  const b = ask(room, "V", "W", "Quick: which branch are you on?");
  await room.tick();
  assert.equal(room.running("W"), true, "W is free for B while slow-check runs");
  room.complete("W", "engine-l1.");
  await room.tick();
  assert.equal(room.state(b), "answered", "slow-check was already running before this run: it holds A only");
  assert.equal(room.state(a), "open");
});

test("a work: activity never settles on idle", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Watch CI and report when it is green.");
  await room.tick();
  room.working("W", "Waiting on CI; I will answer when it is green.");
  room.complete("W", "Watching CI.");
  await room.tick();
  room.clock += 120_000;
  await room.tick(3);
  assert.equal(room.state(a), "open");
  assert.equal(room.wakes("C"), 0);
  assert.equal(room.answer("W", "CI is green.", [a])[0]!.outcome, "answered");
  await room.tick();
  assert.equal(room.wakes("C"), 1);
});

test("cancelling every request of an activity sets it failed", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Watch CI.");
  await room.tick();
  room.working("W", "Watching CI.");
  room.complete("W", "Watching.");
  await room.tick();
  const b = ask(room, "C", "W", "Run the slow check.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  assert.equal(room.pendingActivities().length, 2);
  await room.cancel("C", a);
  await room.cancel("C", b);
  const statuses = [...room.p.activities.values()].map((x) => x.status);
  assert.deepEqual(statuses, ["failed", "failed"]);
});

test("the continuation of background job X answers X while the same seat's work: on B stays open; B's requester is not woken", async () => {
  room = await Room.create();
  const b = ask(room, "C", "W", "B: watch the deploy.");
  await room.tick();
  room.working("W", "Watching the deploy.");
  room.complete("W", "Watching.");
  await room.tick();
  const x = ask(room, "V", "W", "X: run the slow check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "slow-check passed.");
  await room.tick(2);
  assert.equal(room.state(x), "answered");
  assert.equal(room.state(b), "open");
  assert.equal(room.wakes("V"), 1, "X's requester is woken once");
  assert.equal(room.wakes("C"), 0, "B's requester is not woken");
});

test("working in a continuation (T3 lists nothing) keeps A open after the turn; a later answer answers it once", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  const marked = room.working("W", "The subagent found more; I keep going.", [a]);
  assert.match(marked.message, /stays open until you run rooms-board answer/);
  room.complete("W", "Partial result; more to come.");
  await room.tick(2);
  assert.equal(room.state(a), "open", "a member-held activity is not settled by the continuation");
  assert.equal(room.wakes("C"), 0);
  assert.equal(room.answer("W", "Final: text.ts is unused.", [a])[0]!.outcome, "answered");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("a member-held bg: activity is not settled by idle", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.working("W", "I will also watch CI after it.", [a]);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 120_000;
  await room.tick(3);
  assert.equal(room.state(a), "open");
  assert.equal(room.wakes("C"), 0);
});

test("working is refused where it would hold nothing, with the way to send a later result", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "A quick one.");
  await room.tick();
  room.complete("W", "Done.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.throws(() => room.working("W", "more", [a]), /not an open request of yours in this turn; to send a later result, use rooms-board post @C/);
  assert.throws(() => room.working("W", "more"), /No open request of yours/);
});
