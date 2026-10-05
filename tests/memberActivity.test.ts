/** What the Members panel says a member is doing, ranked as T3 Code ranks its thread pills. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeStatus } from "../web/src/memberActivity.ts";
import type { BackgroundTask, Desk, ParticipantStatus } from "../web/src/types.ts";

const status = (over: Partial<ParticipantStatus> = {}): ParticipantStatus => ({
  status: "completed",
  externalActivity: false,
  pendingApprovals: false,
  pendingUserInput: false,
  activeRunId: null,
  threadMissing: false,
  background: null,
  ...over,
});
const job = (kind: string, type: string | null): BackgroundTask => ({ taskId: `${kind}-${type}-${Math.random()}`, title: "job", kind, type, detail: null, lastTool: null, startedAt: "2026-09-28T08:00:00Z", updatedAt: "2026-09-28T08:00:00Z" });
const desk = (over: Partial<Desk> = {}): Desk => ({ backgroundTasks: [], interactionMode: "default", proposedPlan: null, ...over }) as Desk;

test("a turn at work moves the card, and says what runs beside it", () => {
  const running = describeStatus(status({ status: "running", activeRunId: "run1" }), desk({ backgroundTasks: [job("agent", "subagent"), job("agent", "subagent"), job("background", "command")] }));
  assert.deepEqual(running, { label: "working", tone: "working", motion: "working", detail: "2 subagents · 1 command" });
  assert.equal(describeStatus(status({ status: "running", externalActivity: true })).label, "working in T3");
  assert.equal(describeStatus(status({ status: "starting" })).label, "starting");
  assert.equal(describeStatus(status({ status: "queued" })).label, "starting", "queued in T3 behind another run");
  assert.equal(describeStatus(status({ status: "waiting" })).label, "working");
});

test("after the turn: subagents keep it working; watch loops alone are monitoring, which moves slower", () => {
  const agents = describeStatus(status({ background: "working" }), desk({ backgroundTasks: [job("agent", "subagent")] }));
  assert.deepEqual([agents.label, agents.motion, agents.detail], ["subagents running", "working", "1 subagent"]);
  assert.equal(describeStatus(status({ background: "working" })).label, "background work", "T3 says working but lists nothing in the window");
  const watching = describeStatus(status({ background: "monitoring" }), desk({ backgroundTasks: [job("background", "monitor"), job("background", "background_task")] }));
  assert.deepEqual([watching.label, watching.motion, watching.detail], ["monitoring", "monitoring", "1 monitor · 1 command"]);
});

test("what needs you outranks work and stands still; a plan ready waits on you too", () => {
  const busy = { status: "running" as const, activeRunId: "run1", background: "working" as const };
  assert.deepEqual(describeStatus(status({ ...busy, pendingApprovals: true, pendingUserInput: true })), { label: "needs approval", tone: "approval", motion: null, detail: null });
  assert.equal(describeStatus(status({ ...busy, pendingUserInput: true })).label, "waiting for your answer");
  assert.equal(describeStatus(status({ ...busy, threadMissing: true })).tone, "missing");
  const plan = { id: "p1", runId: null, implementedAt: null, createdAt: "2026-09-28T08:00:00Z", markdown: "1. do it" };
  assert.equal(describeStatus(status(), desk({ interactionMode: "plan", proposedPlan: plan })).label, "plan ready");
  assert.equal(describeStatus(status(), desk({ interactionMode: "plan", proposedPlan: { ...plan, implementedAt: "2026-09-28T08:05:00Z" } })).label, "ready");
  assert.deepEqual(describeStatus(status({ status: "failed" })), { label: "error", tone: "error", motion: null, detail: null });
  assert.equal(describeStatus(status({ status: "interrupted" })).label, "interrupted");
  assert.equal(describeStatus(status({ status: "idle" })).label, "ready", "no run yet");
  assert.equal(describeStatus(undefined).label, "ready", "a member seated a moment ago, before its thread was read");
  assert.equal(describeStatus(status({ status: "unknown" })).label, "ready");
});
