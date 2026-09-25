/** Turn correlation against T3's real read-model shape (user messages never carry a turn id). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTurnForMessage } from "../src/adapter/correlate.ts";
import type { T3Message, T3ThreadDetail } from "../src/adapter/types.ts";

function detail(messages: T3Message[], activeTurnId: string | null): T3ThreadDetail {
  return {
    shell: {
      id: "t", projectId: "p", title: "t", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" }, runtimeMode: "approval-required",
      interactionMode: "default", branch: null, worktreePath: null,
      session: { status: activeTurnId ? "running" : "ready", activeTurnId, lastError: null }, latestTurn: null,
      hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false, pullRequests: [], linkedPullRequest: null,
      planProgress: null, backgroundLiveness: null, latestUserMessageAt: null, settledAt: null, archivedAt: null, deletedAt: null, updatedAt: "",
    },
    messages,
    activities: [],
    checkpoints: [],
    proposedPlans: [],
  };
}
const user = (id: string): T3Message => ({ id, role: "user", text: "x", turnId: null, streaming: false, createdAt: "" });
const assistant = (turnId: string): T3Message => ({ id: `assistant:${turnId}`, role: "assistant", text: "y", turnId, streaming: false, createdAt: "" });

test("the live T3 shape: user message has no turn id; the following assistant message carries it", () => {
  const d = detail([user("m1"), assistant("turn-1"), user("m2"), assistant("turn-2")], null);
  assert.deepEqual(resolveTurnForMessage(d, "m1"), { kind: "resolved", turnId: "turn-1" });
  assert.deepEqual(resolveTurnForMessage(d, "m2"), { kind: "resolved", turnId: "turn-2" });
});

test("while running with no provider output yet, the active turn belongs to the last user message", () => {
  const d = detail([user("m1"), assistant("turn-1"), user("m2")], "turn-2");
  assert.deepEqual(resolveTurnForMessage(d, "m2"), { kind: "active", turnId: "turn-2" });
  assert.deepEqual(resolveTurnForMessage(d, "m1"), { kind: "resolved", turnId: "turn-1" });
});

test("not started, missing, and superseded are distinguished", () => {
  assert.deepEqual(resolveTurnForMessage(detail([user("m1")], null), "m1"), { kind: "not_started" });
  assert.deepEqual(resolveTurnForMessage(detail([user("m1")], null), "nope"), { kind: "missing" });
  assert.deepEqual(resolveTurnForMessage(detail([user("m1"), user("m2"), assistant("turn-2")], null), "m1"), { kind: "superseded" });
});

test("a reasoning message counts as provider output for the turn", () => {
  const reasoning: T3Message = { id: "reasoning:1", role: "reasoning", text: "thinking", turnId: "turn-1", streaming: true, createdAt: "" };
  assert.deepEqual(resolveTurnForMessage(detail([user("m1"), reasoning], "turn-1"), "m1"), { kind: "resolved", turnId: "turn-1" });
});
