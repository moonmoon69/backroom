/**
 * M1: every message to a working member goes into its running turn (the user's #2011 and #2018). A request, correction
 * or retry from the user or the orchestrator is offered to the member's live host run and sent with T3's steer; Backroom's
 * own requests, members' answers and notices wait for the turn's end (riding along when a message goes in). The cases
 * are the M1 reviewer's checklist (backroom-handoff/M1-review/checklist.md), each named by its item.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { T3CommandRejected } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** The messages T3 took into a running run on the seat's thread (its turn items with the steer intent). */
function intoTurn(r: Room, seat: string): string[] {
  return r.fake.thread(r.threadOf(seat)).turnItems.flatMap((i) => (i.type === "user_message" && i.inputIntent === "steer" ? [i.text] : []));
}

/** The seat's host runs, oldest first. */
function runsOf(r: Room, seat: string) {
  return [...r.p.runs.values()].filter((x) => x.seatId === seat);
}

/** C hands A to W; W's run on A is running (C's hand-off answered, C idle). */
async function wOnA(r: Room): Promise<string> {
  const a = r.post("C", "W", "A: fix dates.ts.");
  await r.tick();
  assert.equal(r.running("W"), true);
  return a;
}

// ---------------- item 1: which inputs go in, and which wait ----------------

test("item 1: the user's request and the Consigliere's post go into W's running turn; one final answers all, one run", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const b = room.post("C", "W", "B: also fix text.ts.");
  const u = room.user("W", "And keep the old API.");
  await room.tick(2);
  assert.equal(room.wakes("W"), 1, "no turn of its own");
  assert.equal(intoTurn(room, "W").length, 1, "one message carried both");
  assert.match(intoTurn(room, "W")[0]!, /also fix text\.ts[\s\S]*keep the old API/);
  room.complete("W", "A and B fixed, old API kept.");
  await room.tick(2);
  const finals = room.outputs().filter((o) => o.author === "W");
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0]!.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"], [b, "answered"], [u, "answered"]]);
  assert.equal(room.wakes("W"), 1);
});

test("item 1: the Consigliere's correction goes into the running turn: the final answers the request with it, not superseded, and no second turn", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Keep the old signature." });
  await room.tick();
  assert.match(intoTurn(room, "W")[0] ?? "", /Keep the old signature/);
  const run = runsOf(room, "W")[0]!;
  assert.ok(room.p.runs.get(run.id)!.receipts.some((x) => x.confirmed), "confirmed into W's run");
  room.complete("W", "Fixed, signature kept.");
  await room.tick(2);
  assert.deepEqual(room.outputs().filter((o) => o.author === "W").map((o) => o.claims.map((c) => c.outcome)), [["answered"]]);
  assert.equal(room.wakes("W"), 1);
  assert.equal(room.wakes("C"), 1, "C woken once, by the answer");
});

test("item 1: a retry goes into the member's running turn on other work, and the final answers both", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.complete("W", "The tool crashed.", { outcome: "error" });
  await room.tick();
  const failed = runsOf(room, "W")[0]!;
  assert.equal(room.state(a), "open");
  room.complete("C", "Noted the failure.");
  await room.tick();
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick();
  assert.equal(room.running("W"), true);
  room.host.retry(room.room, { actor: "C", id: room.id("retry"), runId: failed.id, body: "Try A again." });
  await room.tick();
  assert.match(intoTurn(room, "W")[0] ?? "", /Try A again/);
  room.complete("W", "B fixed; A done this time.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("W"), 2, "the failed turn and this one: the retry took no turn of its own");
});

