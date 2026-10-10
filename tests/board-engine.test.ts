/**
 * rooms-board on the engine (stage 4/5 plan, item L3; H5: members only answer): the member CLI over the journal. A room
 * of three seats (c, the Consigliere; w, a worker; v, a reviewer) on the engine host and the T3 fake, seated in the
 * journal. Wakes are counted as T3 runs on each fake thread, as tests/runtime does. Gate bullets, in the plan's order:
 *   1. each command appends exactly the expected events;
 *   2. a member's post mid-run is refused; its final answers at once and wakes the Consigliere, who relays the review;
 *   3. a member's own post never wakes itself;
 *   4. a key from another room is refused;
 *   5. index numbering is stable across restart and rebuild;
 *   6. a member's own continuation is a follow-up that wakes the Consigliere only;
 *   7. a 1 MiB + 1 B post is refused.
 * Then: members only answer (post refused, answer/working/follow gone), a correction supersedes a final, retry
 * refusals, board numbers in the host's texts, the seat stub, the route hook, and the CLI's --file.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { BoardEngine, MAX_POST_BYTES, type BoardEngineDeps } from "../src/app/boardEngine.ts";
import { BoardError } from "../src/app/board.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { journalDirectory } from "../src/briefing/envelope.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { EngineStore } from "../src/engine/index.ts";
import type { EventData, Projection, RoomEvent } from "../src/engine/index.ts";
import { loadConfig } from "../src/config.ts";
import { MEMBERS_DO_NOT_POST } from "../src/runtime/index.ts";
import { createHttpApp } from "../src/server/http.ts";
import { RuntimeFake } from "./runtime/helpers.ts";

const MiB = MAX_POST_BYTES;
const REPO = join(import.meta.dirname, "..");
/** A refusal's whole message, exactly. */
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** The refusal a member meets when it posts (H5), as the CLI prints it. */
const MEMBERS = exactly(`rooms-board: ${MEMBERS_DO_NOT_POST}`);

/** A member in rooms.sqlite with no seat on the board, as a crash between the two stores would leave it: L4b's
 *  participant.create seats every member it makes, so tests that need one write it directly. */
function unseatedMember(repos: AppStack["repos"], roomId: string, alias: string): string {
  const at = new Date().toISOString();
  const id = `unseated:${alias}:${roomId}`;
  repos.insertParticipant({ id, roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: at, updatedAt: at });
  repos.insertBinding({ id: `binding:${id}`, participantId: id, generation: 1, threadId: `thread:${id}`, deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: at, retiredAt: null });
  return id;
}

/** A room on the engine: rooms.sqlite and board.sqlite in a temporary folder, the T3 fake kept across restarts. */
class Fixture {
  readonly dir = mkdtempSync(join(tmpdir(), "backroom-board-engine-"));
  readonly fake = new RuntimeFake();
  stack: AppStack;
  board: BoardEngine;
  roomId = "";
  /** alias → participant ID, per room. */
  readonly members = new Map<string, Map<string, string>>();
  /** L4b's side, faked by the seat test: the room commands it runs and its reseats. */
  lifecycle: Pick<BoardEngineDeps, "execute" | "seats">;
  /** ROOMS_KEEPALIVE_MS as the server passes it (H6); the stack's default when absent. */
  private readonly keepAliveMs: number | undefined;

  private constructor(lifecycle: Pick<BoardEngineDeps, "execute" | "seats"> = {}, keepAliveMs?: number) {
    this.lifecycle = lifecycle;
    this.keepAliveMs = keepAliveMs;
    this.stack = this.make();
    this.board = this.makeBoard();
  }

  static async create(options: { aliases?: string[]; orchestrator?: string | null; lifecycle?: Pick<BoardEngineDeps, "execute" | "seats">; keepAliveMs?: number } = {}): Promise<Fixture> {
    const f = new Fixture(options.lifecycle, options.keepAliveMs);
    f.roomId = await f.room("payments", options.aliases ?? ["c", "w", "v"], options.orchestrator === undefined ? "c" : options.orchestrator);
    return f;
  }

  private make(): AppStack {
    return createStack({ dbPath: join(this.dir, "rooms.sqlite"), adapter: this.fake, briefingBudgetChars: 60_000, latestRelease: async () => null, ...(this.keepAliveMs !== undefined ? { keepAliveMs: this.keepAliveMs } : {}) });
  }

  private makeBoard(): BoardEngine {
    return new BoardEngine({
      repos: this.stack.repos,
      host: this.stack.engine!,
      standing: async (participantId) => `standing sections of ${participantId}`,
      afterSeat: async () => {
        await this.stack.engine!.tick();
      },
      ...this.lifecycle,
    });
  }

  /** A room with members, each seated in the journal (seat ID = binding ID); returns the room ID. */
  async room(title: string, aliases: string[], orchestrator: string | null, journal = true): Promise<string> {
    const { roomId } = (await this.run({ type: "room.create", projectId: "project_demo", title })) as { roomId: string };
    const ids = new Map<string, string>();
    for (const alias of aliases) {
      if (!journal) {
        ids.set(alias, unseatedMember(this.stack.repos, roomId, alias));
        continue;
      }
      // participant.create seats the member on the board (L4b); the orchestrator is designated there.
      const { participantId } = (await this.run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string };
      ids.set(alias, participantId);
      if (alias === orchestrator) this.stack.engine!.designate(roomId, { id: `designate:${alias}`, seatId: this.stack.repos.currentBinding(participantId)!.id });
    }
    this.members.set(roomId, ids);
    return roomId;
  }

  run(command: RoomCommandInput): Promise<unknown> {
    return this.stack.service.execute(parseCommand(command));
  }

  /** Throw the service away and build it again over the same files and the same T3. */
  restart(between?: () => void): void {
    this.stack.close();
    between?.();
    this.stack = this.make();
    this.board = this.makeBoard();
  }

