import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
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

test("projects are listed in the sidebar order Backroom keeps; ones never placed follow in T3's order", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-order", ROOMS_PORT: "0" }), "/nonexistent/dist");
  stack.fake.projects.push({ id: "project_b", title: "b", workspaceRoot: "/tmp/b", defaultModelSelection: null }, { id: "project_c", title: "c", workspaceRoot: "/tmp/c", defaultModelSelection: null });
  const listed = async () => ((await (await app.request("/api/t3/projects")).json()) as Array<{ id: string }>).map((p) => p.id);
  assert.deepEqual(await listed(), ["project_demo", "project_b", "project_c"], "T3's order until one is placed");
  await stack.run({ type: "project.reorder", projectIds: ["project_c", "project_demo", "project_c"] });
  // A project added in T3 later goes after the placed ones.
  stack.fake.projects.push({ id: "project_d", title: "d", workspaceRoot: "/tmp/d", defaultModelSelection: null });
  assert.deepEqual(await listed(), ["project_c", "project_demo", "project_b", "project_d"]);
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

for (const engine of [false, true]) {
  test(`deleting a room sends the thread actions at once, deletes the room without waiting, and reports an action T3 is slow to answer as timed out (engine ${engine ? "on" : "off"})`, async (t) => {
    const limit = 300;
    const logged: string[] = [];
    const aliases = ["sol1", "sol2", "sol3", "sol4", "claude", "gone"];
    const stack = await createTestStack({ autoCompleteMs: null }, aliases, { engine, threadActionTimeoutMs: limit, log: (message) => logged.push(message) });
    t.after(() => stack.close());
    const threads = Object.fromEntries(aliases.map((alias) => [alias, stack.threadOf(alias)]));
    // A late answer must never surface as an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    // A retired member's thread is left alone, and so is one also seated in another room (pointed at in the store, as above).
    await stack.run({ type: "participant.retire", participantId: stack.participants.gone!, pendingTasks: "cancel" });
    const second = (await stack.run({ type: "room.create", projectId: "project_demo", title: "second" })) as { roomId: string };
    const seat = (await stack.run({ type: "participant.create", roomId: second.roomId, alias: "claude", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } })) as { participantId: string };
    const seatBinding = stack.repos.currentBinding(seat.participantId);
    assert.ok(seatBinding);
    stack.repos.updateBinding({ ...seatBinding, retiredAt: new Date().toISOString() });
    stack.repos.insertBinding({ ...seatBinding, id: `${seatBinding.id}-shared`, generation: seatBinding.generation + 1, threadId: threads.claude!, retiredAt: null });

    // T3 under load: sol1's and sol4's settles do not answer until released (then sol1's applies, sol4's is refused);
    // the others take 100 ms each.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    const calls: Array<{ threadId: string; type: string; startedAt: number; endedAt: number | null; roomGone: boolean }> = [];
    const original = stack.fake.setThreadLifecycle.bind(stack.fake);
    stack.fake.setThreadLifecycle = async (input) => {
      const call = { threadId: input.threadId, type: `thread.${input.action}`, startedAt: performance.now(), endedAt: null as number | null, roomGone: stack.repos.getRoom(stack.roomId) === null };
      calls.push(call);
      if (input.threadId === threads.sol1 || input.threadId === threads.sol4) await held;
      else await new Promise((resolve) => setTimeout(resolve, 100));
      if (input.threadId === threads.sol4) throw new Error("T3 refused thread.settle");
      await original(input);
      call.endedAt = performance.now();
    };

    const began = performance.now();
    const answer = stack.run({
      type: "room.delete",
      roomId: stack.roomId,
      threads: Object.fromEntries(["sol1", "sol2", "sol4", "gone"].map((alias) => [stack.participants[alias]!, "settle"]).concat([[stack.participants.sol3!, "archive"], [stack.participants.claude!, "delete"]])),
    }) as Promise<{ type: string; threads: Array<{ alias: string; threadId: string; action: string; result: string; detail?: string }> }>;
    const result = await Promise.race([answer, new Promise<null>((resolve) => setTimeout(() => resolve(null), limit + 1500))]);
    const elapsed = performance.now() - began;
    assert.ok(result, `the delete answered within the limit (it had not after ${Math.round(elapsed)} ms, with ${calls.length} of 4 actions sent)`);
    assert.ok(elapsed < limit + 1000, `answered in ${Math.round(elapsed)} ms, limit ${limit} ms`);

    assert.equal(result.type, "room.deleted");
    assert.equal(stack.repos.getRoom(stack.roomId), null, "the room is deleted");
    assert.deepEqual(
      result.threads.map((r) => [r.alias, r.action, r.result]).sort(),
      [["claude", "delete", "kept"], ["sol1", "settle", "timeout"], ["sol2", "settle", "done"], ["sol3", "archive", "done"], ["sol4", "settle", "timeout"]],
    );
    assert.match(result.threads.find((r) => r.alias === "sol1")?.detail ?? "", /not answered after 0\.3 s; the settle may still go through/);
    assert.match(result.threads.find((r) => r.alias === "claude")?.detail ?? "", /another room/);

    // All four actions were sent at once, not one after another, each once the room was deleted.
    assert.deepEqual(calls.map((c) => c.threadId).sort(), [threads.sol1, threads.sol2, threads.sol3, threads.sol4].sort(), "no action for the retired or the shared thread");
    const lastStart = Math.max(...calls.map((c) => c.startedAt));
    const firstEnd = Math.min(...calls.filter((c) => c.endedAt !== null).map((c) => c.endedAt!));
    assert.ok(lastStart < firstEnd, "every action was sent before the first one finished");
    assert.ok(lastStart - began < 50, `all sent within ${Math.round(lastStart - began)} ms of the command`);
    assert.deepEqual(calls.map((c) => c.roomGone), [true, true, true, true], "each action was sent after the room was deleted");
    assert.ok(stack.fake.commands.some((c) => c.type === "thread.archive" && c.threadId === threads.sol3));
    const lifecycle = /^thread\.(settle|archive|delete)$/;
    assert.ok(!stack.fake.commands.some((c) => lifecycle.test(c.type) && (c.threadId === threads.claude || c.threadId === threads.gone)), "kept threads are not changed in T3");

    // T3 answers later: sol1's settle goes through, sol4's is refused; both are logged, nothing is thrown, and the
    // answer already given stands.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(stack.fake.commands.some((c) => c.type === "thread.settle" && c.threadId === threads.sol1));
    assert.ok(logged.some((line) => line.includes("@sol1") && line.includes("settle finished late")), logged.join("\n"));
    assert.ok(logged.some((line) => line.includes("@sol4") && line.includes("settle failed late")), logged.join("\n"));
    assert.deepEqual(unhandled, []);
  });
}

