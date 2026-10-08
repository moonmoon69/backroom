/**
 * The user's message path on the engine (plan item L4a): src/app/engineMessages.ts, the parser's engine mode (D2) and
 * the host's /steer. Each test is named after the README "Writing messages" behaviour it keeps (section: behaviour),
 * or after D2's rejections and the user's controls. What that section says about the composer itself (opening it,
 * keys, drafts, chips, the plan rows and their one-click fixes) is the web UI's, item L5; /add and /remove are L4b's.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { SendMessageInput, T3Run } from "../src/adapter/types.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { messageIdOf } from "../src/app/engineMessages.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { RoomEvent } from "../src/engine/index.ts";
import { AFTER_GONE, HOLD_GONE, parseExplicit, type Draft } from "../src/parser/explicit.ts";

/** The fake T3, plus a hook on a steered message just before T3 takes it, and steer sends lost to an outage. */
class Fake extends FakeT3Adapter {
  beforeSteer: (() => void) | null = null;
  unavailableSteers = 0;
  constructor() {
    super({ autoCompleteMs: null });
  }
  override async sendMessage(input: SendMessageInput): Promise<void> {
    if (input.mode.type === "steer") {
      if (this.unavailableSteers > 0) {
        this.unavailableSteers -= 1;
        throw new T3Unavailable("T3 is not reachable (simulated)");
      }
      const hook = this.beforeSteer;
      this.beforeSteer = null;
      hook?.();
    }
    return super.sendMessage(input);
  }
}

interface Room {
  stack: AppStack;
  fake: Fake;
  roomId: string;
  ids: Record<string, string>;
  dir: string;
  run(command: RoomCommandInput): Promise<unknown>;
  /** What the composer does: parse in engine mode, then message.create with the draft's assignments. */
  say(text: string, attachmentIds?: string[]): Promise<{ messageId: string; requestIds: string[]; noteIds: string[] }>;
  draft(text: string): Draft;
  tick(times?: number): Promise<void>;
  seat(alias: string): string;
  thread(alias: string): string;
  runs(alias: string): T3Run[];
  prompt(alias: string, index: number): string;
  complete(alias: string, text: string, outcome?: "completed" | "error"): void;
  events(): readonly RoomEvent[];
  close(): void;
}

async function engineRoom(aliases = ["sol", "grok"], options: { consigliere?: string; fake?: Fake; dir?: string; fresh?: boolean } = {}): Promise<Room> {
  const fake = options.fake ?? new Fake();
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "backroom-l4a-"));
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, engine: true });
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const ids: Record<string, string> = {};
  let roomId: string;
  if (options.fresh === false) {
    roomId = stack.repos.listRooms()[0]!.id;
    for (const p of stack.repos.listParticipants(roomId)) ids[p.alias] = p.id;
  } else {
    roomId = ((await run({ type: "room.create", projectId: "project_demo", title: "engine" })) as { roomId: string }).roomId;
    for (const alias of aliases) {
      ids[alias] = ((await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string }).participantId;
      // Seats are L4b's; until then a test seats each member's binding itself (seat ID = binding ID).
      const binding = stack.repos.currentBinding(ids[alias]!)!;
      stack.engine!.seat(roomId, { actor: "$user", id: `seat:${alias}`, seatId: binding.id, threadId: binding.threadId, orchestrator: alias === options.consigliere });
    }
    if (options.consigliere) stack.repos.setRoomConsigliere(roomId, ids[options.consigliere]!, new Date().toISOString());
  }
  const room: Room = {
    stack, fake, roomId, ids, dir, run,
    draft(text) {
      const r = stack.repos.getRoom(roomId)!;
      return parseExplicit(text, stack.repos.listActiveParticipants(roomId).map((p) => ({ id: p.id, alias: p.alias })), [], { consigliereId: r.consigliereId, engine: true });
    },
    async say(text, attachmentIds = []) {
      const draft = room.draft(text);
      const errors = draft.unresolved.filter((u) => u.severity === "error");
      if (errors.length) throw new Error(`draft refused: ${errors.map((u) => u.message).join("; ")}`);
      if (draft.kind === "note") return (await run({ type: "room.note.create", roomId, text: draft.instruction })) as never;
      return (await run({
        type: "message.create", roomId, sourceText: text, preamble: draft.preamble, attachmentIds,
        assignments: draft.assignments.map((a) => ({ recipients: a.recipients, instruction: a.instruction, schedule: a.schedule ?? { mode: "now" }, after: a.after.map((r) => r.index), slashCommand: Boolean(a.slashCommand), delivery: a.delivery })),
      })) as { messageId: string; requestIds: string[]; noteIds: string[] };
    },
    async tick(times = 2) {
      for (let i = 0; i < times; i++) await stack.scheduler.tick();
    },
    seat: (alias) => stack.repos.currentBinding(ids[alias]!)!.id,
    thread: (alias) => stack.repos.currentBinding(ids[alias]!)!.threadId,
    runs: (alias) => fake.threads.get(room.thread(alias))!.runs,
    prompt(alias, index) {
      const t = fake.threads.get(room.thread(alias))!;
      return t.messages.find((m) => m.id === t.runs[index]!.userMessageId)!.text;
    },
    complete: (alias, text, outcome = "completed") => fake.completeRun(room.thread(alias), { text, outcome }),
    events: () => stack.engine!.view(roomId).events,
    close() {
      stack.close();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return room;
}

const requestsOf = (r: Room) => [...r.stack.engine!.view(r.roomId).requests.values()];
const requestState = (r: Room, id: string) => r.stack.engine!.view(r.roomId).requests.get(id)!.state;
const dispatches = (r: Room) => r.fake.commands.filter((c) => c.type === "message.dispatch").map((c) => c.payload as SendMessageInput);
const pngId = (r: Room, name: string) => r.stack.service.storeAttachment({ roomId: r.roomId, name, mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, name.length]) }).id;
const errorsOf = (d: Draft) => d.unresolved.filter((u) => u.severity === "error").map((u) => u.message);

