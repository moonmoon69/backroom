/**
 * "Lean semantics" §3 and R3: turns and messages that did not come from the board become non-waking notes, imported
 * once by their T3 IDs; only the member's own continuation can settle its background work (the reviewer's hunt 4);
 * and input that arrives during a self-started turn waits for it and for its import, then goes out in one run.
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

function snapshot(r: Room) {
  return { events: r.p.events.length, wakes: ["C", "W", "V"].map((s) => r.wakes(s)), runs: r.p.runs.size };
}

test("§3: a turn typed in T3 is two notes, the prompt by the user and the reply by the seat; nobody is woken; a restart adds nothing", async () => {
  room = await Room.create();
  await firstRun(room);
  const before = snapshot(room);
  room.fake.startExternalRun(room.threadOf("W"), "Quick question typed in T3: which node version?");
  await room.tick();
  room.complete("W", "Node 24.");
  await room.tick(2);
  const imported = notes(room);
  assert.deepEqual(imported.map((n) => [n.author, n.body]), [["$user", "Quick question typed in T3: which node version?"], ["W", "Node 24."]]);
  assert.ok(imported.every((n) => n.recipients.length === 0), "notes wake nobody");
  assert.equal(room.p.runs.size, before.runs, "no host run");
  assert.deepEqual([room.wakes("C"), room.wakes("V")], [before.wakes[0], before.wakes[2]]);
  const events = room.p.events.length;
  room.restart();
  await room.tick(3);
  assert.equal(room.p.events.length, events, "re-importing after a restart adds nothing");
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

test("§3: a message another member's agent sends with T3's tools is a note by the sender naming the target; its reply is a note", async () => {
  room = await Room.create();
  await firstRun(room);
  const before = snapshot(room);
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "Can you look at text.ts?");
  await room.tick();
  room.complete("W", "Looked: it is fine.");
  await room.tick(2);
  assert.deepEqual(notes(room).map((n) => [n.author, n.body]), [["V", "To @W (sent in T3): Can you look at text.ts?"], ["W", "Looked: it is fine."]]);
  assert.equal([...room.p.requests.values()].length, 1, "no request is made");
  assert.equal(room.wakes("V"), before.wakes[2], "the sender is not woken by the reply");
  assert.equal(room.wakes("C"), before.wakes[0]);
});

test("§3: a self-started turn with no pending activity is a note under the seat's latest answer; it wakes nobody", async () => {
  room = await Room.create();
  const a = await firstRun(room);
  const before = snapshot(room);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "By the way: the CI also flaked once.");
  await room.tick(3);
  const [note] = notes(room);
  assert.deepEqual([note!.author, note!.body, note!.requestIds], ["W", "By the way: the CI also flaked once.", [a]]);
  assert.deepEqual([room.wakes("C"), room.wakes("V")], [before.wakes[0], before.wakes[2]], "no wakePosterOfLatestJob successor");
});

test("T3 history before the seat's first host run is not imported", async () => {
  room = await Room.create();
  room.fake.startExternalRun(room.threadOf("W"), "old conversation");
  room.complete("W", "old reply");
  await firstRun(room);
  await room.tick(2);
  assert.deepEqual(notes(room), []);
});

test("hunt 4: a turn typed in T3 or sent by another agent is not the member's continuation and settles nothing", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Find the imports, with a subagent.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "running");
  room.complete("W", "A subagent is reading the files.");
  await room.tick();
  assert.equal(room.pendingActivities().length, 1);
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  // Someone types in T3; the turn ends with nothing listed in the background.
  room.fake.startExternalRun(room.threadOf("W"), "Unrelated: what's the time?");
  await room.tick();
  room.complete("W", "10:00.");
  await room.tick();
  assert.equal(room.state(a), "open", "a user's turn does not settle the subagent's request");
  // Another member's agent sends a message that starts a turn.
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "Ping from V.");
  await room.tick();
  room.complete("W", "Pong.");
  await room.tick();
  assert.equal(room.state(a), "open", "another agent's turn does not settle it either");
  assert.equal(room.pendingActivities().length, 1);
  assert.equal(room.wakes("C"), 0);
  // The member's own continuation does.
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "The subagent found: text.ts is unused.");
  await room.tick(2);
  assert.equal(room.state(a), "answered");
  assert.equal(room.wakes("C"), 1);
});

test("R3: input during a self-started turn goes out in one run, after that turn ended and its import was done", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Find the imports, with a subagent.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "running");
  room.complete("W", "Subagent started.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-1", "completed");
  room.fake.startSelfRun(room.threadOf("W"));
  const b = ask(room, "V", "W", "B: and the branch name?");
  const attempts = room.fake.attempts.length;
  await room.tick(3);
  assert.equal(room.fake.attempts.length, attempts, "nothing is sent while the self-started turn runs");
  room.complete("W", "Found: text.ts is unused.");
  await room.tick();
  assert.equal(room.state(a), "answered", "the continuation is imported first");
  const settle = room.p.events.find((e) => e.data.kind === "output" && e.data.association.kind === "activity")!;
  const carriers = [...room.p.runs.values()].filter((r) => r.envelope.inputs.some((i) => i.eventId === b));
  assert.equal(carriers.length, 1, "B is delivered in exactly one run");
  const prepared = room.p.events.find((e) => e.data.kind === "run.prepared" && e.data.run.id === carriers[0]!.id)!;
  assert.ok(prepared.seq > settle.seq, "that run was reserved after the continuation's import");
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
  room.complete("W", "Second job done.");
  await room.tick(2);
  const runs = [...room.p.runs.values()].filter((r) => r.seatId === "W");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.phase === "terminal"));
  assert.equal(notes(room).length, 1, "the self-started turn is a note");
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("R3: a thread with a pending approval or question, or an active run, is not free", () => {
  const shell = { status: "completed", activeRunId: null, pendingRequest: null } as unknown as T3ThreadShell;
  assert.equal(threadFree(shell), true);
  assert.equal(threadFree({ ...shell, pendingRequest: { id: "q", kind: "user_input", createdAt: "" } }), false);
  assert.equal(threadFree({ ...shell, status: "running", activeRunId: "r" }), false);
  assert.equal(threadFree({ ...shell, status: "waiting", activeRunId: "r" }), false);
});
