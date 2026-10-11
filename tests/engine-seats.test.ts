/**
 * L4b: the seat lifecycle on the engine (src/app/engineSeats.ts), through the room commands the page and the CLI send,
 * on a full stack with the fake T3. Every T3 run on a member's thread is one wake of it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { CONSIGLIERE_RULES_KEY, ENGINE_BOARD_RULES, ENGINE_DEFAULT_CONSIGLIERE_RULES, engineConsigliereRules, engineSeatFacts, engineSeatInstruction } from "../src/app/consigliere.ts";
import { readEngineReseats } from "../src/app/reseat.ts";
import { standingText } from "../src/briefing/assemble.ts";
import { RoomError } from "../src/domain/errors.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { decide, inputTree } from "../src/engine/index.ts";
import type { ClaimOutcome, Projection, Run } from "../src/engine/index.ts";
import { bindingSource } from "../src/runtime/index.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { RuntimeFake } from "./runtime/helpers.ts";

class Seats {
  readonly dir = mkdtempSync(join(tmpdir(), "backroom-seats-"));
  readonly fake = new RuntimeFake();
  s: AppStack;
  roomId = "";
  readonly ids: Record<string, string> = {};
  private serial = 0;

  private constructor() {
    this.s = this.stack();
  }

  private stack(): AppStack {
    return createStack({ dbPath: join(this.dir, "rooms.sqlite"), adapter: this.fake, briefingBudgetChars: 60000, latestRelease: async () => null });
  }

  /** Throw the service away and start a new one over the same files and the same T3, as a restart does. */
  restart(options: { withoutJournal?: boolean } = {}): void {
    this.s.close();
    // The journal gone (board.sqlite and its WAL files): rooms.sqlite as a database from before the engine has it.
    if (options.withoutJournal) for (const file of ["board.sqlite", "board.sqlite-wal", "board.sqlite-shm"]) rmSync(join(this.dir, file), { force: true });
    this.s = this.stack();
  }

  /** A room with these members; the first is made the Consigliere unless `consigliere` is null. Seat briefings answered. */
  static async create(aliases = ["C", "W", "V"], consigliere: string | null = "C"): Promise<Seats> {
    const h = new Seats();
    h.roomId = ((await h.run({ type: "room.create", projectId: "project_demo", title: "seats" })) as { roomId: string }).roomId;
    for (const alias of aliases) await h.add(alias);
    if (consigliere) {
      await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids[consigliere]! });
      await h.acknowledge();
    }
    return h;
  }

  async add(alias: string): Promise<string> {
    const { participantId } = (await this.run({ type: "participant.create", roomId: this.roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string };
    this.ids[alias] = participantId;
    return participantId;
  }

  run(command: RoomCommandInput): Promise<unknown> {
    return this.s.service.execute(parseCommand(command));
  }

  async refused(command: RoomCommandInput, pattern: RegExp): Promise<RoomError> {
    try {
      await this.run(command);
    } catch (error) {
      assert.ok(error instanceof RoomError, `a RoomError, not ${String(error)}`);
      assert.match(error.message, pattern);
      return error;
    }
    assert.fail(`${command.type} was not refused`);
  }

  get host() {
    return this.s.engine!;
  }

  get p(): Projection {
    return this.host.view(this.roomId);
  }

  seat(alias: string): string {
    return this.s.repos.currentBinding(this.ids[alias]!)!.id;
  }

  thread(alias: string): string {
    return this.s.repos.currentBinding(this.ids[alias]!)!.threadId;
  }

  async tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) await this.s.engine.tick();
  }

  wakes(alias: string): number {
    return this.fake.runsOf(this.thread(alias)).length;
  }

  running(alias: string): boolean {
    return this.fake.liveRun(this.thread(alias)) !== null;
  }

  complete(alias: string, text: string): void {
    this.fake.completeRun(this.thread(alias), { text });
  }

  prompt(alias: string): string {
    const runs = this.fake.runsOf(this.thread(alias));
    return this.fake.promptOf(this.thread(alias), runs[runs.length - 1]!);
  }

  /** Dispatch what is waiting and answer every running turn with one line, until nothing runs. */
  async acknowledge(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
      await this.tick();
      const busy = Object.keys(this.ids).filter((alias) => !this.s.repos.getParticipant(this.ids[alias]!)!.retiredAt && this.running(alias));
      if (busy.length === 0) return;
      for (const alias of busy) this.complete(alias, "Acknowledged.");
    }
    assert.fail("turns kept coming");
  }

  /** A request on the board: from the user or the Consigliere's seat (members do not post, H5). */
  request(from: string, to: string, body: string): string {
    const id = `req:${++this.serial}`;
    this.host.request(this.roomId, { actor: from === "$user" ? "$user" : this.seat(from), id, to: this.seat(to), body });
    return id;
  }

  claims(requestId: string): ClaimOutcome[] {
    return this.p.events.flatMap((e) => (e.data.kind === "output" ? e.data.claims.filter((c) => c.requestId === requestId) : []));
  }

  /** The runs the engine reserved for a seat, oldest first. */
  runs(seatId: string): Run[] {
    return [...this.p.runs.values()].filter((r) => r.seatId === seatId);
  }

  /** T3 takes interrupts but does not stop the turn yet: a real turn takes a while to stop. */
  slowInterrupts(): void {
    this.fake.interruptRun = async () => {};
  }

  close(): void {
    this.s.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

test("seating: a member gets its seat on the board and, in a Consigliere's room, the seat briefing; its acknowledgement wakes nobody", async () => {
  const h = await Seats.create();
  try {
    // The Consigliere's mark is the journal's orchestrator; the members were briefed by Backroom, and he slept through it.
    assert.equal(h.p.orchestrator, h.seat("C"));
    for (const alias of ["C", "W", "V"]) assert.equal(h.p.seats.get(h.seat(alias))?.threadId, h.thread(alias));
    assert.equal(h.wakes("C"), 0);
    assert.equal(h.wakes("W"), 1);
    const briefing = h.prompt("W");
    assert.match(briefing, /You are seated in a room whose Consigliere is @C/);
    assert.ok(briefing.includes(engineSeatInstruction({ alias: "C" })), "the engine's seat instruction");
    assert.doesNotMatch(briefing, /rooms-board (working|answer|follow|post)\b|--for/, "no command members no longer have (H5)");
    assert.equal(briefing.includes("Standing facts of this room"), false, "the seat facts are the assignment here, not repeated in the standing part");

    const x = await h.add("X");
    const seatX = h.seat("X");
    assert.equal(h.p.seats.get(seatX)?.status, "active");
    const request = h.p.requests.get(`seat-briefing:${seatX}:seated`)!;
    assert.deepEqual([request.owner, request.returnTo], [seatX, "$system"], "Backroom's request, not the user's (B1)");
    await h.acknowledge();
    assert.equal(h.p.requests.get(request.id)!.state, "answered");
    assert.equal(h.wakes("C"), 0, "nobody is woken by a seat briefing's acknowledgement");
    const ack = h.p.events.find((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === request.id))!;
    assert.deepEqual(ack.data.kind === "output" ? ack.data.recipients : null, [], "the acknowledgement is to nobody: not an answer to the user");
    assert.ok(x);
  } finally {
    h.close();
  }
});

test("Consigliere: making one briefs every member once, moving him tells them, clearing him clears the orchestrator", async () => {
  const h = await Seats.create(["C", "W", "V"], null);
  try {
    assert.equal(h.p.orchestrator, null);
    await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.W! });
    assert.equal(h.p.orchestrator, h.seat("W"));
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, h.ids.W);
    await h.acknowledge();
    assert.deepEqual([h.wakes("C"), h.wakes("W"), h.wakes("V")], [1, 0, 1]);
    assert.match(h.prompt("V"), /whose Consigliere is @W/);
    // Naming him again changes nothing.
    await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.W! });
    await h.acknowledge();
    assert.deepEqual([h.wakes("C"), h.wakes("W"), h.wakes("V")], [1, 0, 1]);

    await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.V! });
    assert.equal(h.p.orchestrator, h.seat("V"));
    await h.acknowledge();
    assert.deepEqual([h.wakes("C"), h.wakes("W"), h.wakes("V")], [2, 1, 1]);
    assert.match(h.prompt("W"), /The Consigliere of this room is now @V/);

    // His own briefing carries the rules and how the board completes work.
    h.request("$user", "V", "What is the plan?");
    await h.tick();
    const rules = h.prompt("V");
    assert.match(rules, /Rules for the Consigliere:/);
    for (const rule of ENGINE_BOARD_RULES) assert.ok(rules.includes(rule), `missing: ${rule.slice(0, 60)}`);
    assert.ok(rules.includes("- Scope is yours: when a member finds a defect in the code under change, have it fixed before you report unless the user said otherwise; do not ask a member to decide it.\n"));
    h.complete("V", "The plan is ...");
    await h.tick();

    await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: null });
    assert.equal(h.p.orchestrator, null);
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, null);
    await h.acknowledge();
    assert.deepEqual([h.wakes("C"), h.wakes("W"), h.wakes("V")], [2, 1, 2], "clearing asks nobody anything");
  } finally {
    h.close();
  }
});

