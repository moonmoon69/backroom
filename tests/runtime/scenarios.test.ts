/**
 * Regression scenarios from Development's fake comparison (D#290, D#316), rebuilt on the lean host and, since H5
 * (members only answer), on the relayed design: only the orchestrator and the user post, the orchestrator relays every
 * review, every member reply wakes it once, and its first final answers the user while its later ones are updates.
 * They are regression tests, not the integration gate (that is the real comparison, Z1).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { T3TurnItem, TurnImage } from "../../src/adapter/types.ts";
import type { Input } from "../../src/engine/index.ts";
import { FOLLOW_UP } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const IDLE = "[T3 status of @W: idle]\n\n";

/** The engine runs of a seat, oldest first, with what each delivered. */
function runsOf(r: Room, seat: string) {
  return [...r.p.runs.values()].filter((x) => x.seatId === seat).sort((a, b) => a.envelope.through - b.envelope.through);
}

/** A wake is redundant when it delivers no actionable input (request, correction, result, retry, transfer) that is new. */
function redundantWakes(r: Room, seat: string): number {
  const seen = new Set<string>();
  let redundant = 0;
  for (const run of runsOf(r, seat)) {
    const fresh = run.envelope.inputs.filter((i: Input) => ["request", "correction", "result", "retry", "transfer"].includes(i.intent) && !seen.has(i.eventId));
    if (fresh.length === 0) redundant += 1;
    for (const i of run.envelope.inputs) seen.add(i.eventId);
  }
  return redundant;
}

/** W's follow-up posts, oldest first. */
function followUps(r: Room) {
  return r.p.events.flatMap((e) => (e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP ? [{ id: e.id, body: e.data.body, requestIds: e.data.requestIds }] : []));
}

function toolItem(r: Room, seat: string, item: Record<string, unknown>): void {
  const thread = r.fake.thread(r.threadOf(seat));
  const run = thread.runs.find((x) => x.status === "running")!;
  const at = new Date().toISOString();
  thread.turnItems.push({ id: `item:${r.id("tool")}`, runId: run.id, nodeId: `node:${run.id}:root`, providerTurnId: null, ordinal: thread.turnItems.length + 1, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at, ...item } as T3TurnItem);
}

test("H1, the five-wake incident (D#149/#153), relayed: every Consigliere wake delivers something new, and none comes after the report", async () => {
  room = await Room.create({ seats: ["C", "W", "X", "V"] });
  const u = room.user("C", "Build the feature with review, then report.");
  await room.tick();
  const a = room.post("C", "W", "A: implement slugify.");
  const b = room.post("C", "X", "B: add the --json flag.");
  room.complete("C", "Handed A to W and B to X.");
  await room.tick();
  assert.equal(room.state(u), "answered", "C's hand-off answers the user");
  room.complete("X", "B done: --json added.");
  room.complete("W", "A done: slugify in src/text.ts.");
  await room.tick();
  assert.equal(room.running("C"), true, "C is woken by A's and B's answers, in one run");
  assert.match(room.prompt("C"), /A done[\s\S]*B done|B done[\s\S]*A done/);
  // The review is relayed: C asks V, and V's finding comes back to C.
  const r1 = room.post("C", "V", "Review W's slugify in src/text.ts.");
  room.complete("C", "Sent A to V for review.");
  await room.tick();
  room.complete("V", "Finding: unicode is not handled.");
  await room.tick();
  assert.equal(room.running("C"), true, "V's finding wakes C");
  const a2 = room.post("C", "W", "A2: fix slugify: unicode is not handled (V's review).");
  await room.tick();
  assert.equal(room.running("W"), true);
  // A correction during the exchange (the incident's review-correction steer), after W's run took A2.
  room.host.correct(room.room, { actor: "C", id: "correct-A2", requestId: a2, body: "Also strip accents." });
  room.complete("C", "Relayed V's finding to W.");
  room.complete("W", "Fixed unicode.");
  await room.tick();
  assert.equal(room.state(a2), "open", "the correction came after W's watermark: its final is superseded");
  assert.match(room.prompt("W"), /Also strip accents/);
  room.complete("W", "A2 done: slugify handles unicode and strips accents.");
  await room.tick();
  assert.equal(room.running("C"), true, "A2's answer wakes C");
  const r2 = room.post("C", "V", "Review slugify again: unicode and accents.");
  room.complete("C", "Asked V to review again.");
  await room.tick();
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.running("C"), true, "the PASS wakes C");
  room.complete("C", "Report: A and B done, A reviewed PASS. JOB-DONE");
  await room.tick();
  const afterReport = room.wakes("C");
  await room.tick(10);
  assert.equal(room.wakes("C"), afterReport, "0 wakes after the report");
  assert.equal(room.wakes("C"), 5, "C woke for U, A's and B's answers, V's finding, A2's answer and V's PASS");
  for (const seat of ["C", "W", "X", "V"]) assert.equal(redundantWakes(room, seat), 0, `${seat} had a redundant wake`);
  for (const id of [u, a, b, r1, a2, r2]) assert.equal(room.answeredClaims(id).length, 1, `#${id} answered once`);
  assert.deepEqual(room.outputs().filter((o) => o.author === "C").map((o) => o.disposition.kind), ["answer", "yield", "yield", "yield", "yield"], "C's later finals are updates");
  assert.deepEqual(room.p.events.filter((e) => e.data.kind === "note"), [], "no host run came back as a T3-originated note");
  room.assertQuiet(["C", "W", "X", "V"]);
});

