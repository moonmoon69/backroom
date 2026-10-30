/**
 * A secret a member's agent asks the user for (T3's request_secret tool): read from T3's projection as a request, answered
 * from the page over secrets.answerRequest, and never written or said back anywhere by Backroom.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { persistFake } from "../src/adapter/fakeState.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { SECRET_REFUSALS, T3CommandRejected, T3OutcomeUnknown, T3ScopeMissing, T3SecretRefused, T3Unavailable, openRequests, type SecretAnswer } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { EngineRoomSnapshot } from "../src/domain/engineView.ts";
import { withFakeControls } from "../src/server/fakeControls.ts";
import { createHttpApp } from "../src/server/http.ts";
import { describeStatus } from "../web/src/memberActivity.ts";
import { requestsWhat } from "../web/src/requestWords.ts";

/** A value no other text in a test contains: wherever it turns up, the secret leaked there. */
const SENTINEL = "s3cr3t-SENTINEL-7f1e9a";

// ---------------- T3's projection ----------------

const THREAD = "d63512ee-0de9-4d36-8941-21713a5ae0fb";
const RUN = `run:thread:${THREAD}:ordinal:40`;
const DONE = `run:thread:${THREAD}:ordinal:39`;
const NODE = "node:run:run%3Athread%3Ad63512ee-0de9-4d36-8941-21713a5ae0fb%3Aordinal%3A40:root";

/** The item T3 wrote for the user's secret on 2026-10-29 (statev2.sqlite, orchestration_v2_projection_turn_items). */
const LIVE_SAVED = {
  id: `turn-item:secret-request:${THREAD}:smoke-admin-password-1`, threadId: THREAD, runId: RUN, nodeId: NODE,
  providerThreadId: "provider-thread:provider:claudeAgent:native-thread:pending%3Arun%3Athread%3Ad63512ee-0de9-4d36-8941-21713a5ae0fb%3Aordinal%3A1",
  providerTurnId: "provider-turn:provider:claudeAgent:native-turn:turn%3Arun-attempt%3Arun%3Arun%253Athread%253Ad63512ee-0de9-4d36-8941-21713a5ae0fb%253Aordinal%253A40%3Aattempt%3A1",
  nativeItemRef: null, parentItemId: null, ordinal: 40000011, status: "completed", title: "shop.example admin password for owner@example.com",
  startedAt: "2026-10-29T12:44:16.533Z", completedAt: "2026-10-29T12:48:55.458Z", updatedAt: "2026-10-29T12:48:55.458Z", type: "secret_request",
  label: "shop.example admin password for owner@example.com",
  reason: "To run the smoke's ban step against production: it signs in to /admin as this operator, bans the smoke's throwaway identity and checks the push token is revoked. The value goes only into the smoke's environment on this machine.",
  delivery: "file", secretStatus: "saved",
};
/** Its declined sibling, the same day: T3 ends a declined request as status "cancelled". */
const LIVE_DECLINED = { ...LIVE_SAVED, id: `turn-item:secret-request:${THREAD}:smoke-admin-totp-1`, ordinal: 40000013, status: "cancelled", title: "shop.example admin TOTP secret", label: "shop.example admin TOTP secret", secretStatus: "declined" };
/** The first one as it stood while it waited. */
const PENDING = { ...LIVE_SAVED, id: `turn-item:secret-request:${THREAD}:pending-1`, ordinal: 40000020, status: "waiting", completedAt: null, updatedAt: "2026-10-29T12:44:16.533Z", secretStatus: "pending", placeholder: "password" };