// ---------------- How a message becomes tasks ----------------

test("How a message becomes tasks, 1. split: each recipient of an assignment gets its own request with the same text, all sharing the message's ID", async (t) => {
  const r = await engineRoom(["sol", "grok", "claude"]);
  t.after(() => r.close());
  const created = await r.say("@sol @grok review the diff");
  assert.equal(created.requestIds.length, 2);
  const requests = requestsOf(r);
  assert.deepEqual(requests.map((q) => q.owner).sort(), [r.seat("sol"), r.seat("grok")].sort());
  assert.ok(requests.every((q) => q.body === "review the diff" && q.returnTo === "$user"));
  assert.ok(created.requestIds.every((id) => messageIdOf(id) === created.messageId), "one message ID for display");
  await r.tick();
  assert.equal(r.runs("sol").length, 1);
  assert.equal(r.runs("grok").length, 1);
  assert.equal(r.runs("claude").length, 0);
});

test("How a message becomes tasks, 1. split: text before the first address is context every recipient's request carries", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const created = await r.say("The build is red. @sol fix it. @grok find the cause");
  const byId = new Map(requestsOf(r).map((q) => [q.id, q]));
  assert.deepEqual(created.requestIds.map((id) => byId.get(id)!.body), ["The build is red.\n\nfix it.", "The build is red.\n\nfind the cause"]);
  await r.tick();
  assert.match(r.prompt("sol", 0), /The build is red\.\n\nfix it\./);
});

test("How a message becomes tasks, 2. timing (D2): /hold is refused with a hint, by the parser and by the service", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("/hold @sol save this for later")), [HOLD_GONE]);
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "later", schedule: { mode: "manual" } }] }), (e: Error) => e.message === HOLD_GONE);
  assert.equal(requestsOf(r).length, 0);
});

test("How a message becomes tasks, 2. timing (D2): /after is refused with a hint, on a task or on a member", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("/after task41 @grok review the implementation")), [AFTER_GONE]);
  assert.deepEqual(errorsOf(r.draft("/after @sol @grok review it")), [AFTER_GONE]);
  assert.deepEqual(errorsOf(r.draft("/after")), [AFTER_GONE], "an unfinished /after says it is gone, not what it lacks");
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "build" }, { recipients: [r.ids.grok!], instruction: "review", after: [0] }] }), /Waiting for other work is gone/);
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.grok!], instruction: "review", schedule: { mode: "after_all", prerequisites: [{ taskId: "x", revision: 1 }] } }] }), /Waiting for other work is gone/);
});