  close(): void {
    this.stack.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  key(alias: string, roomId = this.roomId): string {
    return agentKey(alias, roomId);
  }

  seat(alias: string, roomId = this.roomId): string {
    return this.stack.repos.currentBinding(this.members.get(roomId)!.get(alias)!)!.id;
  }

  thread(alias: string, roomId = this.roomId): string {
    return this.stack.repos.currentBinding(this.members.get(roomId)!.get(alias)!)!.threadId;
  }

  /** What `rooms-board <argv> --as <alias's key>` prints. */
  cli(alias: string, ...argv: string[]): Promise<string> {
    return this.board.run(argv, this.key(alias));
  }

  /** The command is refused (BoardError) with a message matching `pattern`, and nothing is appended in any journal. */
  async refused(alias: string, argv: string[], pattern: RegExp, key = this.key(alias)): Promise<BoardError> {
    const heads = this.heads();
    let caught: unknown = null;
    try {
      await this.board.run(argv, key);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof BoardError, `expected a refusal of ${argv.join(" ")}, got ${caught === null ? "success" : String(caught)}`);
    assert.match(caught.message, pattern);
    assert.deepEqual(this.heads(), heads, "nothing appended");
    return caught;
  }

  heads(): number[] {
    return [...this.members.keys()].map((roomId) => this.p(roomId).events.length);
  }

  p(roomId = this.roomId): Projection {
    return this.stack.engine!.view(roomId);
  }

  /** The events a step appended to this room's journal. */
  async appended(step: () => Promise<unknown>, roomId = this.roomId): Promise<RoomEvent[]> {
    const before = this.p(roomId).events.length;
    await step();
    return this.p(roomId).events.slice(before);
  }

  async tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) await this.stack.engine!.tick();
  }

  /** Ends every turn still running, with a plain reply, until no seat has a turn or unread input. */
  async quiet(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await this.tick();
      const busy = [...this.members.get(this.roomId)!.keys()].filter((alias) => this.stack.repos.currentBinding(this.members.get(this.roomId)!.get(alias)!) && this.running(alias));
      if (busy.length === 0 && [...this.p().seats.values()].every((seat) => seat.activeRunId === null && this.stack.engine!.unread(this.roomId, seat.id) === 0)) return;
      for (const alias of busy) this.complete(alias, "ok");
    }
    assert.fail("the room did not go quiet");
  }

  wakes(alias: string): number {
    return this.fake.runsOf(this.thread(alias)).length;
  }

  running(alias: string): boolean {
    return this.fake.liveRun(this.thread(alias)) !== null;
  }

  complete(alias: string, text: string, outcome?: "completed" | "error"): void {
    this.fake.completeRun(this.thread(alias), { text, ...(outcome ? { outcome } : {}) });
  }

  /** The number `rooms-board` gives the post that made a request: the request event's seq. */
  num(requestId: string): number {
    return this.p().events.find((e) => e.data.kind === "request" && e.data.request.id === requestId)!.seq;
  }

  /** The request a `post` reply names first ("Posted #n → …"). */
  posted(reply: string): string[] {
    return [...reply.matchAll(/Posted #(\d+)/g)].map((m) => {
      const d = this.p().events[Number(m[1]) - 1]!.data;
      assert.equal(d.kind, "request");
      return d.kind === "request" ? d.request.id : "";
    });
  }

  request(id: string) {
    return this.p().requests.get(id)!;
  }

  /** The turns the host started for a member (engine runs), as opposed to T3 runs it did not start. */
  hostRuns(alias: string): number {
    return [...this.p().runs.values()].filter((r) => r.seatId === this.seat(alias)).length;
  }

  /** The output events a member authored that make a claim on the request. */
  finalsOn(alias: string, requestId: string): RoomEvent[] {
    return this.p().events.filter((e) => e.data.kind === "output" && e.data.author === this.seat(alias) && e.data.claims.some((cl) => cl.requestId === requestId));
  }
}

const kinds = (events: RoomEvent[]) => events.map((e) => e.data.kind);
const data = <K extends EventData["kind"]>(events: RoomEvent[], kind: K) => events.find((e) => e.data.kind === kind)!.data as EventData & { kind: K };

