/**
 * Adapter contract tests against a mocked transport (HTTP reads, the WebSocket RPC for commands): request shapes,
 * auth handling, protocol negotiation and response mapping, in the shapes T3's Orchestrator V2 serves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { exchangePairingCredential, parsePairingUrl } from "../src/adapter/auth.ts";
import { T3CommandRejected, T3OutcomeUnknown, T3ProtocolMismatch, T3Unavailable, openRequests, runForMessage } from "../src/adapter/types.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function mockFetch(routes: Record<string, (recorded: Recorded) => { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const recorded: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null,
    };
    calls.push(recorded);
    const path = new URL(url).pathname;
    const key = `${recorded.method} ${path}`;
    const handler = routes[key] ?? routes[`${recorded.method} *`];
    if (!handler) return new Response("not found", { status: 404 });
    const result = handler(recorded);
    return new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * An RPC socket that answers each request frame from a handler, as T3's WebSocket RPC does (Effect RPC, JSON frames).
 * A handler that returns a promise answers when it settles; `closed` counts the sockets closed.
 */
function mockSocket(handlers: Record<string, (payload: any) => unknown> = {}) {
  const frames: Array<{ tag: string; payload: any; url: string }> = [];
  const sockets = { opened: 0, closed: 0 };
  class Socket {
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      sockets.opened += 1;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(data: string): void {
      const frame = JSON.parse(data) as { id: string; tag: string; payload: unknown };
      frames.push({ tag: frame.tag, payload: frame.payload, url: this.url });
      const answer = (exit: unknown) => this.emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }) });
      const failure = (error: unknown) => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: (error as Error).message } }] });
      queueMicrotask(() => {
        let value: unknown;
        try {
          value = handlers[frame.tag]?.(frame.payload) ?? null;
        } catch (error) {
          answer(failure(error));
          return;
        }
        if (value instanceof Promise) value.then((late) => answer({ _tag: "Success", value: late ?? null }), (error) => answer(failure(error)));
        else answer({ _tag: "Success", value });
      });
    }
    close(): void {
      sockets.closed += 1;
      this.emit("close", {});
    }
  }
  return { Socket, frames, sockets };
}

const ENVIRONMENT = { environmentId: "env", label: "box", serverVersion: "0.0.46-nightly.20261003.2610", orchestrationProtocolVersion: 2 };
const base = {
  "GET /.well-known/t3/environment": () => ({ status: 200, body: ENVIRONMENT }),
  "POST /api/auth/websocket-ticket": () => ({ status: 200, body: { ticket: "tk" } }),
};

const RUN = "run:thread:thread-1:ordinal:1";
const threadShell = {
  createdBy: "user", creationSource: "web", id: "thread-1", projectId: "proj", title: "t", providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" }, forkedFrom: null, activeProviderThreadId: null,
  // T3's shell status is the latest run's: a message queued behind the running run makes it "queued".
  latestRunId: "run:thread:thread-1:ordinal:2", activeRunId: RUN, activityRunStatus: "running", status: "queued", lastError: null,
  pendingRuntimeRequest: { id: "req-2", kind: "user_input", createdAt: "2026-10-03T00:00:02.000Z" }, latestVisibleMessage: null, latestUserMessageAt: "2026-10-03T00:00:00.000Z",
  hasActionableProposedPlan: false, pendingBackgroundTasks: [], itemCount: 3, visibleItemCount: 3, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:02.000Z",
  archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null,
};
const shell = {
  schemaVersion: 2,
  snapshotSequence: 10,
  projects: [{ id: "proj", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: { instanceId: "codex", model: "gpt-6-sol" }, scripts: [] }],
  threads: [threadShell],
  archivedThreads: [{ ...threadShell, id: "thread-old", archivedAt: "2026-10-01T00:00:00.000Z", status: "completed", activeRunId: null, activityRunStatus: null, pendingRuntimeRequest: null }],
};

