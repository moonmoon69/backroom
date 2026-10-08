/**
 * "Lean semantics" §1, as H5 left it (members only answer): which requests a final answers, and who is woken. A final
 * answers the open requests its run was given; results and notices select nothing; nothing is held, so the
 * Consigliere's hand-off answers the user and every member answer wakes it. The required cases that still apply, the
 * worker → orchestrator → reviewer exchange the orchestrator relays with one orchestrator wake per answer, and posts
 * made during a run delivered together in the next one. Wakes are T3 runs on each seat's thread.
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

/** The user asks the Consigliere for U; the Consigliere hands A to W during its turn. Nothing holds U open (H5). */
async function handOut(r: Room): Promise<{ u: string; a: string }> {
  const u = r.user("C", "Fix the date bug and report.");
  await r.tick();
  assert.equal(r.running("C"), true);
  const a = r.post("C", "W", "Fix dates.ts; have it reviewed.");
  r.complete("C", "Handed the fix to W.");
  await r.tick();
  assert.equal(r.p.requests.get(a)!.parentId, null, "no post goes under another request since H5");
  assert.equal(r.state(u), "answered", "the hand-off answers U: no hold for the work it handed out");
  assert.deepEqual(lastFinal(r, "C").disposition, { kind: "answer", requestIds: [u] });
  return { u, a };
}

test("case 1: woken for B only, the final answers B and A stays open", async () => {
  room = await Room.create();
  const a = room.user("W", "Request A: a long job.");
  await room.tick();
  // Nothing holds A open since H5: it stays open when its run did not answer it. T3 fails the turn; A waits for a retry.
  room.complete("W", "the provider crashed", { outcome: "error" });
  await room.tick();
  assert.equal(room.state(a), "open");
  assert.deepEqual(lastFinal(room, "W").disposition, { kind: "error", requestIds: [a] });
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

test("case 3: an error notice as the Consigliere's only input answers nothing", async () => {
  room = await Room.create();
  const { a } = await handOut(room);
  await room.tick();
  assert.equal(room.running("W"), true);
  // Only the orchestrator and the user ask since H5, so an error notice reaches the orchestrator, never a member.
  room.complete("W", "the provider crashed", { outcome: "error" });
  await room.tick();
  const notices = room.notices().filter((n) => n.intent === "error");
  assert.equal(notices.length, 1);
  assert.deepEqual([...notices[0]!.recipients], ["C"], "the failure notice goes to the asker, here the orchestrator, once");
  assert.equal(room.running("C"), true, "C is woken by the notice");
  assert.deepEqual(latestRun(room, "C").envelope.inputs.map((i) => i.intent), ["error"], "the notice is the run's only input");
  room.complete("C", "W's turn failed; waiting.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "yield" });
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

test("case 5: the Consigliere's final for a fresh U2 answers U2 only; U1, answered by the hand-off, is not answered again", async () => {
  room = await Room.create();
  const { u } = await handOut(room);
  const u2 = room.user("C", "Also: what is the branch name?");
  await room.tick();
  assert.match(room.prompt("C"), /what is the branch name/);
  room.complete("C", "The branch is engine.");
  await room.tick();
  assert.equal(room.state(u2), "answered");
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "answer", requestIds: [u2] });
  assert.equal(room.answeredClaims(u).length, 1, "U1 answered once, by the hand-off");
});

test("case 6: a result on A and a fresh U2 in one batch: the final answers U2 only, the result selects nothing", async () => {
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
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "answer", requestIds: [u0] }, "U0's final answers U0 only");
  await room.tick();
  assert.match(room.prompt("C"), /A is done/);
  assert.match(room.prompt("C"), /list the open PRs/);
  room.complete("C", "Report on A and the PR list.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "answer", requestIds: [u2] });
  assert.equal(room.state(u2), "answered");
  assert.equal(room.answeredClaims(u).length, 1, "U1 answered once, by the hand-off");
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

test("a member's own note never wakes itself, it cannot post; the relayed exchange wakes each party once per answer", async () => {
  room = await Room.create();
  const { a } = await handOut(room);
  await room.tick();
  assert.equal(room.running("W"), true);
  const head = room.p.events.length;
  assert.throws(() => room.post("W", "V", "Review please."), { name: "HostRefusal" });
  assert.equal(room.p.events.length, head, "the refused post appends nothing");
  room.host.note(room.room, { actor: "W", id: room.id("note"), body: "Looking at the leap-year path too." });
  room.complete("W", "Fixed dates.ts.");
  await room.tick(3);
  assert.equal(room.wakes("W"), 1, "W's note does not wake W");
  assert.equal(room.answeredClaims(a).length, 1, "W's final answers A once");
  assert.equal(room.running("C"), true, "A's answer wakes C");
  assert.match(room.prompt("C"), /Fixed dates\.ts/);
  // The orchestrator relays the review: members do not ask each other since H5.
  const r = room.post("C", "V", "Review W's fix to dates.ts.");
  room.complete("C", "Sent W's fix to V.");
  await room.tick();
  assert.deepEqual(lastFinal(room, "C").disposition, { kind: "yield" }, "a later Consigliere final answers nothing: an update");
  assert.equal(room.running("V"), true);
  room.complete("V", "PASS");
  await room.tick();
  assert.equal(room.answeredClaims(r).length, 1);
  room.complete("C", "Report: fixed and reviewed.");
  await room.tick(3);
  // C: the user's request, A's answer, the review's answer.
  assert.deepEqual([room.wakes("C"), room.wakes("W"), room.wakes("V")], [3, 1, 1]);
  room.assertQuiet();
});
