/**
 * The Consigliere is told what holds a member's request where no reply of the member's own will end it, as T3 tells the
 * user (#76): an approval, a secret or a question for the user, a usage limit, a queue T3 holds, the thread settled,
 * archived or deleted in T3. One notice per request per state, on the request; a state that persists or clears, or a
 * member that owns no open request, posts nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room | undefined;
afterEach(() => {
  room?.close();
  room = undefined;
});

/** The blocked-state notices: Backroom's attention notices about a member, not the engine's own. */
const held = (r: Room) => r.notices().filter((n) => n.intent === "attention" && n.causeId.startsWith("blocked:"));
/** A blocked notice's seat and state ("blocked:W:approval"), without the hold that follows them. */
const kind = (n: { causeId: string }) => n.causeId.split(":").slice(0, 3).join(":");

/** W works on the Consigliere's request A; returns A. */
async function wOnA(r: Room): Promise<string> {
  const a = r.post("C", "W", "A: fix the flaky test.");
  await r.tick();
  assert.equal(r.running("W"), true);
  return a;
}

test("an approval on a member's turn is one notice to the Consigliere on the request it holds, naming what is asked; it persists and clears without another", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const threadId = room.threadOf("W");
  const requestId = room.fake.raiseApproval(threadId, "req-1", { prompt: "rm -rf build/" });
  await room.tick(3);
  room.restart();
  await room.tick(2);
  const notices = held(room);
  assert.equal(notices.length, 1, "once, through ticks and a restart");
  assert.deepEqual([notices[0]!.author, notices[0]!.recipients, notices[0]!.requestIds], ["W", ["C"], [a]], "from the member, to the Consigliere, on the request it holds");
  assert.match(notices[0]!.body, /^@W waits on an approval: rm -rf build\/\. Only the user can answer it, from the page; @W's reply comes after\.$/);
  await room.fake.respondApproval({ commandId: "ok", threadId, requestId, decision: "accept" });
  await room.tick(2);
  assert.equal(held(room).length, 1, "clearing posts nothing: the member's reply is the news");
  room.complete("W", "A fixed.");
  await room.tick(2);
  assert.equal(room.state(a), "answered");
  assert.equal(held(room).length, 1);
});

test("a secret and a question are each one notice, naming what is asked", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const threadId = room.threadOf("W");
  room.fake.raiseSecret(threadId, { label: "GITHUB_TOKEN", reason: "to push the branch" });
  await room.tick(2);
  assert.deepEqual(held(room).map((n) => [kind(n), n.requestIds, n.body]), [["blocked:W:secret", [a], "@W asks for a secret: GITHUB_TOKEN. Only the user can answer it, from the page; @W's reply comes after."]]);

  room.close();
  room = await Room.create();
  const b = await wOnA(room);
  room.fake.raiseQuestion(room.threadOf("W"), { questions: [{ id: "q", header: "Branch", question: "Which branch do I push to?", options: [] }] });
  await room.tick(3);
  assert.deepEqual(held(room).map((n) => [kind(n), n.requestIds, n.body]), [["blocked:W:input", [b], "@W waits on an answer to a question: Which branch do I push to? Only the user can answer it, from the page; @W's reply comes after."]]);
});

