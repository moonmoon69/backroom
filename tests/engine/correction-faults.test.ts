import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { fold } from "../../src/engine/fold.ts";
import { canonicalJSON, resultDigest } from "../../src/engine/result.ts";
import { hash } from "../../src/engine/provider.ts";
import { parseOperation } from "../../src/engine/operations.ts";
import type { ActivityIntent, LocalOperationPacket, OperationIntent } from "../../src/engine/operation-types.ts";
import type { Command, RoomEvent } from "../../src/engine/types.ts";
import { operationRoom, SimulatedOperationSource } from "./operation-fixture.ts";
import type { OperationContext, OperationRoom } from "./operation-fixture.ts";
import type { OperationWorkerInput } from "./operation-worker.ts";
import { waitForFiles } from "./store-fixture.ts";

interface WorkerResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface WorkerResponse { ok: boolean; error?: string; responseJSON?: string; replayed?: boolean }
function worker(input: OperationWorkerInput): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", new URL("./operation-worker.ts", import.meta.url).pathname, JSON.stringify(input)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`correction worker timed out: ${stdout} ${stderr}`)); }, 12000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function parity(store: EngineStore, room: string): void {
  assert.deepEqual(store.audit(room), { ok: true, mismatches: [], head: store.load(room).length });
  assert.deepEqual(store.project(room), fold(store.load(room)));
}
function baseline(h: OperationRoom, name: string): string {
  h.d.store.close(); const path = join(h.d.dir, name); cpSync(h.d.path, path);
  h.d.store = new EngineStore(h.d.path); return path;
}
function copy(base: string, path: string): string { cpSync(base, path); return path; }
function faults(count: number): string[] {
  return ["before_begin", "after_begin", "after_read", "after_decide", ...Array.from({ length: count }, (_, i) => `after_event:${i}`),
    "after_events", "after_index_delete", "after_projection", "after_indices", "before_commit", "after_commit"];
}
function copySource(h: OperationRoom): SimulatedOperationSource {
  const source = new SimulatedOperationSource();
  Object.assign(source.snapshot, structuredClone(h.source.snapshot)); source.appRuns = h.source.appRuns;
  source.frames.push(...structuredClone(h.source.frames));
  for (const [id, item] of h.source.detailItems) source.detailItems.set(id, structuredClone(item));
  for (const [id, receipt] of h.source.commandReceipts) source.commandReceipts.set(id, { ...receipt });
  return source;
}
function answerIntent(context: OperationContext, clientId: string, requestIds = ["A"]): OperationIntent {
  return { schema: "backroom.operation.v1", operation: "finish", clientId, nonce: `nonce:${clientId}`, originRunId: context.run.id,
    toolRefs: [], body: "Explicit HTTP completion after real process loss", disposition: { kind: "answer", requestIds } };
}
async function http(protocol: EngineLocalProtocol, room: string, context: OperationContext, intent: OperationIntent | ActivityIntent, itemId: string) {
  const path = intent.schema === "backroom.activity.v1" ? "/activities" : "/local";
  const response = await protocol.handle(room, new Request(`http://simulation.invalid${path}`, { method: "POST",
    headers: { authorization: context.authorization, "content-type": "application/json" }, body: JSON.stringify({ itemId, intent }) }));
  const text = await response.text(); assert.equal(response.status, 200, text); return text;
}
async function capturedAcceptedControl(h: OperationRoom): Promise<Extract<Command, { type: "control_phase" }>> {
  const native = h.source.native(h.initial.run);
  h.d.add({ type: "request", id: "Q", actor: "W", to: "O", parentId: "A", body: "Original runtime question",
    live: { runId: h.initial.run.id, providerRequestId: "native-question" } });
  h.source.snapshot.projection.runtimeRequests.push({ id: "native-question", threadId: "thread:W", nodeId: native.rootId,
    status: "pending", responseCapability: { type: "live" }, kind: "user_input" });
  h.source.snapshot.snapshotSequence++;
  h.d.add({ type: "runtime_reply", id: "reply:Q", actor: "O", requestId: "Q", commandId: "control:original-Q",
    body: JSON.stringify({ answers: { choice: "continue" } }) });
  const execute = h.d.store.execute.bind(h.d.store);
  let accepted: Extract<Command, { type: "control_phase" }> | undefined;
  h.d.store.execute = (room, command) => {
    if (command.type === "control_phase" && command.phase === "accepted") { accepted = command; throw new Error("captured native accepted receipt before writer commit"); }
    return execute(room, command);
  };
  try { await assert.rejects(h.x.tick(h.d.room, "W"), /captured native accepted receipt/); }
  finally { h.d.store.execute = execute; }
  assert.ok(accepted); assert.equal(h.d.p.controls.get("reply:Q")!.phase, "sending");
  assert.equal(h.source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1);
  return accepted;
}
function assertAcceptedHold(store: EngineStore, room: string): void {
  const p = store.project(room); assert.equal(p.controls.get("reply:Q")!.phase, "accepted");
  const hold = [...p.providerHolds.values()].find((h) => h.code === "control_effect:reply:Q");
  assert.ok(hold?.held); assert.equal(hold.scope, "work"); assert.deepEqual(hold.requestIds, ["Q", "A"]);
  const log = store.load(room);
  const phase = log.findLast((e) => e.data.kind === "control.phase" && e.data.controlId === "reply:Q" && e.data.phase === "accepted")!;
  const event = log.find((e) => e.commandKey === phase.commandKey && e.data.kind === "provider.hold" && e.data.hold.code === hold.code && e.data.hold.held);
  assert.ok(event, "accepted-phase batch contains its fixed causal work hold before any later observation");
  assert.equal(phase.commandKey, event.commandKey, "app acceptance and original causal work hold share one writer transaction");
}
function answered(log: RoomEvent[]): number {
  return log.flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.outcome === "answered" && c.requestId === "A").length;
}
async function assertRecoveredControlHTTP(h: OperationRoom, store: EngineStore, source: SimulatedOperationSource, suffix: string) {
  const protocol = new EngineLocalProtocol(store, source.adapter), x = new EngineReconciler(store, source.adapter), room = h.d.room;
  const intent = answerIntent(h.initial, `recovered-finish:${suffix}`), item = source.addTool(h.initial.run, intent.clientId, { input: intent, operation: intent.operation });
  const response = await http(protocol, room, h.initial, intent, item.id);
  assert.equal(JSON.parse(response).result.claims[0].outcome, "pending_activity");
  assert.equal(store.project(room).requests.get("A")!.state, "open"); assert.equal(answered(store.load(room)), 0);
  source.completeTool(item, response); source.endRun(h.initial.run, { kind: "yield" }, "Original runtime effect remains unproven");
  await x.tick(room, "W");
  store.execute(room, { type: "request", id: `B:${suffix}`, actor: "O", to: "W", body: "Independent new request" });
  store.reserveNative(room, "W", 1_000_000);
  const p = store.project(room), run = p.runs.get(p.seats.get("W")!.activeRunId!)!;
  await x.prepareRun(room, run.id, { instanceId: "codex", model: "simulated-model" });
  const context = { run, ...protocol.authorizeRun(room, run.id, { generation: 1, server: "backroom-board" }) };
  await x.tick(room, "W"); await x.tick(room, "W");
  const final = answerIntent(context, `independent-finish:${suffix}`, ["A", `B:${suffix}`]);
  const finalItem = source.addTool(context.run, final.clientId, { input: final, operation: final.operation });
  const finalResponse = await http(protocol, room, context, final, finalItem.id);
  assert.deepEqual(JSON.parse(finalResponse).result.claims.map((c: { requestId: string; outcome: string }) => [c.requestId, c.outcome]),
    [["A", "pending_activity"], [`B:${suffix}`, "answered"]]);
  assert.equal(source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1, "recovery never replays an accepted original runtime response");
  assert.equal(source.appRuns, 2); assert.equal(answered(store.load(room)), 0); assertAcceptedHold(store, room);
  assert.equal((await x.quiescence(room, "W")).proven, false); parity(store, room);
}

