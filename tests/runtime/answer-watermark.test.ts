/**
 * H1: an answer is judged by what the member has seen. An output tied to an activity is judged by the watermark of the
 * run that registered it; when a later run carried the requests (it delivered a review's answer or a correction), the
 * host releases the activity and ties the output to that run instead. Covered here: the explicit answer in the run
 * that delivered the review (the defect found by L4c), the explicit answer between turns, the continuation and idle
 * settles, K1 still superseding what came after the later run's watermark, and a crash between the two commits.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

/** work.ts's RELEASED, written out so this file also runs (and fails) on the host before H1. */
const RELEASED = "lean: released for ";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}
function activity(r: Room, prefix: string) {
  return [...r.p.activities.values()].find((a) => a.id.startsWith(prefix))!;
}
function releases(r: Room): string[] {
  return r.p.events.flatMap((e) => (e.data.kind === "activity.status" && e.data.evidence.startsWith(RELEASED) ? [e.data.evidence.slice(RELEASED.length)] : []));
}

/** C asks A of W; W asks V for a review, marks A working and ends its turn; V's PASS wakes W in run 2. */
async function workingThenReview(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "Implement slugify; have V review it.");
  await r.tick();
  r.post("W", "V", "Review slugify please.");
  r.working("W", "Implementation done; waiting for the review.");
  r.complete("W", "Sent for review.");
  await r.tick();
  r.complete("V", "PASS");
  await r.tick();
  assert.equal(r.running("W"), true, "the review's answer wakes W");
  return a;
}

/** A `bg:` activity of run 1 holds A; C's correction is delivered in run 2, whose final is pending_activity. */
async function backgroundThenCorrection(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "Run the slow check in the background and report.");
  await r.tick();
  r.fake.background(r.threadOf("W"), ["slow-check"]);
  r.complete("W", "slow-check started.");
  await r.tick();
  r.host.correct(r.room, { actor: "C", id: r.id("correct"), requestId: a, body: "Also run it on arm64." });
  await r.tick();
  assert.equal(r.running("W"), true, "the correction wakes W while slow-check runs");
  assert.match(r.prompt("W"), /arm64/);
  r.complete("W", "Will cover arm64 too.");
  await r.tick();
  assert.equal(r.state(a), "open");
  assert.deepEqual(r.pendingActivities().filter((id) => id.startsWith("bg:")).length, 1);
  return a;
}

test("H1: working, a review, then the explicit answer in the run that delivered it: answered once, with the answer's text", async () => {
  room = await Room.create();
  const a = await workingThenReview(room);
  const live = room.p.seats.get("W")!.activeRunId!;
  const claims = room.answer("W", "Done and reviewed.", [a]);
  assert.deepEqual(claims.map((c) => c.outcome), ["answered"], "the PASS the member just read is not unseen");
  assert.equal(activity(room, "work:").status, "done");
  const answer = room.outputs().find((o) => o.sourceKey.startsWith("answer:W:"))!;
  assert.deepEqual(answer.association, { kind: "run", id: live }, "tied to the run that delivered the PASS");
  assert.deepEqual(releases(room), [answer.sourceKey], "the work: activity was released for that output");
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  const final = room.outputs().filter((o) => o.sourceKey.startsWith("final:")).pop()!;
  assert.deepEqual(final.disposition, { kind: "yield" }, "the final answers nothing more");
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /Done and reviewed\./);
  assert.doesNotMatch(room.prompt("C"), /Handoff\./);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("H1: an explicit answer between turns, after a later run delivered a correction, is answered", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Write the migration.");
  await room.tick();
  room.working("W", "Writing it.");
  room.complete("W", "Started.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also drop the old index." });
  await room.tick();
  assert.match(room.prompt("W"), /drop the old index/);
  room.complete("W", "Noted; adding it.");
  await room.tick();
  assert.equal(room.state(a), "open", "the work: hold keeps A open through run 2's final");
  assert.equal(room.running("W"), false);
  assert.deepEqual(room.answer("W", "Migration written, old index dropped.", [a]).map((c) => c.outcome), ["answered"]);
  await room.tick(2);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /old index dropped/);
});

test("H1 (i): a continuation settles background work after a later run delivered a correction; the requester wakes once", async () => {
  room = await Room.create();
  const a = await backgroundThenCorrection(room);
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "slow-check passed on x64 and arm64.");
  await room.tick(3);
  assert.equal(room.state(a), "answered", "not superseded by the correction run 2 delivered");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.deepEqual(room.pendingActivities(), []);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /x64 and arm64/);
});

