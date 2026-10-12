/**
 * Adapter contract tests against a mocked transport (HTTP reads, the WebSocket RPC for commands): request shapes,
 * auth handling, protocol negotiation and response mapping, in the shapes T3's Orchestrator V2 serves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { REQUESTED_SCOPES, exchangePairingCredential, missingScopeMessage, parsePairingUrl, sameT3Host } from "../src/adapter/auth.ts";
import { T3CommandRejected, T3OutcomeUnknown, T3ProtocolMismatch, T3ScopeMissing, T3Unavailable, openRequests, runForMessage } from "../src/adapter/types.ts";

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
 * A handler that returns a promise answers when it settles; `closed` counts the sockets closed. A handler that throws
 * is refused with its message, or with the error it carries as `rpcError`.
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
      const failure = (error: unknown) => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: (error as { rpcError?: unknown }).rpcError ?? { _tag: "OrchestrationV2DispatchCommandError", message: (error as Error).message } }] });
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
/** The shell as T3 0.0.46 serves it over HTTP and in its subscribeShell snapshot: the active shell, no archived threads. */
const activeShell = { ...shell, archivedThreads: [] };
/** T3's archived shell (getArchivedShellSnapshot, subscribeArchivedShell's snapshot): the archived threads as `threads`. */
const archivedShell = { schemaVersion: 2, snapshotSequence: 10, projects: shell.projects, threads: shell.archivedThreads };

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
  // T3's HTTP shell lists no archived threads (it builds the active shell only): they are read over the RPC.
  const { fetchImpl, calls } = mockFetch({ ...base, "GET /api/orchestration/shell": () => ({ status: 200, body: activeShell }) });
  const { Socket, frames } = mockSocket({ "orchestration.getArchivedShellSnapshot": () => archivedShell });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, shellCacheMs: 10_000 });
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
  assert.deepEqual((await adapter.listArchivedThreads()).map((t) => t.id), ["thread-old"]);
  assert.deepEqual(frames.map((f) => f.tag), ["orchestration.getArchivedShellSnapshot"], "the archived shells are cached like the shell");
  assert.equal(calls.filter((c) => c.url.endsWith("/api/orchestration/shell")).length, 1, "shell snapshot is cached within a tick");
  const catalog = await adapter.listCatalog();
  assert.ok(catalog.some((c) => c.instanceId === "codex" && c.model === "gpt-6-sol" && c.source === "observed"));
  adapter.close();
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
  assert.equal(form.get("scope"), REQUESTED_SCOPES);
  assert.equal(auth.accessToken, "issued");
  assert.equal(auth.tokenType, "Bearer");
  assert.ok(auth.expiresAt && Date.parse(auth.expiresAt) > Date.now());
});

test("Backroom asks T3 for exactly the scopes its calls need, and nothing broader", () => {
  // T3's RPC_REQUIRED_SCOPES (0.0.46): server.updateProvider providers:manage, server.updateServer environment:maintain,
  // server.getUsageSummary diagnostics:read, filesystem.browse filesystem:read; every other call Backroom makes needs
  // orchestration:read or orchestration:operate.
  assert.equal(REQUESTED_SCOPES, "orchestration:read orchestration:operate providers:manage environment:maintain diagnostics:read filesystem:read");
});

test("a call T3 refuses for a permission Backroom's pairing lacks says, in one sentence, to pair again and how", async () => {
  // T3's refusal as it answers it: requiredScope is the permission's legacy parent, requiredPermission the one missing.
  const refusal = (permission: string, parent: string) => () => {
    throw Object.assign(new Error("refused"), {
      rpcError: { _tag: "EnvironmentAuthorizationError", message: `The authenticated token is missing required scope: ${permission}.`, requiredScope: parent, requiredPermission: permission },
    });
  };
  const { fetchImpl } = mockFetch(base);
  const { Socket } = mockSocket({
    "server.updateServer": refusal("environment:maintain", "orchestration:operate"),
    "server.updateProvider": refusal("providers:manage", "orchestration:operate"),
    "filesystem.browse": refusal("filesystem:read", "orchestration:read"),
    "orchestration.dispatchCommand": () => {
      throw new Error("Run run:nope is not interruptible.");
    },
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket });
  const sentence =
    'Backroom\'s pairing with T3 does not allow this (it lacks the "environment:maintain" permission): run `t3 pair` on T3\'s machine and paste the link it prints into the T3 panel (the T3 button at the top of the overview) to pair again.';
  assert.equal(missingScopeMessage("environment:maintain"), sentence);
  const refused = await adapter.updateServer({ targetVersion: "0.0.47", continueRunningThreads: false }).catch((error: unknown) => error);
  assert.ok(refused instanceof T3ScopeMissing && refused instanceof T3CommandRejected, String(refused));
  assert.equal(refused.scope, "environment:maintain");
  assert.equal(refused.message, sentence);
  await assert.rejects(adapter.updateHarness({ instanceId: "claudeAgent", driver: "claudeAgent" }), (error: unknown) => error instanceof T3ScopeMissing && error.message === missingScopeMessage("providers:manage"));
  await assert.rejects(adapter.browseFolders("/home/"), (error: unknown) => error instanceof T3ScopeMissing && error.scope === "filesystem:read");
  // Any other refusal is passed on as T3 gave it.
  await assert.rejects(adapter.interruptRun({ commandId: "c", threadId: "t", runId: "run:nope" }), (error: unknown) => error instanceof T3CommandRejected && !(error instanceof T3ScopeMissing));
  adapter.close();
});

