import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { T3Adapter, T3PullRequest } from "../src/adapter/types.ts";
import { LimitRecovery } from "../src/app/limitRecovery.ts";
import { controlThread } from "../src/app/threadControl.ts";
import { watchLine, watchedLink } from "../src/app/pullRequestWatch.ts";
import { runLimit } from "../src/runtime/t3.ts";
import { memberStatus, statusLine } from "../src/runtime/status.ts";
import { queueOf } from "../src/app/threadView.ts";
import { journalView, memberStatus as roomMemberStatus } from "../src/server/engineView.ts";
import { memberActivity } from "../web/src/memberActivity.ts";
import { t3Stub } from "./t3Stub.ts";
import { createTestStack } from "./helpers.ts";

const NOW = Date.parse("2026-10-30T10:00:00Z");
const at = (ago = 0) => new Date(NOW - ago).toISOString();
const selection = { instanceId: "claudeAgent", model: "m" };
const link = (host = "github.com"): T3PullRequest => ({
  host, repository: "owner/repo", number: 70, url: `https://${host}/owner/repo/pull/70`, source: "agent",
  snapshot: { state: "open", checksState: "passing", syncedAt: at() },
  watch: { startedAt: at(8 * 3_600_000), headSha: "head", failedChecks: [], passedChecks: [], passed: false, checksAwaitedSince: null },
});

test("review: a fresh passing snapshot replaces an older pending checks read", () => {
  const line = watchLine(link(), { observedAt: at(3_600_000), checks: [{ name: "Browser harness", status: "pending", required: true }] }, NOW);
  assert.match(line, /checks passed/);
  assert.doesNotMatch(line, /pending/);
});

test("review: a watch selects its link by host as well as repository and number", () => {
  const github = link();
  const enterprise = link("git.example.com");
  assert.equal(watchedLink([github, enterprise], "pull-request-watch:git.example.com/owner/repo#70")?.host, enterprise.host);
});

test("review: a new room request behind a held queue remains queue held", async () => {
  const stack = await createTestStack();
  try {
    const threadId = stack.threadOf("sol1");
    await stack.fake.startExternalRun(threadId, "Run the suite");
    await stack.fake.startExternalRun(threadId, "Then lint");
    stack.fake.completeRun(threadId, { text: "overloaded", outcome: "error" });
    await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "Another request" }] });
    await stack.tick(2);
    const detail = (await stack.fake.getThreadDetail(threadId))!;
    const shells = new Map((await stack.adapter.listThreads()).map((shell) => [shell.id, shell]));
    const status = roomMemberStatus({ participant: stack.repos.getParticipant(stack.participants.sol1!)!, repos: stack.repos, view: journalView({ p: stack.engine.view(stack.roomId), marks: { through: 0, ids: [] } }), shells, native: [] });
    const activity = memberActivity(status, { backgroundTasks: [], queue: queueOf(detail) } as unknown as Parameters<typeof memberActivity>[1]);
    assert.equal(activity.label, "queue held");
    assert.equal(activity.motion, null);
  } finally {
    stack.close();
  }
});

