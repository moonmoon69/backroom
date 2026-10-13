/**
 * The host and T3's thread streams: it keeps its seats' threads watched, a change to one wakes it at once (one that
 * comes during a tick, one more tick after it), and while the thread feed serves a seat's detail a tick reads none
 * from T3 unless the thread changed, with nothing else a tick does held back (deliveries, imports, keep-alives).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { FeedConnection } from "../../src/adapter/shellFeed.ts";
import { ThreadFeed } from "../../src/adapter/threadFeed.ts";
import type { T3ThreadDetail } from "../../src/adapter/types.ts";
import { KEEP_ALIVE_MS } from "../../src/runtime/index.ts";
import { Room, RuntimeFake } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

async function until(done: () => boolean, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  return done();
}

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

/**
 * The fake T3 with its details served as the HTTP adapter serves them: through the thread feed, its reads of T3 counted,
 * the fake's own changes to a watched thread as T3's stream of it (an event each, numbered), and each thread's floor
 * as the adapter takes it from the shell feed: the sequence at which its listed shell last changed in more than its time.
 */
class StreamedFake extends RuntimeFake {
  readonly reads: Array<{ threadId: string; bounded: boolean }> = [];
  private sequence = 0;
  private readonly floors = new Map<string, { key: string; sequence: number }>();
  private readonly told = new Set<(threadId: string) => void>();
  private readonly streams = new Map<string, (values: unknown[]) => void>();
  readonly detailFeed: ThreadFeed<T3ThreadDetail>;

  constructor() {
    super();
    this.detailFeed = new ThreadFeed<T3ThreadDetail>({
      read: async (threadId) => {
        this.reads.push({ threadId, bounded: true });
        const detail = await this.direct(threadId);
        return detail ? { ...detail, snapshotSequence: this.sequence } : null;
      },
      onChange: (threadId) => {
        for (const listener of [...this.told]) listener(threadId);
      },
      floor: (threadId) => {
        const shell = this.threads.get(threadId)?.shell;
        if (!shell) return 0;
        const key = JSON.stringify({ ...shell, updatedAt: undefined });
        const known = this.floors.get(threadId);
        if (known?.key === key) return known.sequence;
        this.floors.set(threadId, { key, sequence: this.sequence });
        return this.sequence;
      },
      throttleMs: 0,
    });
    const streams = this.streams;
    const connection: FeedConnection = {
      closed: false,
      heardAt: Date.now(),
      stream: (_tag, payload, onValues) => {
        const threadId = (payload as { threadId: string }).threadId;
        streams.set(threadId, onValues);
        queueMicrotask(() => streams.get(threadId)?.([{ kind: "synchronized" }]));
        return { done: new Promise<void>(() => undefined), cancel: () => streams.delete(threadId) };
      },
      ping: () => undefined,
      close: () => undefined,
    };
    this.detailFeed.connect(connection);
    // The fake's change to a watched thread: T3 streams it.
    super.onThreadChange((threadId) => {
      this.sequence += 1;
      this.streams.get(threadId)?.([{ kind: "event", sequence: this.sequence, event: {} }]);
    });
  }

  private direct(threadId: string): Promise<T3ThreadDetail | null> {
    return super.getThreadDetail(threadId);
  }

  override onThreadChange(listener: (threadId: string) => void): () => void {
    this.told.add(listener);
    return () => {
      this.told.delete(listener);
    };
  }

  override holdThreads(owner: string, threadIds: readonly string[]): void {
    super.holdThreads(owner, threadIds);
    this.detailFeed.hold(owner, threadIds);
  }

  override async getThreadDetail(threadId: string): Promise<T3ThreadDetail | null> {
    return await this.detailFeed.detail(threadId, true);
  }

  /** A command, as the HTTP adapter marks it: the thread's next read is made afresh. */
  override async sendMessage(input: Parameters<RuntimeFake["sendMessage"]>[0]): Promise<void> {
    try {
      await super.sendMessage(input);
    } finally {
      this.detailFeed.command(input.threadId);
    }
  }

  of(seatThread: string): number {
    return this.reads.filter((r) => r.threadId === seatThread).length;
  }
}

