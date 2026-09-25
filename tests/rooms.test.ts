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
