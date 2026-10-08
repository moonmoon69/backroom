/**
 * H1 reviewer's probes (Opus12), as H5 leaves them (members only answer; reviews are relayed by the orchestrator).
 * The explicit-answer and activity probes are gone with what they probed; what remains guards K1's correction rule
 * and the wake counts:
 *  - FIX: a correction the run delivered never supersedes its final;
 *  - K1: a correction that lands after the run's watermark supersedes it, and the next run answers once;
 *  - WAKE: the requester is woken exactly once per answer.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function wOutputs(r: Room) {
  return r.outputs().filter((o) => o.author === "W");
}

test("FIX Q3: a correction delivered with the request, in the same run, does not supersede the run's final: answered once, C woken once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Write the migration.");
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also drop the old index." });
  await room.tick();
  assert.match(room.prompt("W"), /Write the migration[\s\S]*drop the old index/);
  room.complete("W", "Migration written, old index dropped.");
  await room.tick();
  assert.deepEqual(wOutputs(room).map((o) => o.claims.map((c) => c.outcome)), [["answered"]]);
  assert.equal(room.wakes("C"), 1);
  assert.match(room.prompt("C"), /old index dropped/);
  room.complete("C", "ok");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  room.assertQuiet();
});

test("K1 Q4: each run is judged by its own watermark: run 2 delivers the first correction, a second lands during it; run 3 answers once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Implement slugify.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Also handle emoji." });
  room.complete("W", "Done (has not seen the correction).");
  await room.tick();
  assert.equal(room.state(a), "open");
  assert.match(room.prompt("W"), /handle emoji/, "run 2 delivers the first correction");
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "And keep digits." });
  room.complete("W", "Done, emoji handled (has not seen the second correction).");
  await room.tick();
  assert.equal(room.state(a), "open");
  assert.match(room.prompt("W"), /keep digits/, "run 3 delivers the second");
  room.complete("W", "Done: emoji handled, digits kept.");
  await room.tick();
  assert.deepEqual(wOutputs(room).map((o) => o.claims.map((c) => c.outcome)), [["superseded"], ["superseded"], ["answered"]]);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1, "superseded finals wake nobody; the answer wakes C once");
  assert.match(room.prompt("C"), /digits kept/);
  assert.doesNotMatch(room.prompt("C"), /has not seen/);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("FIX+WAKE Q6: two requests in one run, C's and the user's, are answered together by its final, each once; C woken once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "A: implement slugify.");
  const b = room.user("W", "B: document slugify.");
  await room.tick();
  assert.match(room.prompt("W"), /A: implement slugify[\s\S]*B: document slugify/);
  room.complete("W", "A and B done.");
  await room.tick();
  const final = wOutputs(room)[0]!;
  assert.deepEqual(final.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"], [b, "answered"]]);
  assert.deepEqual([...final.recipients].sort(), ["$user", "C"]);
  assert.equal(room.wakes("C"), 1);
  room.complete("C", "ok");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("C"), 1);
  room.assertQuiet();
});

test("Q10: K1 case-7 shape, relayed: V reviews while W works, C corrects A with V's finding; W's final is superseded and the next run answers A once", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Implement slugify.");
  const r = room.post("C", "V", "Review slugify on the branch while W works on it.");
  await room.tick();
  assert.ok(room.running("W") && room.running("V"));
  room.complete("V", "Finding: the unicode case is wrong.");
  await room.tick();
  assert.equal(room.state(r), "answered");
  assert.equal(room.running("C"), true, "V's finding wakes C");
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "V found the unicode case is wrong; fix it." });
  room.complete("C", "Relayed V's finding to W.");
  await room.tick();
  room.complete("W", "A is done.");
  await room.tick();
  assert.deepEqual(wOutputs(room).map((o) => o.claims.map((c) => c.outcome)), [["superseded"]]);
  assert.equal(room.state(a), "open");
  assert.match(room.prompt("W"), /unicode case is wrong/);
  room.complete("W", "Fixed the unicode case.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 2, "C woken by V's finding and by A's answer");
  assert.match(room.prompt("C"), /Fixed the unicode case/);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});