test("1. each command appends exactly the expected events, and reads append nothing", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [c, w, v] = [f.seat("c"), f.seat("w"), f.seat("v")];

  // post: one request per recipient, the whole text as its body, from the caller to each.
  let events = await f.appended(() => f.cli("c", "post", "@w build the parser"));
  assert.deepEqual(kinds(events), ["request"]);
  const a = data(events, "request");
  assert.deepEqual([a.request.owner, a.request.returnTo, a.request.parentId, a.request.body, a.recipients], [w, c, null, "@w build the parser", [w]]);
  events = await f.appended(() => f.cli("c", "post", "@w @v check the fixtures"));
  assert.deepEqual(kinds(events), ["request", "request"]);
  assert.deepEqual(events.map((e) => (e.data.kind === "request" ? e.data.request.owner : "")), [w, v]);
  const [bw, bv] = events.map((e) => (e.data.kind === "request" ? e.data.request.id : ""));

  // correct and cancel, by the requester; the owner of the cancelled request is idle, so nothing is interrupted.
  events = await f.appended(() => f.cli("c", "correct", `#${f.num(bw!)}`, "only the JSON fixtures"));
  assert.deepEqual(kinds(events), ["correction"]);
  assert.deepEqual([data(events, "correction").requestId, data(events, "correction").recipients], [bw, [w]]);
  events = await f.appended(() => f.cli("c", "cancel", `#${f.num(bv!)}`));
  assert.deepEqual(kinds(events), ["cancel"]);
  assert.deepEqual([data(events, "cancel").applied, data(events, "cancel").recipients], [true, [v]]);

  // Reads append nothing.
  for (const argv of [["index"], ["index", "--all"], ["read", String(f.num(a.request.id))], ["members"], ["state"], ["rules"], ["help"], ["crew"]]) {
    assert.deepEqual(kinds(await f.appended(() => f.cli("w", ...argv))), [], argv.join(" "));
  }

  // In w's turn (A, B and the correction). v is woken too, by the request and its cancel (the host reserves on any
  // unread input); its turn answers nothing.
  await f.tick();
  assert.ok(f.running("w"));
  f.complete("v", "nothing left to do");

  // The turn ends: its final is one output that answers A and B (the correction is in the turn), back to c.
  events = await f.appended(async () => {
    f.complete("w", "parser built, JSON fixtures checked");
    await f.tick();
  });
  const finals = events.filter((e) => e.data.kind === "output" && e.data.author === w);
  assert.equal(finals.length, 1);
  const claims = finals[0]!.data.kind === "output" ? [...finals[0]!.data.claims].sort((x, y) => x.requestId.localeCompare(y.requestId)) : [];
  assert.deepEqual(claims, [{ requestId: a.request.id, outcome: "answered", returnTo: c }, { requestId: bw!, outcome: "answered", returnTo: c }].sort((x, y) => x.requestId.localeCompare(y.requestId)));
  assert.deepEqual([f.request(a.request.id).state, f.request(bw!).state], ["answered", "answered"]);

  // cancel of the only request of a live turn: the cancel; the host sends T3 the interrupt (§6).
  const [e] = f.posted(await f.cli("c", "post", "@v profile the build"));
  await f.tick();
  assert.ok(f.running("v"));
  events = await f.appended(() => f.cli("c", "cancel", `#${f.num(e!)}`));
  assert.deepEqual(kinds(events), ["cancel"], "the host interrupts the turn through T3; the journal holds the cancel only");
  await f.tick();

  // cancel of one of two requests of a live turn (#2099): applied at once, and into the running turn, which goes on.
  const [g1] = f.posted(await f.cli("c", "post", "@w port the lexer"));
  const [g2] = f.posted(await f.cli("c", "post", "@w port the printer"));
  await f.tick();
  events = await f.appended(() => f.cli("c", "cancel", `#${f.num(g1!)}`));
  assert.deepEqual(kinds(events), ["cancel"]);
  assert.equal(f.request(g1!).state, "cancelled", "at once");
  await f.tick();
  f.complete("w", "printer ported");
  await f.tick();
  assert.deepEqual([f.request(g1!).state, f.request(g2!).state], ["cancelled", "answered"]);

  // retry: a failed turn runs again, by the Consigliere. (The first cancel above, of a turn's only request, woke its
  // owner once more with the cancel itself, as §4 says a cancel does; that turn ends first.)
  await f.quiet();
  const [h] = f.posted(await f.cli("c", "post", "@v run the benchmark"));
  await f.tick();
  f.complete("v", "the runner crashed", "error");
  await f.tick();
  const notice = f.p().events.find((x) => x.data.kind === "notice" && x.data.intent === "error" && x.data.requestIds.includes(h!))!;
  events = await f.appended(() => f.cli("c", "retry", `#${notice.seq}`));
  assert.deepEqual(kinds(events), ["retry"]);
  assert.deepEqual(data(events, "retry").recipients, [v]);
});

test("2. a member's post mid-run is refused and appends nothing; its final answers its request at once and wakes the Consigliere once, who relays the review", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  assert.ok(f.running("w"));

  // The worker cannot ask for the review itself: members only answer.
  await f.refused("w", ["post", "@v review the parser diff"], MEMBERS);

  // Its final answers A: nothing holds it open, and the Consigliere is woken with it once.
  f.complete("w", "parser done; it wants a review");
  await f.tick(2);
  assert.equal(f.request(a!).state, "answered");
  assert.deepEqual(f.finalsOn("w", a!).map((e) => (e.data.kind === "output" ? e.data.claims.map((cl) => cl.outcome) : [])), [["answered"]]);
  assert.equal(f.wakes("c"), 1, "the worker's reply wakes the Consigliere");
  assert.match(f.fake.promptOf(f.thread("c"), f.fake.runsOf(f.thread("c"))[0]!), /parser done; it wants a review/);

  // The Consigliere relays the review, in his turn: a request of his own, under nothing.
  const [r] = f.posted(await f.cli("c", "post", "@v review the parser diff"));
  assert.deepEqual([f.request(r!).parentId, f.request(r!).returnTo], [null, f.seat("c")]);
  f.complete("c", "review asked");
  await f.tick(2);
  assert.ok(f.running("v"));
  f.complete("v", "PASS");
  await f.tick(2);
  assert.equal(f.request(r!).state, "answered");
  assert.equal(f.wakes("c"), 2, "the reviewer's reply wakes the Consigliere");
  f.complete("c", "parser done and reviewed");
  await f.tick(3);
  assert.deepEqual([f.wakes("c"), f.wakes("w"), f.wakes("v")], [2, 1, 1], "each reply wakes the Consigliere exactly once; the worker is not woken again");
});