test("a change to a seat's thread that its shell does not show (an item of a running turn) wakes the host at once; one of a thread no seat is on does not", async () => {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  await room.tick(2);
  assert.ok(room.running("W"));
  room.host.start(60_000);
  const ticks = countTicks(room);
  // An item of the running turn: T3's shell stream moves only the thread's time, its thread stream tells the change.
  room.fake.say(room.threadOf("W"), "Halfway through dates.ts.");
  assert.ok(await until(() => ticks.runs >= 1), "woken by the thread's change, not the 60 s interval");
  await until(() => false, 50);
  const after = ticks.runs;
  assert.ok(after <= 2, `a wake, not a loop: ${after}`);
  // A thread no seat is on: not watched by the host, nothing told.
  await room.fake.launchThread({ commandId: "launch:other", threadId: "thread:other", projectId: "project_demo", title: "elsewhere", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  room.fake.startExternalRun("thread:other");
  room.fake.say("thread:other", "elsewhere");
  await until(() => false, 50);
  assert.equal(ticks.runs, after);
  room.host.stop();
  assert.equal(room.fake.watches.size, 1, "stopped: its seat's thread lingers, released");
});

test("a seat's thread change that comes during a tick, after the tick read it, runs one more tick after it", async () => {
  room = await Room.create({ seats: ["W", "V"], orchestrator: null });
  room.user("W", "Look at dates.ts.");
  room.user("V", "Look at parse.ts.");
  await room.tick(2);
  room.host.start(60_000);
  const ticks = countTicks(room);
  room.fake.onDetail = {
    threadId: room.threadOf("W"),
    run: async () => {
      room.fake.say(room.threadOf("V"), "Halfway through parse.ts.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  room.fake.say(room.threadOf("W"), "Halfway through dates.ts.");
  assert.ok(await until(() => ticks.runs === 2, 2_000), `ticks: ${ticks.runs}`);
  await until(() => false, 50);
  assert.equal(ticks.runs, 2, "one more, not a loop");
});

test("while a seat's thread is unchanged its ticks read none of it from T3; a change is read once; deliveries and imports go on", async () => {
  let fake!: StreamedFake;
  room = await Room.create({ seats: ["W"], orchestrator: null, fake: () => (fake = new StreamedFake()) });
  const thread = room.threadOf("W");
  room.user("W", "Look at dates.ts.");
  await room.tick(3);
  assert.ok(room.running("W"));
  // A running turn: every tick looks at the run. Nothing changes in T3: nothing is read.
  const quiet = fake.of(thread);
  await room.tick(5);
  assert.equal(fake.of(thread), quiet, "no read without a change");
  // An item of the turn: read once, whoever asks after.
  room.fake.say(thread, "Halfway through dates.ts.");
  assert.ok(await until(() => fake.of(thread) === quiet + 1));
  await room.tick(3);
  assert.equal(fake.of(thread), quiet + 1);
  // The turn ends: read, and its reply imported.
  room.complete("W", "Dates fixed.");
  await room.tick(2);
  assert.ok(room.outputs().some((o) => o.body.includes("Dates fixed.")), "the reply is imported");
  // A new request is delivered: the tick does everything it did, only the reads it would repeat are gone.
  const wakes = room.wakes("W");
  room.user("W", "Now parse.ts.");
  await room.tick(2);
  assert.equal(room.wakes("W"), wakes + 1, "delivered");
  assert.match(room.prompt("W"), /Now parse\.ts\./);
});

test("keep-alives fall due on the clock while the seat's thread, unchanged, is served from its read", async () => {
  let fake!: StreamedFake;
  room = await Room.create({ fake: () => (fake = new StreamedFake()) });
  room.user("C", "Have W build the release.");
  await room.tick();
  room.post("C", "W", "Build the release; it takes a while.");
  room.complete("C", "Handed off to W.");
  await room.tick(3);
  assert.ok(room.running("W") && !room.running("C"));
  const c = room.threadOf("C");
  const keepAlives = () => room.p.events.filter((e) => e.data.kind === "notice" && e.data.intent === "keep-alive").length;
  const reads = fake.of(c);
  room.clock = Date.parse(room.fake.thread(c).shell.latestRunCompletedAt!) + KEEP_ALIVE_MS - 1;
  await room.tick(3);
  assert.equal(keepAlives(), 0, "not due yet");
  assert.equal(fake.of(c), reads, "C's unchanged thread is not read again while the host waits on the clock");
  const wakes = room.wakes("C");
  room.clock += 2;
  await room.tick();
  assert.equal(keepAlives(), 1, "due on the clock: posted");
  assert.equal(room.wakes("C"), wakes + 1, "and sent");
});

test("review #1: a turn the room did not start, whose end the shell shows while the thread's own read is throttled, is imported from a detail read beside that shell", async () => {
  let fake!: StreamedFake;
  room = await Room.create({ fake: () => (fake = new StreamedFake()) });
  const id = room.id("ask-C");
  room.host.request(room.room, { actor: "C", id, to: "W", body: "First job." });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await room.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await settle();
  room.complete("W", "First job done.");
  await settle();
  if (room.running("C")) room.complete("C", "ok");
  await settle();
  const W = room.threadOf("W");
  room.fake.startExternalRun(W, "Quick question typed in T3");
  await room.tick(2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The real throttle from here on: a thread's own reads at most one per 2 s.
  (fake.detailFeed as unknown as { throttleMs: number }).throttleMs = 2000;
  room.fake.say(W, "thinking");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await room.tick(2);
  // The turn ends: the thread's own read of it is owed, throttled; a tick comes meanwhile (the shell's wake, the interval).
  room.complete("W", "Node 24.");
  await room.tick(2);
  const followUps = () => room.p.events.filter((e) => e.data.kind === "progress" && (e.data as { milestone?: string }).milestone === "follow-up");
  assert.ok(followUps().some((e) => JSON.stringify(e.data).includes("Node 24.")), `imported in the tick that listed its end: ${JSON.stringify(followUps().map((e) => (e.data as { body?: string }).body))}`);
});
