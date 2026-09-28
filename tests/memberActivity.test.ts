/** What the Members panel says a member is doing, ranked as T3 Code ranks its thread pills. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeStatus } from "../web/src/memberActivity.ts";
import type { BackgroundTask, Desk, ParticipantStatus } from "../web/src/types.ts";

const status = (over: Partial<ParticipantStatus> = {}): ParticipantStatus => ({
  session: "ready",
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
  const running = describeStatus(status({ session: "running", activeRunId: "run1" }), desk({ backgroundTasks: [job("agent", "local_agent"), job("agent", "subagent"), job("background", "local_bash")] }));
  assert.deepEqual(running, { label: "working", tone: "working", motion: "working", detail: "2 subagents · 1 shell" });
  assert.equal(describeStatus(status({ session: "running", externalActivity: true })).label, "working in T3");
  assert.equal(describeStatus(status({ session: "starting" })).label, "starting");
});

test("after the turn: subagents keep it working; watch loops alone are monitoring, which moves slower", () => {
  const agents = describeStatus(status({ background: "working" }), desk({ backgroundTasks: [job("agent", "local_workflow")] }));
  assert.deepEqual([agents.label, agents.motion, agents.detail], ["subagents running", "working", "1 subagent"]);
  assert.equal(describeStatus(status({ background: "working" })).label, "background work", "T3 says working but lists nothing in the window");
  const watching = describeStatus(status({ background: "monitoring" }), desk({ backgroundTasks: [job("background", "monitor"), job("background", "shell")] }));
  assert.deepEqual([watching.label, watching.motion, watching.detail], ["monitoring", "monitoring", "1 monitor · 1 shell"]);
});

test("what needs you outranks work and stands still; a plan ready waits on you too", () => {
  const busy = { session: "running" as const, activeRunId: "run1", background: "working" as const };
  assert.deepEqual(describeStatus(status({ ...busy, pendingApprovals: true, pendingUserInput: true })), { label: "needs approval", tone: "approval", motion: null, detail: null });
  assert.equal(describeStatus(status({ ...busy, pendingUserInput: true })).label, "waiting for your answer");
  assert.equal(describeStatus(status({ ...busy, threadMissing: true })).tone, "missing");
  const plan = { id: "p1", turnId: null, implementedAt: null, createdAt: "2026-09-28T08:00:00Z", markdown: "1. do it" };
  assert.equal(describeStatus(status(), desk({ interactionMode: "plan", proposedPlan: plan })).label, "plan ready");
  assert.equal(describeStatus(status(), desk({ interactionMode: "plan", proposedPlan: { ...plan, implementedAt: "2026-09-28T08:05:00Z" } })).label, "ready");
  assert.deepEqual(describeStatus(status({ session: "error" })), { label: "error", tone: "error", motion: null, detail: null });
  assert.equal(describeStatus(undefined).label, "unknown");
});
