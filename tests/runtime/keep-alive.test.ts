/**
 * H6, keep-alives (the user's decision, Improvement task581 and task582): a seat with work in flight (a member it asked
 * still working, background work or a subagent of its own) that nothing has woken for its keep-alive interval gets a
 * keep-alive post: one line saying there is nothing to do, then the H5 status lines of that work. It keeps the seat's
 * prompt cache warm. On by default for the orchestrator, off for members unless the room's setting turns it on. Never
 * with nothing in flight, never during the seat's own turn, never twice for one turn; the reply is a note that wakes
 * nobody.
 *
 * When a seat was last woken is T3's: the end of the latest turn on its thread. The fake T3 stamps turns with the wall
 * clock, so these tests set the host's clock from it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { KEEP_ALIVE_LINE } from "../../src/briefing/envelope.ts";
import { loadConfig } from "../../src/config.ts";
import { KEEP_ALIVE_MS, KEEP_ALIVE_REPLY, type KeepAliveSetting } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const RUNNING = "[T3 status of @W: a turn is running (T3 lists no background tasks while it runs)]";

/** When the latest turn on the seat's thread ended, as T3 says. */
function endedAt(r: Room, seat: string): number {
  return Date.parse(r.fake.thread(r.threadOf(seat)).shell.latestRunCompletedAt!);
}

/** The host's clock, `ms` after the seat's latest turn ended. */
function after(r: Room, seat: string, ms: number): void {
  r.clock = endedAt(r, seat) + ms;
}

function keepAlives(r: Room) {
  return r.p.events.filter((e) => e.data.kind === "notice" && e.data.intent === "keep-alive");
}

/** The seat's notes that answer a keep-alive. */
function keepAliveReplies(r: Room, seat: string) {
  return r.p.events.filter((e) => e.data.kind === "note" && e.data.author === seat && e.id.startsWith(KEEP_ALIVE_REPLY));
}

/** C hands W a long job and ends its turn: W's run is live, C idle. Returns W's request. */
async function handOff(r: Room): Promise<string> {
  r.user("C", "Have W build the release.");
  await r.tick();
  const w = r.post("C", "W", "Build the release; it takes a while.");
  r.complete("C", "Handed off to W.");
  await r.tick(2);
  assert.ok(r.running("W") && !r.running("C"));
  return w;
}

test("fires at the interval while a member works; the post is one line and the status lines; the reply is a note that wakes nobody; the next comes an interval after the keep-alive's own turn", async () => {
  room = await Room.create();
  const w = await handOff(room);
  const wakes = room.wakes("C");
  const userAnswers = room.outputs().filter((o) => o.recipients.includes("$user")).length;

  after(room, "C", KEEP_ALIVE_MS - 1);
  await room.tick(2);
  assert.equal(room.wakes("C"), wakes, "not before the interval");
  assert.equal(keepAlives(room).length, 0);

  after(room, "C", KEEP_ALIVE_MS);
  await room.tick();
  assert.equal(room.wakes("C"), wakes + 1, "woken at the interval");
  assert.equal(room.prompt("C"), `${KEEP_ALIVE_LINE}\n${RUNNING}`, "the smallest briefing: the keep-alive line, then W's status line");
  const [notice] = keepAlives(room);
  assert.ok(notice && notice.data.kind === "notice");
  assert.deepEqual([notice.data.author, notice.data.recipients, notice.data.requestIds], ["$system", ["C"], []]);

  room.complete("C", "Nothing to do; W is still building.");
  await room.tick(2);
  const replies = keepAliveReplies(room, "C");
  assert.equal(replies.length, 1, "the reply is a note");
  assert.ok(replies[0]!.data.kind === "note");
  assert.deepEqual([replies[0]!.data.body, replies[0]!.data.recipients], ["Nothing to do; W is still building.", []]);
  const output = room.outputs().find((o) => o.author === "C" && o.sourceKey === `final:${[...room.p.runs.values()].filter((r) => r.seatId === "C").at(-1)!.id}`)!;
  assert.deepEqual([output.disposition.kind, output.body, output.recipients], ["silent", "", []]);
  assert.equal(room.outputs().filter((o) => o.recipients.includes("$user")).length, userAnswers, "the user is not woken");
  assert.equal(room.notices().filter((n) => n.intent !== "keep-alive").length, 0, "no notice to anyone");
  assert.equal(room.state(w), "open", "W's request is untouched");
  assert.equal(room.wakes("W"), 1, "W is not woken");

  // The same turn is never followed by a second keep-alive; the keep-alive's own turn starts the next interval.
  await room.tick(3);
  assert.equal(room.wakes("C"), wakes + 1);
  after(room, "C", KEEP_ALIVE_MS - 1);
  await room.tick(2);
  assert.equal(room.wakes("C"), wakes + 1, "not before an interval after the keep-alive's turn");
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick();
  assert.equal(room.wakes("C"), wakes + 2, "the interval elapsed again with W still working");
  assert.equal(keepAlives(room).length, 2);

  // W's answer is a real wake; once W is idle and nothing else runs, nothing is in flight.
  room.complete("C", "Still waiting.");
  await room.tick();
  room.complete("W", "Built.");
  await room.tick(2);
  assert.equal(room.state(w), "answered");
  assert.ok(room.running("C"), "W's answer wakes C");
  room.complete("C", "W built it.");
  await room.tick(2);
  after(room, "C", 3 * KEEP_ALIVE_MS);
  await room.tick(3);
  assert.equal(keepAlives(room).length, 2, "nothing in flight: no keep-alive");
  room.assertQuiet();
});

