/**
 * H4, the two limits next to H3's room deletion: removing one member waits for its T3 thread action no longer than the
 * per-call limit room deletion has, and an action T3 was sent but never answered (its own
 * time limit, or the shared socket dropped by another call's) is reported and logged as unknown, not as failed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { T3OutcomeUnknown } from "../src/adapter/types.ts";
import { createTestStack } from "./helpers.ts";

type Retired = { type: string; thread?: { action: string; result: string; detail?: string } };

test(`removing a member answers within the per-call limit while T3 holds its settle, and logs the late outcome`, async (t) => {
  const limit = 300;
  const logged: string[] = [];
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1", "sol2"], { threadActionTimeoutMs: limit, log: (message) => logged.push(message) });
  t.after(() => stack.close());
  const sol1 = stack.threadOf("sol1");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const original = stack.fake.setThreadLifecycle.bind(stack.fake);
  stack.fake.setThreadLifecycle = async (input) => {
    await held;
    await original(input);
  };

  const began = performance.now();
  const answer = stack.run({ type: "participant.retire", participantId: stack.participants.sol1!, thread: "settle" }) as Promise<Retired>;
  const result = await Promise.race([answer, new Promise<null>((resolve) => setTimeout(() => resolve(null), limit + 1500))]);
  const elapsed = performance.now() - began;
  assert.ok(result, `the removal answered within the limit (it had not after ${Math.round(elapsed)} ms)`);
  assert.ok(elapsed < limit + 1000, `answered in ${Math.round(elapsed)} ms, limit ${limit} ms`);
  assert.equal(result.type, "participant.updated");
  assert.equal(result.thread?.result, "timeout");
  assert.match(result.thread?.detail ?? "", /not answered after 0\.3 s; the settle may still go through/);
  assert.ok(stack.repos.getParticipant(stack.participants.sol1!)?.retiredAt, "the member is removed all the same");

  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.settle" && c.threadId === sol1), "T3 applied it later");
  assert.ok(logged.some((line) => line.includes("@sol1") && line.includes("settle finished late in T3")), logged.join("\n"));
  assert.deepEqual(unhandled, []);
});

test(`a settle T3 was sent and never answered is unknown, not failed: within the limit it is reported as not confirmed, after it it is logged as unknown`, async (t) => {
  const limit = 300;
  const logged: string[] = [];
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1", "sol2", "sol3"], { threadActionTimeoutMs: limit, log: (message) => logged.push(message) });
  t.after(() => stack.close());
  // sol1's settle is dropped with the socket at once; sol2's after the limit; sol3's is refused by T3.
  const threads = { sol1: stack.threadOf("sol1"), sol3: stack.threadOf("sol3") };
  stack.fake.setThreadLifecycle = async (input) => {
    if (input.threadId === threads.sol1) throw new T3OutcomeUnknown("T3 RPC orchestration.dispatchCommand: connection closed before T3 answered");
    if (input.threadId === threads.sol3) throw new Error("T3 refused orchestration.dispatchCommand: thread is busy");
    await new Promise((resolve) => setTimeout(resolve, limit + 100));
    throw new T3OutcomeUnknown("T3 RPC orchestration.dispatchCommand timed out after 60000ms");
  };

  const removed = (await stack.run({ type: "participant.retire", participantId: stack.participants.sol1!, thread: "settle" })) as Retired;
  assert.equal(removed.thread?.result, "timeout", "a dropped connection is not a failure");
  assert.match(removed.thread?.detail ?? "", /^T3 did not answer \(T3 RPC orchestration\.dispatchCommand: connection closed before T3 answered\); the settle may still go through$/);

  const refused = (await stack.run({ type: "participant.retire", participantId: stack.participants.sol3!, thread: "settle" })) as Retired;
  assert.equal(refused.thread?.result, "failed", "a refusal stays a failure");

  const deleted = (await stack.run({ type: "room.delete", roomId: stack.roomId, threads: { [stack.participants.sol2!]: "settle" } })) as { threads: Array<{ alias: string; result: string }> };
  assert.equal(deleted.threads.find((r) => r.alias === "sol2")?.result, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const late = logged.filter((line) => line.includes("@sol2"));
  assert.equal(late.length, 1, logged.join("\n"));
  assert.match(late[0]!, /^room "payments" deleted: @sol2's thread .* settle: T3 never answered; outcome unknown, it may have been applied$/);
  assert.ok(!logged.some((line) => line.includes("failed late")), logged.join("\n"));
});
