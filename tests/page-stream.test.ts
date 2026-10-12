import assert from "node:assert/strict";
import { test } from "node:test";
import { COALESCE_MS, EVENTS_URL, Latest, PageStream, afterRoomGone, shownSnapshot, REOPEN_MS, type EventSourceLike, type PageStreamHandlers, type T3Reach } from "../web/src/pageStream.ts";

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
