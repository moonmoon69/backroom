import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { persistFake } from "../src/adapter/fakeState.ts";

function stateFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rooms-fake-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "fake-t3.json");
}

const launch = (fake: FakeT3Adapter, threadId: string) =>
  fake.launchThread({ commandId: `launch:${threadId}`, threadId, projectId: "project_demo", title: "Room · worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
const send = (fake: FakeT3Adapter, threadId: string, n: number) =>
  fake.sendMessage({ commandId: `cmd:${n}`, threadId, messageId: `msg:${n}`, text: `message ${n}`, mode: { type: "start" } });

test("a kept fake T3 comes back after a restart with its threads, runs, receipts and held threads", async (t) => {
  const file = stateFile(t);
  const before = persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file);
  await launch(before, "thread-a");
  before.setHeld("thread-a", true);
  await send(before, "thread-a", 1);
  assert.ok(existsSync(file), "written after the calls that changed it");

  // The service is killed: a new process makes a new fake from the same file.
  const after = persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file);
  const detail = (await after.getThreadDetail("thread-a"))!;
  assert.deepEqual(detail.runs.map((r) => [r.id, r.status]), [["run:thread:thread-a:ordinal:1", "running"]]);
  assert.ok(after.held.has("thread-a"));
  // The same command again is a replay T3 keeps a receipt for; a new one gets the next ordinal, not ordinal 1 again.
  await send(after, "thread-a", 1);
  await send(after, "thread-a", 2);
  const runs = (await after.getThreadDetail("thread-a"))!.runs;
  assert.deepEqual(runs.map((r) => [r.id, r.status]), [["run:thread:thread-a:ordinal:1", "running"], ["run:thread:thread-a:ordinal:2", "queued"]]);
  after.completeRun("thread-a", { text: "Done." });
  const ended = persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file);
  assert.deepEqual((await ended.getThreadDetail("thread-a"))!.runs.map((r) => r.status), ["completed", "running"]);
});

test("a run left running and not held still ends by itself after the restart", async (t) => {
  const file = stateFile(t);
  const before = persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file);
  await launch(before, "thread-b");
  await send(before, "thread-b", 1);
  const after = persistFake(new FakeT3Adapter({ autoCompleteMs: 20 }), file);
  const end = Date.now() + 2_000;
  while ((await after.getThreadDetail("thread-b"))!.runs[0]!.status === "running" && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await after.getThreadDetail("thread-b"))!.runs[0]!.status, "completed");
  // And the end was written: a third start sees it.
  assert.equal((await persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file).getThreadDetail("thread-b"))!.runs[0]!.status, "completed");
});

test("the fake T3 reports each change to its state once it is made, a burst once; its feed is always live", async (t) => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const heard: Array<{ threadIds: readonly string[] | null; status: string | undefined }> = [];
  const off = fake.onShellChange((change) => heard.push({ threadIds: change.threadIds, status: fake.threads.get("thread:w")?.shell.status }));
  await launch(fake, "thread:w");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard, [{ threadIds: null, status: "idle" }]);
  // A message starts a run: several changes in one call, heard of once, after the run is recorded.
  await send(fake, "thread:w", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard.at(-1), { threadIds: null, status: "running" });
  assert.equal(heard.length, 2);
  // Test controls too: a run completed, background work listed, a hold.
  fake.completeRun("thread:w", { text: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  fake.setBackground("thread:w", ["watch"]);
  await new Promise((resolve) => setImmediate(resolve));
  fake.setHeld("thread:w", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard.slice(2).map((h) => h.status), ["completed", "completed", "completed"]);
  // A command T3 has a receipt for changes nothing: not heard of.
  await send(fake, "thread:w", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heard.length, 5);
  off();
  await send(fake, "thread:w", 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heard.length, 5, "a removed listener hears nothing");
  assert.deepEqual([fake.feed().state, fake.feed().error], ["connected", null]);

  // Kept in a file: asking for its feed or listening writes nothing.
  const file = stateFile(t);
  const kept = persistFake(new FakeT3Adapter({ autoCompleteMs: null }), file);
  kept.feed();
  kept.onShellChange(() => {})();
  assert.equal(existsSync(file), false);
});
