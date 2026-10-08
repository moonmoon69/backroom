/**
 * H4 review round 1 (Opus6): the two findings as tests. Copy into <checkout>/tests/runtime/ and run with node --test.
 * Both fail on 8a2569f / a62a502; the guard passes there and must keep passing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

async function relaunch(r: Room, seat: string): Promise<void> {
  const threadId = r.threadOf(seat);
  r.fake.threads.delete(threadId);
  await r.fake.launchThread({ commandId: r.id(`relaunch-${seat}`), threadId, projectId: "project_demo", title: `room · ${seat}`, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
}

test("R1-F1: a run whose send alone keeps failing as T3Unavailable while T3 answers every read gets an outcome (a notice and Retry) after a bound", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  // T3 lists the threads and answers every read; only the message never gets through (the command socket, a dispatch
  // T3 never answers within the adapter's limit, a socket T3 closes on this one message).
  room.fake.unavailableSends = 1_000_000;
  const a = room.user("W", "Job.");
  for (let i = 0; i < 120; i++) {
    room.clock += 15_000;
    await room.tick();
  }
  const run = [...room.p.runs.values()].at(-1)!;
  assert.ok(room.fake.attempts.length > 3, "the host kept trying");
  assert.notEqual(run.phase, "sending", `30 minutes of failed sends with every read answered: still ${run.phase}, ${room.notices().length} notices`);
  assert.equal(room.notices().length, 1);
  assert.equal(room.state(a), "open");
});

test("R1-F1 guard: a passing send outage within the bound does not fail the run", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  room.fake.unavailableSends = 4;
  const a = room.user("W", "Job.");
  for (let i = 0; i < 4; i++) {
    room.clock += 15_000;
    await room.tick();
  }
  await room.until(() => room.running("W"), 10);
  assert.equal(room.notices().length, 0);
  room.complete("W", "Done.");
  await room.until(() => room.state(a) === "answered");
});

test("R1-F2: the reply of the turn T3 ran under a reused ID is a note under the request, not dropped as thread history", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  const first = room.user("W", "First job.");
  await room.until(() => room.running("W"));
  room.complete("W", "First job done.");
  await room.until(() => room.state(first) === "answered");
  await relaunch(room, "W");
  const second = room.user("W", "Second job.");
  await room.tick(3);
  assert.equal([...room.p.runs.values()].at(-1)!.phase, "terminal", "the refused run failed (H4)");
  assert.ok(room.running("W"), "T3 runs the message it took");
  room.complete("W", "Second job done in T3 anyway.");
  await room.tick(3);
  const notes = room.p.events.flatMap((e) => (e.data.kind === "note" ? [e.data] : []));
  assert.deepEqual(notes.map((n) => [n.body, n.requestIds]), [["(T3 ran a message after Backroom had recorded it as failed) Second job done in T3 anyway.", [second]]]);
  assert.equal(room.state(second), "open");
  assert.equal(room.notices().length, 1);
  // Imported once: a restart does not import it again.
  room.restart();
  await room.tick(3);
  assert.equal(room.p.events.filter((e) => e.data.kind === "note").length, 1);
});