function projection() {
  const run = (id: string, ordinal: number, status: string) => ({ id, threadId: THREAD, ordinal, providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, userMessageId: `msg-${ordinal}`, status, queuePosition: null, requestedAt: "2026-10-29T12:40:00.000Z", startedAt: "2026-10-29T12:40:00.500Z", completedAt: status === "completed" ? "2026-10-29T12:41:00.000Z" : null, checkpointId: null });
  return {
    thread: { id: THREAD, projectId: "proj", title: "smoke", providerInstanceId: "claudeAgent", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, archivedAt: null, settledAt: null, deletedAt: null, createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:44:16.533Z" },
    runs: [run(DONE, 39, "completed"), run(RUN, 40, "running")],
    messages: [],
    turnItems: [
      LIVE_SAVED,
      LIVE_DECLINED,
      PENDING,
      // Pending, but nothing can take it: no node, a run that ended, a run T3 does not list.
      { ...PENDING, id: "turn-item:secret-request:no-node", ordinal: 40000021, nodeId: null },
      { ...PENDING, id: "turn-item:secret-request:ended-run", ordinal: 39000001, runId: DONE },
      { ...PENDING, id: "turn-item:secret-request:orphan", ordinal: 40000022, runId: "run:thread:gone:ordinal:1" },
      // A timeout ends it as cancelled ("timed_out" is only what the agent is told).
      { ...PENDING, id: "turn-item:secret-request:timed-out", ordinal: 40000023, status: "cancelled", secretStatus: "cancelled" },
      { ...PENDING, id: "turn-item:secret-request:unknown-status", ordinal: 40000024, secretStatus: "timed_out" },
      { id: "item-approval", threadId: THREAD, runId: RUN, nodeId: "node-a", providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 40000001, status: "completed", title: null, startedAt: "2026-10-29T12:42:00.000Z", completedAt: "2026-10-29T12:42:01.000Z", updatedAt: "2026-10-29T12:42:01.000Z", type: "approval_request", requestId: "req-approval", requestKind: "command", prompt: "npm test" },
    ],
    runtimeRequests: [{ id: "req-approval", nodeId: "node-a", providerTurnId: null, nativeRequestRef: null, kind: "command", status: "resolved", responseCapability: { type: "live" }, createdAt: "2026-10-29T12:42:00.000Z", resolvedAt: "2026-10-29T12:42:01.000Z", decision: "accept" }],
    nodes: [], attempts: [], subagents: [], providerSessions: [], providerTurns: [], plans: [], checkpoints: [], checkpointScopes: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], providerThreads: [],
    updatedAt: "2026-10-29T12:44:16.533Z",
  };
}

const ENVIRONMENT = { environmentId: "env", label: "box", serverVersion: "0.1.3-nightly.20261027.3748", orchestrationProtocolVersion: 2 };

/** T3 over HTTP and its RPC socket: `answer` plays secrets.answerRequest (throw { rpcError } to refuse; a promise that never settles to hang). */
function t3(answer: (payload: any) => unknown = () => null) {
  const frames: any[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    const body = path === "/.well-known/t3/environment" ? ENVIRONMENT : path === "/api/auth/websocket-ticket" ? { ticket: "tk" } : path === `/api/orchestration/threads/${THREAD}` ? { snapshotSequence: 3, projection: projection() } : path === "/api/orchestration/shell" ? { schemaVersion: 2, snapshotSequence: 3, projects: [], threads: [] } : null;
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  class Socket {
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      frames.push(frame);
      const exit = (value: unknown) => this.emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: value }) });
      const fail = (error: any) => exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: error.rpcError }] });
      queueMicrotask(() => {
        let value: unknown;
        try {
          value = frame.tag === "secrets.answerRequest" ? answer(frame.payload) : null;
        } catch (error) {
          return fail(error);
        }
        if (value instanceof Promise) value.then((late) => exit({ _tag: "Success", value: late ?? null }), fail);
        else exit({ _tag: "Success", value: value ?? null });
      });
    }
    close(): void {
      this.emit("close", {});
    }
  }
  return { adapter: new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket }), frames };
}

/** Everything an error carries, as a log or a debugger would print it. */
const everything = (error: unknown): string => `${String(error)}\n${inspect(error, { depth: Infinity, showHidden: true })}\n${JSON.stringify(error)}\n${(error as Error).stack ?? ""}`;

