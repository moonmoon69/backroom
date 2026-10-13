/**
 * The thread feed (src/adapter/threadFeed.ts) against a socket of the test's own: which threads are watched and for how
 * long, their streams on the feed's socket, the cache of their reads by sequence, the throttle of the reads their
 * events cause, and the way back to reading T3 directly when a stream is refused or the feed is down.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_STREAM, ThreadFeed, ThreadWatches, type ThreadSnapshot } from "../src/adapter/threadFeed.ts";
import type { FeedConnection } from "../src/adapter/shellFeed.ts";
import { T3CommandRejected, T3Unavailable } from "../src/adapter/types.ts";

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeStream {
  id: number;
  tag: string;
  payload: { threadId: string; afterSequence?: number; acceptBoundedSnapshot?: boolean; acceptCompactTurnItems?: boolean; requestCompletionMarker?: boolean };
  onValues: (values: unknown[]) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  over: boolean;
}

/** The feed's socket as the thread feed uses it: streams it can open, and what the test makes T3 send on them. */
class FakeConnection implements FeedConnection {
  closed = false;
  heardAt = Date.now();
  readonly streams: FakeStream[] = [];
  readonly interrupted: number[] = [];

  stream(tag: string, payload: unknown, onValues: (values: unknown[]) => void): { done: Promise<void>; cancel: () => void } {
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const stream: FakeStream = { id: this.streams.length + 1, tag, payload: payload as FakeStream["payload"], onValues, resolve, reject, over: false };
    this.streams.push(stream);
    return {
      done,
      cancel: () => {
        if (stream.over) return;
        stream.over = true;
        this.interrupted.push(stream.id);
        resolve();
      },
    };
  }

  ping(): void {}

  close(): void {
    this.drop();
  }

  /** The open stream of a thread. */
  of(threadId: string): FakeStream {
    const stream = [...this.streams].reverse().find((s) => s.payload.threadId === threadId && !s.over);
    assert.ok(stream, `an open stream of ${threadId}`);
    return stream;
  }

  /** T3 sends `values` as one chunk on the thread's stream. */
  send(threadId: string, ...values: unknown[]): void {
    this.of(threadId).onValues(values);
  }

  /** T3 refuses (or fails) the thread's stream. */
  refuse(threadId: string, error: unknown = new T3CommandRejected("T3 refused orchestration.subscribeThread: no such thread", 500, null)): void {
    const stream = this.of(threadId);
    stream.over = true;
    stream.reject(error);
  }

