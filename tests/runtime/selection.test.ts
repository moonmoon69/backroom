/**
 * "Lean semantics" §1: which requests a final answers, and who is woken. The seven required cases, the
 * worker → reviewer → orchestrator exchange with one orchestrator wake per answer, and posts made during a run
 * delivered together in the next one. Wakes are T3 runs on each seat's thread.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** The seat's latest engine run, with its frozen envelope. */
function latestRun(r: Room, seat: string) {
  const runs = [...r.p.runs.values()].filter((x) => x.seatId === seat);
  return runs[runs.length - 1]!;
}

/** The output the host imported for a seat's latest run: its disposition and claims. */
function lastFinal(r: Room, seat: string) {
  const outputs = r.outputs().filter((o) => o.author === seat && o.association.kind === "run");
  return outputs[outputs.length - 1]!;
}

/** The user asks the Consigliere for U; the Consigliere hands A to W during its turn (a child of U). */
async function handOut(r: Room): Promise<{ u: string; a: string }> {
  const u = r.user("C", "Fix the date bug and report.");
  await r.tick();
  assert.equal(r.running("C"), true);
  const a = r.post("C", "W", "Fix dates.ts; have it reviewed.");
  r.complete("C", "Handed the fix to W.");
  await r.tick();
  assert.equal(r.p.requests.get(a)!.parentId, u, "a post during a turn is a child of the request that turn works on");
  assert.equal(r.state(u), "open", "U stays open while its child A is open");
  assert.deepEqual(lastFinal(r, "C").claims.map((c) => c.outcome), ["pending_activity"]);
  return { u, a };
}

test("case 1: woken for B only, the final answers B and A stays open", async () => {
  room = await Room.create();
  const a = room.user("W", "Request A: a long job.");
  await room.tick();
  const marked = room.working("W", "A takes a while; I'll answer it myself.");
  assert.deepEqual(marked.requestIds, [a]);
  room.complete("W", "Started A.");
  await room.tick();
  assert.equal(room.state(a), "open");
  const b = room.user("W", "Request B: a quick question.");
  await room.tick();
  assert.match(room.prompt("W"), /Request B/);
  assert.deepEqual(latestRun(room, "W").envelope.inputs.map((i) => i.eventId), [b], "B is this run's only input; A is not");
  room.complete("W", "B: the answer is 42.");
  await room.tick();
  assert.equal(room.state(b), "answered");
  assert.equal(room.state(a), "open");
  assert.deepEqual(lastFinal(room, "W").disposition, { kind: "answer", requestIds: [b] });
});

test("case 2: a review held open under A keeps the Consigliere asleep; W's later final answers A once; C wakes once", async () => {
  room = await Room.create();
  const { u, a } = await handOut(room);
  await room.tick();
  assert.equal(room.running("W"), true);
  const r = room.post("W", "V", "Please review my fix to dates.ts.");
  assert.equal(room.p.requests.get(r)!.parentId, a);
  room.complete("W", "Fixed; sent to V for review.");
  await room.tick();
  assert.equal(room.state(a), "open", "A has an open child (the review)");
  assert.deepEqual(lastFinal(room, "W").claims.map((c) => c.outcome), ["pending_activity"]);
  const cWakes = room.wakes("C");
  await room.tick(2);
  assert.equal(room.wakes("C"), cWakes, "the Consigliere is not woken while the exchange is open");
  assert.equal(room.running("V"), true);
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.state(r), "answered");
  assert.equal(room.running("W"), true, "W is woken by the review's answer");
  assert.equal(room.wakes("C"), cWakes);
  room.complete("W", "A is fixed and reviewed (PASS).");
  await room.tick();
  assert.equal(room.answeredClaims(a).length, 1, "A answered exactly once");
  await room.tick();
  assert.equal(room.wakes("C"), cWakes + 1, "the Consigliere is woken exactly once, by A's answer");
  room.complete("C", "Report: fixed and reviewed.");
  await room.tick(3);
  assert.equal(room.state(u), "answered");
  assert.equal(room.wakes("C"), cWakes + 1);
  assert.equal(room.wakes("W"), 2);
  assert.equal(room.wakes("V"), 1);
  room.assertQuiet();
});