test("H2: each continuation turn after an answer is one follow-up on it, waking C once; nobody else wakes", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Run the tests.");
  await room.tick();
  room.complete("W", "Tests pass.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  assert.equal(room.state(a), "answered");
  const [c0, v0] = [room.wakes("C"), room.wakes("V")];
  for (let i = 0; i < 3; i += 1) {
    room.fake.startSelfRun(room.threadOf("W"));
    await room.tick();
    room.complete("W", `Background watcher ${i} finished.`);
    await room.tick();
    assert.equal(room.wakes("C"), c0 + i + 1, `continuation ${i} wakes C once`);
    assert.match(room.prompt("C"), new RegExp(`watcher ${i} finished`));
    room.complete("C", "ok");
    await room.tick();
  }
  await room.tick(3);
  assert.deepEqual([room.wakes("C"), room.wakes("V")], [c0 + 3, v0], "one wake of C per continuation, none of V");
  assert.deepEqual(followUps(room).map((f) => [f.body, f.requestIds]), [0, 1, 2].map((i) => [`${IDLE}Background watcher ${i} finished.`, [a]]));
  assert.equal(room.p.events.filter((e) => e.data.kind === "note").length, 0);
  assert.equal(room.answeredClaims(a).length, 1);
  room.assertQuiet();
});

test("S3: a burst while busy goes out in one run, and one late result in exactly one more", async () => {
  room = await Room.create({ seats: ["C", "W", "X", "V"] });
  const u = room.user("C", "Start.");
  await room.tick();
  const a = room.post("C", "W", "A.");
  const b = room.post("C", "X", "B.");
  await room.tick();
  room.complete("W", "A done.");
  room.complete("X", "B done.");
  const also = room.user("C", "Also this.");
  const and = room.user("C", "And that.");
  await room.tick();
  assert.equal(room.wakes("C"), 1, "C is still in its first run");
  const c1 = room.user("C", "The user asks C something more.");
  room.complete("C", "Handed out.");
  await room.tick();
  assert.equal(room.wakes("C"), 2);
  for (const text of ["A done", "B done", "Also this", "And that", "asks C something more"]) assert.match(room.prompt("C"), new RegExp(text));
  const late = room.post("C", "W", "One more: A2.");
  room.complete("C", "All handled.");
  await room.tick();
  room.complete("W", "A2 done.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 3, "exactly one more wake for the late result");
  assert.match(room.prompt("C"), /A2 done/);
  room.complete("C", "Done.");
  await room.tick(2);
  for (const id of [u, a, b, also, and, c1, late]) assert.equal(room.state(id), "answered");
  assert.equal(redundantWakes(room, "C"), 0);
  room.assertQuiet(["C", "W", "X", "V"]);
});

test("S5: an early message and a later final, with a restart: the final alone answers, once; one wake", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Find the bug.");
  await room.tick();
  assert.equal(room.running("W"), true);
  room.restart();
  room.complete("W", "Handoff: the bug is at dates.ts:12; no changes.", { progress: ["Found it: dates.ts:12."] });
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  const answer = room.outputs().find((o) => o.claims.some((c) => c.requestId === a && c.outcome === "answered"))!;
  assert.equal(answer.body, `${IDLE}Handoff: the bug is at dates.ts:12; no changes.`, "the run's final is the answer, not its earlier message");
  assert.equal(room.wakes("C"), 1);
  room.complete("C", "ok");
  await room.tick(3);
  assert.equal(room.wakes("C"), 1);
  assert.deepEqual(room.outputs().filter((o) => o.author === "C").pop()!.disposition, { kind: "yield" }, "C's final answers nothing");
  room.assertQuiet();
});