  /** The socket goes: every stream on it fails. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) {
      if (stream.over) continue;
      stream.over = true;
      stream.reject(new T3Unavailable("T3 RPC orchestration.subscribeThread: connection closed"));
    }
  }
}

/** T3's side of the reads: each thread at a sequence; each read counted, and answered at once unless held. */
function t3Reads() {
  const at = new Map<string, number>();
  const reads: Array<{ threadId: string; bounded: boolean }> = [];
  let holding = false;
  const held: Array<() => void> = [];
  const read = async (threadId: string, bounded: boolean): Promise<ThreadSnapshot | null> => {
    reads.push({ threadId, bounded });
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    if (!at.has(threadId)) return null;
    const sequence = at.get(threadId)!;
    return { snapshotSequence: sequence, projection: { thread: { id: threadId }, bounded, sequence } };
  };
  return {
    at,
    reads,
    read,
    count: (threadId: string, bounded?: boolean) => reads.filter((r) => r.threadId === threadId && (bounded === undefined || r.bounded === bounded)).length,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

function feed(options: { throttleMs?: number; leaseMs?: number; lingerMs?: number; retryMs?: number } = {}) {
  const t3 = t3Reads();
  const changes: string[] = [];
  const logs: Array<{ message: string; detail: unknown }> = [];
  const threads = new ThreadFeed({
    read: t3.read,
    onChange: (threadId) => changes.push(threadId),
    log: (message, detail) => logs.push({ message, detail }),
    throttleMs: options.throttleMs ?? 50,
    leaseMs: options.leaseMs ?? 60_000,
    lingerMs: options.lingerMs ?? 30_000,
    retryMs: options.retryMs ?? 60_000,
  });
  const connection = new FakeConnection();
  return { t3, changes, logs, threads, connection, throttleMs: options.throttleMs ?? 50 };
}

/**
 * A thread watched on a live socket, its stream synchronized, its first read cached at `sequence`, and a quiet spell
 * after that read (it counts toward the throttle: the next change is read at once).
 */
async function live(f: ReturnType<typeof feed>, threadId: string, sequence: number, watch: (id: string) => void = (id) => f.threads.lease(id)) {
  f.t3.at.set(threadId, sequence);
  watch(threadId);
  await settle();
  f.connection.send(threadId, { kind: "synchronized" });
  await settle();
  await sleep(f.throttleMs + 10);
}

test("a watched thread is read once and subscribed after that read; an unwatched one is read as before, and subscribes nothing", async () => {
  const f = feed();
  f.threads.connect(f.connection);
  f.t3.at.set("loose", 3);
  await f.threads.detail("loose", true);
  await f.threads.detail("loose", true);
  assert.equal(f.t3.count("loose"), 2, "the overview's describing reads: read each time");
  assert.equal(f.connection.streams.length, 0, "and no stream");

  f.t3.at.set("t1", 7);
  f.threads.lease("t1");
  await settle();
  assert.equal(f.t3.count("t1", true), 1, "its first read, before it is subscribed to");
  const stream = f.connection.of("t1");
  assert.equal(stream.tag, THREAD_STREAM);
  assert.deepEqual(stream.payload, { threadId: "t1", afterSequence: 7, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true }, "after its read: T3 replays what came since, no snapshot");
  // Until T3 has replayed what it missed, the cache is not trusted.
  await f.threads.detail("t1", true);
  assert.equal(f.t3.count("t1", true), 2);
  f.connection.send("t1", { kind: "synchronized" });
  await settle();
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await f.threads.detail("t1", true))?.snapshotSequence, 7);
  assert.equal(f.t3.count("t1", true), 2, "live: every caller gets the cached read");
  assert.deepEqual(f.threads.status(), { watched: 1, live: 1, refused: 0 });
  assert.equal(f.threads.pushed("t1"), true);
  assert.equal(f.threads.pushed("loose"), false);
  f.threads.close();
});

test("an event past the cached read reads it once, told after it is cached; an event the read covers, or one shown again, reads nothing", async () => {
  const f = feed();
  f.threads.connect(f.connection);
  await live(f, "t1", 7);
  const before = f.t3.count("t1");
  f.connection.send("t1", { kind: "event", sequence: 6, event: {} }, { kind: "event", sequence: 7, event: {} });
  await settle();
  assert.equal(f.t3.count("t1"), before, "covered by the read cached");
  assert.deepEqual(f.changes, []);

  // The change: read once; told once it is cached, so a read made then sees it with no read of its own.
  let seenInListener: number | undefined;
  f.t3.at.set("t1", 8);
  const told = new Promise<void>((resolve) => {
    const original = f.changes.push.bind(f.changes);
    f.changes.push = (...ids: string[]) => {
      void f.threads.detail("t1", true).then((snapshot) => {
        seenInListener = snapshot?.snapshotSequence;
        resolve();
      });
      return original(...ids);
    };
  });
  f.connection.send("t1", { kind: "event", sequence: 8, event: {} });
  await told;
  assert.equal(seenInListener, 8, "a read made when it is told sees the change");
  assert.equal(f.t3.count("t1"), before + 1, "one read, the listener's read served from the cache");
  // Shown again (a replay, a duplicate): nothing.
  f.connection.send("t1", { kind: "event", sequence: 8, event: {} });
  await settle();
  await sleep(80);
  assert.equal(f.t3.count("t1"), before + 1);
  assert.deepEqual([...f.changes], ["t1"]);
  f.threads.close();
});

test("an event that comes during a read is read after it; a read is labelled with what it read, and a late answer never replaces a newer one", async () => {
  const f = feed({ throttleMs: 30 });
  f.threads.connect(f.connection);
  await live(f, "t1", 7);
  const base = f.t3.count("t1");
  f.t3.hold();
  f.t3.at.set("t1", 8);
  f.connection.send("t1", { kind: "event", sequence: 8, event: {} });
  await settle();
  assert.equal(f.t3.count("t1"), base + 1, "the read the event owes, in flight");
  // T3 moves on while the read is out; the read answers what it read: 8.
  f.connection.send("t1", { kind: "event", sequence: 9, event: {} });
  f.t3.release();
  await settle();
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 8, "served as read, labelled 8, not 9");
  f.t3.at.set("t1", 9);
  await sleep(60);
  await settle();
  assert.equal(f.t3.count("t1"), base + 2, "the event that came during the read is read after it");
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 9);