test("retire refuses with open work, naming it, and goes ahead once it is done; the thread setting is honoured", async () => {
  const h = await Seats.create();
  try {
    const a = h.request("C", "W", "Build the thing.");
    // Before its turn on it, W owns the open request: that is open work.
    const error = await h.refused({ type: "participant.retire", participantId: h.ids.W!, thread: "archive" }, /@W cannot be retired now: it owns open request #\d+: answer or cancel it first/);
    assert.doesNotMatch(error.message, /in a turn|activity/);
    assert.equal(h.p.seats.get(h.seat("W"))!.status, "active", "a refused retire changes nothing");
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, null);
    await h.tick();
    assert.ok(h.running("W"));
    await h.refused({ type: "participant.retire", participantId: h.ids.W!, thread: "archive" }, /@W cannot be retired now: it is in a turn/);
    // A turn the room did not start holds it too: T3 says the thread is busy.
    h.fake.startExternalRun(h.thread("V"), "typed in T3");
    await h.refused({ type: "participant.retire", participantId: h.ids.V!, thread: "keep" }, /@V cannot be retired now: its T3 thread is in a turn/);
    h.fake.completeRun(h.thread("V"), { text: "answered in T3" });

    // Only the Consigliere retires members from the board.
    await assert.rejects(h.s.seats!.retire({ participantId: h.ids.W!, by: h.ids.V!, thread: "keep" }), /Only this room's Consigliere \(@C\) retires members/);

    // W's final answers the request: nothing of it is open any more.
    h.complete("W", "Built; CI passed.");
    await h.tick();
    assert.equal(h.claims(a).filter((c) => c.outcome === "answered").length, 1);
    await h.acknowledge(); // the Consigliere is woken by the replies

    const threadW = h.thread("W");
    const seatW = h.seat("W");
    const result = (await h.s.seats!.retire({ participantId: h.ids.W!, by: h.ids.C!, thread: "archive" })) as { thread?: { result: string } };
    assert.equal(result.thread?.result, "done");
    assert.ok(h.fake.thread(threadW).shell.archivedAt, "archived in T3, as asked");
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    const retired = h.p.events.find((e) => e.data.kind === "seat.retired")!;
    assert.equal(retired.data.kind === "seat.retired" ? retired.data.author : null, h.seat("C"));
    assert.ok(h.s.repos.getParticipant(h.ids.W!)!.retiredAt);

    // Nothing reaches the retired seat; its old thread is never sent anything again.
    const wakes = h.fake.runsOf(threadW).length;
    h.host.request(h.roomId, { actor: h.seat("C"), id: "late", to: seatW, body: "one more thing" });
    await h.tick(2);
    assert.equal(h.fake.runsOf(threadW).length, wakes);
    assert.ok(h.p.events.some((e) => e.data.kind === "notice" && e.data.intent === "attention" && e.data.causeId === "late"));

    // The default thread setting keeps the thread.
    const threadV = h.thread("V");
    const kept = (await h.run({ type: "participant.retire", participantId: h.ids.V!, thread: "keep" })) as { thread?: { result: string } };
    assert.equal(kept.thread?.result, "kept");
    assert.equal(h.fake.thread(threadV).shell.archivedAt ?? null, null);
  } finally {
    h.close();
  }
});

test("retiring the Consigliere clears the mark and the orchestrator", async () => {
  const h = await Seats.create();
  try {
    await h.run({ type: "participant.retire", participantId: h.ids.C!, thread: "keep" });
    assert.equal(h.p.orchestrator, null);
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, null);
  } finally {
    h.close();
  }
});

