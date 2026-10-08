import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { EngineStore, decide, fold, unread } from "../../src/engine/index.ts";
import type { Command } from "../../src/engine/index.ts";
import { assertions, outcomes, Room } from "./helpers.ts";
import { DiskRoom } from "./store-fixture.ts";

const retire = (seatId: string, actor = "O", evidence = "thread idle, no background work"): Extract<Command, { type: "retire" }> =>
  ({ type: "retire", id: `retire:${seatId}:${actor}`, actor, seatId, evidence });

test("retire refuses exactly what transfer refuses: a run, no evidence, a provider hold, background work, a control", () => {
  const r = new Room(); r.request("A");
  const w = r.reserve("W")!;
  assert.throws(() => r.add(retire("W")), /old run must be reconciled and stopped/);
  r.finish(w, "A");
  assert.throws(() => r.add({ ...retire("W"), evidence: "" }), /quiescence proof reference required/);

  r.add({ type: "provider_hold", actor: "$system", hold: { key: "h", seatId: "W", runId: null, code: "native_pending", detail: "FAKE pending native work", held: true, scope: "reseat" } });
  assert.throws(() => r.add(retire("W")), /provider uncertainty/);
  r.add({ type: "provider_hold", actor: "$system", hold: { key: "h", seatId: "W", runId: null, code: "native_pending", detail: "FAKE native work ended", held: false, scope: "reseat" } });

  r.request("B"); const w2 = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "bg", runId: w2.id, requestIds: ["B"], status: "pending" });
  r.output(w2, { kind: "yield" });
  assert.throws(() => r.add(retire("W")), /known background work/);
  r.add({ type: "activity_status", actor: "$system", activityId: "bg", status: "done", evidence: "FAKE background ended" });
  r.add({ type: "cancel", actor: "O", requestId: "B" });

  // A cancel during a run whose only request it is prepares an interrupt control: unresolved until obsolete.
  r.request("C"); const w3 = r.reserve("W")!;
  r.add({ type: "cancel", id: "cancel-C", actor: "O", requestId: "C" });
  r.output(w3, { kind: "yield" });
  assert.equal(r.p.seats.get("W")!.activeRunId, null);
  assert.throws(() => r.add(retire("W")), /unresolved runtime control/);
  r.add({ type: "control_phase", actor: "$system", controlId: "cancel-C/interrupt", phase: "obsolete", evidence: "lean: interrupt sent directly" });

  const before = r.log.length;
  const d = r.add(retire("W"));
  assert.deepEqual(d.events.map((e) => e.data.kind), ["seat.retired"]);
  assert.equal(r.log.length, before + 1);
  assert.equal(r.p.seats.get("W")!.status, "retired");
  assertions(r);
});

test("retire refuses while the seat owns an open request, and only the user or the orchestrator retires", () => {
  const r = new Room(); r.request("A");
  assert.throws(() => r.add(retire("W")), /open owned requests prevent retirement/);
  r.finish(r.reserve("W")!, "A");
  assert.throws(() => r.add(retire("W", "V")), /user or orchestrator required/);
  assert.throws(() => r.add(retire("W", "$system")), /user or orchestrator required/);
  assert.throws(() => r.add(retire("$user", "$user")), /unknown seat/);
  r.add(retire("W", "$user"));
  assert.throws(() => r.add({ ...retire("W"), id: "again" }), /old run must be reconciled and stopped/, "a retired seat is not active");
  assert.throws(() => r.add({ type: "transfer", actor: "O", id: "t", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "x", evidence: "idle" }), /old run must be reconciled and stopped/);
  assert.throws(() => r.add({ type: "seat", actor: "$user", id: "reuse", seatId: "W9", threadId: "thread:W" }), /fresh provider thread required/, "the retired seat's thread is never reused");
});

