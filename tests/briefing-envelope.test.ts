import assert from "node:assert/strict";
import { test } from "node:test";
import type { T3TurnItem } from "../src/adapter/types.ts";
import {
  KEEP_ALIVE_LINE, isCompactCommand, journalDirectory, keepAliveOnly, relatedContext, renderEnvelopeBriefing, standingLost,
  type EnvelopeBriefing, type EnvelopeBriefingInput, type EnvelopeDirectory, type SeatStanding,
} from "../src/briefing/envelope.ts";
import { inputTree } from "../src/engine/index.ts";
import type { Envelope, Input, Run } from "../src/engine/index.ts";
import type { Participant, Room as BackroomRoom } from "../src/domain/types.ts";
import { Room } from "./engine/helpers.ts";

// ---------- fixtures: a Backroom room whose seats are the engine test Room's O (the Consigliere), W, V, X ----------

const ALIASES: Record<string, string> = { O: "Fable", W: "Worker", V: "Viewer", X: "Xavier", W2: "Worker2", W3: "Worker3" };
const participant = (seat: string): Participant => ({
  id: `p-${seat}`, roomId: "r", alias: ALIASES[seat] ?? seat, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access",
  interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "",
});
const participants = new Map(Object.keys(ALIASES).map((seat) => [`p-${seat}`, participant(seat)]));
const backroomRoom: BackroomRoom = {
  id: "r", projectId: "p", environmentId: null, title: "Improvement", nextSequence: 1, browserEnabled: false,
  defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "p-O", createdAt: "", updatedAt: "",
};
const BOARD = { command: "/repo/bin/rooms-board", as: "Worker.key" };

function render(r: Room, run: Run, options: Partial<EnvelopeBriefingInput> & { attachments?: Record<string, string[]> } = {}): EnvelopeBriefing {
  const { attachments, ...rest } = options;
  const directory = journalDirectory(r.log, { alias: (seat) => ALIASES[seat] ?? null, attachments: (id) => attachments?.[id] ?? [] });
  return renderEnvelopeBriefing({
    room: backroomRoom, participant: participant(run.seatId), participantsById: participants, board: BOARD,
    envelope: run.envelope, directory, context: relatedContext(r.log, run.envelope, run.seatId),
    had: null, runId: run.id, at: "2026-10-08T10:00:00.000Z", budgetChars: 60_000, ...rest,
  });
}

const numberOf = (r: Room, eventId: string) => r.log.find((e) => e.id === eventId)!.seq;
const pointer = (n: number) => `\`rooms-board read ${n}\``;

/**
 * The gate, checked for one rendering: every input of the envelope, inherited ones included, appears; in full its body
 * is there verbatim under its tag, otherwise its tag and its rooms-board read pointer are. Nothing is dropped.
 */
function assertEveryInput(briefing: EnvelopeBriefing, envelope: Envelope, number: (input: Input) => number): void {
  for (const input of inputTree(envelope.inputs)) {
    const form = briefing.forms[input.eventId];
    assert.ok(form, `input ${input.eventId} (#${number(input)}) was rendered`);
    const n = number(input);
    assert.ok(briefing.text.includes(`[#${n} `), `input #${n} has its tag`);
    if (form === "full") assert.ok(briefing.text.includes(`]\n${input.body}`), `input #${n} is verbatim`);
    else {
      assert.ok(briefing.text.includes(pointer(n)), `condensed input #${n} has its pointer`);
      assert.ok(briefing.condensedEventIds.includes(input.eventId));
    }
  }
}

// ---------- real envelopes from the core ----------

