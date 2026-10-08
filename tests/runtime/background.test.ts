/**
 * Background work under H5 (members only answer). Nothing holds a request: a final answers what its run was given,
 * whatever T3 still lists, and the post that wakes the orchestrator carries the member's T3 status, naming the
 * background tasks and subagents still running. The member's own continuation is a follow-up that wakes the
 * orchestrator once; background work its latest post named that ends with no further turn gives one quiet follow-up
 * after `quietMs`.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FOLLOW_UP } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const IDLE = "[T3 status of @W: idle]\n\n";
const SLOW = 'background task "background slow-check"';
const SUB = 'subagent "subagent sub-1"';

/** W's follow-up posts (continuations and quiet follow-ups), oldest first, with their IDs. */
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP ? [{ id: e.id, body: e.data.body, requestIds: e.data.requestIds }] : []));
}

/** The event ID of W's newest output. */
function lastOutputId(r: Room): string {
  return r.p.events.filter((e) => e.data.kind === "output" && e.data.author === "W").at(-1)!.id;
}

/** C asks A of W; W ends its turn with a subagent still running; the final answers A and wakes C. */
async function leaveSubagentRunning(r: Room): Promise<string> {
  const a = r.post("C", "W", "Find which modules src/cli.ts imports, with a subagent.");
  await r.tick();
  assert.equal(r.running("W"), true);
  r.fake.subagent(r.threadOf("W"), "sub-1", "running");
  r.complete("W", "A subagent is reading the imported files.");
  await r.tick();
  return a;
}

/** C asks A of W; W ends its turn with slow-check in the background; C is woken by the answer and completes. */
async function leaveSlowCheckRunning(r: Room, text = "slow-check is running; it should pass."): Promise<string> {
  const a = r.post("C", "W", "Run the slow check in the background and report.");
  await r.tick();
  r.fake.background(r.threadOf("W"), ["slow-check"]);
  r.complete("W", text);
  await r.tick();
  assert.equal(r.state(a), "answered");
  assert.equal(r.running("C"), true);
  r.complete("C", "Noted.");
  await r.tick();
  return a;
}

test("an open subagent at turn end holds nothing: the final answers A, C is woken once with W's status naming the subagent", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  assert.equal(room.state(a), "answered");
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(final.claims.map((c) => c.outcome), ["answered"]);
  assert.equal(final.body, `[T3 status of @W: still running: ${SUB}]\n\nA subagent is reading the imported files.`);
  assert.equal(room.p.activities.size, 0, "the host registers no background work");
  assert.equal(room.running("C"), true);
  assert.equal(room.wakes("C"), 1);
  assert.ok(room.prompt("C").includes(SUB), "the post that wakes C names the subagent");
  assert.match(room.prompt("C"), /A subagent is reading the imported files\./);
  room.complete("C", "Noted.");
  room.clock += 120_000;
  await room.tick(3);
  assert.equal(room.wakes("C"), 1, "nothing more while the subagent still runs, however long");
  assert.deepEqual(followUps(room), []);
});

test("the continuation's final is a follow-up on A, with W's status; it wakes C once and answers nothing", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  room.complete("C", "Noted.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  const self = room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  assert.equal(room.wakes("C"), 1, "nothing is posted while the continuation runs");
  room.complete("W", "cli.ts imports args.ts and text.ts; text.ts is unused (src/cli.ts:3).");
  await room.tick();
  assert.deepEqual(followUps(room), [{ id: `t3run:${room.threadOf("W")}:${self}`, body: `${IDLE}cli.ts imports args.ts and text.ts; text.ts is unused (src/cli.ts:3).`, requestIds: [a] }]);
  assert.equal(room.answeredClaims(a).length, 1, "A was answered once, by the first final");
  assert.equal(room.wakes("C"), 2, "the follow-up wakes C");
  assert.match(room.prompt("C"), /text\.ts is unused/);
  room.complete("C", "Good.");
  room.clock += 60_000;
  await room.tick(3);
  assert.equal(room.wakes("C"), 2, "once");
  assert.deepEqual(room.outputs().filter((o) => o.author === "C").at(-1)!.disposition, { kind: "yield" }, "C's reply to it answers nothing");
  room.assertQuiet();
});

