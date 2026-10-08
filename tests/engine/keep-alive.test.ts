/**
 * H6: the core's `keep_alive`. Backroom ($system) wakes one idle active seat with a `keep-alive` notice: it is that
 * seat's input and nobody else's, asks nothing and answers nothing, and a failed run that carried only keep-alives is
 * not fresh work, so its error notice goes to nobody.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { unread } from "../../src/engine/index.ts";
import { assertions, Room } from "./helpers.ts";

test("keep_alive: one notice from Backroom to the idle seat only, delivered as a keep-alive input that asks nothing", () => {
  const r = new Room();
  const d = r.add({ type: "keep_alive", actor: "$system", id: "keep-alive:O:t3run-1", seatId: "O", body: "Keep-alive.\n[T3 status of @W: idle]" });
  assert.equal(d.outcome, "appended");
  assert.equal(d.events.length, 1);
  const e = d.events[0]!;
  assert.deepEqual(e.data, { kind: "notice", intent: "keep-alive", body: "Keep-alive.\n[T3 status of @W: idle]", requestIds: [], author: "$system", recipients: ["O"], causeId: "O" });
  assert.deepEqual(unread(r.p, "O").map((i) => [i.intent, i.requestIds]), [["keep-alive", []]]);
  for (const seat of ["W", "V", "X"]) assert.equal(unread(r.p, seat).length, 0, seat);
  // Its run's final answers nothing: an answer may name no request the keep-alive brought.
  const run = r.reserve("O")!;
  assert.deepEqual(run.envelope.inputs.map((i) => i.intent), ["keep-alive"]);
  r.output(run, { kind: "silent" });
  assert.equal(r.p.runs.get(run.id)!.phase, "terminal");
  assert.equal(r.p.seats.get("O")!.cursor, run.through);
  // The same command again is a duplicate, never a second wake.
  assert.equal(r.add({ type: "keep_alive", actor: "$system", id: "keep-alive:O:t3run-1", seatId: "O", body: "Keep-alive.\n[T3 status of @W: idle]" }).outcome, "duplicate");
  assert.equal(unread(r.p, "O").length, 0);
  assertions(r);
});

test("keep_alive is Backroom's, for an idle active seat, with a body", () => {
  const r = new Room();
  assert.throws(() => r.add({ type: "keep_alive", actor: "O", seatId: "W", body: "Keep-alive." }), /adapter\/store principal required/);
  assert.throws(() => r.add({ type: "keep_alive", actor: "$user", seatId: "W", body: "Keep-alive." }), /adapter\/store principal required/);
  assert.throws(() => r.add({ type: "keep_alive", actor: "$system", seatId: "W", body: "" }), /keep-alive body required/);
  assert.throws(() => r.add({ type: "keep_alive", actor: "$system", seatId: "nobody", body: "Keep-alive." }), /unknown seat/);
  r.request("A");
  r.reserve("W");
  assert.throws(() => r.add({ type: "keep_alive", actor: "$system", seatId: "W", body: "Keep-alive." }), /keep-alive needs an idle active seat/);
  r.add({ type: "retire", actor: "$user", seatId: "X", evidence: "quiet in T3" });
  assert.throws(() => r.add({ type: "keep_alive", actor: "$system", seatId: "X", body: "Keep-alive." }), /keep-alive needs an idle active seat/);
});

test("a failed run that carried only a keep-alive is no fresh work: its error notice wakes nobody, the orchestrator included", () => {
  const r = new Room();
  r.add({ type: "keep_alive", actor: "$system", seatId: "W", body: "Keep-alive." });
  const run = r.reserve("W")!;
  const d = r.output(run, { kind: "error", requestIds: [] });
  const notice = d.events.find((e) => e.data.kind === "notice")!;
  assert.ok(notice.data.kind === "notice");
  assert.deepEqual([notice.data.intent, notice.data.recipients], ["error", []]);
  assert.match(notice.data.body, /^Recovery failure/);
  assert.equal(unread(r.p, "O").length, 0, "the orchestrator is not woken");
  // observe_end with a failure says the same.
  r.add({ type: "keep_alive", actor: "$system", seatId: "W", body: "Keep-alive." });
  const again = r.reserve("W")!;
  r.output(again, { kind: "silent" }, false, { sourceKey: "final:again" });
  const ended = r.add({ type: "observe_end", actor: "$system", runId: again.id, sourceKey: "final:again", failure: "T3 lost the session", evidence: "t3run failed" });
  const second = ended.events.find((e) => e.data.kind === "notice")!;
  assert.ok(second.data.kind === "notice");
  assert.deepEqual(second.data.recipients, []);
  assert.equal(unread(r.p, "O").length, 0);
});
