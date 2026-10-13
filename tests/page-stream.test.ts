import assert from "node:assert/strict";
import { test } from "node:test";
import { COALESCE_MS, DetailLoader, EVENTS_URL, FALLBACK_MS, Latest, PagePush, PageStream, afterRoomGone, shownSnapshot, REOPEN_MS, type EventSourceLike, type PageStreamHandlers, type T3Reach } from "../web/src/pageStream.ts";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** The connection dropped: the browser retries it itself (CONNECTING), or gives up (CLOSED, after an HTTP error). */
  fail(gaveUp = false): void {
    this.readyState = gaveUp ? 2 : 0;
    this.onerror?.({});
  }
  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

/** A page with a fake clock, fake EventSources and a visibility it sets. */
function page() {
  const sources: FakeSource[] = [];
  const calls: string[] = [];
  let now = 0;
  let timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 0;
  let hidden = false;
  let visibility: (() => void) | null = null;
  const handlers: PageStreamHandlers = {
    all: () => calls.push("all"),
    rooms: () => calls.push("rooms"),
    room: (roomId) => calls.push(`room:${roomId}`),
    shell: () => calls.push("shell"),
    thread: (threadId) => calls.push(`thread:${threadId}`),
    status: (reach: T3Reach) => calls.push(`status:${reach.up ? "up" : `down:${reach.error}`}`),
    open: (open) => calls.push(open ? "open" : "closed"),
  };
  const stream = new PageStream(handlers, {
    connect: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    hidden: () => hidden,
    onVisibility: (listener) => {
      visibility = listener;
      return () => {
        visibility = null;
      };
    },
    setTimeout: (callback, ms) => {
      const id = ++nextId;
      timers.push({ at: now + ms, callback, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  return {
    stream,
    sources,
    calls,
    get source() {
      return sources[sources.length - 1]!;
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        due.callback();
      }
    },
    setHidden(value: boolean) {
      hidden = value;
      visibility?.();
    },
    take() {
      return calls.splice(0);
    },
  };
}

test("the page opens one stream, and reads everything at its every open: the first and each reconnect", () => {
  const p = page();
  p.stream.start();
  assert.equal(p.sources.length, 1);
  assert.equal(p.source.url, EVENTS_URL);
  p.source.open();
  assert.deepEqual(p.take(), ["open", "all"]);
  // The connection drops (iOS put the PWA in the background); the browser retries it itself.
  p.source.fail();
  assert.deepEqual(p.take(), ["closed"], "the timers go back to their own pace");
  p.advance(REOPEN_MS * 2);
  assert.equal(p.sources.length, 1, "a dropped connection is the browser's to retry");
  p.source.open();
  assert.deepEqual(p.take(), ["open", "all"], "what changed while it was down is read");
  p.stream.stop();
  assert.ok(p.source.closed);
  assert.deepEqual(p.take(), ["closed"]);
});

test("a stream the browser gave up on (an HTTP error) is opened again: after a while in view, at once on coming back into view", () => {
  const p = page();
  p.stream.start();
  p.source.open();
  p.take();
  p.source.fail(true);
  assert.deepEqual(p.take(), ["closed"]);
  p.advance(REOPEN_MS - 1);
  assert.equal(p.sources.length, 1);
  p.advance(1);
  assert.equal(p.sources.length, 2, "opened again");
  p.source.open();
  assert.deepEqual(p.take(), ["open", "all"]);
  // Given up while out of sight: nothing until the page is looked at again, then at once.
  p.setHidden(true);
  p.source.fail(true);
  p.advance(REOPEN_MS * 3);
  assert.equal(p.sources.length, 2, "not reopened in the background");
  p.take();
  p.setHidden(false);
  assert.equal(p.sources.length, 3, "reopened on coming back");
  assert.deepEqual(p.take(), ["all"], "and everything read again");
  p.stream.stop();
});

test("coming back into view reads everything again, even with the stream still open; going out of view reads nothing", () => {
  const p = page();
  p.stream.start();
  p.source.open();
  p.take();
  p.setHidden(true);
  assert.deepEqual(p.take(), []);
  p.setHidden(false);
  assert.deepEqual(p.take(), ["all"]);
  assert.equal(p.sources.length, 1, "an open stream is kept");
  p.stream.stop();
  p.setHidden(false);
  assert.deepEqual(p.take(), ["closed"], "a stopped stream does nothing more");
});

test("each event reads again what it names, once per burst; room events of different rooms are kept apart", () => {
  const p = page();
  p.stream.start();
  p.source.open();
  p.take();
  p.source.emit("rooms");
  p.source.emit("room", { roomId: "a" });
  p.source.emit("rooms");
  p.source.emit("room", { roomId: "b" });
  p.source.emit("room", { roomId: "a" });
  p.source.emit("shell");
  p.source.emit("shell");
  assert.deepEqual(p.take(), [], "not read before the burst has had its moment");
  p.advance(COALESCE_MS);
  assert.deepEqual(p.take().sort(), ["room:a", "room:b", "rooms", "shell"]);
  // A steady stream of events still reads every COALESCE_MS, not only when they stop.
  for (let i = 0; i < 6; i += 1) {
    p.source.emit("shell");
    p.advance(COALESCE_MS / 2);
  }
  assert.ok(p.take().filter((c) => c === "shell").length >= 2);
  p.stream.stop();
});

test("status is handed on at once, with T3's error", () => {
  const p = page();
  p.stream.start();
  p.source.open();
  p.take();
  p.source.emit("status", { up: false, error: "connect ECONNREFUSED", at: "2026-10-13T05:44:07Z" });
  p.source.emit("status", { up: true, error: null, at: "2026-10-13T05:44:47Z" });
  p.source.emit("status", { nonsense: true });
  assert.deepEqual(p.take(), ["status:down:connect ECONNREFUSED", "status:up"]);
  p.stream.stop();
});

test("Latest: an answer older than one already applied is dropped, success or failure", () => {
  const order = new Latest();
  // The 05:44 restart: a read hangs on T3 for 30 s; a newer one succeeds; then the old one fails.
  const hung = order.start();
  const newer = order.start();
  assert.equal(order.take(newer), true, "the newer success is applied");
  assert.equal(order.take(hung), false, "the hung read's failure cannot put the banner back");
  // In order, each is applied.
  const a = order.start();
  assert.equal(order.take(a), true);
  const b = order.start();
  assert.equal(order.take(b), true);
  // An older answer arriving first is still applied (nothing newer yet), then the newer.
  const c = order.start();
  const d = order.start();
  assert.equal(order.take(c), true);
  assert.equal(order.take(d), true);
});

test("Latest: a pushed status supersedes every read in flight; the next read after it applies", () => {
  const order = new Latest();
  const inFlight = order.start();
  order.supersede();
  assert.equal(order.take(inFlight), false, "a read started before T3 went down cannot clear the banner");
  const next = order.start();
  assert.equal(order.take(next), true, "the next read clears it");
});

test("a late answer for the room left never shows over the room open now, and its 404 does not close it", () => {
  const order = new Latest();
  const a = { room: { id: "a" } };
  // Room A's read is slow; B is opened and read.
  const forA = order.start();
  const forB = order.start();
  // A answers first: applied as the latest read, but it is not the selected room's, so nothing of it shows.
  assert.equal(order.take(forA), true);
  assert.equal(shownSnapshot(a, "b"), null, "A's snapshot is not shown in B");
  assert.equal(order.take(forB), true);
  assert.deepEqual(shownSnapshot({ room: { id: "b" } }, "b"), { room: { id: "b" } });
  // A was deleted meanwhile and answers 404 late: B stays open; A open is closed.
  assert.deepEqual(afterRoomGone({ kind: "room", id: "b" }, "a"), { kind: "room", id: "b" });
  assert.deepEqual(afterRoomGone({ kind: "thread", id: "a" }, "a"), { kind: "thread", id: "a" }, "a thread with the same id is not a room");
  assert.equal(afterRoomGone({ kind: "room", id: "a" }, "a"), null);
  assert.equal(afterRoomGone(null, "a"), null);
});

test("the T3 banner is the service's word: shown while it says T3 is down, and only then; a list read words it but never clears it", async () => {
  const { feedOut, t3Banner } = await import("../web/src/t3Connection.ts");
  const t3 = (error: string | null, feed: "connected" | "connecting" | "down" = "connected") => ({
    baseUrl: "http://127.0.0.1:3773",
    paired: true,
    pairedAt: null,
    tokenExpiresAt: null,
    environment: null,
    auth: null,
    error,
    errorAt: error ? "2026-10-13T00:00:00.000Z" : null,
    feed: { state: feed, since: "2026-10-13T00:00:00.000Z", error: feed === "connected" ? null : error },
  });
  assert.equal(t3Banner(t3(null), null, true), null, "T3 answers: none");
  assert.equal(t3Banner(t3(null), "fetch failed", false), null, "the service says T3 answers: a list read that failed raises none");
  assert.equal(t3Banner(null, "fetch failed", false), null, "no word from the service yet: none");
  // The feed down, T3's lists read the slow way during the outage: the short line, with the feed's error.
  assert.deepEqual(t3Banner(t3("T3 closed the connection", "down"), null, true), { kind: "feed", error: "T3 closed the connection" });
  assert.deepEqual(t3Banner(t3("Backroom is connecting to T3", "connecting"), null, true), { kind: "feed", error: "Backroom is connecting to T3" });
  // The feed down, no list read since the outage began (or one held up by T3): not answering, until one succeeds.
  assert.deepEqual(t3Banner(t3("T3 closed the connection", "down"), null, false), { kind: "down", error: "T3 closed the connection" });
  // The lists failed too: T3 is not answering, with their error.
  assert.deepEqual(t3Banner(t3("T3 closed the connection", "down"), "cannot reach T3", true), { kind: "down", error: "cannot reach T3" });
  // The fake T3 (its feed always connected, its outages seen by the pages' check): not answering, and no lists read.
  assert.deepEqual(t3Banner(t3("T3 did not answer within 30s"), null, true), { kind: "down", error: "T3 did not answer within 30s" });
  assert.deepEqual([feedOut(t3("T3 did not answer within 30s")), feedOut(t3("T3 closed the connection", "down")), feedOut(t3(null, "down")), feedOut(null)], [false, true, false, false]);
});

test("a thread event reads again the thread it names, once per burst, each thread apart", () => {
  const p = page();
  p.stream.start();
  p.source.open();
  p.take();
  p.source.emit("thread", { threadId: "t1" });
  p.source.emit("thread", { threadId: "t2" });
  p.source.emit("thread", { threadId: "t1" });
  p.source.emit("thread", { nonsense: true });
  assert.deepEqual(p.take(), []);
  p.advance(COALESCE_MS);
  assert.deepEqual(p.take().sort(), ["thread:t1", "thread:t2"]);
  p.stream.stop();
});

/** A clock of the test's own, for a loader's timers. */
function clock() {
  let now = 0;
  let nextId = 0;
  let timers: Array<{ at: number; callback: () => void; id: number }> = [];
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = ++nextId;
        timers.push({ at: now + ms, callback, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        timers = timers.filter((t) => t.id !== id);
      },
    },
    /** When the next timer is due, from now; null with none. */
    next: () => (timers.length === 0 ? null : Math.min(...timers.map((t) => t.at)) - now),
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        due.callback();
      }
    },
  };
}

/** Reads the test answers by hand, in any order. */
function reads<T>() {
  const pending: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  return {
    pending,
    read: () => new Promise<T>((resolve, reject) => pending.push({ resolve, reject })),
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("DetailLoader: one read at a time; asked during a read it reads once more after it, so an event during a read is never answered by that read", async () => {
  const c = clock();
  const r = reads<{ n: number }>();
  const applied: number[] = [];
  const loader = new DetailLoader<{ n: number }>({ read: r.read, apply: (value) => applied.push(value.n), fail: () => undefined, delay: () => 5000 }, c.timers);
  loader.start();
  assert.equal(r.pending.length, 1);
  loader.now();
  loader.now();
  assert.equal(r.pending.length, 1, "not a second read while one is out");
  r.pending[0]!.resolve({ n: 1 });
  await flush();
  assert.deepEqual(applied, [1]);
  assert.equal(r.pending.length, 2, "one more after it, for the events that came during it");
  r.pending[1]!.resolve({ n: 2 });
  await flush();
  assert.deepEqual(applied, [1, 2]);
  assert.equal(r.pending.length, 2);
  assert.equal(c.next(), 5000, "then the timer, as the answer asks");
  c.advance(5000);
  assert.equal(r.pending.length, 3);
  loader.stop();
});

test("DetailLoader: stopped (the page went to another thread, member or room), it applies nothing more, not even the answer in flight", async () => {
  const c = clock();
  const r = reads<{ n: number }>();
  const applied: number[] = [];
  const loader = new DetailLoader<{ n: number }>({ read: r.read, apply: (value) => applied.push(value.n), fail: () => undefined, delay: () => 1500 }, c.timers);
  loader.start();
  loader.stop();
  r.pending[0]!.resolve({ n: 1 });
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(c.next(), null, "and arms nothing");
  loader.now();
  assert.equal(r.pending.length, 1);
});

test("DetailLoader: while the stream is open and the thread pushed, its timer is the 60 s fallback; the stream closing puts it back on its own cadence at once; a failure that stops it stops it", async () => {
  const c = clock();
  const push = new PagePush();
  const r = reads<{ pushed: boolean }>();
  const loader = new DetailLoader<{ pushed: boolean }>(
    { read: r.read, apply: () => undefined, fail: (error) => ((error as Error).message === "gone" ? "stop" : undefined), delay: (value) => (push.open && value?.pushed ? FALLBACK_MS : 1500) },
    c.timers,
  );
  const unfollow = push.subscribe({ open: () => loader.reschedule(), all: () => loader.now() });
  push.setOpen(true);
  loader.start();
  r.pending[0]!.resolve({ pushed: true });
  await flush();
  assert.equal(c.next(), FALLBACK_MS, "pushed: the timer only backs the events up");
  c.advance(10_000);
  assert.equal(r.pending.length, 1, "no read due");
  push.setOpen(false);
  assert.equal(c.next(), 1500, "the stream closed: its own cadence, from now");
  c.advance(1500);
  assert.equal(r.pending.length, 2);
  r.pending[1]!.resolve({ pushed: false });
  await flush();
  push.setOpen(true);
  assert.equal(c.next(), 1500, "not pushed (T3 refused its stream): its own cadence even with the stream open");
  push.all();
  assert.equal(r.pending.length, 3, "a re-read of everything reads it now");
  r.pending[2]!.reject(new Error("gone"));
  await flush();
  assert.equal(c.next(), null, "stopped by its failure");
  unfollow();
});

test("PagePush: its listeners hear thread events, re-reads and the stream's state, until they leave", () => {
  const push = new PagePush();
  const heard: string[] = [];
  const leave = push.subscribe({ thread: (id) => heard.push(`thread:${id}`), all: () => heard.push("all"), open: (open) => heard.push(open ? "open" : "closed") });
  push.setOpen(true);
  push.setOpen(true);
  push.thread("t1");
  push.all();
  push.setOpen(false);
  leave();
  push.thread("t2");
  assert.deepEqual(heard, ["open", "thread:t1", "all", "closed"]);
  assert.equal(push.open, false);
});
