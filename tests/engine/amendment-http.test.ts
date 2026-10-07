import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineHttpT3Adapter, normalizeT3Snapshot, smallLosslessValue } from "../../src/adapter/engine-http.ts";
import { HttpT3Adapter } from "../../src/adapter/http.ts";
import { T3_CONTRACT_ID, T3_SERVER_VERSION, T3_SOURCE_COMMIT, hash } from "../../src/engine/provider.ts";
import { exactAlias, ordinaryOutcomeCoherent, resultDigest, sourceContradiction, sourceIdentity } from "../../src/engine/result.ts";

const threadId = "thread:W";
const ref = { driver: "codex", nativeId: "native-tool", strength: "strong" };
const timestamp = "2026-10-07T01:00:00.000Z";
function fixture(type: "command_execution" | "dynamic_tool" = "command_execution") {
  const item: Record<string, unknown> = { id: "item", threadId, runId: "native-run", nodeId: "tool-node",
    providerThreadId: "pt", providerTurnId: "turn", nativeItemRef: ref, parentItemId: null, ordinal: 1,
    status: "completed", title: null, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp, type,
    ...(type === "command_execution" ? { input: "pwd", output: "/fixture\n", exitCode: 0 }
      : { toolName: "backroom-board.own_run_view", toolSource: { key: "mcp:backroom-board", name: "Backroom", kind: "integration" },
        input: { clientCommandId: "client:unique", originRunId: "origin" }, output: { answer: 42 } }) };
  const snapshot = { snapshotSequence: 40, projection: {
    thread: { id: threadId }, runs: [{ id: "native-run", threadId, userMessageId: "native-input", status: "running" }],
    messages: [{ id: "native-input", threadId, runId: "native-run", role: "user", text: "input" }],
    attempts: [{ id: "attempt", runId: "native-run", rootNodeId: "root", providerInstanceId: "codex", providerThreadId: "pt",
      providerTurnId: "turn", attemptOrdinal: 1, reason: "initial", status: "running", startedAt: timestamp, completedAt: null }],
    nodes: [{ id: "root", threadId, runId: "native-run", rootNodeId: "root", parentNodeId: null, kind: "root_turn",
      countsForRun: true, providerThreadId: "pt", providerTurnId: "turn", nativeItemRef: null, status: "running" },
    { id: "tool-node", threadId, runId: "native-run", rootNodeId: "root", parentNodeId: "root", kind: "tool_call",
      countsForRun: false, providerThreadId: "pt", providerTurnId: "turn", nativeItemRef: ref, status: "completed" }],
    providerTurns: [{ id: "turn", providerThreadId: "pt", nodeId: "root", runAttemptId: "attempt", ordinal: 1, status: "running" }],
    providerThreads: [{ id: "pt", appThreadId: threadId, driver: "codex", pendingBackgroundTasks: [] }], subagents: [] as Record<string, unknown>[],
    runtimeRequests: [] as Record<string, unknown>[], contextTransfers: [] as Record<string, unknown>[],
    turnItems: [] as Record<string, unknown>[],
  } };
  const { output: _output, ...wire } = item;
  snapshot.projection.turnItems.push(wire);
  return { item, snapshot };
}

