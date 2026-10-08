/**
 * H1 reviewer's round-1 probes (Opus12) on b7be81c, as H5 leaves them (members only answer). Each was a path where
 * the watermark counted as seen what the member never saw, or missed what it did see. With explicit answers and
 * activity settles gone, only a host run's final can answer, so what remains is: a correction in a run T3 never took
 * is unseen; a continuation T3 ran before a queued host run is a follow-up, never that run's answer; what a steer put
 * into the run is seen; and nothing is left open with nothing to deliver it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FOLLOW_UP } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function wRuns(r: Room) {
  return [...r.p.runs.values()].filter((x) => x.seatId === "W");
}
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP ? [{ id: e.id, body: e.data.body, requestIds: e.data.requestIds }] : []));
}
/** Every open request has something on its way: unread input for its owner, or the owner's turn running. */
function assertNothingStranded(r: Room): void {
  for (const q of r.p.requests.values()) {
    if (q.state !== "open") continue;
    assert.ok(r.unread(q.owner).length > 0 || r.running(q.owner), `#${q.id} open with nothing to deliver it (owner ${q.owner})`);
  }
}

test("F1a: a correction in a run T3 never took is unseen: W's own later turn does not answer A; C's retry delivers it and answers once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Write the migration.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also drop the old index." });
  room.fake.refuseSends = 3;
  room.complete("W", "Migration written (never saw the correction).");
  await room.tick(3);
  const runs = wRuns(room);
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.phase, "terminal", "run 2 failed");
  assert.equal(room.p.events.some((e) => e.data.kind === "run.phase" && e.data.runId === runs[1]!.id && e.data.phase === "accepted"), false, "T3 never took run 2");
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1, "W's thread has only run 1: W never saw the correction");
  assert.equal(room.state(a), "open", "run 1's final is superseded");
  assert.deepEqual(room.notices().map((n) => [n.intent, n.recipients]), [["error", ["C"]]], "the failure is visible to C");
  assert.equal(room.running("C"), true);
  room.complete("C", "Will retry W.");
  await room.tick();
  // W's own turn (T3 starts it) has never seen the correction either: a follow-up, not an answer.
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "The migration is written.");
  await room.tick();
  assert.deepEqual(followUps(room).map((f) => f.requestIds), [[a]]);
  assert.equal(room.state(a), "open");
  assert.equal(room.answeredClaims(a).length, 0);
  assert.equal(room.wakes("C"), 2, "the follow-up wakes C");
  room.complete("C", "Retrying.");
  room.host.retry(room.room, { actor: "C", id: room.id("retry"), runId: runs[1]!.id, body: "Retry: T3 refused the message." });
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.match(room.prompt("W"), /drop the old index/, "the retry carries the correction");
  room.complete("W", "Migration written, old index dropped.");
  await room.tick();
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 3);
  assert.match(room.prompt("C"), /old index dropped/);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

/**
 * W's run 1 answers A and leaves slow-check in the background. C's B is dispatched to W as run 2 just as T3 starts W's
 * own continuation: T3 queues run 2 behind it. The continuation never sees B.
 */
async function hostRunQueuedBehindContinuation(r: Room): Promise<{ a: string; b: string }> {
  const a = r.post("C", "W", "A: run the slow check in the background.");
  await r.tick();
  r.fake.background(r.threadOf("W"), ["slow-check"]);
  r.complete("W", "slow-check started.");
  await r.tick();
  assert.equal(r.state(a), "answered");
  r.complete("C", "Noted.");
  await r.tick();
  // The continuation starts the moment the host is sending run 2 (the thread looked free when it checked).
  const arm = () => {
    r.fake.onDetail = { threadId: r.threadOf("W"), run: () => {
      if (wRuns(r).some((x) => x.phase === "sending")) r.fake.startSelfRun(r.threadOf("W"));
      else arm();
    } };
  };
  arm();
  const b = r.post("C", "W", "B: what does the lint report?");
  await r.tick();
  r.fake.onDetail = null;
  const t3 = r.fake.runsOf(r.threadOf("W"));
  assert.deepEqual(t3.slice(-2).map((x) => x.status), ["running", "queued"], "run 2 queued behind W's own continuation");
  assert.equal(wRuns(r)[1]!.phase, "accepted");
  return { a, b };
}

test("F2a: a continuation T3 ran before a host run it queued is a follow-up on A, never B's answer; the queued run answers B once", async () => {
  room = await Room.create();
  const { a, b } = await hostRunQueuedBehindContinuation(room);
  room.fake.background(room.threadOf("W"), []);
  room.complete("W", "slow-check passed; all done (never saw B).");
  await room.tick();
  assert.deepEqual(followUps(room).map((f) => [f.requestIds, f.body]), [[[a], "[T3 status of @W: a turn is running (T3 lists no background tasks while it runs)]\n\nslow-check passed; all done (never saw B)."]]);
  assert.equal(room.state(b), "open", "the continuation ran before run 2 delivered B");
  assert.equal(room.running("W"), true, "T3 runs the queued run 2 now");
  assert.equal(room.wakes("C"), 2, "the follow-up wakes C");
  room.complete("C", "Noted.");
  room.complete("W", "B: the lint reports 0 problems.");
  await room.tick();
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 3);
  assert.match(room.prompt("C"), /0 problems/);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("F3: a request steered into the live run is seen: the run's final answers it with A, each once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Implement slugify.");
  await room.tick();
  room.host.request(room.room, { actor: "$user", id: "steer:1", to: "W", body: "Also add a doc comment." });
  await room.tick(2);
  const run1 = wRuns(room)[0]!;
  assert.equal(wRuns(room).length, 1);
  assert.ok(room.p.runs.get(run1.id)!.receipts.some((x) => x.confirmed), "the steer was confirmed into run 1");
  assert.match(room.fake.thread(room.threadOf("W")).messages.at(-1)!.text, /doc comment/, "W saw it in its turn");
  room.complete("W", "Done; doc comment added.");
  await room.tick();
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(final.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"], ["steer:1", "answered"]]);
  assert.equal(room.wakes("C"), 1);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("F3 consequence: a correction a steer carried into the live run is seen: the final answers A, and nothing is left open with nothing to deliver it", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Implement slugify.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Use hyphens, not underscores." });
  room.host.request(room.room, { actor: "$user", id: "steer:1", to: "W", body: "Also add a doc comment." });
  await room.tick(2);
  assert.match(room.fake.thread(room.threadOf("W")).messages.at(-1)!.text, /hyphens, not underscores[\s\S]*doc comment|doc comment[\s\S]*hyphens, not underscores/, "the steer carried the correction too");
  room.complete("W", "Done with hyphens; doc comment added.");
  await room.tick(3);
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(final.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"], ["steer:1", "answered"]], "not superseded: W saw the correction");
  assertNothingStranded(room);
  assert.equal(room.wakes("W"), 1);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});
