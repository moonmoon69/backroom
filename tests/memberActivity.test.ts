/** What the Members panel says a member is doing, ranked as T3 Code ranks its thread pills (src/domain/memberState.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { betweenTurns, memberActivity } from "../web/src/memberActivity.ts";
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
  const running = memberActivity(status({ status: "running", activeRunId: "run1" }), desk({ backgroundTasks: [job("agent", "subagent"), job("agent", "subagent"), job("background", "command")] }));
  assert.deepEqual(running, { state: "working", label: "working", tone: "working", motion: "working", detail: "2 subagents · 1 command" });
  assert.equal(memberActivity(status({ status: "running", externalActivity: true })).label, "working on its own");
  assert.equal(memberActivity(status({ status: "starting" })).label, "starting");
  assert.equal(memberActivity(status({ status: "queued" })).label, "starting", "queued in T3 behind another run");
  assert.equal(memberActivity(status({ status: "waiting" })).label, "working");
});

test("after the turn: subagents keep it working; watch loops alone are monitoring, which moves slower", () => {
  const agents = memberActivity(status({ background: "working" }), desk({ backgroundTasks: [job("agent", "subagent")] }));
  assert.deepEqual([agents.label, agents.motion, agents.detail], ["subagents running", "working", "1 subagent"]);
  assert.equal(memberActivity(status({ background: "working" })).label, "background work", "T3 says working but lists nothing in the window");
  const watching = memberActivity(status({ background: "monitoring" }), desk({ backgroundTasks: [job("background", "monitor"), job("background", "background_task")] }));
  assert.deepEqual([watching.label, watching.motion, watching.detail], ["monitoring", "monitoring", "1 monitor · 1 command"]);
});

test("what needs you outranks work and stands still; a plan ready waits on you too", () => {
  const busy = { status: "running" as const, activeRunId: "run1", background: "working" as const };
  assert.deepEqual(memberActivity(status({ ...busy, pendingApprovals: true, pendingUserInput: true })), { state: "approval", label: "needs approval", tone: "approval", motion: null, detail: null });
  assert.equal(memberActivity(status({ ...busy, pendingUserInput: true })).label, "waiting for your answer");
  assert.equal(memberActivity(status({ ...busy, threadMissing: true })).tone, "missing");
  const plan = { id: "p1", runId: null, implementedAt: null, createdAt: "2026-09-28T08:00:00Z", markdown: "1. do it" };
  assert.equal(memberActivity(status(), desk({ interactionMode: "plan", proposedPlan: plan })).label, "plan ready");
  assert.equal(memberActivity(status(), desk({ interactionMode: "plan", proposedPlan: { ...plan, implementedAt: "2026-09-28T08:05:00Z" } })).label, "ready");
  assert.deepEqual(memberActivity(status({ status: "failed" })), { state: "failed", label: "error", tone: "error", motion: null, detail: null });
  assert.equal(memberActivity(status({ status: "interrupted" })).label, "interrupted");
  assert.equal(memberActivity(status({ status: "idle" })).label, "ready", "no run yet");
  assert.equal(memberActivity(undefined).label, "ready", "a member seated a moment ago, before its thread was read");
  assert.equal(memberActivity(status({ status: "unknown" })).label, "ready");
});

test("a failed last run outranks the work it left running, as T3's Failed pill does, and names that work", () => {
  const commands = desk({ backgroundTasks: [{ ...job("background", "command"), title: "browser-repl", startedAt: "2026-09-28T08:00:00Z" }, { ...job("background", "command"), title: "python run.py", startedAt: "2026-09-28T09:00:00Z" }] });
  const failed = memberActivity(status({ status: "failed", background: "working" }), commands, Date.parse("2026-09-28T11:00:00Z"));
  assert.deepEqual(failed, { state: "failed", label: "error", tone: "error", motion: "working", detail: "still running: browser-repl (command, 180m) · python run.py (command, 120m)" });
  assert.equal(memberActivity(status({ status: "interrupted", background: "working" }), commands).tone, "stopped", "a stopped run too");
  assert.equal(memberActivity(status({ status: "rolled_back", background: "monitoring" }), desk()).detail, "background work still running", "T3 says something runs but lists nothing in the window");
});

test("between turns is read in one place: the status bar's chip and the Members panel agree, the desk's reading first", () => {
  assert.equal(betweenTurns(status({ status: "running", activeRunId: "run1", background: "working" })), null, "mid-turn it is the turn's chip");
  assert.equal(betweenTurns(status({ background: null })), null);
  assert.equal(betweenTurns(status({ background: "working" })), "working");
  const lagging = status({ background: null });
  const watching = desk({ backgroundLiveness: "monitoring", backgroundTasks: [job("background", "monitor")] });
  assert.equal(betweenTurns(lagging, watching), "monitoring", "the desk read T3 after the status line");
  assert.equal(memberActivity(lagging, watching).label, "monitoring");
});