test("real SQLite SIGKILL across accepted control phase+fixed causal hold prevents recovered HTTP completion while independent B executes; native T3 is simulated", async (t) => {
  const h = await operationRoom();
  try {
    const command = await capturedAcceptedControl(h), base = baseline(h, "control-before-acceptance.sqlite"), before = h.d.store.load(h.d.room);
    const probe = new EngineStore(copy(base, join(h.d.dir, "control-expected.sqlite")));
    let expected: RoomEvent[];
    try { probe.execute(h.d.room, command); expected = probe.load(h.d.room); assertAcceptedHold(probe, h.d.room); parity(probe, h.d.room); }
    finally { probe.close(); }
    const count = expected!.length - before.length; assert.equal(count, 2);
    const injections = faults(count); t.diagnostic(`${count} atomic events, ${injections.length} real SIGKILL injections`);
    for (const [index, fault] of injections.entries()) {
      const path = copy(base, join(h.d.dir, `control-kill-${index}.sqlite`)), marker = join(h.d.dir, `control-marker-${index}`);
      const result = await worker({ action: "command", command, path, room: h.d.room, fault, marker });
      assert.equal(result.signal, "SIGKILL", `${fault}: ${result.stdout} ${result.stderr}`); assert.equal(readFileSync(marker, "utf8"), fault);
      const store = new EngineStore(path), source = copySource(h);
      try {
        assert.deepEqual(store.load(h.d.room), fault === "after_commit" ? expected! : before, fault); parity(store, h.d.room);
        if (fault === "after_commit") assertAcceptedHold(store, h.d.room);
        else assert.equal(store.project(h.d.room).controls.get("reply:Q")!.phase, "sending");
        assert.equal(store.execute(h.d.room, command).replayed, fault === "after_commit", fault);
        assert.deepEqual(store.load(h.d.room), expected!, fault); assertAcceptedHold(store, h.d.room);
        const head = store.load(h.d.room).length; assert.equal(store.execute(h.d.room, command).replayed, true);
        assert.equal(store.load(h.d.room).length, head); store.rebuild(h.d.room); parity(store, h.d.room);
        await assertRecoveredControlHTTP(h, store, source, String(index));
      } finally { source.close(); store.close(); }
    }
  } finally { h.cleanup(); }
});