test("How a message becomes tasks, 2. timing (D2): every implied wait is refused with a hint naming whom it waited for", async (t) => {
  const r = await engineRoom(["claude", "grok", "codex"]);
  t.after(() => r.close());
  const refused = (text: string) => errorsOf(r.draft(text)).join(" | ");
  assert.match(refused("@claude build it, then @grok deploy it"), /^Waiting for @claude is gone: send this once @claude is done, have the Consigliere sequence it, or add \/now/);
  assert.match(refused("@claude fix the login bug. @grok check claude's work"), /Waiting for @claude is gone/);
  assert.match(refused("when @grok finishes, @claude write the summary"), /Waiting for other work is gone/, "a condition on work outside the message");
  assert.match(refused("@grok deploy it when claude finishes"), /Waiting for other work is gone/);
  assert.match(refused("@claude fix it and once she's done @grok test it"), /Waiting for @claude is gone/);
  assert.match(refused("@claude build the API. @grok build the UI. @codex review both once they're finished"), /Waiting for @claude and @grok is gone/);
  assert.match(refused("@claude draft a plan. @grok merge them when @all finished"), /Waiting for .* is gone/);
  assert.equal(r.draft("@claude build it, then @grok deploy it").hints.some((h) => h.includes("/after")), false, "no hint points at /after");
});

test("How a message becomes tasks, 2. timing: /now still starts an assignment now, past an implied wait", async (t) => {
  const r = await engineRoom(["claude", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("@claude build it. @grok /now read the notes")), []);
  const created = await r.say("@claude build it. @grok /now read the claude notes");
  assert.equal(created.requestIds.length, 2);
  await r.tick();
  assert.equal(r.runs("claude").length, 1);
  assert.equal(r.runs("grok").length, 1, "both start at once");
});

test("How a message becomes tasks, 3. deliver: a request goes to its member's thread straight away, or after that thread's current turn ends", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  assert.equal(r.runs("sol").length, 1, "straight away");
  await r.say("@sol also add tests");
  await r.tick();
  assert.equal(r.runs("sol").length, 1, "waits for the running turn");
  assert.equal(r.fake.steeredMessages, 0);
  r.complete("sol", "Built.");
  await r.tick();
  assert.equal(r.runs("sol").length, 2, "then starts its own turn");
  assert.match(r.prompt("sol", 1), /also add tests/);
});

// ---------------- Addressing ----------------

test("Addressing: @all is everyone in the room, one request each, and the Consigliere is never among them", async (t) => {
  const r = await engineRoom(["fable", "sol", "grok"], { consigliere: "fable" });
  t.after(() => r.close());
  assert.deepEqual(r.draft("@all review the release notes").assignments[0]!.recipients, [r.ids.fable], "in his room he takes it");
  const plain = await engineRoom(["sol", "grok", "codex"]);
  t.after(() => plain.close());
  const created = await plain.say("@all review the release notes");
  assert.equal(created.requestIds.length, 3);
  assert.deepEqual(errorsOf(plain.draft("@all review")), []);
});

test("Addressing: the spoken form at the start of a sentence addresses, and a name not in the room is an error", async (t) => {
  const r = await engineRoom(["sol2", "grok"]);
  t.after(() => r.close());
  const created = await r.say("Sol two, review the parser");
  assert.equal(requestsOf(r).find((q) => q.id === created.requestIds[0])!.owner, r.seat("sol2"));
  assert.match(errorsOf(r.draft("@bob check the logs")).join(), /nobody called @bob/);
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: ["nobody"], instruction: "x" }] }), /not in this room/);
});

test("Addressing: in a room with one member, a message that addresses nobody goes to that member", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("review the diff");
  assert.equal(requestsOf(r)[0]!.owner, r.seat("sol"));
});

// ---------------- Several assignments in one message ----------------

test("Several assignments in one message: two assignments both start now, each recipient with its own instruction", async (t) => {
  const r = await engineRoom(["claude", "grok"]);
  t.after(() => r.close());
  const created = await r.say("@claude fix the login bug @grok update the docs");
  assert.deepEqual(created.requestIds.map((id) => requestsOf(r).find((q) => q.id === id)!.body), ["fix the login bug", "update the docs"]);
  await r.tick();
  assert.equal(r.runs("claude").length + r.runs("grok").length, 2);
});

// ---------------- Notes ----------------