test("a message is dispatched over the RPC socket with the contract's fields; every request names the protocol", async () => {
  const { fetchImpl, calls } = mockFetch(base);
  const { Socket, frames } = mockSocket({ "orchestration.dispatchCommand": () => ({ sequence: 11 }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773/", accessToken: "secret-token", fetchImpl, webSocketImpl: Socket });
  await adapter.sendMessage({ commandId: "cmd-1", threadId: "thread-1", messageId: "msg-1", text: "hello", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, titleSeed: "sol1: hello", mode: { type: "start" } });
  const frame = frames[0]!;
  assert.equal(frame.tag, "orchestration.dispatchCommand");
  assert.deepEqual(frame.payload, {
    type: "message.dispatch", createdBy: "user", creationSource: "web", commandId: "cmd-1", threadId: "thread-1", messageId: "msg-1", text: "hello", attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, titleSeed: "sol1: hello", dispatchMode: { type: "start_immediately" },
  });
  const socketUrl = new URL(frame.url);
  assert.deepEqual([socketUrl.protocol, socketUrl.pathname, socketUrl.searchParams.get("wsTicket"), socketUrl.searchParams.get("orchestrationProtocol")], ["ws:", "/ws", "tk", "2"]);
  for (const call of calls) {
    assert.equal(call.headers.authorization, "Bearer secret-token");
    assert.equal(call.headers["x-t3-orchestration-protocol"], "2");
  }
  // Queued behind the active run, or steered into it: the same command with another dispatch mode.
  await adapter.sendMessage({ commandId: "cmd-2", threadId: "thread-1", messageId: "msg-2", text: "later", mode: { type: "queue" } });
  await adapter.sendMessage({ commandId: "cmd-3", threadId: "thread-1", messageId: "msg-3", text: "also", mode: { type: "steer", runId: RUN } });
  assert.deepEqual(frames.slice(1).map((f) => f.payload.dispatchMode), [{ type: "queue_after_active" }, { type: "steer_active", targetRunId: RUN }]);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/auth/websocket-ticket")).length, 1, "commands share one socket");
  adapter.close();
});

test("the shared socket stays open while a command waits for T3, and closes after a quiet spell once it is answered", async () => {
  // T3 under load answers a settle after 300 ms; the quiet spell is 100 ms. The socket used to close 100 ms after the
  // call started, failing a settle T3 then applied.
  const { fetchImpl } = mockFetch(base);
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ sequence: 12 }), 300));
  const { Socket, frames, sockets } = mockSocket({ "orchestration.dispatchCommand": slow });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 2000, commandLinkIdleMs: 100 });
  const first = adapter.setThreadLifecycle({ commandId: "cmd-a", threadId: "thread-1", action: "settle" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = adapter.setThreadLifecycle({ commandId: "cmd-b", threadId: "thread-old", action: "archive" });
  await Promise.all([first, second]);
  assert.deepEqual(frames.map((f) => [f.payload.type, f.payload.threadId]), [["thread.settle", "thread-1"], ["thread.archive", "thread-old"]]);
  assert.deepEqual(sockets, { opened: 1, closed: 0 }, "one socket, still open right after the answers");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(sockets, { opened: 1, closed: 1 }, "closed after the quiet spell");
  adapter.close();
});

test("a command T3 never answers, and every other one waiting on the socket its limit drops, are unknown, not failed; a refusal stays a refusal", async () => {
  // Dispatches wait twice the request limit: 200 ms here. thread-1's settle is never answered; thread-old's archive is
  // applied by T3, whose answer would come after the drop; thread-busy's is refused at once.
  const { fetchImpl } = mockFetch(base);
  const { Socket, sockets } = mockSocket({
    "orchestration.dispatchCommand": (payload: { threadId: string }) => {
      if (payload.threadId === "thread-busy") throw new Error("thread is busy");
      if (payload.threadId === "thread-1") return new Promise(() => {});
      if (payload.threadId === "thread-old") return new Promise((resolve) => setTimeout(() => resolve({ sequence: 13 }), 400));
      return { sequence: 14 };
    },
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 100 });
  const never = adapter.setThreadLifecycle({ commandId: "cmd-a", threadId: "thread-1", action: "settle" }).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const applied = adapter.setThreadLifecycle({ commandId: "cmd-b", threadId: "thread-old", action: "archive" }).catch((error: unknown) => error);
  const refused = await adapter.setThreadLifecycle({ commandId: "cmd-c", threadId: "thread-busy", action: "settle" }).catch((error: unknown) => error);
  assert.ok(refused instanceof T3CommandRejected && !(refused instanceof T3OutcomeUnknown), String(refused));
  const [first, second] = await Promise.all([never, applied]);
  assert.ok(first instanceof T3OutcomeUnknown, String(first));
  assert.match((first as Error).message, /timed out after \d+ms/);
  assert.ok(second instanceof T3OutcomeUnknown, `the call waiting when the socket was dropped: ${String(second)}`);
  assert.match((second as Error).message, /connection closed before T3 answered/);
  assert.ok(second instanceof T3Unavailable, "still an outage for callers that resend with the same IDs");
  assert.equal(sockets.opened, 1);
  await adapter.setThreadLifecycle({ commandId: "cmd-d", threadId: "thread-2", action: "settle" });
  assert.equal(sockets.opened, 2, "the next command opens a new socket");
  adapter.close();

  // Nothing was sent when the socket cannot be had at all: that is an outage, not an unknown outcome.
  const down = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl: mockFetch({ ...base, "POST /api/auth/websocket-ticket": () => ({ status: 503, body: {} }) }).fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 100 });
  const unsent = await down.setThreadLifecycle({ commandId: "cmd-e", threadId: "thread-1", action: "settle" }).catch((error: unknown) => error);
  assert.ok(unsent instanceof T3Unavailable && !(unsent instanceof T3OutcomeUnknown), String(unsent));
  down.close();
});

