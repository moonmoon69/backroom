/**
 * "Lean semantics" §6: cancel, with the core's interrupt control neutralised by the host until L6. And the reviewer's
 * hunts 1 and 3: a cancel must never leave a seat stopping while it works on other requests (its posts refused, a
 * review lost), and must never turn into a late-output notice that wakes the Consigliere for nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function unresolvedControls(r: Room): string[] {
  return [...r.p.controls.values()].filter((c) => c.phase !== "obsolete").map((c) => `${c.id}:${c.phase}`);
}

/** The user asks C for U; C hands A to W; W's run on A is running. */
async function wOnA(r: Room): Promise<{ u: string; a: string }> {
  const u = r.user("C", "Fix the dates and report.");
  await r.tick();
  const a = r.post("C", "W", "Fix dates.ts.");
  r.complete("C", "Handed to W.");
  await r.tick();
  assert.equal(r.running("W"), true);
  return { u, a };
}

test("§6: cancelling a run's only request interrupts it; no control stays unresolved; the parent can still be answered", async () => {
  room = await Room.create();
  const { u, a } = await wOnA(room);
  const cWakes = room.wakes("C");
  const result = await room.cancel("C", a);
  assert.deepEqual(result, { applied: true, deferred: false });
  assert.equal(room.running("W"), false, "the turn was interrupted");
  assert.deepEqual(unresolvedControls(room), []);
  await room.tick();
  assert.deepEqual(room.notices(), [], "an interrupt the host sent for a cancel is not a failure");
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.ok(final.disposition.kind === "yield" || final.disposition.kind === "silent");
  assert.equal(room.p.seats.get("W")!.status, "active");
  assert.equal(room.wakes("C"), cWakes, "the Consigliere is not woken by the interrupted turn");
  // W is told of the cancel once; its reply answers nothing.
  assert.equal(room.running("W"), true);
  assert.match(room.prompt("W"), /Request cancelled/);
  room.complete("W", "Stopped.");
  await room.tick(2);
  assert.equal(room.wakes("C"), cWakes);
  assert.deepEqual(room.answer("C", "Cancelled the fix; nothing changed.", [u]).map((c) => c.outcome), ["answered"]);
  room.assertQuiet();
});

