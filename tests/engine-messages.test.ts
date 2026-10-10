/**
 * The user's message path on the engine (plan item L4a): src/app/engineMessages.ts, the parser's refusals (D2) and
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
import { T3CommandRejected, T3Unavailable } from "../src/adapter/types.ts";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { startAttemptKey } from "../src/app/consigliere.ts";
import { MAX_POST_BYTES, messageIdOf } from "../src/app/engineMessages.ts";
import { CommandValidationError, parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { RoomEvent } from "../src/engine/index.ts";
import { AFTER_GONE, HOLD_GONE, NOTE_GONE, STEER_GONE, parseExplicit, type Draft } from "../src/parser/explicit.ts";
import { ROOM_NOTE } from "../src/briefing/envelope.ts";

/**
 * The fake T3, plus: a hook on a steered message just before T3 takes it; steer sends lost to an outage, refused, or
 * with their acknowledgement lost (`lateSteer` keeps the message for `deliverLate`, `dropSteers` loses every one); slash
 * commands refused by an outage; and a hook right after T3 recorded a message that is not a steer.
 */
class Fake extends FakeT3Adapter {
  beforeSteer: (() => void) | null = null;
  unavailableSteers = 0;
  refuseSteers = 0;
  lateSteer = false;
  dropSteers = false;
  late: SendMessageInput | null = null;
  slashDown = false;
  afterRecord: (() => Promise<void>) | null = null;
  constructor() {
    super({ autoCompleteMs: null });
  }
  override async sendMessage(input: SendMessageInput): Promise<void> {
    if (input.mode.type === "steer") {
      if (this.unavailableSteers > 0) {
        this.unavailableSteers -= 1;
        throw new T3Unavailable("T3 is not reachable (simulated)");
      }
      if (this.refuseSteers > 0) {
        this.refuseSteers -= 1;
        throw new T3CommandRejected("T3 refused the steer (simulated)", 500, null);
      }
      if (this.dropSteers) throw new Error("request timed out (simulated); T3 never got it");
      if (this.lateSteer) {
        this.lateSteer = false;
        this.late = structuredClone(input);
        throw new Error("request timed out (simulated); T3 is still working on it");
      }
      const hook = this.beforeSteer;
      this.beforeSteer = null;
      hook?.();
    } else if (this.slashDown && input.text.startsWith("/")) {
      throw new T3Unavailable("T3 is not reachable (simulated)");
    }
    await super.sendMessage(input);
    const after = this.afterRecord;
    if (after && input.mode.type !== "steer") {
      this.afterRecord = null;
      await after();
    }
  }
  /** T3 finally records the steer whose acknowledgement was lost. */
  async deliverLate(): Promise<void> {
    const input = this.late!;
    this.late = null;
    await super.sendMessage(input);
  }
}

