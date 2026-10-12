/**
 * The host woken by T3's shell changes (the T3 shell feed): a change to a seat's thread ticks at once, the interval
 * kept as the fallback; a change that only moves `updatedAt` (T3 streams one per item of a running thread) does not;
 * one that comes during a tick runs one more tick after it; stop, start and close leave one listener, or none.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

/** Let timers, immediates and promises run until `done` holds, for `ms` at most. */
async function until(done: () => boolean, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  return done();
}

/** The ticks the host runs from now on (a call while one runs joins it, and is not counted). */
function countTicks(r: Room): { runs: number } {
  const counter = { runs: 0 };
  const host = r.host as unknown as { runTick: () => Promise<void> };
  const run = host.runTick.bind(r.host);
  host.runTick = () => {
    counter.runs += 1;
    return run();
  };
  return counter;
}

const listeners = (r: Room) => (r.fake as unknown as { shellListeners: Set<unknown> }).shellListeners.size;

test("a change T3 reports to a seat's thread wakes the host at once; the interval stays the fallback", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  await room.tick();
  assert.ok(room.running("W"));
  // An interval no test waits for: only a wake can tick now.
  room.host.start(60_000);
  const ticks = countTicks(room);
  room.complete("W", "Dates fixed.");
  assert.ok(await until(() => room.outputs().some((o) => o.body.includes("Dates fixed."))), "the reply is imported without waiting for the interval");
  assert.ok(ticks.runs >= 1);
});

test("a change that only moves a seat thread's updatedAt does not wake the host, nor one to a thread of no seat", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  await room.tick();
  room.host.start(60_000);
  // A tick lists W running (the tick before sent its message after listing it idle).
  await room.tick();
  const ticks = countTicks(room);
  const notify = () => (room.fake as unknown as { changed: () => void }).changed();
  // T3 streams a change per item of a running thread: its updatedAt moves, nothing a tick reads.
  room.fake.thread(room.threadOf("W")).shell.updatedAt = new Date(Date.now() + 60_000).toISOString();
  notify();
  await until(() => false, 50);
  assert.equal(ticks.runs, 0);
  // A thread no seat is on.
  await room.fake.launchThread({ commandId: "launch:other", threadId: "thread:other", projectId: "project_demo", title: "elsewhere", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  room.fake.startExternalRun("thread:other");
  await until(() => false, 50);
  assert.equal(ticks.runs, 0);
  // What a tick reads: it wakes.
  room.fake.setBackground(room.threadOf("W"), ["watch"]);
  assert.ok(await until(() => ticks.runs === 1));
});

test("a change that comes during a tick, after the tick listed the threads, runs one more tick after it", async () => {
  room = await Room.create({ seats: ["W", "V"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  await room.tick();
  room.host.start(60_000);
  const ticks = countTicks(room);
  // While the tick that the reply wakes reads W's thread, V's thread changes: that tick listed it before the change,
  // and is still running when the change is heard of (T3 takes its time with the read).
  room.fake.onDetail = {
    threadId: room.threadOf("W"),
    run: async () => {
      room.fake.setBackground(room.threadOf("V"), ["watch"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  room.complete("W", "Dates fixed.");
  assert.ok(await until(() => ticks.runs === 2, 2_000), `ticks: ${ticks.runs}`);
  await until(() => false, 50);
  assert.equal(ticks.runs, 2, "one more, not a loop");
});

test("start, start again and stop leave one shell listener or none; a stopped or closed host is not woken", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  await room.tick();
  assert.equal(listeners(room), 0);
  room.host.start(60_000);
  room.host.start(60_000);
  assert.equal(listeners(room), 1);
  room.host.stop();
  assert.equal(listeners(room), 0);
  const ticks = countTicks(room);
  room.complete("W", "Dates fixed.");
  await until(() => false, 50);
  assert.equal(ticks.runs, 0, "stopped: not woken");
  room.host.start(60_000);
  room.host.close();
  assert.equal(listeners(room), 0, "closed: no listener left");
});
