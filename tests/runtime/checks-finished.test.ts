/**
 * T3's watch of a pull request wakes on a change of the checks' rolled-up state or mergeability, not when a run
 * finishes: one failed job makes the state failing while the others run, and nothing wakes when the rest finish. So
 * Backroom tells the Consigliere once when a watched pull request goes from a check pending to none, with one failed:
 * a rerun is possible from then on (#187). Once per pull request and head; a run that passes, or one still running,
 * posts nothing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { T3PullRequestChecks, T3ThreadShell } from "../../src/adapter/types.ts";
import { checksReader } from "../../src/app/pullRequestWatch.ts";
import { createTestStack } from "../helpers.ts";
import { Room } from "./helpers.ts";

let room: Room | undefined;
afterEach(() => {
  room?.close();
  room = undefined;
});

const finished = (r: Room) => r.notices().filter((n) => n.causeId.startsWith("checks:"));
const checks = (list: Array<[string, T3PullRequestChecks["checks"][number]["status"]]>): T3PullRequestChecks => ({ observedAt: null, checks: list.map(([name, status]) => ({ name, status, required: true })) });

/** A room whose host reads the checks through the shared reader, on the room's clock. */
async function watchedRoom(): Promise<Room> {
  let read: ((shell: T3ThreadShell) => Promise<Map<string, T3PullRequestChecks | null>>) | null = null;
  const r = await Room.create({ host: { watchedChecks: (shell) => read!(shell) } });
  read = checksReader(r.fake.pullRequestChecks.bind(r.fake), () => r.clock);
  return r;
}

let synced = 0;
/** The Consigliere's watch of #77 on head `head`, with T3's checks read giving `list`. */
function watch(r: Room, list: Array<[string, T3PullRequestChecks["checks"][number]["status"]]>, head = "a8a71af", seat = "C"): void {
  synced += 1;
  r.fake.linkPullRequest(r.threadOf(seat), { repository: "example-org/canvas", number: 77, watched: true, headSha: head, checksState: list.some(([, s]) => s === "failure") ? "failing" : "pending", syncedAt: new Date(Date.UTC(2026, 9, 30, 22, 0, synced)).toISOString(), checks: checks(list) });
}

test("a watched run with a failed check, then none pending, is one notice to the Consigliere naming the pull request and the failed check; it is never told again, across ticks and a restart", async () => {
  room = await watchedRoom();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"], ["Lint", "success"]]);
  await room.tick(2);
  assert.equal(finished(room).length, 0, "a check still pending: a rerun is not possible yet");
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"], ["Lint", "success"]]);
  await room.tick(2);
  const notices = finished(room);
  assert.deepEqual(notices.map((n) => [n.intent, n.author, n.recipients, n.requestIds]), [["attention", "$system", ["C"], []]], "on the Consigliere's own watch, to him, on no request");
  assert.equal(notices[0]!.body, "Pull request #77 (example-org/canvas), watched on @C's thread: its checks have finished, 1 failed (Hex registry). A rerun of the failed checks is possible now; T3's watch does not wake on a run finishing.");
  await room.tick(3);
  room.restart();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"], ["Lint", "success"]]);
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"], ["Lint", "success"]]);
  await room.tick(3);
  assert.equal(finished(room).length, 1, "the same pull request and head posts nothing more, though the new host saw a check pending again");
});

test("a new head with the same outcome is told again; a member's watch is told too", async () => {
  room = await watchedRoom();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"]], "a8a71af", "W");
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"]], "a8a71af", "W");
  await room.tick();
  watch(room, [["Hex registry", "pending"], ["Elixir tests", "pending"]], "c0ffee1", "W");
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"]], "c0ffee1", "W");
  await room.tick(2);
  assert.deepEqual(finished(room).map((n) => [n.recipients, n.causeId]), [
    [["C"], "checks:pull-request-watch:github.com/example-org/canvas#77@a8a71af"],
    [["C"], "checks:pull-request-watch:github.com/example-org/canvas#77@c0ffee1"],
  ]);
  assert.match(finished(room)[0]!.body, /watched on @W's thread/);
});

test("a run whose checks all pass, or one with a check still pending, posts nothing", async () => {
  room = await watchedRoom();
  watch(room, [["Hex registry", "pending"], ["Lint", "success"]]);
  await room.tick();
  watch(room, [["Hex registry", "success"], ["Lint", "success"]]);
  await room.tick(2);
  assert.equal(finished(room).length, 0, "all passed: T3's watch wakes on that change itself");
  watch(room, [["Hex registry", "pending"], ["Lint", "pending"]], "c0ffee1");
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Lint", "pending"]], "c0ffee1");
  await room.tick(3);
  assert.equal(finished(room).length, 0, "one failed, one still pending: a rerun is not possible yet");
});

test("a read that lists no checks says nothing of the run: the failure after it is still told", async () => {
  room = await watchedRoom();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"]]);
  await room.tick();
  watch(room, []);
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"]]);
  await room.tick(2);
  assert.equal(finished(room).length, 1);
});

test("two rooms whose Consiglieri watch the same pull request and head each get their one notice (Sol, #228)", async () => {
  const s = await createTestStack({ autoCompleteMs: null }, ["first"]);
  try {
    await s.run({ type: "room.consigliere.set", roomId: s.roomId, participantId: s.participants.first! });
    const { roomId: second } = (await s.run({ type: "room.create", projectId: "project_demo", title: "Second" })) as { roomId: string };
    const { participantId } = (await s.run({ type: "participant.create", roomId: second, alias: "second", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } })) as { participantId: string };
    await s.run({ type: "room.consigliere.set", roomId: second, participantId });
    const threads = [s.threadOf("first"), s.repos.currentBinding(participantId)!.threadId];
    const read = (last: "pending" | "success", second: number) =>
      threads.forEach((threadId) => s.fake.linkPullRequest(threadId, { repository: "example-org/canvas", number: 77, headSha: "a8a71af", watched: true, checksState: "failing", syncedAt: new Date(Date.UTC(2026, 9, 30, 22, 0, second)).toISOString(), checks: checks([["Hex registry", "failure"], ["Elixir tests", last]]) }));
    const counts = () => [s.roomId, second].map((id) => s.engine.view(id).events.filter((e) => e.data.kind === "notice" && e.data.causeId.startsWith("checks:")).length);
    read("pending", 1);
    await s.tick(2);
    assert.deepEqual(counts(), [0, 0]);
    read("success", 2);
    await s.tick(4);
    assert.deepEqual(counts(), [1, 1], "one notice on each board");
  } finally {
    s.close();
  }
});

test("two seats of one room watching the same pull request and head are one notice on its board", async () => {
  room = await watchedRoom();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"]], "a8a71af", "C");
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "pending"]], "a8a71af", "W");
  await room.tick();
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"]], "a8a71af", "C");
  watch(room, [["Hex registry", "failure"], ["Elixir tests", "success"]], "a8a71af", "W");
  await room.tick(3);
  assert.equal(finished(room).length, 1);
});
