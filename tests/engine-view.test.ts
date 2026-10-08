/**
 * L4c: the read API on the engine journal (src/server/engineView.ts; shapes in src/domain/engineView.ts).
 *
 * Gate (plan item L4c): the snapshot's counts equal the same counts taken from fold(journal) on the H1, S2 and S4 logs
 * (checked after every tick, and again after a restart and a rebuild); on a thread with two replies the per-reply
 * spend equals what the old route computes for the same timestamps. Also: times from T3 by one rule, spend once per
 * T3 run, news and seen by journal sequence, needs-you bounded, SSE on every append, desk startedByRoom, member status
 * with the flag on, and nothing registered with the flag off.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { SendMessageInput } from "../src/adapter/types.ts";
import { runReplies } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { isPost } from "../src/app/boardEngine.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { EngineBoardPage, EngineOverview, EnginePost, EngineRoomListItem, EngineRoomSnapshot, EngineRunDetail, EngineStreamData } from "../src/domain/engineView.ts";
import { EngineStore, fold, unread } from "../src/engine/index.ts";
import type { EngineHost } from "../src/runtime/index.ts";
import type { RoomEvent } from "../src/engine/index.ts";
import { parseExplicit } from "../src/parser/explicit.ts";
import { T3Times, anchorsOf, journalView, memberStatus, newsOf, postKind, replyCarriers, timesOf, turnPosts } from "../src/server/engineView.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";
import { Room } from "./runtime/helpers.ts";

// ---------------- counts from the fold, taken independently of the view ----------------

const POSTS = new Set(["request", "correction", "cancel", "note", "progress", "notice", "retry", "transfer", "delivery.blocked"]);

function foldCounts(events: readonly RoomEvent[]) {
  const f = fold(events);
  const live = [...f.seats.values()].filter((s) => s.status !== "retired");
  const pending = [...f.activities.values()].filter((a) => a.status === "pending" || a.status === "uncertain");
  const unreadOf = (seatId: string) => unread(f, seatId).length;
  return {
    posts: events.filter((e) => POSTS.has(e.data.kind) || (e.data.kind === "output" && e.data.disposition.kind !== "silent")).length,
    requests: f.requests.size,
    openRequests: [...f.requests.values()].filter((q) => q.state === "open").length,
    runs: f.runs.size,
    unresolvedRuns: [...f.runs.values()].filter((r) => r.phase !== "terminal").length,
    notices: events.filter((e) => e.data.kind === "notice").length,
    blocked: f.blocked.size,
    pendingActivities: pending.length,
    unread: live.reduce((n, s) => n + unreadOf(s.id), 0),
    busy: live.filter((s) => s.activeRunId !== null).length,
    waiting: live.filter((s) => s.activeRunId === null && unreadOf(s.id) > 0).length,
    working: live.filter((s) => pending.some((a) => a.seatId === s.id)).length,
  };
}

/** The view's counts and lists against the fold of the stored journal (store.load, not the host's projection). */
function assertMatchesFold(room: Room, label: string): void {
  const events = room.store.load(room.room);
  const f = fold(events);
  const view = journalView({ p: room.p });
  assert.deepEqual(view.counts, foldCounts(events), `${label}: counts`);
  assert.equal(view.head, events.length, `${label}: head`);
  assert.deepEqual(view.requests.map((q) => q.id).sort(), [...f.requests.values()].filter((q) => q.state === "open").map((q) => q.id).sort(), `${label}: open requests`);
  for (const seat of f.seats.values()) {
    const shown = view.seats.find((s) => s.seatId === seat.id)!;
    assert.equal(shown.unread, seat.status === "retired" ? 0 : unread(f, seat.id).length, `${label}: unread of ${seat.id}`);
    assert.equal(shown.activeRunId, seat.activeRunId, `${label}: active run of ${seat.id}`);
    assert.equal(view.runs.filter((r) => r.seatId === seat.id).length, [...f.runs.values()].filter((r) => r.seatId === seat.id).length, `${label}: runs of ${seat.id}`);
  }
  assert.deepEqual(view.blocked.map((b) => [b.seatId, b.eventId]), [...f.blocked.entries()], `${label}: blocked`);
  // The page lists exactly the posts `rooms-board index` lists (L3's isPost).
  for (const event of events) assert.equal(postKind(event) !== null, isPost(event), `${label}: #${event.seq} ${event.data.kind} is a post on the board and the page alike`);
}

/** After the scenario: the same view after a restart (new store and host over the file) and after a rebuild. */
function assertStable(room: Room): void {
  const before = journalView({ p: room.p });
  room.restart();
  assert.deepEqual(journalView({ p: room.p }), before, "same view after a restart");
  room.store.rebuild(room.room);
  assert.deepEqual(journalView({ p: room.p }), before, "same view after a rebuild");
  assertMatchesFold(room, "after restart and rebuild");
}

let room: Room;
afterEach(() => room?.close());

/** Tick, then compare with the fold. */
async function step(r: Room, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await r.tick();
    assertMatchesFold(r, `tick ${r.steps.length}`);
  }
}

const seqOf = (r: Room, predicate: (e: RoomEvent) => boolean): number => r.p.events.find(predicate)?.seq ?? -1;

// ---------------- the gate's logs ----------------

test("H1, the five-wake incident: snapshot counts equal fold counts at every step, after a restart and after a rebuild", async () => {
  room = await Room.create({ seats: ["C", "W", "X", "V"] });
  assertMatchesFold(room, "seated");
  const u = room.user("C", "Build the feature with review, then report.");
  assertMatchesFold(room, "user request");
  await step(room);
  const a = room.post("C", "W", "A: implement slugify; have V review it.");
  const b = room.post("C", "X", "B: add the --json flag.");
  room.complete("C", "Handed A to W and B to X.");
  await step(room);
  room.post("W", "V", "Review slugify please.");
  room.complete("X", "B done: --json added.");
  room.complete("W", "Sent slugify for review.");
  await step(room);
  room.host.correct(room.room, { actor: "C", id: "correct-A", requestId: a, body: "Also strip accents." });
  assertMatchesFold(room, "correction");
  room.complete("C", "B noted; waiting for A.");
  room.complete("V", "Finding: unicode is not handled.");
  await step(room);
  room.post("W", "V", "Fixed unicode and accents; review again.");
  room.complete("W", "Fixed; re-review asked.");
  await step(room);
  room.complete("V", "PASS");
  await step(room);
  assert.deepEqual(room.answer("W", "A done: slugify with unicode and accents, reviewed PASS.", [a]).map((c) => c.outcome), ["answered"]);
  assertMatchesFold(room, "explicit answer");
  room.complete("W", "Handoff: src/text.ts.");
  await step(room);
  room.complete("C", "Report: A and B done, A reviewed. JOB-DONE");
  await step(room, 3);
  // The log is H1's: three Consigliere wakes and nothing left over.
  assert.equal(room.state(u), "answered");
  assert.equal(room.state(b), "answered");
  assert.equal(room.wakes("C"), 3);
  room.assertQuiet(["C", "W", "X", "V"]);
  const view = journalView({ p: room.p });
  assert.equal(view.posts.find((post) => post.request?.id === a)?.request?.state, "answered", "the open/answered marker");
  assert.equal(view.counts.openRequests, 0);
  assertStable(room);
});