test("H1 (iii): an idle settle after a later run delivered a correction answers; the requester wakes once", async () => {
  room = await Room.create();
  const a = await backgroundThenCorrection(room);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 31_000;
  await room.tick(3);
  assert.equal(room.state(a), "answered");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.match(room.outputs().find((o) => o.sourceKey.startsWith("idle:"))!.body, /^\(background work ended without a further turn\)\n\nWill cover arm64 too\.$/);
  assert.equal(room.wakes("C"), 1);
});

test("H1 K1 (i): a review's answer that lands while the continuation runs, after the later run's watermark, still supersedes; the next run answers once", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background; have V review the patch.");
  await room.tick();
  room.post("W", "V", "Review the patch please.");
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started; review asked.");
  await room.tick();
  assert.equal(room.running("V"), true);
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also run it on arm64." });
  await room.tick();
  room.complete("W", "Will cover arm64 too.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("V", "FAIL: the patch breaks arm64.");
  await room.tick();
  assert.equal(room.running("W"), true, "still the continuation: nothing is sent while it runs");
  room.complete("W", "slow-check passed on x64 and arm64.");
  await room.tick();
  const settle = room.outputs().find((o) => o.sourceKey.startsWith("t3run:") && o.claims.length)!;
  assert.deepEqual(settle.claims.map((c) => c.outcome), ["superseded"], "V's FAIL came after run 2's watermark and is unread");
  assert.equal(room.state(a), "open");
  assert.deepEqual(room.pendingActivities(), [], "the hold is released: the next reply answers A");
  await room.tick();
  assert.equal(room.running("W"), true, "the next run delivers V's FAIL");
  assert.match(room.prompt("W"), /breaks arm64/);
  room.complete("W", "Fixed the arm64 break; slow-check passes.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /Fixed the arm64 break/);
});

test("H1 crash (ii): between the release and the answer: the activity is done and A open; the replayed answer answers once", async () => {
  room = await Room.create();
  const a = await workingThenReview(room);
  room.crashOnce("released", "W");
  const input = { actor: "W", id: "answer-crash", body: "Done and reviewed.", requestIds: [a] };
  assert.throws(() => room.host.answer(room.room, input), /simulated crash after released/);
  assert.equal(activity(room, "work:").status, "done", "the release committed");
  assert.equal(room.state(a), "open", "the answer did not");
  assert.equal(room.outputs().filter((o) => o.sourceKey.startsWith("answer:")).length, 0);
  await room.tick(); // the crashed host does nothing; a new one is built over the same file
  const claims = room.host.answer(room.room, input).claims;
  assert.deepEqual(claims.map((c) => c.outcome), ["answered"]);
  assert.deepEqual(room.host.answer(room.room, input).claims, claims, "a second replay reports the same outcome");
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /Done and reviewed\./);
});

test("H1 crash (i): between the release and the continuation's output: the next look writes it; the requester wakes once", async () => {
  room = await Room.create();
  const a = await backgroundThenCorrection(room);
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.crashOnce("released", "W");
  room.complete("W", "slow-check passed on x64 and arm64.");
  await room.tick();
  assert.deepEqual(room.crashes, ["released:W"]);
  assert.equal(room.state(a), "open");
  assert.deepEqual(room.pendingActivities(), [], "released, its output not written");
  await room.tick(3);
  assert.equal(room.state(a), "answered");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /x64 and arm64/);
});

test("H1 crash (iii): between the release and the idle settle's output: the next tick writes it; the requester wakes once", async () => {
  room = await Room.create();
  const a = await backgroundThenCorrection(room);
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 31_000;
  room.crashOnce("released", "W");
  await room.tick();
  assert.deepEqual(room.crashes, ["released:W"]);
  assert.equal(room.state(a), "open");
  await room.tick(3);
  assert.equal(room.state(a), "answered");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("H1: with no later run the settle is unchanged: one activity output, nothing released", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background and report.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  assert.deepEqual(room.answer("W", "slow-check passed.", [a]).map((c) => c.outcome), ["answered"]);
  const answer = room.outputs().find((o) => o.sourceKey.startsWith("answer:"))!;
  assert.equal(answer.association.kind, "activity");
  assert.deepEqual(releases(room), []);
});
