/**
 * The Consigliere is told when a member's running turn has gone silent: no new turn item from T3 for five minutes, then
 * again at each doubling of the silence, measured from the last item's time as T3 records it. One notice per threshold
 * on each open request of the member's; a new item ends the spell. A member held in a state the hold notices already
 * tell, the Consigliere himself, a member with no open request and a member with no running turn are not told silent.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { T3TurnItem } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

const MIN = 60_000;

let room: Room | undefined;
afterEach(() => {
  room?.close();
  room = undefined;
  mock.timers.reset();
});

/** The silent notices about a seat. */
const silent = (r: Room, seat = "W") => r.notices().filter((n) => n.intent === "attention" && n.causeId.startsWith(`blocked:${seat}:silent:`));

/**
 * A room whose host and fake T3 share one mocked clock (the fake stamps its items with Date.now), with W working on the
 * Consigliere's requests; returns them and the time the test's items start from, a minute after anything stamped.
 */
async function working(bodies = ["A: fix the flaky test."]): Promise<{ r: Room; ids: string[]; t0: number }> {
  mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const r = await Room.create({ host: { now: () => Date.now() } });
  const ids = bodies.map((body) => r.post("C", "W", body));
  await r.tick();
  assert.equal(r.running("W"), true);
  return { r, ids, t0: Date.now() + MIN };
}

/** A command item on W's running turn, started and last updated at `at`. */
function command(r: Room, input: string, at: number, status: T3TurnItem["status"] = "running"): T3TurnItem {
  const thread = r.fake.thread(r.threadOf("W"));
  const iso = new Date(at).toISOString();
  const item: T3TurnItem = {
    id: `item:${at}`, runId: r.fake.liveRun(r.threadOf("W"))!.id, nodeId: null, providerTurnId: null,
    ordinal: thread.turnItems.reduce((max, x) => Math.max(max, x.ordinal), 0) + 1, status, title: "Bash",
    startedAt: iso, completedAt: null, updatedAt: iso,
    type: "command_execution", input, output: null, exitCode: null, outputIndicatesFailure: false,
  };
  thread.turnItems.push(item);
  return item;
}

async function at(r: Room, time: number, ticks = 2): Promise<void> {
  mock.timers.setTime(time);
  await r.tick(ticks);
}

test("five minutes without an item is one notice on each open request, naming the last item; again at ten and twenty, not between", async () => {
  const { r, ids, t0 } = await working(["A: fix the flaky test.", "B: and the docs."]);
  room = r;
  command(r, "until [ -f summary.txt ]; do sleep 10; done", t0);
  await at(r, t0 + 5 * MIN - 1000);
  assert.equal(silent(r).length, 0, "under five minutes is not silent");
  await at(r, t0 + 5 * MIN);
  const first = silent(r);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.author, first[0]!.recipients, [...first[0]!.requestIds].sort()], ["W", ["C"], [...ids].sort()], "from the member, to the Consigliere, on each open request");
  assert.equal(first[0]!.body, "@W has been silent for 5 minutes in a running turn: T3 has delivered nothing new on it, and its last item is a command_execution, until [ -f summary.txt ]; do sleep 10; done (running, started 5 minutes ago). A long command looks the same until it returns: check on it or wait, and report to the user if it does not end. Backroom stops nothing; this is information, not a failure.");
  await at(r, t0 + 6 * MIN);
  await at(r, t0 + 9 * MIN);
  assert.equal(silent(r).length, 1, "nothing more before the doubling");
  await at(r, t0 + 10 * MIN);
  assert.equal(silent(r).length, 2, "one at ten minutes");
  assert.match(silent(r)[1]!.body, /^@W has been silent for 10 minutes/);
  await at(r, t0 + 15 * MIN);
  await at(r, t0 + 20 * MIN);
  assert.equal(silent(r).length, 3, "one at twenty minutes");
  assert.match(silent(r)[2]!.body, /^@W has been silent for 20 minutes/);
  assert.deepEqual(ids.map((id) => r.state(id)), ["open", "open"], "Backroom stops and answers nothing");
  assert.equal(r.running("W"), true);
});