test("item 1: Backroom's own request (a reseat's checkpoint; a briefing held as the user's in a journal from before B1) to a working member waits for its turn's end", async () => {
  for (const [actor, id] of [["$system", "reseat:1"], ["$user", "moved:1"]] as const) {
    room = await Room.create();
    await wOnA(room);
    room.host.request(room.room, { actor, id, to: "W", body: "Backroom's own request: answer in one line." });
    await room.tick(2);
    assert.deepEqual(intoTurn(room, "W"), [], `${id}: nothing went into the turn`);
    room.complete("W", "A fixed.");
    await room.tick(2);
    assert.equal(room.wakes("W"), 2, `${id}: a turn of its own`);
    assert.match(room.prompt("W"), /Backroom's own request/);
    room.close();
  }
});

test("item 18: a member's answer to the Consigliere while he works does not go into his turn; it wakes him once when his turn ends", async () => {
  room = await Room.create();
  const u = room.user("C", "Fix the dates.");
  await room.tick();
  const a = room.post("C", "W", "A: fix dates.ts.");
  await room.tick();
  room.complete("W", "A fixed.");
  await room.tick(2);
  assert.deepEqual(intoTurn(room, "C"), [], "an answer alone does not go into his running turn");
  assert.equal(room.wakes("C"), 1);
  room.complete("C", "Handed to W.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 2, "woken once for W's answer");
  assert.match(room.prompt("C"), /A fixed/);
  room.complete("C", "W fixed it.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(u).length, 1);
  assert.equal(room.wakes("C"), 2, "and only once");
  room.assertQuiet();
});

test("item 18: W's final answering A and a B that went into its turn is one output, and wakes the Consigliere once", async () => {
  room = await Room.create();
  await wOnA(room);
  room.post("C", "W", "B: also fix text.ts.");
  await room.tick();
  room.complete("W", "A and B fixed.");
  await room.tick(2);
  assert.equal(room.outputs().filter((o) => o.author === "W").length, 1);
  assert.equal(room.wakes("C"), 1, "one wake for one reply");
  room.complete("C", "Both done.");
  await room.tick(2);
  room.assertQuiet();
});

// ---------------- item 2: a message T3 shows after the run's last work ----------------

test("item 2: a message T3 records as the run ends and moves to a run of its own is not counted into the first run; its own turn answers it", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.lateSteers = "move";
  const b = room.post("C", "W", "B: also fix text.ts.");
  await room.tick();
  room.complete("W", "A fixed.");
  await room.tick(2);
  const first = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(first.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"]], "the first final answers A only");
  assert.equal(room.wakes("W"), 2, "T3 ran B's message as a turn of its own");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("W"), 2, "adopted: no third turn");
  assert.equal(room.p.events.filter((e) => e.data.kind === "note").length, 0, "nothing imported as a note");
});

test("item 2: a message T3 leaves in the run after its final is never confirmed there; an ordinary turn carries it, once", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.lateSteers = "stay";
  const b = room.post("C", "W", "B: also fix text.ts.");
  await room.tick();
  room.complete("W", "A fixed.");
  room.fake.lateSteers = null;
  await room.tick(3);
  const first = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(first.claims.map((c) => [c.requestId, c.outcome]), [[a, "answered"]]);
  assert.ok(!runsOf(room, "W")[0]!.receipts.some((x) => x.confirmed), "not confirmed into the first run");
  assert.equal(room.wakes("W"), 2, "an ordinary turn for B");
  assert.match(room.prompt("W"), /also fix text\.ts/);
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
});

// ---------------- item 4: turns that take nothing ----------------

test("item 4: nothing goes into a reseat checkpoint's turn or a seat briefing's: the post waits for a turn of its own", async () => {
  for (const [actor, id] of [["$system", "reseat:2"], ["$system", "seat-briefing:W"], ["$user", "seat-briefing:W"]] as const) {
    room = await Room.create();
    room.host.request(room.room, { actor, id, to: "W", body: "Backroom's own request: answer in one line." });
    await room.tick();
    assert.equal(room.running("W"), true, id);
    const b = room.post("C", "W", "B: fix text.ts.");
    await room.tick(2);
    assert.deepEqual(intoTurn(room, "W"), [], `${id}: nothing went into it`);
    room.complete("W", "Acknowledged.");
    await room.tick(2);
    assert.equal(room.answeredClaims(b).length, 0, id);
    assert.equal(room.wakes("W"), 2, `${id}: B in a turn of its own`);
    room.complete("W", "B fixed.");
    await room.tick(2);
    assert.equal(room.answeredClaims(b).length, 1, id);
    room.close();
  }
});

test("item 4: nothing goes into a keep-alive's turn", async () => {
  room = await Room.create();
  await wOnA(room);
  room.complete("W", "A fixed.");
  await room.tick(2);
  room.complete("C", "Done.");
  await room.tick(2);
  const shell = room.fake.thread(room.threadOf("W")).shell;
  room.store.execute(room.room, { type: "keep_alive", actor: "$system", id: `keep-alive:W:${shell.latestRunId}:${shell.latestRunCompletedAt}`, seatId: "W", body: "Nothing to do: reply in one line." });
  await room.tick();
  assert.equal(room.running("W"), true, "the keep-alive's turn");
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick(2);
  assert.deepEqual(intoTurn(room, "W"), []);
  room.complete("W", "Still here.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 0, "the one-line reply answers nothing");
  assert.match(room.prompt("W"), /fix text\.ts/, "B in a turn of its own");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
});

// ---------------- item 7 and item 6: order, and the fallbacks for board posts and corrections ----------------

test("item 7: a post followed at once by a correction makes two offers, in order, each delivered once", async () => {
  room = await Room.create();
  await wOnA(room);
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: b, body: "In text.ts only the slug function." });
  await room.tick();
  const went = intoTurn(room, "W");
  assert.equal(went.length, 2);
  assert.match(went[0]!, /fix text\.ts/);
  assert.match(went[1]!, /only the slug function/);
  assert.doesNotMatch(went[1]!, /\[#\d+ request from @C\]\nB: fix text\.ts/, "the second does not carry the first again");
  room.complete("W", "A and B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("W"), 1);
});

test("item 6: a correction T3 refuses to take into the turn waits: the next ordinary turn carries it exactly once", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.refuseSends = 1;
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Keep the old signature." });
  await room.tick(2);
  assert.deepEqual(intoTurn(room, "W"), []);
  room.complete("W", "A fixed.");
  await room.tick(2);
  assert.deepEqual(room.outputs().filter((o) => o.author === "W").map((o) => o.claims.map((c) => c.outcome)), [["superseded"]], "W had not seen it");
  assert.equal(room.wakes("W"), 2);
  assert.match(room.prompt("W"), /Keep the old signature/);
  room.complete("W", "Signature kept.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("W"), 2);
});

// ---------------- items 9, 10, 11: cancel and Stop ----------------

test("item 9: post B, then cancel A: B went into A's turn, so the cancel waits for the turn's end; the final answers B, A is cancelled, B is never lost", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const b = room.post("C", "W", "B: instead fix text.ts.");
  await room.tick();
  assert.equal(intoTurn(room, "W").length, 1);
  assert.deepEqual(await room.cancel("C", a), { applied: false, deferred: true });
  assert.equal(room.running("W"), true, "B's work is not interrupted");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.state(a), "cancelled");
  assert.equal(room.answeredClaims(b).length, 1);
  assert.deepEqual(room.notices().filter((n) => n.intent === "error"), []);
});

test("item 9: cancel A, then post B, while T3 still ends the turn: B goes into nothing and starts a fresh turn", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.interruptRun = async () => {}; // T3 takes the interrupt, and the turn takes a moment to stop
  assert.deepEqual(await room.cancel("C", a), { applied: true, deferred: false });
  const b = room.post("C", "W", "B: instead fix text.ts.");
  await room.tick(2);
  assert.deepEqual(intoTurn(room, "W"), [], "nothing goes into the turn being stopped");
  room.fake.completeRun(room.threadOf("W"), { text: "(stopped)", outcome: "interrupted" });
  await room.tick(2);
  assert.equal(room.wakes("W"), 2, "B's fresh turn");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.deepEqual(room.notices().filter((n) => n.intent === "error"), []);
});