test("a limit beyond what a timer can hold is held at its maximum: a T3 that answers is done, not timed out at once", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1", "sol2", "claude"], { threadActionTimeoutMs: 1e10 });
  t.after(() => stack.close());
  const original = stack.fake.setThreadLifecycle.bind(stack.fake);
  stack.fake.setThreadLifecycle = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await original(input);
  };
  const result = (await stack.run({ type: "room.delete", roomId: stack.roomId, threads: { [stack.participants.sol1!]: "settle" } })) as { threads: Array<{ alias: string; result: string }> };
  assert.deepEqual(result.threads.find((r) => r.alias === "sol1")?.result, "done");
});

test("two deletes of the same room at once: one deletes it and sends each action once, the other finds no room", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const sol1 = stack.threadOf("sol1");
  const sol2 = stack.threadOf("sol2");
  const threads = { [stack.participants.sol1!]: "settle", [stack.participants.sol2!]: "archive" } as const;
  const [first, second] = await Promise.allSettled([
    stack.run({ type: "room.delete", roomId: stack.roomId, threads }),
    stack.run({ type: "room.delete", roomId: stack.roomId, threads }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.match(String((second as PromiseRejectedResult).reason), /room/i);
  const lifecycle = stack.fake.commands.filter((c) => /^thread\.(settle|archive|delete)$/.test(c.type));
  assert.deepEqual(lifecycle.map((c) => [c.type, c.threadId]), [["thread.settle", sol1], ["thread.archive", sol2]]);
});

test("a room whose delete fails is kept, and none of its threads is changed in T3", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  stack.repos.deleteRoomCascade = () => {
    throw new Error("disk full");
  };
  await assert.rejects(stack.run({ type: "room.delete", roomId: stack.roomId, threads: { [stack.participants.sol1!]: "delete", [stack.participants.sol2!]: "settle" } }), /disk full/);
  assert.ok(stack.repos.getRoom(stack.roomId), "the room is still there");
  assert.equal(stack.fake.commands.some((c) => /^thread\.(settle|archive|delete)$/.test(c.type)), false, "no thread was changed in T3");
  assert.ok(stack.fake.threads.has(stack.threadOf("sol1")));
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

test("the room list counts the participants seated now, not the ones removed", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-list", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const count = async () => ((await (await app.request("/api/rooms")).json()) as Array<{ id: string; participantCount: number }>).find((r) => r.id === stack.roomId)?.participantCount;
  assert.equal(await count(), 3);
  await stack.run({ type: "participant.retire", participantId: stack.participants.sol1 as string, pendingTasks: "cancel" });
  await stack.run({ type: "participant.retire", participantId: stack.participants.sol2 as string, pendingTasks: "cancel" });
  assert.equal(await count(), 1, "two were removed");
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } });
  assert.equal(await count(), 2, "and one was added again");
});
