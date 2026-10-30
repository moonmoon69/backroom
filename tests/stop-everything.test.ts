/**
 * Stop everything on a member or a thread (T3's thread.stop), and Stop on one subagent (subagent.stop): the user's #160,
 * item B. Backroom's Stop sent run.interrupt alone, so background commands, monitors and subagents outlived it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { STOP_EVERYTHING_REASON, type T3BackgroundTask } from "../src/adapter/types.ts";
import { LimitRecovery } from "../src/app/limitRecovery.ts";
import { runError } from "../src/runtime/t3.ts";
import { FOLLOW_UP } from "../src/runtime/index.ts";
import { createTestStack, type TestStack } from "./helpers.ts";
import { Room } from "./runtime/helpers.ts";
import { t3Stub } from "./t3Stub.ts";

const SELECTION = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const WATCH: T3BackgroundTask = { taskId: "pull-request-watch:github.com/demo/demo#70", kind: "monitor", description: "Watching pull request #70", childThreadId: null };

let room: Room | undefined;
let stack: TestStack | undefined;
afterEach(() => {
  room?.close();
  room = undefined;
  stack?.close();
  stack = undefined;
});

test("the HTTP adapter sends Stop everything as thread.stop with Backroom's reason, delegated tasks left to T3's default, and a subagent's Stop as subagent.stop", async () => {
  const { adapter, frames } = t3Stub({});
  await adapter.controlThread({ commandId: "c1", threadId: "t", control: { type: "thread.stop" } });
  await adapter.controlThread({ commandId: "c2", threadId: "t", control: { type: "subagent.stop", runId: "run-1", subagentId: "node-7" } });
  assert.deepEqual(frames.filter((f) => f.tag === "orchestration.dispatchCommand").map((f) => f.payload), [
    { type: "thread.stop", commandId: "c1", threadId: "t", reason: STOP_EVERYTHING_REASON },
    { type: "subagent.stop", commandId: "c2", threadId: "t", runId: "run-1", subagentId: "node-7" },
  ]);
});

/** A thread running a turn with a subagent, a delegated task on a thread of its own, a background command, a monitor and T3's watch of PR #70, and a message queued behind it. */
async function busyThread() {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "l", threadId: "t", projectId: "project_demo", title: "busy", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m-1", text: "Ship it." } });
  await fake.launchThread({ commandId: "l2", threadId: "child", projectId: "project_demo", title: "child", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "c-1", text: "Delegated work." } });
  await fake.sendMessage({ commandId: "q", threadId: "t", messageId: "q-1", text: "Then tag it.", mode: { type: "queue" } });
  const thread = fake.threads.get("t")!;
  const runId = thread.runs[0]!.id;
  const at = new Date().toISOString();
  const subagent = (id: string, extra: object = {}) => ({ id, runId, origin: "provider_native" as const, driver: "claudeAgent", providerInstanceId: "claudeAgent", childThreadId: null, title: id, model: null, prompt: id, status: "running" as const, progress: null, result: null, startedAt: at, completedAt: null, updatedAt: at, ...extra });
  thread.subagents.push(subagent("reader"), subagent("writer"), subagent("delegate", { origin: "app_owned", childThreadId: "child" }));
  fake.setBackground("t", ["slow-check", { taskId: "mon-1", kind: "monitor", description: "until-loop on CI", childThreadId: null }, WATCH]);
  return { fake, thread, runId };
}

