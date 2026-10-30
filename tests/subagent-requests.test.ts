/**
 * A task T3 delegates runs on a thread of its own, its lineage naming the member's thread as parent (relationship
 * "subagent"), and T3 keeps the approval, secret or question it raises there. It holds the member as its own would, and
 * only the user can answer it: it is the member's in Needs you and in the member's state, and it is answered on the
 * subagent's thread (#187).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTestStack, type TestStack } from "./helpers.ts";

let stack: TestStack | undefined;
afterEach(() => {
  stack?.close();
  stack = undefined;
});

/** sol1 at work, with a task delegated to a thread of its own that asks for a command approval; returns both threads. */
async function delegatedApproval(s: TestStack): Promise<{ parent: string; child: string; requestId: string }> {
  const parent = s.threadOf("sol1");
  await s.fake.sendMessage({ commandId: "go", threadId: parent, messageId: "go", text: "Build the pages.", mode: { type: "start" } });
  const child = "thread:delegated-task:pages";
  s.fake.setSubagent(parent, { id: "pages", title: "Build the pages", status: "running", origin: "app_owned", childThreadId: child });
  const requestId = s.fake.raiseApproval(child, "req-sub", { prompt: "rm -rf \"$(git rev-parse --show-toplevel)/dist\"" });
  await s.tick();
  return { parent, child, requestId };
}

test("a subagent's pending approval is the member's: in its open native requests on the subagent's thread, and its state reads approval", async () => {
  stack = await createTestStack();
  const { parent, child, requestId } = await delegatedApproval(stack);
  const open = stack.repos.listOpenNativeRequests([stack.participants.sol1!]);
  assert.deepEqual(open.map((r) => [r.threadId, r.requestId, r.kind]), [[child, requestId, "approval"]]);
  assert.equal((open[0]!.payload as { detail: string }).detail, "rm -rf \"$(git rev-parse --show-toplevel)/dist\"");
  assert.equal((await stack.memberState(parent, false)).state, "approval", "the classifier counts the subagent's hold as the member's");
});

test("answering a subagent's approval from the room answers it on the subagent's thread and resolves the row", async () => {
  stack = await createTestStack();
  const { child, requestId } = await delegatedApproval(stack);
  await stack.run({ type: "native.approval.respond", participantId: stack.participants.sol1!, requestId, decision: "accept" });
  const sent = stack.fake.commands.filter((c) => c.type === "runtime-request.respond");
  assert.deepEqual(sent.map((c) => c.threadId), [child], "T3 is asked on the thread the prompt is on");
  assert.equal(stack.fake.threads.get(child)!.runtimeRequests.find((r) => r.id === requestId)!.decision, "accept");
  assert.deepEqual(stack.repos.listOpenNativeRequests([stack.participants.sol1!]), []);
});

test("a subagent's row resolves when T3 clears the request, answered elsewhere", async () => {
  stack = await createTestStack();
  const { parent, child, requestId } = await delegatedApproval(stack);
  assert.deepEqual(stack.repos.listOpenNativeRequests([stack.participants.sol1!]).map((r) => r.requestId), [requestId], "mirrored first");
  await stack.fake.respondApproval({ commandId: "in-t3", threadId: child, requestId, decision: "decline" });
  await stack.tick();
  assert.deepEqual(stack.repos.listOpenNativeRequests([stack.participants.sol1!]), []);
  assert.notEqual((await stack.memberState(parent, false)).state, "approval");
});