async function registeredUnbound(h: OperationRoom) {
  const intent: ActivityIntent = { schema: "backroom.activity.v1", operation: "register_activity", clientId: "register-host-bound", nonce: "nonce:register-host-bound",
    originRunId: h.initial.run.id, activityId: "background", activityGeneration: 1, requestIds: ["A"], nativeId: null };
  const item = h.source.addTool(h.initial.run, intent.clientId, { input: intent, operation: intent.operation });
  const response = await http(h.protocol, h.d.room, h.initial, intent, item.id); h.source.completeTool(item, response);
  const execute = h.d.store.execute.bind(h.d.store); let command: Extract<Command, { type: "activity_bind" }> | undefined;
  h.d.store.execute = (room, value) => {
    if (value.type === "activity_bind") { command = value; throw new Error("captured host prelaunch binding before writer commit"); }
    return execute(room, value);
  };
  try { await assert.rejects(h.protocol.bindActivity(h.d.room, "background", { nativeId: "native-item:background-result", generation: 1 }), /captured host prelaunch binding/); }
  finally { h.d.store.execute = execute; }
  assert.ok(command); assert.equal(h.d.p.activities.get("background")!.nativeSource!.nativeId, null);
  return { command, intent, response, itemId: item.id };
}
async function assertActivityReceiptFirst(h: OperationRoom, store: EngineStore, source: SimulatedOperationSource, registration: Awaited<ReturnType<typeof registeredUnbound>>) {
  const protocol = new EngineLocalProtocol(store, source.adapter), room = h.d.room;
  const observation = store.project(room).providerObservations.get("W")!;
  store.execute(room, { type: "observe_provider", actor: "$system", id: "advanced-checkpoint-after-bind", observation: { ...observation, sequence: observation.sequence + 10 },
    pending: observation.pending, settled: [] });
  source.snapshot.snapshotSequence = observation.sequence + 11; source.disabled = true;
  const reads = [source.contractReads, source.snapshotReads, source.detailReads];
  assert.equal(await http(protocol, room, h.initial, registration.intent, "original-item-now-unavailable"), registration.response);
  assert.deepEqual([source.contractReads, source.snapshotReads, source.detailReads], reads);
  assert.equal(store.project(room).activityReceipts.size, 1); source.disabled = false;
  const result = source.addTool(h.initial.run, "background-result", { type: "command_execution", input: "original registered background execution",
    output: "Exact original background result\n", exitCode: 0, status: "completed" });
  const toolRef = { itemId: result.id, digest: resultDigest(await source.adapter.detail("thread:W", result.id)), requestIds: ["A"] };
  const intent: ActivityIntent = { schema: "backroom.activity.v1", operation: "record_activity_result", clientId: "record-host-bound", nonce: "nonce:record-host-bound",
    originRunId: h.initial.run.id, activityId: "background", activityGeneration: 1, toolRef, body: "Original correlated background result", completion: "done",
    disposition: { kind: "answer", requestIds: ["A"] } };
  const item = source.addTool(h.initial.run, intent.clientId, { input: intent, operation: intent.operation });
  const response = await http(protocol, room, h.initial, intent, item.id);
  assert.equal(store.project(room).activities.get("background")!.status, "done");
  assert.equal(store.project(room).activities.get("background")!.nativeSource!.nativeId, "native-item:background-result");
  assert.equal(store.project(room).activityReceipts.size, 2);
  assert.ok([...store.project(room).toolResults.values()].some((r) => r.source.itemId === result.id && r.source.output === "Exact original background result\n"));
  source.disabled = true; const nextReads = [source.contractReads, source.snapshotReads, source.detailReads];
  assert.equal(await http(protocol, room, h.initial, intent, "recording-item-now-unavailable"), response);
  assert.deepEqual([source.contractReads, source.snapshotReads, source.detailReads], nextReads); parity(store, room);
}

