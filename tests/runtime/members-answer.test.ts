/**
 * H5, members only answer (the user's design, Improvement #709 and task570): a member's final always answers the
 * requests its run was given and wakes the orchestrator, with the member's T3 status at the top; a turn that answers
 * nothing is a follow-up that wakes the orchestrator too; background work that ends with no further turn gets one
 * follow-up after 30 s of quiet; only the orchestrator and the user post. Nothing is held anywhere.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MEMBERS_DO_NOT_POST } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** C's runs, each with the events it was given (its envelope and confirmed steers). */
function deliveredToC(r: Room): string[][] {
  return [...r.p.runs.values()].filter((x) => x.seatId === "C").map((run) => [...run.envelope.inputs, ...run.receipts.filter((x) => x.confirmed).flatMap((x) => x.envelope.inputs)].map((i) => i.eventId));
}

/** Every reply a member's turn was recorded as: an output with text, or a follow-up post. */
function memberReplies(r: Room, members: string[]) {
  return r.p.events.filter((e) => (e.data.kind === "output" && members.includes(e.data.author) && e.data.body.length > 0) || (e.data.kind === "progress" && members.includes(e.data.author)));
}

function answersOf(r: Room, requestId: string) {
  return r.outputs().filter((o) => o.claims.some((c) => c.requestId === requestId && c.outcome === "answered"));
}

/**
 * Job 14 of the Z1 campaign (backroom-handoff/compare-live/z1/jobs/new-T3-1-1494f5), in its real order: the
 * Consigliere C asks the worker W (#24) and the reviewer V (#25) directly; V says it has nothing to review yet; W
 * leaves the slow check running in the background and then works on in two turns T3 starts itself; C sends W's fix to
 * V; V approves. Nobody runs a command. In the run that happened, both members marked themselves working and nothing
 * was ever answered (before/job14-on-f70767b.txt).
 */
test("job 14 replayed: plain finals answer both requests; C is woken once per member reply with the member's status; the user's request is answered by C's first reply", async () => {
  room = await Room.create();
  const u = room.user("C", "Have W run the slow check in the background, fix what it reports, and report when it passes. End with JOB-DONE.");
  await room.tick();
  const w = room.post("C", "W", "Run the slow check in the background, fix src/catalog.ts until it passes, and report.");
  const v = room.post("C", "V", "You are the reviewer for W's slow-check fix.");
  room.complete("C", "Handed off: W runs the check, V reviews.");
  await room.tick();
  assert.equal(room.state(u), "answered", "C's first reply answers the user");
  assert.equal(answersOf(room, u).length, 1);
  const handOff = room.wakes("C");
  await room.tick();
  assert.ok(room.running("W") && room.running("V"));

  // 09:13:42, V: nothing to review yet. A plain final: it answers #25 and wakes C, with V's status.
  room.complete("V", "Nothing to review yet: W hasn't posted the diff.");
  await room.tick(2);
  assert.equal(room.state(v), "answered");
  assert.ok(room.running("C"));
  assert.match(room.prompt("C"), /\[T3 status of @V: idle\]\n\nNothing to review yet/);

  // 09:13:54, W: the first slow-check run is in the background. A plain final: it answers #24.
  room.fake.background(room.threadOf("W"), ["slow-check-1"]);
  room.complete("W", "The first run is at product 5 of 36. I'll pick it up when the background task finishes.");
  room.complete("C", "V has nothing to review yet.");
  await room.tick(2);
  assert.equal(room.state(w), "answered", "background work holds nothing");
  assert.ok(room.running("C"), "W's reply wakes C");
  assert.match(room.prompt("C"), /\[T3 status of @W: still running: background task "background slow-check-1"\]\n\nThe first run is at product 5 of 36/);
  room.complete("C", "W's slow check is still running.");
  await room.tick(2);

  // 09:16:51, the first run ended: T3 starts W's turn (ordinal 3). It fixes both problems and reruns in the background.
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.fake.background(room.threadOf("W"), ["slow-check-2"]);
  room.complete("W", "Fixed both problems in src/catalog.ts; the second run is in the background.");
  await room.tick(2);
  assert.ok(room.running("C"), "the turn W started itself wakes C as a follow-up");
  assert.match(room.prompt("C"), /follow-up from @W on #\d+\]\n\[T3 status of @W: still running: background task "background slow-check-2"\]\n\nFixed both problems/);
  room.complete("C", "W reran the check.");
  await room.tick(2);

  // 09:19:57, the second run passed: T3 starts W's turn (ordinal 4). W commits.
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "slow-check exits 0 with all 36 products ok; the fix is commit 367a8d3.");
  await room.tick(2);
  assert.ok(room.running("C"));
  assert.match(room.prompt("C"), /\[T3 status of @W: idle\]\n\nslow-check exits 0/);

  // C relays the review: it sends W's result to V.
  const review = room.post("C", "V", "Review W's commit 367a8d3 against the slow-check report.");
  room.complete("C", "Sent W's fix to V.");
  await room.tick(2);
  assert.ok(room.running("V"));
  room.complete("V", "Approved: 367a8d3 fixes exactly what slow-check reported.");
  await room.tick(2);
  assert.equal(room.state(review), "answered");
  assert.ok(room.running("C"));
  assert.match(room.prompt("C"), /\[T3 status of @V: idle\]\n\nApproved/);
  room.complete("C", "Fixed and reviewed: slow-check passes and V approved 367a8d3. JOB-DONE");
  await room.tick(3);

  // Both requests answered once, by the members' plain finals.
  for (const id of [w, v, review]) assert.equal(answersOf(room, id).length, 1, `#${id} answered once`);
  // C woken once per member reply: five replies, five wakes after the hand-off, each reply in exactly one of C's runs.
  const replies = memberReplies(room, ["W", "V"]);
  assert.equal(replies.length, 5);
  assert.equal(room.wakes("C") - handOff, 5);
  const runs = deliveredToC(room);
  for (const reply of replies) assert.equal(runs.filter((ids) => ids.includes(reply.id)).length, 1, `${reply.id} reached C once`);
  // The user is woken once, by C's first reply; C's later replies (its report among them) are updates that wake nobody.
  const toUser = room.outputs().filter((o) => o.author === "C" && o.recipients.includes("$user"));
  assert.equal(toUser.length, 1);
  const report = room.outputs().filter((o) => o.author === "C").at(-1)!;
  assert.deepEqual([report.disposition.kind, report.recipients, /JOB-DONE/.test(report.body)], ["yield", [], true]);
  room.assertQuiet();
});

