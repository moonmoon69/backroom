/**
 * H1's watermark, as H5 leaves it (members only answer): a final is judged by what its run delivered. There are no
 * explicit answers and no activities to release any more; what is left is K1's correction rule (a correction that
 * landed after the run's watermark supersedes its final, and the next run delivers it and answers once), and the
 * crash windows of the imports that are not answers: a restart never imports a turn or a quiet follow-up twice.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FOLLOW_UP } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const SLOW = 'background task "background slow-check"';

function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP ? [{ id: e.id, body: e.data.body, requestIds: e.data.requestIds }] : []));
}

/** C asks A of W; W's turn leaves slow-check in the background and answers A; C is woken by it and completes. */
async function answeredWithBackground(r: Room): Promise<string> {
  const a = r.post("C", "W", "Run the slow check in the background and report.");
  await r.tick();
  r.fake.background(r.threadOf("W"), ["slow-check"]);
  r.complete("W", "slow-check started.");
  await r.tick();
  assert.equal(r.state(a), "answered");
  r.complete("C", "Noted.");
  await r.tick();
  return a;
}

test("K1: a correction landing during W's run, which leaves background work, supersedes its final; the next run answers A once and the quiet follow-up keys on that answer", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Run the slow check in the background and report.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also run it on arm64." });
  room.complete("W", "slow-check started (x64 only).");
  await room.tick();
  const first = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(first.claims.map((c) => c.outcome), ["superseded"], "the correction came after run 1's watermark");
  assert.deepEqual(first.recipients, [], "a superseded final wakes nobody");
  assert.equal(room.state(a), "open");
  assert.deepEqual(room.pendingActivities(), [], "nothing holds A: the correction is what is left to deliver");
  assert.equal(room.running("W"), true, "the next run delivers the correction");
  assert.match(room.prompt("W"), /arm64/);
  assert.equal(room.wakes("C"), 0);
  room.complete("W", "slow-check covers arm64 too; it is running.");
  await room.tick();
  assert.equal(room.answeredClaims(a).length, 1);
  const answer = room.p.events.find((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === a && c.outcome === "answered"))!;
  assert.equal(answer.data.kind === "output" && answer.data.body, `[T3 status of @W: still running: ${SLOW}]\n\nslow-check covers arm64 too; it is running.`);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /covers arm64 too/);
  assert.doesNotMatch(room.prompt("C"), /x64 only/, "the superseded final never reaches C");
  room.complete("C", "Noted.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 31_000;
  await room.tick(2);
  assert.deepEqual(followUps(room).map((f) => [f.id, f.requestIds]), [[`quiet:${answer.id}`, [a]]], "one quiet follow-up, on the answer, not the superseded final");
  assert.equal(room.wakes("C"), 2);
  room.complete("C", "Ok.");
  await room.tick(2);
  room.assertQuiet();
});

test("crash right after a continuation's follow-up is written: the new host does not import the turn again; C woken once by it", async () => {
  room = await Room.create();
  const a = await answeredWithBackground(room);
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.crashOnce("imported", "W");
  room.complete("W", "slow-check passed on x64 and arm64.");
  await room.tick();
  assert.deepEqual(room.crashes, ["imported:W"]);
  assert.equal(followUps(room).length, 1, "the follow-up committed before the crash");
  await room.tick(3);
  assert.equal(followUps(room).length, 1, "and is not imported again");
  assert.deepEqual(followUps(room)[0]!.requestIds, [a]);
  assert.equal(room.wakes("C"), 2);
  assert.match(room.prompt("C"), /x64 and arm64/);
  room.complete("C", "Good.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  room.assertQuiet();
});

test("crash right after the quiet follow-up is written: the new host does not post it again; C woken once by it", async () => {
  room = await Room.create();
  const a = await answeredWithBackground(room);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 31_000;
  room.crashOnce("imported", "W");
  await room.tick();
  assert.deepEqual(room.crashes, ["imported:W"]);
  assert.equal(followUps(room).length, 1);
  await room.tick();
  room.clock += 31_000;
  await room.tick(3);
  assert.equal(followUps(room).length, 1, "a new host, with no quiet clock, posts nothing more");
  assert.deepEqual(followUps(room)[0]!.requestIds, [a]);
  assert.equal(room.wakes("C"), 2);
  room.complete("C", "Ok.");
  await room.tick(2);
  room.assertQuiet();
});

/** The host records W's next run as accepted while T3 still says "starting"; T3 then runs it before the host looks again. */
function acceptedNotYetSeenRunning(r: Room): void {
  const W = r.threadOf("W");
  const arm = () => {
    r.fake.onDetail = { threadId: W, run: () => {
      const live = r.fake.liveRun(W);
      if (live) live.status = "starting";
      else arm();
    } };
  };
  arm();
}

test("the final of a turn the host has recorded only as accepted (T3 ran it unseen) answers A once; C woken once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Write the migration.");
  acceptedNotYetSeenRunning(room);
  await room.tick();
  room.fake.liveRun(room.threadOf("W"))!.status = "running";
  const run = room.p.runs.get(room.p.seats.get("W")!.activeRunId!)!;
  assert.equal(run.phase, "accepted", "T3 runs the turn; the host has recorded it as accepted only");
  room.complete("W", "Migration written.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /\[T3 status of @W: idle\]\n\nMigration written\./);
});
