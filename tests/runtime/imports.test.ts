/**
 * "Lean semantics" §3 and R3, as H5 left them: messages that did not come from the board (typed in T3, sent by another
 * agent) become non-waking notes, and the reply of every turn the host did not start is a follow-up post on the
 * member's latest answered request that wakes the orchestrator, each imported once by its T3 ID; and input that
 * arrives during a self-started turn waits for it and for its import, then goes out in one run.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { T3ThreadShell } from "../../src/adapter/types.ts";
import { threadFree } from "../../src/runtime/t3.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

/** W's first host run, answered: the T3 history before it is the thread's, after it the room's. */
async function firstRun(r: Room): Promise<string> {
  const a = ask(r, "C", "W", "First job.");
  await r.tick();
  r.complete("W", "First job done.");
  await r.tick();
  r.complete("C", "ok");
  await r.tick();
  return a;
}

function notes(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "note" ? [{ id: e.id, author: e.data.author, body: e.data.body, requestIds: e.data.requestIds, recipients: e.data.recipients }] : []));
}

/** Follow-up posts (H5): the replies of turns the host did not start, by the seat, on its latest answered request. */
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.milestone === "follow-up" ? [{ id: e.id, author: e.data.author, body: e.data.body, requestIds: e.data.requestIds, recipients: e.data.recipients }] : []));
}

/** The T3 run IDs of a seat's thread, newest last. */
function t3RunIds(r: Room, seat: string): string[] {
  return r.fake.runsOf(r.threadOf(seat)).map((x) => x.id);
}

function snapshot(r: Room) {
  return { events: r.p.events.length, wakes: ["C", "W", "V"].map((s) => r.wakes(s)), runs: r.p.runs.size };
}

test("§3: a turn typed in T3: the prompt is a note by the user, the reply a follow-up by the seat that wakes the orchestrator once; a restart adds nothing", async () => {
  room = await Room.create();
  const a = await firstRun(room);
  const before = snapshot(room);
  const typed = room.fake.startExternalRun(room.threadOf("W"), "Quick question typed in T3: which node version?");
  await room.tick();
  room.complete("W", "Node 24.");
  await room.tick(2);
  const imported = notes(room);
  assert.deepEqual(imported.map((n) => [n.author, n.body]), [["$user", "Quick question typed in T3: which node version?"]]);
  assert.ok(imported.every((n) => n.recipients.length === 0), "notes wake nobody");
  assert.deepEqual(followUps(room).map((f) => [f.id, f.author, f.body, f.requestIds]), [[`t3run:${room.threadOf("W")}:${typed}`, "W", "[T3 status of @W: idle]\n\nNode 24.", [a]]], "the reply is a follow-up on W's latest answer");
  assert.equal([...room.p.runs.values()].filter((r) => r.seatId === "W").length, 1, "no host run on W");
  assert.equal(room.wakes("C"), before.wakes[0]! + 1, "the follow-up wakes the orchestrator, once");
  assert.match(room.prompt("C"), /Node 24\./);
  assert.equal(room.wakes("V"), before.wakes[2]);
  room.complete("C", "ok");
  await room.tick(2);
  const events = room.p.events.length;
  room.restart();
  await room.tick(3);
  assert.equal(room.p.events.length, events, "re-importing after a restart adds nothing");
  assert.equal(room.wakes("C"), before.wakes[0]! + 1);
});

test("§3: a note typed into a running room turn is a note by the user", async () => {
  room = await Room.create();
  await firstRun(room);
  const a = ask(room, "C", "W", "Second job.");
  await room.tick();
  room.fake.sendUserMessage(room.threadOf("W"), "Also check the leap years.");
  await room.tick();
  assert.deepEqual(notes(room).map((n) => [n.author, n.body]), [["$user", "Also check the leap years."]]);
  room.complete("W", "Done, leap years too.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  room.restart();
  await room.tick(2);
  assert.equal(notes(room).length, 1, "re-importing after a restart adds nothing");
});

test("§3: a message another member's agent sends with T3's tools is a note by the sender naming the target; its reply is a follow-up that wakes the orchestrator", async () => {
  room = await Room.create();
  const a = await firstRun(room);
  const before = snapshot(room);
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "Can you look at text.ts?");
  await room.tick();
  const turn = t3RunIds(room, "W").at(-1)!;
  room.complete("W", "Looked: it is fine.");
  await room.tick(2);
  assert.deepEqual(notes(room).map((n) => [n.author, n.body]), [["V", "To @W (sent in T3): Can you look at text.ts?"]]);
  assert.deepEqual(followUps(room).map((f) => [f.id, f.author, f.body, f.requestIds]), [[`t3run:${room.threadOf("W")}:${turn}`, "W", "[T3 status of @W: idle]\n\nLooked: it is fine.", [a]]]);
  assert.equal([...room.p.requests.values()].length, 1, "no request is made");
  assert.equal(room.wakes("V"), before.wakes[2], "the sender is not woken by the reply");
  assert.equal(room.wakes("C"), before.wakes[0]! + 1, "the orchestrator is, once");
  assert.match(room.prompt("C"), /Looked: it is fine/);
});