test("a pairing link may name T3 by another loopback name than Backroom's address for it", () => {
  // `t3 pair` prints http://localhost:3773 while T3's runtime file says http://127.0.0.1:3773.
  assert.ok(sameT3Host("http://127.0.0.1:3773", "http://localhost:3773/pair#token=x"));
  assert.ok(sameT3Host("http://[::1]:3773", "http://localhost:3773"));
  assert.ok(!sameT3Host("http://127.0.0.1:3773", "http://localhost:3774"), "another port is another server");
  assert.ok(!sameT3Host("http://127.0.0.1:3773", "http://box.tailnet.ts.net:3773"));
  assert.ok(sameT3Host("https://box.tailnet.ts.net", "https://box.tailnet.ts.net/pair#token=x"));
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

// ---------------- the shell feed: T3's shell streams over the RPC socket ----------------

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * T3's WebSocket RPC with its shell streams, as the installed server runs them: a subscription is answered with Chunk
 * frames, the next sent only once the last is acknowledged (Ack); Interrupt ends it with an Exit Failure; a Ping is
 * answered with a Pong (unless the socket is `silent`). Other requests are answered from `handlers`, as mockSocket
 * does. `initial` is what each subscription sends first, chunk by chunk.
 */
function streamingT3(initial: () => Record<string, unknown[][]>, handlers: Record<string, (payload: any) => unknown> = {}) {
  type Subscription = { id: unknown; queue: unknown[][]; awaitingAck: boolean; ended: boolean };
  const sockets: StreamSocket[] = [];
  class StreamSocket {
    readonly url: string;
    readonly sent: any[] = [];
    readonly subscriptions = new Map<string, Subscription>();
    closed = false;
    silent = false;
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
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
    /** One WebSocket message: a frame, or a list of frames. */
    message(value: unknown): void {
      queueMicrotask(() => {
        if (!this.closed) this.emit("message", { data: JSON.stringify(value) });
      });
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      const subscription = [...this.subscriptions.values()].find((s) => s.id === frame.requestId);
      if (frame._tag === "Ping") {
        if (!this.silent) this.message({ _tag: "Pong" });
      } else if (frame._tag === "Ack") {
        if (subscription) {
          subscription.awaitingAck = false;
          this.flush(subscription);
        }
      } else if (frame._tag === "Interrupt") {
        if (subscription && !subscription.ended) {
          subscription.ended = true;
          this.message({ _tag: "Exit", requestId: frame.requestId, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] } });
        }
      } else if (frame._tag === "Request" && frame.tag in initial()) {
        const created = { id: frame.id, queue: [...initial()[frame.tag]!], awaitingAck: false, ended: false };
        this.subscriptions.set(frame.tag, created);
        this.flush(created);
      } else if (frame._tag === "Request") {
        queueMicrotask(() => {
          try {
            const value = handlers[frame.tag]?.(frame.payload) ?? null;
            if (value instanceof Promise) value.then((late) => this.message({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: late ?? null } }), () => undefined);
            else this.message({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } });
          } catch (error) {
            this.message({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "Refused", message: (error as Error).message } }] } });
          }
        });
      }
    }
    private flush(subscription: Subscription): void {
      if (subscription.awaitingAck || subscription.ended || subscription.queue.length === 0) return;
      subscription.awaitingAck = true;
      this.message({ _tag: "Chunk", requestId: subscription.id, values: subscription.queue.shift() });
    }
    /** T3 streams `values` as one chunk on its subscription to `tag`. */
    push(tag: string, ...values: unknown[]): void {
      const subscription = this.subscriptions.get(tag)!;
      subscription.queue.push(values);
      this.flush(subscription);
    }
    /** T3 ends its subscription to `tag`. */
    end(tag: string, exit: unknown): void {
      const subscription = this.subscriptions.get(tag)!;
      subscription.ended = true;
      this.message({ _tag: "Exit", requestId: subscription.id, exit });
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", {});
    }
  }
  /** The socket subscribed to the shell (the feed's), newest first. */
  const feedSocket = () => [...sockets].reverse().find((socket) => socket.subscriptions.size > 0)!;
  return { Socket: StreamSocket, sockets, feedSocket };
}

const SHELL = "orchestration.subscribeShell";
const ARCHIVED = "orchestration.subscribeArchivedShell";
/** T3's two shell streams as they open: a snapshot each. */
const opening = () => ({ [SHELL]: [[{ kind: "snapshot", snapshot: activeShell }]], [ARCHIVED]: [[{ kind: "snapshot", snapshot: archivedShell }]] });

/** An adapter over `t3`, with its feed's timings short; `shellBody` is what T3's HTTP shell answers. */
function feedAdapter(t3: ReturnType<typeof streamingT3>, options: { shellBody?: () => unknown; requestTimeoutMs?: number; pingMs?: number } = {}) {
  let tickets = 0;
  const { fetchImpl, calls } = mockFetch({
    ...base,
    "POST /api/auth/websocket-ticket": () => ({ status: 200, body: { ticket: `tk${++tickets}` } }),
    "GET /api/orchestration/shell": () => ({ status: 200, body: options.shellBody?.() ?? activeShell }),
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: t3.Socket, requestTimeoutMs: options.requestTimeoutMs ?? 2_000, feed: { pingMs: options.pingMs ?? 1_000, retryMs: 10, retryMaxMs: 40 } });
  const gets = () => calls.filter((c) => c.url.endsWith("/api/orchestration/shell")).length;
  return { adapter, calls, gets };
}

/** What the adapter's shell reads return, for comparing a feed's with the HTTP snapshot's. */
async function reads(adapter: HttpT3Adapter) {
  return {
    projects: await adapter.listProjects(),
    threads: await adapter.listThreads(),
    inProject: await adapter.listThreads("proj"),
    elsewhere: await adapter.listThreads("other"),
    archived: await adapter.listArchivedThreads(),
    thread: await adapter.getThreadShell("thread-1"),
    archivedOne: await adapter.getThreadShell("thread-old"),
    missing: await adapter.getThreadShell("nope"),
  };
}