test("3. a member's own post never wakes itself: not a follow-up of its own", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  // A member cannot post at all, to itself or anyone; the Consigliere cannot post to himself.
  await f.refused("w", ["post", "@w remind me later"], MEMBERS);
  await f.refused("c", ["post", "@c remind me later"], /you cannot post to yourself/);
  const all = f.posted(await f.cli("c", "post", "@all look at the grammar"));
  assert.deepEqual(all.map((id) => f.request(id).owner).sort(), [f.seat("w"), f.seat("v")].sort(), "@all is everyone else");
  f.complete("w", "grammar rewritten");
  await f.quiet();
  // w's own continuation: a follow-up, which wakes the Consigliere, never w.
  f.fake.startSelfRun(f.thread("w"));
  await f.tick();
  f.complete("w", "parser rebuilt on the new grammar");
  await f.tick(2);
  await f.quiet();
  assert.ok(f.p().events.some((e) => e.data.kind === "progress" && e.data.author === f.seat("w") && e.data.milestone === "follow-up"), "the continuation is a follow-up");
  assert.deepEqual(f.p().events.filter((e) => "recipients" in e.data && (e.data.recipients as string[]).includes(f.seat("w")) && "author" in e.data && e.data.author === f.seat("w")), []);
  assert.equal(f.hostRuns("w"), 2, "only the Consigliere's two requests woke it");
  assert.equal(f.request(a!).state, "answered");
});

test("4. a key from another room is refused; the room comes from the key only, and nothing is appended in either journal", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const other = await f.room("billing", ["z", "w"], "z");
  // Grow room A's journal so its request numbers do not exist in room B.
  for (let i = 0; i < 6; i += 1) await f.cli("c", "post", `@w job ${i}`);
  const [a] = f.posted(await f.cli("c", "post", "@w the job in room A"));
  const n = f.num(a!);
  assert.ok(n > f.p(other).events.length);

  // z is not a member of room A: its alias with room A's key prefix is refused.
  await f.refused("z", ["index"], /is not the key of a member seated in a room/, f.key("z", f.roomId));
  // w and z of room B act in room B only: room A's #n does not exist there.
  for (const argv of [["cancel", `#${n}`], ["correct", `#${n}`, "x"], ["read", String(n)]]) {
    await f.refused("w", argv, /this room has no post/, f.key("w", other));
  }
  for (const argv of [["cancel", `#${n}`], ["correct", `#${n}`, "x"], ["retry", `#${n}`]]) {
    await f.refused("z", argv, /this room has no post/, f.key("z", other));
  }
  // A forged key, a retired member's key, and a member with no seat in the journal.
  await f.refused("c", ["index"], /is not the key of a member/, "c.00000000");
  await f.refused("c", ["index"], /pass --as/, "");
  await f.run({ type: "participant.retire", participantId: f.members.get(f.roomId)!.get("v")! });
  await f.refused("v", ["index"], /is not the key of a member seated in a room/);
  const unseated = await f.room("drafts", ["u"], null, false);
  await f.refused("u", ["index"], /@u has no seat on this room's board/, f.key("u", unseated));
});

test("5. index numbering is stable across restart and rebuild, and matches the numbers briefings print", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  f.complete("w", "built; it wants a review");
  await f.tick(2);
  const [r] = f.posted(await f.cli("c", "post", "@v review the parser"));
  await f.quiet();
  assert.equal(f.request(r!).state, "answered");

  const snapshot = async () => [await f.cli("c", "index"), await f.cli("c", "index", "--all"), await f.cli("c", "read", String(f.num(a!)), String(f.num(r!)))];
  const before = await snapshot();
  assert.match(before[0]!, new RegExp(`#${f.num(a!)}  request  @c → @w · answered by #\\d+`));
  assert.match(before[0]!, new RegExp(`#${f.num(r!)}  request  @c → @v · answered by #\\d+`));
  // Briefings number posts the same way (L2's journalDirectory, as the host renders them).
  const directory = journalDirectory(f.p().events, { alias: () => null });
  assert.equal(directory.requestNumber(a!), f.num(a!));
  assert.match(f.fake.promptOf(f.thread("w"), f.fake.runsOf(f.thread("w"))[0]!), new RegExp(`#${f.num(a!)}\\b`));

  f.restart();
  assert.deepEqual(await snapshot(), before, "after a restart");
  f.restart(() => {
    const store = new EngineStore(join(f.dir, "board.sqlite"));
    store.rebuild(f.roomId);
    assert.equal(store.audit(f.roomId).ok, true);
    store.close();
  });
  assert.deepEqual(await snapshot(), before, "after a rebuild");
  // The numbers still name the same requests.
  await f.refused("c", ["cancel", `#${f.num(a!)}`], new RegExp(`#${f.num(a!)} is already answered`));
  // A record's number is not a post.
  const record = f.p().events.find((e) => e.data.kind === "run.phase")!;
  await f.refused("c", ["read", String(record.seq)], /this room has no post/);
});

test("6. a member's own continuation is a follow-up on the request its answer closed: it wakes the Consigliere only, with the member's T3 status, and the index lists it as one", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w run the long suite in the background"));
  await f.tick();
  f.fake.background(f.thread("w"), ["suite"]);
  f.complete("w", "suite started");
  await f.tick(2);
  // The final answers A at once; its status line says what T3 still runs.
  assert.equal(f.request(a!).state, "answered");
  const [answer] = f.finalsOn("w", a!);
  assert.equal(answer!.data.kind === "output" && answer!.data.body, '[T3 status of @w: still running: background task "background suite"]\n\nsuite started');
  assert.equal(f.wakes("c"), 1);
  f.complete("c", "ok");
  await f.tick(2);

  // The suite ends and w goes on by itself: its reply is a follow-up on A, to the Consigliere.
  f.fake.background(f.thread("w"), []);
  f.fake.startSelfRun(f.thread("w"));
  await f.tick();
  f.complete("w", "the suite passed");
  await f.tick(2);
  const up = f.p().events.find((e) => e.data.kind === "progress" && e.data.milestone === "follow-up")!;
  assert.ok(up, "a follow-up post");
  assert.equal(up.data.kind === "progress" && up.data.body, "[T3 status of @w: idle]\n\nthe suite passed");
  assert.deepEqual(up.data.kind === "progress" && [up.data.requestIds, up.data.recipients], [[a], [f.seat("c")]]);
  assert.equal(f.wakes("c"), 2, "the follow-up wakes the Consigliere");
  assert.match(f.fake.promptOf(f.thread("c"), f.fake.runsOf(f.thread("c"))[1]!), /the suite passed/);
  f.complete("c", "good");
  await f.tick(3);
  assert.deepEqual([f.wakes("c"), f.wakes("v"), f.hostRuns("w")], [2, 0, 1], "once; nobody else; the continuation is no host turn");

  // The board shows it as a follow-up on A, by number, with the member named by alias.
  const index = await f.cli("c", "index");
  assert.match(index, new RegExp(`#${up.seq}  follow-up  @w → @c · on #${f.num(a!)} · `));
  const shown = await f.cli("v", "read", String(up.seq));
  assert.match(shown, new RegExp(`^\\[#${up.seq} follow-up · @w → @c · on #${f.num(a!)}\\]\n\\[T3 status of @w: idle\\]\n\nthe suite passed$`));
});