test("a new item ends the spell: the next notice comes five minutes after it, naming it", async () => {
  const { r, t0 } = await working();
  room = r;
  command(r, "npm test", t0, "completed");
  await at(r, t0 + 5 * MIN);
  assert.equal(silent(r).length, 1);
  command(r, "npm run check", t0 + 7 * MIN);
  await at(r, t0 + 10 * MIN);
  assert.equal(silent(r).length, 1, "three minutes after the new item is not silent, and the old spell's ten minutes is gone");
  await at(r, t0 + 12 * MIN);
  const notices = silent(r);
  assert.equal(notices.length, 2);
  assert.match(notices[1]!.body, /^@W has been silent for 5 minutes .* its last item is a command_execution, npm run check \(running, started 5 minutes ago\)\./);
  assert.match(notices[0]!.body, /npm test \(completed, started 5 minutes ago\)/);
});

test("a member held on an approval is told the approval, not silent; once answered, the silence is told", async () => {
  const { r, ids, t0 } = await working();
  room = r;
  command(r, "git push", t0);
  const threadId = r.threadOf("W");
  const requestId = r.fake.raiseApproval(threadId, "req-1", { prompt: "git push" });
  await at(r, t0 + 5 * MIN);
  await at(r, t0 + 9 * MIN);
  assert.equal(silent(r).length, 0);
  assert.deepEqual(r.notices().filter((n) => n.causeId.startsWith("blocked:W:approval:")).map((n) => n.requestIds), [ids]);
  await r.fake.respondApproval({ commandId: "ok", threadId, requestId, decision: "accept" });
  await at(r, t0 + 10 * MIN);
  assert.equal(silent(r).length, 1, "the hold cleared, the turn is still silent");
});

test("the Consigliere's own silent turn posts nothing; a member's beside it is told", async () => {
  const { r, ids, t0 } = await working();
  room = r;
  command(r, "npm test", t0);
  r.user("C", "Plan the release.");
  await r.tick();
  assert.equal(r.running("C"), true);
  await at(r, t0 + 20 * MIN);
  assert.equal(r.notices().filter((n) => n.causeId.startsWith("blocked:C:")).length, 0);
  assert.deepEqual(silent(r).map((n) => n.requestIds), [ids]);
});

test("a member with no open request posts nothing; a request it then holds is told", async () => {
  const { r, ids, t0 } = await working();
  room = r;
  r.complete("W", "A fixed.");
  await r.tick(2);
  assert.equal(r.state(ids[0]!), "answered");
  r.fake.startSelfRun(r.threadOf("W"));
  await r.tick();
  assert.equal(r.running("W"), true, "a turn of the member's own, on no open request");
  await at(r, t0 + 20 * MIN);
  assert.equal(silent(r).length, 0);
  const b = r.post("C", "W", "B: and the docs.");
  r.complete("W", "My own turn is done.");
  await r.tick(3);
  assert.equal(r.running("W"), true, "B runs");
  command(r, "npm run check", t0 + 21 * MIN);
  await at(r, t0 + 26 * MIN);
  assert.deepEqual(silent(r).map((n) => n.requestIds), [[b]]);
});

test("a member with an open request and no running turn, only background work, posts nothing; its next turn is told", async () => {
  const { r, ids, t0 } = await working();
  room = r;
  r.complete("W", "overloaded_error", { outcome: "error" });
  r.fake.background(r.threadOf("W"), ["build"]);
  await r.tick(2);
  assert.equal(r.state(ids[0]!), "open");
  assert.equal(r.running("W"), false);
  await at(r, t0 + 20 * MIN);
  assert.equal(silent(r).length, 0);
  const b = r.post("C", "W", "B: try again.");
  await r.tick();
  assert.equal(r.running("W"), true);
  command(r, "npm run check", t0 + 21 * MIN);
  await at(r, t0 + 26 * MIN);
  assert.deepEqual(silent(r).map((n) => [...n.requestIds].sort()), [[ids[0]!, b].sort()]);
});

test("across a restart, the silence is measured from the item's time and a threshold told before is not told again", async () => {
  const { r, t0 } = await working();
  room = r;
  command(r, "npm run rehearse -- --step all", t0);
  await at(r, t0 + 4 * MIN);
  r.restart();
  await at(r, t0 + 5 * MIN);
  assert.equal(silent(r).length, 1, "five minutes from the item, not from the new host's start");
  r.restart();
  await at(r, t0 + 6 * MIN);
  assert.equal(silent(r).length, 1, "the five-minute notice is not told again");
  r.restart();
  await at(r, t0 + 10 * MIN);
  assert.equal(silent(r).length, 2);
  r.restart();
  await at(r, t0 + 11 * MIN);
  assert.equal(silent(r).length, 2);
});