test("a turn the member starts itself is a follow-up on its request that wakes the orchestrator, with the member's status", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Build it.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "lint", "running");
  room.fake.background(room.threadOf("W"), ["build"]);
  room.complete("W", "The build and a lint subagent are running.");
  await room.tick(2);
  assert.equal(room.state(a), "answered");
  assert.match(room.prompt("C"), /\[T3 status of @W: still running: subagent "subagent lint", background task "background build"\]/);
  room.complete("C", "Noted.");
  await room.tick();
  const before = room.wakes("C");
  room.fake.subagent(room.threadOf("W"), "lint", "completed");
  room.fake.background(room.threadOf("W"), []);
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "The build passed and lint is clean.");
  await room.tick(2);
  assert.equal(room.wakes("C"), before + 1, "one wake for the follow-up");
  const followUp = room.p.events.find((e) => e.data.kind === "progress" && e.data.author === "W")!.data;
  assert.ok(followUp.kind === "progress");
  assert.deepEqual([followUp.milestone, followUp.requestIds, followUp.recipients], ["follow-up", [a], ["C"]]);
  assert.equal(followUp.body, "[T3 status of @W: idle]\n\nThe build passed and lint is clean.");
  room.complete("C", "Good.");
  await room.tick(3);
  assert.equal(room.wakes("C"), before + 1, "and only once");
  room.assertQuiet();
});

test("background work that ends with no further turn: one follow-up after 30 s of quiet, not before, and not again", async () => {
  room = await Room.create();
  room.post("C", "W", "Run the soak test.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["soak"]);
  room.complete("W", "The soak test is running in the background.");
  await room.tick(2);
  room.complete("C", "Ok.");
  await room.tick();
  const before = room.wakes("C");
  room.fake.background(room.threadOf("W"), []);
  await room.tick(2);
  room.clock += 29_000;
  await room.tick(2);
  assert.equal(room.wakes("C"), before, "nothing before 30 s of quiet");
  room.clock += 2_000;
  await room.tick(2);
  assert.equal(room.wakes("C"), before + 1);
  assert.match(room.prompt("C"), /follow-up from @W on #\d+\]\n\[T3 status of @W: idle\]\n\n\(background task "background soak" ended without a further turn\.\)/);
  room.complete("C", "Ok.");
  room.clock += 10 * 60_000;
  await room.tick(4);
  assert.equal(room.wakes("C"), before + 1, "one follow-up only");
  room.assertQuiet();
});

test("a member cannot post: the board refuses it with a plain sentence and records nothing; the orchestrator's post has no parent", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Fix the bug and have it reviewed.");
  assert.equal(room.p.requests.get(a)!.parentId, null);
  await room.tick();
  assert.ok(room.running("W"));
  const head = room.p.events.length;
  assert.throws(() => room.post("W", "V", "Please review my fix."), (error: Error) => error.message === MEMBERS_DO_NOT_POST);
  assert.throws(() => room.host.request(room.room, { actor: "V", id: room.id("raw"), to: "W", body: "raw" }), (error: Error) => error.message === MEMBERS_DO_NOT_POST);
  assert.equal(room.p.events.length, head);
  assert.match(MEMBERS_DO_NOT_POST, /^Only the Consigliere and the user post on the board\./);
});