test("a usage limit holding a new request is one notice on it, with when and whether T3 continues; the turn the limit stopped keeps its own notice only", async () => {
  room = await Room.create({ host: { timeZone: "UTC" } });
  const a = await wOnA(room);
  const resetAt = new Date(room.clock + 3_600_000).toISOString();
  room.complete("W", "Claude API rate limit reached.", { outcome: "limit", resetAt });
  await room.tick(3);
  assert.equal(held(room).length, 0, "the limited turn's own notice says it, on A");
  const b = room.post("C", "W", "B: and the docs.");
  await room.tick(4);
  const notices = held(room);
  assert.equal(notices.length, 1);
  assert.deepEqual([kind(notices[0]!), notices[0]!.requestIds], ["blocked:W:limited", [b]], "on B, which waits behind the pause; A has its notice");
  assert.match(notices[0]!.body, /^@W is paused on Claude's usage limit, until \d\d:\d\d \(UTC\): T3 is not yet set to continue it\. What it was sent waits behind it/);
  assert.equal(room.state(a), "open");
});

test("an earlier turn's pause does not stand for a later limit: a request paused once, then waiting behind another run's limit, is told", async () => {
  room = await Room.create({ host: { timeZone: "UTC" } });
  const a = await wOnA(room);
  const threadId = room.threadOf("W");
  room.complete("W", "Claude API rate limit reached.", { outcome: "limit", resetAt: new Date(room.clock + 3_600_000).toISOString() });
  await room.tick(3);
  const first = room.fake.runsOf(threadId).at(-1)!;
  await room.fake.controlThread({ commandId: "continue", threadId, control: { type: "run.continue", runId: first.id } });
  await room.tick();
  room.complete("W", "Half of A; more to do.");
  await room.tick(3);
  assert.equal(room.state(a), "open", "A's continuation is a follow-up: A stays open");
  const b = room.post("C", "W", "B: and the docs.");
  await room.tick(2);
  room.complete("W", "Claude API rate limit reached again.", { outcome: "limit", resetAt: new Date(room.clock + 7_200_000).toISOString() });
  await room.tick(4);
  assert.equal(held(room).filter((n) => n.requestIds.includes(b)).length, 0, "B has its own run's pause notice");
  assert.deepEqual(held(room).filter((n) => n.requestIds.includes(a)).map(kind), ["blocked:W:limited"], "A's pause notice was the first run's; this limit is another hold on it");
});

test("a queue T3 holds after a failed turn is one notice on the open request", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  const threadId = room.threadOf("W");
  await room.fake.sendMessage({ commandId: "typed", threadId, messageId: "typed", text: "Also look at the logs.", mode: { type: "queue" } });
  room.complete("W", "overloaded_error", { outcome: "error" });
  await room.tick(3);
  const notices = held(room);
  assert.deepEqual(notices.map((n) => [kind(n), n.requestIds]), [["blocked:W:held", [a]]]);
  assert.match(notices[0]!.body, /^T3 holds @W's queue \(1 queued message held by T3, held after the last turn failed: overloaded_error\): nothing sent to @W runs until the user presses Resume queue on the member\.$/);
});

test("a thread settled, archived or deleted in T3 while seated is one notice on each open request", async (t) => {
  for (const action of ["settle", "archive", "delete"] as const) await t.test(action, async () => {
    room = await Room.create();
    const a = await wOnA(room);
    await room.fake.setThreadLifecycle({ commandId: action, threadId: room.threadOf("W"), action });
    await room.tick(3);
    const state = { settle: "settled", archive: "archived", delete: "deleted" }[action];
    const body = state === "settled"
      ? "@W's T3 thread was settled in T3 (marked done there) while seated, with this request open. Ask the user whether that was meant; reseat or retire @W if it was."
      : `@W's T3 thread was ${state} in T3 while seated: no reply will come from it. Reseat or retire @W, or report it.`;
    assert.deepEqual(held(room).map((n) => [kind(n), n.requestIds, n.body]), [[`blocked:W:${state}`, [a], body]]);
    room.close();
    room = undefined;
  });
});

test("nothing is posted for a member that owns no open request, for the Consigliere's own thread, or for working", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  await room.tick(3);
  assert.equal(held(room).length, 0, "working is read, not posted");
  room.complete("W", "A fixed.");
  await room.tick(2);
  assert.equal(room.state(a), "answered");
  room.fake.startSelfRun(room.threadOf("W"));
  room.fake.raiseApproval(room.threadOf("W"), "req-own", { prompt: "git push" });
  await room.tick(3);
  assert.equal(held(room).length, 0, "no open request of W's to hold");

  const u = room.user("C", "Plan the release.");
  await room.tick();
  room.fake.raiseApproval(room.threadOf("C"), "req-c", { prompt: "git tag" });
  await room.tick(3);
  assert.equal(room.state(u), "open");
  assert.equal(held(room).length, 0, "the Consigliere's approval is the user's, on the page");
});

test("a failed turn's notice says when it is the second failure on the same request after a retry", async () => {
  room = await Room.create();
  const a = await wOnA(room);
  room.complete("W", "The model is at capacity.", { outcome: "error" });
  await room.tick(2);
  const first = room.notices().filter((n) => n.intent === "error" && n.requestIds.includes(a));
  assert.equal(first.length, 1);
  assert.doesNotMatch(first[0]!.body, /after a retry/);
  const failed = room.fake.runsOf(room.threadOf("W"))[0]!;
  const run = [...room.p.runs.values()].find((r) => r.seatId === "W")!;
  assert.ok(failed && run);
  room.host.retry(room.room, { actor: "C", id: room.id("retry"), runId: run.id, body: "Try A again." });
  await room.tick(2);
  room.complete("W", "The model is at capacity.", { outcome: "error" });
  await room.tick(2);
  const second = room.notices().filter((n) => n.intent === "error" && n.requestIds.includes(a));
  assert.equal(second.length, 2);
  assert.match(second[1]!.body, /The model is at capacity\.\n\nThis is the second failure on this request, after a retry\./);
});