test("real SQLite SIGKILL around host-only activity binding leaves no partial identity and preserves original activity receipts before provider rereads", async (t) => {
  const h = await operationRoom();
  try {
    const registration = await registeredUnbound(h), base = baseline(h, "unbound-activity.sqlite"), before = h.d.store.load(h.d.room);
    const probe = new EngineStore(copy(base, join(h.d.dir, "activity-bound-expected.sqlite")));
    let expected: RoomEvent[];
    try { probe.execute(h.d.room, registration.command); expected = probe.load(h.d.room); parity(probe, h.d.room); }
    finally { probe.close(); }
    const count = expected!.length - before.length; assert.equal(count, 1);
    const injections = faults(count); t.diagnostic(`${count} atomic binding event, ${injections.length} real SIGKILL injections`);
    for (const [index, fault] of injections.entries()) {
      const path = copy(base, join(h.d.dir, `binding-kill-${index}.sqlite`)), marker = join(h.d.dir, `binding-marker-${index}`);
      const result = await worker({ action: "command", command: registration.command, path, room: h.d.room, fault, marker });
      assert.equal(result.signal, "SIGKILL", `${fault}: ${result.stdout} ${result.stderr}`); assert.equal(readFileSync(marker, "utf8"), fault);
      const store = new EngineStore(path), source = copySource(h);
      try {
        assert.deepEqual(store.load(h.d.room), fault === "after_commit" ? expected! : before, fault);
        assert.equal(store.project(h.d.room).activities.get("background")!.nativeSource!.nativeId, fault === "after_commit" ? "native-item:background-result" : null);
        assert.equal(store.execute(h.d.room, registration.command).replayed, fault === "after_commit", fault);
        assert.deepEqual(store.load(h.d.room), expected!, fault); store.rebuild(h.d.room); parity(store, h.d.room);
        await assertActivityReceiptFirst(h, store, source, registration);
        const bindings = store.load(h.d.room).filter((e) => e.data.kind === "activity.native_bound"); assert.equal(bindings.length, 1);
      } finally { source.close(); store.close(); }
    }
  } finally { h.cleanup(); }
});

async function race(h: OperationRoom, inputs: OperationWorkerInput[]): Promise<WorkerResponse[]> {
  const ready = inputs.map((_, i) => join(h.d.dir, `correction-ready-${i}`)), go = join(h.d.dir, "correction-race-go");
  const processes = inputs.map((input, i) => worker({ ...input, ready: ready[i]!, go }));
  await waitForFiles(ready); writeFileSync(go, "go");
  return (await Promise.all(processes)).map((r) => { assert.equal(r.signal, null, r.stderr); return JSON.parse(r.stdout) as WorkerResponse; });
}

