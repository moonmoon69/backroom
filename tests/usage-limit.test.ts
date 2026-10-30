/**
 * A member or a thread paused on its provider's usage limit (the user's #160, item A): read from T3's shell and
 * projection, armed in T3 to continue at the reset, continued once whoever sends the continuation first, shown as
 * paused and not failed, and its held queue resumed only when T3 allows it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { CONTINUE_TEXT, T3CommandRejected, limitArmId, type T3Adapter, type ThreadControl } from "../src/adapter/types.ts";
import { LimitRecovery, limitStep } from "../src/app/limitRecovery.ts";
import { queueOf } from "../src/app/threadView.ts";
import { isPausedNotice, pauseLabel, resetTime } from "../src/domain/usageLimit.ts";
import { replyPieces, replyText } from "../web/src/replyTo.ts";
import { controlThread } from "../src/app/threadControl.ts";
import { describeStatus, pauseDetail, queueLine } from "../web/src/memberActivity.ts";
import { createTestStack, type TestStack } from "./helpers.ts";
import { journalView, memberStatus, pauseOf } from "../src/server/engineView.ts";
import { Room } from "./runtime/helpers.ts";
import { FOLLOW_UP } from "../src/runtime/index.ts";
import { t3Stub } from "./t3Stub.ts";

// ---------------- T3's records, as stored in statev2.sqlite on 2026-10-28 ----------------

const THREAD = "38dcfee2-2b0c-45bb-b544-4c6866d753f7";
const LIMITED = `run:thread:${THREAD}:ordinal:191`;
const QUEUED = `run:thread:${THREAD}:ordinal:192`;
const RESET = "2026-10-28T04:50:00.000Z";
const NODE = "node:run:run%3Athread%3A38dcfee2-2b0c-45bb-b544-4c6866d753f7%3Aordinal%3A191:root";
/** The error T3 wrote when Claude's limit stopped run 191 (orchestration_v2_projection_turn_items). */
const LIMIT_ERROR = {
  id: "turn-item:provider:claudeAgent:native-item:terminal-failure", threadId: THREAD, runId: LIMITED, nodeId: NODE, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 191000004, status: "failed", title: "Usage limit reached", startedAt: "2026-10-28T04:10:09.928Z", completedAt: "2026-10-28T04:10:09.928Z", updatedAt: "2026-10-28T04:10:09.928Z",
  type: "error", failure: { class: "usage_limit", message: "Claude API rate limit reached. Try again later.", code: "api_error_429", retryable: true, resetAt: RESET },
};
const NOTICE = { ...LIMIT_ERROR, id: "turn-item:notice", ordinal: 191000005, status: "completed", title: null, type: "system_notice", message: "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 40m." };
const SELECTION = { instanceId: "claudeAgent", model: "claude-fable-5-1" };

const run = (id: string, ordinal: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, threadId: THREAD, ordinal, providerInstanceId: "claudeAgent", modelSelection: SELECTION, userMessageId: `msg-${ordinal}`, status, queuePosition: null, queueHeld: false,
  requestedAt: "2026-10-28T04:00:00.000Z", startedAt: status === "queued" ? null : "2026-10-28T04:00:01.000Z", completedAt: status === "queued" ? null : "2026-10-28T04:10:09.928Z", checkpointId: null, ...extra,
});

function projection(input: { items?: unknown[]; runs?: unknown[]; limitRecovery?: unknown } = {}) {
  return {
    thread: { id: THREAD, projectId: "proj", title: "pr-70", providerInstanceId: "claudeAgent", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, archivedAt: null, settledAt: null, deletedAt: null, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T04:10:10.000Z", limitRecovery: input.limitRecovery ?? null },
    runs: input.runs ?? [run(LIMITED, 191, "failed"), run(QUEUED, 192, "queued", { queuePosition: 1 })],
    messages: [], turnItems: input.items ?? [LIMIT_ERROR, NOTICE], runtimeRequests: [],
    nodes: [], attempts: [], subagents: [], providerSessions: [], providerTurns: [], plans: [], checkpoints: [], checkpointScopes: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], providerThreads: [],
    updatedAt: "2026-10-28T04:10:10.000Z",
  };
}