test("a secret T3 waits on is read from its turn item: one live request per pending item on a run in progress, and nothing for the rest", async () => {
  const { adapter } = t3();
  const detail = (await adapter.getThreadDetail(THREAD))!;
  assert.deepEqual(detail.turnItems.find((item) => item.id === LIVE_SAVED.id), {
    id: LIVE_SAVED.id, runId: RUN, nodeId: NODE, providerTurnId: LIVE_SAVED.providerTurnId, ordinal: 40000011, status: "completed", title: LIVE_SAVED.title,
    startedAt: "2026-10-29T12:44:16.533Z", completedAt: "2026-10-29T12:48:55.458Z", updatedAt: "2026-10-29T12:48:55.458Z",
    type: "secret_request", label: LIVE_SAVED.label, reason: LIVE_SAVED.reason, placeholder: null, delivery: "file", secretStatus: "saved",
  }, "the item T3 wrote, field for field");
  assert.deepEqual(detail.turnItems.filter((item) => item.type === "secret_request").map((item) => item.type === "secret_request" && [item.id.split(":").pop(), item.secretStatus]), [
    ["ended-run", "pending"], ["smoke-admin-password-1", "saved"], ["smoke-admin-totp-1", "declined"], ["pending-1", "pending"], ["no-node", "pending"], ["orphan", "pending"], ["timed-out", "cancelled"], ["unknown-status", "cancelled"],
  ]);
  const secrets = detail.runtimeRequests.filter((request) => request.type === "secret");
  assert.deepEqual(secrets, [{
    id: PENDING.id, kind: "secret_request", type: "secret", status: "pending", responseMode: "live", runId: RUN, nodeId: NODE, createdAt: "2026-10-29T12:44:16.533Z", resolvedAt: null,
    prompt: PENDING.label, options: null, appName: null, questions: [], secret: { label: PENDING.label, reason: PENDING.reason, placeholder: "password", delivery: "file" }, decision: null, answers: null,
  }], "only the pending item on the running run, with what it asks");
  assert.deepEqual(openRequests(detail).map((request) => request.id), [PENDING.id]);
  assert.deepEqual(detail.shell.pendingRequest, { id: PENDING.id, kind: "secret_request", createdAt: "2026-10-29T12:44:16.533Z" }, "the thread waits on it");
  assert.deepEqual(detail.runtimeRequests.filter((request) => request.type === "approval").map((request) => [request.id, request.status, request.prompt, request.secret]), [["req-approval", "resolved", "npm test", null]], "approvals are read as before");
  adapter.close();
});

test("an answer goes to T3's secrets.answerRequest exactly as typed, and a decline as a decline", async () => {
  const { adapter, frames } = t3();
  const typed = `  ${SENTINEL} `;
  await adapter.respondSecret({ threadId: THREAD, turnItemId: PENDING.id, answer: { type: "save", secret: typed } });
  await adapter.respondSecret({ threadId: THREAD, turnItemId: PENDING.id, answer: { type: "decline" } });
  assert.deepEqual(frames.filter((frame) => frame._tag === "Request").map((frame) => [frame.tag, frame.payload]), [
    ["secrets.answerRequest", { threadId: THREAD, turnItemId: PENDING.id, answer: { type: "save", secret: typed } }],
    ["secrets.answerRequest", { threadId: THREAD, turnItemId: PENDING.id, answer: { type: "decline" } }],
  ]);
  adapter.close();
});