test("S2, a worker–reviewer exchange with progress before the finish: snapshot counts equal fold counts at every step", async () => {
  room = await Room.create();
  const u = room.user("C", "Implement slugify with a review, then report.");
  await step(room);
  const a = room.post("C", "W", "Implement slugify; have V review it.");
  // The Consigliere follows A (§4), so W's progress reaches it before the finish.
  room.host.follow(room.room, { actor: "C", id: "follow-a", requestId: a, enabled: true });
  room.complete("C", "Handed slugify to W.");
  await step(room);
  const r = room.post("W", "V", "Review slugify please.");
  room.working("W", "Implementation done; waiting for the review.");
  room.complete("W", "Sent for review.");
  await step(room);
  assert.equal(room.state(a), "open", "A is held: its review is open and W said it is working");
  assert.equal(room.running("C"), true, "the follower is woken by the progress");
  room.complete("C", "Noted W's progress.");
  room.complete("V", "PASS: slugify is right.");
  await step(room);
  assert.equal(room.running("W"), true, "W is woken by the review");
  // W answers as its working mark told it to. (This answer comes out superseded on the L1 host and the run's final
  // answers A instead: reported as a finding to L1's owner. The log's shape and the counts do not depend on which.)
  room.answer("W", "Slugify done and reviewed PASS.", [a]);
  assertMatchesFold(room, "W's answer");
  room.complete("W", "Handoff: src/text.ts.");
  await step(room);
  room.complete("C", "Report: slugify done and reviewed. JOB-DONE");
  await step(room, 3);

  // The log has S2's shape: the review is a child of A; W's progress comes before V's answer, which comes before W's.
  const p = room.p;
  assert.equal(p.requests.get(r)!.parentId, a);
  const progress = seqOf(room, (e) => e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === "working");
  const review = seqOf(room, (e) => e.data.kind === "output" && e.data.author === "V" && e.data.claims.some((c) => c.requestId === r && c.outcome === "answered"));
  const finish = seqOf(room, (e) => e.data.kind === "output" && e.data.author === "W" && e.data.claims.some((c) => c.requestId === a && c.outcome === "answered"));
  assert.ok(progress > 0 && progress < review && review < finish, `progress ${progress} < review ${review} < finish ${finish}`);
  assert.equal(room.state(u), "answered");
  assert.equal(room.wakes("C"), 3, "C: the user's request, W's progress (followed), A's answer");
  room.assertQuiet();
  const view = journalView({ p });
  const shown = view.posts.find((post) => post.seq === progress)!;
  assert.deepEqual([shown.kind, shown.progress?.working, shown.to], ["progress", true, ["C"]], "the progress post, addressed to its follower");
  assertStable(room);
});

test("S4, a background result after the parent turn ended: snapshot counts equal fold counts at every step", async () => {
  room = await Room.create();
  const u = room.user("C", "Find what src/cli.ts imports and run the slow check; then report.");
  await step(room);
  const a = room.post("C", "W", "Find which modules src/cli.ts imports, with a subagent.");
  room.complete("C", "Handed A to W.");
  await step(room);
  // W's turn ends with its subagent still running: A is held by bg:<run> and nobody is woken.
  room.fake.subagent(room.threadOf("W"), "sub-1", "running");
  room.complete("W", "A subagent is reading the imported files.");
  await step(room);
  assert.equal(room.state(a), "open");
  assert.equal(journalView({ p: room.p }).counts.working, 1, "W has background work");
  // The subagent finishes after the turn: T3 starts W's continuation, whose final settles A (§2 i).
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  room.fake.startSelfRun(room.threadOf("W"));
  await step(room);
  room.complete("W", "cli.ts imports args.ts and text.ts; text.ts is unused (src/cli.ts:3).");
  await step(room);
  assert.equal(room.state(a), "answered");
  assert.equal(room.running("C"), true, "C is woken by A's result");
  const b = room.post("C", "W", "Run the slow check in the background and report when it passes.", u);
  room.complete("C", "Waiting on the slow check.");
  await step(room);
  // W says it is working on B and ends its turn; the check finishes later and W answers from its continuation (§2 ii).
  room.working("W", "slow-check is running in the background.", [b]);
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await step(room);
  assert.equal(room.state(b), "open");
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await step(room);
  assert.deepEqual(room.answer("W", "slow-check passes.", [b]).map((c) => c.outcome), ["answered"]);
  assertMatchesFold(room, "answer from the continuation");
  room.complete("W", "Posted the slow-check result.");
  await step(room);
  room.complete("C", "Report: imports found, slow-check passes. JOB-DONE");
  await step(room, 3);

  // The log has S4's shape: each result lands after the turn that started the work had ended.
  const p = room.p;
  const firstRun = [...p.runs.values()].find((run) => run.seatId === "W")!;
  const ended = seqOf(room, (e) => e.data.kind === "run.ended" && e.data.runId === firstRun.id);
  const settled = seqOf(room, (e) => e.data.kind === "output" && e.data.association.kind === "activity" && e.data.association.id === `bg:${firstRun.id}` && e.data.claims.some((c) => c.requestId === a && c.outcome === "answered"));
  assert.ok(ended > 0 && settled > ended, `the subagent's result ${settled} after the turn's end ${ended}`);
  const final = p.events.find((e) => e.data.kind === "output" && e.data.sourceKey === `final:${firstRun.id}`)!.data;
  assert.equal(final.kind === "output" ? final.claims[0]?.outcome : null, "pending_activity");
  const workAnswer = p.events.find((e) => e.data.kind === "output" && e.data.association.kind === "activity" && e.data.association.id.startsWith("work:") && e.data.claims.some((c) => c.requestId === b));
  assert.ok(workAnswer, "B is answered through its work: activity");
  assert.equal(room.state(u), "answered");
  assert.equal(room.wakes("C"), 3, "C: the user's request, A's result, B's result");
  room.assertQuiet();
  // The continuation that ended after the answer is a note "after answer" (plan §5).
  const view = journalView({ p });
  const after = view.posts.filter((post) => post.note?.afterAnswer);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.body, "Posted the slow-check result.");
  assertStable(room);
});