/** T3's shell entry for the thread (OrchestrationV2ThreadShell), as its snapshot lists it while run 191 is limited. */
function shellEntry(extra: Record<string, unknown> = {}) {
  return {
    id: THREAD, projectId: "proj", title: "pr-70", providerInstanceId: "claudeAgent", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD }, latestRunId: LIMITED, latestRunCompletedAt: "2026-10-28T04:10:09.928Z", activeRunId: null, status: "failed",
    lastError: "Claude API rate limit reached. Try again later.", lastErrorClass: "usage_limit", usageLimitResetAt: RESET, pendingRuntimeRequest: null, hasActionableProposedPlan: false,
    latestUserMessageAt: null, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T04:10:10.000Z", archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null, ...extra,
  };
}

const stub = (input: { shell?: Record<string, unknown>; detail?: Parameters<typeof projection>[0] } = {}) =>
  t3Stub({
    "/api/orchestration/shell": { schemaVersion: 2, snapshotSequence: 3, projects: [], threads: [shellEntry(input.shell)] },
    [`/api/orchestration/threads/${THREAD}`]: { snapshotSequence: 3, projection: projection(input.detail) },
  });

// ---------------- the HTTP adapter ----------------

test("T3's shell: a usage-limited thread is paused until its reset, with T3's recovery only when it is for this run and reset", async () => {
  const armed = { runId: LIMITED, resetAt: RESET, autoResume: true, snooze: false, requestId: "limit-arm:x" };
  const read = async (shell: Record<string, unknown>) => (await stub({ shell }).adapter.listThreads())[0]!.usageLimit;
  assert.deepEqual(await read({ limitRecovery: armed }), { runId: LIMITED, provider: "claudeAgent", resetAt: RESET, message: "Claude API rate limit reached. Try again later.", recovery: { autoResume: true, snooze: false, requestId: "limit-arm:x" } });
  assert.equal((await read({}))!.recovery, null, "nobody armed it");
  assert.equal((await read({ limitRecovery: { ...armed, resetAt: "2026-10-28T09:50:00.000Z" } }))!.recovery, null, "a recovery for another reset counts as none, as in T3");
  assert.equal((await read({ limitRecovery: { ...armed, runId: QUEUED } }))!.recovery, null, "a recovery for another run counts as none");
  assert.deepEqual((await read({ limitRecovery: { ...armed, autoResume: false } }))!.recovery, { autoResume: false, snooze: false, requestId: "limit-arm:x" }, "turned off is kept: Backroom leaves it off");
  assert.equal(await read({ lastErrorClass: "provider_error" }), null, "an ordinary failure is no pause");
  assert.equal(await read({ activeRunId: QUEUED, status: "running" }), null, "nothing is paused while a run goes");
  assert.equal((await read({ usageLimitResetAt: null }))!.resetAt, null, "a limit with no reset time is still a pause");
});

test("T3's projection: the pause is the latest executed run's usage limit; a message queued behind it does not hide it, and an ordinary failure keeps its error", async () => {
  const detail = (await stub({ detail: { limitRecovery: { runId: LIMITED, resetAt: RESET, autoResume: true, snooze: false, requestId: "req-1" } } }).adapter.getThreadDetail(THREAD))!;
  assert.deepEqual(detail.turnItems.find((item) => item.type === "error"), { ...{ id: LIMIT_ERROR.id, runId: LIMITED, nodeId: NODE, providerTurnId: null, ordinal: 191000004, status: "failed", title: "Usage limit reached", startedAt: LIMIT_ERROR.startedAt, completedAt: LIMIT_ERROR.completedAt, updatedAt: LIMIT_ERROR.updatedAt }, type: "error", message: "Claude API rate limit reached. Try again later.", failureClass: "usage_limit", retrying: false, resetAt: RESET });
  assert.deepEqual(detail.shell.usageLimit, { runId: LIMITED, provider: "claudeAgent", resetAt: RESET, message: "Claude API rate limit reached. Try again later.", recovery: { autoResume: true, snooze: false, requestId: "req-1" } });
  assert.deepEqual(queueOf(detail), { count: 1, hold: { by: "limit", reason: "waits for the turn paused on Claude's limit to continue" } });
  const ordinary = (await stub({ detail: { items: [{ ...LIMIT_ERROR, failure: { class: "provider_error", message: "overloaded" } }] } }).adapter.getThreadDetail(THREAD))!;
  assert.equal(ordinary.shell.usageLimit, null);
  assert.equal(ordinary.shell.lastError, "overloaded");
  const after = (await stub({ detail: { runs: [run(LIMITED, 191, "failed"), run(QUEUED, 192, "completed", { completedAt: "2026-10-28T05:00:00.000Z" })] } }).adapter.getThreadDetail(THREAD))!;
  assert.equal(after.shell.usageLimit, null, "a run that ran since ends the pause");
});

