/**
 * H1 reviewer's probes (Opus12). Copy into tests/runtime/ to run. Each probe names what it guards:
 *  - FIX: the defect H1 must remove (fails on ff0bade);
 *  - K1: a stale answer must still be refused (superseded) after the fix;
 *  - WAKE: the requester is woken exactly once.
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
function outputsClaiming(r: Room, requestId: string) {
  return r.outputs().filter((o) => o.claims.some((c) => c.requestId === requestId));
}
function activity(r: Room, prefix: string) {
  return [...r.p.activities.values()].find((a) => a.id.startsWith(prefix));
}

/** C asks A of W; W asks V for a review, marks A working and ends its turn; V's answer is imported. */
async function workingAndReview(r: Room, verdict: string): Promise<{ a: string; rv: string }> {
  const a = ask(r, "C", "W", "Implement slugify; have V review it.");
  await r.tick();
  const rv = r.post("W", "V", "Review slugify please.");
  r.working("W", "Implementation done; waiting for the review.");
  r.complete("W", "Sent for review.");
  await r.tick();
  assert.equal(r.running("V"), true);
  r.complete("V", verdict);
  await r.tick();
  assert.equal(r.running("W"), true, "the review's answer wakes W");
  return { a, rv };
}

test("FIX+WAKE Q1: explicit answer in the run that delivered the review is answered, once; the final does not answer again", async () => {
  room = await Room.create();
  const { a } = await workingAndReview(room, "PASS");
  const claims = room.answer("W", "Done and reviewed.", [a]);
  assert.deepEqual(claims.map((c) => c.outcome), ["answered"]);
  assert.equal(room.state(a), "answered");
  assert.equal(activity(room, "work:")!.status, "done", "the work: activity settles with the answer");
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(outputsClaiming(room, a).length, 1, "no other output names A (no already_answered final)");
  assert.equal(room.answeredClaims(a)[0] && outputsClaiming(room, a)[0]!.body, "Done and reviewed.");
  assert.equal(room.wakes("C"), 1, "C woken exactly once");
  assert.match(room.prompt("C"), /Done and reviewed\./);
  assert.doesNotMatch(room.prompt("C"), /Handoff\./);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("FIX Q1b: the same with a FAIL finding: the explicit answer after the fix is answered", async () => {
  room = await Room.create();
  const { a } = await workingAndReview(room, "FAIL: the unicode case is wrong.");
  assert.deepEqual(room.answer("W", "Fixed the unicode case; done.", [a]).map((c) => c.outcome), ["answered"]);
});

test("K1 Q2: a second review answer that lands during the run (after its watermark) still supersedes the explicit answer", async () => {
  room = await Room.create({ seats: ["C", "W", "V", "X"] });
  const a = ask(room, "C", "W", "Implement slugify; have V and X review it.");
  await room.tick();
  const r1 = room.post("W", "V", "Review slugify please (V).");
  const r2 = room.post("W", "X", "Review slugify please (X).");
  room.working("W", "Waiting for both reviews.");
  room.complete("W", "Sent for review.");
  await room.tick();
  room.complete("V", "PASS from V.");
  await room.tick();
  assert.equal(room.running("W"), true, "V's answer wakes W");
  assert.match(room.prompt("W"), /PASS from V/);
  room.complete("X", "FAIL from X: the empty string crashes.");
  await room.tick();
  assert.equal(room.state(r2), "answered");
  assert.equal(room.running("W"), true, "W is still in the run that delivered V's PASS");
  assert.equal(room.state(r1), "answered");
  const claims = room.answer("W", "Done and reviewed (has not seen X).", [a]);
  assert.deepEqual(claims.map((c) => c.outcome), ["superseded"], "X's FAIL is unseen: the stale answer must not go through");
  assert.equal(room.state(a), "open");
  assert.equal(room.wakes("C"), 0);
  room.complete("W", "Handoff.");
  await room.tick(2);
  assert.equal(room.state(a), "open", "run 2's final is superseded too");
  assert.equal(room.wakes("C"), 0);
  assert.equal(room.running("W"), true, "the next run delivers X's FAIL");
  assert.match(room.prompt("W"), /FAIL from X/);
  assert.equal(room.answer("W", "Fixed the empty string; done.", [a])[0]!.outcome, "answered");
  room.complete("W", "Handoff 2.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("FIX Q3: a correction delivered in the live run does not supersede the explicit answer made in it", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Write the migration.");
  await room.tick();
  room.working("W", "Writing it.");
  room.complete("W", "Started.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also drop the old index." });
  await room.tick();
  assert.equal(room.running("W"), true, "the correction wakes W");
  assert.match(room.prompt("W"), /drop the old index/);
  assert.deepEqual(room.answer("W", "Migration written, old index dropped.", [a]).map((c) => c.outcome), ["answered"]);
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("K1 Q4: a correction that lands during the live run (after its watermark) supersedes the explicit answer", async () => {
  room = await Room.create();
  const { a } = await workingAndReview(room, "PASS");
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also handle emoji." });
  assert.deepEqual(room.answer("W", "Done (has not seen the correction).", [a]).map((c) => c.outcome), ["superseded"]);
  assert.equal(room.state(a), "open");
  room.complete("W", "Handoff.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 0);
  assert.match(room.prompt("W"), /handle emoji/);
});

test("K1 Q5: a run on other work: the review answer landing during it (unseen) supersedes the explicit answer of A", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Implement slugify; have V review it.");
  await room.tick();
  room.post("W", "V", "Review slugify please.");
  room.working("W", "Waiting for the review.");
  room.complete("W", "Sent for review.");
  await room.tick();
  assert.equal(room.running("V"), true);
  const b = ask(room, "C", "W", "B: a quick question.");
  await room.tick();
  assert.equal(room.running("W"), true, "B wakes W");
  room.complete("V", "FAIL: wrong.");
  await room.tick();
  assert.equal(room.running("W"), true, "still B's run");
  assert.deepEqual(room.answer("W", "A is done (has not seen V's FAIL).", [a]).map((c) => c.outcome), ["superseded"]);
  room.complete("W", "B: 42.");
  await room.tick(2);
  assert.equal(room.state(b), "answered");
  assert.equal(room.state(a), "open");
});

test("FIX+WAKE Q6: two requests under one work: activity, one reviewed: answered together in the delivering run, each requester once", async () => {
  room = await Room.create({ seats: ["C", "W", "V", "X"] });
  const a = ask(room, "C", "W", "A: implement slugify; have V review it.");
  const b = ask(room, "X", "W", "B: document slugify.");
  await room.tick();
  room.post("W", "V", "Review slugify please.", a);
  room.working("W", "Both in progress.");
  room.complete("W", "Sent for review.");
  await room.tick();
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.deepEqual(room.answer("W", "A and B done.", [a, b]).map((c) => c.outcome), ["answered", "answered"]);
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("C"), 1);
  assert.equal(room.wakes("X"), 1);
});

test("FIX Q7: bg: activity variant: background work held A, the review's answer delivered in run 2, explicit answer there is answered", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the slow check in the background and have V review the patch.");
  await room.tick();
  room.post("W", "V", "Review the patch please.");
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started; review asked.");
  await room.tick();
  assert.ok(activity(room, "bg:"), "bg: registered");
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.deepEqual(room.answer("W", "slow-check passed and the review passed.", [a]).map((c) => c.outcome), ["answered"]);
  room.fake.background(room.threadOf("W"), []);
  room.complete("W", "Handoff.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("WAKE Q8: second review still open: the explicit answer is pending_activity; X's answer later lets the final answer A once", async () => {
  room = await Room.create({ seats: ["C", "W", "V", "X"] });
  const a = ask(room, "C", "W", "Implement slugify; have V and X review it.");
  await room.tick();
  room.post("W", "V", "Review (V).");
  room.post("W", "X", "Review (X).");
  room.working("W", "Waiting for both.");
  room.complete("W", "Sent.");
  await room.tick();
  room.complete("V", "PASS from V.");
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.deepEqual(room.answer("W", "Done (X still reviewing).", [a]).map((c) => c.outcome), ["pending_activity"]);
  room.complete("W", "Handoff.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 0);
  room.complete("X", "PASS from X.");
  await room.tick(2);
  assert.equal(room.running("W"), true);
  room.complete("W", "Both passed; done.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});

test("Q9: a replayed answer command (same ID) reports the same outcome and appends nothing", async () => {
  room = await Room.create();
  const { a } = await workingAndReview(room, "PASS");
  const first = room.host.answer(room.room, { actor: "W", id: "answer-fixed", body: "Done and reviewed.", requestIds: [a] }).claims;
  const head = room.p.events.length;
  const again = room.host.answer(room.room, { actor: "W", id: "answer-fixed", body: "Done and reviewed.", requestIds: [a] }).claims;
  assert.deepEqual(again, first);
  assert.equal(room.p.events.length, head);
  assert.deepEqual(first.map((c) => c.outcome), ["answered"]);
});

test("Q10: K1 unchanged without working: case-7 shape, the final is superseded and the next run answers A once", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Implement slugify; have V review it.");
  await room.tick();
  room.post("W", "V", "Review while I keep working.");
  await room.tick();
  room.complete("V", "Finding: wrong.");
  await room.tick();
  room.complete("W", "A is done.");
  await room.tick();
  assert.equal(room.state(a), "open");
  await room.tick();
  assert.match(room.prompt("W"), /Finding: wrong/);
  room.complete("W", "Fixed.");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
});