test("images are stored in T3 first, and the message names the stored attachments", async () => {
  const { fetchImpl } = mockFetch(base);
  const stored = [{ type: "image", id: "att-1", name: "shot.png", mimeType: "image/png", sizeBytes: 3 }];
  const { Socket, frames } = mockSocket({ "assets.persistChatAttachments": () => ({ attachments: stored }), "orchestration.dispatchCommand": () => ({ sequence: 1 }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket });
  await adapter.sendMessage({ commandId: "c", threadId: "thread-1", messageId: "m", text: "look", images: [{ name: "shot.png", mimeType: "image/png", sizeBytes: 3, dataUrl: "data:image/png;base64,AAAA" }], mode: { type: "start" } });
  assert.deepEqual(frames.map((f) => f.tag), ["assets.persistChatAttachments", "orchestration.dispatchCommand"]);
  assert.deepEqual(frames[0]!.payload, { threadId: "thread-1", messageId: "m", attachments: [{ type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 3, dataUrl: "data:image/png;base64,AAAA" }] });
  assert.deepEqual(frames[1]!.payload.attachments, stored);
  adapter.close();
});

test("a thread is launched with its workspace and, when given, its first message; other commands use V2's names", async () => {
  const { fetchImpl } = mockFetch({ ...base, "GET /api/orchestration/shell": () => ({ status: 200, body: shell }) });
  const projection = { thread: { ...threadShell, id: "t", branch: "payments/sol1", worktreePath: "/wt/payments-sol1" }, runs: [], messages: [], turnItems: [], runtimeRequests: [] };
  const { Socket, frames } = mockSocket({ "orchestration.launchThread": () => ({ threadId: "t", projection, resumed: false }), "orchestration.dispatchCommand": () => ({ sequence: 1 }), "projects.mutate": () => ({}) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket });
  const launched = await adapter.launchThread({
    commandId: "c", threadId: "t", projectId: "proj", title: "room · sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default",
    workspace: { type: "worktree", baseRef: "main", branch: "payments/sol1" },
  });
  assert.deepEqual(frames[0]!.payload, {
    commandId: "c", creationSource: "web", threadId: "t", projectId: "proj", title: "room · sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: "payments/sol1" },
  });
  assert.deepEqual([launched.id, launched.status, launched.branch, launched.worktreePath], ["t", "idle", "payments/sol1", "/wt/payments-sol1"]);
  await adapter.interruptRun({ commandId: "c1", threadId: "thread-1", runId: RUN });
  await adapter.interruptRun({ commandId: "c2", threadId: "thread-1", runId: null });
  await adapter.respondApproval({ commandId: "c3", threadId: "thread-1", requestId: "req-1", decision: "accept" });
  await adapter.respondUserInput({ commandId: "c4", threadId: "thread-1", requestId: "req-2", answers: { "Proceed?": "yes" } });
  await adapter.dismissUserInput({ commandId: "c5", threadId: "thread-1", requestId: "req-2" });
  await adapter.setThreadModel({ commandId: "c6", threadId: "thread-1", modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
  await adapter.setRuntimeMode({ commandId: "c7", threadId: "thread-1", runtimeMode: "approval-required" });
  await adapter.setThreadLifecycle({ commandId: "c8", threadId: "thread-1", action: "unsettle" });
  await adapter.createProject({ commandId: "c9", projectId: "p2", title: "new", workspaceRoot: "~/new", createIfMissing: true });
  assert.deepEqual(frames.slice(1).map((f) => [f.tag, f.payload.type]), [
    ["orchestration.dispatchCommand", "run.interrupt"],
    ["orchestration.dispatchCommand", "run.interrupt"],
    ["orchestration.dispatchCommand", "runtime-request.respond"],
    ["orchestration.dispatchCommand", "runtime-request.respond"],
    ["orchestration.dispatchCommand", "thread.user-input.dismiss"],
    ["orchestration.dispatchCommand", "thread.model-selection.set"],
    ["orchestration.dispatchCommand", "thread.runtime-mode.set"],
    ["orchestration.dispatchCommand", "thread.unsettle"],
    ["projects.mutate", "project.create"],
  ]);
  assert.equal(frames[2]!.payload.runId, RUN, "no run named: the thread's active run");
  assert.deepEqual([frames[3]!.payload.decision, frames[4]!.payload.answers, frames[8]!.payload.reason], ["accept", { "Proceed?": "yes" }, "user"]);
  assert.deepEqual(frames[9]!.payload, { type: "project.create", commandId: "c9", projectId: "p2", title: "new", workspaceRoot: "~/new", createWorkspaceRootIfMissing: true });
  adapter.close();
});

test("a thread launched into a new worktree without a first message is returned once T3 has made the worktree", async () => {
  // T3 answers the launch as soon as the thread exists; the worktree is recorded on it a moment later.
  let reads = 0;
  const fresh = { ...threadShell, id: "t", status: "idle", activeRunId: null, activityRunStatus: null, latestRunId: null, pendingRuntimeRequest: null, branch: "payments/sol1" };
  const { fetchImpl } = mockFetch({
    ...base,
    "GET /api/orchestration/shell": () => {
      reads += 1;
      return { status: 200, body: { ...shell, threads: [{ ...fresh, worktreePath: reads >= 3 ? "/wt/payments-sol1" : null }] } };
    },
  });
  const { Socket } = mockSocket({ "orchestration.launchThread": () => ({ threadId: "t", projection: { thread: { ...fresh, worktreePath: null }, runs: [] }, resumed: false }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, worktreePollMs: 5 });
  const launch = { commandId: "c", threadId: "t", projectId: "proj", title: "room · sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access" as const, interactionMode: "default" as const };
  const launched = await adapter.launchThread({ ...launch, workspace: { type: "worktree", baseRef: "main", branch: "payments/sol1" } });
  assert.deepEqual([launched.worktreePath, reads], ["/wt/payments-sol1", 3]);
  // With a first message the thread is returned at once: its run waits for the workspace in T3.
  reads = 0;
  const started = await adapter.launchThread({ ...launch, commandId: "c2", workspace: { type: "worktree", baseRef: "main" }, initialMessage: { messageId: "m", text: "go" } });
  assert.deepEqual([started.worktreePath, reads], [null, 0]);
  adapter.close();
});

test("shell snapshot maps projects and thread shells: the active run's status, the pending request, archived threads apart", async () => {
  const { fetchImpl, calls } = mockFetch({ ...base, "GET /api/orchestration/shell": () => ({ status: 200, body: shell }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, shellCacheMs: 10_000 });
  const projects = await adapter.listProjects();
  assert.deepEqual(projects, [{ id: "proj", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: { instanceId: "codex", model: "gpt-6-sol" }, defaultThreadEnvMode: null }]);
  const thread = await adapter.getThreadShell("thread-1");
  assert.deepEqual([thread?.status, thread?.activeRunId, thread?.latestRunId], ["running", RUN, "run:thread:thread-1:ordinal:2"], "the status is the active run's, not the queued one's");
  assert.deepEqual(thread?.pendingRequest, { id: "req-2", kind: "user_input", createdAt: "2026-10-03T00:00:02.000Z" });
  assert.deepEqual((await adapter.listThreads()).map((t) => t.id), ["thread-1"]);
  // T3 keeps listing a question the agent went on without after its run ended; with no run in progress nothing waits.
  const done = adapter["toShell"]({ ...threadShell, status: "completed", activeRunId: null, activityRunStatus: null });
  assert.deepEqual([done.status, done.pendingRequest], ["completed", null]);
  assert.deepEqual((await adapter.listArchivedThreads()).map((t) => t.id), ["thread-old"]);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/orchestration/shell")).length, 1, "shell snapshot is cached within a tick");
  const catalog = await adapter.listCatalog();
  assert.ok(catalog.some((c) => c.instanceId === "codex" && c.model === "gpt-6-sol" && c.source === "observed"));
});

test("shell reads: callers while one is in flight share it, and a slow read is reused for twice its duration (the live service's 144 reads in 42 s)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let reads = 0;
  let fail = false;
  const held: Array<() => void> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path !== "/api/orchestration/shell") return new Response("not found", { status: 404 });
    reads += 1;
    // T3 answers when the test lets it: the read takes as long as the test moves the clock meanwhile.
    await new Promise<void>((resolve) => held.push(resolve));
    if (fail) throw new TypeError("fetch failed (simulated)");
    return new Response(JSON.stringify(shell), { status: 200 });
  }) as typeof fetch;
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const answer = async (afterMs: number) => {
    await settle();
    assert.equal(held.length, 1, "one shell read waits on T3");
    t.mock.timers.tick(afterMs);
    held.shift()!();
    await settle();
  };
  // The default cache (750 ms), as the live service runs it.
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl });

  // 1. Twenty callers while T3 takes 5 s to answer: one read, and every caller gets its snapshot.
  const callers = Array.from({ length: 20 }, (_, i) => (i % 2 ? adapter.listThreads().then((threads) => threads.map((x) => x.id)) : adapter.getThreadShell("thread-1").then((x) => [x?.id])));
  await answer(5_000);
  assert.deepEqual(new Set((await Promise.all(callers)).flat()), new Set(["thread-1"]));
  assert.equal(reads, 1, "callers during a read share it");

  // 2. That read took 5 s: its snapshot serves for 10 s from when it started, not 750 ms.
  t.mock.timers.tick(4_900); // 9.9 s after the read started
  await adapter.listThreads();
  await adapter.listProjects();
  assert.equal(reads, 1, "a slow read is reused for twice its duration");
  t.mock.timers.tick(200); // 10.1 s
  const fresh = adapter.listThreads();
  await answer(0);
  await fresh;
  assert.equal(reads, 2, "past twice the read's duration it is read again");

  // 3. A fast read brings the cache back to 750 ms.
  t.mock.timers.tick(700);
  await adapter.listThreads();
  assert.equal(reads, 2);
  t.mock.timers.tick(100);
  const third = adapter.listThreads();
  await answer(0);
  await third;
  assert.equal(reads, 3);

  // 4. A failed read is shared too, cached nowhere: every caller gets the error, and the next call reads again.
  fail = true;
  t.mock.timers.tick(1_000);
  const failing = [adapter.listThreads(), adapter.listThreads(), adapter.getThreadShell("thread-1")].map((x) => x.then(() => "ok", (error: unknown) => error instanceof T3Unavailable));
  await answer(0);
  assert.deepEqual(await Promise.all(failing), [true, true, true]);
  assert.equal(reads, 4);
  fail = false;
  const after = adapter.listThreads();
  await answer(0);
  assert.deepEqual((await after).map((x) => x.id), ["thread-1"]);
  assert.equal(reads, 5);
});

