/**
 * The L1 reviewer's round-1 probes (backroom-handoff/L1-review/probes), kept as regression tests: each failed on fb92aa2
 * (findings F1 to F4) and passes with the fixes. Further tests for the same findings follow them. Since H5 (members
 * only answer) the idle settle is the quiet follow-up, and a turn the host did not start is a follow-up post, not a
 * note; the probes on child requests, explicit answers and `working` went with them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FakeT3Adapter } from "../../src/adapter/fake.ts";
import { createStack } from "../../src/app/bootstrap.ts";
import { parseCommand } from "../../src/domain/commands.ts";
import { FOLLOW_UP } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

const IDLE = "[T3 status of @W: idle]\n\n";

/** W's follow-up posts (turns the host did not start, and quiet follow-ups), oldest first. */
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP ? [{ id: e.id, body: e.data.body, requestIds: e.data.requestIds }] : []));
}

test("P2: the quiet follow-up never brings back a superseded final: the later run's answer, which found the background work ended, is the last word", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "A: fix dates.ts and run slow-check.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  // V's review finding, relayed by C as a correction while W is still in its turn.
  room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "V found the leap-year case is wrong; fix it too." });
  room.complete("W", "STALE: A is done; slow-check running.");
  await room.tick();
  assert.equal(room.state(a), "open", "K1: superseded by the correction W had not seen");
  // The next run delivers the correction; slow-check ends meanwhile; W fixes and ends with nothing in the background.
  assert.equal(room.running("W"), true);
  room.fake.background(room.threadOf("W"), []);
  room.complete("W", "CURRENT: leap-year fixed; slow-check passed.");
  await room.tick();
  room.complete("C", "ok");
  room.clock += 31_000;
  await room.tick(3);
  assert.equal(room.state(a), "answered");
  const answer = room.outputs().find((o) => o.claims.some((c) => c.requestId === a && c.outcome === "answered"))!;
  assert.equal(answer.body, `${IDLE}CURRENT: leap-year fixed; slow-check passed.`);
  assert.deepEqual(followUps(room), [], "the superseded final named slow-check, but W's latest post says idle: no quiet follow-up");
  assert.equal(room.wakes("C"), 1);
  assert.doesNotMatch(room.prompt("C"), /STALE/, "the requester never receives the superseded final");
});

test("P3: a cancel landing while the quiet follow-up reads the thread never yields a late claim or an attention notice", async () => {
  room = await Room.create();
  const ab = [ask(room, "C", "W", "A: run slow-check."), ask(room, "C", "W", "B: and the lint.")];
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "Both running in the background.");
  await room.tick();
  assert.deepEqual(ab.map((id) => room.state(id)), ["answered", "answered"], "nothing holds them");
  room.complete("C", "ok");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  await room.tick(2);
  room.clock += 31_000;
  const cWakes = room.wakes("C");
  let cancelled: Promise<unknown> | null = null;
  room.fake.onDetail = { threadId: room.threadOf("W"), run: () => { cancelled = room.cancel("C", ab[0]!); } };
  await room.tick();
  await cancelled;
  await room.tick(3);
  assert.ok(room.outputs().every((o) => o.claims.every((c) => c.outcome !== "late")), "no late claim");
  assert.deepEqual(room.notices().filter((n) => n.intent === "attention"), [], "no attention notice to the Consigliere");
  assert.deepEqual(followUps(room).map((f) => f.requestIds), [ab], "one quiet follow-up, on both requests");
  assert.equal(room.wakes("C"), cWakes + 1, "C woken once, for the quiet follow-up");
});