test("Notes: a note creates no request and starts no turn, and every member's next briefing carries it", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const note = (await r.say("/note we keep the public API as it is")) as unknown as { type: string; eventId: string };
  assert.equal(note.type, "note.created");
  assert.equal(requestsOf(r).length, 0);
  await r.tick();
  assert.equal(r.runs("sol").length + r.runs("grok").length, 0, "nobody is woken");
  await r.say("@sol @grok review the change");
  await r.tick();
  for (const alias of ["sol", "grok"]) assert.match(r.prompt(alias, 0), /note from the user\]\nwe keep the public API as it is/, `@${alias}'s briefing has the note`);
  r.complete("sol", "Reviewed.");
  await r.say("@sol one more look");
  await r.tick();
  assert.doesNotMatch(r.prompt("sol", 1), /we keep the public API/, "once, not in every briefing");
});

// ---------------- Images ----------------

test("Images: every assignment in the message receives them, attached exactly; a message with images can have an empty instruction", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const shot = pngId(r, "shot.png");
  const created = await r.run({ type: "message.create", roomId: r.roomId, attachmentIds: [shot], assignments: [{ recipients: [r.ids.sol!], instruction: "" }, { recipients: [r.ids.grok!], instruction: "compare with this" }] }) as { requestIds: string[] };
  assert.equal(requestsOf(r).find((q) => q.id === created.requestIds[0])!.body, "(See the attached image.)");
  await r.tick();
  const sent = dispatches(r);
  assert.equal(sent.length, 2);
  for (const d of sent) assert.deepEqual(d.images?.map((i) => i.name), ["shot.png"]);
  assert.match(r.prompt("sol", 0), /shot\.png/, "the briefing names the image it carries");
});

test("Images: a retry delivers the same bytes", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const shot = pngId(r, "graph.png");
  await r.run({ type: "message.create", roomId: r.roomId, attachmentIds: [shot], assignments: [{ recipients: [r.ids.sol!], instruction: "explain the graph" }] });
  await r.tick();
  r.complete("sol", "provider crashed", "error");
  await r.tick();
  const run = [...r.stack.engine!.view(r.roomId).runs.values()][0]!;
  assert.ok(run.failure, "the run failed");
  await r.run({ type: "run.retry", roomId: r.roomId, runId: run.id });
  await r.tick();
  const [first, second] = dispatches(r);
  assert.equal(r.runs("sol").length, 2);
  assert.deepEqual(second!.images, first!.images, "the same bytes");
  assert.match(r.prompt("sol", 1), /explain the graph/, "with the original content");
});

// ---------------- Quoting and escaping ----------------

test("Quoting and escaping: code, quoted lines and \\@name address nobody", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const draft = r.draft("@sol look at `@grok` and\n> @grok said so\nand \\@grok too");
  assert.deepEqual(draft.assignments.map((a) => a.recipients), [[r.ids.sol]]);
  assert.deepEqual(errorsOf(draft), []);
});

// ---------------- Sending while someone is working ----------------

test("Sending while someone is working: /steer goes into the running turn, recorded as sync.offered plus confirm_sync with T3's evidence, and one final answers both", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const first = await r.say("@sol build it");
  await r.tick();
  const steer = await r.say("@sol /steer also cover the edge cases");
  assert.ok(steer.requestIds[0]!.startsWith("steer:"));
  await r.tick(1);
  assert.equal(r.fake.steeredMessages, 1);
  assert.equal(r.runs("sol").length, 1, "no new run in T3");
  const sent = dispatches(r)[1]!;
  assert.equal(sent.mode.type, "steer");
  assert.equal((sent.mode as { runId: string }).runId, r.runs("sol")[0]!.id, "into the T3 run that is running");
  assert.match(sent.text, /also cover the edge cases/);
  assert.match(sent.text, /This came into your running turn/);
  assert.doesNotMatch(sent.text, /You are "sol"/, "the work only, not the standing part");
  const offered = r.events().find((e) => e.data.kind === "sync.offered")!;
  const confirmed = r.events().find((e) => e.data.kind === "sync.confirmed")!;
  assert.ok(offered && confirmed);
  assert.equal(confirmed.data.kind === "sync.confirmed" && confirmed.data.evidence, `t3msg:${sent.messageId} t3run:${r.runs("sol")[0]!.id} steer`);
  r.complete("sol", "Built it, edge cases covered.");
  await r.tick();
  assert.equal(requestState(r, first.requestIds[0]!), "answered");
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
  const outputs = r.events().filter((e) => e.data.kind === "output" && e.data.claims.length > 0);
  assert.equal(outputs.length, 1, "one reply answers both");
  assert.equal(r.runs("sol").length, 1);
});

