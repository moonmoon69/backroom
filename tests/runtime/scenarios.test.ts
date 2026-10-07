/**
 * Regression scenarios from Development's fake comparison (D#290, D#316), rebuilt on the lean host. They are
 * regression tests, not the integration gate (that is the real comparison, Z1).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { T3TurnItem, TurnImage } from "../../src/adapter/types.ts";
import type { Input } from "../../src/engine/index.ts";
import { Room, plainRenderer } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

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

function toolItem(r: Room, seat: string, item: Record<string, unknown>): void {
  const thread = r.fake.thread(r.threadOf(seat));
  const run = thread.runs.find((x) => x.status === "running")!;
  const at = new Date().toISOString();
  thread.turnItems.push({ id: `item:${r.id("tool")}`, runId: run.id, nodeId: `node:${run.id}:root`, providerTurnId: null, ordinal: thread.turnItems.length + 1, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at, ...item } as T3TurnItem);
}

test("H1, the five-wake incident (D#149/#153): every Consigliere wake delivers something new, and none comes after the report", async () => {
  room = await Room.create({ seats: ["C", "W", "X", "V"] });
  const u = room.user("C", "Build the feature with review, then report.");
  await room.tick();
  const a = room.post("C", "W", "A: implement slugify; have V review it.");
  const b = room.post("C", "X", "B: add the --json flag.");
  room.complete("C", "Handed A to W and B to X.");
  await room.tick();
  room.post("W", "V", "Review slugify please.");
  room.complete("X", "B done: --json added.");
  room.complete("W", "Sent slugify for review.");
  await room.tick();
  assert.equal(room.running("C"), true, "C is woken by B's answer");
  // A correction during the exchange (the incident's review-correction steer).
  room.host.correct(room.room, { actor: "C", id: "correct-A", requestId: a, body: "Also strip accents." });
  room.complete("C", "B noted; waiting for A.");
  room.complete("V", "Finding: unicode is not handled.");
  await room.tick();
  assert.match(room.prompt("W"), /Also strip accents[\s\S]*unicode is not handled|unicode is not handled[\s\S]*Also strip accents/);
  room.post("W", "V", "Fixed unicode and accents; review again.");
  room.complete("W", "Fixed; re-review asked.");
  await room.tick();
  room.complete("V", "PASS");
  await room.tick();
  // W answers explicitly (the incident's explicit completion post), then ends its turn: one answer only.
  assert.deepEqual(room.answer("W", "A done: slugify with unicode and accents, reviewed PASS.", [a]).map((c) => c.outcome), ["answered"]);
  room.complete("W", "Handoff: src/text.ts.");
  await room.tick();
  assert.equal(room.running("C"), true);
  room.complete("C", "Report: A and B done, A reviewed. JOB-DONE");
  await room.tick();
  assert.equal(room.state(u), "answered");
  assert.equal(room.state(b), "answered");
  const afterReport = room.wakes("C");
  await room.tick(10);
  assert.equal(room.wakes("C"), afterReport, "0 wakes after the report");
  assert.equal(room.wakes("C"), 3, "C woke for U, B's answer and A's answer");
  for (const seat of ["C", "W", "X", "V"]) assert.equal(redundantWakes(room, seat), 0, `${seat} had a redundant wake`);
  assert.equal(room.answeredClaims(a).length, 1);
  room.assertQuiet(["C", "W", "X", "V"]);
});

test("H2: continuation turns after an answer wake nobody", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the tests.");
  await room.tick();
  room.complete("W", "Tests pass.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  assert.equal(room.state(a), "answered");
  const wakes = [room.wakes("C"), room.wakes("V")];
  for (let i = 0; i < 3; i += 1) {
    room.fake.startSelfRun(room.threadOf("W"));
    await room.tick();
    room.complete("W", `Background watcher ${i} finished.`);
    await room.tick();
  }
  await room.tick(3);
  assert.deepEqual([room.wakes("C"), room.wakes("V")], wakes, "0 continuation wakes");
  assert.equal(room.p.events.filter((e) => e.data.kind === "note").length, 3);
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
  room.user("C", "Also this.");
  room.user("C", "And that.");
  await room.tick();
  assert.equal(room.wakes("C"), 1, "C is still in its first run");
  const c1 = ask(room, "V", "C", "V asks C something.");
  room.complete("C", "Handed out.");
  await room.tick();
  assert.equal(room.wakes("C"), 2);
  for (const text of ["A done", "B done", "Also this", "And that", "V asks C"]) assert.match(room.prompt("C"), new RegExp(text));
  assert.throws(() => room.post("C", "W", "One more: A2."), /This turn works on .*: say which one this post is for, rooms-board post --for #n/);
  const late = room.post("C", "W", "One more: A2.", u);
  room.complete("C", "All handled.");
  await room.tick();
  room.complete("W", "A2 done.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 3, "exactly one more wake for the late result");
  assert.match(room.prompt("C"), /A2 done/);
  room.complete("C", "Done.");
  await room.tick(2);
  for (const id of [a, b, c1, late]) assert.equal(room.state(id), "answered");
  assert.equal(redundantWakes(room, "C"), 0);
});

test("S5: an early result and a later final, with a restart: one answer, one wake", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Find the bug.");
  await room.tick();
  room.answer("W", "Found it: dates.ts:12.", [a]);
  await room.tick();
  assert.equal(room.running("C"), true, "the early result wakes C at once");
  room.restart();
  room.complete("W", "Handoff: the bug is at dates.ts:12; no changes.");
  await room.tick(3);
  room.complete("C", "ok");
  await room.tick(3);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), 1);
  const final = room.outputs().filter((o) => o.author === "W" && o.association.kind === "run").pop()!;
  assert.deepEqual(final.disposition, { kind: "yield" }, "the later final answers nothing");
  room.assertQuiet();
});

test("S6: correction and cancel races lose no input and wake nobody for nothing", async () => {
  room = await Room.create();
  // Corrected then cancelled before W ever ran: one run sees all three, and its final answers nothing.
  const a = ask(room, "C", "W", "A: rename the module.");
  room.host.correct(room.room, { actor: "C", id: "fix-A", requestId: a, body: "Rename it to dates." });
  await room.cancel("C", a);
  await room.tick();
  assert.match(room.prompt("W"), /rename the module[\s\S]*Rename it to dates[\s\S]*Request cancelled/);
  room.complete("W", "Nothing to do: A was cancelled.");
  await room.tick(2);
  assert.equal(room.wakes("C"), 0);
  // A correction after the watermark supersedes; a correction to a cancelled request is refused.
  const b = ask(room, "C", "W", "B: fix leap years.");
  await room.tick();
  room.host.correct(room.room, { actor: "C", id: "fix-B", requestId: b, body: "Only for 2100." });
  room.complete("W", "Fixed all centuries.");
  await room.tick();
  assert.equal(room.state(b), "open");
  room.complete("W", "Fixed 2100 only.");
  await room.tick(2);
  assert.equal(room.state(b), "answered");
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
  const a = ask(room, "C", "W", "Ask V to review dates.ts.");
  await room.tick();
  room.fake.dropAcks = false;
  room.restart();
  await room.tick();
  assert.equal(room.fake.runsOf(room.threadOf("W")).length, 1, "one T3 run for the dispatch");
  room.post("W", "V", "Review dates.ts.");
  room.complete("W", "Asked V.");
  await room.tick();
  room.complete("V", "crashed", { outcome: "error" });
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.equal(room.running("C"), true);
  room.complete("W", "V failed; waiting for the Consigliere.");
  room.complete("C", "Will retry V later.");
  await room.tick(5);
  assert.deepEqual([room.wakes("C"), room.wakes("W"), room.wakes("V")], [1, 2, 1], "no error ping-pong");
  assert.equal(room.notices().length, 1);
  assert.equal(room.state(a), "open");
});

/**
 * The six coding flows' payloads (D#316): the common flow C → W → review finding → correction → PASS → final → report,
 * with W's turn carrying each payload. Each must finish; none may stall.
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
    afterTurn: async (r) => {
      r.fake.background(r.threadOf("W"), []);
      r.fake.startSelfRun(r.threadOf("W"));
      await r.tick();
      r.complete("W", "slow-check passed.");
      await r.tick();
    },
  },
  {
    name: "a handle known only after launch",
    during: (r) => void r.working("W", "Launched a watcher; its handle shows up later. I will answer when it is done."),
    afterTurn: async (r, a) => {
      r.fake.background(r.threadOf("W"), ["watcher-7"]);
      await r.tick();
      r.fake.background(r.threadOf("W"), []);
      r.fake.startSelfRun(r.threadOf("W"));
      await r.tick();
      r.complete("W", "The watcher reported green.");
      await r.tick();
      r.answer("W", "A is done; the watcher reported green.", [a]);
      await r.tick();
    },
  },
];

for (const flow of flows) {
  test(`coding flow with ${flow.name}: finishes, A answered once, the Consigliere woken once for it`, async () => {
    room = await Room.create({ host: { renderer: plainRenderer((_room, input) => (input.body.includes("screenshot attached") ? [PNG] : [])) } });
    const u = room.user("C", "Fix the date bug, with review, and report.");
    await room.tick();
    const a = room.post("C", "W", "A: fix dates.ts (screenshot attached).");
    room.complete("C", "Handed to W.");
    await room.tick();
    assert.deepEqual(room.fake.sent.filter((s) => s.threadId === room.threadOf("W"))[0]!.images, [PNG]);
    room.post("W", "V", "Review my fix.");
    room.complete("W", "Fix written; review asked.");
    await room.tick();
    room.complete("V", "Finding: February is wrong.");
    await room.tick();
    room.post("W", "V", "Fixed February; review again.");
    room.complete("W", "Corrected.");
    await room.tick();
    room.complete("V", "PASS");
    await room.tick();
    assert.equal(room.running("W"), true);
    flow.during?.(room);
    room.complete("W", flow.final ?? "A done: dates.ts fixed and reviewed (PASS).", { files: [{ path: "src/dates.ts", kind: "modified", additions: 6, deletions: 2 }] });
    await room.tick();
    await flow.afterTurn?.(room, a);
    await room.tick();
    assert.equal(room.answeredClaims(a).length, 1, "A answered exactly once");
    if (flow.final) assert.ok(room.outputs().some((o) => o.body === flow.final), "the long final is kept whole");
    assert.equal(room.running("C"), true, "C woken by A's answer");
    room.complete("C", "Report: fixed and reviewed. JOB-DONE");
    await room.tick(3);
    assert.equal(room.state(u), "answered");
    assert.equal(room.wakes("C"), 2);
    room.assertQuiet();
  });
}