  // A command has the next read made afresh while an older read is still out; the older one answers last, with less.
  f.t3.hold();
  f.t3.at.set("t1", 10);
  f.connection.send("t1", { kind: "event", sequence: 10, event: {} });
  await sleep(40);
  await settle();
  const older = f.t3.reads.length;
  f.threads.command("t1", 12);
  f.t3.at.set("t1", 12);
  const fresh = f.threads.detail("t1", true);
  await settle();
  assert.equal(f.t3.reads.length, older + 1, "the command's read does not share the read sent before it");
  f.t3.release();
  assert.equal((await fresh)?.snapshotSequence, 12);
  await settle();
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 12, "the read sent before the command, answering after, does not replace it");
  f.threads.close();
});

test("the throttle: the first change is read at once, then one read per spell while the thread keeps changing, and one after the last; threads do not hold each other back", async () => {
  const f = feed({ throttleMs: 100 });
  f.threads.connect(f.connection);
  await live(f, "t1", 1);
  await live(f, "t2", 1);
  const base = f.t3.count("t1");
  let sequence = 1;
  const change = (threadId: string) => {
    sequence += 1;
    f.t3.at.set(threadId, sequence);
    f.connection.send(threadId, { kind: "event", sequence, event: {} });
  };
  change("t1");
  await settle();
  assert.equal(f.t3.count("t1"), base + 1, "at once");
  // A burst of 350 ms, an event every 10 ms.
  const started = Date.now();
  while (Date.now() - started < 350) {
    change("t1");
    await sleep(10);
  }
  const during = f.t3.count("t1") - base;
  assert.ok(during >= 3 && during <= 5, `one per 100 ms spell: ${during} reads in 350 ms`);
  // Another thread changing meanwhile is read at once, not after t1's spell.
  const t2Before = f.t3.count("t2");
  change("t2");
  await settle();
  assert.equal(f.t3.count("t2"), t2Before + 1);
  // The last change of the burst is read at the end of its spell.
  const last = sequence - 1;
  await sleep(150);
  await settle();
  assert.ok((await f.threads.detail("t1", true))!.snapshotSequence! >= last, "the burst's last change is read");
  const after = f.t3.count("t1");
  await sleep(250);
  assert.equal(f.t3.count("t1"), after, "nothing more once it is read");
  f.threads.close();
});

test("a full read is served while it is not older than the bounded one; a command has the next read of each kind made afresh", async () => {
  const f = feed({ throttleMs: 0 });
  f.threads.connect(f.connection);
  await live(f, "t1", 7);
  assert.equal((await f.threads.detail("t1", false))?.snapshotSequence, 7);
  assert.equal(f.t3.count("t1", false), 1);
  await f.threads.detail("t1", false);
  assert.equal(f.t3.count("t1", false), 1, "cached");
  // The thread moves on: the bounded read is read again by its event; the full one then is older than it.
  f.t3.at.set("t1", 8);
  f.connection.send("t1", { kind: "event", sequence: 8, event: {} });
  await settle();
  assert.equal((await f.threads.detail("t1", false))?.snapshotSequence, 8, "a caller that saw the bounded detail at 8 gets a full one as new");
  assert.equal(f.t3.count("t1", false), 2);
  // A command: both kinds are read afresh, at once, whatever the cache holds.
  const bounded = f.t3.count("t1", true);
  f.threads.command("t1", 9);
  f.t3.at.set("t1", 9);
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 9);
  assert.equal((await f.threads.detail("t1", false))?.snapshotSequence, 9);
  assert.equal(f.t3.count("t1", true), bounded + 1);
  assert.equal(f.t3.count("t1", false), 3);
  f.threads.close();
});