test("the shell feed subscribes to both streams on a socket of its own, acknowledges each chunk, and serves the shell reads with no HTTP snapshot", async () => {
  const t3 = streamingT3(opening);
  const { adapter, gets, calls } = feedAdapter(t3);
  assert.deepEqual(adapter.feed().state, "down", "not started");
  adapter.startFeed();
  assert.equal(adapter.feed().state, "connecting");
  await settle();
  assert.equal(adapter.feed().state, "connected");
  const socket = t3.feedSocket();
  assert.deepEqual(socket.sent.filter((f) => f._tag === "Request").map((f) => [f.tag, f.payload, f.headers]), [[SHELL, {}, []], [ARCHIVED, {}, []]]);
  assert.equal(new URL(socket.url).searchParams.get("wsTicket"), "tk1");

  // The same data as T3's HTTP snapshot reads the same, with no HTTP snapshot.
  const fromFeed = await reads(adapter);
  assert.equal(gets(), 0, "no shell GET while the feed is live");
  const { fetchImpl } = mockFetch({ ...base, "GET /api/orchestration/shell": () => ({ status: 200, body: activeShell }) });
  const { Socket } = mockSocket({ "orchestration.getArchivedShellSnapshot": () => archivedShell });
  const overHttp = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket });
  assert.deepEqual(fromFeed, await reads(overHttp));
  overHttp.close();
  assert.deepEqual([fromFeed.archived.map((t) => t.id), fromFeed.archivedOne], [["thread-old"], null]);

  // T3 sends the next chunk only once the last is acknowledged: three chunks in a row all arrive.
  const later = (thread: Record<string, unknown>, at: string) => ({ ...thread, updatedAt: at });
  socket.push(SHELL, { kind: "thread.updated", sequence: 11, location: "active", thread: later({ ...threadShell, title: "renamed" }, "2026-10-03T00:00:05.000Z") });
  socket.push(SHELL, { kind: "project.updated", sequence: 12, project: { ...shell.projects[0], title: "demo 2" } });
  socket.push(SHELL, { kind: "thread.updated", sequence: 13, location: "active", thread: later({ ...threadShell, id: "thread-2", title: "new" }, "2026-10-03T00:00:06.000Z") });
  await settle();
  assert.deepEqual((await adapter.listThreads()).map((t) => [t.id, t.title]), [["thread-1", "renamed"], ["thread-2", "new"]]);
  assert.equal((await adapter.listProjects())[0]?.title, "demo 2");
  const shellId = socket.subscriptions.get(SHELL)!.id;
  assert.equal(socket.sent.filter((f) => f._tag === "Ack" && f.requestId === shellId).length, 4, "the snapshot's chunk and the three after it");
  // Several frames in one message: each is taken.
  const archivedId = socket.subscriptions.get(ARCHIVED)!.id;
  socket.message([
    { _tag: "Chunk", requestId: shellId, values: [{ kind: "thread.removed", sequence: 14, location: "active", threadId: "thread-2" }] },
    { _tag: "Chunk", requestId: archivedId, values: [{ kind: "thread.updated", sequence: 14, thread: { ...threadShell, id: "thread-2", title: "new", archivedAt: "2026-10-03T00:00:07.000Z", updatedAt: "2026-10-03T00:00:07.000Z" } }] },
  ]);
  await settle();
  assert.deepEqual([(await adapter.listThreads()).map((t) => t.id), (await adapter.listArchivedThreads()).map((t) => t.id)], [["thread-1"], ["thread-old", "thread-2"]]);
  assert.equal(gets(), 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/auth/websocket-ticket")).length, 1, "one socket");
  adapter.close();
});