test("never with nothing in flight: a member that answered and is idle, one whose turn failed, one working for someone else", async () => {
  room = await Room.create();
  room.user("C", "Have the docs and the tests checked.");
  await room.tick();
  room.post("C", "W", "Check the docs.");
  room.post("C", "V", "Check the tests.");
  room.complete("C", "Asked both.");
  await room.tick();
  room.complete("W", "Docs are fine.");
  room.complete("V", "T3 lost the provider session.", { outcome: "error" });
  await room.tick(2);
  room.complete("C", "W is done; V failed.");
  await room.tick(2);
  // The user asks W directly: W works, but not for C.
  room.user("W", "Tidy the changelog.");
  await room.tick();
  assert.ok(room.running("W"));
  const wakes = room.wakes("C");
  after(room, "C", 2 * KEEP_ALIVE_MS);
  await room.tick(3);
  assert.equal(keepAlives(room).length, 0);
  assert.equal(room.wakes("C"), wakes);
});

test("never during the seat's own turn: a long host run, then a turn T3 starts itself; the interval counts from that turn's end", async () => {
  room = await Room.create();
  room.user("C", "Have W build the release.");
  await room.tick();
  room.post("C", "W", "Build the release.");
  await room.tick();
  assert.ok(room.running("C") && room.running("W"), "C's turn goes on while W works");
  room.clock = Date.now() + 3 * KEEP_ALIVE_MS;
  await room.tick(3);
  assert.equal(keepAlives(room).length, 0, "not while C's own run is live");

  room.clock = Date.now();
  room.complete("C", "Handed off.");
  await room.tick(2);
  room.fake.startSelfRun(room.threadOf("C"));
  room.clock = Date.now() + 3 * KEEP_ALIVE_MS;
  await room.tick(3);
  assert.equal(keepAlives(room).length, 0, "not while a turn C started itself runs");

  room.clock = Date.now();
  room.complete("C", "My own check is done.");
  await room.tick(2);
  const wakes = room.wakes("C");
  after(room, "C", KEEP_ALIVE_MS - 1);
  await room.tick(2);
  assert.equal(room.wakes("C"), wakes);
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick();
  assert.equal(room.wakes("C"), wakes + 1);
  assert.equal(keepAlives(room).length, 1);

  // A pending approval holds the turn: no keep-alive goes in while the thread waits on it.
  room.complete("C", "Waiting on W.");
  await room.tick(2);
  room.fake.startSelfRun(room.threadOf("C"));
  room.fake.raiseApproval(room.threadOf("C"));
  room.clock = Date.now() + 3 * KEEP_ALIVE_MS;
  await room.tick(3);
  assert.equal(keepAlives(room).length, 1);
});

