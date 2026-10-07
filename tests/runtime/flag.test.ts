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

test("without the flag the stack has no engine and never opens board.sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-flag-"));
  const previous = process.env.ROOMS_ENGINE;
  delete process.env.ROOMS_ENGINE;
  try {
    const s = stack(dir);
    assert.equal(s.engine, null);
    assert.equal(existsSync(join(dir, "board.sqlite")), false);
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
    await fake.launchThread({ commandId: "launch-w", threadId: "thread-w", projectId: "project_demo", title: "engine · W", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
    s.engine.seat(roomId, { actor: "$user", id: "seat-w", seatId: "W", threadId: "thread-w" });
    s.engine.request(roomId, { actor: "$user", id: "req-1", to: "W", body: "Hello from the journal." });
    s.engine.stop();
    await s.engine.tick();
    assert.equal(fake.threads.get("thread-w")!.runs.length, 1, "the host dispatched the request");
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