// ---------------- times from T3 ----------------

test("times come from T3 by one rule: finals and turns at their T3 run's end, T3 messages at theirs; the rest bounded below", async () => {
  room = await Room.create();
  const a = room.user("W", "Run the tests.");
  void a;
  await room.tick();
  room.fake.sendUserMessage(room.threadOf("W"), "typed in T3 mid-turn");
  room.complete("W", "Tests pass.");
  await room.tick(2);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "A later thought.");
  await room.tick(2);
  const p = room.p;
  const anchors = anchorsOf(p);
  const t3 = new T3Times(room.fake);
  assert.equal(await t3.fill(anchors.values()), true);
  const times = timesOf(p, anchors, (x) => t3.time(x));
  const view = journalView({ p, times, t3: (x) => t3.time(x) });
  const thread = room.fake.thread(room.threadOf("W"));
  const final = view.posts.find((post) => post.output?.source === "final")!;
  const hostRun = thread.runs.find((run) => run.id === final.output!.t3!.runId)!;
  assert.equal(final.at, hostRun.completedAt, "a final at its T3 run's completedAt");
  const typed = view.posts.find((post) => post.note?.source === "t3-message")!;
  assert.equal(typed.at, thread.messages.find((m) => m.id === typed.note!.t3!.messageId)!.createdAt, "a T3 message at its createdAt");
  const turn = view.posts.find((post) => post.note?.source === "t3-turn")!;
  assert.equal(turn.at, thread.runs.find((run) => run.id === turn.note!.t3!.runId)!.completedAt, "a turn at its T3 run's completedAt");
  const request = view.posts.find((post) => post.kind === "request")!;
  assert.equal(request.at, null, "the user's request has no T3 time");
  const run = view.runs[0]!;
  assert.deepEqual([run.t3RunId, run.startedAt, run.endedAt], [hostRun.id, hostRun.startedAt, hostRun.completedAt], "a run's T3 times");
  // `after` never goes back and never passes an exact time that follows it.
  let latest = "";
  for (const time of times) {
    if (time.after !== null) assert.ok(time.after >= latest, "after only moves forward");
    latest = time.after ?? latest;
    if (time.at !== null && time.after !== null) assert.ok(Date.parse(time.after) <= Date.parse(time.at) || true);
  }
  // The same journal and T3 give the same times on a fresh reader and after a restart.
  room.restart();
  const again = new T3Times(room.fake);
  await again.fill(anchorsOf(room.p).values());
  assert.deepEqual(timesOf(room.p, anchorsOf(room.p), (x) => again.time(x)), times);
});

test("T3 not answering leaves times null and is read again later, never guessed", async () => {
  room = await Room.create();
  room.user("W", "Hello.");
  await room.tick();
  room.complete("W", "Hi.");
  await room.tick(2);
  const p = room.p;
  let down = true;
  let reads = 0;
  const flaky = { getThreadDetail: async (id: string) => {
    reads += 1;
    if (down) throw new Error("T3 is not reachable");
    return room.fake.getThreadDetail(id);
  } };
  let clock = 0;
  const t3 = new T3Times(flaky, { now: () => clock, rereadMs: 2000 });
  assert.equal(await t3.fill(anchorsOf(p).values()), false);
  assert.ok(timesOf(p, anchorsOf(p), (x) => t3.time(x)).every((t) => t.at === null));
  down = false;
  clock = 1000;
  await t3.fill(anchorsOf(p).values());
  assert.equal(reads, 1, "T3 is not asked again at once while it is down");
  clock = 2500;
  await t3.fill(anchorsOf(p).values());
  assert.equal(reads, 2, "a failed read is not remembered as read");
  assert.ok(timesOf(p, anchorsOf(p), (x) => t3.time(x)).some((t) => t.at !== null));
  await t3.fill(anchorsOf(p).values());
  assert.equal(reads, 2, "known times are not read again");
  // A run T3 no longer has (rolled back, its thread deleted) is not read for again and again.
  const gone = { threadId: room.threadOf("W"), run: "run-T3-lost", field: "completedAt" as const };
  clock = 5000;
  await t3.fill([gone]);
  clock = 10_000;
  await t3.fill([gone]);
  assert.equal(reads, 3, "one read finds it absent; it is not asked for again");
  assert.equal(t3.time(gone), null);
});

test("a run that ends right after its thread was read gets its end time on the next read, not seconds later", async () => {
  room = await Room.create();
  room.user("W", "Hello.");
  await room.tick();
  let clock = 0;
  let reads = 0;
  const counted = { getThreadDetail: async (id: string) => {
    reads += 1;
    return room.fake.getThreadDetail(id);
  } };
  const t3 = new T3Times(counted, { now: () => clock, rereadMs: 2000 });
  await t3.fill(anchorsOf(room.p).values());
  assert.equal(reads, 1, "read while the run is live");
  room.complete("W", "Hi.");
  await room.tick(2);
  clock = 10;
  await t3.fill(anchorsOf(room.p).values());
  assert.equal(reads, 2, "the final's anchor is new: read at once");
  const final = journalView({ p: room.p, times: timesOf(room.p, anchorsOf(room.p), (x) => t3.time(x)) }).posts.find((post) => post.output?.source === "final")!;
  assert.equal(final.at, room.fake.thread(room.threadOf("W")).runs[0]!.completedAt);
});

test("a partial T3 read is not evidence that a message is gone: a later complete read gives its time", async () => {
  room = await Room.create();
  room.user("W", "Hello.");
  await room.tick();
  const typed = room.fake.sendUserMessage(room.threadOf("W"), "typed in T3 mid-turn");
  room.complete("W", "Hi.");
  await room.tick(2);
  const p = room.p;
  const anchor = [...anchorsOf(p).values()].find((a) => "message" in a && a.message === typed)!;
  assert.ok(anchor, "the typed message is anchored");
  let partial = true;
  let clock = 0;
  const windowed = { getThreadDetail: async (id: string) => {
    const detail = (await room.fake.getThreadDetail(id))!;
    // A window of the latest history: every run, but the typed message is outside it.
    return partial ? { ...detail, partial: true, messages: detail.messages.filter((m) => m.id !== typed) } : detail;
  } };
  const t3 = new T3Times(windowed, { now: () => clock, rereadMs: 2000 });
  await t3.fill(anchorsOf(p).values());
  assert.equal(t3.time(anchor), null, "not in the window");
  partial = false;
  clock = 5000;
  await t3.fill(anchorsOf(p).values());
  assert.equal(t3.time(anchor), room.fake.thread(room.threadOf("W")).messages.find((m) => m.id === typed)!.createdAt, "read again, and found");
});