test("the HTTP adapter sends each control as T3's own command: the arming, T3's Continue, and queue.resume", async () => {
  const { adapter, frames } = stub();
  const send = (commandId: string, control: ThreadControl) => adapter.controlThread({ commandId, threadId: THREAD, control });
  await send(limitArmId(THREAD, LIMITED, RESET), { type: "limit.arm", runId: LIMITED, resetAt: RESET });
  await send(`limit-continue:${THREAD}:${LIMITED}`, { type: "run.continue", runId: LIMITED });
  await send("cmd-q", { type: "queue.resume" });
  assert.deepEqual(
    frames.filter((frame) => frame.tag === "orchestration.dispatchCommand").map((frame) => frame.payload),
    [
      { type: "thread.metadata.update", commandId: `limit-arm:${THREAD}:${LIMITED}:${Date.parse(RESET)}`, threadId: THREAD, limitRecovery: { runId: LIMITED, resetAt: RESET, autoResume: true, snooze: false } },
      { type: "message.dispatch", commandId: `limit-continue:${THREAD}:${LIMITED}`, messageId: `limit-continue:${THREAD}:${LIMITED}`, threadId: THREAD, manualContinuationOfRunId: LIMITED, text: CONTINUE_TEXT, attachments: [], dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "web" },
      { type: "queue.resume", commandId: "cmd-q", threadId: THREAD },
    ],
  );
});

// ---------------- recovery, on the fake T3 ----------------

