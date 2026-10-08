/**
 * H1 reviewer's round-1 probes (Opus12) on b7be81c. Copy into tests/runtime/ to run.
 * Each is a path where the newest-carrier watermark counts as seen what the member never saw (a stale answer
 * goes through), or misses what it did see (a false supersede the fix does not reach).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}
function wRuns(r: Room) {
  return [...r.p.runs.values()].filter((x) => x.seatId === "W");
}

/** A request held by `working` in run 1; C's correction goes to run 2, which T3 refuses three times, so it fails unsent. */
async function correctionInRunT3NeverTook(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "Write the migration.");
  await r.tick();
  r.working("W", "Writing it.");
  r.complete("W", "Started.");
  await r.tick();
  r.fake.refuseSends = 3;
  r.host.correct(r.room, { actor: "C", id: r.id("correct"), requestId: a, body: "Also drop the old index." });
  await r.tick(3);
  const runs = wRuns(r);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.phase, "terminal", "run 2 failed");
  assert.equal(r.p.events.some((e) => e.data.kind === "run.phase" && e.data.runId === runs[1]!.id && e.data.phase === "accepted"), false, "T3 never took run 2");
  assert.equal(r.fake.runsOf(r.threadOf("W")).length, 1, "W's thread has only run 1: W never saw the correction");
  return a;
}

test("F1a: an explicit answer between turns is not judged by a failed run T3 never took (the correction is unseen)", async () => {
  room = await Room.create();
  const a = await correctionInRunT3NeverTook(room);
  const claims = room.answer("W", "Migration written (never saw the correction).", [a]);
  assert.notEqual(claims[0]!.outcome, "answered", "W never saw the correction: the answer must not go through");
});

test("F1b: an idle settle is not judged by a failed run T3 never took", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background and report.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.fake.refuseSends = 3;
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also run it on arm64." });
  await room.tick(3);
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1, "T3 never took run 2");
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 60_000;
  await room.tick(2);
  const idle = room.outputs().find((o) => o.sourceKey.startsWith("idle:"));
  assert.ok(idle, "the idle settle ran");
  assert.notEqual(idle.claims.find((c) => c.requestId === a)?.outcome, "answered", "run 1's text never saw the arm64 correction");
});

/**
 * W's run 1 leaves slow-check in the background and asks V for a review (A held by bg:). V's FAIL is dispatched to W
 * as run 2 just as T3 starts W's own continuation: T3 queues run 2 behind it. The continuation never sees the FAIL.
 */
async function hostRunQueuedBehindContinuation(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "Run the slow check in the background and have V review the patch.");
  await r.tick();
  r.post("W", "V", "Review the patch please.");
  r.fake.background(r.threadOf("W"), ["slow-check"]);
  r.complete("W", "slow-check started; review asked.");
  await r.tick();
  assert.ok([...r.p.activities.keys()].some((k) => k.startsWith("bg:")));
  // The continuation starts the moment the host is sending run 2 (the thread looked free when it checked).
  const arm = () => {
    r.fake.onDetail = { threadId: r.threadOf("W"), run: () => {
      if (wRuns(r).some((x) => x.phase === "sending")) r.fake.startSelfRun(r.threadOf("W"));
      else arm();
    } };
  };
  arm();
  r.complete("V", "FAIL: the patch breaks arm64.");
  await r.tick();
  r.fake.onDetail = null;
  const t3 = r.fake.runsOf(r.threadOf("W"));
  assert.deepEqual(t3.slice(-2).map((x) => x.status), ["running", "queued"], "run 2 queued behind W's own continuation");
  assert.equal(wRuns(r)[1]!.phase, "accepted");
  return a;
}

test("F2a: the continuation settle is not judged by a host run T3 queued behind it (its FAIL is unseen)", async () => {
  room = await Room.create();
  const a = await hostRunQueuedBehindContinuation(room);
  room.fake.background(room.threadOf("W"), []);
  room.complete("W", "slow-check passed; A is done (never saw the FAIL).");
  await room.tick();
  const settle = room.outputs().find((o) => o.sourceKey.startsWith("t3run:"));
  assert.ok(settle, "the continuation was imported");
  assert.notEqual(settle.claims.find((c) => c.requestId === a)?.outcome, "answered", "the continuation ran before run 2 delivered the FAIL");
  assert.equal(room.wakes("C"), 0, "C is not woken by a stale answer");
});

test("F2b: an explicit answer from inside that continuation is not judged by the queued run", async () => {
  room = await Room.create();
  const a = await hostRunQueuedBehindContinuation(room);
  const claims = room.answer("W", "slow-check passed; A is done (never saw the FAIL).", [a]);
  assert.notEqual(claims[0]!.outcome, "answered", "the live host run is only queued in T3: its FAIL is unseen");
});

test("F3: a review answer steered into the run that registered work: is seen: the explicit answer there is answered", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Implement slugify; have V review it.");
  await room.tick();
  room.post("W", "V", "Review slugify please.");
  room.working("W", "Waiting for the review while I write docs.");
  await room.tick();
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.running("W"), true, "W is still in run 1");
  room.host.request(room.room, { actor: "$user", id: "steer:1", to: "W", body: "Also add a doc comment." });
  await room.tick(2);
  const run1 = wRuns(room)[0]!;
  assert.equal(wRuns(room).length, 1);
  assert.ok(run1.receipts.some((x) => x.confirmed), "the steer, carrying V's PASS, was confirmed into run 1");
  assert.match(room.fake.thread(room.threadOf("W")).messages.at(-1)!.text, /PASS/, "W saw the PASS in the steer");
  assert.deepEqual(room.answer("W", "Done and reviewed; doc comment added.", [a]).map((c) => c.outcome), ["answered"]);
});

test("F3 consequence: after that false supersede, the turn's final leaves A open with nothing holding it and nothing to deliver", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Implement slugify; have V review it.");
  await room.tick();
  room.post("W", "V", "Review slugify please.");
  room.working("W", "Waiting for the review while I write docs.");
  await room.tick();
  room.complete("V", "PASS");
  await room.tick();
  room.host.request(room.room, { actor: "$user", id: "steer:1", to: "W", body: "Also add a doc comment." });
  await room.tick(2);
  const outcome = room.answer("W", "Done and reviewed; doc comment added.", [a])[0]!.outcome;
  room.complete("W", "Handoff.");
  await room.tick(3);
  const stranded = room.state(a) === "open" && room.pendingActivities().length === 0 && room.unread("W").length === 0 && !room.running("W");
  assert.equal(stranded, false, `explicit answer ${outcome}; A ${room.state(a)}, pending ${room.pendingActivities()}, unread W ${room.unread("W").length}, C wakes ${room.wakes("C")}`);
});