test("thread.stop on the fake does what T3's does: the turn interrupted with Backroom's reason, its queue held, every subagent and delegated task, background command, monitor and pull-request watch ended", async () => {
  const { fake, thread, runId } = await busyThread();
  await fake.controlThread({ commandId: "stop-1", threadId: "t", control: { type: "thread.stop" } });
  assert.equal(thread.runs[0]!.status, "interrupted");
  assert.deepEqual(thread.runs.slice(1).map((r) => [r.userMessageId, r.status, r.queueHeld]), [["q-1", "queued", true]], "the queued message kept, held, not started");
  assert.deepEqual(thread.subagents.map((s) => [s.id, s.status]), [["reader", "cancelled"], ["writer", "cancelled"], ["delegate", "cancelled"]]);
  assert.equal(fake.threads.get("child")!.runs[0]!.status, "interrupted", "the delegated task's own thread stopped");
  assert.deepEqual((await fake.getThreadShell("t"))!.pendingBackgroundTasks, [], "commands, the monitor and the watch of #70 are gone");
  const detail = (await fake.getThreadDetail("t"))!;
  assert.match(runError(detail, detail.runs[0]!), /the user stopped everything on the thread from Backroom/);
  assert.ok(detail.turnItems.some((item) => item.type === "run_interrupt_request" && item.runId === runId && item.message === STOP_EVERYTHING_REASON));
});

test("Stop everything on a limited thread turns its recovery off for good: T3's worker and Backroom's leave it paused", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await fake.launchThread({ commandId: "l", threadId: "t", projectId: "project_demo", title: "limited", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m-1", text: "Go." } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  fake.completeRun("t", { text: "limit", outcome: "limit", resetAt });
  let now = Date.now();
  fake.clock = () => now;
  const recovery = new LimitRecovery(fake);
  await recovery.sweep();
  assert.equal(fake.threads.get("t")!.recovery?.autoResume, true, "armed by default");
  await fake.controlThread({ commandId: "stop-1", threadId: "t", control: { type: "thread.stop" } });
  assert.equal(fake.threads.get("t")!.recovery?.autoResume, false);
  now = Date.parse(resetAt) + 120_000;
  fake.sweepLimits(now);
  await new LimitRecovery(fake).sweep();
  assert.equal(fake.threads.get("t")!.runs.length, 1, "nothing continued it");
  assert.notEqual((await fake.getThreadShell("t"))!.usageLimit, null, "still paused, Resume now left to the user");
});

test("subagent.stop ends that subagent alone; a finished one, another run's or an unsupported one is refused in words, never a seeming stop", async () => {
  stack = await createTestStack();
  const threadId = stack.threadOf("sol1");
  await stack.fake.sendMessage({ commandId: "go", threadId, messageId: "go", text: "Work.", mode: { type: "start" } });
  const thread = stack.fake.threads.get(threadId)!;
  const runId = thread.runs[0]!.id;
  const at = new Date().toISOString();
  const sub = (id: string, extra: object = {}) => ({ id, runId, origin: "provider_native" as const, driver: "claudeAgent", providerInstanceId: "claudeAgent", childThreadId: null, title: id, model: null, prompt: id, status: "running" as const, progress: null, result: null, startedAt: at, completedAt: null, updatedAt: at, ...extra });
  thread.subagents.push(sub("reader"), sub("writer"), sub("done", { status: "completed" }), sub("codex-native", { driver: "codex" }));
  const stop = (subagentId: string, onRun = runId) => stack!.run({ type: "member.control", roomId: stack!.roomId, participantId: stack!.participants.sol1!, control: { type: "subagent.stop", runId: onRun, subagentId } });
  assert.deepEqual(await stop("reader"), { type: "member.controlled", participantId: stack.participants.sol1, outcome: "sent" });
  assert.deepEqual(thread.subagents.map((s) => [s.id, s.status]), [["reader", "cancelled"], ["writer", "running"], ["done", "completed"], ["codex-native", "running"]]);
  assert.equal(thread.runs[0]!.status, "running", "the parent turn goes on");
  const sent = () => stack!.fake.commands.filter((c) => c.type === "subagent.stop").length;
  await assert.rejects(stop("done"), /already finished/);
  await assert.rejects(stop("writer", "run:other"), /not on this thread's run/);
  assert.equal(sent(), 1, "nothing sent for a finished subagent, nor for another run's");
  await assert.rejects(stop("codex-native"), /The requested native subagent cannot be stopped on this run\./, "T3's refusal, in its words");
  assert.equal(thread.subagents.find((s) => s.id === "codex-native")!.status, "running");
});

test("a member's Stop everything goes on the room's journal; a loose thread's goes to T3 as thread.stop; member.control refuses it", async () => {
  stack = await createTestStack();
  await assert.rejects(stack.run({ type: "member.control", roomId: stack.roomId, participantId: stack.participants.sol1!, control: { type: "stop.all" } }), /run\.stop with everything/);
  const loose = await stack.fake.launchThread({ commandId: "l", threadId: "loose", projectId: "project_demo", title: "loose", modelSelection: SELECTION, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "lm", text: "Go." } });
  stack.fake.setBackground(loose.id, ["watcher"]);
  assert.deepEqual(await stack.run({ type: "thread.control", threadId: loose.id, control: { type: "stop.all" } }), { type: "thread.controlled", threadId: loose.id, outcome: "sent" });
  assert.equal(stack.fake.threads.get(loose.id)!.runs[0]!.status, "interrupted");
  assert.deepEqual(stack.fake.threads.get(loose.id)!.shell.pendingBackgroundTasks, []);
});

test("Stop everything during a member's turn: its notice says the user stopped everything, keeps what it wrote, and leaves the request open; nothing more is sent into it", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Run the suite with a subagent.");
  await room.tick();
  const threadId = room.threadOf("W");
  room.fake.subagent(threadId, "sub-1", "running");
  room.fake.say(threadId, "Started the suite; a subagent reads the logs.");
  await room.host.stopSeat("room", "W", true);
  assert.equal(room.fake.commands.filter((c) => c.type === "thread.stop").length, 1);
  await room.tick(2);
  const notice = room.outputs().filter((o) => o.author === "W").at(-1)!;
  assert.equal(notice.disposition.kind, "error");
  assert.match(notice.body, /^\[T3 status of @W: idle\]\n\nthe user stopped everything on the thread from Backroom: this turn, and the background work and subagents it left/);
  assert.ok(notice.body.endsWith("\n\n(interrupted)"), "what its turn last wrote is kept under the notice");
  assert.equal(room.state(a), "open", "unanswered: its requester can retry it");
  assert.doesNotMatch(notice.body, /answer/);
});

