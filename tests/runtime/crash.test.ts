/**
 * The crash method (plan item L1): after each committed step the host instance is thrown away, and a new host is built
 * over the same SQLite file and the same FakeT3Adapter, which keeps a receipt per command ID as T3 does. Afterwards:
 * every reserved run's dispatch started at most one T3 run, no delivered input is lost, and every run ends.
 * Process-level SIGKILL atomicity of the store stays covered by tests/engine/store-faults.test.ts and incremental.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { deliveredInputs, inputFor, inputTree } from "../../src/engine/index.ts";
import type { HostStep } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** Every run has ended. */
function allEnded(r: Room): boolean {
  return [...r.p.runs.values()].every((x) => x.phase === "terminal");
}

/**
 * C hands A to W, which answers U (H5: nothing is held); the user's message goes into W's running turn (an old journal's
 * steer: ID); W's final answers A and the message with a subagent still running, and wakes C; the subagent ends and W's own continuation is a follow-up on both,
 * which wakes C again; C reports. Touches every host step.
 */
async function scenario(r: Room): Promise<{ u: string; a: string; steer: string }> {
  const W = r.threadOf("W");
  const u = r.user("C", "Find the unused imports with a subagent, then report.");
  await r.until(() => r.running("C"));
  const a = r.post("C", "W", "A: find the unused imports, with a subagent.");
  r.complete("C", "Handed to W.");
  await r.until(() => r.running("W"));
  const steer = r.host.request(r.room, { actor: "$user", id: "steer:1", to: "W", body: "Also look at the tests folder." }).events[0]!.id;
  await r.until(() => [...r.p.runs.values()].some((x) => x.seatId === "W" && x.receipts.some((c) => c.confirmed)));
  r.fake.subagent(W, "sub-1", "running");
  r.complete("W", "A subagent is reading the files.");
  await r.until(() => r.state(a) === "answered" && r.running("C"));
  r.complete("C", "W's subagent is still reading.");
  await r.until(() => allEnded(r) && !r.running("W"));
  r.fake.subagent(W, "sub-1", "completed");
  r.fake.startSelfRun(W);
  await r.tick();
  r.complete("W", "Unused: src/text.ts.");
  await r.until(() => r.running("C"));
  r.complete("C", "Report: src/text.ts is unused. JOB-DONE");
  await r.until(() => allEnded(r) && !r.running("C"));
  await r.tick(3);
  return { u, a, steer };
}

/** W's follow-ups: its continuation, once, on what its answer closed (A and the steer). */
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" ? [{ id: e.id, ...e.data }] : []));
}

function assertCrashInvariants(r: Room): void {
  const p = r.p;
  // 1. Each reserved run's dispatch started at most one T3 run, across every thread.
  const t3Runs = [...r.fake.threads.values()].flatMap((t) => t.runs);
  for (const run of p.runs.values()) {
    assert.ok(t3Runs.filter((x) => x.userMessageId === run.dispatchMessageId).length <= 1, `run ${run.id} started more than one T3 run`);
  }
  // 2. No delivered input is lost: every addressed input reached its seat in some run (its envelope, or a steer T3
  // confirmed in it), and nothing is left unread.
  for (const seat of p.seats.values()) {
    const delivered = new Set([...p.runs.values()].filter((x) => x.seatId === seat.id).flatMap((x) => inputTree(deliveredInputs(p, x.id)).map((i) => i.eventId)));
    for (const e of p.events) {
      if (inputFor(e, seat.id)) assert.ok(delivered.has(e.id), `${e.data.kind} ${e.id} never reached ${seat.id}`);
    }
    assert.deepEqual(r.unread(seat.id), []);
  }
  // 3. Every run ends; nothing is left pending; T3 runs nothing.
  assert.deepEqual(r.unresolvedRuns(), []);
  assert.deepEqual(r.pendingActivities(), []);
  for (const seat of p.seats.values()) assert.equal(r.running(seat.id), false, `${seat.id} still running in T3`);
}