test("shell reads after a command: a read in flight when the command went out is neither shared nor cached", async () => {
  let reads = 0;
  let title = "v1";
  const held: Array<() => void> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path === "/api/auth/websocket-ticket") return new Response(JSON.stringify({ ticket: "tk" }), { status: 200 });
    if (path !== "/api/orchestration/shell") return new Response("not found", { status: 404 });
    reads += 1;
    // What T3 serves is fixed when the read starts; it answers when the test lets it.
    const body = { ...shell, threads: [{ ...threadShell, title }] };
    await new Promise<void>((resolve) => held.push(resolve));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const { Socket } = mockSocket({ "orchestration.dispatchCommand": () => ({ sequence: 12 }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, shellCacheMs: 60_000 });
  const before = adapter.getThreadShell("thread-1");
  await settle();
  title = "v2";
  await adapter.setThreadTitle({ commandId: "cmd-title", threadId: "thread-1", title: "v2" });
  const after = adapter.getThreadShell("thread-1");
  await settle();
  assert.equal(reads, 2, "the caller after the command reads again instead of sharing the read in flight");
  held.shift()!(); // the read from before the command lands first
  assert.equal((await before)?.title, "v1");
  held.shift()!();
  assert.equal((await after)?.title, "v2");
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "v2", "the cache holds the read made after the command");
  assert.equal(reads, 2);
  // A read from before the next command lands after the read made after it: it does not replace the cache.
  const slow = adapter["shell"](true);
  await settle();
  title = "v3";
  await adapter.setThreadTitle({ commandId: "cmd-title-2", threadId: "thread-1", title: "v3" });
  const fresh = adapter.getThreadShell("thread-1");
  await settle();
  assert.equal(reads, 4);
  held.splice(1, 1)[0]!(); // the read made after the command
  assert.equal((await fresh)?.title, "v3");
  held.shift()!(); // the one from before it, landing late
  await slow;
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "v3", "the late pre-command read did not replace the cache");
  assert.equal(reads, 4);
  adapter.close();
});