test("reseat carries every unread input and every owned request exactly once, and the transfer gets no answer from the old seat", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const threadW = h.thread("W");
    // C asks W for A, and the reseat comes while W is in its turn on A. A correction lands in that turn too, so W's
    // final for it is superseded: A stays open.
    const a = h.request("C", "W", "Implement A.");
    await h.tick();
    assert.ok(h.running("W"));
    const reseat = (await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: "finish A" })) as { eventId: string };
    const checkpoint = reseat.eventId;
    assert.match(checkpoint, /^reseat:/);
    assert.deepEqual([h.p.requests.get(checkpoint)!.owner, h.p.requests.get(checkpoint)!.returnTo], [seatW, "$system"], "Backroom's request (B1)");
    await h.refused({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null }, /being reseated already/);
    h.host.correct(h.roomId, { actor: h.seat("C"), id: "fix-A", requestId: a, body: "Use the new API." });
    h.complete("W", "A is written in src/a.ts.");
    await h.tick();
    assert.deepEqual(h.claims(a).map((c) => c.outcome), ["superseded"]);
    assert.equal(h.p.requests.get(a)!.state, "open");
    assert.ok(h.running("W"), "the checkpoint turn");
    assert.match(h.prompt("W"), /Reseat, asked by @C: a fresh seat of the same crew member takes over your work/);
    const wakesC = h.wakes("C");

    // While W writes its checkpoint: C corrects A again, asks W for B, the user asks W for D. W reads none of it.
    h.host.correct(h.roomId, { actor: h.seat("C"), id: "fix-A2", requestId: a, body: "Also handle the empty case." });
    const b = h.request("C", "W", "And B.");
    const d = h.request("$user", "W", "And D, please.");
    const unreadAtCut = ["fix-A2", b, d];

    h.complete("W", "CHECKPOINT: A written in src/a.ts on the new API; next: the empty case.");
    await h.tick();
    // The checkpoint answered only itself; A, B and D stay open and moved to the fresh seat with everything W had not read.
    assert.equal(h.p.requests.get(checkpoint)!.state, "answered");
    const checkpointOutput = h.p.events.find((e) => e.id === h.p.requests.get(checkpoint)!.answerId)!;
    assert.deepEqual(checkpointOutput.data.kind === "output" ? checkpointOutput.data.claims.map((c) => [c.requestId, c.outcome]) : null, [[checkpoint, "answered"]], "the checkpoint is not A's answer");
    assert.equal(h.claims(a).filter((c) => c.outcome === "answered").length, 0);
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const freshId = transfer.data.newSeatId;
    assert.equal(transfer.data.oldSeatId, seatW);
    assert.deepEqual([...transfer.data.owned].sort(), [a, b, d].sort());
    assert.deepEqual(transfer.data.awaited, []);
    assert.deepEqual(inputTree(transfer.data.inherited).map((i) => i.eventId).sort(), [...unreadAtCut].sort());
    assert.match(transfer.data.body, /CHECKPOINT: A written in src\/a.ts/);
    for (const id of [a, b, d]) assert.equal(h.p.requests.get(id)!.owner, freshId);
    const fresh = h.s.repos.getBinding(freshId)!;
    const freshAlias = h.s.repos.getParticipant(fresh.participantId)!.alias;
    h.ids[freshAlias] = fresh.participantId;
    assert.equal(freshAlias, "W2");
    assert.ok(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, "the old member left the room");
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 0);
    assert.equal(h.wakes("C"), wakesC, "the Consigliere slept through the checkpoint");

    // The fresh seat's first turn carries the handover and the takeover, every input exactly once.
    await h.tick();
    assert.ok(h.running("W2"));
    const [first] = h.runs(freshId);
    const delivered = inputTree(first!.envelope.inputs).map((i) => i.eventId);
    assert.equal(new Set(delivered).size, delivered.length, "no input twice");
    for (const id of unreadAtCut) assert.equal(delivered.filter((e) => e === id).length, 1);
    assert.deepEqual(first!.envelope.inputs.map((i) => i.intent), ["transfer", "request"]);
    const oldDelivered = new Set(h.runs(seatW).flatMap((r) => inputTree(r.envelope.inputs).map((i) => i.eventId)));
    assert.deepEqual(delivered.filter((id) => oldDelivered.has(id)), [], "nothing the old seat read is delivered again");
    assert.match(h.prompt("W2"), /You take over @W's work/);

    // The old seat cannot answer what moved: not from a late turn in its old thread, and not even by an output the core
    // is handed for its last run.
    const before = h.p.events.length;
    h.fake.startExternalRun(threadW, "Are you still there?");
    h.fake.completeRun(threadW, { text: "Yes, and A is done." });
    await h.tick(2);
    assert.equal(h.p.events.filter((e, i) => i >= before && "author" in e.data && e.data.author === seatW).length, 0, "the old thread is not imported");
    const lastOld = h.runs(seatW).at(-1)!;
    const late = decide([...h.p.events], { type: "output", actor: "$system", id: "late-old", author: seatW, sourceKey: "late-old", association: { kind: "run", id: lastOld.id }, body: "A is done.", disposition: { kind: "answer", requestIds: [a] } });
    assert.deepEqual(late.events.flatMap((e) => (e.data.kind === "output" ? e.data.claims.map((c) => c.outcome) : [])), ["late"]);
    assert.equal(h.p.requests.get(a)!.state, "open");
    assert.equal(h.p.requests.get(a)!.owner, freshId);

    // The fresh seat answers A, B, D and the takeover with its final: each requester is woken once.
    h.complete("W2", "A done on the new API with the empty case; B and D done.");
    await h.tick();
    for (const id of [a, b, d]) assert.deepEqual(h.claims(id).filter((c) => c.outcome === "answered").map((c) => c.returnTo), [id === d ? "$user" : h.seat("C")]);
    assert.equal(h.wakes("C"), wakesC + 1, "the Consigliere is woken once, with the answer");
    const takeover = [...h.p.requests.values()].find((q) => q.id.startsWith("takeover:"))!;
    assert.equal(takeover.state, "answered");
  } finally {
    h.close();
  }
});

