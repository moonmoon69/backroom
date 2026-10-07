import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { EngineHttpT3Adapter, normalizeT3Snapshot } from "../../src/adapter/engine-http.ts";
import { HttpT3Adapter } from "../../src/adapter/http.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { T3_SERVER_VERSION, decodeOutput } from "../../src/engine/provider.ts";
import { DiskRoom } from "./store-fixture.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { OperationRoom } from "./operation-fixture.ts";
import type { OperationIntent } from "../../src/engine/operation-types.ts";
import type { ActivityIntent } from "../../src/engine/operation-types.ts";
import { canonicalJSON, resultDigest, sourceKey } from "../../src/engine/result.ts";

/** Shapes pinned to packages/contracts/src/orchestrationV2.ts, not a guarantee from these stubs. */
function raw(threadId = "thread:W") {
  return { snapshotSequence: 11, projection: {
    thread: { id: threadId, activeProviderThreadId: "pt" }, runs: [] as Record<string, unknown>[], attempts: [] as Record<string, unknown>[],
    nodes: [] as Record<string, unknown>[], subagents: [] as Record<string, unknown>[], providerTurns: [] as Record<string, unknown>[],
    providerThreads: [{ id: "pt", pendingBackgroundTasks: [] as unknown[] }], runtimeRequests: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[], turnItems: [] as Record<string, unknown>[], contextTransfers: [] as Record<string, unknown>[],
  } };
}
async function stub() {
  let projection: unknown = raw(), version = T3_SERVER_VERSION;
  const reads: string[] = [];
  const frames: unknown[] = [];
  class Socket {
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor(_url: string) { queueMicrotask(() => this.emit("open", "")); }
    addEventListener(kind: string, listener: (event: { data: string }) => void) { this.listeners.set(kind, [...this.listeners.get(kind) ?? [], listener]); }
    emit(kind: string, data: string) { for (const listener of this.listeners.get(kind) ?? []) listener({ data }); }
    send(data: string) {
      const frame = JSON.parse(data) as { tag: string; payload: unknown };
      assert.equal(frame.tag, "orchestration.dispatchCommand"); frames.push(frame.payload);
      // Public-shaped transport response loss. This fixture does not claim app acceptance.
      queueMicrotask(() => this.close());
    }
    close() { this.emit("close", ""); }
  }
  const server = createServer((req, res) => {
    reads.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/t3/environment") res.end(JSON.stringify({ environmentId: "stub-env", label: "stub", serverVersion: version, orchestrationProtocolVersion: 2 }));
    else if (req.url === "/api/orchestration/threads/thread%3AW") res.end(JSON.stringify(projection));
    else if (req.url === "/api/auth/websocket-ticket") res.end(JSON.stringify({ ticket: "test-fixture" }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const a = server.address(); assert.ok(a && typeof a === "object");
  const http = new HttpT3Adapter({ baseUrl: `http://127.0.0.1:${a.port}`, accessToken: "test-only", requestTimeoutMs: 500, webSocketImpl: Socket });
  const adapter = new EngineHttpT3Adapter(http);
  return { reads, frames, http, adapter, setProjection(value: unknown) { projection = value; }, setVersion(value: string) { version = value; },
    async close() { http.close(); server.close(); await once(server, "close"); } };
}

test("source-matched real isolated HTTP reads pin version, authenticate and use full history", async () => {
  const v = await stub();
  try { const c = await v.adapter.contract(); assert.equal(c.supported, true); assert.equal(c.durableSameId, true);
    assert.equal(c.receiptLookup, false); assert.equal(c.authoritativeAbsence, false); assert.equal(c.atomicIdleStart, false); assert.equal(c.syncExposure, false);
    const s = await v.adapter.inspect("thread:W"); assert.equal(s.complete, true); assert.equal(s.idle, true);
    assert.ok(v.reads.includes("GET /api/orchestration/threads/thread%3AW")); assert.equal(v.reads.some((p) => p.includes("bounded")), false);
    assert.equal((await v.adapter.lookup("{}")).kind, "unknown");
    v.setVersion("unreviewed-next-nightly"); assert.equal((await v.adapter.contract()).supported, false);
  } finally { await v.close(); }
});

test("pinned T3 reserved MESSAGE attempts at most two identical packets, then holds its prefix and later input", async () => {
  const v = await stub(), d = new DiskRoom();
  try { d.request("A"); const r = d.reserve("W", false); const x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    const frozen = d.p.runs.get(r.id)!.transport!.wireJSON, through = r.through;
    await x.tick(d.room, "W"); d.request("B");
    await x.tick(d.room, "W"); await x.tick(d.room, "W"); const count = d.store.load(d.room).length;
    for (let i = 0; i < 7; i++) await x.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, count); assert.equal(d.p.runs.get(r.id)!.transport!.attempts, 2);
    assert.ok((await x.tick(d.room, "W")).held.some((h) => h.code.startsWith("attempt_limit")));
    assert.deepEqual(v.frames, [JSON.parse(frozen), JSON.parse(frozen)]);
    assert.equal(d.p.runs.size, 1); assert.equal(d.p.seats.get("W")!.cursor, 0);
    assert.equal(d.p.runs.get(r.id)!.through, through); assert.equal(d.p.requests.get("B")!.state, "open");
    assert.equal(d.p.runs.get(r.id)!.transport!.wireJSON, frozen); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

for (const fault of ["partial", "version"] as const) test(`reserved policy never sends from ${fault} history/contract`, async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    d.request("A"); const r = d.reserve("W", false), x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    if (fault === "partial") v.setProjection({ ...raw(), hasMoreHistory: true }); else v.setVersion("unreviewed-version");
    for (let i = 0; i < 4; i++) await x.tick(d.room, "W");
    assert.equal(v.frames.length, 0); assert.equal(d.p.runs.get(r.id)!.transport!.attempts, 0);
    assert.equal(d.p.seats.get("W")!.cursor, 0); assert.equal(d.p.runs.size, 1); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

test("raw same-run input/output association drives actual adapter/reconciler/store recovery without send", async () => {
  const v = await stub(), d = new DiskRoom();
  try { d.request("A"); const r = d.reserve("W", false); const x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    const wire = JSON.parse(d.p.runs.get(r.id)!.transport!.wireJSON) as { text: string };
    const s = raw(); s.projection.runs.push({ id: "provider:A", userMessageId: r.dispatchMessageId, status: "completed" });
    const text = JSON.stringify({ schema: "backroom.output.v1", body: "A result", disposition: { kind: "answer", requestIds: ["A"] } });
    s.projection.messages.push({ id: r.dispatchMessageId, threadId: "thread:W", role: "user", runId: "provider:A", text: wire.text },
      { id: "out", threadId: "thread:W", role: "assistant", runId: "provider:A", text, streaming: false });
    s.projection.turnItems.push({ id: "item:out", type: "assistant_message", messageId: "out", runId: "provider:A", text, streaming: false, status: "completed" });
    v.setProjection(s); await x.tick(d.room, "W"); d.reopen(); const y = new EngineReconciler(d.store, v.adapter); await y.tick(d.room, "W");
    assert.equal(d.p.requests.get("A")!.state, "answered"); assert.equal(d.p.runs.get(r.id)!.phase, "terminal");
    assert.equal(d.p.runs.get(r.id)!.providerRunId, "provider:A"); assert.equal(d.p.runs.get(r.id)!.transport!.attempts, 0);
    assert.equal(v.reads.some((r) => r.startsWith("POST")), false); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

for (const fault of ["window", "cursor", "budget", "missing_arrays", "streaming", "truncated", "item_mismatch", "missing_roster"] as const)
  test(`source-matched normalization refuses ${fault} as completeness/idle evidence`, () => {
    const s: Record<string, unknown> = raw(); const p = (s as ReturnType<typeof raw>).projection;
    if (fault === "window") s.hasMoreHistory = true;
    if (fault === "cursor") s.historyCursor = "opaque";
    if (fault === "budget") s.payloadBudgetExceeded = true;
    if (fault === "missing_arrays") { delete (p as Record<string, unknown>).attempts; assert.throws(() => normalizeT3Snapshot(s, "thread:W")); return; }
    if (fault === "missing_roster") delete (p.providerThreads[0] as Record<string, unknown>).pendingBackgroundTasks;
    if (["streaming", "truncated", "item_mismatch"].includes(fault)) {
      p.messages.push({ id: "out", role: "assistant", runId: "run", text: "hello", streaming: fault === "streaming", textTruncated: fault === "truncated" });
      p.turnItems.push({ id: "i", type: "assistant_message", messageId: "out", runId: fault === "item_mismatch" ? "other" : "run", text: "hello", streaming: false, status: "completed" });
      assert.equal(normalizeT3Snapshot(s, "thread:W").emissions[0]!.complete, false); return;
    }
    const n = normalizeT3Snapshot(s, "thread:W"); assert.ok(!n.complete || n.issues.length); assert.ok(!n.idle || !n.complete);
  });

for (const kind of ["runs", "attempts", "nodes", "subagents", "providerTurns", "runtimeRequests", "contextTransfers"] as const)
  test(`quiescence includes source-reported ${kind}, independently of latest terminal run`, () => {
    const s = raw(); s.projection.runs.push({ id: "latest", userMessageId: "u", status: "completed" });
    s.projection[kind].push({ id: "pending", status: "pending" });
    const n = normalizeT3Snapshot(s, "thread:W"); assert.equal(n.idle, false); assert.ok(n.pending.some((p) => p.includes("pending")));
  });

test("source-reported roster includes commands/monitors/subagents, including after completed run", () => {
  const s = raw(); s.projection.runs.push({ id: "latest", userMessageId: "u", status: "completed" });
  s.projection.providerThreads[0]!.pendingBackgroundTasks = [{ taskId: "native:cmd", kind: "command" }, { taskId: "native:child", kind: "subagent" }, { taskId: "watch", kind: "monitor" }];
  const n = normalizeT3Snapshot(s, "thread:W"); assert.equal(n.idle, false); assert.equal(n.pending.length, 3);
});

test("HTTP/store observes PR watches, retains disappearance and accepts exact persisted stop T20", async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    const s = raw(), link = { host: "github", repository: "sample/repo", number: 7, source: "agent",
      watch: { startedAt: "2026-10-07T00:00:00.000Z" } };
    Object.assign(s.projection.thread, { pullRequests: [link] }); v.setProjection(s);
    const x = new EngineReconciler(d.store, v.adapter), normalized = await v.adapter.inspect("thread:W");
    assert.equal(normalized.idle, false); assert.ok(normalized.pending[0]!.startsWith("pullRequestWatch:"));
    assert.ok((await x.tick(d.room, "W")).held.some((h) => h.code === "native_pending"));
    assert.equal((await x.quiescence(d.room, "W")).proven, false);
    d.reopen(); const y = new EngineReconciler(d.store, v.adapter);
    s.snapshotSequence++; Object.assign(s.projection.thread, { pullRequests: [] });
    await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, false);
    s.snapshotSequence++; Object.assign(s.projection.thread, { pullRequests: [{ ...link, watch: undefined }] });
    await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, true);
    assert.equal(v.reads.some((r) => r.startsWith("POST")), false); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

for (const state of ["pending", "claimed", "cohort_only"] as const)
  test(`HTTP/store holds ${state} child-result wake independently of terminal run and consumed transfer T20`, async () => {
    const v = await stub(), d = new DiskRoom();
    try {
      const s = raw(), cohort = { disposition: "open", nextGeneration: 2,
        delivery: { generation: 1, messageId: "future-wake", taskIds: ["child"] } };
      s.projection.runs.push({ id: "root", userMessageId: "native-input", status: "completed", delegatedCompletion: cohort });
      if (state !== "cohort_only") s.projection.subagents.push({ id: "child", runId: "root", origin: "app_owned", status: "completed",
        completionDelivery: { state, observedByRunId: null } });
      s.projection.contextTransfers.push({ id: "child-result", type: "subagent_result", status: "consumed" });
      v.setProjection(s); const x = new EngineReconciler(d.store, v.adapter);
      const normalized = await v.adapter.inspect("thread:W");
      assert.equal(normalized.idle, false); assert.ok(normalized.pending.includes("cohort:root"));
      if (state !== "cohort_only") assert.ok(normalized.pending.includes("childDelivery:child"));
      await x.tick(d.room, "W"); d.reopen(); const y = new EngineReconciler(d.store, v.adapter);
      assert.equal((await y.quiescence(d.room, "W")).proven, false);
      s.snapshotSequence++;
      s.projection.runs[0]!.delegatedCompletion = { ...cohort, delivery: null };
      if (state !== "cohort_only") s.projection.subagents[0]!.completionDelivery = { state: "delivered", observedByRunId: null };
      await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, state === "cohort_only");
      if (state !== "cohort_only") assert.ok([...d.p.providerHolds.values()].some((h) => h.held && h.code === "native_activity:child"));
      assert.equal(v.reads.some((r) => r.startsWith("POST")), false); d.parity();
    } finally { d.cleanup(); await v.close(); }
  });

for (const background of [false, true]) test(`HTTP/store excludes current root but retains row-only causal child=${background}`, async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    d.request("A"); const r = d.reserve("W", false), x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    const wire = JSON.parse(d.p.runs.get(r.id)!.transport!.wireJSON) as { text: string }, s = raw();
    s.projection.runs.push({ id: "current", userMessageId: r.dispatchMessageId, status: "running" });
    s.projection.nodes.push({ id: "root", kind: "root_turn", runId: "current", parentNodeId: null,
      rootNodeId: "root", countsForRun: true, providerTurnId: "turn", status: "running" });
    s.projection.attempts.push({ id: "attempt", runId: "current", rootNodeId: "root", providerTurnId: "turn", status: "running" });
    s.projection.providerTurns.push({ id: "turn", nodeId: "root", runAttemptId: "attempt", status: "running" });
    const text = JSON.stringify({ schema: "backroom.output.v1", body: "A result", disposition: { kind: "answer", requestIds: ["A"] } });
    s.projection.messages.push({ id: r.dispatchMessageId, role: "user", runId: "current", text: wire.text },
      { id: "answer", role: "assistant", runId: "current", text, streaming: false });
    s.projection.turnItems.push({ id: "answer-item", type: "assistant_message", messageId: "answer", runId: "current", text, streaming: false, status: "completed" });
    if (background) {
      s.projection.nodes.push({ id: "native-bg", kind: "subagent", runId: "current", parentNodeId: "root", rootNodeId: "root", countsForRun: false, status: "running" });
    }
    v.setProjection(s); const result = await x.tick(d.room, "W");
    assert.equal(d.p.requests.get("A")!.state, background ? "open" : "answered");
    assert.equal(result.held.some((h) => h.code === "native_pending"), background);
    assert.equal(result.sent, 0);
    if (background) {
      const first = d.store.load(d.room).find((e) => e.data.kind === "output" && e.data.sourceKey.includes("answer"))!;
      assert.equal(first.data.kind, "output"); if (first.data.kind === "output") assert.equal(first.data.claims[0]!.outcome, "pending_activity");
      s.snapshotSequence++; s.projection.nodes.at(-1)!.status = "completed";
      s.projection.messages.push({ id: "answer-later", role: "assistant", runId: "current", text, streaming: false });
      s.projection.turnItems.push({ id: "answer-later-item", type: "assistant_message", messageId: "answer-later", runId: "current", text, streaming: false, status: "completed" });
      await x.tick(d.room, "W"); assert.equal(d.p.requests.get("A")!.state, "open");
      assert.ok([...d.p.providerHolds.values()].some((h) => h.held && h.code === "native_activity:native-bg" && h.runId === r.id));
    }
    d.parity();
  } finally { d.cleanup(); await v.close(); }
});

test("unassociated old native delivery holds reseat while exact current A can answer", async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    d.request("A"); const r = d.reserve("W", false), x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    const wire = JSON.parse(d.p.runs.get(r.id)!.transport!.wireJSON) as { text: string }, s = raw();
    s.projection.runs.push({ id: "current", userMessageId: r.dispatchMessageId, status: "completed" },
      { id: "old", userMessageId: "native-old", status: "completed" });
    s.projection.nodes.push({ id: "old-native-delivery", kind: "root_turn", runId: "old", countsForRun: false, status: "running" });
    const text = JSON.stringify({ schema: "backroom.output.v1", body: "A", disposition: { kind: "answer", requestIds: ["A"] } });
    s.projection.messages.push({ id: r.dispatchMessageId, role: "user", runId: "current", text: wire.text },
      { id: "answer", role: "assistant", runId: "current", text, streaming: false });
    s.projection.turnItems.push({ id: "answer-item", type: "assistant_message", messageId: "answer", runId: "current", text, streaming: false, status: "completed" });
    v.setProjection(s); await x.tick(d.room, "W");
    assert.equal(d.p.requests.get("A")!.state, "answered"); assert.equal(d.p.runs.get(r.id)!.phase, "terminal");
    assert.equal((await x.quiescence(d.room, "W")).proven, false); assert.equal(v.frames.length, 0);
    s.snapshotSequence++; s.projection.nodes[0]!.status = "completed";
    assert.equal((await x.quiescence(d.room, "W")).proven, true); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

for (const type of ["file_change", "web_search", "future_native_tool"] as const)
  for (const status of ["running", "completed"] as const) for (const ordering of ["node-first", "combined"] as const)
    test(`HTTP/store unsupported ${type}/${status}/${ordering} causally holds A through terminal without result consumption`, async () => {
      const v = await stub(), d = new DiskRoom();
      try {
        d.request("A"); const run = d.reserve("W", false), x = new EngineReconciler(d.store, v.adapter);
        await x.prepareRun(d.room, run.id, { instanceId: "codex", model: "test" });
        const wire = JSON.parse(d.p.runs.get(run.id)!.transport!.wireJSON) as { text: string }, s = raw();
        Object.assign(s.projection.providerThreads[0]!, { appThreadId: "thread:W", driver: "codex" });
        const nativeRef = { driver: "codex", nativeId: "unsupported-tool", strength: "strong" };
        s.projection.runs.push({ id: "current", threadId: "thread:W", userMessageId: run.dispatchMessageId, status: "running" });
        // Actual RunAttempt contract has no threadId; its exact run/root/provider-thread edges prove origin.
        s.projection.attempts.push({ id: "attempt", runId: "current", rootNodeId: "root", providerThreadId: "pt", providerTurnId: "turn",
          providerInstanceId: "codex", attemptOrdinal: 1, reason: "initial", status: "running", startedAt: null, completedAt: null });
        s.projection.providerTurns.push({ id: "turn", providerThreadId: "pt", nodeId: "root", runAttemptId: "attempt", ordinal: 1, status: "running" });
        s.projection.nodes.push({ id: "root", threadId: "thread:W", runId: "current", parentNodeId: null, rootNodeId: "root", kind: "root_turn", countsForRun: true,
          providerThreadId: "pt", providerTurnId: "turn", nativeItemRef: null, status: "running" },
        { id: "unsupported-node", threadId: "thread:W", runId: "current", parentNodeId: "root", rootNodeId: "root", kind: "tool_call", countsForRun: false,
          providerThreadId: "pt", providerTurnId: "turn", nativeItemRef: nativeRef, status });
        const item = { id: "unsupported-item", threadId: "thread:W", runId: "current", nodeId: "unsupported-node", providerThreadId: "pt", providerTurnId: "turn",
          nativeItemRef: nativeRef, type, status, updatedAt: "2026-10-07T01:00:00.000Z",
          ...(type === "file_change" ? { fileName: "file.ts", diffStr: "+changed" } : { patterns: ["query"] }) };
        if (ordering === "combined") s.projection.turnItems.push(item);
        const body = JSON.stringify({ schema: "backroom.output.v1", body: "too early", disposition: { kind: "answer", requestIds: ["A"] } });
        s.projection.messages.push({ id: run.dispatchMessageId, threadId: "thread:W", role: "user", runId: "current", text: wire.text },
          { id: "early-answer", threadId: "thread:W", role: "assistant", runId: "current", text: body, streaming: false });
        s.projection.turnItems.push({ id: "early-answer-item", threadId: "thread:W", type: "assistant_message", messageId: "early-answer", runId: "current",
          text: body, status: "completed", streaming: false });
        v.setProjection(s); await x.tick(d.room, "W");
        assert.equal(d.p.requests.get("A")!.state, "open");
        if (ordering === "node-first") s.projection.turnItems.push(item);
        s.snapshotSequence++;
        for (const rows of [s.projection.runs, s.projection.attempts, s.projection.nodes, s.projection.providerTurns]) for (const row of rows) row.status = "completed";
        item.status = "completed";
        s.projection.messages.push({ id: "later-final", threadId: "thread:W", role: "assistant", runId: "current", text: body, streaming: false });
        s.projection.turnItems.push({ id: "later-final-item", threadId: "thread:W", type: "assistant_message", messageId: "later-final", runId: "current",
          text: body, status: "completed", streaming: false });
        await x.tick(d.room, "W"); d.reopen();
        const y = new EngineReconciler(d.store, v.adapter); await y.tick(d.room, "W");
        assert.equal(d.p.requests.get("A")!.state, "open"); assert.equal((await y.quiescence(d.room, "W")).proven, false);
        assert.ok([...d.p.providerHolds.values()].some((h) => h.held
          && h.code === `native_activity:${type === "file_change" && ordering === "combined" ? "unsupported-item" : "unsupported-node"}`
          && h.runId === run.id && h.scope === "work"), "supported edit aliases keep the exact original scope when actual result detail is unavailable");
        const claims = d.store.load(d.room).flatMap((e) => e.data.kind === "output" ? e.data.claims : []);
        assert.equal(claims.length, 2); assert.ok(claims.every((c) => c.outcome === "pending_activity"));
        assert.equal(v.frames.length, 0, "no native command was dispatched; this stub supplies no result detail"); d.parity();
      } finally { d.cleanup(); await v.close(); }
    });

test("HTTP/store accepts source-valid superseded attempts and context transfers as settled history", async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    const s = raw(); s.projection.attempts.push({ id: "old-attempt", status: "superseded" });
    s.projection.contextTransfers.push({ id: "old-merge", status: "superseded" }); v.setProjection(s);
    const normalized = await v.adapter.inspect("thread:W"); assert.equal(normalized.idle, true); assert.deepEqual(normalized.issues, []);
    assert.ok(normalized.settled!.includes("attempts:old-attempt")); assert.ok(normalized.settled!.includes("contextTransfer:old-merge"));
    const x = new EngineReconciler(d.store, v.adapter);
    assert.deepEqual((await x.tick(d.room, "W")).held, []); assert.equal((await x.quiescence(d.room, "W")).proven, true); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

test("HTTP/store does not apply an attempt's superseded status to an invalid native run", async () => {
  const v = await stub(), d = new DiskRoom();
  try {
    const s = raw(); s.projection.runs.push({ id: "invalid", userMessageId: "native", status: "superseded" }); v.setProjection(s);
    const x = new EngineReconciler(d.store, v.adapter);
    assert.ok((await x.tick(d.room, "W")).held.some((h) => h.code === "history"));
    assert.equal((await x.quiescence(d.room, "W")).proven, false); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

for (const origin of ["provider_native", "app_owned"] as const)
  test(`HTTP/store separates ${origin} child lifecycle terminal from wake-delivery settlement after reload`, async () => {
    const v = await stub(), d = new DiskRoom();
    try {
      const s = raw(); s.snapshotSequence = 40;
      s.projection.runs.push({ id: "native-root", userMessageId: "native-input", status: "running" });
      s.projection.nodes.push({ id: "child", kind: "subagent", runId: "native-root", status: "running" });
      s.projection.subagents.push({ id: "child", origin, driver: "claude", runId: "native-root", status: "running" });
      s.projection.turnItems.push({ id: "child-item", type: "subagent", subagentId: "child", runId: "native-root", status: "running" });
      v.setProjection(s); const x = new EngineReconciler(d.store, v.adapter);
      assert.equal((await x.quiescence(d.room, "W")).proven, false); d.reopen();
      const y = new EngineReconciler(d.store, v.adapter); s.snapshotSequence = 50;
      for (const rows of [s.projection.runs, s.projection.nodes, s.projection.subagents, s.projection.turnItems])
        for (const row of rows) row.status = "completed";
      if (origin === "app_owned") s.projection.subagents[0]!.completionDelivery = { state: "delivered", observedByRunId: null };
      const normalized = await v.adapter.inspect("thread:W");
      assert.equal(normalized.pending.includes("nativeChildWake:child"), origin === "provider_native");
      assert.equal(normalized.settled!.includes("nativeChildWake:child"), false);
      // Wake delivery and lifecycle do not record an unassociated logical result.
      assert.equal((await y.quiescence(d.room, "W")).proven, false);
      assert.ok([...d.p.providerHolds.values()].some((h) => h.held && h.code === "native_activity:child-item"));
      if (origin === "provider_native") {
        assert.deepEqual(d.p.providerObservations.get("W")!.pending, ["nativeChildWake:child"]);
        s.snapshotSequence = 60; s.projection.subagents = []; s.projection.nodes = []; s.projection.turnItems = [];
        assert.equal((await y.quiescence(d.room, "W")).proven, false);
        assert.deepEqual(d.p.providerObservations.get("W")!.pending, ["nativeChildWake:child"]);
      }
      assert.equal(v.reads.some((r) => r.startsWith("POST")), false); d.parity();
    } finally { d.cleanup(); await v.close(); }
  });

test("structured sync declaration requires exact schema; prose mentions and unknown dispositions are not exposure", () => {
  assert.equal(decodeOutput("I read receipt Q abcdef and finished A."), null);
  assert.equal(decodeOutput(JSON.stringify({ schema: "backroom.output.v1", body: "done", disposition: { kind: "normal-final" } })), null);
  assert.equal(decodeOutput(JSON.stringify({ schema: "backroom.output.v1", body: "text", disposition: { kind: "silent" } })), null);
  assert.deepEqual(decodeOutput(JSON.stringify({ schema: "backroom.output.v1", body: "", disposition: { kind: "silent" } })), { body: "", disposition: { kind: "silent" }, receipts: [] });
});

/** Source ws.ts wraps inner failures in OrchestrationV2DispatchCommandError; never parse its message. */
function rpcStub(cause?: Record<string, unknown>) {
  const frames: unknown[] = [];
  class Socket {
    listeners = new Map<string, ((e: { data: string }) => void)[]>();
    constructor(_url: string) { queueMicrotask(() => this.emit("open", "")); }
    addEventListener(type: string, listener: (e: { data: string }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data: string) { for (const l of this.listeners.get(type) ?? []) l({ data }); }
    send(data: string) {
      const f = JSON.parse(data) as { id: string; payload: unknown }; frames.push(f.payload);
      queueMicrotask(() => this.emit("message", JSON.stringify({ _tag: "Exit", requestId: f.id,
        exit: cause ? { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", commandId: "response:Q", commandType: "runtime-request.respond", cause } }] } : { _tag: "Success", value: { sequence: 42 } } })));
    }
    close() { this.emit("close", ""); }
  }
  const fetchImpl = (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("websocket-ticket") ? { ticket: "stub" } : { environmentId: "stub", label: "stub", serverVersion: T3_SERVER_VERSION, orchestrationProtocolVersion: 2 }), { status: 200 })) as typeof fetch;
  const http = new HttpT3Adapter({ baseUrl: "http://stub.local", accessToken: "test", fetchImpl, webSocketImpl: Socket });
  return { http, adapter: new EngineHttpT3Adapter(http), frames };
}
for (const tag of [null, "OrchestratorCommandRejectedError", "OrchestratorCommandPreviouslyRejectedError", "OrchestratorDispatchError", "unknown"])
  test(`real HTTP/RPC adapter maps ${tag ?? "success"} to app acceptance/rejection/uncertainty`, async () => {
    const v = rpcStub(tag ? { _tag: tag } : undefined);
    const wireJSON = JSON.stringify({ type: "runtime-request.respond", commandId: "response:Q", threadId: "thread:W", requestId: "runtime:Q", answers: { a: "yes" } });
    try { const result = await v.adapter.send(wireJSON, { kind: "control", id: "reply:Q" });
      assert.equal(result.kind, tag === null ? "accepted" : tag.includes("Rejected") ? "rejected" : "unknown");
      assert.deepEqual(v.frames, [JSON.parse(wireJSON)]);
    } finally { v.http.close(); }
  });

test("public T3 history absence permits one pinned identical replay and then holds without invented rejection", async () => {
  const v = await stub(), d = new DiskRoom();
  try { d.request("A"); const r = d.reserve("W", false); const x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    assert.equal(x.observe(d.room, "W", await v.adapter.contract(), await v.adapter.inspect("thread:W")), true);
    d.add({ type: "transport_attempt", actor: "$system", target: { kind: "run", id: r.id }, expectedAttempts: 0, evidence: "journaled send intention before old process loss" });
    for (let i = 0; i < 8; i++) await x.tick(d.room, "W");
    assert.equal(d.p.runs.get(r.id)!.phase, "uncertain"); assert.equal(d.p.runs.get(r.id)!.transport!.attempts, 2);
    assert.equal(d.p.runs.size, 1); assert.deepEqual(v.frames, [JSON.parse(d.p.runs.get(r.id)!.transport!.wireJSON)]);
    assert.ok((await x.tick(d.room, "W")).held.some((h) => h.code.startsWith("unknown"))); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

test("public T3 resolved question and terminal run do not attribute a lost reply to its command T19", async () => {
  const v = await stub(), d = new DiskRoom();
  try { d.request("A"); const r = d.reserve("W", false); const x = new EngineReconciler(d.store, v.adapter);
    await x.prepareRun(d.room, r.id, { instanceId: "codex", model: "test" });
    const wire = JSON.parse(d.p.runs.get(r.id)!.transport!.wireJSON) as { text: string };
    const s = raw(); s.projection.runs.push({ id: "provider:A", userMessageId: r.dispatchMessageId, status: "running" });
    s.projection.messages.push({ id: r.dispatchMessageId, role: "user", runId: "provider:A", text: wire.text });
    s.projection.nodes.push({ id: "question-node", runId: "provider:A", status: "waiting" });
    s.projection.runtimeRequests.push({ id: "runtime:Q", nodeId: "question-node", kind: "user_input", status: "pending", responseCapability: { type: "live", providerSessionId: "session" } });
    v.setProjection(s); await x.tick(d.room, "W");
    d.add({ type: "request", id: "Q", actor: "W", to: "O", body: "choose", parentId: "A", live: { runId: r.id, providerRequestId: "runtime:Q" } });
    d.add({ type: "runtime_reply", id: "reply", actor: "O", requestId: "Q", commandId: "response:Q", body: JSON.stringify({ answers: { a: "yes" } }) });
    // Freeze and record the old owner's send before response loss, without a real/stub provider write.
    const c = await v.adapter.contract(); const json = JSON.stringify({ type: "runtime-request.respond", commandId: "response:Q", threadId: "thread:W", requestId: "runtime:Q", answers: { a: "yes" } });
    const { hash } = await import("../../src/engine/provider.ts");
    d.add({ type: "freeze_transport", actor: "$system", target: { kind: "control", id: "reply" }, transport: { wireJSON: json, digest: hash(json), environmentId: c.environmentId, serverVersion: c.serverVersion, contract: c.id } });
    d.add({ type: "transport_attempt", actor: "$system", target: { kind: "control", id: "reply" }, expectedAttempts: 0, evidence: "old sender lost response" });
    s.projection.runs[0]!.status = "completed"; s.projection.nodes[0]!.status = "completed"; s.projection.runtimeRequests[0]!.status = "resolved";
    const text = JSON.stringify({ schema: "backroom.output.v1", body: "yield", disposition: { kind: "yield" } });
    s.projection.messages.push({ id: "out", role: "assistant", runId: "provider:A", text, streaming: false });
    s.projection.turnItems.push({ id: "item", type: "assistant_message", messageId: "out", runId: "provider:A", text, streaming: false, status: "completed" });
    for (let i = 0; i < 8; i++) await x.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply")!.phase, "uncertain"); assert.equal(d.p.runs.get(r.id)!.phase, "terminal");
    assert.equal((await x.quiescence(d.room, "W")).proven, false); assert.equal(v.reads.some((r) => r.startsWith("POST")), false); d.parity();
  } finally { d.cleanup(); await v.close(); }
});

/** Actual adapter/local handler/SQLite; only the pinned T3 projection is simulated. */
async function invokeProjected(v: OperationRoom, raw: OperationIntent, deliver = true) {
  const item = v.projectOperation(v.initial, raw);
  const response = await v.call(v.initial, raw, item.id), text = await response.text();
  assert.equal(response.status, 200, text);
  const result = JSON.parse(text) as { result: { view?: { itemId: string; digest: string | null }[]; claims?: { outcome: string }[] } };
  if (deliver) { v.source.completeTool(item, text); await v.x.tick(v.d.room, "W"); }
  return { item, text, result };
}
async function classifiedInvocation(v: OperationRoom, kind: "ordinary" | "own") {
  if (kind === "own") return (await invokeProjected(v, v.intent(v.initial, "view", "own_run_view"))).item;
  const original = v.source.addTool(v.initial.run, "pwd", { type: "command_execution", input: "pwd",
    output: "/workspace\n", status: "completed", exitCode: 0 });
  const view = await invokeProjected(v, v.intent(v.initial, "view", "own_run_view"));
  const ref = view.result.result.view!.find((r) => r.itemId === original.id)!;
  assert.ok(ref.digest);
  await invokeProjected(v, v.intent(v.initial, "consume", "consume_tool_result", {
    toolRefs: [{ itemId: original.id, digest: ref.digest, requestIds: ["A"] }],
  }));
  return original;
}

for (const kind of ["ordinary", "own"] as const) for (const form of ["file_change", "missing_item_changed_node_root", "node_foreign_thread", "node_foreign_provider_thread"] as const)
  for (const status of ["running", "completed"] as const) test(`HTTP/local/SQLite classified ${kind} ${form}/${status} retains causal conflict before claim and after terminal/reopen`, async () => {
    const v = await operationRoom();
    try {
      const original = await classifiedInvocation(v, kind);
      assert.equal(v.held().filter((h) => h.scope === "work").length, 0, "paired original exact source is already settled");
      const node = v.source.snapshot.projection.nodes.find((n) => n.id === original.nodeId)!;
      original.status = status; node.status = status;
      if (status === "running") { delete original.output; original.completedAt = null; }
      if (form === "file_change") {
        original.type = "file_change"; original.fileName = "different.ts"; original.diffStr = "+another effect"; delete original.input;
        v.source.project(original);
      } else if (form === "missing_item_changed_node_root") {
        v.source.snapshot.projection.turnItems = v.source.snapshot.projection.turnItems.filter((i) => i.id !== original.id);
        node.rootNodeId = "changed-unknown-root";
      } else {
        v.source.project(original);
        if (form === "node_foreign_thread") node.threadId = "foreign-thread";
        else node.providerThreadId = "foreign-provider-thread";
      }
      v.source.snapshot.snapshotSequence++;
      const sources = normalizeT3Snapshot(v.source.snapshot, "thread:W").toolSources!;
      if (form === "file_change") {
        const changed = sources.find((s) => s.itemId === original.id)!;
        assert.equal(changed.type, "file_change"); assert.equal(changed.complete, true);
        assert.equal(changed.fileChange!.fileName, "different.ts");
        assert.equal(changed.issues.includes("tool_type_unsupported"), false, "supporting the new item kind cannot authorize mutation of an established invocation");
      } else {
        assert.ok(sources.some((s) => s.nodeId === node.id && !s.complete), "contradicted node evidence remains identifiable");
      }
      const raw = v.intent(v.initial, "finish", "finish", { body: "Explicit finish after changed native source", toolRefs: [],
        disposition: { kind: "answer", requestIds: ["A"] } });
      const finish = await invokeProjected(v, raw, false);
      assert.equal(finish.result.result.claims!.find((c) => c.outcome === "pending_activity")?.outcome, "pending_activity");
      assert.equal(v.d.p.requests.get("A")!.state, "open");
      const events = v.d.store.load(v.d.room), conflicts = events.filter((e) => e.data.kind === "provider.conflict");
      assert.ok(conflicts.length > 0, "present source contradiction is durably journaled, not only an availability hold");
      const conflictIndex = events.findIndex((e) => e.data.kind === "provider.conflict");
      const claimIndex = events.findIndex((e) => e.data.kind === "output" && e.data.claims.some((c) => c.outcome === "pending_activity"));
      assert.ok(conflictIndex < claimIndex, "causal conflict commits before the attempted answer claim");
      assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.source.nodeId === original.nodeId), "conflict retains original invocation identity");
      if (form === "file_change") assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === original.id && e.data.source.type === "file_change"));
      else assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.source.nodeEvidence
        && (e.data.source.nodeEvidence.rootNodeId === "changed-unknown-root" || e.data.source.nodeEvidence.threadId === "foreign-thread"
          || e.data.source.nodeEvidence.providerThreadId === "foreign-provider-thread")), "actual failed edge retained in durable evidence");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
      v.source.completeTool(finish.item, finish.text); v.source.endRun(v.initial.run, { kind: "silent" });
      await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.equal(v.d.p.requests.get("A")!.state, "open"); v.d.parity();
      v.d.reopen(); const reopened = new EngineReconciler(v.d.store, v.source.adapter);
      await reopened.tick(v.d.room, "W");
      assert.equal((await reopened.quiescence(v.d.room, "W")).proven, false);
      assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
      assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const kind of ["ordinary", "own"] as const) test(`HTTP/local/SQLite classified ${kind} exact unchanged node-only alias preserves finite finish`, async () => {
  const v = await operationRoom();
  try {
    const original = await classifiedInvocation(v, kind);
    v.source.snapshot.projection.turnItems = v.source.snapshot.projection.turnItems.filter((i) => i.id !== original.id);
    v.source.snapshot.snapshotSequence++;
    const finish = await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Explicit finish after exact item availability change", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    assert.equal(finish.result.result.claims!.find((c) => c.outcome === "answered")?.outcome, "answered");
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
    assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

for (const nodeStatus of ["running", "completed", "failed", "cancelled", "interrupted", "idle"] as const) test(`HTTP/local/SQLite consumed ordinary terminal item with ${nodeStatus} native node has exact causal outcome`, async () => {
  const v = await operationRoom();
  try {
    const original = await classifiedInvocation(v, "ordinary"), before = v.d.p.toolResults.get([...v.d.p.toolResults.keys()][0]!)!;
    const node = v.source.snapshot.projection.nodes.find((n) => n.id === original.nodeId)!;
    node.status = nodeStatus; v.source.snapshot.snapshotSequence++;
    const finish = await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Explicit finish after native node observation", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict");
    assert.deepEqual(v.d.p.toolResults.get(before.key), before, "recorded terminal result remains immutable");
    if (nodeStatus !== "completed") {
      assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.equal(finish.result.result.claims![0]!.outcome, "pending_activity");
      assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === original.id
        && e.data.source.status === "completed" && e.data.source.nodeStatus === nodeStatus));
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
      v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      v.d.reopen(); const reopened = new EngineReconciler(v.d.store, v.source.adapter);
      assert.equal((await reopened.quiescence(v.d.room, "W")).proven, false);
      assert.equal(v.d.p.requests.get("A")!.state, "open");
      node.status = "completed"; v.source.snapshot.snapshotSequence++;
      await reopened.tick(v.d.room, "W"); v.d.store.rebuild(v.d.room);
      assert.equal((await reopened.quiescence(v.d.room, "W")).proven, false, "restoring old rows cannot erase the observed contradictory outcome");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.deepEqual(v.d.p.toolResults.get(before.key), before);
      assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.nodeStatus === nodeStatus));
    } else {
      assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(conflicts.length, 0);
      assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    }
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

for (const nodeStatus of ["running", "completed", "failed", "cancelled", "interrupted", "idle"] as const) test(`HTTP/local/SQLite initial ordinary consumption requires settled native node ${nodeStatus}`, async () => {
  const v = await operationRoom();
  try {
    const item = v.source.addTool(v.initial.run, "pwd", { type: "command_execution", input: "pwd", output: "/workspace\n", status: "completed", exitCode: 0 });
    const full = await v.source.adapter.detail("thread:W", item.id);
    const { resultDigest } = await import("../../src/engine/result.ts");
    const originalDigest = resultDigest(full);
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = nodeStatus;
    v.source.snapshot.snapshotSequence++;
    const view = await invokeProjected(v, v.intent(v.initial, "view", "own_run_view"));
    const row = view.result.result.view!.find((r) => r.itemId === item.id)!;
    assert.equal(row.digest, nodeStatus !== "completed" ? "" : originalDigest);
    const raw = v.intent(v.initial, "consume", "consume_tool_result", { toolRefs: [{ itemId: item.id, digest: originalDigest, requestIds: ["A"] }] });
    const consumeItem = v.projectOperation(v.initial, raw), response = await v.call(v.initial, raw, consumeItem.id), text = await response.text();
    if (nodeStatus !== "completed") {
      assert.equal(response.status, 409, text); assert.equal(v.d.p.toolResults.size, 0);
      assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
    } else {
      assert.equal(response.status, 200, text); assert.equal(v.d.p.toolResults.size, 1);
      v.source.completeTool(consumeItem, text); await v.x.tick(v.d.room, "W");
      await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Explicit complete settled ordinary result", toolRefs: [],
        disposition: { kind: "answer", requestIds: ["A"] } }));
      assert.equal(v.d.p.requests.get("A")!.state, "answered");
    }
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("HTTP/local/SQLite committed own effects remain closed while exact native node delivery is running", async () => {
  const v = await operationRoom();
  try {
    const item = await classifiedInvocation(v, "own");
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = "running";
    v.source.snapshot.snapshotSequence++;
    await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Finite finish preserves known closed effects", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
    assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("HTTP/local/SQLite missing own item with exact active node keeps closed A effects and independent B while reseat is held", async () => {
  const v = await operationRoom();
  try {
    const item = await classifiedInvocation(v, "own");
    v.source.snapshot.projection.turnItems = v.source.snapshot.projection.turnItems.filter((i) => i.id !== item.id);
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = "running";
    v.source.snapshot.snapshotSequence++;
    await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Known closed own effects can finish A", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
    v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
    assert.ok(v.held().some((h) => h.scope === "reseat"));
    v.d.request("B"); const b = await v.start();
    const raw = v.intent(b, "finish-B", "finish", { body: "Independent B finishes despite original own delivery uncertainty", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["B"] } });
    const finish = v.projectOperation(b, raw), response = await v.call(b, raw, finish.id), text = await response.text();
    assert.equal(response.status, 200, text); assert.equal(v.d.p.requests.get("B")!.state, "answered");
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    v.source.completeTool(finish, text); v.source.endRun(b.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
    assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
    assert.equal(v.source.appRuns, 2, "one native app run per independent frozen A/B reservation");
    v.d.reopen(); assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(v.d.p.requests.get("B")!.state, "answered");
    assert.equal((await new EngineReconciler(v.d.store, v.source.adapter).quiescence(v.d.room, "W")).proven, false); v.d.parity();
  } finally { v.cleanup(); }
});

for (const moved of [false, true]) test(`HTTP/local/SQLite prior ordinary origin moved=${moved} holds original A without putting changed source onto independent B`, async () => {
  const v = await operationRoom();
  try {
    const original = await classifiedInvocation(v, "ordinary");
    v.source.endRun(v.initial.run, { kind: "yield" }); await v.x.tick(v.d.room, "W");
    v.d.request("B"); const b = await v.start();
    if (moved) {
      const native = v.source.native(b.run), node = v.source.snapshot.projection.nodes.find((n) => n.id === original.nodeId)!;
      original.runId = native.id; original.providerTurnId = native.turnId;
      node.runId = native.id; node.rootNodeId = native.rootId; node.parentNodeId = native.rootId; node.providerTurnId = native.turnId;
      v.source.project(original);
    }
    const raw = v.intent(b, "finish-B", "finish", { body: "B answers only its independent request", toolRefs: [], disposition: { kind: "answer", requestIds: ["B"] } });
    const item = v.projectOperation(b, raw), response = await v.call(b, raw, item.id), text = await response.text();
    assert.equal(response.status, 200, text); assert.equal(v.d.p.requests.get("B")!.state, "answered");
    assert.equal(v.d.p.requests.get("A")!.state, "open");
    const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict");
    if (moved) {
      assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.runId === v.initial.run.id
        && e.data.source.itemId === original.id && e.data.source.providerRunId === v.source.native(b.run).id));
      assert.ok(v.held().some((h) => h.scope === "work" && h.runId === v.initial.run.id && h.requestIds?.includes("A")));
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
    } else {
      assert.equal(conflicts.length, 0); assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    }
    assert.equal(v.source.appRuns, 2); v.d.parity();
  } finally { v.cleanup(); }
});

for (const type of ["command_execution", "dynamic_tool"] as const) for (const status of ["completed", "failed", "cancelled", "interrupted"] as const)
  test(`HTTP/local/SQLite ordinary ${type} matched ${status} consumes exact result without inferring request completion`, async () => {
    const v = await operationRoom();
    try {
      const output = type === "command_execution" ? status === "completed" ? "/workspace\n" : "Exact explicit command failure\n" : { outcome: status, result: ["exact", 7] };
      const input = type === "command_execution" ? "pwd" : { question: "ordinary remote computation" };
      const item = v.source.addTool(v.initial.run, "ordinary", { type, input, output, status, exitCode: status === "completed" ? 0 : 7,
        operation: "external_compute" });
      const view = await invokeProjected(v, v.intent(v.initial, "view", "own_run_view"));
      const ref = view.result.result.view!.find((r) => r.itemId === item.id)!; assert.equal(ref.digest!.length, 64);
      await invokeProjected(v, v.intent(v.initial, "consume", "consume_tool_result", { toolRefs: [{ itemId: item.id, digest: ref.digest, requestIds: ["A"] }] }));
      const result = [...v.d.p.toolResults.values()].find((r) => r.source.itemId === item.id)!;
      assert.equal(result.source.status, status); assert.equal(result.source.nodeStatus, status);
      assert.deepEqual(result.source.input, input); assert.deepEqual(result.source.output, output);
      if (type === "command_execution") assert.equal(result.source.exitCode, status === "completed" ? 0 : 7);
      assert.equal(v.d.p.requests.get("A")!.state, "open", "tool outcome alone is not the original request disposition");
      assert.equal(v.claims().length, 0); assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
      const original = JSON.stringify(result);
      await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: `Explicit answer reports ${status} original tool outcome`, toolRefs: [],
        disposition: { kind: "answer", requestIds: ["A"] } }));
      assert.equal(v.d.p.requests.get("A")!.state, "answered");
      assert.equal(JSON.stringify(v.d.p.toolResults.get(result.key)), original);
      assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
      assert.equal(v.source.appRuns, 1); v.d.reopen(); assert.equal(JSON.stringify(v.d.p.toolResults.get(result.key)), original); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const nodeStatus of ["failed", "cancelled", "interrupted", "idle"] as const) test(`HTTP/local/SQLite closed own effects with ${nodeStatus} node delivery mismatch remain reseat-only`, async () => {
  const v = await operationRoom();
  try {
    const item = await classifiedInvocation(v, "own"), receipt = v.receipt("view"), frozen = JSON.stringify(receipt);
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = nodeStatus;
    v.source.snapshot.snapshotSequence++;
    await invokeProjected(v, v.intent(v.initial, "finish", "finish", { body: "Known local effects stay closed despite native delivery outcome", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(JSON.stringify(v.receipt("view")), frozen);
    assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
    assert.ok(v.held().some((h) => h.scope === "reseat"
      && (h.code === `own_source_unavailable:${item.id}` || h.code === `own_delivery:${sourceKey(receipt.packet.source)}`)), "delivery mismatch retains exact original invocation uncertainty");
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0);
    v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
    assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(JSON.stringify(v.receipt("view")), frozen);
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

/** Only hooks simulated public RPC/HTTP producers; adapter/handler/store are unmodified. */
function armInsideFinalCheckpoint(v: OperationRoom, item: Record<string, unknown> & { id: string }, progress: "unchanged" | "same_time_body" | "unrelated_native", repeat = false, unavailableAfterFirstWindow = false) {
  let reads = 0, pendingFinal = false, mutations = 0;
  const originalBody = structuredClone(item.output), stamp = item.updatedAt;
  v.source.onDetail = (id) => {
    pendingFinal = id === item.id && ++reads % 2 === 0;
    if (id === item.id && unavailableAfterFirstWindow && reads > 2) throw new Error("Simulated second bounded detail unavailable after unproved first floor");
    return v.source.detailItems.get(id)!;
  };
  v.source.onSnapshot = () => {
    if (pendingFinal) {
      pendingFinal = false;
      if (progress !== "unchanged" && (repeat || mutations === 0)) {
        mutations++;
        if (progress === "same_time_body") {
          item.output = typeof originalBody === "string" ? `Changed body inside final adapter checkpoint ${mutations}`
            : { ...(originalBody as Record<string, unknown>), changedBody: `Changed confirmed response inside final adapter checkpoint ${mutations}` };
          v.source.project(item);
        } else {
          const root = v.source.snapshot.projection.nodes.find((n) => n.id === v.source.native(v.initial.run).rootId)!;
          root.progress = `Unrelated native progress ${mutations}`; v.source.snapshot.snapshotSequence++;
        }
        assert.equal(item.updatedAt, stamp, "actual collision in producer timestamp, no immutable source mutation");
      }
    }
    return v.source.snapshot;
  };
  return { get reads() { return reads; }, get mutations() { return mutations; }, originalBody, stamp,
    clear() { v.source.onDetail = null; v.source.onSnapshot = null; } };
}

for (const progress of ["unchanged", "same_time_body", "unrelated_native"] as const)
  test(`HTTP/local/SQLite fresh ordinary final-checkpoint ${progress} never consumes stale body or answers from unproved floor`, async () => {
    const v = await operationRoom();
    try {
      const ordinary = v.source.addTool(v.initial.run, "ordinary", { type: "command_execution", input: "pwd", output: "Original ordinary body\n", status: "completed", exitCode: 0 });
      const digest = resultDigest(await v.source.adapter.detail("thread:W", ordinary.id));
      const raw = v.intent(v.initial, "fresh-finish", "finish", { body: "Fresh answer with exactly referenced ordinary result",
        toolRefs: [{ itemId: ordinary.id, digest, requestIds: ["A"] }], disposition: { kind: "answer", requestIds: ["A"] } });
      const invocation = v.projectOperation(v.initial, raw), hook = armInsideFinalCheckpoint(v, ordinary, progress);
      const response = await v.call(v.initial, raw, invocation.id), text = await response.text();
      assert.equal(hook.reads, progress === "unchanged" ? 6 : 2,
        "successful proof includes strict referenced detail, independent closure, and closure revalidation; failed first window stops after its two RPCs");
      assert.equal(hook.mutations, progress === "unchanged" ? 0 : 1);
      if (progress === "unchanged") {
        assert.equal(response.status, 200, text); assert.equal(v.d.p.requests.get("A")!.state, "answered");
        assert.equal([...v.d.p.toolResults.values()][0]!.source.output, hook.originalBody);
      } else {
        assert.equal(response.status, 409, text); assert.equal(v.d.p.toolResults.size, 0);
        assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
        assert.equal(v.d.p.operationReceipts.size, 0, "result/effect/claim batch is absent on coverage failure");
        hook.clear();
        if (progress === "unrelated_native") {
          const retry = await v.call(v.initial, raw, invocation.id); assert.equal(retry.status, 200, await retry.clone().text());
          assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal([...v.d.p.toolResults.values()][0]!.source.output, hook.originalBody);
        }
      }
      assert.equal(v.source.appRuns, 1); assert.equal(v.source.frames.filter((f) => f.payload.type === "message.dispatch").length, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const progress of ["unchanged", "same_time_body", "unrelated_native"] as const)
  test(`HTTP/local/SQLite recorded ordinary final-checkpoint ${progress} preserves original result and causal floor`, async () => {
    const v = await operationRoom();
    try {
      const ordinary = await classifiedInvocation(v, "ordinary"), original = canonicalJSON([...v.d.p.toolResults.values()][0]);
      const raw = v.intent(v.initial, "recorded-finish", "finish", { body: "Fresh answer relies on original recorded ordinary result", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } });
      const invocation = v.projectOperation(v.initial, raw), hook = armInsideFinalCheckpoint(v, ordinary, progress, progress === "unrelated_native");
      const response = await v.call(v.initial, raw, invocation.id), text = await response.text();
      assert.ok(response.status === 200 || response.status === 409, text); assert.ok(hook.reads <= 4, "at most two bounded two-RPC detail attempts");
      assert.equal(canonicalJSON([...v.d.p.toolResults.values()][0]), original);
      if (progress === "unchanged") assert.equal(v.d.p.requests.get("A")!.state, "answered");
      else {
        assert.ok(hook.mutations > 0); assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
        if (progress === "same_time_body") assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === ordinary.id
          && Object.hasOwn(e.data.source, "output") && e.data.source.output === ordinary.output), "changed actual body must be retained by bounded reread");
        assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
        hook.clear();
        if (progress === "unrelated_native") {
          if (response.status === 200) {
            v.source.completeTool(invocation, text); await v.x.tick(v.d.room, "W");
            await invokeProjected(v, v.intent(v.initial, "stable-recorded-finish", "finish", { body: "Explicit fresh finish after stable body proof", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } }));
          } else {
            const retry = await v.call(v.initial, raw, invocation.id); assert.equal(retry.status, 200, await retry.clone().text());
          }
          assert.equal(v.d.p.requests.get("A")!.state, "answered");
        }
      }
      assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const progress of ["unchanged", "same_time_body", "unrelated_native"] as const)
  test(`HTTP/local/SQLite known own final-checkpoint ${progress} preserves effects and fences actual transfer`, async () => {
    const v = await operationRoom();
    try {
      const own = await classifiedInvocation(v, "own"), originalReceipt = canonicalJSON(v.receipt("view"));
      await invokeProjected(v, v.intent(v.initial, "answer-A", "finish", { body: "Known local effects explicitly answer A", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } }));
      v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
      const hook = armInsideFinalCheckpoint(v, own, progress, progress === "unrelated_native"), proof = await v.x.quiescence(v.d.room, "W");
      assert.ok(hook.reads <= 4, "bounded original own response detail attempts");
      assert.equal(canonicalJSON(v.receipt("view")), originalReceipt); assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(v.claims().length, 1);
      if (progress === "unchanged") {
        assert.equal(proof.proven, true);
        v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Stable exact response proof", evidence: proof.evidence });
        assert.equal(v.d.p.seats.get("W")!.status, "retired");
      } else {
        assert.ok(hook.mutations > 0); assert.equal(proof.proven, false);
        assert.ok(v.held().some((h) => h.scope === "reseat")); assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
        if (progress === "same_time_body") assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === own.id
          && Object.hasOwn(e.data.source, "output") && canonicalJSON(e.data.source.output) === canonicalJSON(own.output)), "changed confirmed body journals before transfer");
        assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Unproved response floor", evidence: proof.evidence }), /held|quiescent|uncertain|provider/i);
        assert.equal(v.d.p.seats.get("W")!.status, "active");
      }
      assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

async function activityCall(v: OperationRoom, raw: ActivityIntent, itemId: string) {
  return v.protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local/activities", { method: "POST",
    headers: { authorization: v.initial.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent: raw, itemId }) }));
}
for (const progress of ["unchanged", "same_time_body", "unrelated_native"] as const)
  test(`HTTP/local/SQLite registered background final-checkpoint ${progress} commits only actually covered original result`, async () => {
    const v = await operationRoom();
    try {
      const base = { schema: "backroom.activity.v1" as const, originRunId: v.initial.run.id, activityId: "background", activityGeneration: 1 };
      const registration: ActivityIntent = { ...base, operation: "register_activity", clientId: "register", nonce: "nonce:register", requestIds: ["A"], nativeId: "native-item:background-result" };
      const registrationItem = v.source.addTool(v.initial.run, "register", { input: registration, operation: registration.operation });
      const registered = await activityCall(v, registration, registrationItem.id), registeredText = await registered.text();
      assert.equal(registered.status, 200, registeredText); v.source.completeTool(registrationItem, registeredText); await v.x.tick(v.d.room, "W");
      assert.ok([...v.d.p.operationBindings.values()].some((b) => b.source.itemId === registrationItem.id && b.receiptKind === "activity" && b.confirmed));
      assert.equal(v.d.p.activities.get("background")!.status, "pending", "closed registration invocation leaves the logical activity pending");
      const background = v.source.addTool(v.initial.run, "background-result", { type: "command_execution", input: "original registered background task", output: "Original background body\n", status: "completed", exitCode: 0 });
      const digest = resultDigest(await v.source.adapter.detail("thread:W", background.id));
      const raw: ActivityIntent = { ...base, operation: "record_activity_result", clientId: "settle", nonce: "nonce:settle", toolRef: { itemId: background.id, digest, requestIds: ["A"] },
        body: "Explicit registered original result", disposition: { kind: "answer", requestIds: ["A"] }, completion: "done" };
      const invocation = v.source.addTool(v.initial.run, "settle", { input: raw, operation: raw.operation }), hook = armInsideFinalCheckpoint(v, background, progress);
      const response = await activityCall(v, raw, invocation.id), text = await response.text();
      assert.equal(hook.reads, progress === "unchanged" ? 6 : 2,
        "successful result retains strict activity-reference proof plus independent closure and revalidation; failed coverage stops after two RPCs");
      const completeSettlement = async (responseText: string) => {
        v.source.completeTool(invocation, responseText); await v.x.tick(v.d.room, "W");
        assert.ok([...v.d.p.operationBindings.values()].some((b) => b.source.itemId === invocation.id && b.receiptKind === "activity" && b.confirmed));
        await invokeProjected(v, v.intent(v.initial, "finish-background", "finish", { body: "Explicit finish after original result and native delivery settlement", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } }));
        assert.equal(v.d.p.requests.get("A")!.state, "answered");
      };
      if (progress === "unchanged") {
        assert.equal(response.status, 200, text); assert.equal(v.d.p.activities.get("background")!.status, "done");
        assert.equal(v.d.p.requests.get("A")!.state, "open", "the v1 result claim is recorded before its own activity receipt closes that invocation");
        assert.equal([...v.d.p.toolResults.values()].find((r) => r.source.itemId === background.id)!.source.output, hook.originalBody);
        await completeSettlement(text);
      } else {
        assert.equal(response.status, 409, text); assert.equal(v.d.p.activities.get("background")!.status, "pending");
        assert.equal(v.d.p.toolResults.size, 0, "registration closes through its actual receipt, with no synthetic consumed result");
        assert.equal([...v.d.p.toolResults.values()].some((r) => r.source.itemId === background.id), false);
        assert.equal(v.d.p.activityReceipts.size, 1, "only prelaunch registration remains, settlement/effects batch absent");
        assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0); hook.clear();
        if (progress === "unrelated_native") {
          const retry = await activityCall(v, raw, invocation.id), retryText = await retry.text(); assert.equal(retry.status, 200, retryText);
          assert.equal(v.d.p.activities.get("background")!.status, "done"); await completeSettlement(retryText);
        }
      }
      assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const kind of ["ordinary", "own"] as const)
  test(`HTTP/local/SQLite ${kind} first final-floor reject then unavailable bounded retry preserves original scope and independent B`, async () => {
    const v = await operationRoom();
    try {
      const original = await classifiedInvocation(v, kind), frozen = kind === "own" ? canonicalJSON(v.receipt("view")) : canonicalJSON([...v.d.p.toolResults.values()][0]);
      if (kind === "own") {
        await invokeProjected(v, v.intent(v.initial, "answer-A", "finish", { body: "Closed known A effects", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } }));
        v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
        assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
      }
      const hook = armInsideFinalCheckpoint(v, original, "same_time_body", false, true);
      if (kind === "ordinary") {
        const raw = v.intent(v.initial, "attempt-A", "finish", { body: "Attempted answer after first rejected detail floor", toolRefs: [], disposition: { kind: "answer", requestIds: ["A"] } });
        const invocation = v.projectOperation(v.initial, raw), response = await v.call(v.initial, raw, invocation.id), text = await response.text();
        assert.ok(response.status === 200 || response.status === 409, text);
        assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
        assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")), "failed second attempt cannot downgrade invalidated ordinary coverage to delivery-only");
        // Settle an actual rejected local invocation's error result as ordinary work
        // so it cannot become an unrelated later work hold in the paired B trace.
        if (response.status === 409) {
          invocation.output = "Explicit rejected local call result\n"; invocation.status = "completed";
          v.source.snapshot.projection.nodes.find((n) => n.id === invocation.nodeId)!.status = "completed"; v.source.project(invocation);
          await invokeProjected(v, v.intent(v.initial, "consume-rejected-A", "consume_tool_result", { toolRefs: [{ itemId: invocation.id,
            digest: resultDigest(await v.source.adapter.detail("thread:W", invocation.id)), requestIds: ["A"] }] }));
        }
        v.source.endRun(v.initial.run, { kind: "yield" });
      } else {
        const proof = await v.x.quiescence(v.d.room, "W"); assert.equal(proof.proven, false);
        assert.equal(v.d.p.requests.get("A")!.state, "answered"); assert.equal(v.held().filter((h) => h.scope === "work").length, 0);
        assert.ok(v.held().some((h) => h.scope === "reseat"));
        assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Unproved original body", evidence: proof.evidence }), /held|quiescent|uncertain|provider/i);
      }
      assert.equal(hook.mutations, 1); assert.ok(hook.reads <= 3, "two first reads plus one rejected second-attempt RPC, never unbounded retries");
      assert.equal(kind === "own" ? canonicalJSON(v.receipt("view")) : canonicalJSON([...v.d.p.toolResults.values()][0]), frozen);
      await v.x.tick(v.d.room, "W"); v.d.request("B"); const b = await v.start();
      const rawB = v.intent(b, "answer-B", "finish", { body: "Independent B after unavailable original source detail", toolRefs: [], disposition: { kind: "answer", requestIds: ["B"] } });
      const invocationB = v.projectOperation(b, rawB), responseB = await v.call(b, rawB, invocationB.id), textB = await responseB.text();
      assert.equal(responseB.status, 200, textB); assert.equal(v.d.p.requests.get("B")!.state, "answered");
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      assert.equal(v.d.p.requests.get("A")!.state, kind === "own" ? "answered" : "open");
      hook.clear();
      if (kind === "own") {
        assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
        assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === original.id && Object.hasOwn(e.data.source, "output")
          && canonicalJSON(e.data.source.output) === canonicalJSON(original.output)), "later explicit stable validation retains the changed confirmed body");
      }
      assert.equal(v.source.appRuns, 2); v.d.reopen(); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const unrelated of [false, true]) test(`HTTP/local/SQLite unchanged node-first own terminal alias clears only original pending delivery; unrelated=${unrelated}`, async () => {
  const v = await operationRoom();
  try {
    const raw = v.intent(v.initial, "node-first-view", "own_run_view"), item = v.projectOperation(v.initial, raw, raw.clientId, false);
    await v.x.tick(v.d.room, "W");
    assert.ok(v.d.p.providerObservations.get("W")!.pending.includes(`activity:${item.nodeId}`));
    const other = unrelated ? v.source.addTool(v.initial.run, "unrelated", { type: "command_execution", input: "Independent original native work", status: "running" }) : null;
    v.source.project(item);
    const response = await v.call(v.initial, raw, item.id), text = await response.text(); assert.equal(response.status, 200, text);
    v.source.completeTool(item, text); await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.providerObservations.get("W")!.pending.includes(`activity:${item.nodeId}`), false);
    if (other) {
      assert.ok(v.d.p.providerObservations.get("W")!.pending.includes(`activity:${other.id}`));
      assert.ok(v.held().some((h) => h.code === `native_activity:${other.id}` && h.held));
    }
    const finish = await invokeProjected(v, v.intent(v.initial, "first-alias-finish", "finish", { body: "Finite finish after original own alias confirmation", toolRefs: [],
      disposition: { kind: "answer", requestIds: ["A"] } }));
    assert.equal(finish.result.result.claims![0]!.outcome, unrelated ? "pending_activity" : "answered");
    if (other) {
      other.status = "completed"; other.output = "Exact unrelated native result\n";
      v.source.snapshot.projection.nodes.find((n) => n.id === other.nodeId)!.status = "completed"; v.source.project(other);
      await invokeProjected(v, v.intent(v.initial, "consume-unrelated", "consume_tool_result", { toolRefs: [{ itemId: other.id,
        digest: resultDigest(await v.source.adapter.detail("thread:W", other.id)), requestIds: ["A"] }] }));
      await invokeProjected(v, v.intent(v.initial, "after-unrelated-finish", "finish", { body: "Explicit finish after independent original work settlement", toolRefs: [],
        disposition: { kind: "answer", requestIds: ["A"] } }));
    }
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true, "completed exact alias leaves no stale native_pending pseudoactivity");
    assert.equal(v.source.appRuns, 1); v.d.reopen(); v.d.parity();
  } finally { v.cleanup(); }
});

for (const fault of ["native_ref", "origin", "outcome", "unsupported"] as const)
  test(`HTTP/local/SQLite node-first ${fault} terminal pair retains original persisted pending key and causal work`, async () => {
    const v = await operationRoom();
    try {
      const original = v.source.addTool(v.initial.run, `first-node-${fault}`, { type: "command_execution", input: "pwd", status: "running", projectItem: false });
      const key = `activity:${original.nodeId}`;
      await v.x.tick(v.d.room, "W");
      assert.ok(v.d.p.providerObservations.get("W")!.pending.includes(key), "actual first running node checkpoint journals its exact pending key");
      const unrelated = v.source.addTool(v.initial.run, `unrelated-pending-${fault}`, { type: "command_execution", input: "sleep 1", status: "running" });
      const node = v.source.snapshot.projection.nodes.find((n) => n.id === original.nodeId)!;
      original.status = "completed"; original.output = "Original unconsumed native body\n"; node.status = "completed";
      if (fault === "native_ref") original.nativeItemRef = { driver: "codex", nativeId: "contradicted-native-ref", strength: "strong" };
      if (fault === "origin") original.threadId = "foreign-thread";
      if (fault === "outcome") node.status = "failed";
      if (fault === "unsupported") original.type = "file_change";
      v.source.project(original); await v.x.tick(v.d.room, "W");
      const check = () => {
        const observation = v.d.p.providerObservations.get("W")!;
        assert.ok(observation.pending.includes(key), "terminal lifecycle cannot clear the prior node pending key without an exact coherent alias");
        assert.ok(observation.pending.includes(`activity:${unrelated.id}`), "unrelated native work remains pending");
        assert.ok(v.held().some((h) => h.scope === "work" && h.runId === v.initial.run.id && h.code === `native_activity:${original.nodeId}`), "the same original invocation causally holds A");
        assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
        assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.source.detailItems.get(original.id)!.output, "Original unconsumed native body\n");
      };
      check();
      const finish = await invokeProjected(v, v.intent(v.initial, `finish-node-negative-${fault}`, "finish", { toolRefs: [], body: "Attempt explicit finish while original invocation remains uncertain",
        disposition: { kind: "answer", requestIds: ["A"] } }));
      assert.equal(finish.result.result.claims![0]!.outcome, "pending_activity"); check();
      v.source.endRun(v.initial.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      const proof = await v.x.quiescence(v.d.room, "W"); check(); assert.equal(proof.proven, false);
      assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Contradicted node alias cannot transfer", evidence: proof.evidence }), /held|quiescent|uncertain|provider/i);
      assert.equal(v.d.p.seats.get("W")!.status, "active"); assert.equal(v.source.appRuns, 1);
      v.d.reopen(); check(); v.d.parity();
    } finally { v.cleanup(); }
  });