/** A fake T3 with one thread whose run stopped on Claude's limit, resetting `inMs` from now; `queued` messages behind it. */
async function limitedThread(inMs = 3_600_000, queued: string[] = []) {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const shell = await fake.launchThread({ commandId: "launch", threadId: "t-1", projectId: "project_demo", title: "limited", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m-1", text: "Fix the build." } });
  const resetAt = new Date(Date.now() + inMs).toISOString();
  for (const [index, text] of queued.entries()) await fake.sendMessage({ commandId: `q-${index}`, threadId: shell.id, messageId: `q-${index}`, text, mode: { type: "queue" } });
  fake.completeRun(shell.id, { text: "Claude API rate limit reached. Try again later.", outcome: "limit", resetAt });
  return { fake, threadId: shell.id, resetAt, runId: fake.threads.get(shell.id)!.runs[0]!.id };
}

const continuations = (fake: FakeT3Adapter, threadId: string) => fake.threads.get(threadId)!.messages.filter((m) => m.text === CONTINUE_TEXT).length;

test("limitStep arms as T3's limitRecoveryCommand would: a limited thread nobody armed, and nothing else", async () => {
  const { fake, threadId, resetAt, runId } = await limitedThread();
  const shell = (await fake.getThreadShell(threadId))!;
  assert.deepEqual(limitStep(shell), { commandId: limitArmId(threadId, runId, resetAt), control: { type: "limit.arm", runId, resetAt } });
  const recorded = (autoResume: boolean) => ({ ...shell, usageLimit: { ...shell.usageLimit!, recovery: { autoResume, snooze: false, requestId: "req-1" } } });
  const nothing = {
    "armed already": recorded(true),
    "a recovery turned off (a Stop, the user in T3)": recorded(false),
    archived: { ...shell, archivedAt: resetAt },
    settled: { ...shell, settledAt: resetAt },
    deleted: { ...shell, deletedAt: resetAt },
    "waiting on a request": { ...shell, pendingRequest: { id: "r", kind: "command" as const, createdAt: resetAt } },
    "no reset time": { ...shell, usageLimit: { ...shell.usageLimit!, resetAt: null } },
    "an unreadable reset": { ...shell, usageLimit: { ...shell.usageLimit!, resetAt: "soon" } },
    "a reset before the run ended": { ...shell, latestRunCompletedAt: new Date(Date.parse(resetAt) + 1).toISOString() },
    "no pause": { ...shell, usageLimit: null },
  };
  for (const [why, s] of Object.entries(nothing)) assert.equal(limitStep(s), null, why);
});

test("Backroom arms a limited thread once, with T3's identity, and sends nothing else; T3's worker continues it at the reset with autoResumeLimitedThreads off", async () => {
  const { fake, threadId, resetAt, runId } = await limitedThread();
  const recovery = new LimitRecovery(fake);
  recovery.start();
  await recovery.sweep();
  assert.deepEqual(fake.threads.get(threadId)!.recovery, { runId, resetAt, autoResume: true, snooze: false, requestId: limitArmId(threadId, runId, resetAt) });
  await recovery.sweep();
  assert.equal(fake.commands.filter((c) => c.type === "thread.metadata.update").length, 1, "armed once");
  assert.equal(fake.commands.filter((c) => c.type === "message.dispatch").length, 0, "no continuation of Backroom's");
  assert.equal(fake.autoResumeLimitedThreads, false);
  fake.sweepLimits(Date.parse(resetAt) - 1);
  assert.equal(continuations(fake, threadId), 0, "not before the reset");
  fake.sweepLimits(Date.parse(resetAt));
  assert.equal(continuations(fake, threadId), 1, "T3's worker continued it: the setting only governs arming");
  fake.sweepLimits(Date.parse(resetAt) + 120_000);
  await recovery.sweep();
  assert.equal(continuations(fake, threadId), 1);
  recovery.stop();
});

test("a refused arming is not sent again; a recovery that is off stays off", async () => {
  const refusing = await limitedThread();
  let calls = 0;
  const refuses: T3Adapter = Object.create(refusing.fake, {
    controlThread: {
      value: async () => {
        calls += 1;
        throw new T3CommandRejected("The provider limit changed before recovery could be configured.", 500, null);
      },
    },
  });
  const recovery = new LimitRecovery(refuses);
  await recovery.sweep();
  await recovery.sweep();
  assert.equal(calls, 1, "T3's refusal stands for that run and reset");

  const { fake, threadId, resetAt, runId } = await limitedThread();
  fake.threads.get(threadId)!.recovery = { runId, resetAt, autoResume: false, snooze: false, requestId: "stop-1" };
  await new LimitRecovery(fake).sweep();
  fake.sweepLimits(Date.parse(resetAt) + 600_000);
  assert.equal(fake.commands.filter((c) => c.type === "thread.metadata.update").length, 0);
  assert.equal(continuations(fake, threadId), 0);
});

// ---------------- held queues ----------------

test("a queue behind a usage limit: T3 refuses queue.resume in its words until the turn continues, then the messages start in their order", async () => {
  const { fake, threadId, runId } = await limitedThread(3_600_000, ["first", "second"]);
  const detail = (await fake.getThreadDetail(threadId))!;
  assert.deepEqual(queueOf(detail), { count: 2, hold: { by: "limit", reason: "waits for the turn paused on Claude's limit to continue" } });
  await assert.rejects(fake.controlThread({ commandId: "q", threadId, control: { type: "queue.resume" } }), (error: Error) => error instanceof T3CommandRejected && error.message === "Continue the limited thread before resuming its queue.");
  await fake.controlThread({ commandId: "c", threadId, control: { type: "run.continue", runId } });
  const runs = () => fake.threads.get(threadId)!.runs.map((r) => [fake.threads.get(threadId)!.messages.find((m) => m.id === r.userMessageId)?.text, r.status]);
  assert.deepEqual(runs().slice(1), [["first", "queued"], ["second", "queued"], [CONTINUE_TEXT, "running"]]);
  fake.completeRun(threadId, { text: "Continued." });
  fake.completeRun(threadId, { text: "First done." });
  assert.deepEqual(runs().slice(1), [["first", "completed"], ["second", "running"], [CONTINUE_TEXT, "completed"]]);
});

test("a queue T3 held after a provider failure says so with T3's reason, and Resume queue starts its messages in order", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "launch", threadId: "t-2", projectId: "project_demo", title: "held", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m-1", text: "Go." } });
  await fake.sendMessage({ commandId: "q-1", threadId: "t-2", messageId: "q-1", text: "first", mode: { type: "queue" } });
  await fake.sendMessage({ commandId: "q-2", threadId: "t-2", messageId: "q-2", text: "second", mode: { type: "queue" } });
  fake.completeRun("t-2", { text: "overloaded_error", outcome: "error" });
  const queue = queueOf((await fake.getThreadDetail("t-2"))!);
  assert.deepEqual(queue, { count: 2, hold: { by: "held", reason: "held after the last turn failed: overloaded_error" } });
  assert.equal(queueLine(queue), "2 queued messages held by T3, held after the last turn failed: overloaded_error");
  await fake.controlThread({ commandId: "resume", threadId: "t-2", control: { type: "queue.resume" } });
  const runs = fake.threads.get("t-2")!.runs;
  assert.deepEqual(runs.map((r) => [r.userMessageId, r.status, r.queueHeld]), [["m-1", "failed", false], ["q-1", "running", false], ["q-2", "queued", false]]);
});

// ---------------- how it reads ----------------

test("the reset is said in the viewer's time zone, dated when it is not today there, and changes wording once it passes", () => {
  const reset = "2026-10-28T15:50:00.000Z";
  const now = Date.parse("2026-10-28T14:00:00.000Z");
  assert.equal(resetTime(reset, now, "UTC"), "15:50");
  assert.equal(resetTime(reset, now, "Asia/Taipei"), "23:50");
  assert.equal(resetTime("2026-10-28T16:10:00.000Z", now, "Asia/Taipei"), "00:10 on Thu 29 Oct", "past midnight in Taipei: dated");
  assert.equal(resetTime("2026-10-28T16:10:00.000Z", now, "UTC"), "16:10", "the same day in UTC");
  assert.equal(resetTime("2026-11-02T09:00:00.000Z", now, "UTC"), "09:00 on Mon 2 Nov", "days away: dated");
  assert.equal(resetTime(null, now, "UTC"), null);
  assert.equal(resetTime("whenever", now, "UTC"), null);
  const pause = { provider: "claudeAgent", resetAt: reset };
  assert.equal(pauseLabel(pause, now, "UTC"), "paused on Claude's limit until 15:50");
  assert.equal(pauseLabel(pause, Date.parse(reset), "UTC"), "paused on Claude's limit, reset at 15:50", "at the reset, without a reload");
  assert.equal(pauseLabel({ provider: "claudeAgent", resetAt: null }, now, "UTC"), "paused on Claude's limit until it resets");
  assert.equal(pauseLabel({ provider: "codex", resetAt: "never" }, now), "paused on Codex's limit until it resets");
});

test("a paused member is neither working nor needing you: its label says until when, its detail the provider's own sentence and whether T3 continues it", () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const paused = { runId: "r", provider: "claudeAgent", resetAt, message: "Claude API rate limit reached. Try again later.", resume: "on" as const };
  const status = { status: "queued" as const, externalActivity: false, pendingApprovals: false, pendingUserInput: false, activeRunId: "host-run", threadMissing: false, background: null, paused };
  const activity = describeStatus(status, null);
  assert.equal(activity.label, `paused on Claude's limit until ${resetTime(resetAt, Date.now())}`, "a room message queued behind the limit does not make it working");
  assert.equal(activity.tone, "paused");
  assert.equal(activity.motion, null);
  assert.equal(activity.detail, `Claude API rate limit reached. Try again later. · T3 continues it at ${resetTime(resetAt, Date.now())}`);
  assert.equal(pauseDetail({ ...paused, resume: "off" }, Date.now()), "Claude API rate limit reached. Try again later. · T3 will not continue it");
  assert.equal(pauseDetail({ ...paused, resume: null }, Date.now()), "Claude API rate limit reached. Try again later. · T3 is not yet set to continue it");
  assert.equal(describeStatus({ ...status, pendingApprovals: true }, null).tone, "approval", "an approval still comes first");
  assert.equal(describeStatus({ ...status, paused: null, status: "failed", activeRunId: null }, null).label, "error", "an ordinary failure is still an error");
});