test("a cancelled checkpoint calls the reseat off: the member keeps its seat and its work", async () => {
  const h = await Seats.create();
  try {
    const { eventId } = (await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null })) as { eventId: string };
    await h.host.cancel(h.roomId, { actor: "$user", id: "cancel-checkpoint", requestId: eventId });
    await h.acknowledge();
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 0);
    assert.equal(h.p.seats.get(h.seat("W"))!.status, "active");
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, null);
    const note = h.p.events.find((e) => e.id === `reseat-off:${eventId}`)!;
    assert.match(note.data.kind === "note" ? note.data.body : "", /Reseat of @W called off: its checkpoint request #\d+ was cancelled/);
    // W's reply to the cancel answers nothing: it is a follow-up on the checkpoint, which wakes the Consigliere once (H5).
    const reply = h.p.events.find((e) => e.data.kind === "output" && e.data.author === h.seat("W") && e.data.disposition.kind === "progress")!;
    assert.deepEqual(reply.data.kind === "output" && reply.data.disposition, { kind: "progress", requestIds: [eventId], milestone: "follow-up" });
    assert.equal(h.wakes("C"), 1);
  } finally {
    h.close();
  }
});

test("a reseated Consigliere: the orchestrator and the mark move, the members are told, the user's request goes to the fresh seat", async () => {
  const h = await Seats.create();
  try {
    const seatC = h.seat("C");
    const u = h.request("$user", "C", "Get A built.");
    await h.tick();
    const a = `a:${seatC}`;
    h.host.post(h.roomId, { actor: seatC, id: a, to: h.seat("W"), body: "Build A." });
    assert.equal(h.p.requests.get(a)!.parentId, null, "the Consigliere's post goes under nothing (H5)");
    h.complete("C", "I asked @W for A.");
    await h.tick();
    assert.equal(h.p.requests.get(u)!.state, "answered", "nothing is held: his hand-off answers the user");

    await h.run({ type: "participant.reseat", participantId: h.ids.C!, by: h.ids.C!, plan: null });
    await h.tick();
    assert.match(h.prompt("C"), /takes over as this room's Consigliere/);
    // The user asks him more while he writes the checkpoint: that request goes to the fresh seat.
    const u2 = h.request("$user", "C", "And B, once A is built.");
    h.complete("C", "CHECKPOINT: waiting for @W on A; the user's B is next.");
    await h.tick();
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const freshSeat = transfer.data.newSeatId;
    assert.deepEqual([transfer.data.owned, transfer.data.awaited], [[u2], [a]]);
    assert.equal(h.p.orchestrator, freshSeat);
    const fresh = h.s.repos.getBinding(freshSeat)!.participantId;
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, fresh);
    assert.equal([...h.p.requests.values()].some((q) => q.id.startsWith("takeover:")), false, "he reseated himself: nobody to report to");
    const moved = [...h.p.requests.values()].filter((q) => q.id.startsWith("moved:"));
    assert.deepEqual(moved.map((q) => q.owner).sort(), [h.seat("W"), h.seat("V")].sort(), "every other member is told");
    assert.ok(moved.every((q) => q.returnTo === "$system"), "Backroom's requests (B1)");

    // W answers A: the answer goes to the fresh Consigliere, whose final answers the user's request.
    h.complete("W", "A is built.");
    await h.tick();
    assert.deepEqual(h.claims(a).filter((c) => c.outcome === "answered").map((c) => c.returnTo), [freshSeat]);
    const freshThread = h.s.repos.getBinding(freshSeat)!.threadId;
    assert.ok(h.fake.liveRun(freshThread));
    h.fake.completeRun(freshThread, { text: "A is built; B next." });
    await h.tick();
    assert.equal(h.p.requests.get(u2)!.state, "answered");
  } finally {
    h.close();
  }
});

test("each tick follows the member's thread: its title says room and alias, its model is mirrored", async () => {
  const h = await Seats.create(["C", "W"]);
  try {
    await h.run({ type: "participant.update", participantId: h.ids.W!, alias: "Builder" });
    await h.tick();
    assert.equal(h.fake.thread(h.thread("W")).shell.title, "seats · Builder");
    await h.fake.setThreadModel({ commandId: "in-t3", threadId: h.thread("W"), modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } });
    await h.tick();
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.modelSelection.model, "claude-sonnet-5-5");
  } finally {
    h.close();
  }
});

test("the briefing source has where everyone works, the browsers, and the engine's own wording of the standing facts", async () => {
  const h = await Seats.create();
  try {
    const browser = (await h.run({ type: "browser.create", name: "testing", description: "For tests" })) as { browserId: string };
    await h.run({ type: "room.browser", roomId: h.roomId, enabled: true, browserId: browser.browserId });
    const started = { name: "testing", description: "For tests", cdpUrl: "http://127.0.0.1:9300", cdpPort: 9300, mode: "headless" as const, watchUrl: null };
    const source = bindingSource(h.s.repos, { adapter: h.fake, browsers: { briefingFor: async () => started }, browserCommand: "/repo/bin/rooms-browser" });
    const input = await source.standing(h.roomId, h.seat("W"));
    assert.ok(Array.isArray(input.workspaces), "where everyone works was read");
    assert.equal(input.browsers?.command, "/repo/bin/rooms-browser");
    assert.equal(input.seatFacts, engineSeatFacts);
    const text = standingText(input);
    assert.ok(text.includes(engineSeatFacts({ alias: "C" })));
    assert.match(text, /== Browsers ==/);
    // A seat briefing envelope says so, so the renderer leaves the facts out of the standing part.
    const briefed = h.runs(h.seat("W"))[0]!;
    assert.equal(source.seatBriefing!(h.roomId, h.seat("W"), briefed.envelope), true);
    assert.equal(source.seatBriefing!(h.roomId, h.seat("W"), { ...briefed.envelope, inputs: [] }), false);
  } finally {
    h.close();
  }
});