test("review: an in-flight default arming cannot undo Stop everything", async () => {
  class StopBeforeArm extends FakeT3Adapter {
    stopFirst = true;
    override async controlThread(input: Parameters<T3Adapter["controlThread"]>[0]) {
      if (input.control.type === "limit.arm" && this.stopFirst) {
        this.stopFirst = false;
        await super.controlThread({ commandId: "user-stop", threadId: input.threadId, control: { type: "thread.stop" } });
      }
      return super.controlThread(input);
    }
  }
  const fake = new StopBeforeArm({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "limited", modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Work" } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  fake.completeRun("t", { text: "limit", outcome: "limit", resetAt });
  await new LimitRecovery(fake).sweep();
  fake.sweepLimits(Date.parse(resetAt) + 60_000);
  assert.equal(fake.threads.get("t")!.runs.length, 1, "Stop everything must prevent the reset continuation");
});

test("review: Don't resume works again after the same recovery is re-enabled in T3", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "limited", modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Work" } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  fake.completeRun("t", { text: "limit", outcome: "limit", resetAt });
  const runId = fake.threads.get("t")!.runs[0]!.id;
  await new LimitRecovery(fake).sweep();
  await controlThread(fake, "t", { type: "resume.cancel" });
  await fake.controlThread({ commandId: "user-reenabled-in-t3", threadId: "t", control: { type: "limit.arm", runId, resetAt } });
  assert.equal(fake.threads.get("t")!.recovery?.autoResume, true);
  await controlThread(fake, "t", { type: "resume.cancel" });
  fake.sweepLimits(Date.parse(resetAt) + 60_000);
  assert.equal(fake.threads.get("t")!.runs.length, 1, "the second cancellation must prevent the reset continuation");
});

test("review: a child usage-limit error does not replace the root's ordinary failure", async () => {
  const run = { id: "r", threadId: "t", ordinal: 1, userMessageId: "m", status: "failed", queuePosition: null, queueHeld: false, requestedAt: at(5000), startedAt: at(4000), completedAt: at(1000), checkpointId: null, providerInstanceId: "claudeAgent", modelSelection: selection, rootNodeId: "root" };
  const thread = { id: "t", projectId: "p", title: "t", providerInstanceId: "claudeAgent", modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, activeRunId: null, latestRunId: "r", status: "failed", lastError: "overloaded", lastErrorClass: "provider_error", usageLimitResetAt: null, pendingRuntimeRequest: null, pendingBackgroundTasks: [], archivedAt: null, settledAt: null, deletedAt: null, createdAt: at(10000), updatedAt: at(), lineage: { rootThreadId: "t", parentThreadId: null, relationshipToParent: null } };
  const error = { threadId: "t", runId: "r", providerTurnId: null, ordinal: 1, status: "failed", title: "failure", startedAt: at(2000), completedAt: at(1000), updatedAt: at(1000), type: "error" };
  const { adapter } = t3Stub({
    "/api/orchestration/shell": { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [thread] },
    "/api/orchestration/threads/t": { snapshotSequence: 1, projection: { thread, runs: [run], messages: [], turnItems: [
      { ...error, id: "root-error", nodeId: "root", failure: { class: "provider_error", message: "overloaded" } },
      { ...error, id: "child-error", nodeId: "child", ordinal: 2, updatedAt: at(), failure: { class: "usage_limit", message: "child limit", resetAt: new Date(NOW + 3_600_000).toISOString() } },
    ] } },
  });
  const detail = (await adapter.getThreadDetail("t"))!;
  assert.deepEqual({ shellPause: detail.shell.usageLimit, noticePause: runLimit(detail, detail.runs[0]!) }, { shellPause: null, noticePause: null });
});

test("review: the member's post status line says what a watched pull request is waiting for", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "watch", modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Watch CI" } });
  fake.completeRun("t", { text: "Watching" });
  fake.linkPullRequest("t", { repository: "owner/repo", number: 70, watched: true, checksState: "pending", startedAt: at(8 * 3_600_000) });
  const detail = (await fake.getThreadDetail("t"))!;
  const line = statusLine("sol", memberStatus(detail, null));
  assert.match(line, /checks? pending/);
});

test("review round 2: watches with the same number keep their own status details", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "watch", modelSelection: selection, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Watch both pull requests" } });
  fake.completeRun("t", { text: "Watching both" });
  fake.linkPullRequest("t", { repository: "owner/one", number: 70, watched: true, checksState: "pending" });
  fake.linkPullRequest("t", { repository: "owner/two", number: 70, watched: true, checksState: "passing" });
  const line = statusLine("sol", memberStatus((await fake.getThreadDetail("t"))!, null));
  assert.match(line, /checks pending/, "the first watch must retain its pending detail");
  assert.match(line, /checks passed/, "the second watch must retain its passing detail");
});