test("7. a post over 1 MiB (UTF-8 bytes) is refused on every text-bearing command; exactly 1 MiB is accepted", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const exact = `@w ${"x".repeat(MiB - 3)}`;
  assert.equal(Buffer.byteLength(exact), MiB);
  assert.deepEqual(kinds(await f.appended(() => f.cli("c", "post", exact))), ["request"]);
  const over = `${exact}x`;
  await f.refused("c", ["post", over], /1,048,577 bytes; the board takes at most 1 MiB/);
  // Bytes, not characters: 524,289 two-byte characters.
  await f.refused("c", ["post", `@w ${"é".repeat(MiB / 2)}`], /1,048,579 bytes/);
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  const big = "y".repeat(MiB + 1);
  await f.refused("c", ["correct", `#${f.num(a!)}`, big], /at most 1 MiB/);
  await f.refused("c", ["state", big], /at most 1 MiB/);
  await f.tick();
  f.complete("w", "failed", "error");
  await f.tick();
  await f.refused("c", ["retry", `#${f.num(a!)}`, big], /at most 1 MiB/);
});

test("H5: a member's post is refused with a plain sentence and appends nothing; answer, working, follow and note (N1) are gone, refused with a sentence; the Consigliere's post goes under nothing, in a turn too", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [c, w] = [f.seat("c"), f.seat("w")];
  // The user asks the Consigliere; in his turn, his post is a request of his own, under nothing.
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:plan", to: c, body: "get the parser built" });
  await f.tick();
  assert.ok(f.running("c"));
  const events = await f.appended(() => f.cli("c", "post", "@w build the parser"));
  assert.deepEqual(kinds(events), ["request"]);
  const q = data(events, "request").request;
  assert.deepEqual([q.owner, q.returnTo, q.parentId], [w, c, null]);
  await f.tick();
  assert.ok(f.running("w"));

  // Members post nothing: in a turn (w) or not (v), to anyone, with --for or without; say is post.
  for (const alias of ["w", "v"]) {
    for (const argv of [["post", "@v review the parser"], ["say", "@c parser done"], ["post", "@all look at this"], ["post", "--for", `#${f.num(q.id)}`, "@v review it"]]) {
      const refusal = await f.refused(alias, argv, MEMBERS);
      assert.equal(refusal.status, 403);
    }
  }
  // answer, working, follow and note are gone, for everyone: each is refused with why.
  const gone: Array<[string, RegExp]> = [
    ["answer", exactly("rooms-board: your final reply is your answer; there is nothing to run.")],
    ["working", exactly("rooms-board: there is no working mark: your final reply is your answer, and the Consigliere reads your T3 status (what still runs in the background) at the top of it.")],
    ["follow", exactly("rooms-board: nobody follows requests: every reply of a member, and each follow-up of it, wakes the Consigliere.")],
    ["note", exactly("rooms-board: notes are gone: say it in your final reply.")],
  ];
  for (const alias of ["w", "c"]) {
    for (const [command, sentence] of gone) {
      for (const argv of [[command], [command, `#${f.num(q.id)}`, "parser done"]]) {
        const refusal = await f.refused(alias, argv, sentence);
        assert.equal(refusal.status, 410);
      }
    }
  }
  // help lists none of them, and no refusal points a member to a note.
  const help = await f.cli("w", "help");
  assert.doesNotMatch(help, /^\s+(answer|working|follow|note)\b/m);
  for (const [alias, argv] of [["c", ["post", "look at this"]], ["c", ["post", "@c remind me later"]]] as const) {
    assert.doesNotMatch((await f.refused(alias, [...argv], /rooms-board: /)).message, /note/);
  }
  assert.doesNotMatch(help, /--for/);
  assert.match(help, /^ {2}post "@name the job"/m);

  // The worker's final is its answer.
  f.complete("w", "parser built");
  await f.tick();
  assert.equal(f.request(q.id).state, "answered");
});

test("M1: rooms-board post and correct to a working member go into its running turn, the reply says so, and its one final answers both with the correction seen", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  const reply = await f.cli("c", "correct", `#${f.num(a!)}`, "use the new grammar");
  assert.match(reply, new RegExp(`to #${f.num(a!)} → @w: it goes into @w's running turn, or into its next one when that turn takes nothing \\(one typed in T3, a keep-alive's, one on Backroom's own request, one being stopped\\), and its answer to #${f.num(a!)} takes it into account\\.`));
  assert.doesNotMatch(reply, /next turn/);
  const [b] = f.posted(await f.cli("c", "post", "@w and the printer"));
  await f.tick();
  const t3 = f.fake.thread(f.thread("w"));
  assert.equal(t3.runs.length, 1, "no turn of its own");
  const went = t3.turnItems.flatMap((i) => (i.type === "user_message" && i.inputIntent === "steer" ? [i.text] : []));
  assert.equal(went.length, 1);
  assert.match(went[0]!, /use the new grammar[\s\S]*and the printer/);
  f.complete("w", "parser done with the new grammar, and the printer");
  await f.tick();
  assert.deepEqual(f.finalsOn("w", a!).map((e) => (e.data.kind === "output" ? e.data.claims.map((cl) => [cl.requestId, cl.outcome]) : [])), [[[a, "answered"], [b, "answered"]]]);
  assert.match(await f.cli("c", "help"), /correct #n "<text>"\s+corrects your request #n: it goes into its owner's running turn, or the next one\./);
});

