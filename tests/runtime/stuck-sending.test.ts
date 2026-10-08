/**
 * H4 (Z2 review, finding 2): a run whose phase the journal refuses never sits in sending without an outcome. T3 run IDs
 * are run:thread:<thread>:ordinal:<n>, so when a thread's runs are counted from 1 again (the fake T3 restoring a thread
 * after a service restart does that) T3 gives a new turn an ID an earlier run holds, and the journal refuses to bind it
 * twice. The run fails at once with one notice to the asker and the orchestrator; the request stays open, and a retry
 * runs under the next ID T3 gives. Any other step that keeps failing before T3 has the run fails it after a bound; an
 * outage does not count.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { T3Unavailable } from "../../src/adapter/types.ts";
import type { Run } from "../../src/engine/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const REUSED = /T3 gave @W's turn the run ID run:thread:thread:W:ordinal:(\d+), which an earlier run already holds/;

/** T3 forgets the seat's runs and counts from 1 again: the thread is relaunched under the same ID, as src/server/index.ts restores a fake thread after a restart. */
async function relaunch(r: Room, seat: string): Promise<void> {
  r.fake.threads.delete(r.threadOf(seat));
  await r.fake.launchThread({ commandId: `relaunch:${seat}`, threadId: r.threadOf(seat), projectId: "project_demo", title: `room · ${seat}`, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
}

/** Runs one job on the seat to its answer. */
async function job(r: Room, seat: string, body: string): Promise<void> {
  const id = r.user(seat, body);
  await r.until(() => r.running(seat));
  r.complete(seat, `${body} Done.`);
  await r.until(() => r.state(id) === "answered");
}

function runsOf(r: Room, seat: string): Run[] {
  return [...r.p.runs.values()].filter((x) => x.seatId === seat);
}

function refusals(r: Room): number {
  return r.logs.filter((l) => JSON.stringify(l.detail ?? "").includes("provider run already bound to another local run")).length;
}

// The Z2 reviewer's reproduction (backroom-handoff/Z2-review/finding2-stuck-sending/), its assertion kept, then tightened to the behaviour H4 chose.
test("a T3 run ID already bound to an earlier run does not leave the new run in sending without a notice", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  const W = room.threadOf("W");
  const first = room.user("W", "First job.");
  await room.until(() => room.running("W"));
  room.complete("W", "First job done.");
  await room.until(() => room.state(first) === "answered");
  assert.equal([...room.p.runs.values()][0]!.providerRunId, `run:thread:${W}:ordinal:1`);

  await relaunch(room, "W");

  const second = room.user("W", "Second job.");
  await room.tick(10);
  const runs = [...room.p.runs.values()].map((r) => `${r.phase}${r.providerRunId ? ` ${r.providerRunId}` : ""}`);
  const notices = room.notices();
  assert.ok(
    !room.unresolvedRuns().includes("W:sending") || notices.length > 0,
    `the second run is stuck in sending with no notice: runs ${JSON.stringify(runs)}, notices ${notices.length}, refusals logged ${refusals(room)}, request ${room.state(second)}`,
  );
  // H4: the run ends at once as a failure, never loops, and leaves the request open for a retry.
  assert.deepEqual(runs, [`terminal run:thread:${W}:ordinal:1`, "terminal"]);
  assert.match(runsOf(room, "W")[1]!.failure ?? "", REUSED);
  assert.ok(room.p.events.some((e) => e.data.kind === "run.phase" && e.data.runId === runsOf(room, "W")[1]!.id && e.data.phase === "uncertain"), "recorded uncertain, never bound");
  assert.equal(notices.length, 1, "one notice, not one per tick");
  assert.deepEqual(notices[0]!.recipients, ["$user"]);
  assert.match(notices[0]!.body, REUSED);
  assert.equal(refusals(room), 0, "the host never sends the bind the journal would refuse");
  assert.equal(room.logs.filter((l) => l.message === "seat step failed").length, 0);
  assert.equal(room.state(second), "open");
  assert.equal(room.p.seats.get("W")!.activeRunId, null, "the seat is free again");
});

test("a retry after a reused T3 run ID waits for the turn T3 was given, then runs under the next ID and answers; one notice in all", async () => {
  room = await Room.create({ seats: ["C", "W"], aliases: { W: "worker" } });
  await job(room, "W", "First job.");
  await relaunch(room, "W");
  const second = room.user("W", "Second job.");
  await room.tick(2);
  const failed = runsOf(room, "W")[1]!;
  assert.equal(failed.phase, "terminal");
  assert.equal(room.notices().length, 1);
  assert.deepEqual([...room.notices()[0]!.recipients].sort(), ["$user", "C"], "the asker and the orchestrator");
  assert.match(room.notices()[0]!.body, /^T3 gave @worker's turn the run ID run:thread:thread:W:ordinal:1, which an earlier run already holds/, "the member by its alias, not its seat ID");
  // T3 runs the turn it was given all the same: the thread is busy, so nothing else is sent to it meanwhile.
  assert.equal(room.running("W"), true);
  await room.until(() => room.running("C"));
  room.complete("C", "Noted; retrying.");
  room.host.retry(room.room, { actor: "C", id: "retry-1", runId: failed.id, body: "Try again." });
  await room.tick(2);
  assert.equal(room.wakes("W"), 1, "the retry waits while T3 runs the turn it took");
  room.complete("W", "Second job done, unfollowed.");
  await room.until(() => room.wakes("W") === 2);
  assert.match(room.prompt("W"), /Second job/, "the retry carries the original content");
  const retried = runsOf(room, "W")[2]!;
  assert.equal(retried.providerRunId, `run:thread:${room.threadOf("W")}:ordinal:2`, "T3's next ID is free");
  room.complete("W", "Second job done.");
  await room.until(() => room.state(second) === "answered");
  assert.equal(room.notices().length, 1);
  assert.deepEqual(room.unresolvedRuns(), []);
  assert.equal(refusals(room), 0);
});

test("a retry that lands on a reused ID again fails again with its own one notice, and the next free ID runs: never a loop", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  await job(room, "W", "First job.");
  await job(room, "W", "Second job.");
  await relaunch(room, "W");
  const third = room.user("W", "Third job.");
  for (const ordinal of [1, 2]) {
    await room.tick(3);
    const run = runsOf(room, "W").at(-1)!;
    assert.equal(run.phase, "terminal");
    assert.equal(REUSED.exec(run.failure ?? "")?.[1], String(ordinal));
    assert.equal(room.notices().length, ordinal, "one notice per failed run");
    room.complete("W", `Turn ${ordinal} done, unfollowed.`);
    await room.tick();
    room.host.retry(room.room, { actor: "$user", id: `retry-${ordinal}`, runId: run.id, body: "Try again." });
  }
  await room.until(() => room.running("W") && runsOf(room, "W").at(-1)!.providerRunId === `run:thread:${room.threadOf("W")}:ordinal:3`);
  room.complete("W", "Third job done.");
  await room.until(() => room.state(third) === "answered");
  assert.equal(room.notices().length, 2);
  // What T3 ran unfollowed is a note under the request, turn 1's too though its number is the seat's first host run's
  // (review r1, F2: a run on a host message is never the thread's history).
  const notes = room.p.events.flatMap((e) => (e.data.kind === "note" ? [e.data] : []));
  assert.deepEqual(notes.map((n) => [n.body, n.requestIds]), [1, 2].map((n) => [`(T3 ran a message after Backroom had recorded it as failed) Turn ${n} done, unfollowed.`, [third]]));
  assert.equal(refusals(room), 0);
  assert.equal(room.logs.filter((l) => l.message === "seat step failed").length, 0);
});

test("a run whose step keeps failing before T3 has it fails visibly after the bound, and not before", async () => {
  room = await Room.create({ host: { stuckMs: 60_000 } });
  // The journal refuses W's acceptance for a reason the host does not know of.
  const execute = room.store.execute.bind(room.store);
  room.store.execute = (roomId, command) => {
    if (command.type === "phase" && command.phase === "accepted" && room.p.runs.get(command.runId)?.seatId === "W") throw new Error("simulated: the journal refuses the phase");
    return execute(roomId, command);
  };
  const a = room.user("W", "Fix dates.ts.");
  await room.tick(6);
  assert.deepEqual(room.unresolvedRuns(), ["W:sending"], "within the bound the step is tried again");
  assert.deepEqual(room.notices(), []);
  assert.equal(room.logs.filter((l) => l.message === "seat step failed").length, 6);
  room.clock += 61_000;
  await room.tick();
  assert.deepEqual(room.unresolvedRuns().filter((r) => r.startsWith("W:")), [], "W's run ended (C runs, woken by the notice)");
  const notices = room.notices();
  assert.equal(notices.length, 1);
  assert.deepEqual([...notices[0]!.recipients].sort(), ["$user", "C"]);
  assert.match(notices[0]!.body, /^Backroom stopped trying to start @W's turn after the same step failed 7 times in 61 s: simulated: the journal refuses the phase$/);
  assert.equal(room.state(a), "open");
  await room.tick(5);
  assert.equal(room.notices().length, 1, "and nothing more after it");
  assert.equal(room.logs.filter((l) => l.message === "seat step failed").length, 6);
});

test("a send T3 cannot take while it lists its threads counts toward the bound; a real outage counts nothing and starts the count again", async () => {
  room = await Room.create({ host: { stuckMs: 60_000 } });
  // Two sends fail while T3 answers every read: they count.
  room.fake.unavailableSends = 2;
  room.user("W", "Fix dates.ts.");
  await room.tick(2);
  assert.deepEqual(room.unresolvedRuns(), ["W:sending"]);
  assert.match(String((room.logs.at(-1)?.detail as { error?: string })?.error), /the message for @W could not be sent to T3 \(T3 is not reachable \(simulated\)\); it is sent again with the same IDs/);
  // Then T3 is down for 10 minutes: it lists nothing, so no seat is stepped.
  const list = room.fake.listThreads.bind(room.fake);
  let outage = true;
  room.fake.listThreads = async () => {
    if (outage) throw new T3Unavailable("T3 is not reachable (simulated)");
    return list();
  };
  for (let i = 0; i < 5; i++) {
    room.clock += 2 * 60_000;
    await room.tick();
  }
  assert.deepEqual(room.unresolvedRuns(), ["W:sending"]);
  assert.deepEqual(room.notices(), []);
  // T3 is back and the next send fails once more: the third failure in a row, 10 minutes after the first, but the
  // outage started the count again, so it is the first.
  outage = false;
  room.fake.unavailableSends = 1;
  await room.tick();
  assert.deepEqual(room.unresolvedRuns(), ["W:sending"]);
  assert.deepEqual(room.notices(), []);
  await room.tick();
  assert.equal(room.running("W"), true, "sent when T3 takes it");
  assert.deepEqual(room.notices(), []);
});