test("Sending while someone is working: a steer for an idle member is an ordinary turn with the full briefing", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol /steer review the diff");
  await r.tick();
  assert.equal(r.fake.steeredMessages, 0);
  assert.equal(dispatches(r)[0]!.mode.type, "start");
  assert.match(r.prompt("sol", 0), /^\[Backroom briefing for @sol in room "engine"\]/);
});

test("Sending while someone is working: a steer is never sent while the turn waits on an approval; it goes in once that is answered", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  const approval = r.fake.raiseApproval(r.thread("sol"));
  await r.say("@sol /steer use the new API");
  await r.tick();
  assert.equal(r.fake.steeredMessages, 0, "not while an approval is open");
  await r.run({ type: "native.approval.respond", participantId: r.ids.sol!, requestId: approval, decision: "accept" });
  await r.tick();
  assert.equal(r.fake.steeredMessages, 1, "sent once the turn runs again");
});

test("Sending while someone is working: when the turn has ended by the time T3 has the steer, T3's own run for it is adopted and its reply answers it", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const first = await r.say("@sol build it");
  await r.tick();
  // The turn ends just as the steer reaches T3, so T3 starts a run of its own for the message.
  r.fake.beforeSteer = () => r.complete("sol", "Built.");
  const steer = await r.say("@sol /steer also add tests");
  await r.tick(1);
  assert.equal(r.runs("sol").length, 2, "T3 ran the steered message as a turn of its own");
  assert.equal(r.fake.steeredMessages, 0);
  await r.tick();
  assert.equal(requestState(r, first.requestIds[0]!), "answered", "the first turn answered only what it had");
  const adopted = [...r.stack.engine!.view(r.roomId).runs.values()][1]!;
  assert.equal(adopted.dispatchMessageId, r.runs("sol")[1]!.userMessageId, "adopted by its message ID");
  assert.ok(r.events().some((e) => e.data.kind === "run.phase" && e.data.runId === adopted.id && e.data.evidence.startsWith(`t3run:${r.runs("sol")[1]!.id} `)));
  assert.equal(r.runs("sol").length, 2, "no third run");
  r.complete("sol", "Tests added.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
  assert.equal(r.runs("sol").length, 2);
  assert.equal(r.events().filter((e) => e.data.kind === "note").length, 0, "neither the message nor its reply is imported as a note");
});

test("Sending while someone is working: a run T3 started for a steer is not adopted when more input came since; its reply is a note and one ordinary run carries everything", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  r.fake.beforeSteer = () => r.complete("sol", "Built.");
  const steer = await r.say("@sol /steer also add tests");
  await r.tick(1);
  const later = await r.say("@sol and update the changelog");
  await r.tick();
  assert.equal(r.runs("sol").length, 2, "waits for T3's run of the steer");
  r.complete("sol", "Tests added.");
  await r.tick();
  const note = r.events().find((e) => e.data.kind === "note")!;
  assert.ok(note.data.kind === "note" && note.data.body.includes("Tests added.") && note.data.requestIds.includes(steer.requestIds[0]!));
  assert.equal(r.runs("sol").length, 3, "an ordinary run");
  assert.match(r.prompt("sol", 2), /also add tests[\s\S]*update the changelog/);
  r.complete("sol", "Both done.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
  assert.equal(requestState(r, later.requestIds[0]!), "answered");
});

test("Sending while someone is working: a steer T3 did not take is sent again with the same IDs, also after a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-l4a-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = new Fake();
  let r = await engineRoom(["sol"], { fake, dir });
  await r.say("@sol build it");
  await r.tick();
  fake.unavailableSteers = 1;
  const steer = await r.say("@sol /steer also add tests");
  await r.tick(1);
  assert.equal(fake.steeredMessages, 0, "the send was lost");
  const offer = r.events().find((e) => e.data.kind === "sync.offered")!;
  r.close();
  r = await engineRoom(["sol"], { fake, dir, fresh: false });
  t.after(() => r.close());
  await r.tick(1);
  assert.equal(fake.steeredMessages, 1);
  const sent = dispatches(r).filter((d) => d.mode.type === "steer");
  assert.equal(sent.length, 1);
  assert.ok(offer.data.kind === "sync.offered" && offer.data.receipt.id.endsWith(`${sent[0]!.commandId}:${sent[0]!.messageId}`), "the IDs the offer carries");
  assert.ok(r.events().some((e) => e.data.kind === "sync.confirmed"));
  r.complete("sol", "Done, with tests.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
});

