/**
 * rooms-board on the engine (stage 4/5 plan, item L3): the member CLI over the journal. A room of three seats (c, the
 * Consigliere; w, a worker; v, a reviewer) on the engine host and the T3 fake, seated in the journal. Wakes are counted
 * as T3 runs on each fake thread, as tests/runtime does. Gate bullets, in the plan's order:
 *   1. each command appends exactly the expected events;
 *   2. a review posted mid-run is a child of the run's request, and the worker's final stays pending until it is answered;
 *   3. a member's own post never wakes itself;
 *   4. a key from another room is refused;
 *   5. index numbering is stable across restart and rebuild;
 *   6. follow makes working posts wake the follower;
 *   7. a 1 MiB + 1 B post is refused.
 * Then: answer prints the engine's outcome, retry and post --for refusals, board numbers in the host's texts, the seat
 * stub, the route hook, and the CLI's --file.
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
import { createHttpApp } from "../src/server/http.ts";
import { RuntimeFake } from "./runtime/helpers.ts";

const MiB = MAX_POST_BYTES;
const REPO = join(import.meta.dirname, "..");

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

  private constructor(lifecycle: Pick<BoardEngineDeps, "execute" | "seats"> = {}) {
    this.lifecycle = lifecycle;
    this.stack = this.make();
    this.board = this.makeBoard();
  }

  static async create(options: { aliases?: string[]; orchestrator?: string | null; lifecycle?: Pick<BoardEngineDeps, "execute" | "seats"> } = {}): Promise<Fixture> {
    const f = new Fixture(options.lifecycle);
    f.roomId = await f.room("payments", options.aliases ?? ["c", "w", "v"], options.orchestrator === undefined ? "c" : options.orchestrator);
    return f;
  }

  private make(): AppStack {
    return createStack({ dbPath: join(this.dir, "rooms.sqlite"), adapter: this.fake, briefingBudgetChars: 60_000, engine: true, latestRelease: async () => null });
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
      const { participantId } = (await this.run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string };
      ids.set(alias, participantId);
      if (!journal) continue;
      const binding = this.stack.repos.currentBinding(participantId)!;
      this.stack.engine!.seat(roomId, { actor: "$user", id: `seat:${alias}`, seatId: binding.id, threadId: binding.threadId, orchestrator: alias === orchestrator });
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

  // follow and follow --off: one subscription event each.
  events = await f.appended(() => f.cli("c", "follow", `#${f.num(a.request.id)}`));
  assert.deepEqual(kinds(events), ["subscription"]);
  assert.deepEqual([data(events, "subscription").enabled, data(events, "subscription").subscription], [true, { seatId: c, requestId: a.request.id, milestones: ["working"] }]);
  events = await f.appended(() => f.cli("c", "follow", `${f.num(a.request.id)}`, "--off"));
  assert.deepEqual([kinds(events), data(events, "subscription").enabled], [["subscription"], false]);

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

  // In w's turn (A, B and the correction): working marks A and holds it with a work: activity. v is woken too, by the
  // request and its cancel (the host reserves on any unread input); its turn answers nothing.
  await f.tick();
  assert.ok(f.running("w"));
  f.complete("v", "nothing left to do");
  events = await f.appended(() => f.cli("w", "working", `#${f.num(a.request.id)}`, "running the long suite"));
  assert.deepEqual(kinds(events), ["activity.started", "progress"]);
  assert.deepEqual([data(events, "activity.started").activity.requestIds, data(events, "progress").milestone, data(events, "progress").requestIds], [[a.request.id], "working", [a.request.id]]);

  // note: under the requests this turn works on; it addresses nobody.
  events = await f.appended(() => f.cli("w", "note", "halfway through the fixtures"));
  assert.deepEqual(kinds(events), ["note"]);
  assert.deepEqual([[...data(events, "note").requestIds].sort(), data(events, "note").recipients], [[a.request.id, bw!].sort(), []]);

  // answer #B in the turn: one output that answers B.
  events = await f.appended(() => f.cli("w", "answer", `#${f.num(bw!)}`, "fixtures checked"));
  assert.deepEqual(kinds(events), ["output"]);
  assert.deepEqual(data(events, "output").claims, [{ requestId: bw, outcome: "answered", returnTo: c }]);

  // The turn ends; its final answers nothing (B is answered, A is held), then answer #A between turns settles the
  // work: activity and answers A.
  f.complete("w", "still on the parser");
  await f.tick();
  assert.equal(f.request(a.request.id).state, "open");
  events = await f.appended(() => f.cli("w", "answer", `#${f.num(a.request.id)}`, "parser done"));
  assert.deepEqual(kinds(events), ["activity.status", "output"]);
  assert.deepEqual([data(events, "activity.status").status, data(events, "output").claims], ["done", [{ requestId: a.request.id, outcome: "answered", returnTo: c }]]);

  // cancel of the only request of a live turn: the cancel, the core's interrupt control, and the host marks it obsolete
  // once the interrupt is sent (§6).
  const [e] = f.posted(await f.cli("c", "post", "@v profile the build"));
  await f.tick();
  assert.ok(f.running("v"));
  events = await f.appended(() => f.cli("c", "cancel", `#${f.num(e!)}`));
  assert.deepEqual(kinds(events), ["cancel", "control.prepared", "control.phase"]);
  await f.tick();

  // cancel of one of two requests of a live turn: a visible note; it applies when the turn ends.
  const [g1] = f.posted(await f.cli("c", "post", "@w port the lexer"));
  const [g2] = f.posted(await f.cli("c", "post", "@w port the printer"));
  await f.tick();
  events = await f.appended(() => f.cli("c", "cancel", `#${f.num(g1!)}`));
  assert.deepEqual(kinds(events), ["note"]);
  assert.match(await f.cli("c", "read", String(events[0]!.seq)), new RegExp(`Cancel of #${f.num(g1!)} requested`));
  f.complete("w", "printer ported");
  await f.tick();
  assert.deepEqual([f.request(g1!).state, f.request(g2!).state], ["cancelled", "answered"]);

  // retry: a failed turn runs again, by the Consigliere. (The cancels above woke their owners once more with the
  // cancel itself, as §4 says a cancel does; those turns end first.)
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

test("2. a review posted mid-run is a child of the run's request; the worker's final stays pending until it is answered, then the Consigliere is woken once", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  assert.ok(f.running("w"));

  const reply = await f.cli("w", "post", "@v review the parser diff");
  const [r] = f.posted(reply);
  assert.equal(f.request(r!).parentId, a, "the review is a child of the turn's request");
  assert.match(reply, new RegExp(`under your #${f.num(a!)}`));
  assert.match(reply, new RegExp(`#${f.num(a!)} stays open while #${f.num(r!)} is open`));

  // An explicit answer while the review is open: the engine says pending_activity, and the CLI says so.
  const early = await f.cli("w", "answer", "parser done, review asked");
  assert.match(early, new RegExp(`#${f.num(a!)}: NOT answered; it stays open while #${f.num(r!)} to @v is open`));
  assert.doesNotMatch(early, /: answered/);

  f.complete("w", "parser done, waiting for the review");
  await f.tick();
  const finals = f.p().events.filter((e) => e.data.kind === "output" && e.data.claims.some((cl) => cl.requestId === a));
  assert.deepEqual(finals.map((e) => (e.data.kind === "output" ? e.data.claims[0]!.outcome : "")), ["pending_activity", "pending_activity"]);
  assert.equal(f.request(a!).state, "open");
  assert.equal(f.wakes("c"), 0, "the Consigliere sleeps while the exchange is open");

  // The reviewer answers; the worker is woken with it; its final then answers A, and the Consigliere is woken once.
  await f.tick();
  assert.ok(f.running("v"));
  f.complete("v", "PASS");
  await f.tick();
  assert.equal(f.request(r!).state, "answered");
  assert.equal(f.wakes("w"), 2);
  assert.equal(f.wakes("c"), 0);
  f.complete("w", "parser done and reviewed");
  await f.tick(2);
  assert.equal(f.request(a!).state, "answered");
  assert.equal(f.wakes("c"), 1);
  f.complete("c", "noted");
  await f.tick(3);
  assert.equal(f.wakes("c"), 1, "exactly once");
  assert.deepEqual([f.wakes("w"), f.wakes("v")], [2, 1]);
});

test("3. a member's own post never wakes itself: not a post, note, working, answer or follow of its own", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  await f.refused("w", ["post", "@w remind me later"], /you cannot post to yourself/);
  await f.refused("w", ["follow", `#${f.num(a!)}`], /is yours; your own working posts never wake you/);
  const all = f.posted(await f.cli("w", "post", "@all look at the grammar"));
  assert.deepEqual(all.map((id) => f.request(id).owner).sort(), [f.seat("c"), f.seat("v")].sort(), "@all is everyone else");
  await f.cli("w", "note", "the grammar is ambiguous");
  await f.cli("w", "working", "rewriting the grammar");
  // Even a subscription to its own request (the engine allows one) does not address its own working posts to it.
  f.stack.engine!.follow(f.roomId, { actor: f.seat("w"), id: "self-follow", requestId: a!, enabled: true });
  const mark = await f.appended(() => f.cli("w", "working", `#${f.num(a!)}`, "still rewriting"));
  assert.deepEqual(data(mark, "progress").recipients, []);
  f.complete("w", "grammar rewritten");
  await f.tick(3);
  assert.deepEqual(f.p().events.filter((e) => "recipients" in e.data && (e.data.recipients as string[]).includes(f.seat("w")) && "author" in e.data && e.data.author === f.seat("w")), []);
  assert.equal(f.wakes("w"), 1, "only the Consigliere's request woke it");
  await f.cli("w", "answer", `#${f.num(a!)}`, "parser done");
  await f.tick(3);
  assert.equal(f.wakes("w"), 1);
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
  // w of room B acts in room B only: room A's #n does not exist there.
  for (const argv of [["cancel", `#${n}`], ["answer", `#${n}`, "done"], ["correct", `#${n}`, "x"], ["follow", `#${n}`], ["read", String(n)], ["post", "--for", `#${n}`, "@z help"]]) {
    await f.refused("w", argv, /this room has no post/, f.key("w", other));
  }
  // A forged key, a retired member's key, and a member with no seat in the journal.
  await f.refused("c", ["index"], /is not the key of a member/, "c.00000000");
  await f.refused("c", ["index"], /pass --as/, "");
  await f.run({ type: "participant.retire", participantId: f.members.get(f.roomId)!.get("v")!, pendingTasks: "cancel" });
  await f.refused("v", ["index"], /is not the key of a member seated in a room/);
  const unseated = await f.room("drafts", ["u"], null, false);
  await f.refused("u", ["index"], /@u has no seat on this room's board/, f.key("u", unseated));
});

test("5. index numbering is stable across restart and rebuild, and matches the numbers briefings print", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  const [r] = f.posted(await f.cli("w", "post", "@v review the parser"));
  await f.cli("w", "note", "fixtures pending");
  f.complete("w", "built; review asked");
  await f.tick(2);
  f.complete("v", "PASS with one nit");
  await f.tick(2);

  const snapshot = async () => [await f.cli("c", "index"), await f.cli("c", "index", "--all"), await f.cli("c", "read", String(f.num(a!)), String(f.num(r!)))];
  const before = await snapshot();
  assert.match(before[0]!, new RegExp(`#${f.num(a!)}  request  @c → @w`));
  assert.match(before[0]!, new RegExp(`#${f.num(r!)}  request  @w → @v · under #${f.num(a!)} · answered by #\\d+`));
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
  assert.match(await f.cli("w", "answer", `#${f.num(a!)}`, "parser done after review"), new RegExp(`#${f.num(a!)}: answered`));
  // A record's number is not a post.
  const record = f.p().events.find((e) => e.data.kind === "run.phase")!;
  await f.refused("c", ["read", String(record.seq)], /this room has no post/);
});

test("6. follow makes working posts wake the follower, several in one run; --off stops it; others are not woken", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  await f.cli("c", "follow", `#${f.num(a!)}`);
  const first = await f.cli("w", "working", "running the long suite");
  assert.match(first, /It wakes @c, who follows it\./);
  await f.cli("w", "working", `#${f.num(a!)}`, "suite half done");
  f.complete("w", "suite running in the background");
  await f.tick(2);
  assert.equal(f.wakes("c"), 1, "two working posts, one run");
  assert.match(f.fake.promptOf(f.thread("c"), f.fake.runsOf(f.thread("c"))[0]!), /suite half done/);
  f.complete("c", "ok");
  await f.tick();

  await f.cli("c", "follow", `#${f.num(a!)}`, "--off");
  assert.match(await f.cli("w", "working", `#${f.num(a!)}`, "three quarters"), /It wakes nobody\./);
  await f.tick(3);
  assert.equal(f.wakes("c"), 1, "no longer following");
  assert.equal(f.wakes("v"), 0, "a non-follower is never woken");
  assert.match(await f.cli("w", "answer", `#${f.num(a!)}`, "suite green"), /: answered\. @c is woken with it\./);
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
  await f.refused("w", ["working", big], /at most 1 MiB/);
  await f.refused("w", ["note", big], /at most 1 MiB/);
  await f.refused("w", ["answer", big], /at most 1 MiB/);
  f.complete("w", "failed", "error");
  await f.tick();
  await f.refused("c", ["retry", `#${f.num(a!)}`, big], /at most 1 MiB/);
});

test("answer prints the engine's outcome for each request: answered, superseded, and a closed request is refused, not replayed", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  // A correction lands during the turn: w has not read it, so its answer is superseded and the request stays open.
  const correction = await f.appended(() => f.cli("c", "correct", `#${f.num(a!)}`, "use the new grammar"));
  const superseded = await f.cli("w", "answer", "parser done");
  assert.match(superseded, new RegExp(`#${f.num(a!)}: NOT answered; it stays open, because #${correction[0]!.seq} bears on it and you have not read it yet`));
  assert.match(superseded, /your next turn brings it/);
  assert.equal(f.request(a!).state, "open");
  f.complete("w", "parser done");
  await f.tick(2);
  assert.ok(f.running("w"), "the next turn brings the correction");
  const answered = await f.cli("w", "answer", "parser done with the new grammar");
  assert.match(answered, /^Recorded as #\d+\.\n#\d+: answered\. @c is woken with it\.$/);
  // A number with no text is not taken for the text.
  await f.refused("w", ["answer", `#${f.num(a!)}`], /looks like a post number with no text after it/);
  // A second identical answer is a new attempt (fresh command ID), refused because the request is closed.
  await f.refused("w", ["answer", `#${f.num(a!)}`, "parser done with the new grammar"], new RegExp(`#${f.num(a!)} is already answered`));
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
  const several = await f.refused("w", ["post", "@v review it"], new RegExp(`this turn works on #${f.num(a!)}, #${f.num(b!)}|This turn works on #${f.num(a!)}, #${f.num(b!)}`));
  assert.doesNotMatch(several.message, /#board:|@[0-9a-f]{8}-/);
  assert.match(several.message, /"@v …"/);
  const working = await f.cli("w", "working", `#${f.num(a!)}`, "long suite");
  assert.match(working, new RegExp(`#${f.num(a!)} stays open until you run rooms-board answer #${f.num(a!)}`));
  assert.doesNotMatch(working, /#board:|@[0-9a-f]{8}-/);
  await f.refused("v", ["answer", `#${f.num(a!)}`, "not mine"], new RegExp(`#${f.num(a!)} is not a request of yours`));
  // post --for names one of the poster's own open requests.
  const [r] = f.posted(await f.cli("w", "post", "--for", `#${f.num(b!)}`, "@v review the printer"));
  assert.equal(f.request(r!).parentId, b);
  await f.refused("c", ["post", "--for", `#${f.num(a!)}`, "@v help @w"], /is not your request: a post goes under a request you own/);
  await f.refused("v", ["post", "--for", `#${f.num(b!)}`, "@w which printer?"], /is not your request/);
  // Answering a post that is not a request names the request it is about.
  const note = await f.appended(() => f.cli("w", "note", `#${f.num(a!)}`, "lexer first"));
  await f.refused("w", ["answer", `#${note[0]!.seq}`, "done"], new RegExp(`#${note[0]!.seq} is a note on #${f.num(a!)}, not a request: name #${f.num(a!)}`));
  // An unknown or unseated recipient is refused before anything is written, even with a valid one first.
  await f.refused("c", ["post", "@v @nobody look"], /nobody called @nobody can take work in this room/);
  await f.refused("c", ["post", "look at this"], /start with @name/);
  await f.refused("c", ["post", "@w /compact"], /is a slash command/);
});

test("cancel and correct are the requester's only: the Consigliere cannot close or change work someone else waits on", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  // The worker's review of its own request: the Consigliere did not ask it.
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  await f.tick();
  const [r] = f.posted(await f.cli("w", "post", "@v review the parser diff"));
  f.complete("w", "built; review asked");
  await f.tick(2);
  await f.refused("c", ["cancel", `#${f.num(r!)}`], /only @w, who asked #\d+, can cancel it; ask @w\./);
  await f.refused("c", ["correct", `#${f.num(r!)}`, "skip the tests"], /only @w, who asked #\d+, can correct it/);
  // The user's request to the Consigliere: only the user withdraws or changes it.
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:plan", to: f.seat("c"), body: "plan the release" });
  await f.refused("c", ["cancel", `#${f.num("user:plan")}`], /only the user, who asked #\d+, can cancel it\.$/);
  await f.refused("c", ["correct", `#${f.num("user:plan")}`, "never mind"], /only the user, who asked #\d+, can correct it\.$/);
  // The requester's own cancel is unchanged: the worker withdraws its review.
  assert.deepEqual(kinds(await f.appended(() => f.cli("w", "cancel", `#${f.num(r!)}`))).slice(0, 1), ["cancel"]);
  assert.equal(f.request(a!).state, "open");
});

test("a post outside a host turn while background work holds several requests must say which one it is for", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w run job A in the background"));
  await f.tick();
  f.fake.background(f.thread("w"), ["job-a"]);
  f.complete("w", "job A started");
  await f.tick();
  const [b] = f.posted(await f.cli("c", "post", "@w run job B in the background"));
  await f.tick();
  f.fake.background(f.thread("w"), ["job-a", "job-b"]);
  f.complete("w", "job B started");
  await f.tick();
  f.fake.startSelfRun(f.thread("w"));
  await f.tick();
  // A continuation: no host run, two requests held by background work.
  const refusal = await f.refused("w", ["post", "@v review jobs A and B"], new RegExp(`your work still going on holds #${f.num(a!)}, #${f.num(b!)}: say which one this post is for, post --for #n`));
  assert.doesNotMatch(refusal.message, /#board:|\$user/);
  const [r] = f.posted(await f.cli("w", "post", "--for", `#${f.num(a!)}`, "@v review job A"));
  assert.equal(f.request(r!).parentId, a);
  // The continuation ends with nothing left in the background: B is answered, A stays open while its review is open.
  f.fake.background(f.thread("w"), []);
  f.complete("w", "both jobs done; review of A asked");
  await f.tick(2);
  assert.deepEqual([f.request(a!).state, f.request(b!).state], ["open", "answered"]);

  // With one held request the post goes under it, as before.
  const g = await Fixture.create();
  t.after(() => g.close());
  const [one] = g.posted(await g.cli("c", "post", "@w run the job in the background"));
  await g.tick();
  g.fake.background(g.thread("w"), ["job"]);
  g.complete("w", "job started");
  await g.tick();
  g.fake.startSelfRun(g.thread("w"));
  await g.tick();
  const [child] = g.posted(await g.cli("w", "post", "@v review the job"));
  assert.equal(g.request(child!).parentId, one);
});

test("no text a member reads names the user as someone to post to", async (t) => {
  const f = await Fixture.create({ orchestrator: null });
  t.after(() => f.close());
  f.stack.engine!.request(f.roomId, { actor: "$user", id: "user:job", to: f.seat("w"), body: "do the thing" });
  const refusal = await f.refused("w", ["working", `#${f.num("user:job")}`, "still on it"], /use rooms-board note, which the user reads on the board/);
  assert.doesNotMatch(refusal.message, /\$user/);
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

test("retry of a background job's failure is refused with a sentence, not as 'not a failed turn'", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w run the job in the background"));
  await f.tick();
  f.fake.background(f.thread("w"), ["job"]);
  f.complete("w", "job started");
  await f.tick();
  const activity = [...f.p().activities.values()].find((x) => x.requestIds.includes(a!))!;
  // No host path fails background work today; the engine's form of it is an error output on the activity.
  const w = f.seat("w");
  f.restart(() => {
    const store = new EngineStore(join(f.dir, "board.sqlite"));
    store.execute(f.roomId, { type: "output", actor: "$system", id: "bg-failed", author: w, sourceKey: "bg-failed", association: { kind: "activity", id: activity.id }, activityCompletion: "failed", body: "the job crashed", disposition: { kind: "error", requestIds: [a!] } });
    store.close();
  });
  const notice = f.p().events.find((e) => e.data.kind === "notice" && e.data.intent === "error")!;
  assert.equal(notice.data.kind === "notice" && notice.data.causeId, `activity:${activity.id}`);
  await f.refused("c", ["retry", `#${notice.seq}`], /is the failure of background work, not of a turn; a background job is not retried: post the work again/);
});

test("a post made while the host is still sending the turn is a child of that turn's request", async (t) => {
  const f = await Fixture.create();
  t.after(() => f.close());
  const [a] = f.posted(await f.cli("c", "post", "@w build the parser"));
  f.fake.unavailableSends = 1;
  await f.tick();
  const run = f.p().runs.get(f.p().seats.get(f.seat("w"))!.activeRunId!)!;
  assert.equal(run.phase, "sending");
  const [r] = f.posted(await f.cli("w", "post", "@v review it"));
  assert.equal(f.request(r!).parentId, a);
});

test("seat, reseat and retire run the room commands L4b routes to the journal, the Consigliere's only; without L4b they say so", async (t) => {
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
    { type: "participant.retire", participantId: ids.get("v"), pendingTasks: "cancel", thread: "keep" },
  ]);

  // Without L4b the old paths are never taken: they know nothing of the journal.
  const bare = await Fixture.create({ lifecycle: { execute: async () => assert.fail("no room command without L4b") } });
  t.after(() => bare.close());
  await bare.run({ type: "preset.create", name: "sonnet", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } });
  await bare.refused("c", ["seat", "sonnet"], /arrives with item L4b/);
  await bare.refused("c", ["reseat", "w"], /arrives with item L4b/);
  await bare.refused("c", ["retire", "v"], /arrives with item L4b/);
});

test("the route hook: with the engine on, /api/board-tools is the journal's board; refusals are 4xx with the sentence", async (t) => {
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