test("the feed's shell holds each thread once, in T3's order, and no late change overwrites a newer one", async () => {
  const { ShellState } = await import("../src/adapter/shellFeed.ts");
  const row = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ ...threadShell, id, updatedAt, ...extra });
  const project = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, title: id, workspaceRoot: `/w/${id}`, createdAt, updatedAt: createdAt, repositoryIdentity: null, ...extra });
  const state = new ShellState();
  const ids = () => {
    const read = state.read();
    return { active: read.threads.map((t) => t.id), archived: (read.archivedThreads ?? []).map((t) => t.id), projects: read.projects.map((p) => p.id) };
  };
  const both = () => {
    const read = state.read();
    const active = new Set(read.threads.map((t) => t.id));
    return (read.archivedThreads ?? []).filter((t) => active.has(t.id as string)).map((t) => t.id);
  };
  // Changes before a stream's snapshot are not taken (T3's client skips them too).
  assert.equal(state.apply("active", { kind: "thread.updated", sequence: 5, location: "active", thread: row("x", "t0") }), undefined);
  assert.deepEqual(
    state.apply("active", { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 10, threads: [row("a", "t1"), row("b", "t2"), row("c", "t3")], archivedThreads: [], projects: [project("p2", "c2"), project("p1", "c1")] } }),
    { threadIds: null },
  );
  assert.equal(state.whole, false, "not whole until the archived snapshot is in");
  state.apply("archive", { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 9, projects: [], threads: [row("d", "t0", { archivedAt: "t0" })] } });
  assert.equal(state.whole, true);
  assert.deepEqual(ids(), { active: ["a", "b", "c"], archived: ["d"], projects: ["p1", "p2"] }, "threads by updatedAt then id, projects by createdAt then id");

  // An update moves the thread where T3's snapshot would list it; a new thread goes by its updatedAt too.
  assert.deepEqual(state.apply("active", { kind: "thread.updated", sequence: 11, location: "active", thread: row("a", "t4") }), { threadIds: ["a"] });
  state.apply("active", { kind: "thread.updated", sequence: 12, location: "active", thread: row("e", "t4") });
  assert.deepEqual(ids().active, ["b", "c", "a", "e"]);
  // A change the stream has gone past changes nothing.
  assert.equal(state.apply("active", { kind: "thread.updated", sequence: 12, location: "active", thread: row("b", "t9") }), undefined);
  assert.equal(state.apply("active", { kind: "thread.updated", sequence: 3, location: "active", thread: row("b", "t9") }), undefined);

  // Archived: a removal on the active stream and an update on the archived one, at one sequence, in either order.
  state.apply("archive", { kind: "thread.updated", sequence: 13, thread: row("b", "t5", { archivedAt: "t5" }) });
  assert.deepEqual([both(), ids().archived], [[], ["d", "b"]], "archived first: moved, never in both");
  state.apply("active", { kind: "thread.removed", sequence: 13, location: "active", threadId: "b" });
  assert.deepEqual([ids().active, ids().archived], [["c", "a", "e"], ["d", "b"]], "the active stream's removal does not take it from the archived list");
  state.apply("active", { kind: "thread.removed", sequence: 14, location: "active", threadId: "c" });
  state.apply("archive", { kind: "thread.updated", sequence: 14, thread: row("c", "t6", { archivedAt: "t6" }) });
  assert.deepEqual([ids().active, ids().archived], [["a", "e"], ["d", "b", "c"]], "removed first: then archived");
  // Unarchived: the active stream's update first, then the archived stream's removal, and the other way round.
  state.apply("active", { kind: "thread.updated", sequence: 15, location: "active", thread: row("d", "t7") });
  assert.deepEqual(both(), [], "never in both");
  state.apply("archive", { kind: "thread.removed", sequence: 15, threadId: "d" });
  state.apply("archive", { kind: "thread.removed", sequence: 16, threadId: "b" });
  state.apply("active", { kind: "thread.updated", sequence: 16, location: "active", thread: row("b", "t8") });
  assert.deepEqual([ids().active, ids().archived], [["a", "e", "d", "b"], ["c"]]);
  // An update placed outside the active list takes the thread out of it, as T3's client reads it.
  state.apply("active", { kind: "thread.updated", sequence: 17, location: "archive", thread: row("e", "t9") });
  assert.deepEqual(ids().active, ["a", "d", "b"]);

  // Projects: updated, removed; an enrichment snapshot only patches the repository identity in.
  assert.deepEqual(state.apply("active", { kind: "project.updated", sequence: 18, project: project("p0", "c3") }), { threadIds: [] });
  state.apply("active", { kind: "project.removed", sequence: 19, projectId: "p1" });
  assert.deepEqual(ids().projects, ["p2", "p0"]);
  const identity = { canonicalKey: "github.com/x/p2" };
  assert.deepEqual(state.apply("active", { kind: "snapshot", snapshot: { schemaVersion: 2, snapshotSequence: 19, threads: [], archivedThreads: [], projects: [project("p2", "c2", { repositoryIdentity: identity })] }, resolvedRepositoryIdentityRoots: ["/w/p2"] }), { threadIds: [] });
  assert.deepEqual([ids().active, state.read().projects.find((p) => p.id === "p2")?.repositoryIdentity], [["a", "d", "b"], identity], "threads kept");
  assert.equal(state.apply("active", { kind: "synchronized" }), undefined);
  assert.equal(state.apply("active", { kind: "something.new", sequence: 20 }), undefined);
  assert.equal(state.sequence, 20);

  // Snapshots from two streams that disagree: the newer one holds, whichever comes first.
  const late = new ShellState();
  late.apply("archive", { kind: "snapshot", snapshot: { snapshotSequence: 30, projects: [], threads: [row("z", "t1", { archivedAt: "t1" })] } });
  late.apply("active", { kind: "snapshot", snapshot: { snapshotSequence: 28, threads: [row("z", "t0")], archivedThreads: [], projects: [] } });
  assert.deepEqual([late.read().threads.map((t) => t.id), late.read().archivedThreads?.map((t) => t.id)], [[], ["z"]]);
  // A change on the active stream older than what the archived one holds: past for the active stream, not for z.
  assert.equal(late.apply("active", { kind: "thread.updated", sequence: 29, location: "active", thread: row("z", "t0") }), undefined);
  assert.deepEqual([late.read().threads.map((t) => t.id), late.read().archivedThreads?.map((t) => t.id)], [[], ["z"]]);
  assert.equal(late.apply("active", { kind: "thread.removed", sequence: 29, location: "active", threadId: "z" }), undefined);
  const early = new ShellState();
  early.apply("archive", { kind: "snapshot", snapshot: { snapshotSequence: 28, projects: [], threads: [row("z", "t0", { archivedAt: "t0" })] } });
  early.apply("active", { kind: "snapshot", snapshot: { snapshotSequence: 30, threads: [row("z", "t1")], archivedThreads: [], projects: [] } });
  assert.deepEqual([early.read().threads.map((t) => t.id), early.read().archivedThreads?.map((t) => t.id)], [["z"], []]);
});

test("before the feed's first snapshots, and after its subscription fails, the shell reads go over HTTP without waiting for it", async () => {
  // T3 takes the subscriptions and sends nothing yet.
  const t3 = streamingT3(() => ({ [SHELL]: [], [ARCHIVED]: [] }), { "orchestration.getArchivedShellSnapshot": () => archivedShell });
  const { adapter, gets } = feedAdapter(t3);
  adapter.startFeed();
  await settle();
  assert.equal(adapter.feed().state, "connecting");
  assert.deepEqual((await adapter.listThreads()).map((t) => t.id), ["thread-1"]);
  assert.deepEqual((await adapter.listArchivedThreads()).map((t) => t.id), ["thread-old"]);
  assert.equal(gets(), 1);
  // Only the active snapshot: not whole, still not served.
  t3.feedSocket().push(SHELL, { kind: "snapshot", snapshot: activeShell });
  await settle();
  assert.equal(adapter.feed().state, "connecting");
  // T3 refuses the archived subscription: down, with T3's reason; reads over HTTP; it tries again by itself.
  t3.feedSocket().end(ARCHIVED, { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "Refused", message: "not now" } }] });
  await settle();
  const down = adapter.feed();
  assert.deepEqual([down.state, down.error], ["down", "T3 refused orchestration.subscribeArchivedShell: not now"]);
  assert.ok(t3.sockets[0]!.closed, "the failed socket is closed");
  await adapter.listThreads();
  await sleep(30);
  await settle();
  assert.equal(adapter.feed().state, "down", "a retry that brings no snapshot yet leaves it down");
  t3.feedSocket().push(SHELL, { kind: "snapshot", snapshot: activeShell });
  t3.feedSocket().push(ARCHIVED, { kind: "snapshot", snapshot: archivedShell });
  await settle();
  assert.equal(adapter.feed().state, "connected");
  const ticket = (socket: { url: string }) => new URL(socket.url).searchParams.get("wsTicket");
  assert.notEqual(ticket(t3.feedSocket()), ticket(t3.sockets[0]!), "a fresh ticket");
  adapter.close();
});