test("hunt 1: cancelling one of several requests in a run defers to the turn's end; the seat is never stopping and its review is not lost", async () => {
  room = await Room.create();
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A: fix dates.ts." }).events[0]!.id;
  const b = room.host.request(room.room, { actor: "C", id: "B", to: "W", body: "B: fix text.ts." }).events[0]!.id;
  await room.tick();
  assert.match(room.prompt("W"), /A: fix dates[\s\S]*B: fix text/);
  const result = await room.cancel("C", a);
  assert.deepEqual(result, { applied: false, deferred: true });
  assert.equal(room.state(a), "open", "applies when the turn ends");
  assert.equal(room.p.seats.get("W")!.status, "active", "never stopping");
  assert.equal(room.running("W"), true, "B's work is not interrupted");
  assert.ok(room.p.events.some((e) => e.data.kind === "note" && /Cancel of #A requested; it applies when @W's current turn ends/.test(e.data.body)));
  // W's own posts still go through: the review it asks for B.
  const r = room.post("W", "V", "Review my fix to text.ts.", b);
  assert.equal(room.p.requests.get(r)!.parentId, b);
  room.host.note(room.room, { actor: "W", id: room.id("note"), body: "Dropping A as asked." });
  room.complete("W", "B fixed; sent for review. A dropped.");
  await room.tick();
  assert.equal(room.state(a), "cancelled");
  assert.equal(room.state(b), "open", "B waits for its review");
  assert.deepEqual(unresolvedControls(room), []);
  assert.deepEqual(room.notices(), [], "no late-output notice");
  assert.ok(room.outputs().every((o) => o.claims.every((c) => c.outcome !== "late")));
  assert.equal(room.wakes("C"), 0);
  assert.equal(room.running("V"), true, "the review went out");
  // The cancel, applied as the turn ended, reaches W once in its next run (§4: a cancel wakes its owner).
  assert.match(room.prompt("W"), /\[#\d+ cancel from @C: #\d+ is withdrawn\]\nRequest cancelled/);
  room.complete("W", "Noted: A is dropped.");
  await room.tick();
  assert.equal(room.state(b), "open", "the cancel notice answers nothing");
  room.complete("V", "PASS");
  await room.tick();
  assert.match(room.prompt("W"), /PASS/);
  room.complete("W", "B is done and reviewed.");
  await room.tick(2);
  assert.equal(room.state(b), "answered");
  assert.equal(room.wakes("C"), 1, "C is woken once, by B's answer");
  assert.equal(room.wakes("W"), 3);
});

test("a cancel of the only request while the run is still being sent interrupts it once T3 has it", async () => {
  room = await Room.create();
  room.fake.unavailableSends = 1;
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A: fix dates.ts." }).events[0]!.id;
  await room.tick();
  const run = [...room.p.runs.values()].find((x) => x.seatId === "W")!;
  assert.equal(run.phase, "sending");
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 0, "T3 does not have it yet");
  assert.deepEqual(await room.cancel("C", a), { applied: true, deferred: false });
  assert.equal(unresolvedControls(room).length, 1, "the interrupt waits for the T3 run");
  await room.tick();
  assert.deepEqual(unresolvedControls(room), []);
  assert.equal(room.fake.runsOf(room.threadOf("W"))[0]!.status, "interrupted");
  await room.tick();
  assert.equal(room.p.runs.get(run.id)!.phase, "terminal");
  assert.equal(room.p.seats.get("W")!.status, "active");
  assert.deepEqual(room.notices(), []);
});

test("hunt 3: a cancel landing while the host reads the finished run never yields a late-output notice", async () => {
  room = await Room.create();
  const { a } = await wOnA(room);
  const cWakes = room.wakes("C");
  room.complete("W", "A is done.");
  let cancelled: Promise<unknown> | null = null;
  // The cancel lands when the host reads W's thread to import the finished run: T3 has ended it, the journal not yet.
  room.fake.onDetail = { threadId: room.threadOf("W"), run: () => {
    assert.equal(room.p.runs.get(room.p.seats.get("W")!.activeRunId!)!.phase, "running");
    cancelled = room.cancel("C", a);
  } };
  await room.tick();
  await cancelled;
  await room.tick(2);
  assert.equal(room.state(a), "cancelled");
  assert.ok(room.outputs().every((o) => o.claims.every((c) => c.outcome !== "late")), "no late claim");
  assert.deepEqual(room.notices().filter((n) => n.intent === "attention"), [], "no attention notice");
  assert.equal(room.wakes("C"), cWakes, "the Consigliere is not woken");
});

test("a cancel after the final is recorded is simply not applied, and wakes nobody", async () => {
  room = await Room.create();
  const { a } = await wOnA(room);
  room.complete("W", "A is done.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.deepEqual(await room.cancel("C", a), { applied: false, deferred: false });
  assert.deepEqual(room.notices(), []);
});

test("a deferred cancel survives a restart and applies when the turn ends", async () => {
  room = await Room.create();
  room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A." });
  room.host.request(room.room, { actor: "C", id: "B", to: "W", body: "B." });
  await room.tick();
  await room.cancel("C", "A");
  room.restart();
  room.complete("W", "B done; A dropped.");
  await room.tick();
  assert.equal(room.state("A"), "cancelled");
  assert.equal(room.state("B"), "answered");
  assert.deepEqual(room.notices(), []);
});

test("only the requester, the orchestrator or the user may cancel", async () => {
  room = await Room.create();
  room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A." });
  await assert.rejects(room.cancel("V", "A"), /Only whoever asked #A can cancel it/);
});
