/**
 * The crash method (plan item L1): after each committed step the host instance is thrown away, and a new host is built
 * over the same SQLite file and the same FakeT3Adapter, which keeps a receipt per command ID as T3 does. Afterwards:
 * every reserved run's dispatch started at most one T3 run, no delivered input is lost, and every run ends.
 * Process-level SIGKILL atomicity of the store stays covered by tests/engine/store-faults.test.ts and incremental.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { inputFor, inputTree } from "../../src/engine/index.ts";
import type { HostStep } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** C hands A to W; W leaves a subagent running; its continuation settles A; C reports. Touches every host step. */
async function scenario(r: Room): Promise<{ u: string; a: string }> {
  const W = r.threadOf("W");
  const u = r.user("C", "Find the unused imports with a subagent, then report.");
  await r.until(() => r.running("C"));
  const a = r.post("C", "W", "A: find the unused imports, with a subagent.");
  r.complete("C", "Handed to W.");
  await r.until(() => r.running("W"));
  r.fake.subagent(W, "sub-1", "running");
  r.complete("W", "A subagent is reading the files.");
  await r.until(() => [...r.p.runs.values()].every((x) => x.phase === "terminal"));
  r.fake.subagent(W, "sub-1", "completed");
  r.fake.startSelfRun(W);
  await r.tick();
  r.complete("W", "Unused: src/text.ts.");
  await r.until(() => r.state(a) === "answered");
  await r.until(() => r.running("C"));
  r.complete("C", "Report: src/text.ts is unused. JOB-DONE");
  await r.until(() => r.state(u) === "answered");
  await r.tick(3);
  return { u, a };
}

function assertCrashInvariants(r: Room): void {
  const p = r.p;
  // 1. Each reserved run's dispatch started at most one T3 run, across every thread.
  const t3Runs = [...r.fake.threads.values()].flatMap((t) => t.runs);
  for (const run of p.runs.values()) {
    assert.ok(t3Runs.filter((x) => x.userMessageId === run.dispatchMessageId).length <= 1, `run ${run.id} started more than one T3 run`);
  }
  // 2. No delivered input is lost: every addressed input reached its seat in some run, and nothing is left unread.
  for (const seat of p.seats.values()) {
    const delivered = new Set([...p.runs.values()].filter((x) => x.seatId === seat.id).flatMap((x) => inputTree(x.envelope.inputs).map((i) => i.eventId)));
    for (const e of p.events) {
      if (inputFor(e, seat.id)) assert.ok(delivered.has(e.id), `${e.data.kind} ${e.id} never reached ${seat.id}`);
    }
    assert.deepEqual(r.unread(seat.id), []);
  }
  // 3. Every run ends; nothing is left pending.
  assert.deepEqual(r.unresolvedRuns(), []);
  assert.deepEqual(r.pendingActivities(), []);
}

test("without a crash the scenario passes every step once", async () => {
  room = await Room.create();
  const { u, a } = await scenario(room);
  for (const step of ["reserved", "sending", "sent", "accepted", "running", "activity", "output", "ended", "settled"] as HostStep[]) {
    assert.ok(room.steps.includes(step), `step ${step} not reached`);
  }
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(u).length, 1);
  assertCrashInvariants(room);
});

const STEPS: HostStep[] = ["reserved", "sending", "sent", "accepted", "running", "activity", "output", "ended", "settled"];
for (const seat of ["W", "C"]) {
  for (const step of STEPS) {
    if (seat === "C" && (step === "activity" || step === "settled")) continue;
    test(`a crash after ${step} on ${seat}: one T3 run per dispatch, no input lost, every run ends`, async () => {
      room = await Room.create();
      room.crashOnce(step, seat);
      const { u, a } = await scenario(room);
      assert.deepEqual(room.crashes, [`${step}:${seat}`], "the crash happened");
      assert.equal(room.answeredClaims(a).length, 1, "A answered exactly once");
      assert.equal(room.answeredClaims(u).length, 1);
      assert.equal(room.wakes("C"), 2, "the Consigliere woke for U and for A's answer only");
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