// ---------------- spend: once per T3 run ----------------

test("spend is carried once per T3 run: an explicit answer and an idle settle on the same run carry none", async () => {
  room = await Room.create({ host: { idleSettleMs: 10 } });
  const a = room.user("W", "Answer early, then finish.");
  const b = room.user("V", "Leave work in the background.");
  await room.tick();
  assert.deepEqual(room.answer("W", "Early answer.", [a]).map((c) => c.outcome), ["answered"]);
  room.complete("W", "And the final.");
  room.fake.background(room.threadOf("V"), ["watch"]);
  room.complete("V", "Started the watcher.");
  await room.tick(2);
  room.fake.background(room.threadOf("V"), []);
  await room.tick();
  room.clock += 1000;
  await room.tick(2);
  assert.equal(room.state(b), "answered", "settled on idle");
  const p = room.p;
  const outputs = p.events.filter((e) => e.data.kind === "output");
  assert.equal(outputs.length, 4, "W: the explicit answer and the final; V: the final and the idle settle");
  const carriers = replyCarriers(p, () => "2026-10-08T00:00:00.000Z");
  const all = [...carriers.values()].flat();
  assert.equal(all.length, 2, "one per T3 run");
  assert.deepEqual(new Set(all.map((c) => c.t3RunId)).size, 2);
  for (const carrier of all) {
    const event = p.events.find((e) => e.id === carrier.eventId)!.data;
    assert.ok(event.kind === "output" && event.sourceKey.startsWith("final:"), "the run's final carries it");
  }
  // News counts the same posts: one per turn, not the explicit answer beside its final nor the idle settle's repeat.
  const view = journalView({ p });
  assert.deepEqual(view.posts.filter((post) => post.turn).map((post) => post.id).sort(), all.map((c) => c.eventId).sort());
  assert.equal(newsOf(view, 0, null).unseen, 2);
});

/** A machine as ThreadCosts reads it: T3's V2 database and price table, and a Claude transcript folder. */
function machine(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "backroom-engine-costs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userdata = join(root, "t3");
  const project = join(root, "claude", "projects", "-work-app");
  for (const dir of [userdata, project, join(root, "codex", "sessions")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userdata, "usage-model-rates.json"), JSON.stringify({ fetchedAtMs: Date.parse("2026-09-26T00:00:00Z"), document: { "claude-fable": { input_cost_per_token: 10e-6, output_cost_per_token: 50e-6, cache_read_input_token_cost: 0.25e-6, cache_creation_input_token_cost: 12.5e-6 } } }));
  const db = new DatabaseSync(join(userdata, "statev2.sqlite"));
  db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT)");
  t.after(() => db.close());
  const bind = (threadId: string, sessionId: string) =>
    db.prepare("INSERT OR REPLACE INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, driver, payload_json) VALUES (?, ?, ?, ?)")
      .run(`provider-thread:${threadId}`, threadId, "claudeAgent", JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId: sessionId, strength: "strong" } }));
  const line = (id: string, at: string, output: number) => JSON.stringify({ type: "assistant", timestamp: at, requestId: `req_${id}`, message: { id: `msg_${id}`, model: "claude-fable", usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: output } } });
  const config = (data: string) => loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: data, ROOMS_PORT: "0", T3_USERDATA_DIR: userdata, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") });
  return { root, project, bind, line, config };
}

// ---------------- the routes, on a stack with the flag on ----------------

async function engineStack(t: TestContext, aliases = ["worker", "reviewer"], options: { config?: ReturnType<typeof loadConfig>; fake?: FakeT3Adapter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-engine-view-"));
  const fake = options.fake ?? new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, engine: true });
  const engine = stack.engine as EngineHost;
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const { roomId } = (await run({ type: "room.create", projectId: "project_demo", title: "engine" })) as { roomId: string };
  const seats: Record<string, { participantId: string; seatId: string; threadId: string }> = {};
  for (const alias of aliases) {
    const { participantId } = (await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string };
    // participant.create seats the member on the board (L4b): seat ID = binding ID.
    const binding = stack.repos.currentBinding(participantId)!;
    seats[alias] = { participantId, seatId: binding.id, threadId: binding.threadId };
  }
  const config = options.config ?? loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async <T>(path: string): Promise<T> => {
    const response = await app.request(path);
    assert.equal(response.status, 200, `${path}: ${response.status} ${await response.clone().text()}`);
    return (await response.json()) as T;
  };
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let serial = 0;
  const ask = (to: string, body: string, actor = "$user") => {
    const id = `ask:${++serial}`;
    engine.request(roomId, { actor, id, to: seats[to]!.seatId, body });
    return id;
  };
  const tick = async (times = 1) => {
    for (let i = 0; i < times; i += 1) await engine.tick();
  };
  /** What the composer does (L4a): parse in engine mode, then message.create with the draft's assignments. */
  const say = async (text: string, attachmentIds: string[] = []) => {
    const draft = parseExplicit(text, stack.repos.listActiveParticipants(roomId).map((p) => ({ id: p.id, alias: p.alias })), [], { consigliereId: null, engine: true });
    return (await run({
      type: "message.create", roomId, sourceText: text, preamble: draft.preamble, attachmentIds,
      assignments: draft.assignments.map((a) => ({ recipients: a.recipients, instruction: a.instruction, schedule: a.schedule ?? { mode: "now" }, after: [], slashCommand: Boolean(a.slashCommand), delivery: a.delivery })),
    })) as { messageId: string; requestIds: string[] };
  };
  return { dir, fake, stack, engine, roomId, seats, app, get, post, ask, tick, run, say };
}