test("a read that fails is not served around: callers read T3 themselves until one succeeds", async () => {
  let fail = false;
  const reads: string[] = [];
  const threads = new ThreadFeed({
    read: async (threadId) => {
      reads.push(threadId);
      if (fail) throw new T3Unavailable("T3 returned HTTP 503");
      return { snapshotSequence: 5, projection: {} };
    },
    onChange: () => undefined,
    throttleMs: 0,
  });
  const connection = new FakeConnection();
  threads.connect(connection);
  threads.lease("t1");
  await settle();
  connection.send("t1", { kind: "synchronized" });
  await settle();
  fail = true;
  connection.send("t1", { kind: "event", sequence: 6, event: {} });
  await settle();
  const before = reads.length;
  await assert.rejects(threads.detail("t1", true), /503/, "not the cached read: T3's failure, as before");
  assert.equal(reads.length, before + 1);
  fail = false;
  assert.equal((await threads.detail("t1", true))?.snapshotSequence, 5);
  await threads.detail("t1", true);
  assert.equal(reads.length, before + 2, "served from the cache again once a read succeeded");
  threads.close();
});

test("leases: a page's read keeps a thread watched for the lease, renewed by each read; the stream outlives it by the linger, and is interrupted after", async () => {
  const f = feed({ leaseMs: 150, lingerMs: 100 });
  f.threads.connect(f.connection);
  await live(f, "t1", 3);
  const first = f.connection.of("t1");
  // The page's fallback read comes a little after the lease's end, within the linger: the same stream, no new read.
  await sleep(180);
  f.threads.lease("t1");
  await f.threads.detail("t1", true);
  assert.equal(f.connection.of("t1"), first, "kept: not subscribed again");
  assert.deepEqual(f.connection.interrupted, []);
  assert.equal(f.t3.count("t1"), 1, "and served from the cache");
  // Nothing renews it: interrupted after the lease and the linger.
  await sleep(150 + 100 + 60);
  assert.deepEqual(f.connection.interrupted, [first.id]);
  assert.deepEqual(f.threads.status(), { watched: 0, live: 0, refused: 0 });
  assert.equal(f.threads.pushed("t1"), false);
  f.threads.close();
});

test("owners: the engine's hold and a page's lease share one stream; releasing one leaves the other's watch, and the stream ends after the last", async () => {
  const f = feed({ leaseMs: 100, lingerMs: 80 });
  f.threads.connect(f.connection);
  f.t3.at.set("t1", 3);
  f.t3.at.set("t2", 4);
  f.threads.hold("engine", ["t1", "t2"]);
  f.threads.lease("t1");
  f.threads.hold("other", ["t1"]);
  await settle();
  assert.equal(f.connection.streams.length, 2, "one stream per thread, whoever watches it");
  const [s1, s2] = [f.connection.of("t1"), f.connection.of("t2")];
  assert.notEqual(s1.id, s2.id);
  // The engine retires t2's seat and keeps t1.
  f.threads.hold("engine", ["t1"]);
  await sleep(120);
  assert.deepEqual(f.connection.interrupted, [s2.id], "t2: nobody watches it after the linger");
  f.threads.hold("engine", []);
  await sleep(250);
  assert.deepEqual(f.connection.interrupted, [s2.id], "t1: still held by the other owner, past its lease");
  f.threads.hold("other", []);
  await sleep(120);
  assert.deepEqual(f.connection.interrupted, [s2.id, s1.id]);
  f.threads.close();
});

test("ThreadWatches: a hold replaced keeps what stays, a lease renewed within the linger is never unwatched, and close tells nobody", async () => {
  const events: string[] = [];
  const watches = new ThreadWatches({ onWatch: (id) => events.push(`+${id}`), onUnwatch: (id) => events.push(`-${id}`), leaseMs: 50, lingerMs: 50 });
  watches.hold("engine", ["a", "b"]);
  watches.hold("engine", ["b", "c"]);
  assert.deepEqual(events, ["+a", "+b", "+c"]);
  await sleep(70);
  assert.deepEqual(events, ["+a", "+b", "+c", "-a"]);
  watches.lease("d");
  for (let i = 0; i < 4; i += 1) {
    await sleep(60);
    watches.lease("d");
  }
  assert.ok(!events.includes("-d"), "renewed each time within lease + linger");
  watches.close();
  await sleep(150);
  assert.deepEqual(events, ["+a", "+b", "+c", "-a", "+d"]);
});