test("T3's refusals of a secret are read by their reason, and no failure carries what was sent", async () => {
  const save: SecretAnswer = { type: "save", secret: SENTINEL };
  const refuse = (rpcError: unknown) => () => {
    throw Object.assign(new Error("refused"), { rpcError });
  };
  const failure = async (answer: (payload: any) => unknown, after?: (adapter: HttpT3Adapter) => void) => {
    const { adapter } = t3(answer);
    const pending = adapter.respondSecret({ threadId: THREAD, turnItemId: PENDING.id, answer: save }).then(() => assert.fail("T3 refused it"), (error: unknown) => error);
    after?.(adapter);
    const error = await pending;
    adapter.close();
    assert.ok(!everything(error).includes(SENTINEL), `the secret is in the error: ${everything(error)}`);
    return error as Error;
  };
  // T3's SecretRequestError crosses the wire as its tag and reason: its message is a getter, not sent.
  for (const reason of Object.keys(SECRET_REFUSALS) as Array<keyof typeof SECRET_REFUSALS>) {
    const error = await failure(refuse({ _tag: "SecretRequestError", reason, cause: { message: `could not store ${SENTINEL}`, input: SENTINEL } }));
    assert.ok(error instanceof T3SecretRefused, `${reason}: ${error}`);
    assert.deepEqual([error.reason, error.message, (error as T3SecretRefused).body], [reason, SECRET_REFUSALS[reason], null]);
  }
  assert.equal(SECRET_REFUSALS.record_failed, "Saved the secret, but could not update the request.");
  assert.deepEqual((Object.keys(SECRET_REFUSALS) as Array<keyof typeof SECRET_REFUSALS>).filter((reason) => new T3SecretRefused(reason).stale), ["not_found", "already_answered", "agent_stopped"], "record_failed is not stale: the secret was stored");
  // A failure T3 describes by echoing the input (a decoding error): only its tag is kept.
  const decoding = await failure(refuse({ _tag: "SchemaError", message: `Expected a non-blank string, got "${SENTINEL}"`, issues: [{ actual: SENTINEL }] }));
  assert.ok(decoding instanceof T3CommandRejected && !(decoding instanceof T3SecretRefused));
  assert.equal(decoding.message, "T3 refused the secret (SchemaError); nothing was saved.");
  // The pairing lacks the permission: said as such, with how to pair again.
  const scope = await failure(refuse({ _tag: "EnvironmentAuthorizationError", requiredPermission: "orchestration:operate", message: SENTINEL }));
  assert.ok(scope instanceof T3ScopeMissing && scope.scope === "orchestration:operate", String(scope));
  // Sent, and the socket went before T3 answered: T3 may have stored it.
  const unknown = await failure(() => new Promise(() => {}), (adapter) => setTimeout(() => adapter.close(), 20));
  assert.ok(unknown instanceof T3OutcomeUnknown, String(unknown));
  assert.match(unknown.message, /may have been saved/);
});

// ---------------- the service, the page's commands, and what Backroom keeps ----------------

/**
 * A service on disk, as it runs: its database, the fake T3's state file, its log, its console, the HTTP answers and
 * the event streams the page reads. `written()` is all of it.
 */
async function service(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-secret-"));
  const lines: string[] = [];
  const console_ = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const level of ["log", "error", "warn", "info"] as const) console[level] = (...args: unknown[]) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: Infinity }))).join(" "));
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const adapter = persistFake(fake, join(dir, "fake-t3.json"));
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter, briefingBudgetChars: 60000, latestRelease: async () => null, log: (message, detail) => lines.push(`${message} ${inspect(detail, { depth: Infinity })}`) });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const serve = withFakeControls(app.fetch, fake);
  const answers: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const response = await serve(new Request(`http://backroom${path}`, init));
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const command = (body: unknown) => request("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const run = (input: RoomCommandInput) => stack.service.execute(parseCommand(input));
  const { roomId } = (await run({ type: "room.create", projectId: "project_demo", title: "smoke" })) as { roomId: string };
  const seat = async (alias: string) => {
    const { participantId } = (await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, thread: { mode: "create" } })) as { participantId: string };
    return { participantId, threadId: stack.repos.currentBinding(participantId)!.threadId };
  };
  // What the page's event streams carried while the test ran.
  const streamed: string[] = [];
  const streams = await Promise.all(["/api/events", `/api/rooms/${roomId}/stream`].map(async (path) => (await app.request(path)).body!.getReader()));
  const decoder = new TextDecoder();
  for (const reader of streams) void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      streamed.push(decoder.decode(chunk.value));
    }
  })();
  let open = true;
  const close = () => {
    if (open) stack.close();
    open = false;
  };
  t.after(() => {
    for (const reader of streams) void reader.cancel().catch(() => {});
    Object.assign(console, console_);
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  const files = (at: string): string[] => readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? files(join(at, name)) : [join(at, name)]));
  const written = () => {
    // Every file Backroom and the fake T3 wrote (the database with its WAL, the fake's state), byte for byte.
    const disk = files(dir).map((file) => [file, readFileSync(file).toString("latin1")] as const);
    return [...disk, ["log and console", lines.join("\n")] as const, ["HTTP answers", answers.join("\n")] as const, ["event streams", streamed.join("")] as const];
  };
  const tick = async () => {
    await stack.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const snapshot = async () => (await request(`/api/rooms/${roomId}`)).body as EngineRoomSnapshot;
  return { dir, fake, stack, roomId, seat, run, command, request, tick, snapshot, written, lines, close };
}