test("the Consigliere's briefings and rooms-board rules carry the saved crew, a member's do not, and an edit reaches him as a change", async () => {
  const h = await Seats.create();
  try {
    const opus = (await h.run({ type: "preset.create", name: "Opus", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] }, goodAt: "careful review" })) as { presetId: string };
    const crew = "== Your crew ==\nThe user's saved crew (seat one with: rooms-board seat <name>):\nOpus · claude-opus-5-5 · effort xhigh · good at: careful review";
    // What rooms-board rules prints (src/server/http.ts): the same standing text a briefing starts with.
    assert.ok((await h.s.seats.standingText(h.ids.C!)).includes(crew));
    assert.ok(!(await h.s.seats.standingText(h.ids.W!)).includes("== Your crew =="), "a member is not given the crew");
    // The seating rule names the two lines and the effort in the sentence that names members and seat.
    assert.ok((await h.s.seats.standingText(h.ids.C!)).includes("- Work through this room's members only. Find them with `rooms-board members`; seat more with `rooms-board seat <saved crew name>`, picking from `rooms-board crew` by what each crew member is good at, what it should avoid and its effort level. Never send work to a thread that is not a member of this room.\n"));

    h.request("$user", "C", "Who should review?");
    await h.tick();
    assert.ok(h.prompt("C").includes(crew), "his first briefing has it");
    h.complete("C", "Opus.");
    await h.tick();

    await h.run({ type: "preset.update", presetId: opus.presetId, look: { hair: "short" } });
    h.request("$user", "C", "And now?");
    await h.tick();
    assert.ok(!h.prompt("C").includes("== Your crew =="), "a new look is not news");
    h.complete("C", "Still Opus.");
    await h.tick();

    await h.run({ type: "preset.update", presetId: opus.presetId, avoid: "reviews" });
    h.request("$user", "C", "And now?");
    await h.tick();
    assert.ok(h.prompt("C").includes("Changed since your last briefing:\n== Your crew ==\nThe user's saved crew (seat one with: rooms-board seat <name>):\nOpus · claude-opus-5-5 · effort xhigh · good at: careful review · avoid: reviews"), "a new avoid is news, and good at is kept");
    h.complete("C", "Someone else.");
    await h.tick();
  } finally {
    h.close();
  }
});

test("a restart in the middle of a reseat carries on from the journal and the record: one fresh seat, one transfer", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Work on A.");
    await h.tick();
    h.complete("W", "A is done.");
    await h.acknowledge();
    assert.equal(h.p.requests.get(a)!.state, "answered");
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    assert.ok(h.running("W"));
    h.restart();
    h.complete("W", "CHECKPOINT after a restart.");
    await h.tick();
    const transfers = h.p.events.filter((e) => e.data.kind === "transfer");
    assert.equal(transfers.length, 1);
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    const members = h.s.repos.listActiveParticipants(h.roomId).map((p) => p.alias).sort();
    assert.deepEqual(members, ["C", "V", "W2"]);
    h.restart();
    await h.tick(2);
    assert.equal(h.p.events.filter((e) => e.data.kind === "transfer").length, 1, "nothing is handed over twice");
    assert.equal(h.s.repos.listActiveParticipants(h.roomId).length, 3);
  } finally {
    h.close();
  }
});

test("at start, members with no seat on the journal (a database from before the engine) get their seats and the Consigliere's mark becomes the orchestrator", async () => {
  const h = await Seats.create(["C", "W"], "C");
  try {
    h.restart({ withoutJournal: true });
    assert.equal(h.p.events.some((e) => e.data.kind === "request"), false, "a fresh journal");
    assert.equal(h.p.seats.get(h.seat("C"))?.threadId, h.thread("C"));
    assert.equal(h.p.seats.get(h.seat("W"))?.threadId, h.thread("W"));
    assert.equal(h.p.orchestrator, h.seat("C"));
    const events = h.p.events.length;
    h.restart();
    assert.equal(h.p.events.length, events, "a second start adds nothing");
  } finally {
    h.close();
  }
});

test("a checkpoint that arrives with other work answers only itself: the other request goes to the fresh seat, open", async () => {
  const h = await Seats.create();
  try {
    const b = h.request("C", "W", "Look at B.");
    const { eventId: checkpoint } = (await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null })) as { eventId: string };
    await h.tick();
    const [run] = h.runs(h.seat("W")).filter((r) => r.envelope.inputs.some((i) => i.requestIds.includes(checkpoint)));
    assert.deepEqual(run!.envelope.inputs.map((i) => i.requestIds[0]), [b, checkpoint], "one turn brings both");
    h.complete("W", "CHECKPOINT: B not started.");
    await h.tick();
    assert.equal(h.p.requests.get(checkpoint)!.state, "answered");
    assert.equal(h.claims(b).length, 0, "B was not answered with the checkpoint");
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.deepEqual(transfer.data.kind === "transfer" ? transfer.data.owned : null, [b]);
    assert.equal(h.wakes("C"), 0, "B's requester is not woken: B was not answered");
  } finally {
    h.close();
  }
});

test("retire with a request the member asked still open: its answer wakes no retired thread; the Consigliere is told once", async () => {
  const h = await Seats.create();
  try {
    // Only the Consigliere asks members (H5): C asks V, then the user moves the mark to W, so C is a member whose
    // question is still open.
    const seatC = h.seat("C");
    const threadC = h.thread("C");
    const q = h.request("C", "V", "Which node version does CI use?");
    assert.equal(h.p.requests.get(q)!.parentId, null, "a question outside any turn stands alone");
    await h.tick();
    assert.ok(h.running("V"));
    await h.run({ type: "room.consigliere.set", roomId: h.roomId, participantId: h.ids.W! });
    assert.equal(h.p.orchestrator, h.seat("W"));
    await h.tick();
    assert.ok(h.running("C"), "C is told of the new Consigliere");
    h.complete("C", "Noted.");
    await h.tick();
    await h.run({ type: "participant.retire", participantId: h.ids.C!, thread: "keep" });
    const wakes = h.fake.runsOf(threadC).length;
    const wakesW = h.wakes("W");
    h.complete("V", "Node 24.");
    await h.tick();
    assert.deepEqual(h.claims(q).map((c) => [c.outcome, c.returnTo]), [["answered", seatC]]);
    const notice = h.p.events.find((e) => e.data.kind === "notice" && e.data.intent === "attention" && /Undeliverable/.test(e.data.body))!;
    assert.deepEqual(notice.data.kind === "notice" ? notice.data.recipients : null, [h.seat("W")]);
    await h.tick();
    assert.equal(h.fake.runsOf(threadC).length, wakes, "the retired thread is never woken");
    assert.equal(h.wakes("W"), wakesW + 1, "the Consigliere is told once");
  } finally {
    h.close();
  }
});

