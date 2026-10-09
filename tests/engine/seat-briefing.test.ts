/**
 * B1: Backroom's own request ($system), the seat briefing, in the core. It is to a seat and under nothing; its answer
 * wakes nobody and raises no attention notice; a failed run on it is the orchestrator's notice alone; the orchestrator
 * (never another member) may cancel it, and the seat can then be retired.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomEvent } from "../../src/engine/index.ts";
import { Room, outcomes } from "./helpers.ts";

const notices = (events: readonly RoomEvent[]) => events.flatMap((e) => (e.data.kind === "notice" ? [e.data] : []));

test("B1: Backroom asks a seat for itself: under nothing, to a seat only", () => {
  const r = new Room();
  r.request("A", "V");
  assert.throws(() => r.add({ type: "request", actor: "$system", to: "$user", body: "Standing facts." }), /Backroom asks a seat, under nothing/);
  assert.throws(() => r.add({ type: "request", actor: "$system", to: "W", body: "Standing facts.", parentId: "A" }), /Backroom asks a seat, under nothing/);
  assert.throws(() => r.add({ type: "request", actor: "$system", to: "nobody", body: "Standing facts." }), /unknown seat/);
  // Backroom authors requests only: a post or a cancel of its own is still refused.
  assert.throws(() => r.add({ type: "post", actor: "$system", intent: "note", body: "x" }), /system cannot author member intent/);
});

test("B1: the answer to Backroom's briefing wakes nobody, and is no undeliverable post", () => {
  const r = new Room();
  r.add({ id: "seat-briefing:W:seated", type: "request", actor: "$system", to: "W", body: "Standing facts." });
  const q = r.p.requests.get("seat-briefing:W:seated")!;
  assert.deepEqual([q.owner, q.returnTo, q.parentId], ["W", "$system", null]);
  const run = r.reserve("W")!;
  const answer = r.finish(run, q.id);
  assert.deepEqual(outcomes(answer), ["answered"]);
  const output = answer.events.find((e) => e.data.kind === "output")!.data;
  assert.deepEqual(output.kind === "output" ? output.recipients : null, [], "Backroom reads the journal: nobody is woken");
  assert.deepEqual(notices(answer.events), [], "no attention notice: Backroom is not a retired seat");
  assert.equal(r.p.requests.get(q.id)!.state, "answered");
  r.idle("O", "V", "X");
});

test("B1: a failed run on Backroom's briefing is the orchestrator's notice alone; he cancels the briefing and retires the seat", () => {
  const r = new Room();
  r.add({ id: "seat-briefing:X:seated", type: "request", actor: "$system", to: "X", body: "Standing facts." });
  const run = r.reserve("X")!;
  const failed = r.output(run, { kind: "error", requestIds: ["seat-briefing:X:seated"] });
  const [notice] = notices(failed.events);
  assert.ok(notice);
  assert.deepEqual([notice.intent, notice.recipients, notice.requestIds], ["error", ["O"], ["seat-briefing:X:seated"]], "to the orchestrator, not the user");
  // The owner still owns an open request: retire is refused until it is cancelled.
  assert.throws(() => r.add({ type: "retire", actor: "O", seatId: "X", evidence: "T3 thread idle" }), /open owned requests prevent retirement/);
  // Another member cannot cancel it; the orchestrator (and the user) can.
  assert.throws(() => r.add({ type: "cancel", actor: "V", requestId: "seat-briefing:X:seated" }), /requester authorization required/);
  r.add({ type: "cancel", actor: "O", requestId: "seat-briefing:X:seated" });
  assert.equal(r.p.requests.get("seat-briefing:X:seated")!.state, "cancelled");
  r.add({ type: "retire", actor: "O", seatId: "X", evidence: "T3 thread idle" });
  assert.equal(r.p.seats.get("X")!.status, "retired");
  // The cancel it was not given is undeliverable now, and raises nothing.
  assert.equal(notices(r.log).length, 1);
});