test("S6: correction and cancel races lose no input; W's reply to a cancelled request reaches C once, as a follow-up", async () => {
  room = await Room.create();
  // Corrected then cancelled before W ever ran: one run sees all three, and its final answers nothing.
  const a = room.post("C", "W", "A: rename the module.");
  room.host.correct(room.room, { actor: "C", id: "fix-A", requestId: a, body: "Rename it to dates." });
  await room.cancel("C", a);
  await room.tick();
  assert.match(room.prompt("W"), /rename the module[\s\S]*Rename it to dates[\s\S]*Request cancelled/);
  room.complete("W", "Nothing to do: A was cancelled.");
  await room.tick(2);
  const reply = room.outputs().find((o) => o.author === "W")!;
  assert.deepEqual(reply.disposition, { kind: "progress", requestIds: [a], milestone: FOLLOW_UP });
  assert.deepEqual(reply.claims, []);
  assert.equal(reply.body, `${IDLE}Nothing to do: A was cancelled.`);
  assert.equal(room.wakes("C"), 1, "the reply answers nothing and reaches C once");
  room.complete("C", "ok");
  await room.tick(2);
  // A correction after the watermark supersedes; a correction to a cancelled request is refused.
  const b = room.post("C", "W", "B: fix leap years.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: "fix-B", requestId: b, body: "Only for 2100." });
  room.complete("W", "Fixed all centuries.");
  await room.tick();
  assert.equal(room.state(b), "open");
  assert.equal(room.wakes("C"), 1, "the superseded final wakes nobody");
  room.complete("W", "Fixed 2100 only.");
  await room.tick(2);
  assert.equal(room.state(b), "answered");
  assert.equal(room.wakes("C"), 2);
  assert.throws(() => room.host.correct(room.room, { actor: "C", id: "fix-A2", requestId: a, body: "x" }), /closed request needs a new request/);
  assert.ok(room.outputs().every((o) => o.claims.every((c) => c.outcome !== "late")));
  assert.deepEqual(room.notices(), []);
  room.complete("C", "ok");
  await room.tick(2);
  room.assertQuiet();
});

test("S7: a lost acknowledgement and a restart make one T3 run; error-only feedback does not ping-pong", async () => {
  room = await Room.create();
  room.fake.dropAcks = true;
  const a = room.post("C", "W", "Fix dates.ts.");
  await room.tick();
  room.fake.dropAcks = false;
  room.restart();
  await room.tick();
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1, "one T3 run for the dispatch");
  room.complete("W", "Fixed dates.ts.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.equal(room.running("C"), true);
  // C relays the review to V; V's turn fails.
  const r = room.post("C", "V", "Review W's dates.ts fix.");
  room.complete("C", "Asked V to review.");
  await room.tick();
  room.complete("V", "crashed", { outcome: "error" });
  await room.tick();
  assert.equal(room.running("C"), true, "V's failure notice wakes C");
  assert.equal(room.running("W"), false, "and not W, which asked nothing");
  room.complete("C", "Will retry V later.");
  await room.tick(5);
  assert.deepEqual([room.wakes("C"), room.wakes("W"), room.wakes("V")], [2, 1, 1], "no error ping-pong");
  assert.equal(room.notices().length, 1);
  assert.equal(room.state(r), "open");
});

/**
 * The six coding flows' payloads (D#316), on the relayed flow: C hands A to W and the review to V; V's finding wakes C,
 * which corrects A while W is still in its turn; W's next turn, carrying each payload, answers A; C asks V to review
 * again; the PASS wakes C, which reports. Each must finish; none may stall.
 */
const PNG: TurnImage = { name: "bug.png", mimeType: "image/png", sizeBytes: 772, dataUrl: `data:image/png;base64,${Buffer.alloc(772, 3).toString("base64")}` };
const flows: Array<{ name: string; during?: (r: Room) => void; final?: string; afterTurn?: (r: Room, a: string) => Promise<void> }> = [
  { name: "261 B tool output", during: (r) => toolItem(r, "W", { type: "command_execution", input: "npm test", output: "x".repeat(261), exitCode: 0, outputIndicatesFailure: false }) },
  { name: "65,536 B text", during: (r) => toolItem(r, "W", { type: "dynamic_tool", toolName: "Read", input: { file_path: "big.txt" }, output: "y".repeat(65_536) }), final: "z".repeat(65_536) },
  { name: "772 B PNG", during: (r) => toolItem(r, "W", { type: "dynamic_tool", toolName: "Screenshot", input: {}, output: { image: PNG.dataUrl } }) },
  { name: "376 B edit", during: (r) => toolItem(r, "W", { type: "file_change", fileName: "src/dates.ts", additions: 6, deletions: 2, diff: "e".repeat(376) }) },
  {
    name: "a background job",
    during: (r) => r.fake.background(r.threadOf("W"), ["slow-check"]),
    afterTurn: async (r, a) => {
      r.fake.background(r.threadOf("W"), []);
      r.fake.startSelfRun(r.threadOf("W"));
      await r.tick();
      r.complete("W", "slow-check passed.");
      await r.tick();
      assert.deepEqual(followUps(r).map((f) => [f.body, f.requestIds]), [[`${IDLE}slow-check passed.`, [a]]]);
      assert.equal(r.running("C"), true, "the continuation's follow-up wakes C");
      r.complete("C", "Noted: slow-check passed.");
      await r.tick();
    },
  },
  {
    name: "a handle known only after launch",
    afterTurn: async (r, a) => {
      // T3 lists the watcher only after the answer, whose status said idle; it ends, and W's continuation reports.
      r.fake.background(r.threadOf("W"), ["watcher-7"]);
      await r.tick();
      r.fake.background(r.threadOf("W"), []);
      r.fake.startSelfRun(r.threadOf("W"));
      await r.tick();
      r.complete("W", "The watcher reported green.");
      await r.tick();
      assert.deepEqual(followUps(r).map((f) => [f.body, f.requestIds]), [[`${IDLE}The watcher reported green.`, [a]]]);
      assert.equal(r.running("C"), true, "the continuation's follow-up wakes C");
      r.complete("C", "Noted: the watcher is green.");
      await r.tick();
    },
  },
];

for (const flow of flows) {
  test(`coding flow with ${flow.name}: finishes, A answered once, each member reply waking the Consigliere once`, async () => {
    room = await Room.create({ images: (body) => (body.includes("screenshot attached") ? [PNG] : []) });
    const u = room.user("C", "Fix the date bug, with review, and report.");
    await room.tick();
    const a = room.post("C", "W", "A: fix dates.ts (screenshot attached).");
    const r1 = room.post("C", "V", "R1: review W's dates.ts fix on the branch as it lands.");
    room.complete("C", "Handed to W; V reviews.");
    await room.tick();
    assert.equal(room.state(u), "answered", "C's hand-off answers the user");
    assert.deepEqual(room.fake.sent.filter((s) => s.threadId === room.threadOf("W"))[0]!.images, [PNG]);
    room.complete("V", "Finding: February is wrong.");
    await room.tick();
    assert.equal(room.running("C"), true, "V's finding wakes C");
    room.host.correct(room.room, { actor: "C", id: room.id("correct"), requestId: a, body: "V found February is wrong; fix it." });
    room.complete("C", "Relayed V's finding to W.");
    await room.tick();
    room.complete("W", "Fix written.");
    await room.tick();
    assert.equal(room.state(a), "open", "W had not seen the correction: its final is superseded");
    assert.equal(room.running("W"), true);
    assert.match(room.prompt("W"), /February is wrong/);
    flow.during?.(room);
    room.complete("W", flow.final ?? "A done: dates.ts fixed, February included.", { files: [{ path: "src/dates.ts", kind: "modified", additions: 6, deletions: 2 }] });
    await room.tick();
    assert.equal(room.answeredClaims(a).length, 1, "A answered");
    if (flow.final) assert.ok(room.outputs().some((o) => o.body === `${IDLE}${flow.final}`), "the long final is kept whole, under W's status");
    assert.equal(room.running("C"), true, "C woken by A's answer");
    const r2 = room.post("C", "V", "R2: review W's fix again.");
    room.complete("C", "Asked V to review again.");
    await room.tick();
    await flow.afterTurn?.(room, a);
    room.complete("V", "PASS");
    await room.tick();
    assert.equal(room.running("C"), true, "the PASS wakes C");
    room.complete("C", "Report: fixed and reviewed. JOB-DONE");
    await room.tick(3);
    assert.equal(room.answeredClaims(a).length, 1, "A answered exactly once");
    for (const id of [u, r1, r2]) assert.equal(room.answeredClaims(id).length, 1);
    assert.equal(room.wakes("C"), flow.afterTurn ? 5 : 4, "C woke for U, the finding, A's answer, the PASS (and a continuation's follow-up)");
    room.assertQuiet();
  });
}