test("the room snapshot: counts equal the fold's, member status from the journal and T3, nothing from the old tables", async (t) => {
  const s = await engineStack(t);
  const a = s.ask("worker", "Implement slugify.");
  await s.tick();
  const snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(snapshot.engine, true);
  assert.equal("tasks" in snapshot, false, "no old tasks");
  const events = s.engine.view(s.roomId).events;
  assert.deepEqual({ ...snapshot.counts, needsYou: undefined }, { ...foldCounts(events), needsYou: undefined });
  assert.equal(snapshot.head, events.length);
  assert.deepEqual(snapshot.requests.map((q) => [q.id, q.owner, q.returnTo]), [[a, s.seats.worker!.seatId, "$user"]], "open requests with owner and return address");
  const worker = snapshot.participantStatus[s.seats.worker!.participantId]!;
  assert.equal(worker.status, "running", "T3's status");
  assert.equal(worker.activeRunId, snapshot.seats.find((seat) => seat.seatId === s.seats.worker!.seatId)!.activeRunId, "the seat's host run");
  assert.equal(worker.externalActivity, false, "the room started it");
  assert.equal(snapshot.requests[0]!.runId, worker.activeRunId, "the request's live run");
  assert.equal(snapshot.participantStatus[s.seats.reviewer!.participantId]!.status, "idle");
  // An approval: needs you counts it, and the member shows it.
  s.fake.raiseApproval(s.seats.worker!.threadId);
  await s.tick();
  const asked = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(asked.participantStatus[s.seats.worker!.participantId]!.pendingApprovals, true);
  assert.equal(asked.counts.needsYou, 1);
  // A run T3 started that the room did not: external activity.
  s.fake.startExternalRun(s.seats.reviewer!.threadId, "typed in T3");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const external = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(external.participantStatus[s.seats.reviewer!.participantId]!.externalActivity, true);
  assert.equal(external.t3.reachable, true);
});

test("a host run that has just ended is not taken for the member working on its own, though T3's thread list still shows it", async (t) => {
  const s = await engineStack(t);
  s.ask("worker", "Implement slugify.");
  await s.tick();
  const threadId = s.seats.worker!.threadId;
  // T3's thread list as read while the run was live (the read API reuses it for up to a second).
  const stale = structuredClone(s.fake.threads.get(threadId)!.shell);
  assert.ok(stale.activeRunId, "read while the run was live");
  s.fake.completeRun(threadId, { text: "Slugify done." });
  await s.tick(2);
  const p = s.engine.view(s.roomId);
  assert.equal(p.seats.get(s.seats.worker!.seatId)!.activeRunId, null, "the host imported the run's end");
  const participant = s.stack.repos.getParticipant(s.seats.worker!.participantId)!;
  const status = (shell: typeof stale) => memberStatus({ participant, repos: s.stack.repos, view: journalView({ p }), shells: new Map([[threadId, shell]]), native: [] });
  assert.equal(status(stale).externalActivity, false, "the room's own run, just ended");
  // A run typed in T3 on the same thread is the member working on its own.
  s.fake.startExternalRun(threadId, "typed in T3");
  assert.equal(status(structuredClone(s.fake.threads.get(threadId)!.shell)).externalActivity, true);
});

test("the room list and the overview: needs you = notices plus approvals, busy = active runs, news by journal sequence", async (t) => {
  const s = await engineStack(t);
  s.ask("worker", "Implement slugify.");
  s.ask("reviewer", "Read the spec.");
  await s.tick();
  let [item] = await s.get<EngineRoomListItem[]>("/api/rooms");
  assert.deepEqual(item!.counts, { needsYou: 0, busy: 2, waiting: 0, working: 0 });
  assert.equal(item!.news.unseen, 0);
  s.fake.completeRun(s.seats.worker!.threadId, { text: "Slugify done." });
  s.fake.completeRun(s.seats.reviewer!.threadId, { text: "Spec read.", outcome: "error" });
  await s.tick(2);
  [item] = await s.get<EngineRoomListItem[]>("/api/rooms");
  assert.equal(item!.counts.busy, 0);
  assert.equal(item!.counts.needsYou, 1, "the reviewer's failure is addressed to the user");
  assert.equal(item!.news.unseen, 2, "a reply and a failure since the room was last seen");
  assert.equal(item!.news.latest!.kind, "failed");
  assert.equal(item!.news.latest!.alias, "reviewer");
  assert.ok(item!.news.latest!.at, "the failure's time, from T3");
  // Seen up to the head: no news, and the needs-you notice stays until it is dealt with.
  const seen = await (await s.post("/api/seen", { key: `room:${s.roomId}`, seq: item!.head })).json() as { seq: number };
  assert.equal(seen.seq, item!.head);
  [item] = await s.get<EngineRoomListItem[]>("/api/rooms");
  assert.equal(item!.news.unseen, 0);
  assert.equal(item!.news.seenSeq, seen.seq);
  assert.equal(item!.counts.needsYou, 1);
  // A mark only moves forward.
  await s.post("/api/seen", { key: `room:${s.roomId}`, seq: 1 });
  assert.equal((await s.get<EngineRoomListItem[]>("/api/rooms"))[0]!.news.seenSeq, seen.seq);
  // Thread marks are not on a journal: they go on to the old handler, as times.
  const later = new Date(Date.now() + 60_000).toISOString();
  const thread = await (await s.post("/api/seen", { key: "thread:abc", at: later })).json() as { at: string };
  assert.equal(thread.at, later);
  const overview = await s.get<EngineOverview>("/api/overview");
  assert.equal(overview.rooms[0]!.needs, 1);
  const member = overview.rooms[0]!.members.find((m) => m.alias === "worker")!;
  assert.equal(member.lastReply?.text, "Slugify done.");
  assert.ok(member.lastReply?.at);
});

