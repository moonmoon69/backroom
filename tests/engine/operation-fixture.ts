import assert from "node:assert/strict";
import { EngineHttpT3Adapter } from "../../src/adapter/engine-http.ts";
import { HttpT3Adapter } from "../../src/adapter/http.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { T3_SERVER_VERSION } from "../../src/engine/provider.ts";
import type { OperationIntent } from "../../src/engine/operation-types.ts";
import type { Disposition, Run } from "../../src/engine/types.ts";
import { DiskRoom } from "./store-fixture.ts";

type Row = Record<string, unknown> & { id: string };
const timestamp = "2026-10-07T04:00:00.000Z";
export const simulatedThread = "thread:W";

/** Source-shaped in-memory T3 HTTP/RPC simulation, never a live provider service. */
export class SimulatedOperationSource {
  version = T3_SERVER_VERSION;
  environmentId = "simulated-operation-environment";
  detailReads = 0;
  snapshotReads = 0;
  contractReads = 0;
  appRuns = 0;
  disabled = false;
  controlResponse: "accepted" | "unknown" = "accepted";
  readonly frames: { tag: string; payload: Record<string, unknown> }[] = [];
  readonly detailItems = new Map<string, Row>();
  readonly commandReceipts = new Map<string, { sequence: number; threadId: string }>();
  readonly snapshot = {
    snapshotSequence: 1,
    hasMoreHistory: false,
    historyCursor: null as string | null,
    payloadBudgetExceeded: false,
    projection: {
      thread: { id: simulatedThread },
      runs: [] as Row[], attempts: [] as Row[], nodes: [] as Row[], providerTurns: [] as Row[],
      providerThreads: [{ id: "provider-thread", appThreadId: simulatedThread, driver: "codex", pendingBackgroundTasks: [] }] as Row[],
      messages: [] as Row[], turnItems: [] as Row[], subagents: [] as Row[],
      runtimeRequests: [] as Row[], contextTransfers: [] as Row[],
    },
  };
  onDetail: ((itemId: string, count: number) => Row) | null = null;
  onSnapshot: ((count: number) => unknown) | null = null;
  readonly http: HttpT3Adapter;
  readonly adapter: EngineHttpT3Adapter;
  constructor() {
    const source = this;
    class Socket {
      private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
      constructor(_url: string) { queueMicrotask(() => this.emit("open", "")); }
      addEventListener(kind: string, listener: (event: { data: string }) => void) {
        this.listeners.set(kind, [...this.listeners.get(kind) ?? [], listener]);
      }
      emit(kind: string, data: string) { for (const listener of this.listeners.get(kind) ?? []) listener({ data }); }
      send(text: string) {
        const frame = JSON.parse(text) as { id: string; tag: string; payload: Record<string, unknown> };
        source.frames.push(frame);
        queueMicrotask(() => {
          try {
            if (source.disabled) throw new Error("simulated transport reads disabled");
            let value: unknown;
            if (frame.tag === "orchestration.getTurnItem") {
              source.detailReads++;
              const id = String(frame.payload.itemId);
              const item = source.onDetail ? source.onDetail(id, source.detailReads) : source.detailItems.get(id);
              if (!item) throw new Error("simulated original detail unavailable");
              value = { item: structuredClone(item) };
            } else if (frame.tag === "orchestration.dispatchCommand") value = source.dispatch(frame.payload);
            else throw new Error(`unexpected simulated RPC ${frame.tag}`);
            this.emit("message", JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }));
          } catch {
            this.emit("message", JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure",
              cause: [{ _tag: "Fail", error: { message: "simulated RPC failure" } }] } }));
          }
        });
      }
      close() { this.emit("close", ""); }
    }
    const fetchImpl = (async (url: string | URL | Request) => {
      if (source.disabled) throw new Error("simulated transport reads disabled");
      const path = new URL(String(url)).pathname;
      let value: unknown;
      if (path === "/.well-known/t3/environment") {
        source.contractReads++;
        value = { environmentId: source.environmentId, label: "simulated finite protocol", serverVersion: source.version, orchestrationProtocolVersion: 2 };
      } else if (path.includes("websocket-ticket")) value = { ticket: "simulated-ticket" };
      else if (path === `/api/orchestration/threads/${encodeURIComponent(simulatedThread)}`) {
        source.snapshotReads++;
        value = source.onSnapshot ? source.onSnapshot(source.snapshotReads) : source.snapshot;
      } else throw new Error(`unexpected simulated HTTP path ${path}`);
      return new Response(JSON.stringify(value), { status: 200 });
    }) as typeof fetch;
    this.http = new HttpT3Adapter({ baseUrl: "http://simulation.invalid", accessToken: "simulation-only",
      fetchImpl, webSocketImpl: Socket, requestTimeoutMs: 100 });
    this.adapter = new EngineHttpT3Adapter(this.http);
  }
  private dispatch(command: Record<string, unknown>): { sequence: number } {
    const old = this.commandReceipts.get(String(command.commandId));
    if (old) { assert.equal(command.threadId, old.threadId); return { sequence: old.sequence }; }
    assert.equal(command.threadId, simulatedThread);
    if (command.type === "message.dispatch") {
      assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
      assert.deepEqual(command.attachments, []);
      const index = ++this.appRuns, nativeId = `native-run:${index}`, rootId = `root:${index}`, turnId = `turn:${index}`, attemptId = `attempt:${index}`;
      this.snapshot.projection.runs.push({ id: nativeId, threadId: simulatedThread, userMessageId: command.messageId, status: "running" });
      this.snapshot.projection.messages.push({ id: String(command.messageId), threadId: simulatedThread, runId: nativeId, role: "user", text: command.text });
      this.snapshot.projection.nodes.push({ id: rootId, threadId: simulatedThread, runId: nativeId, rootNodeId: rootId, parentNodeId: null,
        kind: "root_turn", countsForRun: true, providerThreadId: "provider-thread", providerTurnId: turnId, nativeItemRef: null, status: "running" });
      this.snapshot.projection.attempts.push({ id: attemptId, runId: nativeId, rootNodeId: rootId,
        providerThreadId: "provider-thread", providerTurnId: turnId, attemptOrdinal: 1, status: "running" });
      this.snapshot.projection.providerTurns.push({ id: turnId, providerThreadId: "provider-thread", nodeId: rootId,
        runAttemptId: attemptId, ordinal: 1, status: "running" });
    } else if (command.type === "runtime-request.respond") {
      const q = this.snapshot.projection.runtimeRequests.find((q) => q.id === command.requestId);
      assert.ok(q, "only the original simulated runtime request can receive a control");
      q.status = "resolved";
    } else if (command.type !== "run.interrupt") throw new Error("unexpected simulated native mutation");
    const sequence = ++this.snapshot.snapshotSequence;
    this.commandReceipts.set(String(command.commandId), { sequence, threadId: simulatedThread });
    if (command.type !== "message.dispatch" && this.controlResponse === "unknown") throw new Error("simulated postcommit response loss");
    return { sequence };
  }
  native(run: Run): { id: string; rootId: string; turnId: string; attemptId: string } {
    const row = this.snapshot.projection.runs.find((r) => r.userMessageId === run.dispatchMessageId);
    assert.ok(row);
    const root = this.snapshot.projection.nodes.find((n) => n.runId === row.id && n.kind === "root_turn");
    const attempt = this.snapshot.projection.attempts.find((a) => a.runId === row.id);
    assert.ok(root); assert.ok(attempt);
    return { id: row.id, rootId: root.id, turnId: String(root.providerTurnId), attemptId: attempt.id };
  }
  /** Simulated provider-owned wake: a distinct native run, NOT a Backroom message.dispatch. */
  continuation(original: Run, generation = 1): Run {
    const id = `native-continuation:${this.snapshot.projection.runs.length + 1}`, rootId = `${id}:root`, turnId = `${id}:turn`, attemptId = `${id}:attempt`;
    const messageId = `${id}:native-wake-input`;
    this.snapshot.projection.runs.push({ id, threadId: simulatedThread, userMessageId: messageId, status: "running" });
    this.snapshot.projection.messages.push({ id: messageId, threadId: simulatedThread, runId: id, role: "user", text: "simulated original registered activity wake" });
    this.snapshot.projection.nodes.push({ id: rootId, threadId: simulatedThread, runId: id, rootNodeId: rootId, parentNodeId: null,
      kind: "root_turn", countsForRun: true, providerThreadId: "provider-thread", providerTurnId: turnId, nativeItemRef: null, status: "running" });
    this.snapshot.projection.attempts.push({ id: attemptId, runId: id, rootNodeId: rootId,
      providerThreadId: "provider-thread", providerTurnId: turnId, attemptOrdinal: generation, status: "running" });
    this.snapshot.projection.providerTurns.push({ id: turnId, providerThreadId: "provider-thread", nodeId: rootId, runAttemptId: attemptId, ordinal: 1, status: "running" });
    this.snapshot.snapshotSequence++;
    return { ...original, dispatchMessageId: messageId };
  }
  project(item: Row): void {
    this.detailItems.set(item.id, item);
    // Ordinary wire snapshots deliberately omit output WITHOUT outputOmitted=true.
    const { output: _output, ...wire } = item;
    const old = this.snapshot.projection.turnItems.findIndex((row) => row.id === item.id);
    if (old < 0) this.snapshot.projection.turnItems.push(wire);
    else this.snapshot.projection.turnItems[old] = wire;
    this.snapshot.snapshotSequence++;
  }
  addTool(run: Run, id: string, options: { input: unknown; output?: unknown; type?: "command_execution" | "dynamic_tool";
    status?: string; exitCode?: number; operation?: string; projectItem?: boolean } ): Row {
    const native = this.native(run), ref = { driver: "codex", nativeId: `native-item:${id}`, strength: "strong" };
    const nodeId = `node:${id}`;
    this.snapshot.projection.nodes.push({ id: nodeId, threadId: simulatedThread, runId: native.id,
      rootNodeId: native.rootId, parentNodeId: native.rootId, kind: "tool_call", countsForRun: false,
      providerThreadId: "provider-thread", providerTurnId: native.turnId, nativeItemRef: ref, status: options.status ?? "running" });
    const item: Row = { id, threadId: simulatedThread, runId: native.id, nodeId,
      providerThreadId: "provider-thread", providerTurnId: native.turnId, nativeItemRef: ref, parentItemId: null, ordinal: 1,
      type: options.type ?? "dynamic_tool", status: options.status ?? "running", input: options.input, updatedAt: timestamp,
      startedAt: timestamp, completedAt: options.status === "completed" ? timestamp : null,
      ...(options.type === "command_execution" ? { exitCode: options.exitCode ?? 0 } : {
        toolName: `backroom-board.${options.operation ?? "own_run_view"}`,
        toolSource: { key: "mcp:backroom-board", name: "Backroom board", kind: "integration" } }),
      ...(Object.hasOwn(options, "output") ? { output: options.output } : {}) };
    if (options.projectItem !== false) this.project(item); else this.snapshot.snapshotSequence++;
    return item;
  }
  completeTool(item: Row, response: string): void {
    item.status = "completed"; item.output = JSON.parse(response); item.completedAt = timestamp;
    const node = this.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!; node.status = "completed";
    this.project(item);
  }
  endRun(run: Run, disposition: Disposition, body = ""): void {
    const native = this.native(run), text = JSON.stringify({ schema: "backroom.output.v1", body, disposition, receipts: [] });
    this.snapshot.projection.runs.find((r) => r.id === native.id)!.status = "completed";
    this.snapshot.projection.nodes.find((n) => n.id === native.rootId)!.status = "completed";
    this.snapshot.projection.attempts.find((a) => a.id === native.attemptId)!.status = "completed";
    this.snapshot.projection.providerTurns.find((t) => t.id === native.turnId)!.status = "completed";
    this.snapshot.projection.messages.push({ id: `final:${native.id}`, threadId: simulatedThread, runId: native.id,
      role: "assistant", text, streaming: false });
    this.snapshot.projection.turnItems.push({ id: `final-item:${native.id}`, threadId: simulatedThread, runId: native.id,
      type: "assistant_message", messageId: `final:${native.id}`, text, streaming: false, status: "completed" });
    this.snapshot.snapshotSequence++;
  }
  close(): void { this.http.close(); }
}

