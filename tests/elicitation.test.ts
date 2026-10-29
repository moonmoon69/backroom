/**
 * An MCP server's form request (T3's approval with requestKind "mcp-elicitation"): the card offers the request's own
 * choices, in T3's order and words, and answers with the one chosen (the user's #160, item C).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { openRequests } from "../src/adapter/types.ts";
import { requestPayload } from "../src/app/threadView.ts";
import { approvalChoices } from "../web/src/requestWords.ts";
import { createTestStack, type TestStack } from "./helpers.ts";
import { t3Stub } from "./t3Stub.ts";

const THREAD = "e1c1e1c1-0000-4000-8000-000000000001";
const RUN = `run:thread:${THREAD}:ordinal:3`;
/** What describeMcpElicitation offers for a server that allows a session approval but not a permanent one. */
const OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] as const;

function projection() {
  const at = "2026-10-30T01:00:00.000Z";
  const item = (id: string, requestId: string, requestKind: string, extra: object) => ({ id, threadId: THREAD, runId: RUN, nodeId: `node-${requestId}`, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 3, status: "waiting", title: null, startedAt: at, completedAt: null, updatedAt: at, type: "approval_request", requestId, requestKind, ...extra });
  const request = (id: string, kind: string) => ({ id, nodeId: `node-${id}`, providerTurnId: null, nativeRequestRef: null, kind, status: "pending", responseCapability: { type: "live" }, createdAt: at, resolvedAt: null });
  return {
    thread: { id: THREAD, projectId: "proj", title: "mcp", providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, archivedAt: null, settledAt: null, deletedAt: null, createdAt: at, updatedAt: at },
    runs: [{ id: RUN, threadId: THREAD, ordinal: 3, providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, userMessageId: "m", status: "waiting", queuePosition: null, requestedAt: at, startedAt: at, completedAt: null, checkpointId: null }],
    messages: [],
    turnItems: [
      item("i-1", "req-form", "mcp-elicitation", { prompt: "Allow Linear to create an issue in project BACK?", appName: "Linear", options: OPTIONS }),
      item("i-2", "req-auth", "auth_refresh", { prompt: "Refresh the token", appName: null, options: null }),
    ],
    runtimeRequests: [request("req-form", "mcp-elicitation"), request("req-auth", "auth_refresh")],
    nodes: [], attempts: [], subagents: [], providerSessions: [], providerTurns: [], plans: [], checkpoints: [], checkpointScopes: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], providerThreads: [],
    updatedAt: at,
  };
}

test("a form request from T3's projection keeps its prompt, its app and its own choices in order; a credential refresh stays out of what waits", async () => {
  const { adapter } = t3Stub({ "/api/orchestration/shell": { schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [] }, [`/api/orchestration/threads/${THREAD}`]: { snapshotSequence: 1, projection: projection() } });
  const detail = (await adapter.getThreadDetail(THREAD))!;
  const waiting = openRequests(detail);
  assert.deepEqual(waiting.map((r) => r.id), ["req-form"], "auth_refresh is T3's to handle");
  const payload = requestPayload(waiting[0]!);
  assert.equal(payload.requestType, "mcp-elicitation");
  assert.equal(payload.detail, "Allow Linear to create an issue in project BACK?");
  assert.equal(payload.appName, "Linear");
  assert.deepEqual(payload.options, OPTIONS);
});

test("the card offers the request's own choices in its order, words and cautions; without any, T3's five decisions", () => {
  assert.deepEqual(approvalChoices(OPTIONS).map((c) => [c.decision, c.label, c.tone ?? null]), [
    ["cancel", "Cancel", "danger"],
    ["decline", "Decline", "danger"],
    ["acceptForSession", "Always allow this session", null],
    ["accept", "Approve", "primary"],
  ], "no permanent approval: the server did not offer one");
  assert.deepEqual(approvalChoices([{ decision: "accept", label: "Run it", warning: "It deletes the cache." }]), [{ decision: "accept", label: "Run it", tone: "primary", warning: "It deletes the cache." }]);
  const legacy = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"];
  assert.deepEqual(approvalChoices(null).map((c) => c.decision), legacy, "a request from before options: T3's five");
  assert.deepEqual(approvalChoices([]).map((c) => c.decision), legacy);
  assert.deepEqual(approvalChoices([{ decision: "approve-everything", label: "Yes" }, { decision: "accept" }]).map((c) => c.decision), legacy, "nothing usable: T3's five");
});

let stack: TestStack | undefined;
afterEach(() => {
  stack?.close();
  stack = undefined;
});

test("answering a form request sends the choice made; one it did not offer is refused before T3, for a member and for a loose thread", async () => {
  stack = await createTestStack();
  const threadId = stack.threadOf("sol1");
  await stack.fake.sendMessage({ commandId: "go", threadId, messageId: "go", text: "File the bug in Linear.", mode: { type: "start" } });
  const requestId = stack.fake.raiseApproval(threadId, "req-form", { kind: "mcp-elicitation", prompt: "Allow Linear to create an issue?", options: [...OPTIONS], appName: "Linear" });
  await stack.tick();
  const open = stack.repos.listOpenNativeRequests([stack.participants.sol1!]);
  assert.deepEqual((open[0]!.payload as { options: unknown }).options, OPTIONS, "mirrored with its choices");
  const respond = (decision: string) => stack!.run({ type: "native.approval.respond", participantId: stack!.participants.sol1!, requestId, decision: decision as never });
  await assert.rejects(respond("acceptAlways"), /does not offer "acceptAlways"/);
  assert.equal(stack.fake.commands.filter((c) => c.type === "runtime-request.respond").length, 0, "nothing reached T3");
  await respond("acceptForSession");
  assert.equal(stack.fake.threads.get(threadId)!.runtimeRequests.find((r) => r.id === requestId)!.decision, "acceptForSession");

  const loose = await stack.fake.launchThread({ commandId: "l", threadId: "loose", projectId: "project_demo", title: "loose", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "lm", text: "Go." } });
  const looseRequest = stack.fake.raiseApproval(loose.id, "req-loose", { kind: "mcp-elicitation", prompt: "Allow Linear?", options: [OPTIONS[0], OPTIONS[1], OPTIONS[3]], appName: "Linear" });
  await assert.rejects(stack.run({ type: "thread.approval.respond", threadId: loose.id, requestId: looseRequest, decision: "acceptForSession" }), /does not offer/);
  await stack.run({ type: "thread.approval.respond", threadId: loose.id, requestId: looseRequest, decision: "decline" });
  assert.equal(stack.fake.threads.get(loose.id)!.runtimeRequests[0]!.decision, "decline");
});