test("a read waiting on a slow HTTP snapshot is answered from the feed once it is live, not held behind the older read", async () => {
  const t3 = streamingT3(() => ({ [SHELL]: [], [ARCHIVED]: [] }));
  const held: Array<() => void> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path === "/api/auth/websocket-ticket") return new Response(JSON.stringify({ ticket: "tk" }), { status: 200 });
    // A T3 restarting: the HTTP shell takes its time.
    await new Promise<void>((resolve) => held.push(resolve));
    return new Response(JSON.stringify(activeShell), { status: 200 });
  }) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: t3.Socket, requestTimeoutMs: 5_000 });
  adapter.startFeed();
  await settle();
  const waiting = adapter.listThreads();
  const alsoWaiting = adapter.getThreadShell("thread-1");
  await settle();
  assert.equal(held.length, 1, "one HTTP read, shared");
  t3.feedSocket().push(SHELL, { kind: "snapshot", snapshot: { ...activeShell, snapshotSequence: 11, threads: [{ ...threadShell, title: "from the feed" }] } });
  t3.feedSocket().push(ARCHIVED, { kind: "snapshot", snapshot: archivedShell });
  await settle();
  assert.deepEqual((await waiting).map((t) => t.title), ["from the feed"]);
  assert.equal((await alsoWaiting)?.title, "from the feed");
  assert.equal(held.length, 1, "the HTTP read is still unanswered");
  held.shift()!();
  await settle();
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "from the feed", "the late HTTP read does not displace the feed");
  adapter.close();
});

test("a dropped feed reconnects with backoff on a fresh ticket and subscribes again; the shell is heard of once its snapshots are in", async () => {
  let snapshotTitle = "first";
  const t3 = streamingT3(() => ({ [SHELL]: [[{ kind: "snapshot", snapshot: { ...activeShell, threads: [{ ...threadShell, title: snapshotTitle }] } }]], [ARCHIVED]: [[{ kind: "snapshot", snapshot: archivedShell }]] }));
  const { adapter, gets, calls } = feedAdapter(t3);
  const heard: unknown[] = [];
  adapter.onShellChange((change) => heard.push(change));
  // Read over HTTP before the feed starts: that snapshot stays cached for 750 ms.
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "t");
  adapter.startFeed();
  await settle();
  assert.deepEqual([adapter.feed().state, heard], ["connected", [{ threadIds: null }]]);
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "first");
  const connectedSince = adapter.feed().since;
  // T3 goes away: its side closes the socket.
  snapshotTitle = "second";
  t3.feedSocket().close();
  await settle();
  const down = adapter.feed();
  assert.deepEqual([down.state, down.error], ["down", "T3 closed the connection"]);
  assert.ok(down.since >= connectedSince);
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "t", "over HTTP meanwhile");
  assert.equal(gets(), 2, "afresh: the HTTP snapshot cached before the feed was live is not reused");
  await sleep(40);
  await settle();
  assert.deepEqual([adapter.feed().state, adapter.feed().error], ["connected", null]);
  assert.equal(t3.sockets.filter((s) => s.subscriptions.size > 0).length, 2);
  assert.deepEqual(t3.feedSocket().sent.filter((f) => f._tag === "Request").map((f) => f.tag), [SHELL, ARCHIVED], "subscribed again");
  assert.equal(new URL(t3.feedSocket().url).searchParams.get("wsTicket"), "tk2");
  assert.deepEqual(heard, [{ threadIds: null }, { threadIds: null }], "heard of once per connection, nothing on the drop");
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "second");
  assert.equal(gets(), 2);

  // T3 stays away: the retries back off (10, 20, 40, 40 ms ...), never a tight loop.
  const ticketsBefore = calls.filter((c) => c.url.endsWith("/api/auth/websocket-ticket")).length;
  const failing = new Set<string>(["POST /api/auth/websocket-ticket"]);
  (adapter as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: {}, body: null });
    if (failing.has(`${init?.method ?? "GET"} ${path}`)) throw new TypeError("fetch failed (connection refused)");
    return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
  }) as typeof fetch;
  t3.feedSocket().close();
  await sleep(200);
  const attempts = calls.filter((c) => c.url.endsWith("/api/auth/websocket-ticket")).length - ticketsBefore;
  assert.ok(attempts >= 3 && attempts <= 8, `${attempts} attempts in 200 ms`);
  assert.match(adapter.feed().error ?? "", /cannot reach T3/);
  adapter.close();
});

test("a feed socket T3 has gone silent on is given up after three pings, and opened again", async () => {
  const t3 = streamingT3(opening);
  const { adapter } = feedAdapter(t3, { pingMs: 15 });
  adapter.startFeed();
  await settle();
  const first = t3.feedSocket();
  assert.equal(adapter.feed().state, "connected");
  await sleep(40);
  assert.ok(first.sent.some((f) => f._tag === "Ping"), "pinged");
  assert.equal(adapter.feed().state, "connected", "T3 answers its pings");
  first.silent = true;
  await sleep(120);
  await settle();
  assert.ok(first.closed, "the silent socket is closed");
  assert.notEqual(t3.feedSocket(), first);
  assert.equal(adapter.feed().state, "connected");
  adapter.close();
});