test("a correction that lands as the turn ends, too late to go in, supersedes its final: the request stays open and the next turn answers it", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  // The correction lands as the turn ends, with no tick between: w has not read it, so its final is superseded.
  const correction = await f.appended(() => f.cli("c", "correct", `#${f.num(a!)}`, "use the new grammar"));
  assert.deepEqual(kinds(correction), ["correction"]);
  f.complete("w", "parser done");
  await f.tick();
  const [first] = f.finalsOn("w", a!);
  assert.deepEqual(first!.data.kind === "output" && first!.data.claims.map((cl) => cl.outcome), ["superseded"]);
  assert.equal(f.request(a!).state, "open");
  assert.match(await f.cli("c", "index"), new RegExp(`#${first!.seq}  answer  @w → @c · #${f.num(a!)} still open \\(superseded\\)`));
  await f.tick();
  assert.ok(f.running("w"), "the next turn brings the correction");
  assert.match(f.fake.promptOf(f.thread("w"), f.fake.runsOf(f.thread("w")).at(-1)!), /use the new grammar/);
  f.complete("w", "parser done with the new grammar");
  await f.tick();
  assert.equal(f.request(a!).state, "answered");
  assert.deepEqual(f.finalsOn("w", a!).map((e) => (e.data.kind === "output" ? e.data.claims.map((cl) => cl.outcome) : [])), [["superseded"], ["answered"]]);
  // A number with no text is not taken for the text.
  await f.refused("c", ["correct", `#${f.num(a!)}`], /looks like a post number with no text after it/);
  // A closed request is not corrected: post a new one.
  await f.refused("c", ["correct", `#${f.num(a!)}`, "and the printer"], new RegExp(`#${f.num(a!)} is answered; a closed request is not corrected`));
  // Two identical posts are two requests.
  const twice = [...f.posted(await f.cli("c", "post", "@v re-review please")), ...f.posted(await f.cli("c", "post", "@v re-review please"))];
  assert.equal(new Set(twice).size, 2);
});