test("case 3: an error notice as W's only input answers nothing", async () => {
  room = await Room.create();
  const { a } = await handOut(room);
  await room.tick();
  room.post("W", "V", "Please review.");
  room.complete("W", "Sent for review.");
  await room.tick();
  assert.equal(room.running("V"), true);
  room.complete("V", "the provider crashed", { outcome: "error" });
  await room.tick();
  const notice = room.notices().find((n) => n.intent === "error")!;
  assert.deepEqual([...notice.recipients].sort(), ["C", "W"], "the failure notice goes to the asker and the orchestrator");
  assert.equal(room.running("W"), true, "W is woken by the notice");
  room.complete("W", "The review failed; waiting.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "W").disposition, { kind: "yield" });
  assert.equal(room.state(a), "open");
});

test("case 4: a correction is the only input, and one that lands after the watermark supersedes", async () => {
  room = await Room.create();
  const a = room.user("W", "Rename the module.");
  await room.tick();
  assert.equal(room.running("W"), true);
  room.host.correct(room.room, { actor: "$user", id: room.id("correct"), requestId: a, body: "Rename it to dates, not time." });
  room.complete("W", "Renamed to time.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "W").claims.map((c) => c.outcome), ["superseded"], "the unseen correction supersedes");
  assert.equal(room.state(a), "open");
  await room.tick();
  assert.equal(room.running("W"), true, "the correction is delivered next");
  assert.match(room.prompt("W"), /\[#\d+ correction from the user to #\d+\]\nRename it to dates/);
  assert.deepEqual(latestRun(room, "W").envelope.inputs.map((i) => i.intent), ["correction"], "the correction is the only input");
  room.complete("W", "Renamed to dates.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "W").disposition, { kind: "answer", requestIds: [a] });
  assert.equal(room.state(a), "answered");
});

test("case 5: the Consigliere answers a fresh U2 only while U1 waits on its child", async () => {
  room = await Room.create();
  const { u } = await handOut(room);
  const u2 = room.user("C", "Also: what is the branch name?");
  await room.tick();
  assert.match(room.prompt("C"), /what is the branch name/);
  room.complete("C", "The branch is engine.");
  await room.tick();
  assert.equal(room.state(u2), "answered");
  assert.equal(room.state(u), "open");
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "answer", requestIds: [u2] });
});

test("case 6: a result on R1 and a fresh U2 in one batch: one final answers U1 and U2", async () => {
  room = await Room.create();
  const { u, a } = await handOut(room);
  await room.tick();
  assert.equal(room.running("W"), true);
  const u0 = room.user("C", "Unrelated: summarise the README.");
  await room.tick();
  assert.equal(room.running("C"), true, "C is busy on U0");
  room.complete("W", "A is done.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  const u2 = room.user("C", "And U2: list the open PRs.");
  room.complete("C", "README summary.");
  await room.tick();
  assert.equal(room.state(u0), "answered");
  assert.equal(room.state(u), "open", "U0's final does not touch U1");
  await room.tick();
  assert.match(room.prompt("C"), /A is done/);
  assert.match(room.prompt("C"), /list the open PRs/);
  room.complete("C", "Report on U1 and the PR list.");
  await room.tick();
  assert.deepEqual([...(lastFinal(room, "C").disposition as { requestIds: string[] }).requestIds].sort(), [u, u2].sort());
  assert.equal(room.state(u), "answered");
  assert.equal(room.state(u2), "answered");
});

test("case 7 (K1): a review answer landing during W's turn supersedes W's final; the next run answers A; C wakes once", async () => {
  room = await Room.create();
  const { a } = await handOut(room);
  await room.tick();
  room.post("W", "V", "Review this while I keep working.");
  await room.tick();
  assert.equal(room.running("V"), true);
  assert.equal(room.running("W"), true, "W keeps working");
  room.complete("V", "Finding: the leap-year case is wrong.");
  await room.tick();
  const cWakes = room.wakes("C");
  room.complete("W", "A is done.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "W").claims.map((c) => c.outcome), ["superseded"], "the unseen review answer supersedes");
  assert.equal(room.state(a), "open");
  await room.tick();
  assert.equal(room.running("W"), true, "the next run delivers the review");
  assert.match(room.prompt("W"), /leap-year case is wrong/);
  assert.equal(room.wakes("C"), cWakes, "C is not woken by the superseded final");
  room.complete("W", "Fixed the leap-year case too.");
  await room.tick(2);
  assert.equal(room.answeredClaims(a).length, 1);
  assert.equal(room.wakes("C"), cWakes + 1, "C is woken exactly once, after A's answer");
});

test("three posts during a run are delivered together in one next run", async () => {
  room = await Room.create();
  room.user("W", "First job.");
  await room.tick();
  const posts = [room.user("W", "Second: one."), room.user("W", "Third: two."), room.user("W", "Fourth: three.")];
  room.complete("W", "First done.");
  await room.tick();
  assert.equal(room.wakes("W"), 2);
  for (const text of ["Second: one.", "Third: two.", "Fourth: three."]) assert.match(room.prompt("W"), new RegExp(text));
  room.complete("W", "All three done.");
  await room.tick();
  assert.equal(room.wakes("W"), 2, "one run for the three");
  for (const id of posts) assert.equal(room.state(id), "answered");
});

test("a member's own posts never wake itself; the exchange wakes each party once per answer", async () => {
  room = await Room.create();
  await handOut(room);
  await room.tick();
  room.post("W", "V", "Review please.");
  room.host.note(room.room, { actor: "W", id: room.id("note"), body: "Looking at the leap-year path too." });
  room.complete("W", "Sent.");
  await room.tick(3);
  assert.equal(room.wakes("W"), 1, "W's post and note do not wake W");
  room.complete("V", "PASS");
  await room.tick();
  room.complete("W", "Done after PASS.");
  await room.tick();
  room.complete("C", "Report.");
  await room.tick(3);
  assert.deepEqual([room.wakes("C"), room.wakes("W"), room.wakes("V")], [2, 2, 1]);
  room.assertQuiet();
});