// ---------------- the room ----------------

let room: Room | undefined;
let stack: TestStack | undefined;
afterEach(() => {
  room?.close();
  room = undefined;
  stack?.close();
  stack = undefined;
});

test("the Consigliere's notice for a turn the limit stopped says paused until the reset, in the service's named time zone, once, through ticks and a restart", async () => {
  room = await Room.create({ host: { timeZone: "Asia/Taipei" } });
  const a = room.post("C", "W", "Fix the flaky test.");
  await room.tick();
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  room.complete("W", "Claude API rate limit reached. Try again later.", { outcome: "limit", resetAt });
  await room.tick(3);
  room.restart();
  await room.tick(2);
  const outputs = room.outputs().filter((o) => o.author === "W");
  assert.equal(outputs.length, 1, "one notice");
  const body = outputs[0]!.body;
  assert.match(body, new RegExp(`W's turn is paused on Claude's usage limit until ${resetTime(resetAt, room.clock, "Asia/Taipei")!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(Asia/Taipei\\), not failed\\.`));
  assert.match(body, /Claude said: "Claude API rate limit reached\. Try again later\." T3 continues the turn by itself at the reset, and its reply comes as a follow-up\./);
  assert.doesNotMatch(body, /failed in T3/);
  assert.equal(isPausedNotice(body), true, "the board knows it for a pause by the notice's own words");
  const post = { body, about: [{ number: 12 }], output: { disposition: "error", claims: [] } } as unknown as Parameters<typeof replyPieces>[0];
  assert.equal(replyText(replyPieces(post, { requestPost: () => undefined, nameOf: (p: string) => p } as never)), "paused on #12");
  assert.equal(replyText(replyPieces({ ...post, body: "W's turn failed: overloaded" } as never, { requestPost: () => undefined, nameOf: (p: string) => p } as never)), "failed on #12");
  assert.equal(room.state(a), "open", "as after any failed turn: the request stays open, and its notice offers Retry");

  // T3 continues it at the reset: what it then says reaches the Consigliere as a follow-up on the request.
  const threadId = room.threadOf("W");
  const limited = room.fake.thread(threadId).runs.at(-1)!;
  await room.fake.controlThread({ commandId: "c", threadId, control: { type: "run.continue", runId: limited.id } });
  await room.tick();
  room.complete("W", "Fixed the flaky test: the clock was shared.");
  await room.tick(2);
  const followUp = room.p.events.find((e) => e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP);
  assert.ok(followUp && followUp.data.kind === "progress" && followUp.data.body.includes("Fixed the flaky test") && followUp.data.requestIds.includes(a), "the continued turn's reply is a follow-up on the request");
});