test("closing the adapter stops the feed: its subscriptions are interrupted, its socket closed, and nothing reconnects", async () => {
  const t3 = streamingT3(opening);
  const { adapter, gets } = feedAdapter(t3);
  await adapter.listThreads();
  adapter.startFeed();
  await settle();
  const socket = t3.feedSocket();
  adapter.close();
  await settle();
  await adapter.listThreads();
  assert.equal(gets(), 2, "over HTTP afresh: the snapshot cached before the feed was live is not reused");
  assert.deepEqual(socket.sent.filter((f) => f._tag === "Interrupt").map((f) => f.requestId).sort(), [socket.subscriptions.get(SHELL)!.id, socket.subscriptions.get(ARCHIVED)!.id].sort());
  assert.ok(socket.closed);
  assert.deepEqual([adapter.feed().state, adapter.feed().error], ["down", "stopped"]);
  await sleep(60);
  assert.equal(t3.sockets.length, 1, "no reconnect after close");

  // Closed while waiting to reconnect: the retry is called off.
  const again = streamingT3(opening);
  const second = feedAdapter(again);
  second.adapter.startFeed();
  await settle();
  again.feedSocket().close();
  await settle();
  assert.equal(second.adapter.feed().state, "down");
  second.adapter.close();
  await sleep(60);
  assert.equal(again.sockets.length, 1);
});

test("a new token reopens the feed with a ticket asked for with it", async () => {
  const t3 = streamingT3(opening);
  const { adapter, calls } = feedAdapter(t3);
  adapter.startFeed();
  await settle();
  const first = t3.feedSocket();
  adapter.setAccessToken("tok2");
  assert.equal(adapter.feed().state, "connecting");
  await settle();
  assert.ok(first.closed);
  assert.equal(adapter.feed().state, "connected");
  assert.equal(calls.filter((c) => c.url.endsWith("/api/auth/websocket-ticket")).at(-1)?.headers.authorization, "Bearer tok2");
  adapter.close();
});

test("a shell change is heard of once it is applied, naming its threads; a listener removed hears nothing more", async () => {
  const t3 = streamingT3(opening);
  const { adapter } = feedAdapter(t3);
  const seen: Array<{ threadIds: readonly string[] | null; title: string | undefined }> = [];
  const off = adapter.onShellChange((change) => {
    // A read made by the listener sees the change; the feed answers it at once.
    void adapter.getThreadShell("thread-1").then((thread) => seen.push({ threadIds: change.threadIds, title: thread?.title }));
  });
  adapter.startFeed();
  await settle();
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 11, location: "active", thread: { ...threadShell, title: "renamed" } }, { kind: "thread.updated", sequence: 12, location: "active", thread: { ...threadShell, id: "thread-2" } });
  await settle();
  t3.feedSocket().push(SHELL, { kind: "project.updated", sequence: 13, project: shell.projects[0] });
  // Nothing changed: not heard of.
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 9, location: "active", thread: threadShell });
  await settle();
  assert.deepEqual(seen, [
    { threadIds: null, title: "t" },
    { threadIds: ["thread-1", "thread-2"], title: "renamed" },
    { threadIds: [], title: "renamed" },
  ]);
  off();
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 14, location: "active", thread: { ...threadShell, title: "again" } });
  await settle();
  assert.equal(seen.length, 3);
  adapter.close();
});

test("after a command the reads go over HTTP until the feed shows T3's sequence for it, then to the feed again", async (t) => {
  let title = "before";
  const t3 = streamingT3(opening, { "orchestration.dispatchCommand": () => ({ sequence: 15 }), "projects.mutate": () => ({}) });
  const { adapter, gets } = feedAdapter(t3, { shellBody: () => ({ ...activeShell, snapshotSequence: 15, threads: [{ ...threadShell, title }] }) });
  adapter.startFeed();
  await settle();
  title = "after";
  await adapter.setThreadTitle({ commandId: "c1", threadId: "thread-1", title: "after" });
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "after", "the read after the command sees it");
  assert.equal(gets(), 1);
  // The feed has a change at sequence 14 only: still behind the command.
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 14, location: "active", thread: { ...threadShell, title: "before" } });
  await settle();
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "after");
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 15, location: "active", thread: { ...threadShell, title: "after" } });
  await settle();
  const gotten = gets();
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "after");
  assert.equal(gets(), gotten, "caught up: from the feed");
  // A command T3 answers with no sequence: over HTTP for a second at most, then the feed.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await adapter.createProject({ commandId: "c2", projectId: "p2", title: "p2", workspaceRoot: "/tmp/p2", createIfMissing: false });
  await adapter.listProjects();
  assert.equal(gets(), gotten + 1);
  t.mock.timers.tick(1_001);
  await adapter.listProjects();
  assert.equal(gets(), gotten + 1, "past the catch-up limit: from the feed");
  // A floor past its time holds nothing: a command the feed has already shown reads from the feed at once.
  await adapter.createProject({ commandId: "c3", projectId: "p3", title: "p3", workspaceRoot: "/tmp/p3", createIfMissing: false });
  t.mock.timers.tick(1_001);
  await adapter.setThreadTitle({ commandId: "c4", threadId: "thread-1", title: "after" });
  await adapter.listProjects();
  assert.equal(gets(), gotten + 1, "T3's sequence 15 is shown already: no HTTP read");
  t.mock.timers.reset();
  adapter.close();
});

test("a feed socket that fails to open says why", async () => {
  class Refused {
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string) {
      queueMicrotask(() => {
        for (const type of ["error", "close"]) for (const listener of this.listeners.get(type) ?? []) listener({});
      });
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(): void {}
    close(): void {}
  }
  const { fetchImpl } = mockFetch(base);
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Refused, feed: { retryMs: 60_000 } });
  adapter.startFeed();
  await settle();
  assert.deepEqual([adapter.feed().state, adapter.feed().error], ["down", "T3 RPC orchestration.subscribeShell: websocket error"]);
  adapter.close();
});