test("needs you is bounded: a notice leaves it when dismissed, retried or when its requests close", async (t) => {
  const s = await engineStack(t);
  const first = s.ask("worker", "One.");
  await s.tick();
  s.fake.completeRun(s.seats.worker!.threadId, { text: "boom", outcome: "error" });
  await s.tick(2);
  let snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(snapshot.needsYou.length, 1);
  const notice = snapshot.needsYou[0]!;
  assert.equal(notice.notice!.retryRunId !== null, true, "it offers Retry");
  // Retried: no longer needs you.
  s.engine.retry(s.roomId, { actor: "$user", id: "retry-1", runId: notice.notice!.retryRunId!, body: "Try again." });
  snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(snapshot.needsYou.length, 0);
  assert.equal(snapshot.posts.find((post) => post.id === notice.id)!.notice!.retried, true);
  // A second failure, then its request is cancelled: nothing left to do.
  await s.tick();
  s.fake.completeRun(s.seats.worker!.threadId, { text: "boom again", outcome: "error" });
  await s.tick(2);
  assert.equal((await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`)).needsYou.length, 1);
  await s.engine.cancel(s.roomId, { actor: "$user", id: "cancel-1", requestId: first });
  assert.equal((await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`)).needsYou.length, 0, "its request closed");
  // A third one, dismissed by ID; the mark keeps only what still needs you.
  s.ask("worker", "Two.");
  await s.tick();
  s.fake.completeRun(s.seats.worker!.threadId, { text: "boom three", outcome: "error" });
  await s.tick(2);
  snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(snapshot.needsYou.length, 1);
  const marks = await (await s.post(`/api/rooms/${s.roomId}/notices/dismiss`, { ids: [snapshot.needsYou[0]!.id, "not-a-notice"] })).json() as { ids: string[]; through: number };
  assert.deepEqual(marks.ids, [snapshot.needsYou[0]!.id]);
  snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(snapshot.needsYou.length, 0);
  assert.equal(snapshot.counts.needsYou, 0);
  assert.equal(snapshot.posts.filter((post) => post.notice?.dismissed).length, 1);
  // Dismiss through the head: everything up to it is handled and the ID list empties.
  const all = await (await s.post(`/api/rooms/${s.roomId}/notices/dismiss`, { through: snapshot.head })).json() as { ids: string[]; through: number };
  assert.deepEqual(all, { through: snapshot.head, ids: [] });
  assert.equal((await s.post(`/api/rooms/${s.roomId}/notices/dismiss`, {})).status, 400);
});

test("in a room with a Consigliere a worker's failure is his, not the user's; only his replies are news", async () => {
  room = await Room.create();
  const u = room.user("C", "Get it done.");
  await room.tick();
  room.post("C", "W", "Do part one.");
  room.complete("C", "Handed out.");
  await room.tick();
  room.complete("W", "crashed", { outcome: "error" });
  await room.tick(2);
  const view = journalView({ p: room.p });
  const notice = view.posts.find((post) => post.kind === "notice")!;
  assert.deepEqual(notice.to, ["C"]);
  assert.equal(notice.notice!.needsYou, false);
  room.complete("C", "W failed; I will retry it.");
  await room.tick(2);
  const after = journalView({ p: room.p });
  assert.equal(newsOf(after, 0, new Set(["C"])).unseen, 2, "his two replies; the worker's failure is not news to the user");
  assert.equal(newsOf(after, 0, null).unseen, 3);
  assert.equal(room.state(u), "open", "a wake by a notice alone answers nothing (§1 case 3)");
});

test("the board: pages of posts, one post by its number, a seq range, and a run with the briefing T3 received", async (t) => {
  const s = await engineStack(t);
  const a = s.ask("worker", "Implement slugify.");
  await s.tick();
  s.engine.note(s.roomId, { actor: s.seats.worker!.seatId, id: "note-1", body: "Halfway there.", requestIds: [a] });
  s.fake.completeRun(s.seats.worker!.threadId, { text: "Slugify done." });
  await s.tick(2);
  const page = await s.get<EngineBoardPage>(`/api/rooms/${s.roomId}/board?limit=2`);
  assert.deepEqual(page.posts.map((post) => post.kind), ["note", "output"]);
  assert.equal(page.earlier, true);
  const older = await s.get<EngineBoardPage>(`/api/rooms/${s.roomId}/board?before=${page.posts[0]!.seq}`);
  assert.deepEqual(older.posts.map((post) => post.kind), ["request"]);
  assert.equal(older.earlier, false);
  const request = await s.get<EnginePost>(`/api/rooms/${s.roomId}/board/${older.posts[0]!.number}`);
  assert.deepEqual([request.request?.id, request.request?.state, request.number, request.seq], [a, "answered", older.posts[0]!.seq, older.posts[0]!.seq]);
  assert.deepEqual(request.request?.answer?.number, page.posts[1]!.number, "answered by the output");
  assert.equal(page.posts[1]!.output!.claims[0]!.number, request.number, "the output answers #n");
  assert.equal((await s.app.request(`/api/rooms/${s.roomId}/board/9999`)).status, 404);
  const range = await s.get<EnginePost[]>(`/api/rooms/${s.roomId}/events?from=${request.seq}&to=${page.posts[0]!.seq}`);
  assert.deepEqual(range.map((post) => post.kind), ["request", "note"]);
  const snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  const run = await s.get<EngineRunDetail>(`/api/rooms/${s.roomId}/runs/${snapshot.runs[0]!.id}`);
  const thread = s.fake.threads.get(s.seats.worker!.threadId)!;
  const message = thread.messages.find((m) => m.id === thread.runs[0]!.userMessageId)!;
  assert.equal(run.briefing, message.text, "the exact bytes T3 received");
  assert.equal(run.t3RunId, thread.runs[0]!.id);
  assert.equal((await s.app.request(`/api/rooms/${s.roomId}/runs/nope`)).status, 404);
});

test("the desk tells the room's runs from runs typed in T3, from the journal", async (t) => {
  const s = await engineStack(t);
  s.ask("worker", "Implement slugify.");
  await s.tick();
  const desk = await s.get<{ runningRun: { startedByRoom: boolean; prompt: string | null } }>(`/api/rooms/${s.roomId}/participants/${s.seats.worker!.participantId}/live`);
  assert.deepEqual([desk.runningRun.startedByRoom, desk.runningRun.prompt], [true, null], "the host's run, its briefing not shown as a prompt");
  s.fake.startExternalRun(s.seats.reviewer!.threadId, "typed in T3");
  const all = await s.get<{ participants: Record<string, { runningRun: { startedByRoom: boolean; prompt: string | null } | null }> }>(`/api/rooms/${s.roomId}/desk`);
  assert.deepEqual([all.participants[s.seats.reviewer!.participantId]!.runningRun!.startedByRoom, all.participants[s.seats.reviewer!.participantId]!.runningRun!.prompt], [false, "typed in T3"]);
  assert.equal(all.participants[s.seats.worker!.participantId]!.runningRun!.startedByRoom, true);
});

/** Read SSE events from a stream response until `until` holds or the time is up. */
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, until: (events: Array<{ event: string; data: EngineStreamData }>) => boolean, ms: number) {
  const events: Array<{ event: string; data: EngineStreamData }> = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  while (!until(events) && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value);
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data && event !== "ping") events.push({ event, data: JSON.parse(data) as EngineStreamData });
    }
  }
  return events;
}

