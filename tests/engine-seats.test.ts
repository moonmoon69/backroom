/**
 * L4b: the seat lifecycle on the engine (src/app/engineSeats.ts), through the room commands the page and the CLI send,
 * on a full stack with ROOMS_ENGINE on and the fake T3. Every T3 run on a member's thread is one wake of it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { CONSIGLIERE_RULES_KEY, ENGINE_BOARD_RULES, ENGINE_DEFAULT_CONSIGLIERE_RULES, engineConsigliereRules, engineSeatFacts, seatFacts } from "../src/app/consigliere.ts";
import { readEngineReseats } from "../src/app/reseat.ts";
import { standingText } from "../src/briefing/assemble.ts";
import { RoomError } from "../src/domain/errors.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { decide, inputTree } from "../src/engine/index.ts";
import type { ClaimOutcome, Projection, Run } from "../src/engine/index.ts";
import { HostRefusal, bindingSource } from "../src/runtime/index.ts";
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

  private constructor(engine = true) {
    this.s = this.stack(engine);
  }

  private stack(engine: boolean): AppStack {
    return createStack({ dbPath: join(this.dir, "rooms.sqlite"), adapter: this.fake, briefingBudgetChars: 60000, latestRelease: async () => null, engine });
  }

  /** Throw the service away and start a new one over the same files and the same T3, as a restart does. */
  restart(engine = true): void {
    this.s.close();
    this.s = this.stack(engine);
  }

  /** A room with these members; the first is made the Consigliere unless `consigliere` is null. Seat briefings answered. */
  static async create(aliases = ["C", "W", "V"], consigliere: string | null = "C", engine = true): Promise<Seats> {
    const h = new Seats(engine);
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
    for (let i = 0; i < times; i += 1) await this.s.scheduler.tick();
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

  /** A request on the board: from the user or a member's seat. */
  request(from: string, to: string, body: string, parentId?: string): string {
    const id = `req:${++this.serial}`;
    this.host.request(this.roomId, { actor: from === "$user" ? "$user" : this.seat(from), id, to: this.seat(to), body, ...(parentId ? { parentId } : {}) });
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
    // The Consigliere's mark is the journal's orchestrator; the members were briefed by the user, and he slept through it.
    assert.equal(h.p.orchestrator, h.seat("C"));
    for (const alias of ["C", "W", "V"]) assert.equal(h.p.seats.get(h.seat(alias))?.threadId, h.thread(alias));
    assert.equal(h.wakes("C"), 0);
    assert.equal(h.wakes("W"), 1);
    const briefing = h.prompt("W");
    assert.match(briefing, /You are seated in a room whose Consigliere is @C/);
    assert.match(briefing, /rooms-board working "what is still going"/);
    assert.equal(briefing.includes("Standing facts of this room"), false, "the seat facts are the assignment here, not repeated in the standing part");

    const x = await h.add("X");
    const seatX = h.seat("X");
    assert.equal(h.p.seats.get(seatX)?.status, "active");
    const request = h.p.requests.get(`seat-briefing:${seatX}:seated`)!;
    assert.deepEqual([request.owner, request.returnTo], [seatX, "$user"]);
    await h.acknowledge();
    assert.equal(h.p.requests.get(request.id)!.state, "answered");
    assert.equal(h.wakes("C"), 0, "nobody is woken by a seat briefing's acknowledgement");
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
    await h.tick();
    assert.ok(h.running("W"));
    await h.refused({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "archive" }, /@W cannot be retired now: it is in a turn/);
    // A turn the room did not start holds it too: T3 says the thread is busy.
    h.fake.startExternalRun(h.thread("V"), "typed in T3");
    await h.refused({ type: "participant.retire", participantId: h.ids.V!, pendingTasks: "cancel", thread: "keep" }, /@V cannot be retired now: its T3 thread is in a turn/);
    h.fake.completeRun(h.thread("V"), { text: "answered in T3" });

    h.host.working(h.roomId, { actor: h.seat("W"), id: "w-working", body: "the build runs in CI" });
    h.complete("W", "Started; CI is running.");
    await h.tick();
    assert.equal(h.p.requests.get(a)!.state, "open");
    const error = await h.refused({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "archive" }, /owns open request #\d+: answer or cancel it first/);
    assert.match(error.message, /it said it is still working on #\d+ \(activity work:/);
    assert.equal(h.p.seats.get(h.seat("W"))!.status, "active", "a refused retire changes nothing");
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, null);

    // Only the Consigliere retires members from the board.
    await assert.rejects(h.s.seats!.retire({ participantId: h.ids.W!, by: h.ids.V!, thread: "keep" }), /Only this room's Consigliere \(@C\) retires members/);

    h.host.answer(h.roomId, { actor: h.seat("W"), id: "w-answer", body: "CI passed; done.", requestIds: [a] });
    await h.tick();
    assert.equal(h.claims(a).filter((c) => c.outcome === "answered").length, 1);
    if (h.running("C")) h.complete("C", "Noted.");
    await h.tick();

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
    const kept = (await h.run({ type: "participant.retire", participantId: h.ids.V!, pendingTasks: "cancel", thread: "keep" })) as { thread?: { result: string } };
    assert.equal(kept.thread?.result, "kept");
    assert.equal(h.fake.thread(threadV).shell.archivedAt ?? null, null);
  } finally {
    h.close();
  }
});

test("retiring the Consigliere clears the mark and the orchestrator", async () => {
  const h = await Seats.create();
  try {
    await h.run({ type: "participant.retire", participantId: h.ids.C!, pendingTasks: "cancel", thread: "keep" });
    assert.equal(h.p.orchestrator, null);
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, null);
    await h.refused({ type: "participant.rebind", participantId: h.ids.W!, thread: { mode: "create" }, outstandingTasks: "carry" }, /reseat it/);
  } finally {
    h.close();
  }
});