interface Room {
  stack: AppStack;
  fake: Fake;
  roomId: string;
  ids: Record<string, string>;
  dir: string;
  run(command: RoomCommandInput): Promise<unknown>;
  /** What the composer does: parse, then message.create with the draft's assignments. */
  say(text: string, attachmentIds?: string[], clientMessageId?: string): Promise<{ messageId: string; requestIds: string[]; noteIds: string[] }>;
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


/** A member in rooms.sqlite with no seat on the board, as a crash between the two stores would leave it: L4b's
 *  participant.create seats every member it makes, so tests that need one write it directly. */
function unseatedMember(repos: AppStack["repos"], roomId: string, alias: string): string {
  const at = new Date().toISOString();
  const id = `unseated:${alias}:${roomId}`;
  repos.insertParticipant({ id, roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: at, updatedAt: at });
  repos.insertBinding({ id: `binding:${id}`, participantId: id, generation: 1, threadId: `thread:${id}`, deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: at, retiredAt: null });
  return id;
}

async function engineRoom(aliases = ["sol", "grok"], options: { consigliere?: string; fake?: Fake; dir?: string; fresh?: boolean } = {}): Promise<Room> {
  const fake = options.fake ?? new Fake();
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "backroom-l4a-"));
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null });
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
      // participant.create seats the member on the board (L4b); the Consigliere is designated there.
      if (alias === options.consigliere) stack.engine!.designate(roomId, { id: `designate:${alias}`, seatId: stack.repos.currentBinding(ids[alias]!)!.id });
    }
    if (options.consigliere) stack.repos.setRoomConsigliere(roomId, ids[options.consigliere]!, new Date().toISOString());
  }
  const room: Room = {
    stack, fake, roomId, ids, dir, run,
    draft(text) {
      const r = stack.repos.getRoom(roomId)!;
      return parseExplicit(text, stack.repos.listActiveParticipants(roomId).map((p) => ({ id: p.id, alias: p.alias })), { consigliereId: r.consigliereId });
    },
    async say(text, attachmentIds = [], clientMessageId) {
      const draft = room.draft(text);
      const errors = draft.unresolved.filter((u) => u.severity === "error");
      if (errors.length) throw new Error(`draft refused: ${errors.map((u) => u.message).join("; ")}`);
      return (await run({
        type: "message.create", roomId, sourceText: text, preamble: draft.preamble, attachmentIds, ...(clientMessageId ? { clientMessageId } : {}),
        assignments: draft.assignments.map((a) => ({ recipients: a.recipients, instruction: a.instruction, slashCommand: Boolean(a.slashCommand) })),
      })) as { messageId: string; requestIds: string[]; noteIds: string[] };
    },
    async tick(times = 2) {
      for (let i = 0; i < times; i++) await stack.engine.tick();
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

// ---------------- How a message becomes requests ----------------

test("How a message becomes requests, 1. split: each recipient of an assignment gets its own request with the same text, all sharing the message's ID", async (t) => {
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

test("How a message becomes requests, 1. split: text before the first address is context every recipient's request carries", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const created = await r.say("The build is red. @sol fix it. @grok find the cause");
  const byId = new Map(requestsOf(r).map((q) => [q.id, q]));
  assert.deepEqual(created.requestIds.map((id) => byId.get(id)!.body), ["The build is red.\n\nfix it.", "The build is red.\n\nfind the cause"]);
  await r.tick();
  assert.match(r.prompt("sol", 0), /The build is red\.\n\nfix it\./);
});

test("How a message becomes requests, 1. split: a client that sends only the message text (today's composer) still gets the preamble, read from it", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.run({ type: "message.create", roomId: r.roomId, sourceText: "The build is red. @sol fix it", assignments: [{ recipients: [r.ids.sol!], instruction: "fix it" }] });
  assert.equal(requestsOf(r)[0]!.body, "The build is red.\n\nfix it");
  await r.run({ type: "message.create", roomId: r.roomId, sourceText: "@sol and the docs", preamble: "", assignments: [{ recipients: [r.ids.sol!], instruction: "and the docs" }] });
  assert.equal(requestsOf(r)[1]!.body, "and the docs", "an explicit empty preamble is taken as sent");
});

/** A message.create carrying a field the command no longer has (Z4): refused before anything is recorded. */
const unknownField = (field: string) => (e: Error) => e instanceof CommandValidationError && e.message.includes(field);

test("How a message becomes requests, 2. timing (D2): /hold is refused with a hint by the parser; the command has no field for it", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("/hold @sol save this for later")), [HOLD_GONE]);
  await assert.rejects(async () => r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "later", schedule: { mode: "manual" } }] } as unknown as RoomCommandInput), unknownField("schedule"));
  assert.equal(requestsOf(r).length, 0);
});

test("How a message becomes requests, 2. timing (D2): /after is refused with a hint, whatever it names", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("/after task41 @grok review the implementation")), [AFTER_GONE]);
  assert.deepEqual(errorsOf(r.draft("/after @sol @grok review it")), [AFTER_GONE]);
  assert.deepEqual(errorsOf(r.draft("/after")), [AFTER_GONE], "an unfinished /after says it is gone, not what it lacks");
  await assert.rejects(async () => r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "build" }, { recipients: [r.ids.grok!], instruction: "review", after: [0] }] } as unknown as RoomCommandInput), unknownField("after"));
  await assert.rejects(async () => r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.grok!], instruction: "review", schedule: { mode: "after_all" } }] } as unknown as RoomCommandInput), unknownField("schedule"));
  assert.equal(requestsOf(r).length, 0);
});

