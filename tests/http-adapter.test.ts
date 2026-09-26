/** HTTP adapter contract tests against a mocked transport: request shapes, auth handling, and response mapping. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { exchangePairingCredential, parsePairingUrl } from "../src/adapter/auth.ts";
import { T3CommandRejected, T3Unavailable } from "../src/adapter/types.ts";

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

const shell = {
  snapshotSequence: 10,
  projects: [{ id: "proj", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: { instanceId: "codex", model: "gpt-6-sol" } }],
  threads: [
    {
      id: "thread-1", projectId: "proj", title: "t", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access",
      interactionMode: "default", branch: null, worktreePath: null, session: { status: "running", activeTurnId: "turn-1", lastError: null },
      latestTurn: { turnId: "turn-1", state: "running", completedAt: null, assistantMessageId: null }, hasPendingApprovals: false,
      hasPendingUserInput: true, archivedAt: null, deletedAt: null, updatedAt: "2026-09-23T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-09-23T00:00:00.000Z",
};

test("thread.turn.start is dispatched with the contract's required fields and a bearer header", async () => {
  const { fetchImpl, calls } = mockFetch({ "POST /api/orchestration/dispatch": () => ({ status: 200, body: { sequence: 11 } }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773/", accessToken: "secret-token", fetchImpl });
  await adapter.startTurn({
    commandId: "cmd-1", threadId: "thread-1", messageId: "msg-1", text: "hello", runtimeMode: "approval-required", interactionMode: "default",
    modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, titleSeed: "sol1: hello",
  });
  const call = calls[0]!;
  assert.equal(call.url, "http://t3.local:3773/api/orchestration/dispatch");
  assert.equal(call.headers.authorization, "Bearer secret-token");
  const body = JSON.parse(call.body!);
  assert.equal(body.type, "thread.turn.start");
  assert.equal(body.commandId, "cmd-1");
  assert.deepEqual(body.message, { messageId: "msg-1", role: "user", text: "hello", attachments: [] });
  assert.equal(body.runtimeMode, "approval-required");
  assert.equal(body.interactionMode, "default");
  assert.equal(body.titleSeed, "sol1: hello");
  assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!("bootstrap" in body), "no bootstrap block; threads are created explicitly");
});

test("thread.create sends null branch/worktree so the agent owns its workspace strategy", async () => {
  const { fetchImpl, calls } = mockFetch({ "POST /api/orchestration/dispatch": () => ({ status: 200, body: { sequence: 12 } }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl });
  await adapter.createThread({ commandId: "c", threadId: "t", projectId: "proj", title: "room · sol1", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, runtimeMode: "full-access", interactionMode: "default" });
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.type, "thread.create");
  assert.equal(body.branch, null);
  assert.equal(body.worktreePath, null);
  assert.equal(body.projectId, "proj");
});

test("shell snapshot maps projects and thread shells, including pending-input flags", async () => {
  const { fetchImpl, calls } = mockFetch({ "GET /api/orchestration/shell": () => ({ status: 200, body: shell }) });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, shellCacheMs: 10_000 });
  const projects = await adapter.listProjects();
  assert.deepEqual(projects, [{ id: "proj", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: { instanceId: "codex", model: "gpt-6-sol" }, defaultThreadEnvMode: null }]);
  const thread = await adapter.getThreadShell("thread-1");
  assert.equal(thread?.session?.activeTurnId, "turn-1");
  assert.equal(thread?.hasPendingUserInput, true);
  assert.equal(calls.length, 1, "shell snapshot is cached within a tick");
  const catalog = await adapter.listCatalog();
  assert.ok(catalog.some((c) => c.instanceId === "codex" && c.model === "gpt-6-sol" && c.source === "observed"));
});

test("thread detail derives pending requests from activities and returns null for 404", async () => {
  const detail = {
    snapshotSequence: 10,
    thread: {
      ...shell.threads[0],
      messages: [
        { id: "msg-1", role: "user", text: "hi", turnId: "turn-1", streaming: false, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "" },
        { id: "assistant:1", role: "assistant", text: "partial", turnId: "turn-1", streaming: true, createdAt: "2026-09-23T00:00:01.000Z", updatedAt: "" },
      ],
      activities: [
        { id: "a1", tone: "approval", kind: "approval.requested", summary: "Approval", payload: { requestId: "req-1", requestType: "command" }, turnId: "turn-1", createdAt: "" },
        { id: "a2", tone: "approval", kind: "approval.resolved", summary: "Approval", payload: { requestId: "req-1", decision: "accept" }, turnId: "turn-1", createdAt: "" },
        { id: "a3", tone: "info", kind: "user-input.requested", summary: "Question", payload: { requestId: "req-2", questions: [] }, turnId: "turn-1", createdAt: "" },
      ],
      checkpoints: [],
    },
  };
  const { fetchImpl, calls } = mockFetch({
    "GET /api/orchestration/threads/thread-1": () => ({ status: 200, body: detail }),
    "GET /api/orchestration/threads/missing": () => ({ status: 404, body: { error: "not found" } }),
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl });
  const loaded = await adapter.getThreadDetail("thread-1", { turnLimit: 3 });
  assert.ok(calls[0]!.url.endsWith("/api/orchestration/threads/thread-1?turnLimit=3"));
  assert.equal(loaded?.shell.hasPendingApprovals, false, "resolved approval is not pending");
  assert.equal(loaded?.shell.hasPendingUserInput, true);
  assert.equal(loaded?.messages.find((m) => m.id === "msg-1")?.turnId, "turn-1");
  assert.equal(await adapter.getThreadDetail("missing"), null);
});

test("401/403 and network failures are T3Unavailable; 4xx rejections are T3CommandRejected", async () => {
  const { fetchImpl } = mockFetch({
    "GET /api/orchestration/shell": () => ({ status: 401, body: { error: "unauthorized" } }),
    "POST /api/orchestration/dispatch": () => ({ status: 422, body: { error: "invalid command" } }),
  });
  const adapter = new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "expired", fetchImpl });
  await assert.rejects(adapter.listThreads(), (error: unknown) => error instanceof T3Unavailable && /re-pair/.test(error.message));
  await assert.rejects(
    adapter.interruptTurn({ commandId: "c", threadId: "t", turnId: null }),
    (error: unknown) => error instanceof T3CommandRejected && error.status === 422,
  );
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
  await assert.rejects(adapter.listProjects(), (error: Error) => error instanceof T3Unavailable && /did not answer GET \/api\/orchestration\/shell within 50ms/.test(error.message));
  assert.ok(Date.now() - started < 2000, "gives up at the limit");
});