test("reseat carries every unread input and every owned request exactly once, and the transfer gets no answer from the old seat", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const threadW = h.thread("W");
    // C asks W for A; W asks V to review under A and ends its turn: A waits for the review.
    const a = h.request("C", "W", "Implement A.");
    await h.tick();
    const review = `review:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: review, to: h.seat("V"), body: "Please review A." });
    await h.tick();
    assert.ok(h.running("V"));
    h.complete("W", "A is written; waiting for the review.");
    await h.tick();
    assert.equal(h.p.requests.get(a)!.state, "open");

    const reseat = (await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: "finish A" })) as { eventId: string };
    const checkpoint = reseat.eventId;
    assert.match(checkpoint, /^reseat:/);
    assert.deepEqual([h.p.requests.get(checkpoint)!.owner, h.p.requests.get(checkpoint)!.returnTo], [seatW, "$user"]);
    await h.refused({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null }, /being reseated already/);
    await h.tick();
    assert.ok(h.running("W"), "the checkpoint turn");
    assert.match(h.prompt("W"), /Reseat, asked by @C: a fresh seat of the same crew member takes over your work/);

    // While W writes its checkpoint: V's review answers, C corrects A, the user asks W for D. W reads none of it.
    h.complete("V", "PASS on A.");
    await h.tick();
    h.host.correct(h.roomId, { actor: h.seat("C"), id: "fix-A", requestId: a, body: "Also handle the empty case." });
    const d = h.request("$user", "W", "And D, please.");
    const unreadAtCut = ["fix-A", d, ...h.p.events.filter((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === review)).map((e) => e.id)];
    assert.equal(unreadAtCut.length, 3);

    h.complete("W", "CHECKPOINT: A written in src/a.ts, review asked; next: address the review.");
    await h.tick();
    // The checkpoint answered only itself; A and D stay open and moved to the fresh seat with everything W had not read.
    assert.equal(h.p.requests.get(checkpoint)!.state, "answered");
    const checkpointOutput = h.p.events.find((e) => e.id === h.p.requests.get(checkpoint)!.answerId)!;
    assert.deepEqual(checkpointOutput.data.kind === "output" ? checkpointOutput.data.claims.map((c) => [c.requestId, c.outcome]) : null, [[checkpoint, "answered"]], "the checkpoint is not A's answer");
    assert.equal(h.claims(a).filter((c) => c.outcome === "answered").length, 0);
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const freshId = transfer.data.newSeatId;
    assert.equal(transfer.data.oldSeatId, seatW);
    assert.deepEqual([...transfer.data.owned].sort(), [a, d].sort());
    assert.deepEqual(transfer.data.awaited, []);
    assert.deepEqual(inputTree(transfer.data.inherited).map((i) => i.eventId).sort(), [...unreadAtCut].sort());
    assert.match(transfer.data.body, /CHECKPOINT: A written in src\/a.ts/);
    for (const id of [a, d]) assert.equal(h.p.requests.get(id)!.owner, freshId);
    const fresh = h.s.repos.getBinding(freshId)!;
    const freshAlias = h.s.repos.getParticipant(fresh.participantId)!.alias;
    h.ids[freshAlias] = fresh.participantId;
    assert.equal(freshAlias, "W2");
    assert.ok(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, "the old member left the room");
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 0);
    assert.equal(h.wakes("C"), 0, "the Consigliere slept through the checkpoint");

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

    // The old seat cannot answer what moved: not through the board, not from a late turn in its old thread, and not
    // even by an output the core is handed for its last run.
    assert.throws(() => h.host.answer(h.roomId, { actor: seatW, id: "old-answer", body: "done", requestIds: [a] }), HostRefusal);
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

    // The fresh seat answers A, D and the takeover with its final: each requester is woken once.
    h.complete("W2", "A done with the empty case and the review addressed; D done.");
    await h.tick();
    for (const id of [a, d]) assert.deepEqual(h.claims(id).filter((c) => c.outcome === "answered").map((c) => c.returnTo), [id === a ? h.seat("C") : "$user"]);
    assert.equal(h.wakes("C"), 1, "the Consigliere is woken once, with the answer");
    const takeover = [...h.p.requests.values()].find((q) => q.id.startsWith("takeover:"))!;
    assert.equal(takeover.state, "answered");
  } finally {
    h.close();
  }
});

test("reseat refuses with a pending work activity, naming it, and goes ahead once the request is cancelled", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Long job.");
    await h.tick();
    h.host.working(h.roomId, { actor: h.seat("W"), id: "w-working", body: "running the long job" });
    h.complete("W", "Started.");
    await h.tick();
    const error = await h.refused({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null }, /@W cannot be reseated now: it said it is still working on #\d+ \(activity work:/);
    assert.match(error.message, /cancel the request/);
    assert.equal(readEngineReseats(h.s.repos, h.roomId).length, 0);

    await h.host.cancel(h.roomId, { actor: h.seat("C"), id: "cancel-A", requestId: a });
    assert.equal(h.p.requests.get(a)!.state, "cancelled");
    assert.deepEqual([...h.p.activities.values()].map((x) => x.status), ["failed"]);
    await h.acknowledge(); // W is told of the cancel

    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    h.complete("W", "CHECKPOINT: nothing in flight.");
    await h.tick();
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
    assert.ok(h.s.repos.getParticipant(h.ids.W!)!.retiredAt);
    assert.ok(h.p.events.some((e) => e.data.kind === "transfer"));
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
    assert.equal(h.wakes("C"), 0);
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
    h.complete("C", "I asked @W for A.");
    await h.tick();
    assert.equal(h.p.requests.get(u)!.state, "open");

    await h.run({ type: "participant.reseat", participantId: h.ids.C!, by: h.ids.C!, plan: null });
    await h.tick();
    assert.match(h.prompt("C"), /takes over as this room's Consigliere/);
    h.complete("C", "CHECKPOINT: waiting for @W on A for the user's request.");
    await h.tick();
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const freshSeat = transfer.data.newSeatId;
    assert.deepEqual([transfer.data.owned, transfer.data.awaited], [[u], [a]]);
    assert.equal(h.p.orchestrator, freshSeat);
    const fresh = h.s.repos.getBinding(freshSeat)!.participantId;
    assert.equal(h.s.repos.getRoom(h.roomId)!.consigliereId, fresh);
    assert.equal([...h.p.requests.values()].some((q) => q.id.startsWith("takeover:")), false, "he reseated himself: nobody to report to");
    const moved = [...h.p.requests.values()].filter((q) => q.id.startsWith("moved:"));
    assert.deepEqual(moved.map((q) => q.owner).sort(), [h.seat("W"), h.seat("V")].sort(), "every other member is told");
    assert.ok(moved.every((q) => q.returnTo === "$user"));

    // W answers A: the answer goes to the fresh Consigliere, whose final answers the user's request.
    h.complete("W", "A is built.");
    await h.tick();
    const freshThread = h.s.repos.getBinding(freshSeat)!.threadId;
    assert.ok(h.fake.liveRun(freshThread));
    h.fake.completeRun(freshThread, { text: "A is built; done." });
    await h.tick();
    assert.equal(h.p.requests.get(u)!.state, "answered");
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
    assert.equal(text.includes(seatFacts({ alias: "C" })), false, "not the old runtime's wording");
    assert.match(text, /== Browsers ==/);
    // A seat briefing envelope says so, so the renderer leaves the facts out of the standing part.
    const briefed = h.runs(h.seat("W"))[0]!;
    assert.equal(source.seatBriefing!(h.roomId, h.seat("W"), briefed.envelope), true);
    assert.equal(source.seatBriefing!(h.roomId, h.seat("W"), { ...briefed.envelope, inputs: [] }), false);
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
    h.host.working(h.roomId, { actor: seatW, id: "w-working", body: "A runs long" });
    h.host.answer(h.roomId, { actor: seatW, id: "w-answer", body: "A is done.", requestIds: [a] });
    h.complete("W", "A is done.");
    await h.acknowledge();
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

test("at start, members seated without the engine get their seats and the Consigliere's mark becomes the orchestrator", async () => {
  const h = await Seats.create(["C", "W"], "C", false);
  try {
    assert.equal(h.s.engine, null);
    h.restart(true);
    assert.equal(h.p.seats.get(h.seat("C"))?.threadId, h.thread("C"));
    assert.equal(h.p.seats.get(h.seat("W"))?.threadId, h.thread("W"));
    assert.equal(h.p.orchestrator, h.seat("C"));
    const events = h.p.events.length;
    h.restart(true);
    assert.equal(h.p.events.length, events, "a second start adds nothing");
  } finally {
    h.close();
  }
});

test("a checkpoint that arrives with other work answers only itself: the other request goes to the fresh seat, open", async () => {
  const h = await Seats.create();
  try {
    const b = h.request("V", "W", "Look at B.");
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
    assert.equal(h.wakes("V"), 1, "V's only wake is its seat briefing");
  } finally {
    h.close();
  }
});

test("retire with a request the member asked still open: its answer wakes no retired thread; the Consigliere is told once", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const threadW = h.thread("W");
    const q = `question:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: q, to: h.seat("V"), body: "Which node version does CI use?" });
    assert.equal(h.p.requests.get(q)!.parentId, null, "a question outside any turn stands alone");
    await h.tick();
    assert.ok(h.running("V"));
    await h.run({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" });
    const wakes = h.fake.runsOf(threadW).length;
    h.complete("V", "Node 24.");
    await h.tick();
    assert.deepEqual(h.claims(q).map((c) => [c.outcome, c.returnTo]), [["answered", seatW]]);
    const notice = h.p.events.find((e) => e.data.kind === "notice" && e.data.intent === "attention" && /Undeliverable/.test(e.data.body))!;
    assert.deepEqual(notice.data.kind === "notice" ? notice.data.recipients : null, [h.seat("C")]);
    await h.tick();
    assert.equal(h.fake.runsOf(threadW).length, wakes, "the retired thread is never woken");
    assert.equal(h.wakes("C"), 1, "the Consigliere is told once");
  } finally {
    h.close();
  }
});