/** The member's agent in a turn of its own, asking for a secret: the request's id, once the room has it. */
async function asked(s: Awaited<ReturnType<typeof service>>, threadId: string, label = "shop.example admin password") {
  if (!(await s.fake.getThreadShell(threadId))?.activeRunId) s.fake.startExternalRun(threadId, "run the smoke");
  const { body } = await s.request("/api/fake/secret", { method: "POST", body: JSON.stringify({ threadId, label, reason: "To run the ban step.", placeholder: "password", delivery: "file" }) });
  await s.tick();
  return (body as { requestId: string }).requestId;
}

const secretStatus = async (s: Awaited<ReturnType<typeof service>>, threadId: string, requestId: string) =>
  ((await s.request(`/api/fake/secret?threadId=${encodeURIComponent(threadId)}&requestId=${encodeURIComponent(requestId)}`)).body as { secretStatus: string }).secretStatus;

test("a member asking for a secret is shown and counted as needing you, and saved from the room its row goes and T3 has it", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const requestId = await asked(s, worker.threadId);
  const waiting = await s.snapshot();
  assert.deepEqual(waiting.nativeRequests.map((request) => [request.requestId, request.kind, (request.payload as { secret: unknown }).secret]), [[requestId, "secret", { label: "shop.example admin password", reason: "To run the ban step.", placeholder: "password", delivery: "file" }]]);
  assert.equal(waiting.participantStatus[worker.participantId]!.pendingSecret, true);
  assert.equal(waiting.counts.needsYou, 1);
  assert.equal(describeStatus(waiting.participantStatus[worker.participantId] as never).label, "asking for a secret");

  // It reaches T3 as typed, once.
  const received: SecretAnswer[] = [];
  const respond = s.fake.respondSecret.bind(s.fake);
  s.fake.respondSecret = async (input) => {
    received.push(structuredClone(input.answer));
    return respond(input);
  };
  const saved = await s.command({ type: "native.secret.respond", participantId: worker.participantId, requestId, answer: { type: "save", secret: ` ${SENTINEL}` } });
  assert.deepEqual([saved.status, saved.body], [200, { type: "native.responded", requestId }]);
  assert.deepEqual(received.splice(0), [{ type: "save", secret: ` ${SENTINEL}` }]);
  assert.equal(await secretStatus(s, worker.threadId, requestId), "saved");
  const after = await s.snapshot();
  assert.deepEqual([after.nativeRequests, after.participantStatus[worker.participantId]!.pendingSecret, after.counts.needsYou], [[], false, 0]);
  await s.tick();
  assert.deepEqual((await s.snapshot()).nativeRequests, [], "the mirror does not bring it back");
  // Answered once, it is no longer the room's to answer.
  const again = await s.command({ type: "native.secret.respond", participantId: worker.participantId, requestId, answer: { type: "save", secret: SENTINEL } });
  assert.equal(again.status, 404);
  assert.deepEqual(received, []);

  // Declined: T3 has it as declined, and the run goes on.
  const second = await asked(s, worker.threadId, "TOTP secret");
  const declined = await s.command({ type: "native.secret.respond", participantId: worker.participantId, requestId: second, answer: { type: "decline" } });
  assert.equal(declined.status, 200);
  assert.equal(await secretStatus(s, worker.threadId, second), "declined");
  assert.ok((await s.fake.getThreadShell(worker.threadId))?.activeRunId, "the run goes on");
  assert.equal((await s.snapshot()).counts.needsYou, 0);
});