test("a request reaches its owner verbatim, in the assignment, with who asked", () => {
  const r = new Room();
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: "Fix the failing test in src/dates.ts.\n\n  Keep the API." });
  const run = r.reserve("W")!;
  const b = render(r, run);
  const n = numberOf(r, "A");
  assert.match(b.text, new RegExp(`== Your assignment ==\\nYour open requests: #${n} \\(asked by @Fable\\)\\.\\n\\[#${n} request from @Fable\\]\\nFix the failing test`));
  assert.ok(b.text.includes("Fix the failing test in src/dates.ts.\n\n  Keep the API."), "whitespace kept");
  assert.ok(b.text.endsWith("This assignment is addressed to you. Perform only the part addressed to you."));
  assert.equal(b.forms.A, "full");
  assert.equal(b.condensed, false);
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("a reviewer's answer is a post for the worker; its own open request goes with it, condensed after the first briefing", () => {
  const r = new Room();
  const long = "Fix the failing test in src/dates.ts, then have it reviewed. " + "Context line. ".repeat(30);
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: long });
  r.request("S"); // a short one: its preview would be no shorter, so it goes in full
  r.output(r.reserve("W")!, { kind: "yield" });
  // W asks V for a review under A; V answers; W is woken by the answer alone.
  const w = r.reserve("W");
  assert.equal(w, null, "nothing new for W yet");
  r.add({ type: "request", id: "R", actor: "W", to: "V", body: "Review my fix", parentId: "A" });
  r.finish(r.reserve("V")!, "R");
  const run = r.reserve("W")!;
  assert.deepEqual(run.envelope.inputs.map((i) => i.intent), ["result"]);
  const resultId = run.envelope.inputs[0]!.eventId;
  const later = render(r, run, { had: renderOnce(r, run).held });
  const nR = numberOf(r, "R"), nA = numberOf(r, "A"), nResult = numberOf(r, resultId);
  assert.match(later.text, new RegExp(`== Posts for you since your last briefing \\(#${nResult}\\) ==\\n\\[#${nResult} answer from @Viewer to your request #${nR}\\]\\nOutput from`));
  assert.equal(later.forms[resultId], "full");
  assert.equal(later.forms.A, "condensed", "A was given before: a preview and its pointer");
  assert.ok(later.text.includes(`[#${nA} request from @Fable, still open] Fix the failing test in src/dates.ts, then have it reviewed. Context line.`));
  assert.ok(later.text.includes(`… (condensed; full text: ${pointer(nA)})`));
  assert.equal(later.forms.S, "full");
  assert.ok(later.text.includes(`[#${numberOf(r, "S")} request from @Fable, still open]\nContent of S`));
  // On a thread that lost its standing sections, the open request goes in full again.
  const fresh = render(r, run, { had: null });
  assert.equal(fresh.forms.A, "full");
  assert.ok(fresh.text.includes(`[#${nA} request from @Fable, still open]\n${long}`));
});

/** The record a seat holds after one delivery with everything. */
function renderOnce(r: Room, run: Run): EnvelopeBriefing {
  return render(r, run, { had: null, runId: "first-run" });
}

