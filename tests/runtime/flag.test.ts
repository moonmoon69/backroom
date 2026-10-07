/** The ROOMS_ENGINE flag in src/app/bootstrap.ts: off by default and inert; on, the host runs over data/board.sqlite. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeT3Adapter } from "../../src/adapter/fake.ts";
import { createStack } from "../../src/app/bootstrap.ts";
import { parseCommand } from "../../src/domain/commands.ts";

function stack(dir: string, engine?: boolean) {
  return createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null, ...(engine === undefined ? {} : { engine }) });
}

test("without the flag the stack has no engine, never opens board.sqlite, and the old scheduler dispatches as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-flag-"));
  const previous = process.env.ROOMS_ENGINE;
  delete process.env.ROOMS_ENGINE;
  try {
    const s = stack(dir);
    assert.equal(s.engine, null);
    assert.equal(existsSync(join(dir, "board.sqlite")), false);
    const { roomId } = (await s.service.execute(parseCommand({ type: "room.create", projectId: "project_demo", title: "old" }))) as { roomId: string };
    const { participantId } = (await s.service.execute(parseCommand({ type: "participant.create", roomId, alias: "worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } }))) as { participantId: string };
    await s.service.execute(parseCommand({ type: "message.create", roomId, assignments: [{ recipients: [participantId], instruction: "Old-path task." }] }));
    await s.scheduler.tick();
    const fake = s.adapter as FakeT3Adapter;
    assert.equal(fake.threads.get(s.repos.currentBinding(participantId)!.threadId)!.runs.length, 1, "the old scheduler dispatched");
    s.close();
  } finally {
    if (previous !== undefined) process.env.ROOMS_ENGINE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with ROOMS_ENGINE=1 the host runs over board.sqlite next to rooms.sqlite and serves the stack's rooms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-flag-"));
  const previous = process.env.ROOMS_ENGINE;
  process.env.ROOMS_ENGINE = "1";
  try {
    const s = stack(dir);
    assert.ok(s.engine);
    assert.equal(existsSync(join(dir, "board.sqlite")), true);
    const fake = s.adapter as FakeT3Adapter;
    const { roomId } = (await s.service.execute(parseCommand({ type: "room.create", projectId: "project_demo", title: "engine" }))) as { roomId: string };
    const { participantId } = (await s.service.execute(parseCommand({ type: "participant.create", roomId, alias: "worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } }))) as { participantId: string };
    // A seat is a participant's binding: seat ID = binding ID, on the binding's thread.
    const binding = s.repos.currentBinding(participantId)!;
    s.engine.seat(roomId, { actor: "$user", id: "seat-w", seatId: binding.id, threadId: binding.threadId });
    // The flag selects the engine: a message on the old path makes an old task, but the old scheduler never dispatches it.
    await s.service.execute(parseCommand({ type: "message.create", roomId, assignments: [{ recipients: [participantId], instruction: "Old-path task." }] }));
    await s.scheduler.tick();
    assert.equal(fake.threads.get(binding.threadId)!.runs.length, 0, "the old scheduler does not dispatch with the flag on");
    s.engine.request(roomId, { actor: "$user", id: "req-1", to: binding.id, body: "Hello from the journal." });
    await s.scheduler.tick();
    const runs = fake.threads.get(binding.threadId)!.runs;
    assert.equal(runs.length, 1, "ticking the stack's scheduler ticks the engine host, which dispatched the request");
    const prompt = fake.threads.get(binding.threadId)!.messages.find((m) => m.id === runs[0]!.userMessageId)!.text;
    assert.match(prompt, /^\[Backroom briefing for @worker in room "engine"\]/, "L2's briefing, standing part included");
    assert.match(prompt, /\[#\d+ request from the user\]\nHello from the journal\./);
    s.close();
  } finally {
    if (previous === undefined) delete process.env.ROOMS_ENGINE;
    else process.env.ROOMS_ENGINE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine: false overrides the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-flag-"));
  const previous = process.env.ROOMS_ENGINE;
  process.env.ROOMS_ENGINE = "1";
  try {
    const s = stack(dir, false);
    assert.equal(s.engine, null);
    s.close();
  } finally {
    if (previous === undefined) delete process.env.ROOMS_ENGINE;
    else process.env.ROOMS_ENGINE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
