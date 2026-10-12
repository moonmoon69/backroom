import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { T3Unavailable, type T3Project, type T3ThreadShell } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { PageChanges, type PageEvent } from "../src/app/changes.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { EngineStore } from "../src/engine/index.ts";
import { withFakeControls } from "../src/server/fakeControls.ts";
import { createHttpApp } from "../src/server/http.ts";

/** A service on the fake T3, through bootstrap, with GET /api/events quick to check. */
async function eventsStack(t: TestContext, changes: { shellMs?: number; headsMs?: number; heartbeatMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-page-events-"));
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, changes: { shellMs: 50, headsMs: 50, ...changes } });
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const { roomId } = (await run({ type: "room.create", projectId: "project_demo", title: "push" })) as { roomId: string };
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const serve = withFakeControls(app.fetch, fake);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stack.close();
  };
  t.after(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, fake, stack, roomId, run, app, serve, close };
}

interface Frame {
  event: string | null;
  data: unknown;
  comment: string | null;
  retry: number | null;
}

/** An open GET /api/events: its frames as they come. */
async function listen(t: TestContext, app: { request(path: string): Response | Promise<Response> }) {
  const response = await app.request("/api/events");
  const reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  // A read still waiting when a wait ends is kept for the next one, so no chunk is lost.
  let pending: ReturnType<typeof reader.read> | null = null;
  const pump = async (deadline: number) => {
    pending ??= reader.read();
    const chunk = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null) return;
    pending = null;
    if (chunk.done) {
      done = true;
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, "m").exec(block)?.[1] ?? null;
      const data = field("data");
      const retry = field("retry");
      frames.push({ event: field("event"), data: data === null ? null : JSON.parse(data), comment: /^:/m.test(block) ? block.replace(/^: ?/, "") : null, retry: retry === null ? null : Number(retry) });
    }
  };
  return {
    response,
    frames,
    get done() {
      return done;
    },
    /** Read until `until` holds of the frames seen since `from`, or the time is up; those frames. */
    async until(until: (frames: Frame[]) => boolean, ms = 2000, from = 0): Promise<Frame[]> {
      const deadline = Date.now() + ms;
      while (!until(frames.slice(from)) && !done && Date.now() < deadline) await pump(deadline);
      return frames.slice(from);
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

const events = (frames: Frame[]) => frames.filter((f) => f.event !== null);

test("GET /api/events is an event stream with a retry hint, and a hub.notify reaches it as rooms and room with its id", async (t) => {
  const s = await eventsStack(t);
  const page = await listen(t, s.app);
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(page.response.headers.get("cache-control"), "no-cache");
  const [hint] = await page.until((frames) => frames.length >= 1);
  assert.equal(hint!.retry, 3000, "the browser is told how soon to reconnect");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const from = page.frames.length;
  s.stack.hub.notify(s.roomId);
  const told = events(await page.until((frames) => events(frames).length >= 2, 1000, from));
  assert.deepEqual(
    told.map((f) => [f.event, f.data]),
    [
      ["rooms", {}],
      ["room", { roomId: s.roomId }],
    ],
  );
});

test("a command through the service (a room created) reaches every open page at once", async (t) => {
  const s = await eventsStack(t, { headsMs: 60_000 });
  const a = await listen(t, s.app);
  const b = await listen(t, s.app);
  await a.until((frames) => frames.length >= 1);
  await b.until((frames) => frames.length >= 1);
  const { roomId } = (await s.run({ type: "room.create", projectId: "project_demo", title: "second" })) as { roomId: string };
  for (const page of [a, b]) {
    const told = events(await page.until((frames) => events(frames).some((f) => f.event === "room" && (f.data as { roomId: string }).roomId === roomId), 1000));
    assert.ok(told.some((f) => f.event === "rooms"), "the room list");
    assert.ok(told.some((f) => f.event === "room" && (f.data as { roomId: string }).roomId === roomId), "the new room");
  }
});

test("an append nobody announced (straight to the journal, from another connection) reaches the page as room", async (t) => {
  const s = await eventsStack(t);
  const page = await listen(t, s.app);
  await page.until((frames) => frames.length >= 1);
  // Let the first comparison of the heads take place.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const from = page.frames.length;
  const other = new EngineStore(join(s.dir, "board.sqlite"));
  t.after(() => other.close());
  other.execute(s.roomId, { type: "post", actor: "$user", id: "direct-1", intent: "note", body: "another connection" });
  const told = events(await page.until((frames) => events(frames).some((f) => f.event === "room"), 2000, from));
  assert.deepEqual(told.find((f) => f.event === "room")?.data, { roomId: s.roomId });
});

test("an announced append is told once, not again when the heads are next compared", async (t) => {
  const s = await eventsStack(t);
  const page = await listen(t, s.app);
  await page.until((frames) => frames.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const from = page.frames.length;
  let announced = 0;
  const stop = s.stack.hub.subscribe(s.roomId, () => (announced += 1));
  t.after(stop);
  // Seating a member, through the service: the journal moves and the hub is told.
  const head = s.stack.engine.heads().get(s.roomId) ?? 0;
  await s.run({ type: "participant.create", roomId: s.roomId, alias: "worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } });
  assert.ok((s.stack.engine.heads().get(s.roomId) ?? 0) > head, "the journal moved");
  assert.ok(announced >= 1);
  // Several comparisons of the heads later.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.until(() => false, 50, from);
  const rooms = events(page.frames.slice(from)).filter((f) => f.event === "room");
  assert.equal(rooms.length, announced, `one room event per announcement (${announced}), none more from the heads`);
});

test("T3's threads changing becomes shell; nothing changing sends nothing", async (t) => {
  const s = await eventsStack(t);
  const page = await listen(t, s.app);
  await page.until((frames) => frames.length >= 1);
  // A few checks with T3 unchanged: no shell.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.until(() => false, 50);
  assert.deepEqual(events(page.frames).filter((f) => f.event === "shell"), [], "an unchanged shell is not told");
  const from = page.frames.length;
  await s.fake.launchThread({ commandId: "launch:x", threadId: "thread-x", projectId: "project_demo", title: "outside", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
  const told = events(await page.until((frames) => events(frames).some((f) => f.event === "shell"), 1000, from));
  assert.equal(told.filter((f) => f.event === "shell").length, 1, "one shell for one change");
  // A thread's title, on T3's side.
  const from2 = page.frames.length;
  s.fake.threads.get("thread-x")!.shell.title = "renamed in T3";
  const again = events(await page.until((frames) => events(frames).some((f) => f.event === "shell"), 1000, from2));
  assert.ok(again.some((f) => f.event === "shell"));
});

test("T3 stopping and starting to answer becomes status down then up, once each; a page opening while it is down is told at once", async (t) => {
  const s = await eventsStack(t);
  const page = await listen(t, s.app);
  await page.until((frames) => frames.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(events(page.frames).filter((f) => f.event === "status"), [], "T3 answering from the start is no news");
  // Through the fake's control, as the rehearsal does.
  const down = await s.serve(new Request("http://fake/api/fake/outage", { method: "POST", body: JSON.stringify({ down: true, message: "connect ECONNREFUSED" }) }));
  assert.deepEqual(await down.json(), { ok: true, down: true });
  let told = events(await page.until((frames) => events(frames).some((f) => f.event === "status"), 1000));
  const off = told.find((f) => f.event === "status")!.data as { up: boolean; error: string; at: string };
  assert.equal(off.up, false);
  assert.equal(off.error, "connect ECONNREFUSED");
  // A second page opening now is told T3 is down right away.
  const late = await listen(t, s.app);
  const lateFrames = await late.until((frames) => frames.some((f) => f.event === "status"), 500);
  assert.deepEqual((lateFrames.find((f) => f.event === "status")!.data as { up: boolean }).up, false);
  // Still down for several checks: told once.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.until(() => false, 50);
  assert.equal(events(page.frames).filter((f) => f.event === "status").length, 1, "down is told once");
  await s.serve(new Request("http://fake/api/fake/outage", { method: "POST", body: JSON.stringify({ down: false }) }));
  told = events(await page.until((frames) => events(frames).filter((f) => f.event === "status").length >= 2, 1000));
  const on = told.filter((f) => f.event === "status")[1]!.data as { up: boolean; error: string | null };
  assert.deepEqual([on.up, on.error], [true, null]);
});

test("a heartbeat comment keeps the stream open", async (t) => {
  const s = await eventsStack(t, { heartbeatMs: 60 });
  const page = await listen(t, s.app);
  const frames = await page.until((list) => list.filter((f) => f.comment?.startsWith("heartbeat")).length >= 2, 1000);
  assert.ok(frames.filter((f) => f.comment?.startsWith("heartbeat")).length >= 2);
  assert.ok(frames.every((f) => f.event === null || f.event === "status"), "a heartbeat is a comment, not an event the page acts on");
});

test("the watches run only while a page listens: a page going away stops them, and the service shutting down ends every stream", async (t) => {
  const s = await eventsStack(t);
  let reads = 0;
  const list = s.fake.listProjects.bind(s.fake);
  s.fake.listProjects = async () => {
    reads += 1;
    return list();
  };
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reads, 0, "no page, no reads of T3");
  const a = await listen(t, s.app);
  await a.until((frames) => frames.length >= 1);
  assert.equal(s.stack.changes.listening, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(reads >= 2, `checked while a page listens (${reads})`);
  await a.close();
  // The abort reaches the route on its next write at the latest.
  for (let i = 0; i < 20 && s.stack.changes.listening > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.stack.changes.listening, 0, "the page that went away no longer listens");
  const stopped = reads;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(reads <= stopped + 1, "no more checks once no page listens");
  const b = await listen(t, s.app);
  await b.until((frames) => frames.length >= 1);
  s.close();
  await b.until(() => false, 1000);
  assert.ok(b.done, "the stream ends when the service shuts down");
});

test("checks of T3 never overlap: one held up by T3 is shared, and the next waits for it", async () => {
  let reads = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = {
    listProjects: async (): Promise<T3Project[]> => {
      reads += 1;
      await held;
      return [];
    },
    listThreads: async (): Promise<T3ThreadShell[]> => [],
  };
  const changes = new PageChanges(adapter, { shellMs: 10 });
  const seen: PageEvent[] = [];
  const stop = changes.subscribe((event) => seen.push(event));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reads, 1, "one read while T3 holds it, however many checks came due");
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(reads > 1, "the checks go on once it answers");
  stop();
  changes.close();
});

test("a check that fails then succeeds is status down then up; recovery with a changed shell is told as both", async () => {
  let fail: Error | null = new T3Unavailable("T3 did not answer within 30s");
  let threads: T3ThreadShell[] = [];
  const adapter = {
    listProjects: async (): Promise<T3Project[]> => {
      if (fail) throw fail;
      return [];
    },
    listThreads: async () => threads,
  };
  const changes = new PageChanges(adapter, { shellMs: 60_000 });
  const seen: PageEvent[] = [];
  const stop = changes.subscribe((event) => seen.push(event));
  await changes.check();
  assert.deepEqual(seen.map((e) => (e.type === "status" ? [e.type, e.status.up, e.status.error] : [e.type])), [["status", false, "T3 did not answer within 30s"]]);
  await changes.check();
  assert.equal(seen.length, 1, "down once");
  fail = null;
  await changes.check();
  assert.deepEqual(seen.slice(1).map((e) => (e.type === "status" ? [e.type, e.status.up] : [e.type])), [["status", true]]);
  threads = [{ id: "t" } as T3ThreadShell];
  await changes.check();
  assert.deepEqual(seen.slice(2).map((e) => e.type), ["shell"]);
  stop();
  changes.close();
});

test("with no page listening, a room's change reads nothing of the journal", async () => {
  let reads = 0;
  const changes = new PageChanges({ listProjects: async () => [], listThreads: async () => [] }, { shellMs: 60_000, headsMs: 60_000, heads: () => {
    reads += 1;
    return new Map([["room", 1]]);
  } });
  const stop = changes.subscribe(() => undefined);
  stop();
  const before = reads;
  for (let i = 0; i < 5; i += 1) changes.roomChanged("room");
  assert.equal(reads, before, "no heads read for nobody");
  changes.close();
});