test("T3 reporting a defect on a socket fails what waits on it at once, as unknown", async () => {
  const { fetchImpl } = mockFetch(base);
  let socket: { message: (value: unknown) => void } | null = null;
  const t3 = streamingT3(() => ({}), {
    "orchestration.dispatchCommand": () => {
      queueMicrotask(() => socket?.message({ _tag: "Defect", defect: "Invalid request id" }));
      return new Promise(() => {});
    },
  });
  class Socket extends t3.Socket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  }
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 10_000 });
  const started = Date.now();
  const error = await adapter.setThreadLifecycle({ commandId: "c", threadId: "thread-1", action: "settle" }).catch((caught: unknown) => caught);
  assert.ok(error instanceof T3OutcomeUnknown, String(error));
  assert.match((error as Error).message, /defect on the connection: "Invalid request id"/);
  assert.ok(Date.now() - started < 1_000, "not left to the time limit");
  adapter.close();
});

test("GET /api/status reports the shell feed under t3", async (t) => {
  const { createStack } = await import("../src/app/bootstrap.ts");
  const { createHttpApp } = await import("../src/server/http.ts");
  const { loadConfig } = await import("../src/config.ts");
  const t3 = streamingT3(opening);
  const { adapter } = feedAdapter(t3);
  const stack = createStack({ dbPath: ":memory:", adapter, briefingBudgetChars: 60_000, latestRelease: async () => null });
  t.after(() => {
    stack.close();
    adapter.close();
  });
  const app = createHttpApp(stack, loadConfig({ ROOMS_DATA_DIR: "/nonexistent/rooms-test-feed", ROOMS_PORT: "0", T3_BASE_URL: "http://t3.local:3773" }), "/nonexistent/dist");
  const status = async () => ((await (await app.request("/api/status")).json()) as { t3: { feed: unknown } }).t3.feed;
  assert.deepEqual(await status(), adapter.feed());
  assert.deepEqual((await status()) as { state: string; error: string }, { ...adapter.feed(), state: "down", error: "not started" });
  adapter.startFeed();
  await settle();
  const live = (await status()) as { state: string; since: string; error: string | null };
  assert.deepEqual([live.state, live.error, live.since], ["connected", null, adapter.feed().since]);
  t3.feedSocket().close();
  await settle();
  assert.deepEqual(((await status()) as { state: string; error: string }).state, "down");
});

// ---------------- review findings (deliverable A review) ----------------

test("the feed's heartbeat holds one timer at a time, however long the socket stays open", async () => {
  const t3 = streamingT3(opening);
  const { adapter } = feedAdapter(t3, { pingMs: 10 });
  adapter.startFeed();
  await settle();
  const timers = () => (adapter as unknown as { shellFeed: { timers: Set<unknown> } }).shellFeed.timers.size;
  await sleep(300);
  assert.equal(adapter.feed().state, "connected");
  assert.ok(t3.feedSocket().sent.filter((f) => f._tag === "Ping").length >= 10, "pinged all along");
  assert.ok(timers() <= 2, `${timers()} timers held after 300 ms of pings`);
  adapter.close();
  assert.equal(timers(), 0);
});

test("after a command, a change on the archived stream does not count as the feed showing it", async () => {
  let title = "before";
  const t3 = streamingT3(opening, { "orchestration.dispatchCommand": () => ({ sequence: 15 }) });
  const { adapter, gets } = feedAdapter(t3, { shellBody: () => ({ ...activeShell, snapshotSequence: 16, threads: [{ ...threadShell, title }] }) });
  adapter.startFeed();
  await settle();
  title = "after";
  await adapter.setThreadTitle({ commandId: "c1", threadId: "thread-1", title: "after" });
  // Another thread is archived in T3 at 16; the archived stream tells it before the active stream tells 15.
  t3.feedSocket().push(ARCHIVED, { kind: "thread.updated", sequence: 16, thread: { ...threadShell, id: "thread-x", archivedAt: "2026-10-03T00:00:09.000Z", updatedAt: "2026-10-03T00:00:09.000Z" } });
  await settle();
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "after");
  assert.equal(gets(), 1, "over HTTP");
  adapter.close();
});

test("during the wait after a command T3 gave no sequence for, a read made after a change is heard of sees it", async () => {
  // T3's HTTP snapshot is T3's state: it has the rename by the time T3 streams it.
  let title = "t";
  const t3 = streamingT3(opening, { "projects.mutate": () => ({}) });
  const { adapter } = feedAdapter(t3, { shellBody: () => ({ ...activeShell, threads: [{ ...threadShell, title }] }) });
  adapter.startFeed();
  await settle();
  await adapter.createProject({ commandId: "c2", projectId: "p2", title: "p2", workspaceRoot: "/tmp/p2", createIfMissing: false });
  assert.equal((await adapter.getThreadShell("thread-1"))?.title, "t", "over HTTP, and cached");
  const seen: string[] = [];
  adapter.onShellChange(() => void adapter.getThreadShell("thread-1").then((thread) => seen.push(thread?.title ?? "none")));
  title = "renamed";
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 11, location: "active", thread: { ...threadShell, title: "renamed", updatedAt: "2026-10-03T00:00:05.000Z" } });
  await settle();
  assert.deepEqual(seen, ["renamed"]);
  adapter.close();
});