test("§3: a self-started turn is a follow-up on the seat's latest answer; it wakes the orchestrator once", async () => {
  room = await Room.create();
  const a = await firstRun(room);
  const before = snapshot(room);
  const self = room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "By the way: the CI also flaked once.");
  await room.tick(3);
  assert.deepEqual(notes(room), [], "T3's notice that started the turn is not imported");
  assert.deepEqual(followUps(room).map((f) => [f.id, f.author, f.body, f.requestIds]), [[`t3run:${room.threadOf("W")}:${self}`, "W", "[T3 status of @W: idle]\n\nBy the way: the CI also flaked once.", [a]]]);
  assert.equal(room.p.subscriptions.filter((x) => x.seatId === "C" && x.requestId === a).length, 1, "the host subscribed the orchestrator to A");
  assert.deepEqual([room.wakes("C"), room.wakes("V")], [before.wakes[0]! + 1, before.wakes[2]], "the orchestrator is woken once; nobody else");
});

test("T3 history before the seat's first host run is not imported", async () => {
  room = await Room.create();
  room.fake.startExternalRun(room.threadOf("W"), "old conversation");
  room.complete("W", "old reply");
  await firstRun(room);
  await room.tick(2);
  assert.deepEqual(notes(room), []);
});

test("R3: input during a self-started turn goes out in one run, after that turn ended and its import was done", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Find the imports, with a subagent.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "running");
  room.complete("W", "Subagent started.");
  await room.tick();
  assert.equal(room.state(a), "answered", "W's final answers A: nothing is held since H5");
  room.complete("C", "ok");
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  room.fake.startSelfRun(room.threadOf("W"));
  const b = ask(room, "C", "W", "B: and the branch name?");
  const sends = () => room.fake.attempts.filter((x) => x.threadId === room.threadOf("W")).length;
  const attempts = sends();
  await room.tick(3);
  assert.equal(sends(), attempts, "nothing is sent while the self-started turn runs");
  room.complete("W", "Found: text.ts is unused.");
  await room.tick();
  const follow = room.p.events.find((e) => e.data.kind === "progress" && e.data.author === "W")!;
  assert.ok(follow, "the continuation is imported first, as a follow-up");
  const carriers = [...room.p.runs.values()].filter((r) => r.envelope.inputs.some((i) => i.eventId === b));
  assert.equal(carriers.length, 1, "B is delivered in exactly one run");
  const prepared = room.p.events.find((e) => e.data.kind === "run.prepared" && e.data.run.id === carriers[0]!.id)!;
  assert.ok(prepared.seq > follow.seq, "that run was reserved after the continuation's import");
  room.complete("W", "engine-l1.");
  await room.tick();
  assert.equal(room.state(b), "answered");
});

test("R3: a host message T3 queues behind a self-started turn runs once, after it", async () => {
  room = await Room.create();
  await firstRun(room);
  ask(room, "C", "W", "Second job.");
  // The thread looks free when the host checks, then the member starts a turn of its own before the message lands.
  room.fake.onDetail = { threadId: room.threadOf("W"), run: () => void room.fake.startSelfRun(room.threadOf("W")) };
  await room.tick();
  const t3Runs = room.fake.runsOf(room.threadOf("W"));
  assert.deepEqual(t3Runs.slice(-2).map((r) => r.status), ["running", "queued"]);
  room.complete("W", "My own follow-up.");
  await room.tick(2);
  assert.equal(room.running("W"), true, "the queued host run started after it");
  // H5: the self-started turn's reply is a follow-up, and wakes the orchestrator.
  assert.equal(room.running("C"), true);
  room.complete("C", "ok");
  room.complete("W", "Second job done.");
  await room.tick(2);
  const runs = [...room.p.runs.values()].filter((r) => r.seatId === "W");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.phase === "terminal"));
  assert.deepEqual(notes(room), []);
  // Its status says a turn runs: T3 started the queued host run as the self-started turn ended.
  assert.deepEqual(followUps(room).map((f) => f.body), ["[T3 status of @W: a turn is running (T3 lists no background tasks while it runs)]\n\nMy own follow-up."], "the self-started turn is one follow-up");
  room.complete("C", "ok");
  await room.tick(2);
  // C: the first job's answer, the follow-up, the second job's answer.
  assert.equal(room.wakes("C"), 3);
  room.assertQuiet();
});

test("R3: a thread with a pending approval or question, or an active run, is not free", () => {
  const shell = { status: "completed", activeRunId: null, pendingRequest: null } as unknown as T3ThreadShell;
  assert.equal(threadFree(shell), true);
  assert.equal(threadFree({ ...shell, pendingRequest: { id: "q", kind: "user_input", createdAt: "" } }), false);
  assert.equal(threadFree({ ...shell, status: "running", activeRunId: "r" }), false);
  assert.equal(threadFree({ ...shell, status: "waiting", activeRunId: "r" }), false);
});