test("thread detail: runs by the message that started them or was steered into them, and requests with what they ask", async () => {
  const item = (ordinal: number, runId: string, fields: Record<string, unknown>) => ({ id: `item-${ordinal}`, threadId: "thread-1", runId, nodeId: `node-${ordinal}`, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal, status: "completed", title: null, startedAt: "2026-10-03T00:00:01.000Z", completedAt: "2026-10-03T00:00:01.000Z", updatedAt: "2026-10-03T00:00:01.000Z", ...fields });
  const message = (id: string, role: string, runId: string, text: string, createdBy = "user") => ({ id, threadId: "thread-1", runId, nodeId: null, role, text, attachments: [], streaming: false, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", createdBy, creationSource: "web" });
  const run = (ordinal: number, userMessageId: string, status: string) => ({ id: `run:thread:thread-1:ordinal:${ordinal}`, threadId: "thread-1", ordinal, providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, userMessageId, status, queuePosition: status === "queued" ? 1 : null, requestedAt: "2026-10-03T00:00:00.000Z", startedAt: status === "queued" ? null : "2026-10-03T00:00:00.500Z", completedAt: null, checkpointId: null });
  const request = (id: string, kind: string, status: string, capability: string) => ({ id, nodeId: `node-${id}`, providerTurnId: null, nativeRequestRef: null, kind, status, responseCapability: { type: capability }, createdAt: "2026-10-03T00:00:02.000Z", resolvedAt: status === "pending" ? null : "2026-10-03T00:00:03.000Z", ...(status === "resolved" && kind !== "user_input" ? { decision: "accept" } : {}) });
  const projection = {
    thread: { ...threadShell },
    runs: [run(1, "msg-1", "running"), run(2, "msg-3", "queued")],
    messages: [message("msg-1", "user", RUN, "hi"), message("msg-2", "user", RUN, "also this"), message("assistant:1", "assistant", RUN, "partial", "agent"), message("msg-3", "user", "run:thread:thread-1:ordinal:2", "next")],
    turnItems: [
      item(1000001, RUN, { type: "user_message", messageId: "msg-1", text: "hi", attachments: [], inputIntent: "turn_start", createdBy: "user", creationSource: "web" }),
      item(1000002, RUN, { type: "approval_request", requestId: "req-1", requestKind: "command", prompt: "npm test" }),
      item(1000003, RUN, { type: "user_message", messageId: "msg-2", text: "also this", attachments: [], inputIntent: "steer", createdBy: "user", creationSource: "web" }),
      item(1000004, RUN, { type: "user_input_request", requestId: "req-2", questions: [{ id: "Proceed?", header: "Confirm", question: "Proceed?", options: [{ label: "yes", description: "Proceed" }] }], responseMode: "message" }),
      item(1000005, RUN, { type: "mystery_item" }),
    ],
    runtimeRequests: [request("req-1", "command", "resolved", "live"), request("req-2", "user_input", "pending", "message"), request("req-3", "dynamic_tool_call", "pending", "live")],
    nodes: [], attempts: [], subagents: [], providerSessions: [], providerTurns: [], plans: [], checkpoints: [], checkpointScopes: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [],
    providerThreads: [{ id: "pt", driver: "codex", providerInstanceId: "codex", status: "active", nativeThreadRef: { driver: "codex", nativeId: "codex-session-1", strength: "strong" }, pendingBackgroundTasks: [], contextUsage: { usedTokens: 1000, maxTokens: 258000 }, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" }],
    updatedAt: "2026-10-03T00:00:02.000Z",
  };
  const { fetchImpl, calls } = mockFetch({
    ...base,
    "GET /api/orchestration/shell": () => ({ status: 200, body: shell }),
    "GET /api/orchestration/threads/thread-1": () => ({ status: 200, body: { snapshotSequence: 10, projection } }),
    "GET /api/orchestration/threads/thread-1/bounded": () => ({ status: 200, body: { snapshotSequence: 10, projection, historyCursor: "c", hasMoreHistory: true, latestLocalTurnOrdinal: 1 } }),
    "GET /api/orchestration/threads/missing": () => ({ status: 404, body: { error: "not found" } }),
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl });
  const loaded = await adapter.getThreadDetail("thread-1");
  assert.ok(loaded);
  assert.deepEqual([loaded.shell.status, loaded.shell.activeRunId, loaded.partial], ["running", RUN, false]);
  assert.equal(runForMessage(loaded, "msg-1")?.id, RUN, "the run a message started");
  assert.equal(runForMessage(loaded, "msg-2")?.id, RUN, "the run a message was steered into");
  assert.deepEqual([runForMessage(loaded, "msg-3")?.status, runForMessage(loaded, "nope")], ["queued", null]);
  assert.deepEqual(loaded.runtimeRequests.map((r) => [r.id, r.type, r.status, r.responseMode, r.runId, r.prompt ?? r.questions[0]?.question]), [
    ["req-1", "approval", "resolved", "live", RUN, "npm test"],
    ["req-2", "user-input", "pending", "message", RUN, "Proceed?"],
  ]);
  assert.deepEqual(loaded.turnItems.at(-1), { id: "item-1000005", runId: RUN, nodeId: "node-1000005", providerTurnId: null, ordinal: 1000005, status: "completed", title: null, startedAt: "2026-10-03T00:00:01.000Z", completedAt: "2026-10-03T00:00:01.000Z", updatedAt: "2026-10-03T00:00:01.000Z", type: "other", itemType: "mystery_item" }, "an item type Backroom does not read is kept by name");
  assert.equal(loaded.providerThreads[0]?.nativeId, "codex-session-1");
  assert.deepEqual(openRequests(loaded).map((r) => r.id), ["req-2"], "a question asked in message mode waits while its run is active");
  // The run ends without the answer (Codex goes on): nothing is waiting, whatever T3 still lists as pending.
  const ended = { ...loaded, runs: loaded.runs.map((r) => (r.id === RUN ? { ...r, status: "completed" as const } : r)) };
  assert.deepEqual(openRequests(ended), []);
  const bounded = await adapter.getThreadDetail("thread-1", { bounded: true });
  assert.ok(calls.some((c) => c.url.endsWith("/api/orchestration/threads/thread-1/bounded")));
  assert.equal(bounded?.partial, true, "a bounded read says when T3 holds older history");
  assert.equal(await adapter.getThreadDetail("missing"), null);
});

test("a server on another orchestration protocol is refused with what to do, and can still be asked for its version", async () => {
  const { fetchImpl } = mockFetch({
    ...base,
    // A V1 server: no protocol version in its descriptor, and a shell of another shape.
    "GET /.well-known/t3/environment": () => ({ status: 200, body: { environmentId: "env", label: "box", serverVersion: "0.0.45-nightly.20261002.2595" } }),
    "GET /api/orchestration/shell": () => ({ status: 200, body: { snapshotSequence: 1, projects: [], threads: [] } }),
  });
  const { Socket, frames } = mockSocket({ "server.getConfig": () => ({ environment: { serverVersion: "0.0.45-nightly.20261002.2595", capabilities: { serverSelfUpdate: "boot-service" } }, providers: [] }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket });
  const mismatch = (error: unknown) => error instanceof T3ProtocolMismatch && error instanceof T3Unavailable && /speaks orchestration protocol 1; Backroom needs protocol 2/.test(error.message) && /Update T3/.test(error.message);
  await assert.rejects(adapter.listThreads(), mismatch);
  await assert.rejects(adapter.getThreadDetail("thread-1"), mismatch);
  await assert.rejects(adapter.sendMessage({ commandId: "c", threadId: "thread-1", messageId: "m", text: "x", mode: { type: "start" } }), mismatch);
  assert.equal(frames.length, 0, "no command reaches a server that would misread it");
  assert.deepEqual([(await adapter.versions()).serverVersion, (await adapter.versions()).selfUpdate], ["0.0.45-nightly.20261002.2595", "boot-service"], "its version and update path are still read, so it can be updated from here");
  adapter.close();
});

test("401/403 and network failures are T3Unavailable; 4xx rejections are T3CommandRejected", async () => {
  const { fetchImpl } = mockFetch({
    ...base,
    "GET /api/orchestration/shell": () => ({ status: 401, body: { error: "unauthorized" } }),
  });
  const { Socket } = mockSocket({
    "orchestration.dispatchCommand": () => {
      throw new Error("Run run:nope is not interruptible.");
    },
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "expired", fetchImpl, webSocketImpl: Socket });
  await assert.rejects(adapter.listThreads(), (error: unknown) => error instanceof T3Unavailable && /pair Backroom again/.test(error.message));
  // T3 refuses a command with its reason; the adapter passes the reason on.
  await assert.rejects(
    adapter.interruptRun({ commandId: "c", threadId: "t", runId: "run:nope" }),
    (error: unknown) => error instanceof T3CommandRejected && /T3 refused orchestration.dispatchCommand: Run run:nope is not interruptible\./.test(error.message),
  );
  adapter.close();
  const offline = new HttpT3Adapter({
    baseUrl: "http://t3.local:3773",
    accessToken: "tok",
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(offline.describe(), (error: unknown) => error instanceof T3Unavailable);
});

test("pairing URL parsing and the RFC 8693 token exchange request", async () => {
  const parsed = parsePairingUrl("http://192.168.1.10:3773/pair?token=abc123");
  assert.deepEqual(parsed, { baseUrl: "http://192.168.1.10:3773", credential: "abc123" });
  assert.throws(() => parsePairingUrl("http://192.168.1.10:3773/pair"), /does not contain a token/);
  const { fetchImpl, calls } = mockFetch({
    "POST /oauth/token": () => ({ status: 200, body: { access_token: "issued", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600, scope: "orchestration:read orchestration:operate" } }),
  });
  const auth = await exchangePairingCredential(parsed.baseUrl, parsed.credential, fetchImpl);
  const call = calls[0]!;
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(call.body!);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(form.get("subject_token"), "abc123");
  assert.equal(form.get("subject_token_type"), "urn:t3:params:oauth:token-type:environment-bootstrap");
  assert.equal(form.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(auth.accessToken, "issued");
  assert.equal(auth.tokenType, "Bearer");
  assert.ok(auth.expiresAt && Date.parse(auth.expiresAt) > Date.now());
});

test("a T3 that accepts a request but never answers counts as unreachable after the time limit, not forever", async () => {
  // Like T3 while it restarts after an update: the connection is accepted, no response ever comes.
  const silent: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl: silent, requestTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(adapter.listProjects(), (error: Error) => error instanceof T3Unavailable && /did not answer GET \/\.well-known\/t3\/environment within 50ms/.test(error.message));
  assert.ok(Date.now() - started < 2000, "gives up at the limit");
});

test("versions read T3's own version and each harness's, offering an update only where T3 would", async () => {
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.test", accessToken: "tok" });
  const checkedAt = "2026-09-28T07:23:22.886Z";
  const advisory = (status: string, currentVersion: string, latestVersion: string | null, updateCommand: string | null) => ({ status, currentVersion, latestVersion, updateCommand, canUpdate: updateCommand !== null, checkedAt, message: "Install the update now or review provider settings." });
  // server.getConfig as the running T3 answers it, trimmed to what versions() reads.
  adapter.getServerConfig = async () => ({
    environment: { serverVersion: "0.0.46-nightly.20261003.2610", capabilities: { serverSelfUpdate: "boot-service", serverSelfUpdateProgress: true, serverUpdateThreadContinuation: true } },
    providers: [
      { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, version: "2.1.282", versionAdvisory: advisory("behind_latest", "2.1.282", "2.1.283", "/home/me/.local/bin/claude update") },
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, version: "0.157.0", versionAdvisory: advisory("behind_latest", "0.157.0", "0.158.0", null) },
      { instanceId: "cursor", driver: "cursor", displayName: "Cursor", enabled: true, version: "2026.09.23-86fc751", versionAdvisory: advisory("unknown", "2026.09.23-86fc751", null, "/home/me/.local/bin/cursor-agent update") },
      { instanceId: "opencode", driver: "opencode", displayName: "OpenCode", enabled: true, version: "1.2.0", versionAdvisory: advisory("behind_latest", "1.2.0", "1.3.0", "npm i -g opencode-ai"), compatibilityAdvisory: { latestVersionStatus: "broken", message: "OpenCode 1.3.0 breaks T3's session resume." } },
      { instanceId: "grok", driver: "grok", enabled: false, version: null },
    ],
  });
  const versions = await adapter.versions();
  assert.deepEqual([versions.serverVersion, versions.selfUpdate, versions.threadContinuation], ["0.0.46-nightly.20261003.2610", "boot-service", true]);
  const by = Object.fromEntries(versions.harnesses.map((h) => [h.instanceId, h]));
  assert.equal(by.claudeAgent!.updatable, true);
  assert.equal(by.claudeAgent!.latestVersion, "2.1.283");
  assert.equal(by.codex!.updatable, false, "no update command: T3 cannot update it");
  assert.match(by.codex!.note ?? "", /cannot update this install/);
  assert.equal(by.cursor!.updatable, false, "newest unknown");
  assert.equal(by.opencode!.updatable, false, "T3 flags the newest version as broken");
  assert.equal(by.opencode!.note, "OpenCode 1.3.0 breaks T3's session resume.");
  assert.deepEqual([by.grok!.enabled, by.grok!.status, by.grok!.displayName], [false, "unknown", "grok"]);
});