test("a continuation while T3 still lists the subagent names it; when it then ends with no turn, one quiet follow-up says so", async () => {
  room = await Room.create();
  const a = await leaveSubagentRunning(room);
  room.complete("C", "Noted.");
  await room.tick();
  const self = room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "Still waiting for the subagent.");
  await room.tick();
  const continuation = `t3run:${room.threadOf("W")}:${self}`;
  assert.deepEqual(followUps(room), [{ id: continuation, body: `[T3 status of @W: still running: ${SUB}]\n\nStill waiting for the subagent.`, requestIds: [a] }]);
  assert.equal(room.wakes("C"), 2);
  room.complete("C", "Noted.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  await room.tick();
  room.clock += 29_000;
  await room.tick();
  assert.equal(followUps(room).length, 1, "not before 30 s of quiet");
  room.clock += 2_000;
  await room.tick();
  assert.deepEqual(followUps(room)[1], { id: `quiet:${continuation}`, body: `${IDLE}(${SUB} ended without a further turn.)`, requestIds: [a] }, "keyed on W's latest post, the continuation's follow-up");
  assert.equal(room.wakes("C"), 3);
  room.complete("C", "Ok.");
  room.clock += 5 * 60_000;
  await room.tick(3);
  assert.equal(followUps(room).length, 2);
  assert.equal(room.wakes("C"), 3);
  room.assertQuiet();
});

test("a background task ending with no turn: one quiet follow-up after 30 s, not before, with the current status; C woken once by it", async () => {
  room = await Room.create();
  const a = await leaveSlowCheckRunning(room);
  const answer = room.outputs().find((o) => o.author === "W")!;
  assert.equal(answer.body, `[T3 status of @W: still running: ${SLOW}]\n\nslow-check is running; it should pass.`);
  const answerId = lastOutputId(room);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 29_000;
  await room.tick();
  assert.deepEqual(followUps(room), [], "not before 30 s");
  assert.equal(room.wakes("C"), 1);
  room.clock += 2_000;
  await room.tick();
  assert.deepEqual(followUps(room), [{ id: `quiet:${answerId}`, body: `${IDLE}(${SLOW} ended without a further turn.)`, requestIds: [a] }]);
  assert.equal(room.wakes("C"), 2, "the follow-up wakes C");
  assert.match(room.prompt("C"), /ended without a further turn/);
  room.complete("C", "Ok.");
  room.clock += 5 * 60_000;
  await room.tick(3);
  assert.equal(followUps(room).length, 1, "only one");
  assert.equal(room.wakes("C"), 2);
  assert.equal(room.answeredClaims(a).length, 1);
  room.assertQuiet();
});

test("the quiet follow-up waits the host's quietMs", async () => {
  room = await Room.create({ host: { quietMs: 5_000 } });
  await leaveSlowCheckRunning(room);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 4_000;
  await room.tick();
  assert.deepEqual(followUps(room), []);
  room.clock += 2_000;
  await room.tick();
  assert.equal(followUps(room).length, 1);
  assert.equal(room.wakes("C"), 2);
});

test("a continuation before the quiet period ends is the only follow-up: no quiet follow-up comes after it", async () => {
  room = await Room.create();
  const a = await leaveSlowCheckRunning(room, "slow-check started.");
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 10_000;
  const self = room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "slow-check passed.");
  await room.tick();
  assert.deepEqual(followUps(room), [{ id: `t3run:${room.threadOf("W")}:${self}`, body: `${IDLE}slow-check passed.`, requestIds: [a] }]);
  assert.equal(room.wakes("C"), 2);
  room.complete("C", "Good.");
  room.clock += 60_000;
  await room.tick(3);
  assert.equal(followUps(room).length, 1, "W's latest post says idle: nothing ended unreported");
  assert.equal(room.wakes("C"), 2);
  room.assertQuiet();
});

test("background work an earlier turn started holds nothing and is still named in a later status line", async () => {
  room = await Room.create();
  const a = await leaveSlowCheckRunning(room, "slow-check started.");
  const b = room.post("C", "W", "Quick: which branch are you on?");
  await room.tick();
  assert.equal(room.running("W"), true, "W is free for B while slow-check runs");
  room.complete("W", "engine-l1.");
  await room.tick();
  assert.equal(room.state(b), "answered");
  assert.equal(room.state(a), "answered");
  assert.equal(room.outputs().filter((o) => o.author === "W").at(-1)!.body, `[T3 status of @W: still running: ${SLOW}]\n\nengine-l1.`, "this run did not start slow-check, and its status still names it");
  assert.equal(room.wakes("C"), 2);
  assert.ok(room.prompt("C").includes(SLOW));
});

test("the continuation of background job X is a follow-up on X, not on B, the seat's earlier request; C woken once for it", async () => {
  room = await Room.create();
  const b = room.post("C", "W", "B: which version is deployed?");
  await room.tick();
  room.complete("W", "B: v1.4.2.");
  await room.tick();
  room.complete("C", "Noted.");
  await room.tick();
  const x = room.post("C", "W", "X: run the slow check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  assert.equal(room.state(x), "answered");
  room.complete("C", "Noted.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "slow-check passed.");
  await room.tick();
  assert.deepEqual(followUps(room).map((f) => f.requestIds), [[x]]);
  assert.equal(room.wakes("C"), 3);
  assert.match(room.prompt("C"), /slow-check passed/);
  room.complete("C", "Good.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 3);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.answeredClaims(x).length, 1);
  room.assertQuiet();
});