test("P4: after the sender of an imported T3 message is reseated (retired), the recipient's thread changing must not stall its dispatch", async () => {
  room = await Room.create();
  // W's first host run sets the baseline; then V's agent messages W with T3's tools (imported as a note by V).
  ask(room, "C", "W", "First job.");
  await room.tick();
  room.complete("W", "First job done.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "Can you look at text.ts?");
  await room.tick();
  room.complete("W", "Looked: fine.");
  await room.tick(2);
  assert.ok(room.p.events.some((e) => e.data.kind === "note" && e.data.author === "V"), "imported as V's note");
  // V is reseated: the core's transfer retires V for a fresh seat on a fresh thread (L4b's reseat).
  await room.fake.launchThread({ commandId: "launch:V2", threadId: "thread:V2", projectId: "project_demo", title: "room · V2", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  room.store.execute(room.room, { type: "transfer", actor: "$user", id: "reseat-V", oldSeatId: "V", newSeatId: "V2", threadId: "thread:V2", owned: [], awaited: [], body: "V reseated.", evidence: "test: V idle" });
  // Then new work for W: it must go out.
  const b = ask(room, "C", "W", "Second job.");
  await room.tick(3);
  assert.equal(room.running("W"), true, "W is dispatched; logs: " + JSON.stringify(room.logs.slice(-3)));
  room.complete("W", "Second job done.");
  await room.tick(2);
  assert.equal(room.state(b), "answered");
  // W's thread has changed since the import, so the host reads its messages again: the third job must still go out.
  const c = ask(room, "C", "W", "Third job.");
  await room.tick(3);
  assert.equal(room.running("W"), true, "W is dispatched again; logs: " + JSON.stringify(room.logs.slice(-2)));
  room.complete("W", "Third job done.");
  await room.tick(2);
  assert.equal(room.state(c), "answered");
});

test("F1/G1: a message another agent sent in T3 is not imported again after a restart, nor after its sender is reseated", async () => {
  room = await Room.create();
  ask(room, "C", "W", "First job.");
  await room.tick();
  room.complete("W", "Done.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "Ping from V.");
  await room.tick();
  room.complete("W", "Pong.");
  await room.tick(2);
  const notes = () => room.p.events.filter((e) => e.data.kind === "note").map((e) => [(e.data as { author: string }).author, (e.data as { body: string }).body]);
  const replies = () => followUps(room).map((f) => f.body);
  assert.deepEqual(notes(), [["V", "To @W (sent in T3): Ping from V."]]);
  assert.deepEqual(replies(), [`${IDLE}Pong.`], "W's reply is a follow-up on its first job");
  assert.equal(room.wakes("C"), 2, "and wakes C");
  room.complete("C", "ok");
  await room.tick();
  room.restart();
  await room.tick(3);
  assert.deepEqual([notes().length, replies().length], [1, 1], "a restart adds nothing");
  await room.fake.launchThread({ commandId: "launch:V2", threadId: "thread:V2", projectId: "project_demo", title: "room · V2", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  room.store.execute(room.room, { type: "transfer", actor: "$user", id: "reseat-V", oldSeatId: "V", newSeatId: "V2", threadId: "thread:V2", owned: [], awaited: [], body: "V reseated.", evidence: "test: V idle" });
  room.restart();
  await room.tick(3);
  assert.deepEqual([notes().length, replies().length], [1, 1], "nor does the sender's retirement");
  assert.equal(room.wakes("C"), 2);
  // A message from the retired seat's thread that arrives later is posted by the recipient, naming the sender.
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "A late ping from V's old thread.");
  await room.tick();
  room.complete("W", "Pong again.");
  await room.tick(2);
  assert.deepEqual(notes().slice(1), [["W", "From @V (sent in T3): A late ping from V's old thread."]]);
  assert.deepEqual(replies().slice(1), [`${IDLE}Pong again.`]);
  assert.equal(room.wakes("C"), 3);
  assert.deepEqual(room.logs.filter((l) => /waits/.test(l.message)), [], "no import ever waits");
});

test("G1: a self-started turn's follow-up is not imported again after a restart", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "First job.");
  await room.tick();
  room.complete("W", "Done.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "By the way: CI flaked once.");
  await room.tick();
  assert.deepEqual(followUps(room).map((f) => [f.body, f.requestIds]), [[`${IDLE}By the way: CI flaked once.`, [a]]]);
  assert.equal(room.wakes("C"), 2);
  room.complete("C", "ok");
  await room.tick();
  room.restart();
  await room.tick(3);
  assert.equal(followUps(room).length, 1);
  assert.equal(room.p.events.filter((e) => e.data.kind === "note").length, 0);
  assert.equal(room.wakes("C"), 2);
});

test("N3: a crash right after a continuation's follow-up leaves nothing for the quiet follow-up", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "A: run slow-check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  const b = ask(room, "C", "W", "B: run lint in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check", "lint"]);
  room.complete("W", "lint started.");
  await room.tick();
  assert.deepEqual([room.state(a), room.state(b)], ["answered", "answered"]);
  assert.deepEqual(room.pendingActivities(), []);
  room.complete("C", "ok");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.crashOnce("imported", "W");
  room.complete("W", "slow-check and lint both passed.");
  await room.tick(3);
  assert.deepEqual(room.crashes, ["imported:W"]);
  room.clock += 60_000;
  await room.tick(3);
  assert.deepEqual(followUps(room).map((f) => [f.body, f.requestIds]), [[`${IDLE}slow-check and lint both passed.`, [b]]], "one follow-up, by the continuation, not the quiet follow-up");
  assert.equal(room.wakes("C"), 3);
  assert.equal(room.answeredClaims(a).length + room.answeredClaims(b).length, 2);
});

// ---------------- review round 2 ----------------

/** A flag-on stack with one member seated through the engine and its first request dispatched. */
async function flagStack(engine: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-r2-"));
  const s = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null, engine });
  const fake = s.adapter as FakeT3Adapter;
  const { roomId } = (await s.service.execute(parseCommand({ type: "room.create", projectId: "project_demo", title: "engine" }))) as { roomId: string };
  const { participantId } = (await s.service.execute(parseCommand({ type: "participant.create", roomId, alias: "worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } }))) as { participantId: string };
  const binding = s.repos.currentBinding(participantId)!;
  return { s, fake, roomId, participantId, binding, close: () => { s.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("P5: with the flag on, a question a member's run raises reaches Backroom's native-requests path", async () => {
  const { s, fake, roomId, participantId, binding, close } = await flagStack(true);
  try {
    assert.ok(s.engine!.view(roomId).seats.has(binding.id), "participant.create seats the member on the board (L4b)");
    s.engine!.request(roomId, { actor: "$user", id: "req-1", to: binding.id, body: "Do the thing; ask me if unsure." });
    await s.scheduler.tick();
    assert.equal(fake.threads.get(binding.threadId)!.runs.length, 1, "dispatched by the host");
    fake.raiseQuestion(binding.threadId, { requestId: "q-1" });
    await s.scheduler.tick();
    await s.scheduler.tick();
    assert.deepEqual(s.repos.listOpenNativeRequests([participantId]).map((r) => r.requestId), ["q-1"], "the member's question is on Backroom's native-requests path, where the user can answer it");
  } finally {
    close();
  }
});

test("F5: with the flag on, the user answers through Backroom; a request T3 resolves itself is resolved; the seat gets work again", async () => {
  const { s, fake, roomId, participantId, binding, close } = await flagStack(true);
  try {
    assert.ok(s.engine!.view(roomId).seats.has(binding.id), "participant.create seats the member on the board (L4b)");
    s.engine!.request(roomId, { actor: "$user", id: "req-1", to: binding.id, body: "First job." });
    await s.scheduler.tick();
    fake.raiseQuestion(binding.threadId, { requestId: "q-1" });
    await s.scheduler.tick();
    await s.service.execute(parseCommand({ type: "native.userInput.respond", participantId, requestId: "q-1", answers: { "Proceed?": "yes" } }));
    assert.deepEqual(s.repos.listOpenNativeRequests([participantId]), [], "answered through the service");
    fake.raiseApproval(binding.threadId, "a-1");
    await s.scheduler.tick();
    assert.deepEqual(s.repos.listOpenNativeRequests([participantId]).map((r) => [r.requestId, r.kind]), [["a-1", "approval"]]);
    await fake.respondApproval({ commandId: "in-t3", threadId: binding.threadId, requestId: "a-1", decision: "accept" });
    await s.scheduler.tick();
    assert.deepEqual(s.repos.listOpenNativeRequests([participantId]), [], "resolved in T3, resolved here");
    fake.completeRun(binding.threadId, { text: "First job done." });
    s.engine!.request(roomId, { actor: "$user", id: "req-2", to: binding.id, body: "Second job." });
    await s.scheduler.tick();
    await s.scheduler.tick();
    assert.equal(fake.threads.get(binding.threadId)!.runs.length, 2, "the seat gets work again");
  } finally {
    close();
  }
});

test("F5 control: without the flag, the old scheduler mirrors the same question", async () => {
  const { s, fake, roomId, participantId, binding, close } = await flagStack(false);
  try {
    await s.service.execute(parseCommand({ type: "message.create", roomId, assignments: [{ recipients: [participantId], instruction: "Do the thing." }] }));
    await s.scheduler.tick();
    fake.raiseQuestion(binding.threadId, { requestId: "q-1" });
    await s.scheduler.tick();
    assert.deepEqual(s.repos.listOpenNativeRequests([participantId]).map((r) => r.requestId), ["q-1"]);
  } finally {
    close();
  }
});