test("a retired seat is never woken: later input is undeliverable with one attention notice, and it cannot author", () => {
  const r = new Room();
  // W asked V something that is still open when W leaves; W owns nothing.
  r.request("A"); const w = r.reserve("W")!;
  r.request("R", "V", "W", "A");
  r.output(w, { kind: "yield" });
  r.add({ type: "cancel", actor: "O", requestId: "A" });
  r.add(retire("W"));
  assert.equal(unread(r.p, "W").length, 0);

  // The answer to what W asked closes R and goes nowhere; the orchestrator is told once.
  const v = r.reserve("V")!;
  const answered = r.finish(v, "R");
  assert.deepEqual(outcomes(answered), ["answered"]);
  const notices = answered.events.filter((e) => e.data.kind === "notice");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]!.data.kind === "notice" ? notices[0]!.data.recipients : null, ["O"]);
  assert.equal(unread(r.p, "W").length, 0);
  assert.throws(() => r.reserve("W"), /not active/, "no run is ever reserved for a retired seat");

  // A request to it is kept on the board but is undeliverable.
  const d = r.add({ type: "request", id: "late", actor: "O", to: "W", body: "one more thing" });
  assert.ok(d.events.some((e) => e.data.kind === "notice" && e.data.intent === "attention"));
  assert.equal(unread(r.p, "W").length, 0);
  assert.throws(() => r.reserve("W"), /not active/);

  assert.throws(() => r.add({ type: "post", actor: "W", intent: "note", body: "still here" }), /author seat is not active/);
  assert.throws(() => r.add({ type: "request", actor: "W", to: "V", body: "help" }), /author seat is not active/);
  r.idle("V"); assertions(r);
});

test("retiring the orchestrator leaves the room without one; designate moves, clears and refuses", () => {
  const r = new Room();
  assert.throws(() => r.add({ type: "designate", actor: "O", id: "d0", seatId: "W" }), /only the user designates/);
  assert.throws(() => r.add({ type: "designate", actor: "$user", id: "d1", seatId: "nobody" }), /unknown seat/);
  assert.equal(r.add({ type: "designate", actor: "$user", id: "d2", seatId: "O" }).outcome, "idle", "no change, no event");

  r.add({ type: "designate", actor: "$user", id: "d3", seatId: "W" });
  assert.equal(r.p.orchestrator, "W");
  // Rights and notices follow the mark.
  assert.throws(() => r.add({ type: "seat", actor: "O", id: "s1", seatId: "N", threadId: "thread:N" }), /user or orchestrator required/);
  r.add({ type: "seat", actor: "W", id: "s2", seatId: "N", threadId: "thread:N" });
  r.request("A", "V", "$user");
  const v = r.reserve("V")!;
  const failed = r.output(v, { kind: "error", requestIds: ["A"] });
  const notice = failed.events.find((e) => e.data.kind === "notice")!;
  assert.deepEqual(notice.data.kind === "notice" ? notice.data.recipients.sort() : null, ["$user", "W"]);

  r.add({ type: "designate", actor: "$user", id: "d4", seatId: null });
  assert.equal(r.p.orchestrator, null);
  r.add({ type: "designate", actor: "$user", id: "d5", seatId: "O" });
  r.add(retire("O", "O"));
  assert.equal(r.p.orchestrator, null, "the orchestrator retired himself");
  assert.throws(() => r.add({ type: "designate", actor: "$user", id: "d6", seatId: "O" }), /orchestrator must be an active seat/);
  r.add({ type: "designate", actor: "$user", id: "d7", seatId: "X" });
  assert.equal(fold(r.log).orchestrator, "X");
  assertions(r);
});

test("retire and designate are journaled, replayed by command identity, and rebuild to the same projection", () => {
  const room = new DiskRoom();
  try {
    room.request("A");
    const run = room.reserve("W");
    room.add(room.outputCommand(run, { kind: "answer", requestIds: ["A"] }));
    const command: Command = { type: "retire", id: "retire-W", actor: "O", seatId: "W", evidence: "idle" };
    const first = room.store.execute(room.room, command);
    assert.equal(first.replayed, false);
    const again = room.store.execute(room.room, command);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.events.map((e) => e.id), first.events.map((e) => e.id));
    room.add({ type: "designate", actor: "$user", id: "designate-V", seatId: "V" });
    assert.throws(() => room.store.execute(room.room, { ...command, evidence: "changed" }), /conflicting command identity reuse/);

    room.store.close();
    room.store = new EngineStore(room.path);
    const p = room.store.project(room.room);
    assert.equal(p.seats.get("W")!.status, "retired");
    assert.equal(p.orchestrator, "V");
    assert.equal(room.store.audit(room.room).ok, true);
    room.store.rebuild(room.room);
    const rebuilt = room.store.project(room.room);
    assert.equal(rebuilt.orchestrator, "V");
    assert.equal(rebuilt.seats.get("W")!.status, "retired");
    assert.deepEqual(fold(room.store.load(room.room)).orchestrator, "V");
    // decide over the stored log agrees with the store about what a retired seat may do.
    assert.throws(() => decide(room.store.load(room.room), { type: "post", id: "n", actor: "W", intent: "note", body: "x" }), /author seat is not active/);
  } finally {
    room.store.close();
    rmSync(room.dir, { recursive: true, force: true });
  }
});