/** Public HTTP/RPC shapes simulated locally; these tests perform no live provider calls. */
function transport(options: { loseFirst?: boolean } = {}) {
  const f = fixture();
  let version = T3_SERVER_VERSION, detailReads = 0, snapshotReads = 0, appRuns = 0;
  const frames: { tag: string; payload: Record<string, unknown> }[] = [], auth: string[] = [];
  const receipts = new Map<string, { threadId: unknown; sequence: number }>();
  let onDetail: ((count: number) => unknown) | null = null, onSnapshot: ((count: number) => unknown) | null = null;
  class Socket {
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor(_url: string) { queueMicrotask(() => this.emit("open", "")); }
    addEventListener(kind: string, callback: (event: { data: string }) => void) {
      this.listeners.set(kind, [...this.listeners.get(kind) ?? [], callback]);
    }
    emit(kind: string, data: string) { for (const callback of this.listeners.get(kind) ?? []) callback({ data }); }
    send(data: string) {
      const frame = JSON.parse(data) as { id: string; tag: string; payload: Record<string, unknown> };
      frames.push(frame);
      queueMicrotask(() => {
        try {
        let value: unknown;
        if (frame.tag === "orchestration.getTurnItem") {
          detailReads++;
          value = onDetail ? onDetail(detailReads) : { item: f.item };
        } else if (frame.tag === "orchestration.dispatchCommand") {
          const c = frame.payload, id = String(c.commandId), previous = receipts.get(id);
          if (previous) {
            assert.equal(previous.threadId, c.threadId);
            value = { sequence: previous.sequence };
          } else {
            assert.equal(c.type, "message.dispatch");
            assert.deepEqual(c.dispatchMode, { type: "start_immediately" });
            appRuns++;
            const sequence = ++f.snapshot.snapshotSequence;
            receipts.set(id, { threadId: c.threadId, sequence });
            f.snapshot.projection.runs.push({ id: "reserved-native", threadId, userMessageId: String(c.messageId), status: "queued" });
            f.snapshot.projection.messages.push({ id: String(c.messageId), threadId, runId: "reserved-native", role: "user", text: String(c.text) });
            if (options.loseFirst) { this.close(); return; }
            value = { sequence };
          }
        } else throw new Error(`Unexpected public-shaped RPC ${frame.tag}`);
        this.emit("message", JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }));
        } catch {
          this.emit("message", JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "simulated detail unavailable" } }] } }));
        }
      });
    }
    close() { this.emit("close", ""); }
  }
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    const path = new URL(String(url)).pathname;
    let result: unknown;
    if (path === "/.well-known/t3/environment") result = { environmentId: "simulated-env", label: "fixture", serverVersion: version, orchestrationProtocolVersion: 2 };
    else if (path.includes("websocket-ticket")) result = { ticket: "simulated-ticket" };
    else if (path === "/api/orchestration/threads/thread%3AW") {
      snapshotReads++;
      result = onSnapshot ? onSnapshot(snapshotReads) : f.snapshot;
    } else throw new Error(`Unexpected public-shaped HTTP read ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const http = new HttpT3Adapter({ baseUrl: "http://simulation.invalid", accessToken: "fixture-only", fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 100 });
  return { ...f, frames, auth, http, adapter: new EngineHttpT3Adapter(http), get appRuns() { return appRuns; },
    get detailReads() { return detailReads; }, get snapshotReads() { return snapshotReads; },
    setVersion(v: string) { version = v; },
    onDetail(fn: (count: number) => unknown) { onDetail = fn; }, onSnapshot(fn: (count: number) => unknown) { onSnapshot = fn; } };
}
const frozenWire = JSON.stringify({ type: "message.dispatch", commandId: "globally-unique-command", threadId,
  messageId: "globally-unique-message", text: "one frozen board prefix", attachments: [],
  modelSelection: { instanceId: "codex", model: "fixture" }, createdBy: "user", creationSource: "server", dispatchMode: { type: "start_immediately" } });
const frozen = (wireJSON = frozenWire, attempts = 1) => ({ wireJSON, digest: hash(wireJSON), environmentId: "simulated-env",
  serverVersion: T3_SERVER_VERSION, contract: T3_CONTRACT_ID, attempts,
  dispatchPolicy: { kind: "t3-reserved-start-immediately-v1" as const, maxPackets: 2 as const, sourceCommit: T3_SOURCE_COMMIT } });

for (const lost of [false, true]) test(`pinned reserved busy MESSAGE sends real public packet and same-ID replay creates one app run; lost=${lost}`, async () => {
  const v = transport({ loseFirst: lost });
  try {
    const c = await v.adapter.contract();
    assert.equal(c.atomicIdleStart, false);
    assert.deepEqual(c.reservedDispatchPolicy, { kind: "t3-reserved-start-immediately-v1", maxPackets: 2, sourceCommit: T3_SOURCE_COMMIT });
    assert.equal((await v.adapter.send(frozenWire, { kind: "run", id: "reservation" }, frozen())).kind, lost ? "unknown" : "accepted");
    assert.equal((await v.adapter.send(frozenWire, { kind: "run", id: "reservation" }, frozen(frozenWire, 2))).kind, "accepted");
    assert.equal(v.appRuns, 1);
    assert.deepEqual(v.frames.map((f) => f.payload), [JSON.parse(frozenWire), JSON.parse(frozenWire)]);
    const s = await v.adapter.inspect(threadId);
    const reserved = s.runs.find((r) => r.id === "reserved-native")!;
    assert.equal(reserved.status, "queued"); assert.equal(reserved.inputText, "one frozen board prefix");
    Object.assign(v.snapshot.projection.runs.at(-1)!, { queueHeld: true });
    assert.equal((await v.adapter.inspect(threadId)).runs.at(-1)!.queueHeld, true);
    assert.equal(v.frames.some((f) => f.payload.type === "queue.resume"), false);
  } finally { v.http.close(); }
});

for (const fault of ["mode", "attachments", "version", "foreign_command", "missing_model", "changed_origin", "third_packet", "missing_journal", "changed_digest", "changed_policy"] as const)
  test(`HTTP reserved dispatch refuses ${fault} without a packet`, async () => {
    const v = transport(), wire = JSON.parse(frozenWire) as Record<string, unknown>;
    try {
      if (fault === "mode") wire.dispatchMode = { type: "queue_after_active" };
      if (fault === "attachments") wire.attachments = [{ id: "mutable" }];
      if (fault === "version") v.setVersion("unsupported");
      if (fault === "foreign_command") wire.type = "queue.resume";
      if (fault === "missing_model") delete wire.modelSelection;
      const packet = JSON.stringify(wire), policy = frozen(packet);
      if (fault === "changed_origin") policy.environmentId = "prior-environment";
      if (fault === "third_packet") policy.attempts = 3;
      if (fault === "changed_digest") policy.digest = "0".repeat(64);
      if (fault === "changed_policy") policy.dispatchPolicy.sourceCommit = "unreviewed";
      assert.notEqual((await v.adapter.send(packet, { kind: "run", id: "reservation" }, fault === "missing_journal" ? undefined : policy)).kind, "accepted");
      assert.equal(v.frames.length, 0); assert.equal(v.appRuns, 0);
    } finally { v.http.close(); }
  });

test("ordinary command always fetches actual detail twice, even absent outputOmitted, with exact outcome/source", async () => {
  const v = transport();
  try {
    const s = await v.adapter.detail(threadId, "item");
    assert.equal(s.complete, true); assert.deepEqual(s.issues, []);
    assert.equal(s.output, "/fixture\n"); assert.equal(s.exitCode, 0);
    assert.equal(s.attemptId, "attempt"); assert.equal(s.generation, 1);
    assert.equal(Object.hasOwn(v.snapshot.projection.attempts[0]!, "threadId"), false);
    assert.equal(v.detailReads, 2); assert.equal(v.snapshotReads, 3);
    assert.ok(resultDigest(s));
    assert.deepEqual(v.frames.map((f) => f.tag), ["orchestration.getTurnItem", "orchestration.getTurnItem"]);
    assert.ok(v.auth.some((value) => value === "Bearer fixture-only"));
  } finally { v.http.close(); }
});

for (const progress of ["unchanged", "same_time_body", "unrelated_native"] as const)
  test(`actual detail final checkpoint ${progress} cannot relabel an earlier second body to a newer floor`, async () => {
    const v = transport(), originalBody = v.item.output, originalTimestamp = v.item.updatedAt;
    let mutated = false;
    try {
      v.onSnapshot((count) => {
        if (count === 3 && progress !== "unchanged") {
          assert.equal(v.detailReads, 2, "mutation is inside the final adapter snapshot after both real RPC reads");
          if (progress === "same_time_body") v.item.output = "Changed body after second RPC, same timestamp";
          else Reflect.set(v.snapshot.projection.nodes[0]!, "progress", "Unrelated native root progress");
          v.snapshot.snapshotSequence++; mutated = true;
          assert.equal(v.item.updatedAt, originalTimestamp);
        }
        return v.snapshot;
      });
      if (progress === "unchanged") {
        const detail = await v.adapter.detail(threadId, "item");
        assert.equal(detail.sequence, v.snapshot.snapshotSequence); assert.equal(detail.output, originalBody); assert.ok(resultDigest(detail));
      } else await assert.rejects(v.adapter.detail(threadId, "item"), /Unproved detail coverage/);
      assert.equal(mutated, progress !== "unchanged"); assert.equal(v.detailReads, 2); assert.equal(v.snapshotReads, 3);
      assert.equal(v.appRuns, 0); assert.equal(v.frames.some((f) => f.tag === "orchestration.dispatchCommand"), false);
    } finally { v.http.close(); }
  });

for (const nodeStatus of ["running", "completed", "failed", "cancelled", "interrupted", "idle"] as const) test(`ordinary terminal item retains volatile node ${nodeStatus} before consumption`, async () => {
  const v = transport();
  try {
    const original = normalizeT3Snapshot(v.snapshot, threadId).toolSources!.find((s) => s.itemId === "item")!;
    v.snapshot.projection.nodes[1]!.status = nodeStatus;
    const snapshot = normalizeT3Snapshot(v.snapshot, threadId), item = snapshot.toolSources!.find((s) => s.itemId === "item")!;
    assert.equal(item.nodeStatus, nodeStatus); assert.equal(item.status, "completed");
    assert.equal(sourceIdentity(item), sourceIdentity(original), "native lifecycle does not rewrite immutable source origin");
    assert.equal(sourceContradiction(item), false);
    const detail = await v.adapter.detail(threadId, "item");
    assert.equal(detail.nodeStatus, nodeStatus); assert.equal(v.detailReads, 2); assert.equal(v.snapshotReads, 3);
    assert.equal(ordinaryOutcomeCoherent(detail), nodeStatus === "completed");
    if (nodeStatus !== "completed") {
      assert.ok(snapshot.activities.some((a) => a.id === "tool-node" && a.status === nodeStatus));
      const node = snapshot.toolSources!.find((s) => s.type === "tool_node")!;
      assert.equal(exactAlias(node, item), false, "contradictory node outcome cannot vanish behind terminal item");
      assert.throws(() => resultDigest(detail), /unavailable/);
    } else {
      assert.equal(snapshot.activities.some((a) => a.id === "tool-node"), false);
      assert.ok(resultDigest(detail));
    }
  } finally { v.http.close(); }
});

for (const type of ["command_execution", "dynamic_tool"] as const) for (const status of ["completed", "failed", "cancelled", "interrupted"] as const)
  test(`actual detail ${type} matched terminal ${status} retains consumable exact outcome`, async () => {
    const v = transport(), f = fixture(type);
    try {
      Object.assign(v.item, f.item, { status });
      if (type === "dynamic_tool") delete v.item.exitCode;
      else v.item.exitCode = status === "completed" ? 0 : 7;
      const { output: _output, ...wire } = v.item;
      v.snapshot.projection.turnItems[0] = wire; v.snapshot.projection.nodes[1]!.status = status;
      const snapshot = normalizeT3Snapshot(v.snapshot, threadId), detail = await v.adapter.detail(threadId, "item");
      assert.equal(detail.complete, true); assert.deepEqual(detail.issues, []);
      assert.equal(detail.status, status); assert.equal(detail.nodeStatus, status); assert.equal(ordinaryOutcomeCoherent(detail), true);
      assert.equal(snapshot.activities.some((a) => a.id === "tool-node"), false, "only coherent alias suppresses separate node work");
      assert.equal(resultDigest(detail).length, 64); assert.equal(v.detailReads, 2); assert.equal(v.snapshotReads, 3);
      if (type === "command_execution") assert.equal(detail.exitCode, status === "completed" ? 0 : 7);
      else assert.deepEqual(detail.output, { answer: 42 });
      const { nodeStatus: _nodeStatus, ...missingNodeOutcome } = detail;
      assert.throws(() => resultDigest(missingNodeOutcome), /unavailable/, "missing terminal node outcome is not positive evidence");
      assert.throws(() => resultDigest({ ...detail, nodeStatus: status === "failed" ? "completed" : "failed" }), /unavailable/);
    } finally { v.http.close(); }
  });

for (const output of ["", "  \n", null, [], {}, { value: [null, 1, false] }])
  test(`ordinary dynamic PRESENT ${JSON.stringify(output)} remains a complete lossless detail result`, async () => {
    const v = transport(), f = fixture("dynamic_tool");
    Object.assign(v.item, f.item, { output }); delete v.item.exitCode; v.snapshot.projection.turnItems[0] = f.snapshot.projection.turnItems[0]!;
    try { const s = await v.adapter.detail(threadId, "item"); assert.equal(s.complete, true); assert.deepEqual(s.output, output); assert.ok(resultDigest(s)); }
    finally { v.http.close(); }
  });

for (const fault of ["marker", "image", "opaque", "oversize", "oversize_input", "summary", "withheld", "missing_output", "wrong_exit", "wrong_item", "fetch_failure", "unstable_output", "generation", "partial", "status", "revision", "final_generation", "final_revision"] as const)
  test(`ordinary detail holds ${fault} and never hashes a lossy/full-fetch substitute`, async () => {
    const v = transport();
    if (fault === "marker") v.item.output = "prefix\n… output truncated for transport";
    if (fault === "image") v.item.output = [{ type: "image", mimeType: "image/png" }];
    if (fault === "opaque") v.item.output = { source: { type: "base64" } };
    if (fault === "oversize") v.item.output = "x".repeat(8192);
    if (fault === "oversize_input") { v.item.input = "x".repeat(8192); v.snapshot.projection.turnItems[0]!.input = v.item.input; }
    if (fault === "summary") v.item.output = { summary: "small", truncated: true };
    if (fault === "withheld") v.item.outputOmitted = true;
    if (fault === "missing_output") delete v.item.output;
    if (fault === "wrong_exit") v.item.exitCode = 1;
    if (fault === "wrong_item") v.onDetail(() => ({ item: { ...v.item, id: "other" } }));
    if (fault === "fetch_failure") v.onDetail(() => { throw new Error("simulated fetch unavailable"); });
    if (fault === "unstable_output") v.onDetail((count) => ({ item: { ...v.item, output: count === 1 ? "first" : "changed" } }));
    if (fault === "generation") v.onSnapshot((count) => { if (count === 2) v.snapshot.projection.attempts[0]!.attemptOrdinal = 2; return v.snapshot; });
    if (fault === "partial") v.onSnapshot(() => ({ ...v.snapshot, hasMoreHistory: true }));
    if (fault === "status") v.onSnapshot((count) => { if (count === 2) v.snapshot.projection.turnItems[0]!.status = "failed"; return v.snapshot; });
    if (fault === "revision") v.onSnapshot((count) => { if (count === 2) v.snapshot.projection.turnItems[0]!.updatedAt = "2026-10-07T01:00:01.000Z"; return v.snapshot; });
    if (fault === "final_generation") v.onSnapshot((count) => { if (count === 3) v.snapshot.projection.attempts[0]!.attemptOrdinal = 2; return v.snapshot; });
    if (fault === "final_revision") v.onSnapshot((count) => { if (count === 3) v.snapshot.projection.turnItems[0]!.updatedAt = "2026-10-07T01:00:02.000Z"; return v.snapshot; });
    try {
      try {
        const s = await v.adapter.detail(threadId, "item"); assert.equal(s.complete, false); assert.ok(s.issues.length);
        assert.throws(() => resultDigest(s));
        if (["marker", "image", "opaque", "oversize", "summary"].includes(fault)) assert.deepEqual(s.output, v.item.output);
      } catch (error) {
        if (!["wrong_item", "fetch_failure", "generation", "partial", "status", "revision", "final_generation", "final_revision"].includes(fault)) throw error;
      }
      assert.equal(v.appRuns, 0); assert.equal(v.frames.some((frame) => frame.tag === "orchestration.dispatchCommand"), false);
    } finally { v.http.close(); }
  });

test("node-before-item source edge remains visible and exact item/node native alias coalesces", () => {
  const f = fixture("dynamic_tool"); f.snapshot.projection.turnItems = [];
  const before = normalizeT3Snapshot(f.snapshot, threadId).toolSources!;
  assert.equal(normalizeT3Snapshot(f.snapshot, threadId).activities[0]!.id, "tool-node");
  assert.equal(before.length, 1); assert.equal(before[0]!.type, "tool_node");
  assert.equal(before[0]!.itemId, null); assert.equal(before[0]!.nodeId, "tool-node"); assert.equal(before[0]!.complete, false);
  f.snapshot.projection.turnItems.push(f.item);
  const after = normalizeT3Snapshot(f.snapshot, threadId).toolSources!;
  assert.equal(after.length, 1); assert.equal(after[0]!.type, "dynamic_tool"); assert.equal(after[0]!.complete, true);
  assert.equal(after[0]!.nodeId, before[0]!.nodeId); assert.deepEqual(after[0]!.nativeRef, before[0]!.nativeRef);
  assert.deepEqual(after[0]!.toolSource, { key: "mcp:backroom-board", name: "Backroom", kind: "integration" });
  assert.equal(Object.hasOwn(after[0]!, "output"), false);
  assert.deepEqual(normalizeT3Snapshot(f.snapshot, threadId).activities.map((a) => a.id), ["item"]);
  assert.ok(normalizeT3Snapshot(f.snapshot, threadId).settled?.includes("activity:tool-node"), "exact coherent terminal alias settles its prior node-first pending key");
  f.snapshot.projection.nodes[1]!.nativeItemRef = { ...ref, nativeId: "unrelated" };
  const conflict = normalizeT3Snapshot(f.snapshot, threadId).toolSources!;
  assert.equal(conflict.length, 2); assert.equal(conflict[0]!.complete, false);
  assert.deepEqual(normalizeT3Snapshot(f.snapshot, threadId).activities.map((a) => a.id), ["item", "tool-node"]);
});

for (const fault of ["native_ref", "origin", "outcome", "unsupported"] as const)
  test(`node-first pending alias ${fault} is never settled by a contradicted item or unrelated node`, () => {
    const f = fixture("dynamic_tool"), node = f.snapshot.projection.nodes[1]!;
    f.snapshot.projection.turnItems = []; node.status = "running";
    const before = normalizeT3Snapshot(f.snapshot, threadId);
    assert.ok(before.pending.includes("activity:tool-node"));
    node.status = "completed"; f.snapshot.projection.turnItems.push(f.item);
    f.snapshot.projection.nodes.push({ ...node, id: "unrelated-node", parentNodeId: "root", status: "running", nativeItemRef: { ...ref, nativeId: "unrelated-native" } });
    if (fault === "native_ref") f.snapshot.projection.turnItems[0]!.nativeItemRef = { ...ref, nativeId: "changed-native" };
    if (fault === "origin") f.snapshot.projection.turnItems[0]!.threadId = "foreign-thread";
    if (fault === "outcome") node.status = "failed";
    if (fault === "unsupported") f.snapshot.projection.turnItems[0]!.type = "file_change";
    const after = normalizeT3Snapshot(f.snapshot, threadId);
    assert.equal(after.settled?.includes("activity:tool-node"), false);
    assert.equal(after.settled?.includes("activity:unrelated-node"), false);
    assert.ok(after.pending.includes("activity:unrelated-node"));
    assert.ok(after.activities.some((a) => a.id === "tool-node"));
  });

test("running own invocation has exact authenticated-source metadata without inventing a future output", async () => {
  const v = transport(), f = fixture("dynamic_tool");
  Object.assign(v.item, f.item, { status: "running" }); delete v.item.output; delete v.item.exitCode;
  v.snapshot.projection.nodes[1]!.status = "running";
  v.snapshot.projection.turnItems[0] = { ...f.snapshot.projection.turnItems[0]!, status: "running" };
  try { const s = await v.adapter.detail(threadId, "item"); assert.equal(s.complete, true); assert.equal(Object.hasOwn(s, "output"), false);
    assert.equal(Object.hasOwn(v.snapshot.projection.attempts[0]!, "threadId"), false);
    assert.throws(() => resultDigest(s)); }
  finally { v.http.close(); }
});

for (const edge of ["attempt_run", "attempt_root", "attempt_provider_thread", "turn_attempt", "turn_root", "turn_provider_thread", "provider_thread_origin", "root_origin", "run_origin"] as const)
  test(`actual RunAttempt origin is proved through immutable ${edge} edge; changed edge stays unavailable`, async () => {
    const v = transport();
    try {
      assert.equal(Object.hasOwn(v.snapshot.projection.attempts[0]!, "threadId"), false);
      if (edge === "attempt_run") v.snapshot.projection.attempts[0]!.runId = "foreign-run";
      if (edge === "attempt_root") v.snapshot.projection.attempts[0]!.rootNodeId = "foreign-root";
      if (edge === "attempt_provider_thread") v.snapshot.projection.attempts[0]!.providerThreadId = "foreign-provider-thread";
      if (edge === "turn_attempt") v.snapshot.projection.providerTurns[0]!.runAttemptId = "foreign-attempt";
      if (edge === "turn_root") v.snapshot.projection.providerTurns[0]!.nodeId = "foreign-root";
      if (edge === "turn_provider_thread") v.snapshot.projection.providerTurns[0]!.providerThreadId = "foreign-provider-thread";
      if (edge === "provider_thread_origin") v.snapshot.projection.providerThreads[0]!.appThreadId = "foreign-thread";
      if (edge === "root_origin") v.snapshot.projection.nodes[0]!.threadId = "foreign-thread";
      if (edge === "run_origin") {
        v.snapshot.projection.runs[0]!.threadId = "foreign-thread";
        await assert.rejects(v.adapter.detail(threadId, "item"), /Incomplete source checkpoint/); return;
      }
      const s = await v.adapter.detail(threadId, "item"); assert.equal(s.complete, false);
      assert.ok(s.issues.some((i) => ["tool_generation", "tool_node_root"].includes(i))); assert.throws(() => resultDigest(s));
    } finally { v.http.close(); }
  });

for (const type of ["file_change", "web_search", "future_native_tool"]) for (const status of ["running", "completed"])
  for (const ordering of ["node-first", "combined"])
    test(`native ${type}/${status}/${ordering} preserves exact supported alias or unsupported causal node`, async () => {
      const v = transport(), p = v.snapshot.projection;
      const unsupported: Record<string, unknown> = { ...p.turnItems[0]!, type, status };
      delete unsupported.input;
      Object.assign(unsupported, type === "file_change" ? { fileName: "file.ts", diffStr: "+changed" } : { patterns: ["query"] });
      p.nodes[1]!.status = status; p.turnItems = ordering === "node-first" ? [] : [unsupported];
      try {
        const first = await v.adapter.inspect(threadId);
        assert.deepEqual(first.activities.map((a) => [a.id, a.runId, a.status]), [[type === "file_change" && ordering === "combined" ? "item" : "tool-node", "native-run", status]]);
        if (type !== "file_change" || ordering === "node-first") {
          const firstNode = first.toolSources!.find((s) => s.type === "tool_node")!;
          assert.equal(firstNode.complete, false);
        }
        if (ordering === "node-first") { p.turnItems.push(unsupported); v.snapshot.snapshotSequence++; }
        const combined = await v.adapter.inspect(threadId);
        assert.deepEqual(combined.activities.map((a) => [a.id, a.runId, a.status]), [[type === "file_change" ? "item" : "tool-node", "native-run", status]]);
        const retained = combined.toolSources!.find((s) => s.itemId === "item")!;
        assert.equal(retained.type, type);
        if (type === "file_change") {
          assert.equal(retained.complete, true); assert.equal(retained.fileChange!.fileName, "file.ts");
          assert.equal(combined.toolSources!.some((s) => s.type === "tool_node"), false);
          // This transport still returns the ORIGINAL command detail, so recognizing
          // supported edit metadata cannot manufacture matching edit result evidence.
          const mismatched = await v.adapter.detail(threadId, "item");
          assert.ok(mismatched.issues.includes("detail_checkpoint_mismatch")); assert.throws(() => resultDigest(mismatched));
          assert.equal(v.detailReads, 2);
        } else {
          assert.equal(retained.complete, false); assert.ok(retained.issues.includes("tool_type_unsupported"));
          assert.equal(combined.toolSources!.find((s) => s.type === "tool_node")!.complete, false);
          await assert.rejects(v.adapter.detail(threadId, "item"), /Exact ordinary source item unavailable/);
          assert.equal(v.detailReads, 0);
        }
        assert.equal(v.appRuns, 0);
      } finally { v.http.close(); }
    });

for (const changed of ["root", "provider_thread", "thread", "native_ref"] as const)
  test(`same item ID retains contradictory node ${changed} evidence and cannot alias a classified result`, () => {
    const f = fixture(), original = normalizeT3Snapshot(f.snapshot, threadId).toolSources!.find((s) => s.itemId === "item")!;
    if (changed === "root") f.snapshot.projection.nodes[1]!.rootNodeId = "changed-root";
    if (changed === "provider_thread") f.snapshot.projection.nodes[1]!.providerThreadId = "changed-provider-thread";
    if (changed === "thread") f.snapshot.projection.nodes[1]!.threadId = "changed-thread";
    if (changed === "native_ref") f.snapshot.projection.nodes[1]!.nativeItemRef = { ...ref, nativeId: "changed-native-ref" };
    const snapshot = normalizeT3Snapshot(f.snapshot, threadId), current = snapshot.toolSources!.find((s) => s.itemId === "item")!;
    assert.equal(current.itemId, original.itemId); assert.equal(current.complete, false); assert.equal(sourceContradiction(current), true);
    assert.notEqual(sourceIdentity(current), sourceIdentity(original)); assert.equal(exactAlias(current, original), false);
    assert.notDeepEqual(current.nodeEvidence, original.nodeEvidence);
    assert.ok(snapshot.activities.some((a) => a.id === original.nodeId), "contradictory node is not suppressed by the retained item ID");
  });

test("legitimate node-before-item alias allows only exact source edges with item availability missing", () => {
  const f = fixture(), item = normalizeT3Snapshot(f.snapshot, threadId).toolSources!.find((s) => s.itemId === "item")!;
  f.snapshot.projection.turnItems = [];
  const node = normalizeT3Snapshot(f.snapshot, threadId).toolSources!.find((s) => s.type === "tool_node")!;
  assert.deepEqual(node.issues, ["tool_item_unavailable"]); assert.equal(sourceContradiction(node), false); assert.equal(exactAlias(node, item), true);
  assert.equal(exactAlias({ ...node, rootNodeId: "different-root" }, item), false);
  assert.equal(exactAlias({ ...node, providerThreadId: "different-provider-thread" }, item), false);
  assert.equal(exactAlias({ ...node, issues: [...node.issues, "tool_generation"] }, item), false);
  assert.equal(exactAlias({ ...node, issues: [...node.issues, "tool_input_unavailable"] }, item), false);
  assert.equal(exactAlias({ ...item, type: "file_change", complete: false, issues: ["tool_type_unsupported"] }, item), false);
});

test("all native item identities/types survive unsupported form changes and never become ordinary results", () => {
  const f = fixture(), old = normalizeT3Snapshot(f.snapshot, threadId).toolSources!.find((s) => s.itemId === "item")!;
  for (const type of ["file_change", "web_search", "assistant_message", "future_native_type"]) {
    f.snapshot.projection.turnItems[0]!.type = type;
    const current = normalizeT3Snapshot(f.snapshot, threadId).toolSources!.find((s) => s.itemId === "item")!;
    assert.equal(current.type, type); assert.equal(current.itemId, old.itemId); assert.equal(current.complete, false);
    assert.notEqual(sourceIdentity(current), sourceIdentity(old)); assert.equal(exactAlias(current, old), false);
    assert.throws(() => resultDigest(current));
  }
});

test("row-only child retains exact original run without a turn-item or newest-run inference", () => {
  const f = fixture();
  f.snapshot.projection.subagents.push({ id: "row-only-child", threadId, runId: "native-run", origin: "provider_native", status: "running" });
  f.snapshot.projection.runs.push({ id: "newest-unrelated", threadId, userMessageId: "unrelated-input", status: "running" });
  const s = normalizeT3Snapshot(f.snapshot, threadId);
  const child = s.activities.find((a) => a.id === "row-only-child")!;
  assert.equal(child.runId, "native-run"); assert.equal(child.status, "running");
  assert.ok(s.pending.includes("nativeChildWake:row-only-child"));
});

for (const matched of [true, false]) test(`child row suppression requires actually retained exact originating activity alias=${matched}`, () => {
  const f = fixture();
  f.snapshot.projection.subagents.push({ id: "child", threadId, runId: "native-run", origin: "provider_native", status: "completed" });
  f.snapshot.projection.turnItems.push({ id: "child-item", type: "subagent", threadId, runId: matched ? "native-run" : "foreign-run", subagentId: "child", status: "completed" });
  const s = normalizeT3Snapshot(f.snapshot, threadId);
  assert.equal(s.activities.some((a) => a.id === "child" && a.runId === "native-run"), !matched);
  assert.equal(s.activities.some((a) => a.id === "child-item"), true);
});

for (const kind of ["run", "input", "queueHeld"] as const) test(`snapshot rejects wrong immutable ${kind} origin/status shape`, () => {
  const f = fixture();
  if (kind === "run") f.snapshot.projection.runs[0]!.threadId = "foreign-thread";
  if (kind === "input") f.snapshot.projection.messages[0]!.threadId = "foreign-thread";
  if (kind === "queueHeld") Object.assign(f.snapshot.projection.runs[0]!, { queueHeld: "unknown" });
  assert.ok(normalizeT3Snapshot(f.snapshot, threadId).issues.length);
});

test("small finite JSON guard rejects actual transport/opaque markers and exact byte boundary", () => {
  for (const value of ["Unserializable tool value", { truncated: true }, { type: "image" }, { data: "bytes" }, { mimeType: "x" }, "x".repeat(8192), Infinity, undefined])
    assert.equal(smallLosslessValue(value), false);
  assert.equal(smallLosslessValue({ finite: [null, false, "text", 42] }), true);
});