test("a review still open at the transfer: its answer reaches the fresh seat, whose final answers the parent once", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Implement A.");
    await h.tick();
    const review = `review:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: review, to: h.seat("V"), body: "Please review A." });
    h.complete("W", "A written; review asked.");
    await h.tick();
    assert.ok(h.running("V"));
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    h.complete("W", "CHECKPOINT: waiting for the review of A.");
    await h.tick();
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    assert.deepEqual([transfer.data.owned, transfer.data.awaited], [[a], [review]]);
    const fresh = transfer.data.newSeatId;
    assert.equal(h.p.requests.get(review)!.returnTo, fresh);
    h.complete("V", "PASS.");
    await h.tick();
    const freshThread = h.s.repos.getBinding(fresh)!.threadId;
    const [first] = h.runs(fresh);
    assert.deepEqual(first!.envelope.inputs.map((i) => i.intent), ["transfer", "request", "result"]);
    h.fake.completeRun(freshThread, { text: "A is reviewed and done." });
    await h.tick();
    assert.deepEqual(h.claims(a).filter((c) => c.outcome === "answered").map((c) => c.returnTo), [h.seat("C")]);
    assert.equal(h.wakes("C"), 1, "woken once, by the one final that answers A and the takeover");
    assert.equal(h.fake.runsOf(h.thread("V")).length, 2, "V: its seat briefing and the review, nothing more");
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
    await h.refused({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" }, /@W cannot be retired now: it is in a turn \(its run is (accepted|running)\)/);
    assert.equal(h.s.repos.getParticipant(h.ids.W!)!.retiredAt, null, "nothing written in rooms.sqlite");
    assert.equal(h.p.events.length, events, "nothing written in the journal");
    // The turn ends; the member is told of the cancel; then it can be retired, and its thread is never sent anything again.
    h.fake.completeRun(h.thread("W"), { text: "(stopped)", outcome: "interrupted" });
    await h.acknowledge();
    const threadW = h.thread("W");
    await h.run({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" });
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
    await h.run({ type: "participant.retire", participantId: h.ids.V!, pendingTasks: "cancel", thread: "keep" });
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
    const seatW = h.seat("W");
    const a = h.request("C", "W", "Implement A.");
    await h.tick();
    const review = `review:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: review, to: h.seat("V"), body: "Please review A." });
    h.complete("W", "A is written; waiting for the review.");
    await h.tick();
    const b = h.request("C", "W", "Meanwhile, B.");
    await h.tick();
    h.complete("V", "FINDING: A breaks on empty input.");
    await h.tick();
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    h.complete("W", "B is done.");
    await h.tick();
    assert.match(h.prompt("W"), /FINDING: A breaks on empty input/, "the checkpoint turn brings the finding with the checkpoint");
    assert.match(h.prompt("W"), /Whatever else this briefing brings you is not acted on now: say in the checkpoint what it changes/);
    assert.ok(h.claims(b).some((c) => c.outcome === "answered"));
    h.complete("W", "CHECKPOINT: A written; review asked.");
    await h.tick(2);
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    assert.deepEqual(transfer.data.owned, [a]);
    const answer = h.p.events.find((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === review && c.outcome === "answered"))!;
    const reviewNumber = h.p.events.find((e) => e.id === review)!.seq;
    const line = `#${answer.seq}: @V's answer to #${reviewNumber}`;
    assert.ok(transfer.data.body.includes(line), `the handover names ${line}`);
    const fresh = h.s.repos.getBinding(transfer.data.newSeatId)!;
    assert.ok(h.fake.promptOf(fresh.threadId, h.fake.runsOf(fresh.threadId)[0]!).includes(line), "and the fresh seat reads it");
  } finally {
    h.close();
  }
});