// ---------------- T3 slash commands ----------------

test("T3 slash commands: sent to the member's thread exactly as typed, with no briefing, and recorded once as a note", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  // A first host run, so the thread's later turns are imported (§3).
  await r.say("@sol build it");
  await r.tick();
  r.complete("sol", "Built.");
  await r.tick();
  const created = await r.say("@sol /compact focus on the parser");
  assert.equal(created.requestIds.length, 0);
  const sent = dispatches(r).at(-1)!;
  assert.equal(sent.text, "/compact focus on the parser");
  assert.equal(sent.mode.type, "start");
  r.complete("sol", "Context compacted.");
  await r.tick();
  const notes = r.events().filter((e) => e.data.kind === "note");
  assert.deepEqual(notes.map((e) => e.id), [created.noteIds[0], notes[1]?.id], "the command once, then its reply");
  assert.ok(notes[0]!.data.kind === "note" && notes[0]!.data.author === "$user" && notes[0]!.data.body.endsWith("/compact focus on the parser"));
  assert.ok(notes[1]!.data.kind === "note" && notes[1]!.data.author === r.seat("sol") && notes[1]!.data.body === "Context compacted.");
});

test("T3 slash commands: unknown commands are blocked, and one cannot be combined with /steer", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await assert.rejects(r.say("@sol /nonsense"), /has no \/nonsense command/);
  assert.match(errorsOf(r.draft("@sol /steer /compact")).join(), /starts its own turn/);
  assert.throws(() => parseCommand({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "/compact", slashCommand: true, delivery: "steer" }] }));
  assert.equal(dispatches(r).length, 0);
});

test("T3 slash commands: a command does not count as the member having seen the room; its next request gets the full briefing", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol /review");
  r.complete("sol", "No changes to review.");
  await r.say("@sol build it");
  await r.tick();
  assert.match(r.prompt("sol", 1), /^\[Backroom briefing for @sol in room "engine"\]\nYou are "sol"/);
});

// ---------------- The Consigliere: every message is for him ----------------

test("The Consigliere: every message is for him, also when it names members, and it is steered into his turn when he is working", async (t) => {
  const r = await engineRoom(["fable", "sol"], { consigliere: "fable" });
  t.after(() => r.close());
  const first = await r.say("@sol check the logs");
  const q = requestsOf(r).find((x) => x.id === first.requestIds[0])!;
  assert.equal(q.owner, r.seat("fable"));
  assert.equal(q.body, "@sol check the logs", "names and all");
  await r.tick();
  assert.equal(r.runs("fable").length, 1, "a turn of his own when idle");
  assert.equal(r.runs("sol").length, 0);
  await r.say("and the metrics too");
  await r.tick(1);
  assert.equal(r.fake.steeredMessages, 1, "into his turn when he is working");
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "check the logs" }] }), /every message is for him/);
});

test("The Consigliere: a T3 slash command still goes straight to the member it names", async (t) => {
  const r = await engineRoom(["fable", "sol"], { consigliere: "fable" });
  t.after(() => r.close());
  await r.say("@sol /compact");
  assert.equal(dispatches(r)[0]!.threadId, r.thread("sol"));
  assert.equal(requestsOf(r).length, 0);
});

test("The Consigliere (D2): a message that chains members goes to him whole and is his to sequence; /hold is refused even there", async (t) => {
  const r = await engineRoom(["fable", "claude", "grok"], { consigliere: "fable" });
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("@claude build it, then @grok deploy it")), []);
  assert.deepEqual(errorsOf(r.draft("/hold @claude save this")), [HOLD_GONE]);
  assert.deepEqual(errorsOf(r.draft("/hold think about it")), [HOLD_GONE]);
});

// ---------------- The user's controls: cancel, correct, retry, stop ----------------