test("Stop everything with only background work left: thread.stop goes, and one quiet follow-up names what ended and that the user stopped it, through ticks and a restart", async () => {
  room = await Room.create();
  const a = room.post("C", "W", "Watch CI.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["ci-watch", WATCH]);
  room.complete("W", "Watching CI and PR #70.");
  await room.tick();
  room.complete("C", "Noted.");
  await room.tick();
  await room.host.stopSeat("room", "W", true);
  await room.tick();
  room.clock += 31_000;
  await room.tick();
  room.restart();
  room.clock += 5 * 60_000;
  await room.tick(3);
  const follow = room.p.events.filter((e) => e.data.kind === "progress" && e.data.author === "W" && e.data.milestone === FOLLOW_UP).map((e) => (e.data as { body: string; requestIds: string[] }));
  assert.equal(follow.length, 1, "one follow-up, not repeated after a restart");
  assert.equal(follow[0]!.body, '[T3 status of @W: idle]\n\n(background task "background ci-watch", monitor "Watching pull request #70" ended: the user stopped everything from Backroom.)');
  assert.deepEqual(follow[0]!.requestIds, [a]);
});

test("Stop everything is refused when nothing is left to stop; Stop alone still needs a turn", async () => {
  room = await Room.create();
  await assert.rejects(room.host.stopSeat("room", "W", true), /not running anything/);
  await assert.rejects(room.host.stopSeat("room", "W"), /not running anything/);
  room.fake.background(room.threadOf("W"), ["left-over"]);
  await assert.rejects(room.host.stopSeat("room", "W"), /not running anything/, "Stop stops a turn");
  await room.host.stopSeat("room", "W", true);
  assert.equal(room.fake.commands.filter((c) => c.type === "thread.stop").length, 1, "Stop everything stops what is left");
});
