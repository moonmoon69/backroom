/**
 * H6, keep-alives (the user's decision, Improvement task581 and task582): a seat with work in flight (a member it asked
 * still working, background work or a subagent of its own) that nothing has woken for its keep-alive interval gets a
 * keep-alive post: one line saying there is nothing to do, then the H5 status lines of that work. It keeps the seat's
 * prompt cache warm. On by default for the orchestrator, off for members unless the room's setting turns it on. Never
 * with nothing in flight, never during the seat's own turn, never twice for one turn; the reply is a note that wakes
 * nobody.
 *
 * When a seat was last woken is T3's: the end of the latest turn on its thread. The fake T3 stamps turns with the wall
 * clock, so these tests set the host's clock from it. A member working through the intervals they step is silent in T3,
 * so these rooms leave the silent notice out (silentMs): its wake of the Consigliere is tests/runtime/silent-notice.test.ts's.
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
/** T3's own watch of a pull request (watch_pull_request), as T3 lists it among the thread's background tasks. */
const WATCH = { taskId: "pull-request-watch:github.com/demo/demo#7", kind: "monitor" as const, description: "Watching pull request #7", childThreadId: null };

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
  room = await Room.create({ host: { silentMs: Infinity } });
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
  room = await Room.create({ host: { silentMs: Infinity } });
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

test("an overdue seat with nothing in flight has its threads read once a minute, not on every tick", async () => {
  room = await Room.create({ host: { silentMs: Infinity } });
  room.user("C", "Have the docs checked.");
  await room.tick();
  room.post("C", "W", "Check the docs.");
  room.complete("C", "Asked W.");
  await room.tick();
  room.complete("W", "Docs are fine.");
  await room.tick(2);
  room.complete("C", "W checked them.");
  await room.tick(3);
  const reads = new Map<string, number>();
  const detail = room.fake.getThreadDetail.bind(room.fake);
  room.fake.getThreadDetail = async (threadId: string) => {
    reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
    return detail(threadId);
  };
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick(5);
  assert.deepEqual([reads.get(room.threadOf("C")), reads.get(room.threadOf("W"))], [1, 1], "one look at C's thread and at W's, then none");
  room.clock += 59_999;
  await room.tick(3);
  assert.deepEqual([reads.get(room.threadOf("C")), reads.get(room.threadOf("W"))], [1, 1]);
  room.clock += 1;
  await room.tick();
  assert.deepEqual([reads.get(room.threadOf("C")), reads.get(room.threadOf("W"))], [2, 2], "a minute on, one more look");
  assert.equal(keepAlives(room).length, 0);
});