test("T3 away while the fresh seat is made, then a restart before the transfer: one fresh thread, one transfer, one takeover", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: "carry on" });
    await h.tick();
    h.complete("W", "CHECKPOINT: idle.");
    // T3 cannot make the fresh thread once: the reseat waits and asks again with the same IDs.
    const launch = h.fake.launchThread.bind(h.fake);
    let away = 1;
    h.fake.launchThread = async (input) => {
      if (away-- > 0) throw new T3Unavailable("T3 is not reachable (simulated)");
      return launch(input);
    };
    await h.tick();
    const [record] = readEngineReseats(h.s.repos, h.roomId);
    assert.equal(record!.stage, "checkpoint");
    assert.equal(h.p.seats.get(seatW)!.status, "active");
    // The fresh thread is made; the transfer fails once (as a crash would stop it); then the service restarts.
    h.host.transfer = () => {
      throw new Error("simulated crash before the transfer");
    };
    await h.tick();
    assert.equal(readEngineReseats(h.s.repos, h.roomId)[0]!.stage, "seated");
    h.restart();
    await h.tick(2);
    const fresh = record!.fresh;
    assert.equal(h.p.events.filter((e) => e.data.kind === "transfer").length, 1);
    assert.equal([...h.p.requests.keys()].filter((id) => id.startsWith("takeover:")).length, 1);
    assert.equal(h.s.repos.listParticipants(h.roomId).filter((p) => p.alias.startsWith("W")).length, 2, "W and one fresh W2");
    assert.equal(h.s.repos.currentBinding(fresh.participantId)!.threadId, fresh.threadId, "the thread chosen before T3 was asked");
    assert.equal(h.fake.threads.has(fresh.threadId), true);
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 0);
  } finally {
    h.close();
  }
});

// ---------------- review round 1 (#223) ----------------

test("F1: a retire while the member's turn is being stopped (a cancel) is refused, names the turn, and leaves the seat on the board", async () => {
  const h = await Seats.create();
  try {
    h.slowInterrupts();
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Build A.");
    await h.tick();
    await h.host.cancel(h.roomId, { actor: h.seat("C"), id: "cancel-A", requestId: a });
    // Since L6 the core records no control and no stopping state: the seat is active and still in its turn until T3 ends it.
    assert.equal(h.p.seats.get(seatW)!.status, "active");
    assert.ok(h.p.seats.get(seatW)!.activeRunId);
    const events = h.p.events.length;
    await h.refused({ type: "participant.retire", participantId: h.ids.W!, thread: "keep" }, /@W cannot be retired now: it is in a turn \(its run is (accepted|running)\)/);
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, null, "nothing written in rooms.sqlite");
    assert.equal(h.p.events.length, events, "nothing written in the journal");
    // The turn ends; the member is told of the cancel; then it can be retired, and its thread is never sent anything again.
    h.fake.completeRun(h.thread("W"), { text: "(stopped)", outcome: "interrupted" });
    await h.acknowledge();
    const threadW = h.thread("W");
    await h.run({ type: "participant.retire", participantId: h.ids.W!, thread: "keep" });
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    const wakes = h.fake.runsOf(threadW).length;
    await h.tick(2);
    assert.equal(h.fake.runsOf(threadW).length, wakes);
  } finally {
    h.close();
  }
});

test("F2: a reseat waits while its member's turn is being stopped (a cancel), then goes ahead", async () => {
  const h = await Seats.create();
  try {
    h.slowInterrupts();
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Build A.");
    await h.tick();
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.host.cancel(h.roomId, { actor: h.seat("C"), id: "cancel-A", requestId: a });
    assert.ok(h.p.seats.get(seatW)!.activeRunId, "still in the turn being stopped");
    await h.tick(2);
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 1, "still in progress");
    assert.equal(h.p.events.some((e) => e.id.startsWith("reseat-off:")), false, "not called off");
    h.fake.completeRun(h.thread("W"), { text: "(stopped)", outcome: "interrupted" });
    await h.tick();
    assert.ok(h.running("W"), "the checkpoint turn");
    h.complete("W", "CHECKPOINT: A was withdrawn; nothing in flight.");
    await h.tick();
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    assert.equal(h.p.events.filter((e) => e.data.kind === "transfer").length, 1);
  } finally {
    h.close();
  }
});

test("F3: attaching a thread this room's board had is refused before anything is written", async () => {
  const h = await Seats.create();
  try {
    const threadV = h.thread("V");
    await h.run({ type: "participant.retire", participantId: h.ids.V!, thread: "keep" });
    const members = h.s.repos.listParticipants(h.roomId).length;
    const events = h.p.events.length;
    await h.refused({ type: "participant.create", roomId: h.roomId, alias: "V9", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "attach", threadId: threadV } }, /was @V's on this room's board, and the board never seats a thread twice/);
    assert.equal(h.s.repos.listParticipants(h.roomId).length, members);
    assert.equal(h.p.events.length, events);
  } finally {
    h.close();
  }
});

test("F4: the handover names what the checkpoint turn brought besides the checkpoint, by number", async () => {
  const h = await Seats.create();
  try {
    // The reseat comes while W is in its turn on A; a correction of A lands in that turn, so its final is superseded
    // and A stays open. The checkpoint turn then brings the correction and B with the checkpoint.
    const a = h.request("C", "W", "Implement A.");
    await h.tick();
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    h.host.correct(h.roomId, { actor: h.seat("C"), id: "finding-A", requestId: a, body: "FINDING: A breaks on empty input." });
    const b = h.request("C", "W", "Meanwhile, B.");
    h.complete("W", "A is written.");
    await h.tick();
    assert.deepEqual(h.claims(a).map((c) => c.outcome), ["superseded"]);
    assert.match(h.prompt("W"), /FINDING: A breaks on empty input/, "the checkpoint turn brings the finding with the checkpoint");
    assert.match(h.prompt("W"), /Meanwhile, B\./);
    assert.match(h.prompt("W"), /Whatever else this briefing brings you is not acted on now: say in the checkpoint what it changes/);
    h.complete("W", "CHECKPOINT: A written; the empty case and B are open.");
    await h.tick(2);
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    assert.deepEqual([...transfer.data.owned].sort(), [a, b].sort());
    const seq = (id: string) => h.p.events.find((e) => e.id === id)!.seq;
    const lines = [`#${seq("finding-A")}: a correction of #${seq(a)} from @C`, `#${seq(b)}: a request from @C, handed over to you`];
    const fresh = h.s.repos.getBinding(transfer.data.newSeatId)!;
    const prompt = h.fake.promptOf(fresh.threadId, h.fake.runsOf(fresh.threadId)[0]!);
    for (const line of lines) {
      assert.ok(transfer.data.body.includes(line), `the handover names ${line}`);
      assert.ok(prompt.includes(line), `and the fresh seat reads ${line}`);
    }
  } finally {
    h.close();
  }
});