test("a secret answer is refused for the wrong request, and T3's refusals leave the room honest", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const other = await s.seat("reviewer");
  const requestId = await asked(s, worker.threadId);
  const approval = s.fake.raiseApproval(worker.threadId);
  await s.tick();
  const save = (participantId: string, id: string, secret = SENTINEL) => s.command({ type: "native.secret.respond", participantId, requestId: id, answer: { type: "save", secret } });
  assert.equal((await save(worker.participantId, approval)).status, 404, "an approval is not a secret");
  assert.equal((await save(other.participantId, requestId)).status, 404, "another member's thread has no such request");
  assert.equal((await s.command({ type: "native.userInput.respond", participantId: worker.participantId, requestId, answers: { x: "y" } })).status, 404, "a secret is not a question");
  assert.equal(await secretStatus(s, worker.threadId, requestId), "pending");

  // T3 took the secret and could not mark the request: not a success, and the card stays.
  s.fake.secretFailure = new T3SecretRefused("record_failed");
  const recorded = await save(worker.participantId, requestId);
  assert.deepEqual([recorded.status, recorded.body.message], [502, "Saved the secret, but could not update the request."]);
  assert.ok((await s.snapshot()).nativeRequests.some((request) => request.requestId === requestId));
  // Answered meanwhile in T3's own window: T3 says so, and the card goes.
  await s.fake.respondSecret({ threadId: worker.threadId, turnItemId: requestId, answer: { type: "decline" } });
  const stale = await save(worker.participantId, requestId);
  assert.deepEqual([stale.status, stale.body], [409, { error: "secret_stale", message: "This secret request was already answered." }]);
  assert.ok(!(await s.snapshot()).nativeRequests.some((request) => request.requestId === requestId), "its row is resolved at once");
});