test("from the page: Resume on a paused member sends one manual continuation however often it is pressed; a loose thread's Resume goes to its own thread, a member's thread is refused there", async () => {
  stack = await createTestStack();
  const threadId = stack.threadOf("sol1");
  await stack.fake.sendMessage({ commandId: "go", threadId, messageId: "go", text: "Work.", mode: { type: "start" } });
  stack.fake.completeRun(threadId, { text: "You've hit your usage limit.", outcome: "limit", resetAt: new Date(Date.now() + 3_600_000).toISOString() });
  const resume = { type: "member.control" as const, roomId: stack.roomId, participantId: stack.participants.sol1!, control: { type: "resume" as const } };
  const results = await Promise.all([stack.run(resume), stack.run(resume)]);
  for (const result of results) assert.ok(["sent", "already"].includes((result as { outcome: string }).outcome), "each press says T3 took it, or that it had continued");
  assert.equal(continuations(stack.fake, threadId), 1, "two presses, one continuation");
  const runId = stack.fake.threads.get(threadId)!.runs[0]!.id;
  assert.deepEqual(stack.fake.commands.filter((c) => c.type === "message.dispatch" && c.commandId.startsWith("limit-")).map((c) => c.commandId), [`limit-continue:${threadId}:${runId}`, `limit-continue:${threadId}:${runId}`], "the same ID both times: the second is a replay");
  await assert.rejects(stack.run({ type: "thread.control", threadId, control: { type: "resume" } }), /room/i, "a member's thread is controlled from its room");

  const loose = await stack.fake.launchThread({ commandId: "l", threadId: "loose-1", projectId: "project_demo", title: "loose", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "lm", text: "Go." } });
  stack.fake.completeRun(loose.id, { text: "limit", outcome: "limit", resetAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual(await stack.run({ type: "thread.control", threadId: loose.id, control: { type: "resume" } }), { type: "thread.controlled", threadId: loose.id, outcome: "sent" });
  assert.equal(continuations(stack.fake, loose.id), 1);
  assert.deepEqual(await stack.run({ type: "thread.control", threadId: loose.id, control: { type: "resume" } }), { type: "thread.controlled", threadId: loose.id, outcome: "already" }, "nothing is paused any more");
});

test("the room's member status carries the pause from T3's thread list", async () => {
  stack = await createTestStack();
  const threadId = stack.threadOf("sol2");
  await stack.fake.sendMessage({ commandId: "go", threadId, messageId: "go", text: "Work.", mode: { type: "start" } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  stack.fake.completeRun(threadId, { text: "You've hit your usage limit.", outcome: "limit", resetAt });
  const shells = new Map((await stack.adapter.listThreads()).map((s) => [s.id, s]));
  const participant = stack.repos.getParticipant(stack.participants.sol2!)!;
  const status = memberStatus({ participant, repos: stack.repos, view: journalView({ p: stack.engine.view(stack.roomId), marks: { through: 0, ids: [] } }), shells, native: [] });
  assert.deepEqual(status.paused, { runId: stack.fake.threads.get(threadId)!.runs[0]!.id, provider: "codex", resetAt, message: "You've hit your usage limit.", resume: null });
  assert.equal(describeStatus(status, null).label, `paused on Codex's limit until ${resetTime(resetAt, Date.now())}`);
});

test("a paused turn of your own request does not need you: its notice keeps Retry, and an ordinary failure still needs you", async () => {
  room = await Room.create({ orchestrator: null });
  room.user("W", "Fix the flaky test.");
  await room.tick();
  room.complete("W", "Claude API rate limit reached. Try again later.", { outcome: "limit", resetAt: new Date(Date.now() + 3_600_000).toISOString() });
  await room.tick(2);
  let view = journalView({ p: room.p });
  const notice = view.posts.find((post) => post.notice && isPausedNotice(post.body));
  assert.ok(notice?.notice?.retryRunId, "Retry stays on it");
  assert.equal(view.needsYou.length, 0, "T3 continues it: nothing waits on you");
  room.user("V", "Check the build.");
  await room.tick();
  room.complete("V", "overloaded", { outcome: "error" });
  await room.tick(2);
  view = journalView({ p: room.p });
  assert.equal(view.needsYou.length, 1, "an ordinary failure still needs you");
});

test("Don't resume turns T3's recovery off with T3's own command; Backroom does not arm it again, T3 does not continue it, and Resume now still does", async () => {
  const { adapter, frames } = stub();
  await adapter.controlThread({ commandId: "d", threadId: THREAD, control: { type: "limit.disarm", runId: LIMITED, resetAt: RESET } });
  assert.deepEqual(frames.filter((f) => f.tag === "orchestration.dispatchCommand").map((f) => f.payload), [{ type: "thread.metadata.update", commandId: "d", threadId: THREAD, limitRecovery: { runId: LIMITED, resetAt: RESET, autoResume: false, snooze: false } }]);

  stack = await createTestStack();
  const fake = stack.fake;
  const loose = await fake.launchThread({ commandId: "l", threadId: "loose", projectId: "project_demo", title: "loose", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "lm", text: "Go." } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  fake.completeRun(loose.id, { text: "limit", outcome: "limit", resetAt });
  const runId = fake.threads.get(loose.id)!.runs[0]!.id;
  const recovery = new LimitRecovery(fake);
  await recovery.sweep();
  assert.equal(fake.threads.get(loose.id)!.recovery?.autoResume, true, "armed by default");
  const cancel = () => stack!.run({ type: "thread.control", threadId: loose.id, control: { type: "resume.cancel" } });
  assert.deepEqual(await cancel(), { type: "thread.controlled", threadId: loose.id, outcome: "sent" });
  assert.deepEqual(fake.threads.get(loose.id)!.recovery, { runId, resetAt, autoResume: false, snooze: false, requestId: `limit-disarm:${loose.id}:${runId}:${Date.parse(resetAt)}` });
  assert.deepEqual(await cancel(), { type: "thread.controlled", threadId: loose.id, outcome: "already" }, "already off: nothing sent");
  await recovery.sweep();
  await new LimitRecovery(fake).sweep();
  assert.equal(fake.commands.filter((c) => c.threadId === loose.id && c.type === "thread.metadata.update").length, 2, "armed once, turned off once, never armed again");
  fake.sweepLimits(Date.parse(resetAt) + 600_000);
  assert.equal(continuations(fake, loose.id), 0, "T3's worker leaves it");
  const shell = (await fake.getThreadShell(loose.id))!;
  assert.equal(shell.usageLimit?.recovery?.autoResume, false);
  assert.equal(pauseOf(shell.usageLimit!).resume, "off");
  assert.equal(pauseDetail(pauseOf(shell.usageLimit!), Date.now()), "limit · T3 will not continue it", "the member reads that T3 will not continue it");
  assert.deepEqual(await stack.run({ type: "thread.control", threadId: loose.id, control: { type: "resume" } }), { type: "thread.controlled", threadId: loose.id, outcome: "sent" });
  assert.equal(continuations(fake, loose.id), 1, "Resume now still continues it");
  assert.deepEqual(await cancel(), { type: "thread.controlled", threadId: loose.id, outcome: "already" }, "nothing paused any more");
});

test("a member's Don't resume reaches T3 and the Consigliere hears of it once, on the paused request", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Fix the flaky test.");
  await room.tick();
  room.complete("W", "Claude API rate limit reached. Try again later.", { outcome: "limit", resetAt: new Date(Date.now() + 3_600_000).toISOString() });
  await room.tick(2);
  const threadId = room.threadOf("W");
  const limited = room.fake.thread(threadId).runs.at(-1)!;
  await new LimitRecovery(room.fake).sweep();
  const outcome = await controlThread(room.fake, threadId, { type: "resume.cancel" });
  assert.equal(outcome, "sent");
  await room.host.resumeOff("room", "W", limited.id);
  await room.host.resumeOff("room", "W", limited.id);
  await room.tick(2);
  const said = room.p.events.filter((e) => e.id === `resume-off:${limited.id}`);
  assert.equal(said.length, 1, "once");
  const data = said[0]!.data as { kind: string; body: string; requestIds: string[]; milestone: string };
  assert.equal(data.kind, "progress");
  assert.deepEqual(data.requestIds, [a]);
  assert.equal(data.body, "[T3 status of @W: idle]\n\n(The user turned off T3's resume of @W's paused turn: T3 will not continue it at the reset. It stays paused until someone presses Resume now on @W.)");
  assert.equal(room.fake.thread(threadId).recovery?.autoResume, false);
});

test("from the page, a member's Don't resume goes through the room: T3 has it off, and the room has its one follow-up", async () => {
  stack = await createTestStack();
  const threadId = stack.threadOf("sol1");
  await stack.fake.sendMessage({ commandId: "go", threadId, messageId: "go", text: "Work.", mode: { type: "start" } });
  stack.fake.completeRun(threadId, { text: "You've hit your usage limit.", outcome: "limit", resetAt: new Date(Date.now() + 3_600_000).toISOString() });
  const runId = stack.fake.threads.get(threadId)!.runs[0]!.id;
  const cancel = () => stack!.run({ type: "member.control", roomId: stack!.roomId, participantId: stack!.participants.sol1!, control: { type: "resume.cancel" } });
  assert.deepEqual(await cancel(), { type: "member.controlled", participantId: stack.participants.sol1, outcome: "sent" });
  assert.equal(stack.fake.threads.get(threadId)!.recovery?.autoResume, false);
  assert.deepEqual(await cancel(), { type: "member.controlled", participantId: stack.participants.sol1, outcome: "already" });
  assert.equal(stack.engine.view(stack.roomId).events.filter((e) => e.id === `resume-off:${runId}`).length, 1);
});
