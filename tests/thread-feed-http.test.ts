/**
 * The thread streams through the HTTP adapter, on a T3 socket of the test's own that speaks the wire as T3 does:
 * several subscribeThread requests on the shell feed's one socket, each chunk acknowledged on its own request id,
 * Interrupt when a watch ends; thread reads over HTTP counted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpT3Adapter } from "../src/adapter/http.ts";

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENVIRONMENT = { environmentId: "env", label: "box", serverVersion: "0.0.46-nightly.20261012.3021", orchestrationProtocolVersion: 2 };
const row = (id: string) => ({
  id, projectId: "proj", title: id, providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default",
  branch: null, worktreePath: null, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, activeRunId: null, latestRunId: null, status: "idle",
  lastError: null, pendingRuntimeRequest: null, latestUserMessageAt: null, pendingBackgroundTasks: [], createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
  archivedAt: null, settledAt: null, deletedAt: null,
});
const project = { id: "proj", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: null, scripts: [], createdAt: "2026-10-13T00:00:00.000Z" };
const SHELL = "orchestration.subscribeShell";
const THREAD = "orchestration.subscribeThread";

/** T3: its shell stream, a thread stream per subscription (synchronized at once), and its thread reads over HTTP. */
function t3() {
  type Subscription = { id: string; tag: string; payload: any; queue: unknown[][]; awaitingAck: boolean; ended: boolean };
  const sockets: Socket[] = [];
  const sequences = new Map<string, number>([["thread-1", 10], ["thread-2", 20]]);
  const gets: string[] = [];
  class Socket {
    readonly sent: any[] = [];
    readonly subscriptions: Subscription[] = [];
    closed = false;
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    message(value: unknown): void {
      queueMicrotask(() => {
        if (!this.closed) this.emit("message", { data: JSON.stringify(value) });
      });
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      const subscription = this.subscriptions.find((s) => s.id === frame.requestId);
      if (frame._tag === "Ping") this.message({ _tag: "Pong" });
      else if (frame._tag === "Ack" && subscription) {
        subscription.awaitingAck = false;
        this.flush(subscription);
      } else if (frame._tag === "Interrupt" && subscription && !subscription.ended) {
        subscription.ended = true;
        this.message({ _tag: "Exit", requestId: frame.requestId, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] } });
      } else if (frame._tag === "Request") {
        const initial =
          frame.tag === SHELL ? [[{ kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 30, projects: [project], threads: [row("thread-1"), row("thread-2"), row("thread-3")], archivedThreads: [] } }]]
          : frame.tag === THREAD ? [[{ kind: "synchronized" }]]
          : null;
        if (!initial) {
          queueMicrotask(() => this.message({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: frame.tag === "orchestration.dispatchCommand" ? { sequence: 50 } : null } }));
          return;
        }
        const created = { id: frame.id, tag: frame.tag, payload: frame.payload, queue: initial, awaitingAck: false, ended: false };
        this.subscriptions.push(created);
        this.flush(created);
      }
    }
    private flush(subscription: Subscription): void {
      if (subscription.awaitingAck || subscription.ended || subscription.queue.length === 0) return;
      subscription.awaitingAck = true;
      this.message({ _tag: "Chunk", requestId: subscription.id, values: subscription.queue.shift() });
    }
    thread(threadId: string): Subscription {
      const found = this.subscriptions.find((s) => s.tag === THREAD && s.payload.threadId === threadId && !s.ended);
      assert.ok(found, `a stream of ${threadId}`);
      return found;
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", {});
    }
  }
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/.well-known/t3/environment") return Response.json(ENVIRONMENT);
    if (path === "/api/auth/websocket-ticket") return Response.json({ ticket: "tk" });
    if (path === "/api/orchestration/shell") return Response.json({ schemaVersion: 2, snapshotSequence: 30, projects: [project], threads: [row("thread-1"), row("thread-2"), row("thread-3")], archivedThreads: [] });
    const match = /^\/api\/orchestration\/threads\/([^/]+)(\/bounded)?$/.exec(path);
    if (match) {
      const threadId = decodeURIComponent(match[1]!);
      gets.push(`${threadId}${match[2] ?? ""}`);
      const sequence = sequences.get(threadId);
      if (sequence === undefined) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ snapshotSequence: sequence, projection: { thread: row(threadId), runs: [], messages: [], turnItems: [], runtimeRequests: [], providerThreads: [], nodes: [] } });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }) as typeof fetch;
  const feedSocket = () => [...sockets].reverse().find((s) => s.subscriptions.some((sub) => sub.tag === SHELL))!;
  return { Socket, sockets, feedSocket, fetchImpl, sequences, gets, count: (path: string) => gets.filter((g) => g === path).length };
}