test("F5: the handover and the takeover say the final reply answers the requests handed over", async () => {
  const h = await Seats.create();
  try {
    const b = h.request("V", "W", "Look at B.");
    await h.run({ type: "participant.reseat", participantId: h.ids.W!, by: h.ids.C!, plan: null });
    await h.tick();
    h.complete("W", "CHECKPOINT: B not started.");
    await h.tick(2);
    const transfer = h.p.events.find((e) => e.data.kind === "transfer")!;
    assert.ok(transfer.data.kind === "transfer");
    const fresh = h.s.repos.getBinding(transfer.data.newSeatId)!;
    const prompt = h.fake.promptOf(fresh.threadId, h.fake.runsOf(fresh.threadId)[0]!);
    const bNumber = h.p.events.find((e) => e.id === b)!.seq;
    assert.match(prompt, /Your final reply answers every request handed over to you, so reply when the work is done; if it goes on past your turn, run `rooms-board working "…"` before you end it\./);
    assert.ok(prompt.includes(`Your final reply answers the requests handed to you (#${bNumber}) and this one, so reply when the work is done`));
    assert.equal(/picked it up/.test(prompt), false);
    assert.match(prompt, new RegExp(`#${bNumber}: a request from @V, handed over to you`));
  } finally {
    h.close();
  }
});

