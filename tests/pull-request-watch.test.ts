/**
 * T3's watch of a pull request says what it waits for (the user's #160, item D): from T3's checks read when it has one,
 * else the link's checksState, with the watch's age as T3 records it. The watch's task keeps its title, so a changing
 * line never reads as work that ended.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { T3PullRequest, T3PullRequestChecks } from "../src/adapter/types.ts";
import { STALE_MS, ageWords, watchLine } from "../src/app/pullRequestWatch.ts";
import { backgroundTasks } from "../src/app/threadView.ts";
import { memberStatus } from "../src/runtime/status.ts";
import { memberActivity } from "../web/src/memberActivity.ts";
import { jobsLine } from "../src/domain/memberState.ts";
import { t3Stub } from "./t3Stub.ts";
import { createTestStack } from "./helpers.ts";

const NOW = Date.parse("2026-10-30T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

/** PR #70 as T3 keeps it while it watches it: the shapes stored in statev2.sqlite. */
const link = (snapshot: Record<string, unknown> = {}, watch: Partial<NonNullable<T3PullRequest["watch"]>> | null = {}): T3PullRequest => ({
  host: "github.com",
  repository: "example-org/shop",
  number: 70,
  url: "https://github.com/example-org/shop/pull/70",
  source: "created",
  snapshot: { state: "open", title: "Rerun the browser harness", checksState: "pending", syncedAt: ago(60_000), ...snapshot },
  watch: watch === null ? null : { startedAt: ago(8 * H + 20 * 60_000), headSha: "a8a71af", failedChecks: [], passedChecks: [], passed: false, checksAwaitedSince: null, ...watch },
});
const checks = (list: Array<[string, T3PullRequestChecks["checks"][number]["status"]]>, observedMsAgo = 30_000): T3PullRequestChecks => ({ observedAt: ago(observedMsAgo), checks: list.map(([name, status]) => ({ name, status, required: true })) });

test("the watch's line says what its pull request waits for, from the freshest of T3's sources, and the watch's age as T3 records it", () => {
  assert.equal(watchLine(link(), checks([["Browser harness", "pending"], ["vet + test", "success"]]), NOW), "Watching pull request #70: 1 check pending (Browser harness) · watched for 8h");
  assert.equal(watchLine(link(), checks([["A", "pending"], ["B", "action-required"], ["C", "pending"], ["D", "success"]]), NOW), "Watching pull request #70: 3 checks pending (A, B, …) · watched for 8h");
  assert.equal(watchLine(link({ checksState: "failing" }), checks([["Trivy", "failure"], ["vet", "success"]]), NOW), "Watching pull request #70: 1 check failing (Trivy) · watched for 8h");
  assert.equal(watchLine(link(), checks([["A", "success"], ["B", "skipped"]]), NOW), "Watching pull request #70: checks passed · watched for 8h", "green checks leave no pending claim, whatever the older snapshot said");
  assert.equal(watchLine(link(), null, NOW), "Watching pull request #70: checks pending · watched for 8h", "no checks read: the snapshot's checksState, no count");
  assert.equal(watchLine(link({ checksState: "failing" }, { failedChecks: ["Trivy (secrets + IaC misconfig)"] }), null, NOW), "Watching pull request #70: 1 check failing (Trivy (secrets + IaC misconfig)) · watched for 8h");
  assert.equal(watchLine(link({ checksState: "passing" }), null, NOW), "Watching pull request #70: checks passed · watched for 8h");
  assert.equal(watchLine(link({ checksState: "pending", syncedAt: ago(40 * 60_000) }), null, NOW), "Watching pull request #70: checks pending, as of 40m ago · watched for 8h", "an old reading says its age");
  assert.equal(watchLine(link({ syncedAt: ago(STALE_MS + 120_000) }), checks([["Browser harness", "pending"]], STALE_MS + 60_000), NOW), "Watching pull request #70: 1 check pending (Browser harness), as of 16m ago · watched for 8h", "the later of two old readings, with its age");
  assert.equal(watchLine(link({ checksState: "passing", syncedAt: ago(60_000) }), checks([["Browser harness", "pending"]], 3_600_000), NOW), "Watching pull request #70: checks passed · watched for 8h", "a checks read older than the snapshot gives way to it");
  assert.equal(watchLine(link({ checksState: null }), null, NOW), "Watching pull request #70: checks not known yet · watched for 8h", "nothing known is said so");
  assert.equal(watchLine(link({ checksState: null }, { checksAwaitedSince: ago(25 * 60_000) }), null, NOW), "Watching pull request #70: no checks yet, for 25m · watched for 8h");
  assert.equal(watchLine(link({ state: "merged" }), null, NOW), "Watching pull request #70: merged · watched for 8h");
  assert.equal(watchLine(link({ snapshot: null } as never, null), null, NOW).startsWith("Watching pull request #70: "), true);
  assert.deepEqual([ageWords(5 * 60_000), ageWords(8.5 * H), ageWords(51 * H)], ["5m", "8h", "2d 3h"]);
});