test("F5: the handover and the takeover say the final reply answers the requests handed over", async () => {
  const h = await Seats.create();
  try {
    const b = h.request("$user", "W", "Look at B.");
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    h.complete("W", "CHECKPOINT: B not started.");
    await h.tick(2);
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const fresh = h.s.repos.getBinding(transfer.data.newSeatId)!;
    const prompt = h.fake.promptOf(fresh.threadId, h.fake.runsOf(fresh.threadId)[0]!);
    const bNumber = h.p.events.find((e) => e.id === b)!.seq;
    assert.ok(prompt.includes("Your final reply answers every request handed over to you."));
    assert.ok(prompt.includes(`Your final reply answers the requests handed to you (#${bNumber}) and this one.`));
    assert.doesNotMatch(prompt, /rooms-board (working|answer|follow)\b/, "no command members no longer have (H5)");
    assert.equal(/picked it up/.test(prompt), false);
    assert.match(prompt, new RegExp(`#${bNumber}: a request from the user, handed over to you`));
  } finally {
    h.close();
  }
});

test("F6: the Consigliere's rules on the engine adjust running work with correct, and say the board carries no slash commands", async () => {
  assert.equal(/\/steer|\/compact|several names for several jobs/.test(ENGINE_DEFAULT_CONSIGLIERE_RULES), false);
  assert.match(ENGINE_DEFAULT_CONSIGLIERE_RULES, /If it only adjusts running work, correct the request you posted: `rooms-board correct <number> "the adjustment"`/);
  // The user's own wording may still name them: the mechanics, appended whatever the wording, say how it is on the board.
  const custom = engineConsigliereRules("- If it only adjusts running work, post `@name /steer <the adjustment>`.");
  assert.match(custom, /The board carries no slash commands to members \(`\/compact` and the like are the user's\), whatever the wording above says\./);
  // M1: the mechanics say a post or correction goes into a working member's running turn, whatever a saved copy says.
  assert.match(custom, /A post, correction or retry to a member who is working goes into its running turn, as a message typed into its harness does, and that turn's reply answers it; a turn the room did not start \(one typed in T3, or the member's own\) takes nothing/);
  assert.doesNotMatch(ENGINE_DEFAULT_CONSIGLIERE_RULES, /next turn/, "no default rule says a correction waits for the next turn");
  const h = await Seats.create();
  try {
    h.s.repos.setKv(CONSIGLIERE_RULES_KEY, "- Be brief.");
    h.request("$user", "C", "Plan it.");
    await h.tick();
    const prompt = h.prompt("C");
    assert.match(prompt, /- Be brief\./);
    for (const rule of ENGINE_BOARD_RULES) assert.ok(prompt.includes(rule), `missing: ${rule.slice(0, 60)}`);
  } finally {
    h.close();
  }
});

test("R3 review speed: the engine's briefing for the Consigliere carries the seven review-speed rules and the two reworded ones, word for word", async () => {
  const freshSeat = "A fresh seat for every review: each gate that needs a reviewer gets a newly seated one, who also checks the fixes it asked for and is retired when the gate is passed. The member who did the work never reviews it.";
  const route = "You route reviews: members never post to each other. When the work is ready, send the reviewer the worker's result by post number; send the reviewer's findings back to the worker the same way, until the reviewer passes it.";
  const speed = [
    "Seat the reviewer when you seat the writer: it sends you what it will check while the writer builds, and you pass that to the writer.",
    "Before a writer reports its work ready, it reviews its own diff and fixes what that finds.",
    "Anything that changes or describes behaviour gets a fresh reviewer; wording that changes and describes no behaviour gets your own read and the automated gate.",
    "After two review rounds, rule on the open technical points yourself and bring the user only product questions.",
    "Keep one revision in review at a time: the writer sends the next only after the reviewer's verdict on the last.",
    "Every reviewer finding becomes a test in the deliverable before its gate passes.",
  ];
  const reseatSelf = "Reseat yourself the same way when your own context nears compaction, at a quiet moment, after writing the room state.";
  const lines = [freshSeat, route, ...speed, reseatSelf];

  // Each is a whole line of the default rules, once.
  for (const line of lines) assert.equal(ENGINE_DEFAULT_CONSIGLIERE_RULES.split("\n").filter((l) => l === `- ${line}`).length, 1, `once: ${line.slice(0, 50)}`);
  // The six sit with the review rules, in this order, after the one that routes reviews; the seventh follows the rule it says "the same way" of.
  assert.ok(ENGINE_DEFAULT_CONSIGLIERE_RULES.includes([freshSeat, route, ...speed].map((l) => `- ${l}`).join("\n") + "\n- Scope is yours:"));
  assert.match(ENGINE_DEFAULT_CONSIGLIERE_RULES, new RegExp(`\\n- Reseat long work before the harness compacts it[^\\n]*\\n- ${reseatSelf}\\n- Keep the room state current`));
  // The old wording of the two reworded rules is gone.
  assert.doesNotMatch(ENGINE_DEFAULT_CONSIGLIERE_RULES, /each gate gets a newly seated reviewer|When the work is ready, seat the reviewer/);
  // How a writer reviews its own diff is its own business (the user's #66): no subagent, no workflow named.
  assert.doesNotMatch(ENGINE_DEFAULT_CONSIGLIERE_RULES, /reviews its own diff with|subagent or a review workflow/);

  // The briefing the engine sends a Consigliere carries all nine.
  const h = await Seats.create();
  try {
    h.request("$user", "C", "Plan it.");
    await h.tick();
    const prompt = h.prompt("C");
    for (const line of lines) assert.ok(prompt.includes(`- ${line}\n`), `missing: ${line.slice(0, 50)}`);
  } finally {
    h.close();
  }
  // What the user saved replaces them, as it replaces every default rule.
  const custom = engineConsigliereRules("- Be brief.");
  for (const line of lines) assert.equal(custom.includes(line), false);
});

test("F7: members are told their reply is their answer, and that they post nothing (H5)", () => {
  const facts = engineSeatFacts({ alias: "C" });
  assert.match(facts, /Your final reply at the end of a turn is your answer\./);
  assert.match(facts, /You do not post to other members/);
  assert.doesNotMatch(facts, /rooms-board (post|working|answer|follow)\b|--for/);
});

test("M1: retire is refused while an answer to what the member asked has not reached it", async () => {
  const h = await Seats.create();
  try {
    // Only the Consigliere asks members (H5). A turn typed in T3 on his thread keeps the host from waking him at once.
    const seatC = h.seat("C");
    const q = h.request("C", "V", "Which node version?");
    await h.tick();
    assert.ok(h.running("V"));
    h.fake.startExternalRun(h.thread("C"), "typed in T3");
    h.complete("V", "Node 24.");
    await h.tick();
    const answer = h.p.events.find((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === q && c.outcome === "answered"))!;
    assert.equal(h.host.unread(h.roomId, seatC), 1);
    // That turn ends: his thread is idle and listed, and the next tick would wake him with the answer.
    h.fake.completeRun(h.thread("C"), { text: "answered in T3" });
    await h.refused({ type: "participant.retire", participantId: h.ids.C!, thread: "keep" }, new RegExp(`the answer #${answer.seq} to what it asked has not reached it yet`));
  } finally {
    h.close();
  }
});

test("M2: a turn T3 starts on the old thread while the fresh member is made ends, and is imported, before the transfer", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const threadW = h.thread("W");
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    h.complete("W", "CHECKPOINT: idle.");
    const launch = h.fake.launchThread.bind(h.fake);
    h.fake.launchThread = async (input) => {
      h.fake.startExternalRun(threadW, "one more thing, typed in T3");
      return launch(input);
    };
    await h.tick();
    assert.equal(readEngineReseats(h.s.repos, h.roomId)[0]!.stage, "seated");
    assert.equal(h.p.seats.get(seatW)!.status, "active", "the transfer waits for that turn");
    h.fake.launchThread = launch;
    h.fake.completeRun(threadW, { text: "Done, in T3." });
    await h.tick();
    // That turn answers nothing: it is a follow-up on the request W's latest answer closed, the checkpoint (H5).
    const reply = h.p.events.find((e) => e.data.kind === "progress" && e.data.author === seatW && e.data.milestone === "follow-up" && e.data.body === "[T3 status of @W: idle]\n\nDone, in T3.")!;
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(reply && transfer && reply.seq < transfer.seq, "the turn is on the board before the handover");
  } finally {
    h.close();
  }
});

