/**
 * "Lean semantics" §6: cancel; the core records it and the host sends T3 the interrupt (no control on the journal since
 * L6). And the reviewer's hunts 1 and 3: a cancel must never interrupt a turn that works on other requests too (an
 * answer lost), and must never turn into a late-output notice. Since H5 a member's reply that answers nothing (to a
 * cancel, or after one) is a follow-up on its request and wakes the Consigliere.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { T3Unavailable } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** The interrupts T3 was sent, by command ID; and no control is on the journal. */
function interrupts(r: Room): string[] {
  assert.equal(r.p.events.some((e) => (e.data.kind as string).startsWith("control.")), false);
  return r.fake.commands.filter((c) => c.type === "run.interrupt").map((c) => c.commandId);
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

test("§6: cancelling a run's only request interrupts it, once; the stopped turn wakes nobody; W's reply to the cancel is a follow-up that wakes C once", async () => {
  room = await Room.create();
  const { u, a } = await wOnA(room);
  assert.equal(room.state(u), "answered", "C's hand-off answered U: nothing is held since H5");
  const cWakes = room.wakes("C");
  const result = await room.cancel("C", a);
  assert.deepEqual(result, { applied: true, deferred: false, stopped: true });
  assert.equal(room.running("W"), false, "the turn was interrupted");
  assert.equal(interrupts(room).length, 1);
  await room.tick();
  assert.deepEqual(room.notices(), [], "an interrupt the host sent for a cancel is not a failure");
  // The stopped turn answers nothing (A is cancelled) and is no failure: what it wrote is on the board and wakes nobody,
  // since C stopped it itself.
  const final = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual([final.disposition, final.recipients], [{ kind: "yield" }, []]);
  assert.equal(room.p.seats.get("W")!.status, "active");
  assert.equal(room.wakes("C"), cWakes, "the stopped turn does not wake C");
  // W is told of the cancel once; its reply answers nothing: a follow-up on A, which wakes C once.
  assert.equal(room.running("W"), true);
  assert.match(room.prompt("W"), /Request cancelled/);
  room.complete("W", "Stopped.");
  await room.tick(2);
  const reply = room.outputs().filter((o) => o.author === "W").at(-1)!;
  assert.deepEqual(reply.disposition, { kind: "progress", requestIds: [a], milestone: "follow-up" });
  assert.equal(reply.body, "[T3 status of @W: idle]\n\nStopped.");
  assert.equal(room.wakes("C"), cWakes + 1, "C is woken once, by W's reply to the cancel");
  room.complete("C", "Cancelled the fix; nothing changed.");
  await room.tick(2);
  assert.equal(room.wakes("C"), cWakes + 1);
  assert.equal(room.answeredClaims(u).length, 1);
  room.assertQuiet();
});

test("hunt 1 (M1): cancelling one of several requests in a run applies at once and goes into the running turn; nothing is interrupted, B's answer is not lost, and no turn of its own follows", async () => {
  room = await Room.create();
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A: fix dates.ts." }).events[0]!.id;
  const b = room.host.request(room.room, { actor: "C", id: "B", to: "W", body: "B: fix text.ts." }).events[0]!.id;
  await room.tick();
  assert.match(room.prompt("W"), /A: fix dates[\s\S]*B: fix text/);
  const result = await room.cancel("C", a);
  assert.deepEqual(result, { applied: true, deferred: false, stopped: false });
  assert.equal(room.state(a), "cancelled", "at once");
  assert.equal(room.running("W"), true, "B's work is not interrupted");
  await room.tick();
  const told = room.fake.thread(room.threadOf("W")).turnItems.flatMap((i) => (i.type === "user_message" && i.inputIntent === "steer" ? [i.text] : []));
  assert.equal(told.length, 1, "the cancel went into W's running turn");
  assert.match(told[0]!, /\[#\d+ cancel from @C: #\d+ is withdrawn; stop any work on it\]\nRequest cancelled/);
  // W's own notes still go through: the seat is not left stopping while it works on B.
  room.host.note(room.room, { actor: "W", id: room.id("note"), body: "Dropping A as asked." });
  room.complete("W", "B fixed. A dropped.");
  await room.tick();
  assert.equal(room.state(b), "answered", "the turn's final answers B (nothing holds it since H5)");
  assert.deepEqual(room.outputs().filter((o) => o.author === "W").at(-1)!.disposition, { kind: "answer", requestIds: [b] });
  assert.deepEqual(interrupts(room), [], "the cancel interrupts nothing");
  assert.deepEqual(room.notices(), [], "no late-output notice");
  assert.ok(room.outputs().every((o) => o.claims.every((c) => c.outcome !== "late")));
  assert.equal(room.wakes("C"), 1, "C is woken once, by B's answer");
  room.complete("C", "Ok.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("W"), 1, "no turn of its own to be told of the cancel");
  assert.equal(room.wakes("C"), 1, "and no second wake for C");
  room.assertQuiet();
});

test("a cancel of the only request while the run is still being sent interrupts it once T3 has it", async () => {
  room = await Room.create();
  room.fake.unavailableSends = 1;
  const a = room.host.request(room.room, { actor: "C", id: "A", to: "W", body: "A: fix dates.ts." }).events[0]!.id;
  await room.tick();
  const run = [...room.p.runs.values()].find((x) => x.seatId === "W")!;
  assert.equal(run.phase, "sending");
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 0, "T3 does not have it yet");
  assert.deepEqual(await room.cancel("C", a), { applied: true, deferred: false, stopped: true });
  assert.deepEqual(interrupts(room), [], "the interrupt waits for the T3 run");
  await room.tick();
  assert.equal(interrupts(room).length, 1);
  assert.equal(room.fake.runsOf(room.threadOf("W"))[0]!.status, "interrupted");
  await room.tick();
  assert.equal(room.p.runs.get(run.id)!.phase, "terminal");
  assert.equal(room.p.seats.get("W")!.status, "active");
  assert.deepEqual(room.notices(), []);
});

test("an interrupt T3 could not take (unreachable) is sent again on a later tick, with the same command ID", async () => {
  room = await Room.create();
  const { a } = await wOnA(room);
  const interrupt = room.fake.interruptRun.bind(room.fake);
  let refusals = 1;
  room.fake.interruptRun = async (input) => {
    if (refusals > 0) {
      refusals -= 1;
      room.fake.commands.push({ type: "run.interrupt.unreachable", commandId: input.commandId, threadId: input.threadId, payload: input });
      throw new T3Unavailable("T3 is not reachable (simulated)");
    }
    return interrupt(input);
  };
  assert.deepEqual(await room.cancel("C", a), { applied: true, deferred: false, stopped: true });
  assert.equal(room.running("W"), true, "not interrupted yet");
  await room.tick();
  assert.equal(room.running("W"), false);
  const tried = room.fake.commands.filter((c) => c.type.startsWith("run.interrupt")).map((c) => c.commandId);
  assert.equal(tried.length, 2);
  assert.equal(tried[0], tried[1], "the same command ID");
  await room.tick();
  assert.deepEqual(room.notices(), [], "the stopped turn is not a failure");
});

test("'cancel that, do this instead': a message sent while T3 is still ending the cancelled turn waits for a fresh turn (review P6; an old journal's steer: ID)", async () => {
  room = await Room.create();
  const { a } = await wOnA(room);
  // T3 takes the interrupt command, but the turn takes a moment to stop (as a real agent harness does).
  const taken: string[] = [];
  room.fake.interruptRun = async (input) => { taken.push(input.commandId); };
  await room.cancel("C", a);
  assert.equal(taken.length, 1);
  room.host.request(room.room, { actor: "$user", id: "steer:1", to: "W", body: "Instead: fix text.ts." });
  await room.tick(2);
  const t3 = room.fake.thread(room.threadOf("W"));
  assert.equal(t3.messages.some((m) => m.role === "user" && m.runId === t3.runs[0]!.id && /fix text\.ts/.test(m.text)), false, "nothing is steered into the turn being stopped");
  room.fake.completeRun(room.threadOf("W"), { text: "(stopped)", outcome: "interrupted" });
  await room.tick(2);
  assert.deepEqual(room.notices().filter((n) => n.intent === "error"), [], "the stopped turn is not a failure");
  assert.equal(room.state("steer:1"), "open");
  assert.equal(room.running("W"), true, "W's next turn carries the request");
  assert.match(room.prompt("W"), /fix text\.ts/);
});

test("hunt 3: a cancel landing while the host reads the finished run never yields a late-output notice; the reply is a follow-up", async () => {
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
  // H5: W's final answers nothing now that A is cancelled; it is a follow-up on A and wakes C once, as a reply.
  const reply = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(reply.disposition, { kind: "progress", requestIds: [a], milestone: "follow-up" });
  assert.equal(room.wakes("C"), cWakes + 1, "the Consigliere is woken once, by W's reply");
  assert.match(room.prompt("C"), /A is done/);
});

test("a cancel after the final is recorded is simply not applied, and wakes nobody", async () => {
  room = await Room.create();
  const { a } = await wOnA(room);
  room.complete("W", "A is done.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.deepEqual(await room.cancel("C", a), { applied: false, deferred: false, stopped: false });
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