test("Cancel: the user withdraws a request a member is working on; the turn is stopped and the request ends cancelled", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const created = await r.say("@sol build it");
  await r.tick();
  const result = (await r.run({ type: "request.cancel", roomId: r.roomId, requestId: created.requestIds[0]! })) as { applied: boolean };
  assert.equal(result.applied, true);
  assert.equal(requestState(r, created.requestIds[0]!), "cancelled");
  assert.equal(r.runs("sol")[0]!.status, "interrupted", "the turn was stopped");
  await r.tick();
  // A cancel wakes its owner (plan §4): the member is told in a turn of its own.
  assert.equal(r.runs("sol").length, 2);
  assert.match(r.prompt("sol", 1), /cancel/i);
  r.complete("sol", "Understood, dropped it.");
  await r.tick();
  assert.equal(requestState(r, created.requestIds[0]!), "cancelled");
  assert.equal(r.runs("sol").length, 2);
  await assert.rejects(r.run({ type: "request.cancel", roomId: r.roomId, requestId: "nope" }), /not a request in this room/);
});

test("Correct: the user amends a running request; the turn's final does not answer it, the next run carries the correction and answers it", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const created = await r.say("@sol write the release note");
  await r.tick();
  await r.run({ type: "request.correct", roomId: r.roomId, requestId: created.requestIds[0]!, text: "Keep it under 100 words." });
  r.complete("sol", "Here is a long release note.");
  await r.tick();
  assert.equal(requestState(r, created.requestIds[0]!), "open", "superseded by the correction it had not seen");
  assert.equal(r.runs("sol").length, 2);
  assert.match(r.prompt("sol", 1), /Keep it under 100 words\./);
  r.complete("sol", "A short release note.");
  await r.tick();
  assert.equal(requestState(r, created.requestIds[0]!), "answered");
  await assert.rejects(r.run({ type: "request.correct", roomId: r.roomId, requestId: created.requestIds[0]!, text: "too late" }), /closed request/);
});

test("Retry and Stop: the user stops a member's turn, which fails with a notice to the user, and retries it with its original content", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const created = await r.say("@sol run the migration");
  await r.tick();
  await r.run({ type: "run.stop", roomId: r.roomId, participantId: r.ids.sol! });
  await r.tick();
  assert.equal(r.runs("sol")[0]!.status, "interrupted");
  const notice = r.events().find((e) => e.data.kind === "notice")!;
  assert.ok(notice.data.kind === "notice" && notice.data.intent === "error" && notice.data.requestIds.includes(created.requestIds[0]!));
  assert.equal(requestState(r, created.requestIds[0]!), "open");
  const run = [...r.stack.engine!.view(r.roomId).runs.values()][0]!;
  await r.run({ type: "run.retry", roomId: r.roomId, runId: run.id, text: "Go on, it is safe now." });
  await r.tick();
  assert.equal(r.runs("sol").length, 2);
  assert.match(r.prompt("sol", 1), /Go on, it is safe now\.[\s\S]*run the migration|run the migration[\s\S]*Go on, it is safe now\./);
  r.complete("sol", "Migrated.");
  await r.tick();
  assert.equal(requestState(r, created.requestIds[0]!), "answered");
  await assert.rejects(r.run({ type: "run.stop", roomId: r.roomId, participantId: r.ids.sol! }), /not running anything/);
});

// ---------------- Limits and the flag ----------------

test("§7: the message API refuses a post over 1 MiB", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "x".repeat(1024 * 1024 + 1) }] }), /up to 1 MiB/);
  await r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "x".repeat(1024 * 1024) }] });
  assert.equal(requestsOf(r).length, 1);
});

test("a member with no seat on the board yet is refused rather than given an old task", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const late = ((await r.run({ type: "participant.create", roomId: r.roomId, alias: "late", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string }).participantId;
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [late], instruction: "hello" }] }), /no seat on this room's board/);
  assert.equal(r.stack.repos.listTasks(r.roomId).length, 0);
});

test("without the flag the engine's controls are refused and the parser keeps /after and /hold", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-l4a-"));
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null, engine: false });
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { roomId } = (await stack.service.execute(parseCommand({ type: "room.create", projectId: "project_demo", title: "old" }))) as { roomId: string };
  for (const command of [{ type: "request.cancel", roomId, requestId: "r" }, { type: "request.correct", roomId, requestId: "r", text: "t" }, { type: "run.retry", roomId, runId: "r" }, { type: "run.stop", roomId, participantId: "p" }] as const) {
    await assert.rejects(stack.service.execute(parseCommand(command)), /ROOMS_ENGINE=1/);
  }
  const parts = [{ id: "a", alias: "sol" }];
  assert.equal(parseExplicit("/hold @sol later", parts, []).assignments[0]!.schedule?.mode, "manual");
  assert.deepEqual(errorsOf(parseExplicit("/hold @sol later", parts, [])), []);
});