test("never during the seat's own turn: a long host run, then a turn T3 starts itself; the interval counts from that turn's end", async () => {
  room = await Room.create({ host: { silentMs: Infinity } });
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

test("never into a turn the listed shell does not show yet: no keep-alive is posted, and one posted earlier is not sent", async () => {
  room = await Room.create({ host: { silentMs: Infinity } });
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  // T3's thread list answers from a snapshot taken before a turn started on C's thread (typed in T3 just now).
  const frozen = structuredClone(room.fake.thread(room.threadOf("C")).shell);
  const list = room.fake.listThreads.bind(room.fake);
  room.fake.listThreads = async (projectId?: string) => (await list(projectId)).map((s) => (s.id === frozen.id ? frozen : s));
  room.fake.startExternalRun(room.threadOf("C"), "typed in T3 just now");
  const sent = () => room.fake.sent.filter((m) => m.threadId === room.threadOf("C")).length;
  const before = sent();
  await room.tick(3);
  assert.equal(keepAlives(room).length, 0, "the seat's own thread says a turn runs: nothing is posted");
  assert.equal(sent(), before);

  // A keep-alive posted before that turn started (the host crashed before sending it) is not sent into it either.
  room.complete("C", "Done with what was typed.");
  room.fake.listThreads = list;
  await room.tick(2);
  after(room, "C", KEEP_ALIVE_MS);
  room.crashOnce("keep-alive", "C");
  await room.tick();
  assert.equal(keepAlives(room).length, 1);
  const frozenAgain = structuredClone(room.fake.thread(room.threadOf("C")).shell);
  room.fake.listThreads = async (projectId?: string) => (await list(projectId)).map((s) => (s.id === frozenAgain.id ? frozenAgain : s));
  room.fake.startExternalRun(room.threadOf("C"), "typed in T3 again");
  const beforeAgain = sent();
  await room.tick(3);
  assert.equal(sent(), beforeAgain, "nothing goes to C while its turn runs");
});

test("the setting: members off by default and on when set; the orchestrator on by default and off when set; the interval is the setting's", async () => {
  const setting: { intervalMs: number; on: Record<string, boolean> } = { intervalMs: 10 * 60_000, on: {} };
  room = await Room.create({ host: { silentMs: Infinity, keepAlive: (_room, seatId): KeepAliveSetting => ({ intervalMs: setting.intervalMs, on: setting.on[seatId] ?? null }) } });
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
  room = await Room.create({ host: { silentMs: Infinity } });
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

test("a keep-alive overtaken by a turn of the seat's is not sent on its own; beside real work it is left out, so the briefing holds only the reply's own fresh status", async () => {
  room = await Room.create({ host: { silentMs: Infinity } });
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
  // The stale keep-alive costs no reads while it waits: the listed shell is past its turn already.
  let reads = 0;
  const detail = room.fake.getThreadDetail.bind(room.fake);
  room.fake.getThreadDetail = async (threadId: string) => {
    if (threadId === room.threadOf("C")) reads += 1;
    return detail(threadId);
  };
  await room.tick(5);
  assert.equal(reads, 0, "C's thread is not read on every tick for a stale keep-alive");
  room.fake.getThreadDetail = detail;

  // W answers: C's run brings W's answer and the stale keep-alive, which is left out (its status line is out of date).
  room.complete("W", "Built.");
  await room.tick(2);
  assert.equal(room.wakes("C"), wakes + 2);
  const prompt = room.prompt("C");
  assert.ok(!prompt.includes(KEEP_ALIVE_LINE), "no keep-alive line beside real work");
  assert.doesNotMatch(prompt, /keep-alive from Backroom/);
  assert.deepEqual(prompt.split("\n").filter((l) => l.startsWith("[T3 status of @W")), ["[T3 status of @W: idle]"], "one status for W, its answer's own");
  assert.match(prompt, /answer from @W/);
  room.complete("C", "W built it.");
  await room.tick(2);
  assert.equal(room.unread("C").length, 0, "the keep-alive went with that run, not left behind");
  assert.equal(keepAliveReplies(room, "C").length, 0, "a run with real work ends as usual");
  assert.equal(room.outputs().filter((o) => o.author === "C").at(-1)!.disposition.kind, "yield");
});

test("ROOMS_KEEPALIVE_MS: 55 minutes by default, 0 for off, a minute to under the cache's hour, and refused otherwise", () => {
  const base = { ROOMS_DATA_DIR: "data-test" };
  assert.equal(loadConfig(base).keepAliveMs, KEEP_ALIVE_MS);
  assert.equal(KEEP_ALIVE_MS, 55 * 60_000);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "0" }).keepAliveMs, 0);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "1800000" }).keepAliveMs, 1_800_000);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "60000" }).keepAliveMs, 60_000);
  assert.equal(loadConfig({ ...base, ROOMS_KEEPALIVE_MS: "3599999" }).keepAliveMs, 3_599_999);
  // Under a minute is refused: a unit slip (55 for 55 minutes) would wake seats back to back.
  for (const bad of ["55", "1000", "59999", "3600000", "-1", "soon", "1.5"]) assert.throws(() => loadConfig({ ...base, ROOMS_KEEPALIVE_MS: bad }), /ROOMS_KEEPALIVE_MS/, bad);
});

test("never for T3's watch of a pull request alone: it is T3's, for the pull request's life, not work the seat waits on; beside the seat's own work it is named", async () => {
  room = await Room.create({ host: { silentMs: Infinity } });
  room.user("C", "Open the release pull request and have T3 watch it.");
  await room.tick();
  room.fake.background(room.threadOf("C"), [WATCH]);
  room.complete("C", "PR 7 is open; T3 watches it.");
  await room.tick(2);
  assert.ok(!room.running("C"));
  const wakes = room.wakes("C");
  after(room, "C", 2 * KEEP_ALIVE_MS);
  await room.tick(3);
  assert.equal(keepAlives(room).length, 0, "no keep-alive for the watch alone");
  assert.equal(room.wakes("C"), wakes);
  // A build of its own beside the watch: the keep-alive comes, and its status line names both.
  room.fake.background(room.threadOf("C"), [WATCH, "release-build"]);
  after(room, "C", 2 * KEEP_ALIVE_MS + 60_000);
  await room.tick(3);
  assert.equal(keepAlives(room).length, 1);
  assert.equal(room.wakes("C"), wakes + 1);
  assert.equal(room.prompt("C"), `${KEEP_ALIVE_LINE}\n[T3 status of @C: still running: monitor "Watching pull request #7", background task "background release-build"]`);
  room.complete("C", "Nothing to do; the build runs.");
  await room.tick(2);
});