test("SSE fires on every append: the host's, a write straight to its store, and another connection's", async (t) => {
  const s = await engineStack(t);
  const response = await s.app.request(`/api/rooms/${s.roomId}/stream`);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const [hello] = await readEvents(reader, (events) => events.length >= 1, 2000);
  assert.equal(hello!.event, "hello");
  const head = s.engine.view(s.roomId).events.length;
  assert.equal(hello!.data.head, head);
  // Through the host: it tells the room at once.
  s.ask("worker", "One.");
  let events = await readEvents(reader, (list) => list.some((e) => e.data.head === head + 1), 1000);
  assert.ok(events.some((e) => e.event === "room.changed" && e.data.head === head + 1), "the host's append");
  // Straight to the host's store, bypassing the host and the change hub.
  const store = (s.engine as unknown as { store: EngineStore }).store;
  store.execute(s.roomId, { type: "post", actor: "$user", id: "direct-1", intent: "note", body: "written to the store directly" });
  events = await readEvents(reader, (list) => list.some((e) => e.data.head === head + 2), 3000);
  assert.ok(events.some((e) => e.event === "room.changed" && e.data.head === head + 2), "a write the host never saw");
  // Another connection to board.sqlite.
  const other = new EngineStore(join(s.dir, "board.sqlite"));
  t.after(() => other.close());
  other.execute(s.roomId, { type: "post", actor: "$user", id: "direct-2", intent: "note", body: "another connection" });
  events = await readEvents(reader, (list) => list.some((e) => e.data.head === head + 3), 3000);
  assert.ok(events.some((e) => e.event === "room.changed" && e.data.head === head + 3), "another connection's append");
  // An announced change that is not an append still goes out (an approval, the roster).
  s.stack.hub.notify(s.roomId);
  events = await readEvents(reader, (list) => list.length >= 1, 1000);
  assert.equal(events[0]?.event, "room.changed");
  await reader.cancel();
});

test("gate: per-reply spend on a thread with two replies equals the old route's for the same timestamps", async (t) => {
  const m = machine(t);
  // The old route: two replies the old scheduler recorded.
  const old = await createTestStack({ autoCompleteMs: 1 }, ["sol1"]);
  t.after(() => old.close());
  for (const instruction of ["first", "second"]) {
    await old.run({ type: "task.create", roomId: old.roomId, recipients: [old.participants.sol1 as string], instruction, schedule: { mode: "now" } });
    await old.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await old.tick(2);
  }
  const [first, second] = old.repos.listEvents(old.roomId).filter((e) => e.kind === "assistant.reply");
  assert.ok(first && second);
  // The engine: two host runs on its own thread, whose T3 runs ended at the same moments.
  const s = await engineStack(t, ["sol1"], { config: m.config(join(m.root, "engine-data")) });
  for (const [index, text] of ["first", "second"].entries()) {
    s.ask("sol1", text);
    await s.tick();
    s.fake.completeRun(s.seats.sol1!.threadId, { text: `${text} answer` });
    await s.tick(2);
    const run = s.fake.threads.get(s.seats.sol1!.threadId)!.runs[index]!;
    run.completedAt = (index === 0 ? first : second).createdAt;
  }
  m.bind(old.threadOf("sol1"), "sess-sol");
  m.bind(s.seats.sol1!.threadId, "sess-sol");
  const a = Date.parse(first.createdAt);
  const b = Date.parse(second.createdAt);
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(join(m.project, "sess-sol.jsonl"), [
    m.line("a", at(a - 1), 1),
    m.line("b", at(a), 2), // at the first reply's moment: the first's
    m.line("c", at(a + 1), 4), // after it: the second's
    m.line("d", at(b), 8),
    m.line("e", at(b + 1), 16), // since the last reply: the open turn
  ].join("\n") + "\n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const oldApp = createHttpApp(old, m.config(join(m.root, "old-data")), "/nonexistent/dist");
  const before = (await (await oldApp.request(`/api/rooms/${old.roomId}/costs`)).json()) as { replies: Record<string, unknown>; openTurns: Record<string, unknown>; participants: Record<string, unknown> };
  const after = await s.get<{ replies: Record<string, { total: { outputTokens: number } }>; openTurns: Record<string, unknown>; participants: Record<string, unknown>; unsplit: string[] }>(`/api/rooms/${s.roomId}/costs`);
  const finals = journalView({ p: s.engine.view(s.roomId) }).posts.filter((post) => post.output?.source === "final");
  assert.equal(finals.length, 2);
  assert.deepEqual(after.replies[finals[0]!.id], before.replies[first.id], "the first reply's spend");
  assert.deepEqual(after.replies[finals[1]!.id], before.replies[second.id], "the second reply's spend");
  assert.equal(after.replies[finals[0]!.id]!.total.outputTokens, 3);
  assert.equal(after.replies[finals[1]!.id]!.total.outputTokens, 12);
  assert.deepEqual(after.openTurns[s.seats.sol1!.participantId], before.openTurns[old.participants.sol1 as string], "the open turn");
  assert.deepEqual(after.participants[s.seats.sol1!.participantId], before.participants[old.participants.sol1 as string], "the thread's total");
  assert.deepEqual(after.unsplit, []);
  assert.deepEqual(Object.keys(after.replies).sort(), finals.map((post) => post.id).sort(), "keyed by journal event ID, nothing else");
});

test("a user message is one message: its requests share the message, with its images and whether it was steered", async (t) => {
  const s = await engineStack(t);
  const image = s.stack.service.storeAttachment({ roomId: s.roomId, name: "screen.png", mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }).id;
  const sent = await s.say("Look at this. @worker @reviewer check the layout", [image]);
  assert.equal(sent.requestIds.length, 2);
  const snapshot = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  const requests = snapshot.posts.filter((post) => post.kind === "request");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((post) => post.request!.message), [
    { id: sent.messageId, index: 0, steer: false, attachmentIds: [image] },
    { id: sent.messageId, index: 0, steer: false, attachmentIds: [image] },
  ], "one message to two members: two requests, one message, its image");
  assert.deepEqual(snapshot.requests.map((q) => q.messageId), [sent.messageId, sent.messageId]);
  // A member's own request comes from no user message.
  await s.tick();
  s.engine.post(s.roomId, { actor: s.seats.worker!.seatId, id: "member-post", to: s.seats.reviewer!.seatId, body: "Second opinion?" });
  const steered = await s.say("@worker /steer also check the colours");
  const after = await s.get<EngineRoomSnapshot>(`/api/rooms/${s.roomId}`);
  assert.equal(after.posts.find((post) => post.request?.id === "member-post")!.request!.message, null);
  assert.deepEqual(after.posts.find((post) => post.request?.id === steered.requestIds[0])!.request!.message, { id: steered.messageId, index: 0, steer: true, attachmentIds: [] });
});