test("no failure on the way to T3 says the secret back, and Backroom writes it nowhere", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const requestId = await asked(s, worker.threadId);
  const body = (answer: unknown) => ({ type: "native.secret.respond", participantId: worker.participantId, requestId, answer });

  // Refused before it is sent: blank, malformed, not JSON.
  for (const [what, sent] of [
    ["blank", body({ type: "save", secret: "   " })],
    ["an extra field", body({ type: "save", secret: SENTINEL, note: SENTINEL })],
    ["an unknown answer", body({ type: SENTINEL, secret: SENTINEL })],
    ["not a string", body({ type: "save", secret: [SENTINEL] })],
    ["too long", body({ type: "save", secret: SENTINEL.repeat(4000) })],
    // JSON.parse quotes the text around where it stopped: here the secret's start.
    ["not JSON", `{"type":"native.secret.respond","answer":{"type":"save","secret":${SENTINEL}}}`],
  ] as const) {
    const refused = await s.command(sent);
    assert.equal(refused.status, 400, `${what}: ${JSON.stringify(refused.body)}`);
  }
  // Failures of the adapter, whatever they carry: in their message, their cause, their body.
  const failures: Array<[Error, number, string]> = [
    [Object.assign(new T3CommandRejected(`T3 refused: "${SENTINEL}"`, 500, { payload: SENTINEL }), { cause: new Error(SENTINEL) }), 502, "T3 refused the secret; nothing was saved."],
    [new T3Unavailable(`socket error near ${SENTINEL}`, new Error(SENTINEL)), 503, "T3 is not answering; the secret was not sent."],
    [new T3OutcomeUnknown(`timed out sending ${SENTINEL}`), 504, "T3 did not confirm the secret; it may have been saved. Look at the request before you answer it again."],
    [new TypeError(`cannot read ${SENTINEL}`), 500, "Backroom could not send the secret to T3; it may not have been saved."],
  ];
  for (const [error, status, message] of failures) {
    s.fake.secretFailure = error;
    const failed = await s.command(body({ type: "save", secret: SENTINEL }));
    assert.deepEqual([failed.status, failed.body.message], [status, message], error.name);
  }
  assert.equal(await secretStatus(s, worker.threadId, requestId), "pending");
  // Then saved; and read back everywhere the page reads.
  assert.equal((await s.command(body({ type: "save", secret: SENTINEL }))).status, 200);
  await s.tick();
  for (const path of [`/api/rooms/${s.roomId}`, `/api/rooms/${s.roomId}/desk`, `/api/rooms/${s.roomId}/participants/${worker.participantId}/live`, `/api/threads/${worker.threadId}`, "/api/rooms", "/api/overview"]) assert.equal((await s.request(path)).status, 200, path);
  // A loose thread's secret, saved from its own view.
  const { threadId } = (await s.run({ type: "thread.start", projectId: "project_demo", text: "deploy" })) as { threadId: string };
  s.fake.setHeld(threadId, true);
  const loose = await asked(s, threadId);
  assert.equal((await s.command({ type: "thread.secret.respond", threadId, requestId: loose, answer: { type: "save", secret: SENTINEL } })).status, 200);
  assert.equal(await secretStatus(s, threadId, loose), "saved");
  await s.request(`/api/threads/${threadId}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  s.close();

  const written = s.written();
  assert.ok(written.some(([name]) => name.endsWith("rooms.sqlite")) && written.some(([name]) => name.endsWith("fake-t3.json")), "the database and the fake's state were written");
  assert.ok(written.find(([name]) => name === "event streams")![1].includes("room.changed"), "the event streams were read");
  // Its start alone counts: a parser's message quotes ten characters or so.
  for (const [where, text] of written) assert.ok(!text.includes(SENTINEL.slice(0, 10)), `the secret is in ${where}`);
});

test("a loose thread's secret is answered from its own view, and a member's thread is answered from its room", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const seated = await asked(s, worker.threadId);
  const refused = await s.command({ type: "thread.secret.respond", threadId: worker.threadId, requestId: seated, answer: { type: "decline" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(await secretStatus(s, worker.threadId, seated), "pending");

  const { threadId } = (await s.run({ type: "thread.start", projectId: "project_demo", text: "deploy" })) as { threadId: string };
  s.fake.setHeld(threadId, true);
  const loose = await asked(s, threadId);
  const view = (await s.request(`/api/threads/${threadId}`)).body as { requests: Array<{ requestId: string; kind: string; payload: { secret: unknown } }>; thread: { pendingRequest: unknown } };
  assert.deepEqual(view.requests.map((request) => [request.requestId, request.kind, request.payload.secret]), [[loose, "secret", { label: "shop.example admin password", reason: "To run the ban step.", placeholder: "password", delivery: "file" }]]);
  assert.ok(view.thread.pendingRequest, "the overview ranks it as needing you");
  assert.equal((await s.command({ type: "thread.secret.respond", threadId, requestId: loose, answer: { type: "decline" } })).status, 200);
  assert.equal(await secretStatus(s, threadId, loose), "declined");
  const answered = (await s.request(`/api/threads/${threadId}`)).body as { requests: unknown[]; thread: { pendingRequest: unknown } };
  assert.deepEqual([answered.requests, answered.thread.pendingRequest], [[], null]);
  // Already answered: T3's reason, said as stale.
  const late = await s.command({ type: "thread.secret.respond", threadId, requestId: loose, answer: { type: "save", secret: SENTINEL } });
  assert.deepEqual([late.status, late.body.error], [409, "secret_stale"]);
});

test("the fake T3 asks for a secret only in a running turn, ends it with the run, and keeps no secret", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const idle = await s.request("/api/fake/secret", { method: "POST", body: JSON.stringify({ threadId: worker.threadId, label: "x" }) });
  assert.equal(idle.status, 400, "no turn to ask in");
  const requestId = await asked(s, worker.threadId);
  assert.equal((await s.fake.getThreadShell(worker.threadId))?.pendingRequest?.kind, "user_input", "T3's shell says a secret is a question");
  s.fake.completeRun(worker.threadId, { text: "gave up" });
  assert.equal(await secretStatus(s, worker.threadId, requestId), "cancelled", "the run's end cancels it");
  await s.tick();
  assert.deepEqual((await s.snapshot()).nativeRequests, [], "and the room's card goes");
  await assert.rejects(s.fake.respondSecret({ threadId: worker.threadId, turnItemId: requestId, answer: { type: "save", secret: SENTINEL } }), (error: unknown) => error instanceof T3SecretRefused && error.reason === "already_answered");
  await assert.rejects(s.fake.respondSecret({ threadId: worker.threadId, turnItemId: "nope", answer: { type: "decline" } }), (error: unknown) => error instanceof T3SecretRefused && error.reason === "not_found");
  const saved = await asked(s, worker.threadId);
  await s.fake.respondSecret({ threadId: worker.threadId, turnItemId: saved, answer: { type: "save", secret: SENTINEL } });
  assert.deepEqual(s.fake.secretAnswers.map((answer) => answer.answer), ["save"]);
  assert.ok(!JSON.stringify([s.fake.commands, s.fake.secretAnswers, s.fake.state()]).includes(SENTINEL), "neither its command record nor its state holds the secret");
});

test("the page words a secret as T3 does, and a chip with several kinds names each", () => {
  const status = { status: "running" as const, externalActivity: true, pendingApprovals: false, pendingUserInput: true, pendingSecret: true, activeRunId: null, threadMissing: false };
  assert.equal(describeStatus(status).label, "asking for a secret");
  assert.equal(describeStatus({ ...status, pendingApprovals: true }).label, "needs approval");
  assert.equal(describeStatus({ ...status, pendingSecret: false }).label, "waiting for your answer");
  assert.deepEqual([requestsWhat(["secret"]), requestsWhat(["approval", "approval"]), requestsWhat(["user-input"]), requestsWhat(["user-input", "secret"]), requestsWhat(["secret", "approval", "user-input"])], ["secret", "approval", "question", "secret and question", "approval, secret and question"]);
});

test("review: agent_stopped reaches the HTTP caller and removes the stale secret without recording a value", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const requestId = await asked(s, worker.threadId);
  s.fake.secretFailure = new T3SecretRefused("agent_stopped");
  const response = await s.command({ type: "native.secret.respond", participantId: worker.participantId, requestId, answer: { type: "save", secret: SENTINEL } });
  assert.deepEqual(response, { status: 409, body: { error: "secret_stale", message: "The agent that asked has stopped, so this secret can't be used." } });
  assert.deepEqual((await s.snapshot()).nativeRequests, []);
  assert.deepEqual(s.fake.secretAnswers, []);
  s.fake.completeRun(worker.threadId, { text: "Stopped", outcome: "interrupted" });
  await s.tick();
  assert.deepEqual((await s.snapshot()).nativeRequests, []);
  for (const [where, text] of s.written()) assert.ok(!text.includes(SENTINEL), where);
});

test("review: a reseated member and its retired predecessor cannot answer the predecessor's secret", async (t) => {
  const s = await service(t);
  const boss = await s.seat("boss");
  const worker = await s.seat("worker");
  await s.run({ type: "room.consigliere.set", roomId: s.roomId, participantId: boss.participantId });
  for (let i = 0; i < 5; i++) {
    await s.tick();
    for (const member of [boss, worker]) if ((await s.fake.getThreadShell(member.threadId))?.activeRunId) s.fake.completeRun(member.threadId, { text: "Ready." });
  }
  await s.tick();
  const requestId = await asked(s, worker.threadId);
  await s.run({ type: "participant.reseat", participantId: worker.participantId, by: boss.participantId, plan: "Continue the review." });
  s.fake.completeRun(worker.threadId, { text: "Finishing the old turn." });
  await s.tick();
  assert.ok((await s.fake.getThreadShell(worker.threadId))?.activeRunId, "the checkpoint turn has started");
  s.fake.completeRun(worker.threadId, { text: "CHECKPOINT: ready for a fresh seat." });
  await s.tick();
  const fresh = s.stack.repos.listActiveParticipants(s.roomId).find((p) => p.id !== boss.participantId);
  assert.ok(fresh && fresh.id !== worker.participantId, "a new member has taken over");
  assert.equal(s.stack.repos.currentBinding(worker.participantId), null);
  for (const participantId of [worker.participantId, fresh.id]) {
    const response = await s.command({ type: "native.secret.respond", participantId, requestId, answer: { type: "save", secret: SENTINEL } });
    assert.ok(response.status === 404 || response.status === 409, JSON.stringify(response));
  }
  assert.deepEqual(s.fake.secretAnswers, []);
  for (const [where, text] of s.written()) assert.ok(!text.includes(SENTINEL), where);
});

test("review: room messages wait while a secret blocks the turn and are steered after it is answered", async (t) => {
  const s = await service(t);
  const worker = await s.seat("worker");
  const send = (instruction: string) => s.run({ type: "message.create", roomId: s.roomId, assignments: [{ recipients: [worker.participantId], instruction }] });
  await send("Start the review.");
  await s.tick();
  const requestId = await asked(s, worker.threadId);
  const before = s.fake.steeredMessages;
  await send("Also review the error path.");
  await s.tick();
  assert.equal(s.fake.steeredMessages, before, "the blocking secret holds the new message");
  await s.command({ type: "native.secret.respond", participantId: worker.participantId, requestId, answer: { type: "decline" } });
  await s.tick();
  assert.equal(s.fake.steeredMessages, before + 1, "the message enters the same turn after the answer");
});