test("How a message becomes requests, 2. timing (D2): every implied wait is refused with a hint naming whom it waited for", async (t) => {
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

test("How a message becomes requests, 2. timing: /now still starts an assignment now, past an implied wait", async (t) => {
  const r = await engineRoom(["claude", "grok"]);
  t.after(() => r.close());
  assert.deepEqual(errorsOf(r.draft("@claude build it. @grok /now read the notes")), []);
  const created = await r.say("@claude build it. @grok /now read the claude notes");
  assert.equal(created.requestIds.length, 2);
  await r.tick();
  assert.equal(r.runs("claude").length, 1);
  assert.equal(r.runs("grok").length, 1, "both start at once");
});

test("How a message becomes requests, 3. deliver: a request goes to its member's thread straight away: a turn of its own, or into the turn running (M1)", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const first = await r.say("@sol build it");
  await r.tick();
  assert.equal(r.runs("sol").length, 1, "straight away, as a turn of its own");
  const more = await r.say("@sol also add tests");
  await r.tick();
  assert.equal(r.runs("sol").length, 1, "no turn of its own: it went into the running one");
  assert.equal(r.fake.steeredMessages, 1);
  assert.match(dispatches(r).at(-1)!.text, /also add tests/);
  r.complete("sol", "Built, with tests.");
  await r.tick();
  assert.equal(r.runs("sol").length, 1, "nothing left for another turn");
  assert.equal(requestState(r, first.requestIds[0]!), "answered");
  assert.equal(requestState(r, more.requestIds[0]!), "answered");
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

test("How an @mention is read: possessive, after a linking word, after a one-word lead, with nothing after it, and in URLs and paths, it is a reference, not a recipient", async (t) => {
  const r = await engineRoom(["claude", "grok"]);
  t.after(() => r.close());
  const references = [
    "@claude review @grok's notes",
    "@claude work with @grok on the parser",
    "@claude review @grok changes",
    "@claude fix it and tell @grok",
    "@claude read https://example.com/@grok/page and src/@grok/main.ts",
  ];
  for (const text of references) {
    const draft = r.draft(text);
    assert.deepEqual(draft.assignments.map((a) => a.recipients), [[r.ids.claude]], text);
    assert.deepEqual(errorsOf(draft), [], text);
  }
  const before = requestsOf(r).length;
  await r.say(references[0]!);
  const made = requestsOf(r).slice(before);
  assert.deepEqual(made.map((q) => [q.owner, q.body]), [[r.seat("claude"), "review @grok's notes"]], "one request, the reference kept in its text");
  // At the start of a line, or mid-sentence with an instruction after it, a mention addresses.
  assert.deepEqual(r.draft("@claude fix it.\n@grok update the docs").assignments.map((a) => a.recipients), [[r.ids.claude], [r.ids.grok]]);
  assert.deepEqual(r.draft("@claude fix the login bug @grok update the docs").assignments.map((a) => a.recipients), [[r.ids.claude], [r.ids.grok]]);
  assert.deepEqual(r.draft("@claude and @grok review this").assignments.map((a) => a.recipients), [[r.ids.claude, r.ids.grok]], "side by side, one assignment");
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

test("Notes: a message that starts with the note directive is refused with one sentence and records nothing; a room note a journal already holds reaches every member's next briefing once", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  // N1: room notes are gone. The composer's draft is refused, and so is the message sent anyway, with or without its text.
  const draft = r.draft("/note we keep the public API as it is");
  assert.deepEqual([draft.kind, draft.assignments.length, draft.unresolved.map((u) => [u.severity, u.message])], ["task", 0, [["error", NOTE_GONE]]]);
  await assert.rejects(r.say("/note we keep the public API as it is"), new RegExp(`draft refused: ${NOTE_GONE}`));
  const [before, sent] = [r.events().length, r.fake.commands.length];
  for (const [sourceText, slashCommand] of [["/note we keep the public API as it is", false], ["/note we keep the public API as it is", true], [undefined, false]] as const) {
    const command = { type: "message.create", roomId: r.roomId, ...(sourceText ? { sourceText } : {}), assignments: [{ recipients: [r.ids.sol!], instruction: "/note we keep the public API as it is", slashCommand }] } as RoomCommandInput;
    await assert.rejects(r.run(command), (error: Error) => error.message === NOTE_GONE);
  }
  assert.equal(r.events().length, before, "nothing is recorded");
  assert.equal(r.fake.commands.length, sent, "nothing goes to T3");
  // A room note from before N1, as the journal holds it: it creates no request and wakes nobody.
  r.stack.engine!.note(r.roomId, { actor: "$user", id: "note:before-n1", body: "we keep the public API as it is", milestone: ROOM_NOTE });
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

test("Images: a message's images can total up to 80 MB", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const big = (name: string) => {
    const id = `big-${name}`;
    r.stack.repos.insertAttachment({ id, roomId: r.roomId, name, mimeType: "image/png", sizeBytes: 41 * 1024 * 1024, createdAt: new Date().toISOString() }, new Uint8Array([1]));
    return id;
  };
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, attachmentIds: [big("a.png"), big("b.png")], assignments: [{ recipients: [r.ids.sol!], instruction: "look" }] }), /80 MB per message/);
  assert.equal(requestsOf(r).length, 0);
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

test("Sending while someone is working: a message goes into the running turn, recorded as sync.offered plus confirm_sync with T3's evidence, and one final answers both", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const first = await r.say("@sol build it");
  await r.tick();
  const steer = await r.say("@sol also cover the edge cases");
  assert.ok(steer.requestIds[0]!.startsWith("msg:"), "an ordinary message: nothing marks it");
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

test("Sending while someone is working: a message for an idle member is an ordinary turn with the full briefing", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol review the diff");
  await r.tick();
  assert.equal(r.fake.steeredMessages, 0);
  assert.equal(dispatches(r)[0]!.mode.type, "start");
  assert.match(r.prompt("sol", 0), /^\[Backroom briefing for @sol in room "engine"\]/);
});

test("Sending while someone is working: a message is never sent into the turn while the turn waits on an approval; it goes in once that is answered", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  const approval = r.fake.raiseApproval(r.thread("sol"));
  await r.say("@sol use the new API");
  await r.tick();
  assert.equal(r.fake.steeredMessages, 0, "not while an approval is open");
  await r.run({ type: "native.approval.respond", participantId: r.ids.sol!, requestId: approval, decision: "accept" });
  await r.tick();
  assert.equal(r.fake.steeredMessages, 1, "sent once the turn runs again");
});

test("Sending while someone is working: when the turn has ended by the time T3 has the message, T3's own run for it is adopted and its reply answers it", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const first = await r.say("@sol build it");
  await r.tick();
  // The turn ends just as the steer reaches T3, so T3 starts a run of its own for the message.
  r.fake.beforeSteer = () => r.complete("sol", "Built.");
  const steer = await r.say("@sol also add tests");
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

test("Sending while someone is working: a run T3 started for a message is not adopted when more input came since; its reply is a follow-up and one ordinary run carries everything", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  r.fake.beforeSteer = () => r.complete("sol", "Built.");
  const steer = await r.say("@sol also add tests");
  await r.tick(1);
  const later = await r.say("@sol and update the changelog");
  await r.tick();
  assert.equal(r.runs("sol").length, 2, "waits for T3's run of the steer");
  r.complete("sol", "Tests added.");
  await r.tick();
  // Its reply answers nothing: a follow-up on what the steer carried, with the member's T3 status at the top (H5).
  const reply = r.events().find((e) => e.data.kind === "progress" && e.data.milestone === "follow-up")!;
  assert.ok(reply.data.kind === "progress" && reply.data.body.startsWith("[T3 status of @sol: ") && reply.data.body.includes("Tests added.") && reply.data.requestIds.includes(steer.requestIds[0]!));
  assert.equal(r.events().filter((e) => e.data.kind === "note").length, 0);
  assert.equal(r.runs("sol").length, 3, "an ordinary run");
  assert.match(r.prompt("sol", 2), /also add tests[\s\S]*update the changelog/);
  r.complete("sol", "Both done.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
  assert.equal(requestState(r, later.requestIds[0]!), "answered");
});

test("Sending while someone is working: a message T3 did not take is sent again with the same IDs, also after a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-l4a-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = new Fake();
  let r = await engineRoom(["sol"], { fake, dir });
  await r.say("@sol build it");
  await r.tick();
  fake.unavailableSteers = 1;
  const steer = await r.say("@sol also add tests");
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

test("Sending while someone is working: a message whose acknowledgement was lost, and that T3 records only after its run ended, reaches the agent once", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  r.fake.lateSteer = true;
  const steer = await r.say("@sol also add tests");
  await r.tick(1);
  r.complete("sol", "Built.");
  await r.tick(1);
  assert.equal(r.runs("sol").length, 2, "sent again with its own IDs: T3 runs it as a turn of its own, as no run is going");
  await r.fake.deliverLate(); // the lost send: T3 keeps one receipt per command ID
  await r.tick();
  assert.equal(r.runs("sol").length, 2, "no ordinary run carries it as well");
  r.complete("sol", "Tests added.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
  const carried = r.runs("sol").filter((_, i) => /also add tests/.test(r.prompt("sol", i)));
  assert.equal(carried.length, 1);
});

test("Sending while someone is working: a message T3 refused, or never reached, waits for nothing: the next ordinary run carries it", async (t) => {
  for (const fault of ["refuseSteers", "unavailableSteers"] as const) {
    const r = await engineRoom(["sol"]);
    t.after(() => r.close());
    await r.say("@sol build it");
    await r.tick();
    r.fake[fault] = 99;
    const steer = await r.say("@sol also add tests");
    await r.tick(1);
    r.fake[fault] = 0;
    r.complete("sol", "Built.");
    await r.tick();
    assert.equal(r.fake.steeredMessages, 0, fault);
    assert.equal(r.runs("sol").length, 2, fault);
    assert.match(r.prompt("sol", 1), /also add tests/, fault);
    r.complete("sol", "Tests added.");
    await r.tick();
    assert.equal(requestState(r, steer.requestIds[0]!), "answered", fault);
  }
});

test("Sending while someone is working: a message T3 never records is waited for up to five minutes after its run ended, then an ordinary run carries it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  r.fake.dropSteers = true;
  const steer = await r.say("@sol also add tests");
  await r.tick(1);
  r.complete("sol", "Built.");
  await r.tick(3);
  assert.equal(r.runs("sol").length, 1, "the seat waits: T3 may still record it");
  t.mock.timers.tick(5 * 60_000 + 1);
  await r.tick();
  assert.equal(r.runs("sol").length, 2, "then the ordinary run");
  assert.match(r.prompt("sol", 1), /also add tests/);
  r.complete("sol", "Tests added.");
  await r.tick();
  assert.equal(requestState(r, steer.requestIds[0]!), "answered");
});

// ---------------- T3 slash commands ----------------

test("T3 slash commands: sent to the member's thread exactly as typed, with no briefing, and recorded once as a note; its reply is a follow-up", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  // A first host run, so the thread's later turns are imported (§3).
  const build = await r.say("@sol build it");
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
  assert.deepEqual(notes.map((e) => e.id), [created.noteIds[0]], "the command once");
  assert.ok(notes[0]!.data.kind === "note" && notes[0]!.data.author === "$user" && notes[0]!.data.body.endsWith("/compact focus on the parser"));
  // Its reply answers nothing: a follow-up on the request sol's latest answer closed (H5), once.
  const replies = r.events().filter((e) => e.data.kind === "progress");
  assert.equal(replies.length, 1);
  assert.ok(replies[0]!.data.kind === "progress" && replies[0]!.data.author === r.seat("sol") && replies[0]!.data.milestone === "follow-up" && replies[0]!.data.body === "[T3 status of @sol: idle]\n\nContext compacted.");
  assert.deepEqual(replies[0]!.data.kind === "progress" && replies[0]!.data.requestIds, build.requestIds);
});

test("T3 slash commands: in a room with one member, /compact needs no @name", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const created = await r.say("/compact");
  assert.equal(created.requestIds.length, 0);
  assert.deepEqual(dispatches(r).map((d) => [d.threadId, d.text]), [[r.thread("sol"), "/compact"]]);
});

test("T3 slash commands: a tick that imports the command's T3 message before its note is written does not make it a failure; it is recorded once", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  r.complete("sol", "Built.");
  await r.tick();
  // The host's §3 import of the command's T3 message lands between T3 recording it and the note being written.
  r.fake.afterRecord = () => r.stack.engine.tick();
  const created = await r.say("@sol /compact");
  const notes = r.events().filter((e) => e.data.kind === "note");
  assert.deepEqual(notes.map((e) => e.id), created.noteIds, "one note, under the ID both writers use");
  assert.equal(dispatches(r).filter((d) => d.text === "/compact").length, 1);
});

test("T3 slash commands: a message whose T3 command T3 refuses records none of its requests, so sending it again makes one of each", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  r.fake.slashDown = true;
  await assert.rejects(r.say("@grok review the diff\n@sol /compact"), /T3 did not take \/compact for @sol/);
  assert.equal(requestsOf(r).length, 0, "nothing left behind");
  r.fake.slashDown = false;
  await r.say("@grok review the diff\n@sol /compact");
  assert.equal(requestsOf(r).filter((q) => q.body === "review the diff").length, 1);
  assert.equal(dispatches(r).filter((d) => d.text === "/compact").length, 1);
});