test("the setting: members off by default and on when set; the orchestrator on by default and off when set; the interval is the setting's", async () => {
  const setting: { intervalMs: number; on: Record<string, boolean> } = { intervalMs: 10 * 60_000, on: {} };
  room = await Room.create({ host: { keepAlive: (_room, seatId): KeepAliveSetting => ({ intervalMs: setting.intervalMs, on: setting.on[seatId] ?? null }) } });
  const w = room.post("C", "W", "Build it.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["build"]);
  room.complete("W", "The build runs in the background.");
  await room.tick(2);
  assert.equal(room.state(w), "answered");
  room.complete("C", "Noted.");
  await room.tick(2);
  const status = '[T3 status of @W: still running: background task "background build"]';

  // C: W answered, but its background work is in flight; the interval is the setting's 10 minutes, not 55.
  after(room, "C", 10 * 60_000 - 1);
  await room.tick(2);
  assert.equal(keepAlives(room).length, 0);
  after(room, "C", 10 * 60_000);
  await room.tick();
  assert.equal(room.prompt("C"), `${KEEP_ALIVE_LINE}\n${status}`);
  // W, a member whose own background task runs, is as overdue as C: members get none by default.
  assert.equal(keepAlives(room).map((e) => e.data.kind === "notice" && e.data.recipients.join()).join(), "C");
  room.complete("C", "Still building.");
  await room.tick(2);

  // Turned on for W: its own background task is in flight, and its last turn ended long ago.
  const wakesC = room.wakes("C");
  const wakesW = room.wakes("W");
  setting.on.W = true;
  await room.tick();
  assert.equal(room.wakes("W"), wakesW + 1);
  assert.equal(room.prompt("W"), `${KEEP_ALIVE_LINE}\n${status}`, "its own status line");
  room.complete("W", "Still building.");
  await room.tick(2);
  assert.equal(keepAliveReplies(room, "W").length, 1);
  assert.equal(room.wakes("C"), wakesC, "W's keep-alive reply wakes nobody");

  // Turned off for C: no keep-alive for it, however long (W, still on, gets its next one).
  setting.on.C = false;
  room.clock = Date.now() + 5 * 10 * 60_000;
  await room.tick(2);
  assert.equal(room.wakes("C"), wakesC);
  assert.equal(room.wakes("W"), wakesW + 2);
  room.complete("W", "Still building.");
  await room.tick(2);

  // An interval of 0 turns keep-alives off for every seat.
  setting.on.C = true;
  setting.intervalMs = 0;
  const before = keepAlives(room).length;
  room.clock = Date.now() + 5 * 10 * 60_000;
  await room.tick(3);
  assert.equal(keepAlives(room).length, before);
});

test("a crash and restart does not double it: the keep-alive posted before the crash is the one sent, and the next waits an interval after its turn", async () => {
  room = await Room.create();
  await handOff(room);
  const wakes = room.wakes("C");
  after(room, "C", KEEP_ALIVE_MS);
  room.crashOnce("keep-alive", "C");
  await room.tick();
  assert.deepEqual(room.crashes, ["keep-alive:C"]);
  assert.equal(keepAlives(room).length, 1);
  assert.equal(room.wakes("C"), wakes, "the crash came before the send");
  await room.tick(3);
  assert.equal(keepAlives(room).length, 1, "the restarted host finds it");
  assert.equal(room.wakes("C"), wakes + 1, "and sends it once");

  room.crashOnce("output", "C");
  room.complete("C", "Still waiting on W.");
  await room.tick(3);
  assert.deepEqual(room.crashes, ["keep-alive:C", "output:C"]);
  assert.equal(keepAliveReplies(room, "C").length, 1, "the reply is recorded once");
  room.restart();
  await room.tick(3);
  assert.equal(keepAlives(room).length, 1, "no second keep-alive for the same turn after a restart");
  assert.equal(room.wakes("C"), wakes + 1);
});

test("a keep-alive overtaken by a turn of the seat's is not sent on its own; with real work it gives only its status lines", async () => {
  room = await Room.create();
  await handOff(room);
  const wakes = room.wakes("C");
  after(room, "C", KEEP_ALIVE_MS);
  room.crashOnce("keep-alive", "C");
  await room.tick();
  assert.equal(keepAlives(room).length, 1);
  // Before the restarted host sends it, a turn T3 starts on C's thread ends: C was woken since.
  room.fake.startSelfRun(room.threadOf("C"));
  room.complete("C", "My own check passed.");
  await room.tick(3);
  assert.equal(room.wakes("C"), wakes + 1, "only C's own turn: the stale keep-alive is not sent");
  assert.equal(room.unread("C").map((i) => i.intent).join(), "keep-alive");

  // W answers: C's run brings W's answer and the stale keep-alive, which gives only its status lines.
  room.complete("W", "Built.");
  await room.tick(2);
  assert.equal(room.wakes("C"), wakes + 2);
  const prompt = room.prompt("C");
  assert.ok(!prompt.includes(KEEP_ALIVE_LINE), "no keep-alive line beside real work");
  assert.match(prompt, /status from Backroom of the work you are waiting on\]\n\[T3 status of @W: a turn is running/);
  assert.match(prompt, /answer from @W/);
  room.complete("C", "W built it.");
  await room.tick(2);
  assert.equal(keepAliveReplies(room, "C").length, 0, "a run with real work ends as usual");
  assert.equal(room.outputs().filter((o) => o.author === "C").at(-1)!.disposition.kind, "yield");
});

test("ROOMS_KEEPALIVE_MS: 55 minutes by default, 0 for off, and refused at or over the cache's hour", () => {
  const base = { ROOMS_DATA_DIR: "data-test" };
  assert.equal(loadConfig(base).keepAliveMs, KEEP_ALIVE_MS);
  assert.equal(KEEP_ALIVE_MS, 55 * 60_000);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "0" }).keepAliveMs, 0);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "1800000" }).keepAliveMs, 1_800_000);
  for (const bad of ["3600000", "-1", "soon", "1.5"]) assert.throws(() => loadConfig({ ...base, ROOMS_KEEPALIVE_MS: bad }), /ROOMS_KEEPALIVE_MS/, bad);
});
