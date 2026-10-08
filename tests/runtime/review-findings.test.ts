/**
 * The L1 reviewer's round-1 probes (backroom-handoff/L1-review/probes), kept as regression tests: each failed on fb92aa2
 * (findings F1 to F4) and passes with the fixes. Further tests for the same findings follow them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FakeT3Adapter } from "../../src/adapter/fake.ts";
import { createStack } from "../../src/app/bootstrap.ts";
import { parseCommand } from "../../src/domain/commands.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

test("P1: a cancel that stops W's turn on X's question must not turn into an error notice on W's own outer request (walk passes the closed request)", async () => {
  // C asks W for A. W asks X to review (S, child of A). X asks W a question (Q, child of S, owned by W).
  room = await Room.create({ seats: ["C", "W", "X"] });
  const a = ask(room, "C", "W", "A: fix dates.ts and have X review it.");
  await room.tick();
  const s = room.post("W", "X", "S: please review my dates.ts fix.");
  room.complete("W", "Fix written; review asked.");
  await room.tick();
  assert.equal(room.running("X"), true);
  const q = room.post("X", "W", "Q: which branch is the fix on?");
  assert.equal(room.p.requests.get(q)!.parentId, s);
  room.complete("X", "Asked W which branch.");
  await room.tick();
  assert.equal(room.running("W"), true, "W is woken by Q");
  const cWakes = room.wakes("C");
  // X finds the branch itself and withdraws Q: W's turn has only Q, so it is interrupted.
  assert.deepEqual(await room.cancel("X", q), { applied: true, deferred: false });
  await room.tick(3);
  assert.equal(room.state(a), "open");
  const errors = room.notices().filter((n) => n.intent === "error");
  assert.deepEqual(errors.map((n) => n.recipients), [], "a cancel-stopped turn about Q raises no failure notice on A");
  assert.equal(room.wakes("C"), cWakes, "the Consigliere is not woken because X withdrew a question to W");
});

test("P2: (iii) idle settle must not re-import a superseded final when a later run already answered the request", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "A: fix dates.ts, run slow-check, have V review.");
  await room.tick();
  room.post("W", "V", "Review dates.ts while I run slow-check.");
  await room.tick();
  assert.equal(room.running("V"), true);
  room.complete("V", "Finding: the leap-year case is wrong.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "STALE: A is done; slow-check running.");
  await room.tick();
  assert.equal(room.state(a), "open", "K1: superseded by V's unread finding, and held by slow-check");
  // Next run delivers the finding; slow-check ends meanwhile; W fixes and ends with nothing in the background.
  assert.equal(room.running("W"), true);
  room.fake.background(room.threadOf("W"), []);
  room.complete("W", "CURRENT: leap-year fixed; slow-check passed.");
  await room.tick();
  room.clock += 31_000;
  await room.tick(3);
  assert.equal(room.state(a), "answered");
  const answer = room.outputs().find((o) => o.claims.some((c) => c.requestId === a && c.outcome === "answered"))!;
  assert.doesNotMatch(answer.body, /STALE/, "the requester must not receive the superseded first final as A's answer");
  assert.match(answer.body, /CURRENT/);
});

test("P3: a cancel landing while the idle settle reads the thread never yields a late claim or an attention notice", async () => {
  room = await Room.create();
  const ab = [ask(room, "C", "W", "A: run slow-check."), ask(room, "C", "W", "B: and the lint.")];
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "Both running in the background.");
  await room.tick();
  assert.deepEqual(ab.map((id) => room.state(id)), ["open", "open"]);
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
  assert.equal(room.state(ab[1]!), "answered");
  assert.equal(room.wakes("C"), cWakes + 1, "C woken once, for B's answer");
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

test("F2: an explicit answer of the seat's own request during the turn is taken out of T, not passed up to its parent", async () => {
  room = await Room.create({ seats: ["C", "W", "X"] });
  const a = ask(room, "C", "W", "A: fix dates.ts and have X review it.");
  await room.tick();
  const s = room.post("W", "X", "S: please review my dates.ts fix.");
  room.complete("W", "Review asked.");
  await room.tick();
  const q = room.post("X", "W", "Q: which branch is the fix on?");
  room.complete("X", "Asked W.");
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.deepEqual(room.answer("W", "engine-w.", [q]).map((c) => c.outcome), ["answered"]);
  room.complete("W", "Answered X's question.");
  await room.tick();
  const final = room.outputs().filter((o) => o.author === "W" && o.association.kind === "run").pop()!;
  assert.deepEqual(final.disposition, { kind: "yield" }, "T is empty: Q was answered, and A is not reached through it");
  assert.equal(room.state(a), "open");
  assert.equal(room.state(s), "open");
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
  assert.deepEqual(notes(), [["V", "To @W (sent in T3): Ping from V."], ["W", "Pong."]]);
  room.restart();
  await room.tick(3);
  assert.deepEqual(notes().length, 2, "a restart adds nothing");
  await room.fake.launchThread({ commandId: "launch:V2", threadId: "thread:V2", projectId: "project_demo", title: "room · V2", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  room.store.execute(room.room, { type: "transfer", actor: "$user", id: "reseat-V", oldSeatId: "V", newSeatId: "V2", threadId: "thread:V2", owned: [], awaited: [], body: "V reseated.", evidence: "test: V idle" });
  room.restart();
  await room.tick(3);
  assert.deepEqual(notes().length, 2, "nor does the sender's retirement");
  // A message from the retired seat's thread that arrives later is posted by the recipient, naming the sender.
  room.fake.sendAgentMessage(room.threadOf("W"), room.threadOf("V"), "A late ping from V's old thread.");
  await room.tick();
  room.complete("W", "Pong again.");
  await room.tick(2);
  assert.deepEqual(notes().slice(2), [["W", "From @V (sent in T3): A late ping from V's old thread."], ["W", "Pong again."]]);
  assert.deepEqual(room.logs.filter((l) => /waits/.test(l.message)), [], "no import ever waits");
});

test("G1: a self-started turn's note is not imported again after a restart", async () => {
  room = await Room.create();
  ask(room, "C", "W", "First job.");
  await room.tick();
  room.complete("W", "Done.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "By the way: CI flaked once.");
  await room.tick();
  const count = () => room.p.events.filter((e) => e.data.kind === "note").length;
  assert.equal(count(), 1);
  room.restart();
  await room.tick(3);
  assert.equal(count(), 1);
});

test("N3: a crash between the settles of several bg: activities leaves none for the idle settle", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "A: run slow-check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  const b = ask(room, "V", "W", "B: run lint in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check", "lint"]);
  room.complete("W", "lint started.");
  await room.tick();
  assert.equal(room.pendingActivities().length, 2);
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.crashOnce("settled", "W");
  room.complete("W", "slow-check and lint both passed.");
  await room.tick(3);
  assert.deepEqual(room.crashes, ["settled:W"]);
  assert.equal(room.state(a), "answered");
  assert.equal(room.state(b), "answered");
  const bodies = room.outputs().filter((o) => o.claims.some((c) => c.outcome === "answered" && (c.requestId === a || c.requestId === b))).map((o) => o.body);
  assert.deepEqual(bodies, ["slow-check and lint both passed.", "slow-check and lint both passed."], "both settled by the continuation, not the idle settle");
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

test("P6: an answer with no #n in a continuation must not close another job's request the member is still working on", async () => {
  room = await Room.create();
  const b = ask(room, "C", "W", "B: watch the deploy and tell me when it is live.");
  await room.tick();
  room.working("W", "Watching the deploy; I will answer B when it is live.");
  room.complete("W", "Watching.");
  await room.tick();
  const x = ask(room, "V", "W", "X: run slow-check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  let refused = false;
  try { room.answer("W", "slow-check passed."); } catch { refused = true; }
  assert.equal(room.state(b), "open", "B (the deploy W is still watching) is not closed by an answer about slow-check");
  if (!refused) assert.equal(room.state(x), "answered");
});

test("P7: with no #n in a continuation, working is refused and names the candidates; named, it holds only that job, and the other settles when its work ends", async () => {
  room = await Room.create();
  const x = ask(room, "V", "W", "X: run slow-check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  const y = ask(room, "C", "W", "Y: run lint in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check", "lint"]);
  room.complete("W", "lint started.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["lint"]);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  // The reviewer's P7 asserts X stays open whether working is refused or acts on X; with a refusal nothing holds X, so
  // the idle settle closes it as §2 (iii) says. The member is told to name it, and does.
  assert.throws(() => room.working("W", "slow-check failed; fixing it."), /Several of your requests are still open with work going on: #ask-V:\d+ \(from @V: "X: run slow-check in the background\."\), #ask-C:\d+ \(from @C: "Y: run lint in the background\."\)\. Say which this is about: rooms-board working #n/);
  room.working("W", "slow-check failed; fixing it.", [x]);
  room.complete("W", "Fixing slow-check.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  await room.tick();
  room.clock += 31_000;
  await room.tick(3);
  assert.equal(room.state(y), "answered", "lint's request settles once lint ends");
  assert.equal(room.state(x), "open", "X is held by the member's mark");
});

test("F6: with one candidate, answer and working with no #n act on it; in a live run the turn's requests stay the default", async () => {
  room = await Room.create();
  const x = ask(room, "C", "W", "X: run slow-check in the background.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check"]);
  room.complete("W", "slow-check started.");
  await room.tick();
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  assert.deepEqual(room.working("W", "slow-check failed; fixing.").requestIds, [x]);
  assert.deepEqual(room.answer("W", "slow-check passed after the fix.").map((c) => [c.requestId, c.outcome]), [[x, "answered"]]);
  room.complete("W", "Done.");
  await room.tick();
  const a = ask(room, "C", "W", "A.");
  const b = ask(room, "C", "W", "B.");
  await room.tick();
  assert.deepEqual(room.working("W", "Both take a while.").requestIds.sort(), [a, b].sort(), "in a live run, the turn's requests");
});