test("T3 slash commands: a message sent again under its client message ID records nothing twice and sends no T3 command twice", async (t) => {
  const r = await engineRoom(["sol", "grok"]);
  t.after(() => r.close());
  const id = "0b5a7e64-2f1c-4a8e-9d3b-6c1f2e4a5b70";
  const first = await r.say("@grok review the diff\n@sol /review", [], id);
  const again = await r.say("@grok review the diff\n@sol /review", [], id);
  assert.equal(first.messageId, id);
  assert.deepEqual(again, first);
  assert.equal(requestsOf(r).length, 1);
  assert.equal(r.events().filter((e) => e.data.kind === "note").length, 1);
  const sends = r.fake.commands.filter((c) => c.type === "message.dispatch");
  assert.equal(new Set(sends.map((c) => c.commandId)).size, 1, "sent again with the same command ID");
  assert.equal(r.runs("sol").length, 1, "which T3 ran once");
});

test("T3 slash commands: unknown commands are blocked; /steer is gone (M1), refused with its hint and never sent to T3, as a command or as text", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await assert.rejects(r.say("@sol /nonsense"), /has no \/nonsense command/);
  assert.deepEqual(errorsOf(r.draft("@sol /steer /compact")), [STEER_GONE]);
  assert.deepEqual(errorsOf(r.draft("/steer @sol also check the logs")), [STEER_GONE]);
  // A client that sends it anyway (an old page, a script) is refused by the service too.
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, sourceText: "/steer @sol also check the logs", assignments: [{ recipients: [r.ids.sol!], instruction: "also check the logs" }] }), /\/steer is gone/);
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "/steer also check the logs", slashCommand: true }] }), /\/steer is gone/);
  assert.equal(dispatches(r).length, 0);
  assert.equal(r.events().filter((e) => e.data.kind === "request").length, 0, "nothing recorded");
});