test("a stream T3 refuses is logged; that thread is read from T3 as before, its changes not pushed, while the others go on, and T3 is asked again later", async () => {
  const f = feed({ retryMs: 120 });
  f.threads.connect(f.connection);
  await live(f, "t1", 3);
  await live(f, "t2", 5);
  f.connection.refuse("t1");
  await settle();
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0]!.message, /refused/);
  assert.deepEqual((f.logs[0]!.detail as { threadId: string }).threadId, "t1");
  assert.equal(f.threads.pushed("t1"), false, "its pages keep their own cadence");
  assert.equal(f.threads.pushed("t2"), true);
  const before = f.t3.count("t1");
  await f.threads.detail("t1", true);
  await f.threads.detail("t1", true);
  assert.equal(f.t3.count("t1"), before + 2, "read from T3 each time");
  const t2Reads = f.t3.count("t2");
  await f.threads.detail("t2", true);
  assert.equal(f.t3.count("t2"), t2Reads, "the other thread is still served from its stream");
  assert.deepEqual(f.threads.status(), { watched: 2, live: 1, refused: 1 });
  // Asked again after the wait: subscribed after its latest read; live once T3 has replayed.
  await sleep(150);
  const again = f.connection.of("t1");
  assert.equal(again.payload.afterSequence, 3);
  f.connection.send("t1", { kind: "synchronized" });
  await settle();
  assert.equal(f.threads.pushed("t1"), true);
  assert.deepEqual(f.threads.status(), { watched: 2, live: 2, refused: 0 });
  f.threads.close();
});

test("the feed going down has every thread read from T3 as before; its reconnect subscribes again after the latest read, and trusts the cache only once T3 has replayed", async () => {
  const f = feed({ throttleMs: 0 });
  f.threads.connect(f.connection);
  await live(f, "t1", 7);
  f.connection.drop();
  f.threads.connect(null);
  await settle();
  assert.equal(f.threads.pushed("t1"), false);
  assert.equal(f.logs.length, 0, "the socket going is no refusal");
  const before = f.t3.count("t1");
  f.t3.at.set("t1", 9);
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 9, "read from T3 while down");
  assert.equal(f.t3.count("t1"), before + 1);
  // Back: subscribed again after the latest read (9), no snapshot asked for.
  const next = new FakeConnection();
  f.threads.connect(next);
  await settle();
  assert.equal(next.of("t1").payload.afterSequence, 9);
  await f.threads.detail("t1", true);
  assert.equal(f.t3.count("t1"), before + 2, "not trusted before T3 has replayed what came since");
  // T3 replays one event it had missed, then the marker: that change is read once, and from then on the cache serves.
  f.t3.at.set("t1", 10);
  next.send("t1", { kind: "event", sequence: 10, event: {} }, { kind: "synchronized" });
  await settle();
  assert.equal(f.t3.count("t1"), before + 3);
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 10);
  assert.equal(f.t3.count("t1"), before + 3);
  assert.deepEqual(f.changes, ["t1"], "told once the replayed change is read");
  // A replay too long for T3 comes as a snapshot: its sequence counts as a change, read once.
  f.t3.at.set("t1", 40);
  next.send("t1", { kind: "snapshot", snapshotSequence: 40, projection: {} });
  await settle();
  assert.equal((await f.threads.detail("t1", true))?.snapshotSequence, 40);
  f.threads.close();
});

test("a thread with no read yet whose first read fails is still subscribed to (T3 then sends its snapshot); close interrupts every stream and arms nothing", async () => {
  let fail = true;
  const threads = new ThreadFeed({
    read: async () => {
      if (fail) throw new T3Unavailable("T3 returned HTTP 503");
      return { snapshotSequence: 2, projection: {} };
    },
    onChange: () => undefined,
  });
  const connection = new FakeConnection();
  threads.connect(connection);
  threads.lease("t1");
  await settle();
  assert.deepEqual(connection.of("t1").payload, { threadId: "t1", acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true });
  fail = false;
  threads.close();
  assert.deepEqual(connection.interrupted, [1]);
  assert.deepEqual(threads.status(), { watched: 0, live: 0, refused: 0 });
});