test("the host's texts reach members with board numbers, never request IDs", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  const [b] = f.posted(await f.cli("c", "post", "@w build the printer"));
  await f.tick();
  const refusal = await f.refused("w", ["post", "@v review it"], MEMBERS);
  assert.doesNotMatch(refusal.message, /#board:|@[0-9a-f]{8}-/);
  // The reply to a cancel of one of the turn's two requests names the request and its owner: #n and @alias (#2099).
  const shown = await f.cli("c", "cancel", `#${f.num(a!)}`);
  assert.match(shown, new RegExp(`#${f.num(a!)} is cancelled\\. @w is told in its running turn, which goes on with its other work\\.`));
  assert.doesNotMatch(shown, /#board:|@[0-9a-f]{8}-/);
  // A post that is not a request names the request it is about: Backroom's note of a reseat called off, say.
  const note = await f.appended(async () => f.stack.engine!.note(f.roomId, { actor: "$user", id: "reseat-called-off", body: "lexer first", requestIds: [b!] }));
  await f.refused("c", ["correct", `#${note[0]!.seq}`, "printer first"], new RegExp(`#${note[0]!.seq} is a note on #${f.num(b!)}, not a request: name #${f.num(b!)}`));
  // The member's answer: its status line names it by alias.
  f.complete("w", "printer built");
  await f.tick();
  assert.deepEqual([f.request(a!).state, f.request(b!).state], ["cancelled", "answered"]);
  const answer = f.finalsOn("w", b!)[0]!;
  const read = await f.cli("c", "read", String(answer.seq));
  assert.match(read, /^\[#\d+ answer · @w → @c · #\d+ answered\]\n\[T3 status of @w: idle\]\n\nprinter built$/);
  assert.doesNotMatch(read, /#board:|@[0-9a-f]{8}-/);
  // An unknown or unseated recipient is refused before anything is written, even with a valid one first.
  await f.refused("c", ["post", "@v @nobody look"], /nobody called @nobody can take work in this room/);
  await f.refused("c", ["post", "look at this"], /start with @name/);
  await f.refused("c", ["post", "@w /compact"], /is a slash command/);
});

test("cancel and correct are the requester's only: nobody else can close or change work someone else waits on", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  // The Consigliere's request: another member did not ask it.
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  await f.refused("v", ["cancel", `#${f.num(a!)}`], /only @c, who asked #\d+, can cancel it; ask @c\./);
  await f.refused("v", ["correct", `#${f.num(a!)}`, "skip the tests"], /only @c, who asked #\d+, can correct it/);
  // The user's requests, to a member and to the Consigliere: only the user withdraws or changes them.
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:docs", to: f.seat("w"), body: "write the docs" });
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:plan", to: f.seat("c"), body: "plan the release" });
  for (const id of ["user:docs", "user:plan"]) {
    await f.refused("c", ["cancel", `#${f.num(id)}`], /only the user, who asked #\d+, can cancel it\.$/);
    await f.refused("c", ["correct", `#${f.num(id)}`, "never mind"], /only the user, who asked #\d+, can correct it\.$/);
  }
  // The requester's own cancel is unchanged: the Consigliere withdraws his request.
  assert.deepEqual(kinds(await f.appended(() => f.cli("c", "cancel", `#${f.num(a!)}`))).slice(0, 1), ["cancel"]);
  assert.deepEqual([f.request(a!).state, f.request("user:docs").state, f.request("user:plan").state], ["cancelled", "open", "open"]);
});

test("no text a member reads names the user as someone to post to", async (t) => {
  const f = await Fixture.create({ orchestrator: null });
  t.after(() => f.close());
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:job", to: f.seat("w"), body: "do the thing" });
  const refusal = await f.refused("w", ["post", "@v help me with it"], MEMBERS);
  assert.doesNotMatch(refusal.message, /\$user/);
  // The user's request and the member's answer to it name "the user".
  await f.tick();
  f.complete("w", "done");
  await f.tick();
  const read = await f.cli("w", "read", String(f.num("user:job")));
  assert.match(read, /^\[#\d+ request · the user → @w · answered by #\d+\]/);
  const index = await f.cli("v", "index");
  assert.match(index, /answer {2}@w → the user · #\d+ answered/);
  for (const text of [read, index]) assert.doesNotMatch(text, /\$user/);
});

test("H6 keepalive: anyone prints the setting; the Consigliere turns it on or off by member and sets the room's interval under the hour; the host reads it", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const of = (alias: string) => f.stack.engine!.keepAliveFor(f.roomId, f.seat(alias));
  assert.deepEqual([of("c"), of("w")], [{ intervalMs: 55 * 60_000, on: true, chosen: false }, { intervalMs: 55 * 60_000, on: false, chosen: false }]);
  const shown = await f.cli("w", "keepalive");
  assert.match(shown, /nothing has woken for 55 minutes gets a keep-alive post/);
  assert.match(shown, /\nInterval: 55 minutes \(Backroom's default\)\.\nOn for: @c \(the Consigliere's default\)\.\nOff for: @w \(members' default\), @v \(members' default\)\.\nWork that never ends \(a dev server left running\) keeps a seat warm without end/);

  // Members only read it; the Consigliere sets it, and nothing goes on the journal.
  await f.refused("w", ["keepalive", "@w", "on"], exactly("rooms-board: only this room's Consigliere (@c) sets keep-alives."));
  const heads = f.heads();
  assert.match(await f.cli("c", "keepalive", "@w", "on"), /\nOn for: @c \(the Consigliere's default\), @w \(turned on\)\.\nOff for: @v \(members' default\)\.\n/);
  assert.match(await f.cli("c", "keepalive", "every", "10"), /\nInterval: 10 minutes \(this room's own\)\./);
  assert.match(await f.cli("c", "keepalive", "@c", "off"), /\nOn for: @w \(turned on\)\.\nOff for: @c \(turned off\), @v \(members' default\)\.\n/);
  assert.deepEqual(f.heads(), heads, "the setting is not on the board");
  assert.deepEqual([of("c"), of("w"), of("v")], [{ intervalMs: 600_000, on: false, chosen: true }, { intervalMs: 600_000, on: true, chosen: true }, { intervalMs: 600_000, on: false, chosen: false }]);

  // Refusals: an interval at or over the cache's hour, an unknown member, a word that is not on or off.
  await f.refused("c", ["keepalive", "every", "60"], /takes 1 to 59 minutes, under the prompt cache's hour, or "default"/);
  await f.refused("c", ["keepalive", "every", "0"], /takes 1 to 59 minutes/);
  await f.refused("c", ["keepalive", "@nobody", "on"], /nobody called @nobody is seated in this room/);
  await f.refused("c", ["keepalive", "@w", "maybe"], /keepalive takes nothing \(it prints the setting\), "@name on", "@name off" or "every <minutes>"/);

  // It is the room's, kept across a restart; "default" goes back to ROOMS_KEEPALIVE_MS's.
  f.restart();
  assert.equal(of("w").on, true);
  assert.match(await f.cli("c", "keepalive", "every", "default"), /\nInterval: 55 minutes \(Backroom's default\)\./);
  assert.equal(of("w").intervalMs, 55 * 60_000);
});

test("H6 keepalive: ROOMS_KEEPALIVE_MS, as the server passes it, is the interval of rooms that set none; 0 is off until a room sets one", async (t) => {
  const f = await Fixture.create({ keepAliveMs: 0 });
  t.after(() => f.close());
  const host = f.stack.engine!;
  assert.deepEqual(host.keepAliveFor(f.roomId, f.seat("c")), { intervalMs: 0, on: false, chosen: false });
  assert.match(await f.cli("c", "keepalive"), /^Keep-alives are off in this room: Backroom runs with ROOMS_KEEPALIVE_MS=0/);
  await f.cli("c", "keepalive", "every", "30");
  assert.deepEqual(host.keepAliveFor(f.roomId, f.seat("c")), { intervalMs: 30 * 60_000, on: true, chosen: false });
});

test("retry: the Consigliere's, once per failed turn, and never for a turn whose requests are all closed", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w run the benchmark"));
  await f.tick();
  f.complete("w", "out of memory", "error");
  await f.tick();
  await f.refused("v", ["retry", `#${f.num(a!)}`], /only this room's Consigliere \(@c\) retries a failed turn/);
  const reply = await f.cli("c", "retry", `#${f.num(a!)}`);
  assert.match(reply, new RegExp(`Retry #\\d+ → @w: the turn that failed on #${f.num(a!)}`));
  await f.refused("c", ["retry", `#${f.num(a!)}`], /was already retried as #\d+/);
  await f.tick();
  assert.equal(f.wakes("w"), 2);
  f.complete("w", "out of memory again", "error");
  await f.tick();
  // The second failure is cancelled by the Consigliere: nothing left to redo.
  await f.cli("c", "cancel", `#${f.num(a!)}`);
  const notices = f.p().events.filter((e) => e.data.kind === "notice" && e.data.intent === "error");
  await f.refused("c", ["retry", `#${notices.at(-1)!.seq}`], /nothing to redo/);
  await f.refused("c", ["retry", `#${f.num(a!)}`], /nothing to redo/);
});

test("seat, reseat and retire run the room commands L4b routes to the journal, the Consigliere's only; a board without the seat lifecycle refuses them", async (t) => {
  const commands: Array<Record<string, unknown>> = [];
  let checkpoint = "";
  const f = await Fixture.create({
    lifecycle: {
      seats: { reseats: () => (checkpoint ? [{ participantId: f.members.get(f.roomId)!.get("w")!, seatId: f.seat("w"), requestId: checkpoint, stage: "checkpoint" }] : []) },
      async execute(command) {
        commands.push({ ...command });
        if (command.type === "participant.fromPreset") return { alias: "opus", threadId: "thread-new" };
        if (command.type === "participant.reseat") {
          checkpoint = f.posted(await f.cli("c", "post", "@w write your checkpoint"))[0]!;
          return { requestId: checkpoint, eventId: checkpoint };
        }
        if (command.type === "participant.retire") return { thread: { action: "keep", result: "kept" } };
        throw new Error(`unexpected ${command.type}`);
      },
    },
  });
  t.after(() => f.close());
  await f.run({ type: "preset.create", name: "opus", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } });
  await f.refused("w", ["seat", "opus"], /only this room's Consigliere \(@c\) seats members/);
  await f.refused("w", ["reseat", "v"], /only this room's Consigliere \(@c\) reseats members/);
  await f.refused("w", ["retire", "v"], /only this room's Consigliere \(@c\) retires members/);
  await f.refused("c", ["retire", "c"], /cannot retire yourself/);
  await f.refused("c", ["retire", "nobody"], /nobody called @nobody is seated/);
  assert.equal(commands.length, 0);
  assert.match(await f.cli("c", "seat", "opus"), /^Seated @opus \(claude-opus-5-5\) · thread thread-new/);
  assert.match(await f.cli("c", "reseat", "w", "carry on with item 4"), new RegExp(`Asked @w for its checkpoint: #${f.num(checkpoint)}\\.`));
  assert.match(await f.cli("c", "members"), new RegExp(`@w · claude-opus-5-5 · .*being reseated \\(checkpoint #${f.num(checkpoint)}\\)`));
  assert.match(await f.cli("c", "retire", "v"), /@v has left the room\. Its thread stays in T3\./);
  const ids = f.members.get(f.roomId)!;
  assert.deepEqual(commands, [
    { type: "participant.fromPreset", roomId: f.roomId, presetId: f.stack.repos.findPresetByName("opus")!.id },
    { type: "participant.reseat", participantId: ids.get("w"), by: ids.get("c"), plan: "carry on with item 4" },
    { type: "participant.retire", participantId: ids.get("v"), thread: "keep" },
  ]);

  // A board built without the seat lifecycle sends no room command: it refuses all three.
  const bare = await Fixture.create({ lifecycle: { execute: async () => assert.fail("no room command without the seat lifecycle") } });
  t.after(() => bare.close());
  await bare.run({ type: "preset.create", name: "sonnet", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } });
  await bare.refused("c", ["seat", "sonnet"], /no seat lifecycle/);
  await bare.refused("c", ["reseat", "w"], /no seat lifecycle/);
  await bare.refused("c", ["retire", "v"], /no seat lifecycle/);
});

test("the route hook: /api/board-tools is the journal's board; refusals are 4xx with the sentence", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const app = createHttpApp(f.stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: f.dir, ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "secret", command: "rooms-browser" });
  const call = (alias: string, argv: string[]) =>
    app.request("/api/board-tools", { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ argv, as: f.key(alias) }) });
  const posted = await call("c", ["post", "@w build the parser"]);
  assert.equal(posted.status, 200);
  assert.match(((await posted.json()) as { text: string }).text, /^Posted #\d+ → @w\./);
  assert.equal(f.p().requests.size, 1);
  const refused = await call("c", ["post", "@c talk to myself"]);
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { message: string }).message, /you cannot post to yourself/);
  // A member's post: 403 with the plain sentence; a command that is gone: 410 with why. Nothing is written.
  const member = await call("w", ["post", "@v review it"]);
  assert.equal(member.status, 403);
  assert.match(((await member.json()) as { message: string }).message, MEMBERS);
  const gone = await call("w", ["answer", "parser done"]);
  assert.equal(gone.status, 410);
  assert.match(((await gone.json()) as { message: string }).message, /^rooms-board: your final reply is your answer; there is nothing to run\.$/);
  assert.equal(f.p().requests.size, 1);
});

test("the CLI: --file and stdin carry a text past the shell's argument limit; over 1 MiB it exits 1", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const app = createHttpApp(f.stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: f.dir, ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "secret", command: "rooms-browser" });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const api = join(f.dir, "browser-api.json");
  writeFileSync(api, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "secret" }));
  const cli = (argv: string[], stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [join(REPO, "bin", "rooms-board.mjs"), "--api", api, "--as", f.key("c"), ...argv], { maxBuffer: 8 * MiB }, (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
      child.stdin!.end(stdin ?? "");
    });

  const big = join(f.dir, "big.txt");
  writeFileSync(big, `@w ${"x".repeat(200 * 1024)}`);
  const fromFile = await cli(["post", "--file", big]);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.match(fromFile.stdout, /^Posted #\d+ → @w\./);
  const exact = await cli(["post", "--file", "-"], `@w ${"x".repeat(MiB - 3)}`);
  assert.equal(exact.code, 0, exact.stderr);
  const before = f.p().events.length;
  writeFileSync(big, `@w ${"x".repeat(MiB - 2)}`);
  const over = await cli(["post", "--file", big]);
  assert.equal(over.code, 1);
  assert.match(over.stderr, /1,048,577 bytes; the board takes at most 1 MiB/);
  assert.equal(f.p().events.length, before);
});