test("item 9: B in T3 but not yet taken when the cancel of A stops the turn: B is not confirmed into the stopped turn and starts fresh, with no notice", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.lateSteers = "stay"; // T3 records B in the run; the agent has not taken it yet
  room.fake.interruptRun = async () => {};
  const b = room.post("C", "W", "B: instead fix text.ts.");
  await room.tick();
  assert.equal(intoTurn(room, "W").length, 1, "T3 has B in the run");
  assert.deepEqual(await room.cancel("C", a), { applied: true, deferred: false }, "B was not taken: the turn works on A alone");
  room.fake.lateSteers = null;
  // The agent works on after B arrived, then the interrupt lands.
  room.fake.thread(room.threadOf("W")).turnItems.push({ id: "late-work", runId: runsOf(room, "W")[0]!.providerRunId ?? null, nodeId: null, providerTurnId: null, ordinal: 999, status: "completed", title: null, startedAt: null, completedAt: null, updatedAt: new Date(0).toISOString(), type: "reasoning", text: "…", streaming: false });
  await room.tick();
  room.fake.completeRun(room.threadOf("W"), { text: "(stopped)", outcome: "interrupted" });
  await room.tick(2);
  assert.ok(!runsOf(room, "W")[0]!.receipts.some((x) => x.confirmed), "nothing confirmed into the turn being stopped");
  assert.deepEqual(room.notices().filter((n) => n.intent === "error"), [], "B has no error notice");
  assert.equal(room.wakes("W"), 2, "B starts fresh");
  assert.match(room.prompt("W"), /instead fix text\.ts/);
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
});