/** What the scenario must end with, crash or not. */
function assertOutcome(r: Room, ids: { u: string; a: string; steer: string }): void {
  assert.equal(r.answeredClaims(ids.a).length, 1, "A answered exactly once");
  assert.equal(r.answeredClaims(ids.u).length, 1, "U answered exactly once, by C's hand-off");
  assert.equal(r.answeredClaims(ids.steer).length, 1, "the message answered exactly once, by W's final");
  const copies = r.fake.thread(r.threadOf("W")).messages.filter((m) => m.role === "user" && /Also look at the tests folder/.test(m.text));
  assert.equal(copies.length, 1, "the message reached W once, whatever restarts came between its offer, its send and its confirmation");
  const answer = r.outputs().find((o) => o.claims.some((c) => c.requestId === ids.a && c.outcome === "answered"))!;
  assert.equal(answer.body, '[T3 status of @W: still running: subagent "subagent sub-1"]\n\nA subagent is reading the files.');
  const follow = followUps(r);
  assert.equal(follow.length, 1, "one follow-up for W's continuation");
  assert.deepEqual([[...follow[0]!.requestIds].sort(), follow[0]!.milestone], [[ids.a, ids.steer].sort(), "follow-up"], "on the requests W's answer closed");
  assert.match(follow[0]!.id, /^t3run:/);
  assert.equal(follow[0]!.body, "[T3 status of @W: idle]\n\nUnused: src/text.ts.");
  // C wakes for U, for W's answer to A, and for W's follow-up: each member reply wakes it, once.
  assert.equal(r.wakes("C"), 3, "the Consigliere woke for U, A's answer and W's follow-up only");
  assert.equal(r.wakes("W"), 2, "W: its run on A, and its own continuation");
}

// "steered": the offer of a message into W's running turn is recorded, nothing sent; "steer-sent": T3 took it, not yet
// confirmed; "steer-confirmed": confirmed, the run not yet ended (M1 review item 13).
const STEPS: HostStep[] = ["reserved", "sending", "sent", "accepted", "running", "steered", "steer-sent", "steer-confirmed", "output", "ended", "imported"];

test("without a crash the scenario passes every step once", async () => {
  room = await Room.create();
  const ids = await scenario(room);
  for (const step of STEPS) assert.ok(room.steps.includes(step), `step ${step} not reached`);
  assertOutcome(room, ids);
  assertCrashInvariants(room);
});

for (const seat of ["W", "C"]) {
  for (const step of STEPS) {
    // The message into a running turn and the continuation's import are W's only.
    if (seat === "C" && (step.startsWith("steer") || step === "imported")) continue;
    test(`a crash after ${step} on ${seat}: one T3 run per dispatch, no input lost, every run ends`, async () => {
      room = await Room.create();
      room.crashOnce(step, seat);
      const ids = await scenario(room);
      assert.deepEqual(room.crashes, [`${step}:${seat}`], "the crash happened");
      assertOutcome(room, ids);
      assertCrashInvariants(room);
    });
  }
}

test("a lost acknowledgement, then a crash: the new host finds the message by its ID and sends nothing more", async () => {
  room = await Room.create();
  room.fake.dropAcks = true;
  room.crashOnce("sending", "W");
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A." }).events[0]!.id;
  await room.tick();
  assert.deepEqual(room.crashes, ["sending:W"], "crashed after recording sending, before the send");
  await room.tick();
  assert.equal(room.running("W"), true, "the new host sent it; T3 recorded it and the acknowledgement was lost");
  room.fake.dropAcks = false;
  room.restart();
  room.complete("W", "A done.");
  await room.until(() => room.state(a) === "answered");
  const attempts = room.fake.attempts.filter((x) => x.threadId === room.threadOf("W"));
  assert.equal(attempts.length, 1, "found by message ID after the lost acknowledgement: no resend");
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1);
  await room.until(() => room.running("C"));
  room.complete("C", "ok");
  await room.tick(2);
  assertCrashInvariants(room);
});

test("a crash after sending and an outage: the message goes out once T3 is back, with the frozen IDs", async () => {
  room = await Room.create();
  room.crashOnce("sending", "W");
  room.fake.unavailableSends = 2;
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A." }).events[0]!.id;
  await room.tick(3);
  await room.until(() => room.running("W"));
  room.complete("W", "A done.");
  await room.until(() => room.state(a) === "answered");
  const attempts = room.fake.attempts.filter((x) => x.threadId === room.threadOf("W"));
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((x) => `${x.commandId}/${x.messageId}`)).size, 1);
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1);
});