test("at start the Consigliere's mark follows the journal once the journal has named one, and the journal is not written", async () => {
  const h = await Seats.create();
  try {
    // As a crash after the journal's designate and before rooms.sqlite would leave it.
    h.host.designate(h.roomId, { id: "designate:w-only-in-journal", seatId: h.seat("W") });
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, h.ids.C);
    const events = h.p.events.length;
    h.restart();
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, h.ids.W, "rooms.sqlite follows the journal");
    assert.equal(h.p.orchestrator, h.seat("W"));
    assert.equal(h.p.events.length, events, "nothing appended on start");
  } finally {
    h.close();
  }
});

test("rooms-board through the route: rules prints the engine's standing facts; seat, reseat and retire act on the journal", async () => {
  const h = await Seats.create();
  try {
    const app = createHttpApp(h.s, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: h.dir, ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "secret", command: "rooms-browser" });
    const cli = async (alias: string, ...argv: string[]): Promise<{ status: number; text: string }> => {
      const response = await app.request("/api/board-tools", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ argv, as: agentKey(alias, h.roomId) }) });
      const body = (await response.json()) as { text?: string; message?: string };
      return { status: response.status, text: body.text ?? body.message ?? "" };
    };
    const rules = await cli("W", "rules");
    assert.equal(rules.status, 200);
    assert.ok(rules.text.includes(engineSeatFacts({ alias: "C" })), "the engine's member facts, not the old runtime's");
    assert.match((await cli("C", "rules")).text, /How the board works \(Backroom's mechanics/);

    await h.run({ type: "preset.create", name: "Sonnet", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" }, runtimeMode: "full-access", workspaceMode: "local" });
    const seated = await cli("C", "seat", "Sonnet");
    assert.equal(seated.status, 200, seated.text);
    const sonnet = h.s.repos.listActiveParticipants(h.roomId).find((p) => p.alias === "Sonnet")!;
    h.ids.Sonnet = sonnet.id;
    assert.equal(h.p.seats.get(h.seat("Sonnet"))?.status, "active");
    await h.acknowledge();

    const reseat = await cli("C", "reseat", "W", "carry on");
    assert.equal(reseat.status, 200, reseat.text);
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 1);

    const seatV = h.seat("V");
    const retired = await cli("C", "retire", "V");
    assert.equal(retired.status, 200, retired.text);
    assert.equal(h.p.seats.get(seatV)!.status, "retired");
    const event = h.p.events.find((e) => e.data.kind === "seat.retired")!;
    assert.equal(event.data.kind === "seat.retired" ? event.data.author : null, "$user", "the room command path retires as the user");
  } finally {
    h.close();
  }
});

for (const action of ["archive", "delete"] as const) test(`R2-F1: a member whose thread T3 has ${action}d can be retired with an answer that can never reach it`, async () => {
  const h = await Seats.create();
  try {
    // Only the Consigliere asks members (H5): his is the answer that waits.
    const seatC = h.seat("C");
    const threadC = h.thread("C");
    h.request("C", "V", "Which node version?");
    await h.tick();
    await h.fake.setThreadLifecycle({ commandId: `${action}-c`, threadId: threadC, action });
    h.complete("V", "Node 24.");
    await h.tick(3);
    assert.equal(h.host.unread(h.roomId, seatC), 1, "the answer waits for C, whom nothing can wake");
    await h.run({ type: "participant.retire", participantId: h.ids.C!, thread: "keep" });
    assert.equal(h.p.seats.get(seatC)!.status, "retired");
  } finally {
    h.close();
  }
});

test("R3: a thread T3 deleted but still returns (deletedAt set, as the real adapter reports it) does not hold a retire either", async () => {
  const h = await Seats.create();
  try {
    // The real adapter's getThreadShell finds a deleted thread in the snapshot with deletedAt set; listThreads leaves it out.
    const list = h.fake.listThreads.bind(h.fake);
    h.fake.listThreads = async (projectId?: string) => (await list(projectId)).filter((t) => t.deletedAt === null);
    const seatC = h.seat("C");
    h.request("C", "V", "Which node version?");
    await h.tick();
    h.fake.thread(h.thread("C")).shell.deletedAt = new Date().toISOString();
    h.complete("V", "Node 24.");
    await h.tick(3);
    assert.equal(h.host.unread(h.roomId, seatC), 1, "the answer waits for C, whom nothing can wake");
    await h.run({ type: "participant.retire", participantId: h.ids.C!, thread: "keep" });
    assert.equal(h.p.seats.get(seatC)!.status, "retired");
  } finally {
    h.close();
  }
});