test("item 10: B cancelled while its message is still on the way to T3 is not sent again; the turn answers A only", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.unavailableSends = 1;
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick();
  assert.deepEqual(intoTurn(room, "W"), [], "the send did not reach T3");
  assert.deepEqual(await room.cancel("C", b), { applied: false, deferred: true });
  const tried = room.fake.attempts.length;
  await room.tick(3);
  assert.equal(room.fake.attempts.length, tried, "not sent again");
  room.complete("W", "A fixed.");
  await room.tick(2);
  assert.equal(room.state(b), "cancelled");
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(b).length, 0);
});

test("item 11: Stop, then a message: nothing goes into the turn being stopped; the message starts a fresh turn and has no part in the stopped turn's notice", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.fake.interruptRun = async () => {}; // the turn takes a moment to stop
  await room.host.stopSeat(room.room, "W");
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick(2);
  assert.deepEqual(intoTurn(room, "W"), []);
  room.fake.completeRun(room.threadOf("W"), { text: "(stopped)", outcome: "interrupted" });
  await room.tick(2);
  const notice = room.notices().find((n) => n.intent === "error")!;
  assert.ok(notice.requestIds.includes(a), "the stopped turn fails with its notice (Retry), as before");
  assert.ok(!notice.requestIds.includes(b), "B is not in it");
  assert.equal(room.wakes("W"), 2, "B's fresh turn");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
});

// ---------------- items 13, 14, 15, 20: restarts and old journals ----------------

test("item 15: the first tick after a deploy takes requests waiting for a busy member into its running turn, in one message", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  // Recorded before the deploy, under the old rules (they waited): no tick between.
  const b = room.post("C", "W", "B: fix text.ts.");
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "Keep the old signature." });
  room.restart();
  await room.tick();
  assert.equal(intoTurn(room, "W").length, 1);
  assert.match(intoTurn(room, "W")[0]!, /fix text\.ts[\s\S]*old signature|old signature[\s\S]*fix text\.ts/);
  room.complete("W", "Both done.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(b).length, 1);
  assert.equal(room.wakes("W"), 1);
});

test("item 20: a journal with old steer: requests and t3steer receipts imports no new notes after a restart, and nothing runs twice", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const old = room.host.request(room.room, { actor: "$user", id: "steer:old-message:0:W", to: "W", body: "Also add a doc comment." }).events[0]!.id;
  await room.tick();
  assert.ok(runsOf(room, "W")[0]!.receipts.some((x) => x.confirmed && x.id.startsWith("t3steer:")));
  room.complete("W", "Done, doc comment added.");
  await room.tick(2);
  const notes = () => room.p.events.filter((e) => e.data.kind === "note").length;
  const events = room.p.events.length;
  room.restart();
  await room.tick(3);
  assert.equal(notes(), 0, "the steered T3 message is the board's, not a note");
  assert.equal(room.wakes("W"), 1);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.answeredClaims(old).length, 1);
  assert.ok(room.p.events.length - events <= 2, "nothing but C's own turn's records");
});