test("a read made after a command is answered from the feed once it shows the command, not held behind a slow HTTP snapshot", async () => {
  // T3 is slow with its snapshots, the archived one too.
  const t3 = streamingT3(opening, { "orchestration.dispatchCommand": () => ({ sequence: 15 }), "orchestration.getArchivedShellSnapshot": () => new Promise(() => {}) });
  const held: Array<() => void> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path === "/api/auth/websocket-ticket") return new Response(JSON.stringify({ ticket: "tk" }), { status: 200 });
    await new Promise<void>((resolve) => held.push(resolve));
    return new Response(JSON.stringify(activeShell), { status: 200 });
  }) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: t3.Socket, requestTimeoutMs: 5_000 });
  adapter.startFeed();
  await settle();
  await adapter.setThreadTitle({ commandId: "c1", threadId: "thread-1", title: "after" });
  let answered: string | undefined;
  const read = adapter.getThreadShell("thread-1").then((thread) => (answered = thread?.title));
  const archived = adapter.listArchivedThreads();
  await settle();
  assert.equal(held.length, 1, "over HTTP while the feed has not shown the command");
  t3.feedSocket().push(SHELL, { kind: "thread.updated", sequence: 15, location: "active", thread: { ...threadShell, title: "after" } });
  await settle();
  assert.equal(answered, "after", "answered from the feed while the HTTP snapshot is still unanswered");
  assert.deepEqual((await archived).map((t) => t.id), ["thread-old"], "the archived threads too");
  held.splice(0).forEach((release) => release());
  await read;
  adapter.close();
});

test("archived thread reads without the feed share one call in flight, and take the feed when it comes live first", async () => {
  const t3 = streamingT3(() => ({ [SHELL]: [], [ARCHIVED]: [] }), { "orchestration.getArchivedShellSnapshot": () => new Promise(() => {}) });
  const { adapter } = feedAdapter(t3);
  adapter.startFeed();
  await settle();
  const first = adapter.listArchivedThreads();
  const second = adapter.listArchivedThreads();
  await settle();
  const calls = t3.sockets.flatMap((socket) => socket.sent).filter((f) => f.tag === "orchestration.getArchivedShellSnapshot");
  assert.equal(calls.length, 1, "one call for both reads");
  t3.feedSocket().push(SHELL, { kind: "snapshot", snapshot: activeShell });
  t3.feedSocket().push(ARCHIVED, { kind: "snapshot", snapshot: { ...archivedShell, threads: [{ ...shell.archivedThreads[0], title: "from the feed" }] } });
  await settle();
  assert.deepEqual((await Promise.all([first, second])).map((list) => list.map((t) => t.title)), [["from the feed"], ["from the feed"]]);
  adapter.close();
});

test("a new token while the feed's first ticket is still coming leaves one feed socket open, the new token's", async () => {
  const t3 = streamingT3(opening);
  let tickets = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path === "/api/auth/websocket-ticket") {
      const n = ++tickets;
      if (n === 1) await sleep(30);
      return new Response(JSON.stringify({ ticket: `tk${n}` }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: t3.Socket, requestTimeoutMs: 2_000, feed: { pingMs: 1_000, retryMs: 10, retryMaxMs: 40 } });
  adapter.startFeed();
  await sleep(5);
  adapter.setAccessToken("tok2");
  await sleep(60);
  await settle();
  const open = () => t3.sockets.filter((s) => !s.closed).map((s) => new URL(s.url).searchParams.get("wsTicket"));
  assert.equal(adapter.feed().state, "connected");
  assert.deepEqual(open(), ["tk2"]);
  adapter.close();
  await settle();
  assert.deepEqual(open(), []);
});

test("a T3 that takes the subscriptions and never sends its snapshots is given up at the time limit, and asked again", async () => {
  const t3 = streamingT3(() => ({ [SHELL]: [], [ARCHIVED]: [] }));
  const { adapter } = feedAdapter(t3, { requestTimeoutMs: 60 });
  adapter.startFeed();
  await settle();
  assert.equal(adapter.feed().state, "connecting");
  await sleep(80);
  await settle();
  assert.deepEqual([adapter.feed().state, adapter.feed().error], ["down", "T3 did not send its shell within 60 ms"]);
  assert.ok(t3.sockets[0]!.closed);
  await sleep(30);
  assert.ok(t3.sockets.length >= 2, "asked again");
  adapter.close();
});

test("a subscription T3 ends of its own counts as the feed going down, and it is opened again", async () => {
  const t3 = streamingT3(opening);
  const { adapter } = feedAdapter(t3);
  adapter.startFeed();
  await settle();
  const first = t3.feedSocket();
  first.end(SHELL, { _tag: "Success", value: null });
  await settle();
  assert.deepEqual([adapter.feed().state, adapter.feed().error], ["down", "T3 ended orchestration.subscribeShell"]);
  assert.ok(first.closed);
  await sleep(30);
  await settle();
  assert.equal(adapter.feed().state, "connected");
  assert.notEqual(t3.feedSocket(), first);
  adapter.close();
});

test("the reconnect wait starts again from its shortest once the feed was live", async () => {
  const t3 = streamingT3(opening);
  let refusals = 4;
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify(ENVIRONMENT), { status: 200 });
    if (path === "/api/auth/websocket-ticket") {
      if (refusals > 0) {
        refusals -= 1;
        return new Response("{}", { status: 503 });
      }
      return new Response(JSON.stringify({ ticket: "tk" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: t3.Socket, requestTimeoutMs: 2_000, feed: { pingMs: 1_000, retryMs: 10, retryMaxMs: 1_000 } });
  adapter.startFeed();
  // Four refusals: waits of 10, 20, 40 and 80 ms, then the feed is live.
  for (let i = 0; i < 100 && adapter.feed().state !== "connected"; i += 1) await sleep(10);
  assert.equal(adapter.feed().state, "connected");
  t3.feedSocket().close();
  const dropped = Date.now();
  for (let i = 0; i < 100 && adapter.feed().state !== "connected"; i += 1) await sleep(5);
  const waited = Date.now() - dropped;
  assert.equal(adapter.feed().state, "connected");
  assert.ok(waited < 100, `back after ${waited} ms (the fifth wait in a row would be 160 ms)`);
  adapter.close();
});