test("corrections, cancels and requests no longer open all appear in the assignment", () => {
  const r = new Room();
  r.request("A");
  r.output(r.reserve("W")!, { kind: "yield" });
  r.add({ type: "correct", id: "fixA", actor: "O", requestId: "A", body: "Also cover leap years." });
  r.request("B");
  r.add({ type: "cancel", id: "stopB", actor: "O", requestId: "B" });
  const run = r.reserve("W")!;
  const b = render(r, run, { had: { runId: "x", at: "2026-10-08T09:00:00.000Z", sections: {} } });
  const nA = numberOf(r, "A"), nB = numberOf(r, "B");
  assert.ok(b.text.includes(`[#${numberOf(r, "fixA")} correction from @Fable to #${nA}]\nAlso cover leap years.`));
  assert.ok(b.text.includes(`[#${nB} request from @Fable, no longer open]\nContent of B`));
  assert.ok(b.text.includes(`[#${numberOf(r, "stopB")} cancel from @Fable: #${nB} is withdrawn]\nRequest cancelled`));
  assert.ok(b.text.includes(`Your open requests: #${nA} (asked by @Fable).`));
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("a retry carries the failed run's content over, verbatim and once", () => {
  const r = new Room();
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: "Run the slow check and fix what it reports." });
  const failed = r.reserve("W")!;
  r.output(failed, { kind: "error", requestIds: ["A"] });
  // W's error notice goes to O; W itself is not woken by it.
  assert.equal(r.reserve("W"), null);
  r.add({ type: "retry", id: "again", actor: "O", runId: failed.id, body: "Try again; the CI box is back." });
  const run = r.reserve("W")!;
  const b = render(r, run);
  const nA = numberOf(r, "A"), nRetry = numberOf(r, "again");
  assert.ok(b.text.includes(`[#${nRetry} retry from @Fable of your failed run on #${nA}]\nTry again; the CI box is back.`));
  assert.ok(b.text.includes(`[#${nA} request from @Fable, carried over by #${nRetry}]\nRun the slow check and fix what it reports.`));
  assert.equal(b.text.split("Run the slow check and fix what it reports.").length, 2, "the request body appears once");
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("a handover gives the new seat its owned requests in full, the awaited answer, and the carried-over posts", () => {
  const r = new Room();
  r.request("A"); const w = r.reserve("W")!; r.request("R", "V", "W", "A"); r.output(w, { kind: "yield" });
  r.request("B"); // unread by W at the handover: carried over
  const v = r.reserve("V")!;
  r.add({ type: "transfer", id: "reseat", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A", "B"], awaited: ["R"], body: "Carry on from the checkpoint post.", evidence: "idle" });
  r.finish(v, "R");
  const run = r.reserve("W2")!;
  const b = render(r, run);
  const nA = numberOf(r, "A"), nB = numberOf(r, "B"), nR = numberOf(r, "R"), nT = numberOf(r, "reseat");
  assert.equal(b.standing, "all", "a new seat gets the standing part");
  assert.ok(b.text.includes(`[#${nT} handover from @Fable: #${nA}, #${nB} now yours to answer; answers to #${nR} now come to you]\nCarry on from the checkpoint post.`));
  assert.ok(b.text.includes(`[#${nB} request from @Fable, carried over by #${nT}]\nContent of B`));
  assert.ok(b.text.includes(`[#${nA} request from @Fable, still open]\nContent of A`), "A, delivered to the old seat, goes in full");
  assert.ok(b.text.includes(`answer from @Viewer to your request #${nR}`));
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("a handover's split comes from the transfer event, also when an owned request was cancelled before delivery", () => {
  const r = new Room();
  r.request("A"); r.request("B");
  r.output(r.reserve("W")!, { kind: "yield" });
  r.add({ type: "transfer", id: "reseat", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A", "B"], awaited: [], body: "Carry on", evidence: "idle" });
  r.add({ type: "cancel", id: "stopB", actor: "O", requestId: "B" });
  const run = r.reserve("W2")!;
  const b = render(r, run);
  const nA = numberOf(r, "A"), nB = numberOf(r, "B"), nT = numberOf(r, "reseat");
  assert.ok(b.text.includes(`[#${nT} handover from @Fable: #${nA}, #${nB} (no longer open) now yours to answer]\nCarry on`));
  assert.ok(!b.text.includes("now come to you"), "B is not called awaited");
  assert.ok(b.text.includes(`[#${numberOf(r, "stopB")} cancel from @Fable: #${nB} is withdrawn]`));
  // A directory that does not know the split names the requests without one.
  const { handover, ...plain } = journalDirectory(r.log, { alias: (seat) => ALIASES[seat] ?? null });
  assert.ok(handover);
  const unsplit = renderEnvelopeBriefing({
    room: backroomRoom, participant: participant("W2"), participantsById: participants, board: BOARD, envelope: run.envelope,
    directory: plain, had: null, runId: run.id, at: "", budgetChars: 60_000,
  });
  assert.ok(unsplit.text.includes(`[#${nT} handover from @Fable on #${nA}, #${nB}]\nCarry on`));
});

test("images are named under the post that carried them, in every form", () => {
  const r = new Room();
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: "Match this mock-up. " + "x".repeat(5_000) });
  const run = r.reserve("W")!;
  const n = numberOf(r, "A");
  const full = render(r, run, { attachments: { A: ["mock.png", "detail.png"] } });
  assert.ok(full.text.includes(`x\nImages with #${n}: mock.png, detail.png.`));
  assert.deepEqual(full.images, [{ eventId: "A", names: ["mock.png", "detail.png"] }]);
  // An input's images go with the message in every form.
  const tight = render(r, run, { attachments: { A: ["mock.png", "detail.png"] }, budgetChars: 1_500, had: full.held });
  assert.equal(tight.forms.A, "condensed");
  assert.ok(tight.text.includes(`(condensed; full text: ${pointer(n)})\nImages with #${n}: mock.png, detail.png.`));
  assert.deepEqual(tight.images, [{ eventId: "A", names: ["mock.png", "detail.png"] }]);
});

test("an earlier open request's images go again only with its full text on a fresh or compacted thread", () => {
  const r = new Room();
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: "Match this mock-up. " + "Detail. ".repeat(40) });
  const first = r.reserve("W")!;
  const attachments = { A: ["mock.png"], after: ["ci.png"] };
  const had = render(r, first, { attachments }).held;
  r.output(first, { kind: "yield" });
  r.request("B");
  const run = r.reserve("W")!;
  const n = numberOf(r, "A");
  // A later briefing: A is condensed and its image is not sent again.
  const later = render(r, run, { attachments, had });
  assert.equal(later.forms.A, "condensed");
  assert.ok(later.text.includes(`Images with #${n}, not attached here: mock.png.`));
  assert.deepEqual(later.images, []);
  // A fresh or compacted thread: A goes in full, with its image.
  const fresh = render(r, run, { attachments, had: null });
  assert.equal(fresh.forms.A, "full");
  assert.ok(fresh.text.includes(`Detail. \nImages with #${n}: mock.png.`));
  assert.deepEqual(fresh.images, [{ eventId: "A", names: ["mock.png"] }]);
  // ... unless the budget condenses it: then its image stays behind too.
  const squeezed = render(r, run, { attachments, had: null, budgetChars: fresh.text.length - 200 });
  assert.notEqual(squeezed.forms.A, "full");
  assert.ok(squeezed.text.includes(`Images with #${n}, not attached here: mock.png.`));
  assert.deepEqual(squeezed.images, []);
});

test("a context post's images are never attached: they were not sent to this seat", () => {
  const r = new Room();
  r.request("U", "O", "$user");
  const o = r.reserve("O")!;
  r.request("A", "W", "O", "U");
  r.output(o, { kind: "yield" });
  const w = r.reserve("W")!;
  r.finish(w, "A");
  r.add({ type: "post", id: "after", actor: "W", intent: "note", requestIds: ["A"], body: "CI went red after my answer; screenshot attached." });
  const next = r.reserve("O")!;
  const b = render(r, next, { attachments: { after: ["ci.png"] } });
  assert.ok(b.text.includes(`Images with #${numberOf(r, "after")}, not attached here: ci.png.`));
  assert.deepEqual(b.images, []);
});

// ---------- the budget: condensed, never dropped ----------

test("one input far over the budget is condensed with its pointer, and the briefing fits", () => {
  const r = new Room();
  const huge = "Spec line.\n".repeat(100_000); // about 1.1 MB of text
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: huge });
  const run = r.reserve("W", 4 * 1024 * 1024)!;
  const b = render(r, run);
  assert.equal(b.forms.A, "condensed");
  assert.deepEqual(b.condensedEventIds, ["A"]);
  assert.ok(b.text.length <= 60_000, `fits: ${b.text.length}`);
  assert.ok(b.text.includes(pointer(numberOf(r, "A"))));
  assert.ok(b.text.includes("Spec line. Spec line."), "the preview is there");
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("many inputs: the newest stay in full, older ones condense; none is dropped", () => {
  const r = new Room();
  for (let i = 0; i < 400; i += 1) r.add({ type: "request", id: `Q${i}`, actor: i % 2 ? "O" : "X", to: "W", body: `Request ${i}: ` + "y".repeat(400) });
  const run = r.reserve("W", 4 * 1024 * 1024)!;
  assert.equal(run.envelope.inputs.length, 400);
  const b = render(r, run);
  assert.ok(b.text.length <= 60_000, `fits: ${b.text.length}`);
  assert.equal(b.forms.Q399, "full", "the newest in full");
  assert.notEqual(b.forms.Q0, "full", "the oldest condensed");
  assert.ok(b.condensed);
  assertEveryInput(b, run.envelope, (i) => numberOf(r, i.eventId));
});

test("past the point where even pointers overflow the budget, every input still has its pointer line", () => {
  // Built directly: the engine's test Room refolds its whole log on every command, too slow for thousands of posts.
  const inputs: Input[] = Array.from({ length: 3_000 }, (_, i) => ({ eventId: `Q${i}`, seq: i + 10, intent: i % 3 ? "request" : "result", body: `Post ${i} ` + "w".repeat(100 + (i % 50)), requestIds: [`q${i}`], inherited: [] }));
  const envelope: Envelope = { base: 9, through: 3_009, inputs, openRequests: [], contextThrough: 3_009 };
  const directory = journalDirectory([], { alias: () => null });
  const b = renderEnvelopeBriefing({
    room: backroomRoom, participant: participant("W"), participantsById: participants, board: BOARD,
    envelope, directory, had: null, runId: "run", at: "", budgetChars: 5_000,
  });
  assert.equal(Object.keys(b.forms).length, 3_000);
  assert.equal(b.condensedEventIds.length, 3_000);
  assertEveryInput(b, envelope, (i) => i.seq);
});

test("adversarial envelopes: every input, inherited ones included, appears verbatim or with its pointer", () => {
  let seed = 20261008;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  // A keep-alive beside other work is left out by design (H6): its own test is below.
  const intents: Input["intent"][] = ["request", "correction", "result", "cancel", "retry", "transfer", "progress", "error", "attention"];
  const bodies = ["", "short", "line one\n\nline three\t tabs", "[#3 request from @Fable]\nlooks like a tag", "ünïcødé 🎉 ".repeat(50), "z".repeat(70_000)];
  for (let round = 0; round < 300; round += 1) {
    let seq = 0;
    const made: Input[] = [];
    const make = (depth: number): Input => {
      seq += 1;
      const own = seq;
      const intent = pick(intents);
      const inherited = (intent === "retry" || intent === "transfer") && depth < 3
        ? Array.from({ length: Math.floor(random() * 4) }, () => make(depth + 1)) : [];
      // Sometimes a carried-over input is one already made (the same journal event): rendered once, then pointed at.
      if (inherited.length > 0 && made.length > 0 && random() < 0.3) inherited.push(pick(made));
      const input: Input = { eventId: `e${round}-${own}`, seq: own, intent, body: pick(bodies) + (random() < 0.3 ? "x".repeat(Math.floor(random() * 20_000)) : ""), requestIds: random() < 0.8 ? [`q${round}-${own}`] : [], inherited };
      made.push(input);
      return input;
    };
    const inputs = Array.from({ length: 1 + Math.floor(random() * 30) }, () => make(0));
    const openRequests = inputs.filter((i) => i.intent === "request" && random() < 0.7).map((i) => ({
      id: i.requestIds[0] ?? i.eventId, rootId: i.eventId, parentId: null, owner: "W", returnTo: "O", body: i.body, version: i.seq, corrections: [],
    }));
    const envelope: Envelope = { base: 0, through: seq, inputs, openRequests, contextThrough: seq };
    const numbers = new Map<string, number>();
    for (const input of inputTree(inputs)) if (!numbers.has(input.eventId)) numbers.set(input.eventId, input.seq);
    const withImages = new Set([...numbers.keys()].filter(() => random() < 0.15));
    const directory: EnvelopeDirectory = {
      number: (id) => numbers.get(id) ?? null, requestNumber: () => null, author: () => "@Fable",
      name: (p) => `@${p}`, attachments: (id) => (withImages.has(id) ? ["shot.png"] : []),
    };
    const budget = pick([0, 500, 5_000, 60_000, 200_000]);
    const b = renderEnvelopeBriefing({
      room: backroomRoom, participant: participant("W"), participantsById: participants, board: BOARD,
      envelope, directory, had: random() < 0.5 ? null : { runId: "x", at: "", sections: {} }, runId: `run${round}`, at: "", budgetChars: budget,
    });
    assertEveryInput(b, envelope, (i) => numbers.get(i.eventId) as number);
    // At the real budget (and above) a briefing of up to 30 posts, however long, always fits.
    if (budget >= 60_000) assert.ok(b.text.length <= budget, `round ${round}: ${b.text.length} > ${budget}`);
    // Inputs in full are verbatim; repeated event IDs are rendered once.
    for (const id of new Set(inputTree(inputs).map((i) => i.eventId))) assert.ok(b.forms[id], `round ${round}: ${id}`);
    // Every input's images go with the message, once each; nothing else's.
    assert.deepEqual(b.images.map((i) => i.eventId).sort(), [...withImages].sort(), `round ${round}: images`);
  }
});

test("short posts stay whole even when the budget is spent: a pointer would be longer than they are", () => {
  const inputs: Input[] = Array.from({ length: 50 }, (_, i) => ({ eventId: `S${i}`, seq: i + 1, intent: "result", body: i % 10 ? "ok" : "z".repeat(10_000), requestIds: [], inherited: [] }));
  const envelope: Envelope = { base: 0, through: 50, inputs, openRequests: [], contextThrough: 50 };
  const b = renderEnvelopeBriefing({
    room: backroomRoom, participant: participant("W"), participantsById: participants, board: BOARD,
    envelope, directory: journalDirectory([], { alias: () => null }), had: { runId: "x", at: "", sections: {} }, runId: "run", at: "", budgetChars: 100,
  });
  for (let i = 0; i < 50; i += 1) assert.equal(b.forms[`S${i}`], i % 10 ? "full" : "pointer", `S${i}`);
  assertEveryInput(b, envelope, (i) => i.seq);
});

// ---------- the standing part: once per seat, again after compaction ----------

const compaction = (completedAt: string): T3TurnItem => ({
  id: `c-${completedAt}`, type: "compaction", runId: null, nodeId: null, providerTurnId: null, ordinal: 1, status: "completed", title: null,
  startedAt: completedAt, completedAt, updatedAt: completedAt, summary: null, beforeTokenCount: 900_000, afterTokenCount: 40_000,
} as T3TurnItem);

test("the standing part goes once per seat, and again after a compaction", () => {
  const r = new Room();
  const ledger = new Map<string, SeatStanding>();
  const deliver = (seat: string, at: string): EnvelopeBriefing => {
    const run = r.reserve(seat)!;
    const b = render(r, run, { had: ledger.get(seat) ?? null, at, runId: run.id });
    ledger.set(seat, b.held);
    r.output(run, { kind: "yield" });
    return b;
  };
  r.request("A");
  const first = deliver("W", "2026-10-08T10:00:00.000Z");
  assert.equal(first.standing, "all");
  assert.match(first.text, /^\[Backroom briefing for @Worker in room "Improvement"\]\nYou are "Worker", a member of the crew/);
  assert.ok(first.text.includes("Standing facts of this room, whose Consigliere is @Fable"), "seat facts with the standing part");
  assert.ok(first.text.includes("The board keeps every post of this room by number."));

  r.request("B");
  const second = deliver("W", "2026-10-08T10:05:00.000Z");
  assert.deepEqual(second.standing, []);
  assert.match(second.text, /^\[Backroom briefing for @Worker in room "Improvement". Your standing rules, where everyone works and the room's state: `\/repo\/bin\/rooms-board rules --as Worker.key`\]\n\n/);
  assert.ok(!second.text.includes("You are \""), "no standing part the second time");
  assert.equal(second.held.runId, first.held.runId, "the record still names the run that carried them all");

  // Another seat has its own record: its first briefing carries everything.
  r.request("C", "V");
  assert.equal(deliver("V", "2026-10-08T10:06:00.000Z").standing, "all");

  // A compaction before the record does not count; one after it does.
  const had = ledger.get("W")!;
  assert.equal(standingLost(had, { turnItems: [compaction("2026-10-08T09:59:00.000Z")] }), false);
  assert.equal(standingLost(had, { turnItems: [compaction("2026-10-08T10:07:00.000Z")] }), true);
  ledger.delete("W");
  r.request("D");
  const third = deliver("W", "2026-10-08T10:08:00.000Z");
  assert.equal(third.standing, "all");
  assert.ok(third.text.includes("You are \"Worker\""));
  r.request("E");
  assert.deepEqual(deliver("W", "2026-10-08T10:09:00.000Z").standing, []);
});

test("a standing section that changed goes again by itself; a rollback past the carrier or /compact loses them all", () => {
  const r = new Room();
  r.request("A");
  const run = r.reserve("W")!;
  const first = render(r, run);
  const changed = render(r, run, { had: first.held, board: { command: "/elsewhere/rooms-board", as: "Worker.key" } });
  assert.deepEqual(changed.standing, ["board"]);
  assert.ok(changed.text.includes("Changed since your last briefing:\nThe board keeps every post of this room by number. Run it as `/elsewhere/rooms-board"));
  assert.ok(!changed.text.includes("You are \""));
  // The run that carried the standing part is gone from T3 (rolled back), or never got a T3 run.
  assert.equal(standingLost(first.held, { turnItems: [], runs: [{ id: "t3-run-1" }] }, "t3-run-1"), false);
  assert.equal(standingLost(first.held, { turnItems: [], runs: [{ id: "t3-run-2" }] }, "t3-run-1"), true);
  assert.equal(standingLost(first.held, { turnItems: [], runs: [] }, null), true);
  assert.equal(isCompactCommand("/compact keep the plan"), true);
  assert.equal(isCompactCommand(" /COMPACT"), true);
  assert.equal(isCompactCommand("/compactor"), false);
  assert.equal(isCompactCommand("please /compact"), false);
});

test("a seat briefing leaves the seat facts out of its standing part: its request is those facts", () => {
  const r = new Room();
  r.request("A");
  const run = r.reserve("W")!;
  assert.ok(render(r, run).text.includes("Standing facts of this room"));
  assert.ok(!render(r, run, { seatBriefing: true }).text.includes("Standing facts of this room"));
});

// ---------- context: what reaches the requester without waking it (plan §5) ----------

test("a member's note after its answer, and unfollowed progress, reach the requester's next briefing as context", () => {
  const r = new Room();
  r.request("U", "O", "$user");
  const o = r.reserve("O")!;
  r.request("A", "W", "O", "U");
  r.request("K", "X", "V"); // an unrelated request between others
  r.output(o, { kind: "yield" });
  const w = r.reserve("W")!;
  r.add({ type: "post", id: "still", actor: "W", intent: "progress", requestIds: ["A"], body: "Still running the slow check." });
  r.finish(w, "A");
  const after = "After my answer: the slow check failed on CI, I am fixing it. " + "Log excerpt. ".repeat(20);
  r.add({ type: "post", id: "after", actor: "W", intent: "note", requestIds: ["A"], body: after });
  r.add({ type: "post", id: "other", actor: "X", intent: "note", requestIds: ["K"], body: "Unrelated note on K." });
  const next = r.reserve("O")!;
  const context = relatedContext(r.log, next.envelope, "O");
  assert.deepEqual(context.map((c) => c.eventId), ["still", "after"]);
  const b = render(r, next);
  const nA = numberOf(r, "A"), nAfter = numberOf(r, "after"), nStill = numberOf(r, "still");
  assert.ok(b.text.includes("== Also on the board about your requests (not addressed to you) =="));
  assert.ok(b.text.includes(`[#${nAfter} note from @Worker on #${nA}] After my answer: the slow check failed on CI, I am fixing it. Log excerpt.`));
  assert.ok(b.text.includes(`… (condensed; full text: ${pointer(nAfter)})`));
  assert.equal(b.forms.after, "condensed", "context goes as a preview with its pointer");
  assert.equal(b.forms.still, "full", "unless the preview would be no shorter");
  assert.ok(b.text.includes(`[#${nStill} progress from @Worker on #${nA}]\nStill running the slow check.`));
  assert.ok(!b.text.includes("Unrelated note on K."));
  // The context comes before the assignment; it is not an input and never marks the briefing condensed.
  assert.ok(b.text.indexOf("Also on the board") < b.text.indexOf("== Your assignment =="));
  assert.ok(!b.condensedEventIds.includes("after"));
  // The member's own notes are not context for itself.
  assert.deepEqual(relatedContext(r.log, next.envelope, "W"), []);
});

test("a note without request IDs is not context: it reaches nobody's briefing (the host must give §3 notes their request)", () => {
  const r = new Room();
  r.request("U", "O", "$user");
  const o = r.reserve("O")!;
  r.request("A", "W", "O", "U");
  r.output(o, { kind: "yield" });
  r.finish(r.reserve("W")!, "A");
  r.add({ type: "post", id: "bare", actor: "W", intent: "note", body: "A self-started turn after the answer, imported without its request." });
  r.add({ type: "post", id: "tied", actor: "W", intent: "note", requestIds: ["A"], body: "The same turn, imported with the answered request's ID." });
  const next = r.reserve("O")!;
  assert.deepEqual(relatedContext(r.log, next.envelope, "O").map((c) => c.eventId), ["tied"]);
  const b = render(r, next);
  assert.ok(!b.text.includes("imported without its request"));
  assert.ok(b.text.includes("imported with the answered request's ID"));
});

test("a seat with nothing open is told so, without the closing assignment line", () => {
  const r = new Room();
  r.request("A");
  const w = r.reserve("W")!;
  r.add({ type: "request", id: "R", actor: "W", to: "V", body: "Check this", parentId: "A" });
  r.output(w, { kind: "yield" });
  const v = r.reserve("V")!;
  r.output(v, { kind: "error", requestIds: ["R"] }); // V's run fails: an error notice to W (R's requester) and O
  const o = r.reserve("O")!;
  const b = render(r, o);
  assert.deepEqual(o.envelope.inputs.map((i) => i.intent), ["error"]);
  assert.ok(b.text.includes("You have no open requests: nothing here asks you for an answer."));
  assert.ok(!b.text.includes("This assignment is addressed to you."));
  assert.ok(b.text.includes(`error notice from @Viewer on #${numberOf(r, "R")}`));
});

test("H6: a briefing of keep-alives only is the newest one's text; beside other work a keep-alive is left out", () => {
  const r = new Room();
  r.request("A");
  r.output(r.reserve("W")!, { kind: "answer", requestIds: ["A"] });
  r.add({ type: "keep_alive", actor: "$system", id: "ka1", seatId: "O", body: `${KEEP_ALIVE_LINE}\n[T3 status of @W: a turn is running]` });
  r.add({ type: "keep_alive", actor: "$system", id: "ka2", seatId: "O", body: `${KEEP_ALIVE_LINE}\n[T3 status of @W: still running: background task "x"]` });
  // The answer to A reached O before the keep-alives; a second request brings real work after them.
  const o = r.reserve("O")!;
  assert.deepEqual(o.envelope.inputs.map((i) => i.intent), ["result", "keep-alive", "keep-alive"]);
  assert.equal(keepAliveOnly(o.envelope), null);
  const b = render(r, o);
  // (The Consigliere's rules in the standing part name keep-alives; no keep-alive post is among the inputs.)
  assert.ok(!b.text.includes(KEEP_ALIVE_LINE) && !b.text.includes("T3 status of @W") && !/keep-alive from /.test(b.text), "beside an answer, keep-alives are left out");
  assert.ok(b.text.includes(`answer from @Worker to your request #${numberOf(r, "A")}`));
  assert.deepEqual(Object.keys(b.forms).filter((id) => id.startsWith("ka")), []);
  r.output(o, { kind: "yield" });
  r.add({ type: "keep_alive", actor: "$system", id: "ka3", seatId: "O", body: `${KEEP_ALIVE_LINE}\n[T3 status of @W: idle]` });
  r.add({ type: "keep_alive", actor: "$system", id: "ka4", seatId: "O", body: `${KEEP_ALIVE_LINE}\n[T3 status of @W: still running: subagent "s"]` });
  assert.equal(keepAliveOnly(r.reserve("O")!.envelope), `${KEEP_ALIVE_LINE}\n[T3 status of @W: still running: subagent "s"]`, "the newest keep-alive only");
});