test("the HTTP adapter reads T3's link with its watch, and the checks with T3's cached read", async () => {
  const thread = {
    id: "t", projectId: "proj", title: "pr", providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" }, latestRunId: null, activeRunId: null, status: "completed", pendingRuntimeRequest: null, hasActionableProposedPlan: false,
    latestUserMessageAt: null, createdAt: ago(H), updatedAt: ago(0), archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null,
    pullRequests: [
      { host: "github.com", repository: "example-org/shop", number: 70, url: "u", source: "created", linkedAt: ago(9 * H), snapshot: { state: "open", checksState: "pending", syncedAt: ago(0) }, stack: null, watch: { startedAt: ago(8 * H), headSha: "a8a", failedChecks: [], passed: false, passedChecks: ["vet"], remarksThrough: ago(0), remarkIds: [], conflicting: false, wakes: 0, checksAwaitedSince: null } },
      { host: "github.com", repository: "example-org/shop", number: 65, url: "u", source: "created", linkedAt: ago(9 * H), snapshot: { state: "merged", checksState: "passing" }, stack: null, endedWatch: { startedAt: ago(9 * H) } },
    ],
  };
  const { adapter, frames } = t3Stub({ "/api/orchestration/shell": { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [thread] } }, (frame) =>
    frame.tag === "pullRequests.checks" ? { observedAt: NOW - 30_000, state: "open", checks: [{ name: "Browser harness", status: "pending", description: null, url: null, required: true }, { name: "odd", status: "exploded" }] } : null,
  );
  const [shell] = await adapter.listThreads();
  assert.deepEqual(shell!.pullRequests.map((pr) => [pr.number, pr.host, pr.watch?.startedAt ?? null, pr.watch?.passedChecks ?? null]), [[70, "github.com", ago(8 * H), ["vet"]], [65, "github.com", null, null]], "an ended watch is none");
  const read = await adapter.pullRequestChecks({ projectId: "proj", host: "github.com", repository: "example-org/shop", number: 70 });
  assert.deepEqual(frames.filter((f) => f.tag === "pullRequests.checks").map((f) => f.payload), [{ projectId: "proj", host: "github.com", repository: "example-org/shop", number: 70, allowStale: true }]);
  assert.deepEqual(read, { observedAt: new Date(NOW - 30_000).toISOString(), checks: [{ name: "Browser harness", status: "pending", required: true }] }, "a status T3 does not list is left out");
});

