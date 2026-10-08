/** The engine is the only runtime (Z4): every stack runs the host over data/board.sqlite, whatever ROOMS_ENGINE says. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeT3Adapter } from "../../src/adapter/fake.ts";
import { createStack } from "../../src/app/bootstrap.ts";
import { parseCommand } from "../../src/domain/commands.ts";

function stack(dir: string) {
  return createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null });
}

for (const flag of [undefined, "0", "1"]) {
  test(`with ROOMS_ENGINE ${flag === undefined ? "unset" : `=${flag}`} the host runs over board.sqlite next to rooms.sqlite and serves the stack's rooms`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "backroom-flag-"));
    const previous = process.env.ROOMS_ENGINE;
    if (flag === undefined) delete process.env.ROOMS_ENGINE;
    else process.env.ROOMS_ENGINE = flag;
    try {
      const s = stack(dir);
      assert.equal(existsSync(join(dir, "board.sqlite")), true);
      const fake = s.adapter as FakeT3Adapter;
      const { roomId } = (await s.service.execute(parseCommand({ type: "room.create", projectId: "project_demo", title: "engine" }))) as { roomId: string };
      const { participantId } = (await s.service.execute(parseCommand({ type: "participant.create", roomId, alias: "worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } }))) as { participantId: string };
      // A seat is a participant's binding: seat ID = binding ID, on the binding's thread.
      const binding = s.repos.currentBinding(participantId)!;
      // Seating the member seated it on the board too (L4b): no seat briefing, since the room has no Consigliere.
      assert.equal(s.engine.view(roomId).seats.get(binding.id)?.threadId, binding.threadId);
      // The user's message is a request on the journal (L4a).
      await s.service.execute(parseCommand({ type: "message.create", roomId, assignments: [{ recipients: [participantId], instruction: "Hello from the journal." }] }));
      assert.equal([...s.engine.view(roomId).requests.values()].length, 1);
      await s.engine.tick();
      const runs = fake.threads.get(binding.threadId)!.runs;
      assert.equal(runs.length, 1, "the engine host dispatched the request");
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
}