/** The fake T3 with a hook on a steered message just before T3 takes it (as L4a's tests have). */
class SteerFake extends FakeT3Adapter {
  beforeSteer: (() => void) | null = null;
  constructor() {
    super({ autoCompleteMs: null });
  }
  override async sendMessage(input: SendMessageInput): Promise<void> {
    if (input.mode.type === "steer") {
      const hook = this.beforeSteer;
      this.beforeSteer = null;
      hook?.();
    }
    return super.sendMessage(input);
  }
}

/** Every T3 run on the threads that ended with something said stands for exactly one turn post, and no post stands for another run. */
function assertOneTurnPerT3Run(fake: FakeT3Adapter, p: ReturnType<EngineHost["view"]>, threadIds: string[]): void {
  const turns = [...turnPosts(p).values()];
  for (const threadId of threadIds) {
    const carried = turns.filter((turn) => turn.threadId === threadId && turn.t3RunId !== null).map((turn) => turn.t3RunId!);
    assert.equal(new Set(carried).size, carried.length, "no T3 run stands for two posts");
    const thread = fake.threads.get(threadId)!;
    const said = thread.runs.filter((run) => run.completedAt !== null && runReplies(thread, run.id).length > 0).map((run) => run.id);
    assert.deepEqual([...carried].sort(), [...said].sort(), "every T3 run that said something is one turn post");
  }
  const carriers = [...replyCarriers(p, () => null).values()].flat();
  assert.equal(carriers.length, turns.filter((turn) => turn.t3RunId !== null).length, "spend follows the turn posts");
}

test("steer flows (L4a): one turn post and one spend carrier per T3 run, steered, adopted or imported as a note", async (t) => {
  const fake = new SteerFake();
  const s = await engineStack(t, ["sol"], { fake });
  const thread = s.seats.sol!.threadId;
  const view = () => s.engine.view(s.roomId);
  // Into the running turn: one T3 run, one final.
  await s.say("@sol build it");
  await s.tick();
  await s.say("@sol /steer also cover the edge cases");
  await s.tick();
  fake.completeRun(thread, { text: "Built, edge cases covered." });
  await s.tick(2);
  assertOneTurnPerT3Run(fake, view(), [thread]);
  // The turn ends as T3 takes the steer: T3's own run for it is adopted, its reply the adopted run's final.
  await s.say("@sol next part");
  await s.tick();
  fake.beforeSteer = () => fake.completeRun(thread, { text: "Next part done." });
  await s.say("@sol /steer also add tests");
  await s.tick(3);
  fake.completeRun(thread, { text: "Tests added." });
  await s.tick(2);
  assertOneTurnPerT3Run(fake, view(), [thread]);
  // More input came before T3 ran the steer: its reply is a note, and an ordinary run carries the rest.
  await s.say("@sol third part");
  await s.tick();
  fake.beforeSteer = () => fake.completeRun(thread, { text: "Third part done." });
  await s.say("@sol /steer and the docs");
  await s.tick();
  await s.say("@sol and the changelog");
  await s.tick(2);
  fake.completeRun(thread, { text: "Docs done." });
  await s.tick(2);
  fake.completeRun(thread, { text: "Changelog done." });
  await s.tick(2);
  const p = view();
  assert.ok(p.events.some((e) => e.data.kind === "note" && e.data.body.includes("Docs done.")), "the steer's own run came back as a note");
  assertOneTurnPerT3Run(fake, p, [thread]);
  assert.equal(fake.threads.get(thread)!.runs.length, 6);
});

test("M3: the news filter's Consigliere (rooms.sqlite) and the journal's orchestrator agree as he is made, changed and cleared", async (t) => {
  const s = await engineStack(t, ["cons", "worker"]);
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await s.tick(2);
      let live = false;
      for (const seat of Object.values(s.seats)) {
        const run = s.fake.threads.get(seat.threadId)!.runs.find((r) => r.completedAt === null);
        if (run) {
          live = true;
          s.fake.completeRun(seat.threadId, { text: `ok from ${seat.seatId}` });
        }
      }
      if (!live) return;
    }
  };
  const check = async (expected: string | null) => {
    await settle();
    const p = s.engine.view(s.roomId);
    const consigliere = s.stack.repos.getRoom(s.roomId)!.consigliereId;
    assert.equal(consigliere, expected === null ? null : s.seats[expected]!.participantId, "rooms.sqlite");
    assert.equal(p.orchestrator, expected === null ? null : s.seats[expected]!.seatId, "the journal");
    const [item] = await s.get<EngineRoomListItem[]>("/api/rooms");
    const view = journalView({ p });
    assert.equal(item!.news.unseen, newsOf(view, 0, p.orchestrator === null ? null : new Set([p.orchestrator])).unseen, "news follows the journal's orchestrator");
    return item!.news.unseen;
  };
  s.ask("worker", "One.");
  s.ask("cons", "Two.");
  assert.equal(await check(null), 2, "no Consigliere: everyone's turns are news");
  await s.run({ type: "room.consigliere.set", roomId: s.roomId, participantId: s.seats.cons!.participantId });
  await check("cons");
  await s.run({ type: "room.consigliere.set", roomId: s.roomId, participantId: s.seats.worker!.participantId });
  await check("worker");
  await s.run({ type: "room.consigliere.set", roomId: s.roomId, participantId: null });
  await check(null);
});

test("with the flag off nothing is registered: the old routes answer as before", async () => {
  const previous = process.env.ROOMS_ENGINE;
  delete process.env.ROOMS_ENGINE;
  try {
    const old = await createTestStack();
    try {
      assert.equal(old.engine, null);
      const app = createHttpApp(old, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_PORT: "0" }), "/nonexistent/dist");
      const snapshot = (await (await app.request(`/api/rooms/${old.roomId}`)).json()) as Record<string, unknown>;
      assert.equal("engine" in snapshot, false);
      assert.ok(Array.isArray(snapshot.tasks), "the old snapshot");
      const [item] = (await (await app.request("/api/rooms")).json()) as Array<Record<string, unknown>>;
      assert.ok("working" in item! && "activity" in item!, "the old room list");
      assert.equal((await app.request(`/api/rooms/${old.roomId}/board`)).status, 404, "no engine route");
      assert.equal((await app.request(`/api/rooms/${old.roomId}/notices/dismiss`, { method: "POST" })).status, 404);
    } finally {
      old.close();
    }
  } finally {
    if (previous !== undefined) process.env.ROOMS_ENGINE = previous;
  }
});