test("F6: the Consigliere's rules on the engine adjust running work with correct, and say the board carries no slash commands", async () => {
  assert.equal(/\/steer|\/compact|several names for several jobs/.test(ENGINE_DEFAULT_CONSIGLIERE_RULES), false);
  assert.match(ENGINE_DEFAULT_CONSIGLIERE_RULES, /If it only adjusts running work, correct the request you posted: `rooms-board correct <number> "the adjustment"`/);
  // The user's own wording may still name them: the mechanics, appended whatever the wording, say how it is on the board.
  const custom = engineConsigliereRules("- If it only adjusts running work, post `@name /steer <the adjustment>`.");
  assert.match(custom, /The board carries no slash commands to members \(`\/steer`, `\/compact` and the like are the user's\), whatever the wording above says\./);
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

test("F7: members are told their reply is their answer, not to post it again to whoever asked", () => {
  assert.match(engineSeatFacts({ alias: "C" }), /Your reply is your answer: do not also post it to whoever asked\. A post to them during your turn is a question, and it holds your request open until they answer it\./);
});

test("M1: retire is refused while an answer to the member's own question has not reached it", async () => {
  const h = await Seats.create();
  try {
    const seatW = h.seat("W");
    const q = `question:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: q, to: h.seat("V"), body: "Which node version?" });
    await h.tick();
    // V answers during its turn; W's thread is idle and listed, and the next tick would wake W with the answer.
    h.host.answer(h.roomId, { actor: h.seat("V"), id: "v-answer", body: "Node 24.", requestIds: [q] });
    const answer = h.p.events.find((e) => e.data.kind === "output" && e.data.claims.some((c) => c.requestId === q))!;
    assert.equal(h.host.unread(h.roomId, seatW), 1);
    await h.refused({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" }, new RegExp(`the answer #${answer.seq} to what it asked has not reached it yet`));
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
    const reply = h.p.events.find((e) => e.data.kind === "note" && e.data.author === seatW && e.data.body === "Done, in T3.")!;
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
    const seatW = h.seat("W");
    const threadW = h.thread("W");
    const q = `question:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: q, to: h.seat("V"), body: "Which node version?" });
    await h.tick();
    await h.fake.setThreadLifecycle({ commandId: `${action}-w`, threadId: threadW, action });
    h.complete("V", "Node 24.");
    await h.tick(3);
    assert.equal(h.host.unread(h.roomId, seatW), 1, "the answer waits for W, whom nothing can wake");
    await h.run({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" });
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
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
    const seatW = h.seat("W");
    const q = `question:${seatW}`;
    h.host.post(h.roomId, { actor: seatW, id: q, to: h.seat("V"), body: "Which node version?" });
    await h.tick();
    h.fake.thread(h.thread("W")).shell.deletedAt = new Date().toISOString();
    h.complete("V", "Node 24.");
    await h.tick(3);
    assert.equal(h.host.unread(h.roomId, seatW), 1, "the answer waits for W, whom nothing can wake");
    await h.run({ type: "participant.retire", participantId: h.ids.W!, pendingTasks: "cancel", thread: "keep" });
    assert.equal(h.p.seats.get(seatW)!.status, "retired");
  } finally {
    h.close();
  }
});