function adapter(fake: ReturnType<typeof t3>, threads: { throttleMs?: number; leaseMs?: number; lingerMs?: number } = {}) {
  return new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl: fake.fetchImpl, webSocketImpl: fake.Socket as never, requestTimeoutMs: 2_000, feed: { pingMs: 60_000, retryMs: 10, retryMaxMs: 40 }, threads: { throttleMs: 0, ...threads } });
}

test("watched threads are streamed on the shell feed's one socket, a request each; each chunk is acknowledged on its own request; an unwatched one is never streamed", async (t) => {
  const fake = t3();
  const http = adapter(fake);
  t.after(() => http.close());
  const told: string[] = [];
  http.onThreadChange((threadId) => told.push(threadId));
  http.startFeed();
  await settle();
  http.holdThreads("engine", ["thread-1"]);
  http.leaseThread("thread-2");
  await settle();
  const socket = fake.feedSocket();
  assert.equal(fake.sockets.filter((s) => s.subscriptions.length > 0).length, 1, "one socket for the shell and the threads");
  const [one, two] = [socket.thread("thread-1"), socket.thread("thread-2")];
  assert.notEqual(one.id, two.id);
  assert.deepEqual([one.payload, two.payload], [
    { threadId: "thread-1", afterSequence: 10, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true },
    { threadId: "thread-2", afterSequence: 20, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true },
  ]);
  assert.deepEqual([fake.count("thread-1/bounded"), fake.count("thread-2/bounded")], [1, 1], "each read once, before its stream");
  // Unchanged: every caller is served from that read.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await http.getThreadDetail("thread-1", { bounded: true }))?.shell.id, "thread-1");
    await http.getThreadDetail("thread-2", { bounded: true });
  }
  assert.deepEqual([fake.count("thread-1/bounded"), fake.count("thread-2/bounded")], [1, 1]);
  // The overview's describing read of a thread nobody watches: read, and not streamed.
  await http.getThreadDetail("thread-3", { bounded: true });
  await http.getThreadDetail("thread-3", { bounded: true });
  assert.equal(fake.count("thread-3/bounded"), 2);
  assert.ok(!socket.subscriptions.some((s) => s.tag === THREAD && s.payload.threadId === "thread-3"));

  // Both threads change after the shell's snapshot (at 30), their chunks in one message: each reaches its own thread,
  // each acknowledged on its own id.
  fake.sequences.set("thread-1", 31);
  fake.sequences.set("thread-2", 32);
  const acks = (id: string) => socket.sent.filter((f) => f._tag === "Ack" && f.requestId === id).length;
  const [ackOne, ackTwo] = [acks(one.id), acks(two.id)];
  socket.message([
    { _tag: "Chunk", requestId: one.id, values: [{ kind: "event", sequence: 31, event: { type: "thread.turn-item-recorded" } }] },
    { _tag: "Chunk", requestId: two.id, values: [{ kind: "event", sequence: 32, event: { type: "thread.message-sent" } }] },
  ]);
  await settle();
  assert.deepEqual([acks(one.id) - ackOne, acks(two.id) - ackTwo], [1, 1]);
  assert.deepEqual([fake.count("thread-1/bounded"), fake.count("thread-2/bounded")], [2, 2], "each change read once");
  assert.deepEqual(told.sort(), ["thread-1", "thread-2"]);
  assert.deepEqual(http.threadStreams(), { watched: 2, live: 2, refused: 0 });
  assert.deepEqual([http.threadPushed("thread-1"), http.threadPushed("thread-3")], [true, false]);
});

test("a watch that ends interrupts its own stream only; a command has the thread read afresh; the feed's drop has threads read from T3, its reconnect streams them again after their latest read", async (t) => {
  const fake = t3();
  const http = adapter(fake, { lingerMs: 30 });
  t.after(() => http.close());
  http.startFeed();
  await settle();
  http.holdThreads("engine", ["thread-1", "thread-2"]);
  await settle();
  const socket = fake.feedSocket();
  const [one, two] = [socket.thread("thread-1"), socket.thread("thread-2")];
  // thread-1's seat retires: its stream is interrupted after the linger, thread-2's goes on.
  http.holdThreads("engine", ["thread-2"]);
  await sleep(60);
  await settle();
  assert.deepEqual(socket.sent.filter((f) => f._tag === "Interrupt").map((f) => f.requestId), [one.id]);
  assert.equal(two.ended, false);

  // A command on thread-2: the next read is made afresh, not served from its cached read.
  const before = fake.count("thread-2/bounded");
  await http.setThreadTitle({ commandId: "c1", threadId: "thread-2", title: "renamed" });
  fake.sequences.set("thread-2", 50);
  await http.getThreadDetail("thread-2", { bounded: true });
  assert.equal(fake.count("thread-2/bounded"), before + 1);
  await http.getThreadDetail("thread-2", { bounded: true });
  assert.equal(fake.count("thread-2/bounded"), before + 1, "then served from that read");

  // The feed's socket goes: thread-2 is read from T3 on each call until it is streamed again.
  socket.close();
  await settle();
  assert.equal(http.threadPushed("thread-2"), false);
  await http.getThreadDetail("thread-2", { bounded: true });
  await http.getThreadDetail("thread-2", { bounded: true });
  assert.equal(fake.count("thread-2/bounded"), before + 3);
  await sleep(50);
  await settle();
  const again = fake.feedSocket();
  assert.notEqual(again, socket);
  assert.equal(again.thread("thread-2").payload.afterSequence, 50, "after its latest read: no snapshot");
  assert.ok(!again.subscriptions.some((s) => s.tag === THREAD && s.payload.threadId === "thread-1"), "only what is still watched");
  await http.getThreadDetail("thread-2", { bounded: true });
  assert.equal(fake.count("thread-2/bounded"), before + 3, "streamed and synchronized again: served from the cache");
});

