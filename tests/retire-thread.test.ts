/**
 * The retire setting: what happens to a member's T3 thread when the Consigliere retires it (rooms-board retire) or a
 * reseat retires the old seat. App-wide, kept by default; the retire reply says what was done.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { Board } from "../src/app/board.ts";
import { parseCommand } from "../src/domain/commands.ts";
import { agentKey } from "../src/browser/catalog.ts";
import { RETIRE_THREAD_KEY } from "../src/app/consigliere.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

const board = (stack: TestStack) =>
  new Board({
    repos: stack.repos,
    execute: (command) => stack.service.execute(parseCommand(command)),
    afterSeat: () => stack.tick(2),
    statusOf: (participantId) => stack.scheduler.participantStatus(participantId),
  });
const key = (stack: TestStack, alias: string) => agentKey(alias, stack.roomId);
const member = (stack: TestStack, alias: string) => stack.repos.listParticipants(stack.roomId).find((p) => p.alias === alias)!;
const threadOf = (stack: TestStack, alias: string) => stack.repos.listBindings([member(stack, alias).id])[0]!.threadId;
const finish = async (stack: TestStack, alias: string, text: string) => {
  stack.fake.completeRun(threadOf(stack, alias), { text });
  await stack.tick(3);
};

/** alice is the Consigliere; bob and carol have answered their seat briefings. */
async function room() {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice", "bob", "carol"]);
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await stack.tick(2);
  await finish(stack, "bob", "Understood.");
  await finish(stack, "carol", "Understood.");
  return stack;
}

test("the retire setting is keep until the user picks another, and the settings route reads it", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-retire-thread", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const setting = async () => ((await (await app.request("/api/settings")).json()) as { retireThread: string }).retireThread;
  assert.equal(await setting(), "keep");
  for (const thread of ["settle", "archive", "delete"] as const) {
    await stack.run({ type: "consigliere.retireThread.set", thread });
    assert.equal(await setting(), thread);
  }
  await stack.run({ type: "consigliere.retireThread.set", thread: "keep" });
  assert.equal(await setting(), "keep");
  assert.equal(stack.repos.getKv(RETIRE_THREAD_KEY), null, "keep is the default, not a stored value");
  await assert.rejects(stack.run({ type: "consigliere.retireThread.set", thread: "unarchive" } as never));
});

test("rooms-board retire treats the member's thread as the setting says, and its reply names what was done", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  const bobThread = threadOf(stack, "bob");
  await stack.run({ type: "consigliere.retireThread.set", thread: "archive" });
  assert.equal(await board(stack).run(["retire", "bob"], key(stack, "alice")), "@bob has left the room. Its T3 thread was archived, as the user's retire setting says.");
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.archive" && c.threadId === bobThread));
  assert.ok(stack.fake.threads.get(bobThread)!.shell.archivedAt);
  assert.ok(stack.repos.listEvents(stack.roomId).some((e) => e.kind === "system" && /@bob removed from the room; .*its T3 thread was archived/.test(e.text)));

  // A T3 that refuses leaves the thread as it was, and the reply says so.
  const carolThread = threadOf(stack, "carol");
  await stack.run({ type: "consigliere.retireThread.set", thread: "delete" });
  const original = stack.fake.setThreadLifecycle.bind(stack.fake);
  stack.fake.setThreadLifecycle = async () => {
    throw new Error("T3 said no");
  };
  t.after(() => (stack.fake.setThreadLifecycle = original));
  assert.equal(await board(stack).run(["retire", "carol"], key(stack, "alice")), "@carol has left the room. Its T3 thread stays as it was: T3 could not delete it (T3 said no).");
  assert.ok(stack.fake.threads.has(carolThread));
  assert.ok(member(stack, "carol").retiredAt);
});

test("with the setting at keep, rooms-board retire leaves the thread alone", async (t) => {
  const stack = await room();
  t.after(() => stack.close());
  assert.equal(await board(stack).run(["retire", "bob"], key(stack, "alice")), "@bob has left the room. Its thread stays in T3.");
  assert.ok(!stack.fake.commands.some((c) => ["thread.settle", "thread.archive", "thread.delete"].includes(c.type)));
});

test("a reseat retires the old seat's thread as the setting says", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, ["alice"]);
  t.after(() => stack.close());
  await stack.run({ type: "preset.create", name: "carol", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } });
  await stack.run({ type: "room.consigliere.set", roomId: stack.roomId, participantId: stack.participants.alice! });
  await board(stack).run(["seat", "carol"], key(stack, "alice"));
  await finish(stack, "carol", "Seated.");
  await stack.run({ type: "consigliere.retireThread.set", thread: "settle" });
  const oldThread = threadOf(stack, "carol");

  await board(stack).run(["reseat", "carol"], key(stack, "alice"));
  await stack.tick(2);
  await finish(stack, "carol", "Checkpoint: nothing in flight; next step: the tests.");
  assert.ok(member(stack, "carol").retiredAt, "the old seat left");
  assert.equal(member(stack, "carol2").retiredAt, null);
  assert.ok(stack.fake.commands.some((c) => c.type === "thread.settle" && c.threadId === oldThread));
  assert.ok(stack.fake.threads.get(oldThread)!.shell.settledAt);
  assert.notEqual(threadOf(stack, "carol2"), oldThread);
  assert.ok(!stack.fake.threads.get(threadOf(stack, "carol2"))!.shell.settledAt, "the fresh seat's thread is untouched");
});