test("a watch's task keeps its title and the member's status line while its line changes: no false quiet follow-up; several watches and repositories each say theirs", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "l", threadId: "t", projectId: "project_demo", title: "pr", modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Open the PRs." } });
  fake.completeRun("t", { text: "Opened #70 and web#12; watching both." });
  fake.linkPullRequest("t", { repository: "example-org/shop", number: 70, watched: true, checksState: "pending", startedAt: ago(8 * H), syncedAt: ago(60_000) });
  fake.linkPullRequest("t", { repository: "example-org/web", number: 12, watched: true, checksState: "failing", failedChecks: ["lint"], startedAt: ago(H), syncedAt: ago(60_000) });
  const at = (detailChecks: Map<string, T3PullRequestChecks | null>) => fake.getThreadDetail("t").then((d) => backgroundTasks(d!, NOW, detailChecks));
  const before = await at(new Map());
  const after = await at(new Map([["pull-request-watch:github.com/example-org/shop#70", checks([["Browser harness", "pending"]])]]));
  assert.deepEqual(before.map((t) => [t.taskId, t.title]), after.map((t) => [t.taskId, t.title]), "the same tasks, the same titles");
  assert.deepEqual(after.map((t) => t.detail), ["Watching pull request #70: 1 check pending (Browser harness) · watched for 8h", "Watching pull request #12: 1 check failing (lint) · watched for 1h"]);
  const detail = (await fake.getThreadDetail("t"))!;
  assert.deepEqual(memberStatus(detail, null).running, ['monitor "Watching pull request #70"', 'monitor "Watching pull request #12"'], "the status line names the watches only: what changes in their lines never makes a label end");

  const desk = { backgroundTasks: after, backgroundLiveness: "monitoring" } as never;
  const status = { status: "completed" as const, externalActivity: false, pendingApprovals: false, pendingUserInput: false, activeRunId: null, threadMissing: false, background: "monitoring" as const };
  const activity = memberActivity(status, desk);
  assert.equal(activity.label, "monitoring");
  assert.equal(activity.detail, "Watching pull request #70: 1 check pending (Browser harness) · watched for 8h · Watching pull request #12: 1 check failing (lint) · watched for 1h", "the hover says what each waits for");
  assert.equal(jobsLine(after, NOW), activity.detail, "and so does the status chip");

  fake.linkPullRequest("t", { repository: "example-org/web", number: 12, watched: false, state: "merged", checksState: "passing" });
  assert.deepEqual((await at(new Map())).map((t) => t.taskId), ["pull-request-watch:github.com/example-org/shop#70"], "a merged pull request's watch ends");
  await fake.controlThread({ commandId: "stop", threadId: "t", control: { type: "thread.stop" } });
  const stopped = (await fake.getThreadDetail("t"))!;
  assert.deepEqual([stopped.shell.pendingBackgroundTasks, stopped.shell.pullRequests.map((pr) => pr.watch)], [[], [null, null]], "Stop everything ends T3's watches");
});

test("a member's post names the watch with its line; when the line changes, no quiet follow-up says the watch ended", async () => {
  const { Room } = await import("./runtime/helpers.ts");
  const room = await Room.create();
  try {
    room.post("C", "W", "Open the PR and watch it.");
    await room.tick();
    const threadId = room.threadOf("W");
    room.fake.linkPullRequest(threadId, { repository: "demo/demo", number: 70, watched: true, checksState: "pending" });
    room.complete("W", "Opened #70; T3 watches it.");
    await room.tick();
    const answer = room.outputs().filter((o) => o.author === "W").at(-1)!;
    assert.match(answer.body, /^\[T3 status of @W: still running: monitor "Watching pull request #70" \(checks pending · watched for 0m\)\]/);
    room.complete("C", "Noted.");
    await room.tick();
    room.fake.linkPullRequest(threadId, { repository: "demo/demo", number: 70, watched: true, checksState: "passing" });
    await room.tick();
    room.clock += 5 * 60_000;
    await room.tick(3);
    assert.equal(room.p.events.filter((e) => e.data.kind === "progress" && e.data.author === "W").length, 0, "the watch did not end: no follow-up");
  } finally {
    room.close();
  }
});

test("the service's host reads a watched pull request's checks through the page's reader: a run that finishes with one failed is one notice to the Consigliere", async () => {
  const stack = await createTestStack();
  try {
    await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.sol1! });
    const consigliere = stack.repos.currentBinding(stack.participants.sol1!)!.id;
    const read = (list: Array<[string, T3PullRequestChecks["checks"][number]["status"]]>, second: number) =>
      stack.fake.linkPullRequest(stack.threadOf("sol2"), { repository: "example-org/canvas", number: 77, watched: true, headSha: "a8a71af", checksState: "failing", syncedAt: new Date(Date.UTC(2026, 9, 30, 22, 0, second)).toISOString(), checks: { observedAt: null, checks: list.map(([name, status]) => ({ name, status, required: true })) } });
    const finished = () => stack.engine.view(stack.roomId).events.flatMap((e) => (e.data.kind === "notice" && e.data.causeId.startsWith("checks:") ? [e.data] : []));
    read([["Hex registry", "failure"], ["Elixir tests", "pending"]], 1);
    await stack.tick(2);
    assert.equal(finished().length, 0);
    read([["Hex registry", "failure"], ["Elixir tests", "success"]], 2);
    await stack.tick(2);
    assert.deepEqual(finished().map((n) => [n.recipients, n.body]), [[[consigliere], "Pull request #77 (example-org/canvas), watched on @sol2's thread: its checks have finished, 1 failed (Hex registry). A rerun of the failed checks is possible now; T3's watch does not wake on a run finishing."]]);
  } finally {
    stack.close();
  }
});