test("two real SQLite host binding writers choose exactly one immutable native identity, preserve registration receipt and reject replacement", async () => {
  const h = await operationRoom();
  try {
    const registration = await registeredUnbound(h), path = baseline(h, "competing-host-bindings.sqlite");
    const other = { ...registration.command, id: "different-host-native-binding", nativeId: "native-item:competing-result" };
    const results = await race(h, [{ action: "command", path, room: h.d.room, command: registration.command }, { action: "command", path, room: h.d.room, command: other }]);
    assert.equal(results.filter((r) => r.ok).length, 1); assert.match(results.find((r) => !r.ok)!.error!, /prelaunch native identity/);
    const store = new EngineStore(path), source = copySource(h);
    try {
      const bindings = store.load(h.d.room).filter((e) => e.data.kind === "activity.native_bound"); assert.equal(bindings.length, 1);
      const original = store.project(h.d.room).activities.get("background")!.nativeSource!.nativeId;
      assert.ok(original === registration.command.nativeId || original === other.nativeId);
      const before = store.load(h.d.room), loser = original === registration.command.nativeId ? other : registration.command;
      assert.throws(() => store.execute(h.d.room, { ...loser, id: "rejected-post-race-replacement" }), /prelaunch native identity/);
      assert.deepEqual(store.load(h.d.room), before);
      source.disabled = true; const reads = [source.contractReads, source.snapshotReads, source.detailReads];
      assert.equal(await http(new EngineLocalProtocol(store, source.adapter), h.d.room, h.initial, registration.intent, "unavailable"), registration.response);
      assert.deepEqual([source.contractReads, source.snapshotReads, source.detailReads], reads); parity(store, h.d.room);
    } finally { source.close(); store.close(); }
  } finally { h.cleanup(); }
});

test("accepted control and local HTTP finish race through SQLite serialization never answers original A, regardless of writer order", async () => {
  for (const order of ["accept-first", "finish-first", "simultaneous"] as const) {
    const h = await operationRoom();
    try {
      const command = await capturedAcceptedControl(h), intent = answerIntent(h.initial, `concurrent-finish:${order}`);
      const item = h.projectOperation(h.initial, intent), source = await h.source.adapter.detail("thread:W", item.id);
      const snapshot = await h.source.adapter.inspect("thread:W"); assert.equal(h.x.observe(h.d.room, "W", await h.source.adapter.contract(), snapshot), true);
      const packet: LocalOperationPacket = { capabilityId: h.initial.capabilityId, intent, intentJSON: canonicalJSON(parseOperation(intent)),
        source, tools: [], view: [], sequence: snapshot.sequence, sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
      const path = baseline(h, `control-finish-${order}.sqlite`), acceptance: OperationWorkerInput = { action: "command", path, room: h.d.room, command },
        finish: OperationWorkerInput = { action: "operation", path, room: h.d.room, packet };
      let results: WorkerResponse[];
      if (order === "simultaneous") results = await race(h, [acceptance, finish]);
      else {
        const first = order === "accept-first" ? acceptance : finish, second = order === "accept-first" ? finish : acceptance;
        const holdReady = join(h.d.dir, "winning-writer-locked"), holdGo = join(h.d.dir, "release-winning-writer");
        const firstProcess = worker({ ...first, holdReady, holdGo }); await waitForFiles([holdReady]);
        const secondProcess = worker(second); writeFileSync(holdGo, "release");
        results = (await Promise.all([firstProcess, secondProcess])).map((r) => { assert.equal(r.signal, null, r.stderr); return JSON.parse(r.stdout) as WorkerResponse; });
      }
      assert.ok(results.every((r) => r.ok), JSON.stringify(results));
      const store = new EngineStore(path);
      try {
        assertAcceptedHold(store, h.d.room); assert.equal(store.project(h.d.room).requests.get("A")!.state, "open"); assert.equal(answered(store.load(h.d.room)), 0);
        const receipt = [...store.project(h.d.room).operationReceipts.values()][0]!;
        assert.equal(receipt.result.claims[0]!.outcome, "pending_activity");
        assert.equal(store.project(h.d.room).operationReceipts.size, 1); assert.equal(store.project(h.d.room).operationBindings.size, 1);
        assert.equal(store.load(h.d.room).filter((e) => e.data.kind === "output").length, 1);
        const log = store.load(h.d.room), accepted = log.find((e) => e.data.kind === "control.phase" && e.data.phase === "accepted")!,
          output = log.find((e) => e.data.kind === "output")!;
        if (order !== "simultaneous") assert.equal(accepted.seq < output.seq, order === "accept-first");
        assert.equal(h.source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1);
        const originalResponse = receipt.responseJSON, protocol = new EngineLocalProtocol(store, h.source.adapter); h.source.disabled = true;
        const reads = [h.source.contractReads, h.source.snapshotReads, h.source.detailReads];
        assert.equal(await http(protocol, h.d.room, h.initial, intent, "projection-unavailable-after-race"), originalResponse);
        assert.deepEqual([h.source.contractReads, h.source.snapshotReads, h.source.detailReads], reads); parity(store, h.d.room);
      } finally { store.close(); }
    } finally { h.cleanup(); }
  }
});