test("item 14: after T3 forgets the thread and counts its runs from 1 again, a message never sent into the old run is not sent into the run that now has its ID; an ordinary turn carries it once", async () => {
  room = await Room.create();
  await wOnA(room);
  const carrierId = runsOf(room, "W")[0]!.providerRunId!;
  // The message leaves, but T3's answer is lost and it never records it.
  const realSend = room.fake.sendMessage.bind(room.fake);
  room.fake.sendMessage = async (input) => {
    if (input.mode.type === "steer") throw new Error("socket closed (simulated)");
    return realSend(input);
  };
  const b = room.post("C", "W", "B: fix text.ts.");
  await room.tick();
  room.fake.sendMessage = realSend;
  // T3 restarts and forgets the thread: the run fails ("T3 no longer has the run"), and the thread counts from 1 again.
  room.fake.threads.delete(room.threadOf("W"));
  await room.fake.launchThread({ commandId: "relaunch:W", threadId: room.threadOf("W"), projectId: "project_demo", title: "room · W", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  const typed = room.fake.startExternalRun(room.threadOf("W"), "looking at something");
  assert.equal(room.fake.thread(room.threadOf("W")).runs[0]!.id, carrierId, "the run typed in T3 has the old run's ID");
  assert.ok(typed);
  await room.tick(3);
  assert.deepEqual(intoTurn(room, "W"), [], "nothing was sent into the run that took the old ID");
  room.fake.completeRun(room.threadOf("W"), { text: "Looked." });
  await room.tick(3);
  assert.match(room.prompt("W"), /fix text\.ts/, "an ordinary turn carries B");
  room.complete("W", "B fixed.");
  await room.tick(2);
  assert.equal(room.answeredClaims(b).length, 1);
});

// ---------------- risk 4: Cursor and Antigravity restart the turn with the message ----------------

test("Cursor and Antigravity: T3 restarts the turn with the message in the same run; its final answers both, posted once, with no follow-up", async () => {
  for (const provider of ["cursor", "antigravity"]) {
    room = await Room.create();
    room.fake.thread(room.threadOf("W")).shell.providerInstanceId = provider;
    const a = await wOnA(room);
    const b = room.post("C", "W", "B: also fix text.ts.");
    await room.tick();
    const t3 = room.fake.thread(room.threadOf("W"));
    assert.equal(t3.runs.length, 1, provider);
    assert.notEqual(t3.runs[0]!.userMessageId, runsOf(room, "W")[0]!.dispatchMessageId, `${provider}: T3 names the message the turn restarted with`);
    room.complete("W", "A and B fixed.");
    await room.tick(3);
    const posts = room.p.events.filter((e) => (e.data.kind === "output" || e.data.kind === "progress" || e.data.kind === "note") && "author" in e.data && e.data.author === "W");
    assert.equal(posts.length, 1, `${provider}: one post for the turn, no follow-up doubling it`);
    assert.equal(room.answeredClaims(a).length, 1, provider);
    assert.equal(room.answeredClaims(b).length, 1, provider);
    room.close();
  }
});

test("the fake follows T3 0.0.46: a message into an unknown or stopped run is refused; into a completed run, it gets a run of its own", async () => {
  room = await Room.create();
  await wOnA(room);
  const W = room.threadOf("W");
  const send = (runId: string, id: string) => room.fake.sendMessage({ commandId: `c-${id}`, threadId: W, messageId: `m-${id}`, text: id, mode: { type: "steer", runId } });
  await assert.rejects(send("run:nowhere", "unknown"), T3CommandRejected);
  const first = room.fake.thread(W).runs[0]!;
  room.fake.completeRun(W, { text: "A fixed." });
  await send(first.id, "after");
  assert.equal(room.fake.thread(W).runs.length, 2, "a completed run: T3 starts a run of its own");
  const second = room.fake.thread(W).runs[1]!;
  room.fake.completeRun(W, { text: "(stopped)", outcome: "interrupted" });
  await assert.rejects(send(second.id, "stopped"), /is interrupted and cannot be steered/);
});