test("a thread stream T3 refuses is that thread's fallback only: the feed stays connected and T3 up, and the refusal is logged", async (t) => {
  const fake = t3();
  const logs: Array<{ message: string; detail: unknown }> = [];
  const http = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl: fake.fetchImpl, webSocketImpl: fake.Socket as never, requestTimeoutMs: 2_000, feed: { pingMs: 60_000 }, threads: { throttleMs: 0, retryMs: 60_000 }, log: (message, detail) => logs.push({ message, detail }) });
  t.after(() => http.close());
  http.startFeed();
  await settle();
  http.holdThreads("engine", ["thread-1", "thread-2"]);
  await settle();
  const socket = fake.feedSocket();
  const one = socket.thread("thread-1");
  one.ended = true;
  socket.message({ _tag: "Exit", requestId: one.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2GetThreadProjectionError", message: "Failed to load orchestration V2 thread thread-1" } }] } });
  await settle();
  assert.equal(http.feed().state, "connected", "T3 is not down");
  assert.deepEqual(http.threadStreams(), { watched: 2, live: 1, refused: 1 });
  assert.equal(http.threadPushed("thread-1"), false);
  assert.equal(http.threadPushed("thread-2"), true);
  assert.ok(logs.some((l) => /refused/.test(l.message) && (l.detail as { threadId: string }).threadId === "thread-1" && /Failed to load/.test((l.detail as { error: string }).error)));
  const before = fake.count("thread-1/bounded");
  await http.getThreadDetail("thread-1", { bounded: true });
  await http.getThreadDetail("thread-1", { bounded: true });
  assert.equal(fake.count("thread-1/bounded"), before + 2, "read from T3 each time, as before");
});

test("review #1: a change the shell stream shows (the run ended) is in the detail read beside it, though the thread stream's own read of it waits for the throttle", async (t) => {
  const fake = t3();
  const http = adapter(fake, { throttleMs: 60_000 });
  t.after(() => http.close());
  http.startFeed();
  await settle();
  http.holdThreads("engine", ["thread-1"]);
  await settle();
  await http.getThreadDetail("thread-1", { bounded: true });
  assert.equal(fake.count("thread-1/bounded"), 1, "read once, before its stream");
  const socket = fake.feedSocket();
  const shell = socket.subscriptions.find((s) => s.tag === SHELL)!;
  // The turn ends at 40: T3's shell stream says so, and its thread stream; the thread's read is owed, throttled.
  fake.sequences.set("thread-1", 40);
  socket.message({ _tag: "Chunk", requestId: shell.id, values: [{ kind: "thread.updated", sequence: 40, location: "active", thread: { ...row("thread-1"), status: "completed", latestRunId: "run-1", latestRunCompletedAt: "2026-10-13T00:01:00.000Z", updatedAt: "2026-10-13T00:01:00.000Z" } }] });
  socket.message({ _tag: "Chunk", requestId: socket.thread("thread-1").id, values: [{ kind: "event", sequence: 40, event: { type: "run.completed" } }] });
  await settle();
  assert.equal((await http.getThreadShell("thread-1"))?.status, "completed", "the shell says the run ended");
  assert.equal(fake.count("thread-1/bounded"), 1, "the thread's own read waits for the throttle");
  await http.getThreadDetail("thread-1", { bounded: true });
  assert.equal(fake.count("thread-1/bounded"), 2, "the detail read beside that shell is read again, not served from before the end");
  await http.getThreadDetail("thread-1", { bounded: true });
  assert.equal(fake.count("thread-1/bounded"), 2, "and then served from that read");
  // A change of its time alone (each item of a running turn) moves no floor.
  socket.message({ _tag: "Chunk", requestId: shell.id, values: [{ kind: "thread.updated", sequence: 41, location: "active", thread: { ...row("thread-1"), status: "completed", latestRunId: "run-1", latestRunCompletedAt: "2026-10-13T00:01:00.000Z", updatedAt: "2026-10-13T00:01:05.000Z" } }] });
  await settle();
  await http.getThreadDetail("thread-1", { bounded: true });
  assert.equal(fake.count("thread-1/bounded"), 2);
});