export interface OperationContext { run: Run; authorization: string; capabilityId: string }
export async function operationRoom(requests = ["A"]) {
  const d = new DiskRoom(), source = new SimulatedOperationSource(), x = new EngineReconciler(d.store, source.adapter);
  const protocol = new EngineLocalProtocol(d.store, source.adapter);
  async function start(): Promise<OperationContext> {
    const run = d.reserve("W", false);
    await x.prepareRun(d.room, run.id, { instanceId: "codex", model: "simulated-model" });
    const auth = protocol.authorizeRun(d.room, run.id, { generation: 1, server: "backroom-board" });
    await x.tick(d.room, "W"); await x.tick(d.room, "W");
    assert.ok(d.p.runs.get(run.id)!.providerRunId, "real HTTP adapter binds the simulated public dispatch");
    return { run, ...auth };
  }
  for (const id of requests) d.request(id);
  const initial = await start();
  const intent = (context: OperationContext, clientId: string, operation: OperationIntent["operation"], extra: Record<string, unknown> = {}) =>
    ({ schema: "backroom.operation.v1", operation, clientId, nonce: `nonce:${clientId}`, originRunId: context.run.id, ...extra }) as OperationIntent;
  const call = (context: OperationContext, raw: unknown, itemId: string, overrides: { authorization?: string | null; method?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorization = Object.hasOwn(overrides, "authorization") ? overrides.authorization : context.authorization;
    if (authorization !== null && authorization !== undefined) headers.authorization = authorization;
    return protocol.handle(d.room, new Request("http://backroom-simulation.invalid/local", {
      method: overrides.method ?? "POST", headers, body: JSON.stringify({ intent: raw, itemId }),
    }));
  };
  const projectOperation = (context: OperationContext, raw: OperationIntent, id = raw.clientId, projectItem = true) =>
    source.addTool(context.run, id, { input: raw, operation: raw.operation, projectItem });
  const receipt = (clientId: string) => [...d.p.operationReceipts.values()].find((r) => r.clientId === clientId)!;
  const claims = () => d.store.load(d.room).flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.outcome === "answered");
  const held = () => [...d.p.providerHolds.values()].filter((h) => h.held);
  return { d, source, x, protocol, initial, start, intent, call, projectOperation, receipt, claims, held,
    cleanup() { source.close(); d.cleanup(); } };
}

export type OperationRoom = Awaited<ReturnType<typeof operationRoom>>;