test("Old pages (M1): a page loaded before M1 still sends delivery; it is accepted and ignored, and the message goes into the running turn as any", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await r.say("@sol build it");
  await r.tick();
  for (const delivery of ["queue", "steer"] as const) {
    const created = (await r.run({ type: "message.create", roomId: r.roomId, sourceText: `@sol also ${delivery}`, assignments: [{ recipients: [r.ids.sol!], instruction: `also ${delivery}`, delivery }] })) as { requestIds: string[] };
    assert.match(created.requestIds[0]!, /^msg:/, delivery);
    await r.tick();
  }
  assert.equal(r.runs("sol").length, 1, "both went into the running turn");
  assert.equal(r.fake.steeredMessages, 2);
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

test("The Consigliere: every message is for him, also when it names members, and it goes into his turn when he is working, by name too (M1: no exception)", async (t) => {
  const r = await engineRoom(["fable", "sol"], { consigliere: "fable" });
  t.after(() => r.close());
  const first = await r.say("@sol check the logs");
  const q = requestsOf(r).find((x) => x.id === first.requestIds[0])!;
  assert.equal(q.owner, r.seat("fable"));
  assert.equal(q.body, "@sol check the logs", "names and all");
  await r.tick();
  assert.equal(r.runs("fable").length, 1, "a turn of his own when idle");
  assert.equal(r.runs("sol").length, 0);
  const more = await r.say("and the metrics too");
  await r.tick(1);
  assert.equal(r.fake.steeredMessages, 1, "into his turn when he is working");
  // Addressed to him by name: it goes in all the same (before M1 it waited for his turn to end).
  const named = await r.say("@fable and the traces");
  await r.tick(1);
  assert.equal(r.fake.steeredMessages, 2, "by name too");
  assert.equal(r.runs("fable").length, 1, "no turn of its own");
  r.complete("fable", "Logs, metrics and traces: handed to sol.");
  await r.tick();
  for (const id of [first, more, named].map((m) => m.requestIds[0]!)) assert.equal(requestState(r, id), "answered", "his first reply answers each");
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

test("The Consigliere: a conversation started with Talk to … gives him its first message as the composer would, his request on the board, and wakes him; sent again it records nothing twice", async (t) => {
  const r = await engineRoom([]);
  t.after(() => r.close());
  const presetId = ((await r.run({ type: "preset.create", name: "astra", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } })) as { presetId: string }).presetId;
  await r.run({ type: "consigliere.preset.set", presetId });
  const start = { type: "consigliere.start", projectId: "project_demo", text: "Plan the next release for me.", requestId: "3f0b8c52-6d1e-4c7a-9b2f-8e5d4a1c7b90" } as const;
  const started = (await r.run(start)) as { roomId: string; participantId: string };
  const seatId = r.stack.repos.currentBinding(started.participantId)!.id;
  const requests = () => [...r.stack.engine!.view(started.roomId).requests.values()];
  assert.deepEqual(
    requests().map((q) => [q.owner, q.returnTo, q.body, messageIdOf(q.id)]),
    [[seatId, "$user", "Plan the next release for me.", start.requestId]],
    "one request from the user to his seat, under the start's ID as the message's client ID",
  );
  assert.equal(r.stack.repos.listEvents(started.roomId).filter((e) => e.kind === "user.message").length, 0, "no old user message");
  assert.equal(r.stack.engine!.unread(started.roomId, seatId), 1, "his seat has the message unread");

  // The attempt stopped after the message and before it said so: the start sent again replays it.
  const key = startAttemptKey(start.requestId);
  r.stack.repos.setKv(key, JSON.stringify({ ...JSON.parse(r.stack.repos.getKv(key)!), delivered: false }));
  assert.deepEqual(await r.run(start), started);
  assert.equal(requests().length, 1, "recorded once");

  await r.tick();
  const thread = r.fake.threads.get(r.stack.repos.currentBinding(started.participantId)!.threadId)!;
  assert.equal(thread.runs.length, 1, "his turn starts");
  const prompt = thread.messages.find((m) => m.id === thread.runs[0]!.userMessageId)!.text;
  assert.match(prompt, /Plan the next release for me\./);
  assert.match(prompt, /Rules for the Consigliere/);
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

test("Correct: the user's correction that lands as the turn ends, too late to go in, leaves the final answering nothing; the next run carries it and answers", async (t) => {
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

// ---------------- Limits ----------------

test("§7: the message API refuses a post over 1 MiB", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "x".repeat(1024 * 1024 + 1) }] }), /up to 1 MiB/);
  await r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "x".repeat(1024 * 1024) }] });
  assert.equal(requestsOf(r).length, 1);
});

test("a member with no seat on the board yet is refused", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const late = unseatedMember(r.stack.repos, r.roomId, "late");
  await assert.rejects(r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [late], instruction: "hello" }] }), /no seat on this room's board/);
  assert.equal(requestsOf(r).length, 0);
});

test("Images: only PNG, JPEG, GIF and WebP are stored, and a message with neither text nor images is refused", async (t) => {
  const r = await engineRoom(["sol"]);
  t.after(() => r.close());
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  assert.throws(() => r.stack.service.storeAttachment({ roomId: r.roomId, name: "x.svg", mimeType: "image/svg+xml", data: png }), /PNG, JPEG, GIF, or WebP/);
  await assert.rejects(async () => r.run({ type: "message.create", roomId: r.roomId, assignments: [{ recipients: [r.ids.sol!], instruction: "" }] }), /instruction is empty/);
  assert.equal(requestsOf(r).length, 0);
});
