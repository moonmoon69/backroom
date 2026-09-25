import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack } from "./helpers.ts";

test("rooms can be renamed and reordered", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const second = (await stack.run({ type: "room.create", projectId: "project_demo", title: "second" })) as { roomId: string };
  await stack.run({ type: "room.update", roomId: stack.roomId, title: "payments v2" });
  assert.equal(stack.repos.getRoom(stack.roomId)?.title, "payments v2");
  await stack.run({ type: "room.reorder", roomIds: [second.roomId, stack.roomId] });
  assert.deepEqual(stack.repos.listRooms().map((r) => r.title), ["second", "payments v2"]);
});

test("deleting a room removes its data and applies the chosen action to each thread in T3", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const image = stack.service.storeAttachment({ roomId: stack.roomId, name: "a.png", mimeType: "image/png", data: Uint8Array.from([1, 2, 3]) });
  await stack.run({ type: "message.create", roomId: stack.roomId, attachmentIds: [image.id], assignments: [{ recipients: [stack.participants.sol1!], instruction: "go" }] });
  await stack.tick(2);
  const threads = { sol1: stack.threadOf("sol1"), sol2: stack.threadOf("sol2"), claude: stack.threadOf("claude") };
  const result = (await stack.run({
    type: "room.delete",
    roomId: stack.roomId,
    threads: { [stack.participants.sol1!]: "settle", [stack.participants.sol2!]: "delete" },
  })) as { threads: Array<{ alias: string; action: string; result: string }> };
  assert.deepEqual(result.threads.map((r) => [r.alias, r.action, r.result]).sort(), [["claude", "keep", "kept"], ["sol1", "settle", "done"], ["sol2", "delete", "done"]]);
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.settle" && c.threadId === threads.sol1));
  assert.ok(!stack.fake.threads.has(threads.sol2), "deleted in T3");
  assert.ok(stack.fake.threads.has(threads.claude), "kept in T3");
  assert.equal(stack.repos.getRoom(stack.roomId), null);
  assert.equal(stack.repos.listTasks(stack.roomId).length, 0);
  assert.equal(stack.repos.listEvents(stack.roomId).length, 0);
  assert.equal(stack.repos.getAttachment(image.id), null);
  await stack.tick(2); // the scheduler keeps running without the room
});

test("removing a participant can settle, archive, or delete its T3 thread; threads shared with another room are kept", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const archived = stack.threadOf("sol1");
  const deleted = stack.threadOf("sol2");
  const shared = stack.threadOf("claude");

  // Default: the thread is left alone.
  const keep = (await stack.run({ type: "participant.retire", participantId: stack.participants.sol1!, pendingTasks: "cancel" })) as {
    thread: { action: string; result: string };
  };
  assert.deepEqual(keep.thread, { threadId: archived, action: "keep", result: "kept" });
  assert.equal(stack.fake.commands.some((c) => c.type.startsWith("thread.archive") || c.type === "thread.delete"), false);

  // Archive: T3 receives thread.archive. (sol1 is already retired, so exercise it through sol2's sibling.)
  const other = (await stack.run({
    type: "participant.create",
    roomId: stack.roomId,
    alias: "sol3",
    modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
    thread: { mode: "create" },
  })) as { participantId: string };
  const archiveResult = (await stack.run({ type: "participant.retire", participantId: other.participantId, pendingTasks: "cancel", thread: "archive" })) as {
    thread: { threadId: string; action: string; result: string };
  };
  assert.equal(archiveResult.thread.action, "archive");
  assert.equal(archiveResult.thread.result, "done");
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.archive" && c.threadId === archiveResult.thread.threadId));

  // Delete: T3 receives thread.delete and the fake forgets the thread.
  const deleteResult = (await stack.run({ type: "participant.retire", participantId: stack.participants.sol2!, pendingTasks: "cancel", thread: "delete" })) as {
    thread: { action: string; result: string };
  };
  assert.deepEqual(deleteResult.thread, { threadId: deleted, action: "delete", result: "done" });
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.delete" && c.threadId === deleted));
  assert.equal(await stack.fake.getThreadShell(deleted), null);

  // A thread also seated in another room is kept regardless of the choice. Attaching a live thread twice is refused
  // by the command layer, so the second seat is pointed at the shared thread directly in the store.
  const second = (await stack.run({ type: "room.create", projectId: "project_demo", title: "second" })) as { roomId: string };
  const seat = (await stack.run({
    type: "participant.create",
    roomId: second.roomId,
    alias: "claude",
    modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
    thread: { mode: "create" },
  })) as { participantId: string };
  const seatBinding = stack.repos.currentBinding(seat.participantId);
  assert.ok(seatBinding);
  stack.repos.updateBinding({ ...seatBinding, retiredAt: new Date().toISOString() });
  stack.repos.insertBinding({ ...seatBinding, id: `${seatBinding.id}-shared`, generation: seatBinding.generation + 1, threadId: shared, retiredAt: null });
  const sharedResult = (await stack.run({ type: "participant.retire", participantId: stack.participants.claude!, pendingTasks: "cancel", thread: "delete" })) as {
    thread: { action: string; result: string; detail?: string };
  };
  assert.equal(sharedResult.thread.result, "kept");
  assert.match(sharedResult.thread.detail ?? "", /another room/);
  assert.equal(stack.fake.commands.some((c) => c.type === "thread.delete" && c.threadId === shared), false);
});
