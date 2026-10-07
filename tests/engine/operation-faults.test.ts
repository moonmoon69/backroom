import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { canonicalJSON, resultDigest } from "../../src/engine/result.ts";
import { hash } from "../../src/engine/provider.ts";
import { parseActivity, parseOperation } from "../../src/engine/operations.ts";
import { fold } from "../../src/engine/fold.ts";
import type { ActivityIntent, ActivityPacket, LocalOperationPacket, OperationIntent } from "../../src/engine/operation-types.ts";
import type { Command, RoomEvent } from "../../src/engine/types.ts";
import type { OperationWorkerInput } from "./operation-worker.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { OperationRoom } from "./operation-fixture.ts";
import { waitForFiles } from "./store-fixture.ts";

interface WorkerResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface WorkerResponse { ok: boolean; replayed?: boolean; responseJSON?: string; packetDigest?: string; error?: string }
function worker(input: OperationWorkerInput): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", new URL("./operation-worker.ts", import.meta.url).pathname, JSON.stringify(input)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("operation worker timed out")); }, 12000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function parity(store: EngineStore, room: string): void {
  assert.deepEqual(store.audit(room), { ok: true, mismatches: [], head: store.load(room).length });
  assert.deepEqual(store.project(room), fold(store.load(room)));
}
function immutableCopy(h: OperationRoom, name: string): string {
  // Closing the sole original connection checkpoints WAL before a DB-only copy.
  h.d.store.close(); const path = join(h.d.dir, name); cpSync(h.d.path, path);
  h.d.store = new EngineStore(h.d.path); return path;
}
function clone(base: string, target: string): string { cpSync(base, target); return target; }
function answered(log: RoomEvent[]): number { return log.flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.outcome === "answered").length; }

async function operationPacket(h: OperationRoom, intent: OperationIntent, id = intent.clientId, aliases: string[] = []): Promise<LocalOperationPacket> {
  h.projectOperation(h.initial, intent, id);
  for (const alias of aliases) h.projectOperation(h.initial, intent, alias);
  const source = await h.source.adapter.detail("thread:W", id);
  const tools: LocalOperationPacket["tools"] = [];
  if (intent.operation !== "own_run_view") for (const ref of intent.toolRefs) tools.push({ ref, source: await h.source.adapter.detail("thread:W", ref.itemId) });
  const snapshot = await h.source.adapter.inspect("thread:W");
  assert.equal(h.x.observe(h.d.room, "W", await h.source.adapter.contract(), snapshot), true);
  const packet: LocalOperationPacket = { capabilityId: h.initial.capabilityId, intent, intentJSON: canonicalJSON(parseOperation(intent)), source,
    aliases: snapshot.toolSources!.filter((s) => aliases.includes(s.itemId ?? "")), tools, view: [], sequence: snapshot.sequence, sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
  assert.equal(source.complete, true); return packet;
}
async function pwdRef(h: OperationRoom, id = "pwd", nativeId?: string) {
  const item = h.source.addTool(h.initial.run, id, { type: "command_execution", input: "pwd", output: "/fixture\n", exitCode: 0, status: "completed" });
  if (nativeId) { item.nativeItemRef = { driver: "codex", nativeId, strength: "strong" };
    h.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.nativeItemRef = item.nativeItemRef; h.source.project(item); }
  const source = await h.source.adapter.detail("thread:W", id);
  return { itemId: id, digest: resultDigest(source), requestIds: ["A"] };
}
async function activityPacket(h: OperationRoom, intent: Extract<ActivityIntent, {schema: "backroom.activity.v1"}>): Promise<ActivityPacket> {
  h.source.addTool(h.initial.run, intent.clientId, { input: intent, operation: intent.operation });
  const source = await h.source.adapter.detail("thread:W", intent.clientId);
  const resultSource = intent.operation === "record_activity_result" ? await h.source.adapter.detail("thread:W", intent.toolRef.itemId) : null;
  const snapshot = await h.source.adapter.inspect("thread:W");
  assert.equal(h.x.observe(h.d.room, "W", await h.source.adapter.contract(), snapshot), true);
  return { capabilityId: h.initial.capabilityId, intent, intentJSON: canonicalJSON(parseActivity(intent)), source, resultSource, sequence: snapshot.sequence, sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
}
async function authenticatedActivity(h: OperationRoom, intent: ActivityIntent, itemId: string): Promise<string> {
  const response = await h.protocol.handle(h.d.room, new Request("http://simulation.invalid/activities", {
    method: "POST", headers: { "content-type": "application/json", authorization: h.initial.authorization }, body: JSON.stringify({ intent, itemId }),
  }));
  assert.equal(response.status, 200); return response.text();
}
type Prepared = { h: OperationRoom; action: "operation"; packet: LocalOperationPacket } | { h: OperationRoom; action: "activity"; packet: ActivityPacket };
async function prepare(kind: "view" | "consume" | "finish" | "register" | "activity-result"): Promise<Prepared> {
  const h = await operationRoom();
  try {
    if (kind === "view") return { h, action: "operation", packet: await operationPacket(h, h.intent(h.initial, "view", "own_run_view")) };
    if (kind === "consume" || kind === "finish") {
      const ref = await pwdRef(h);
      const intent = h.intent(h.initial, kind, kind === "consume" ? "consume_tool_result" : "finish", {
        toolRefs: [ref], ...(kind === "finish" ? { body: "result fixture", disposition: { kind: "answer", requestIds: ["A"] } } : {}),
      });
      return { h, action: "operation", packet: await operationPacket(h, intent) };
    }
    const registration: ActivityIntent = { schema: "backroom.activity.v1", operation: "register_activity", clientId: "register", nonce: "nonce:register",
      originRunId: h.initial.run.id, activityId: "background", activityGeneration: 1, requestIds: ["A"], nativeId: "native-background-original" };
    if (kind === "register") return { h, action: "activity", packet: await activityPacket(h, registration) };
    h.source.addTool(h.initial.run, registration.clientId, { input: registration, operation: registration.operation });
    const response = await authenticatedActivity(h, registration, registration.clientId);
    h.source.completeTool(h.source.detailItems.get(registration.clientId)!, response);
    const ref = await pwdRef(h, "background-result", registration.nativeId!);
    const intent: ActivityIntent = { schema: "backroom.activity.v1", operation: "record_activity_result", clientId: "activity-result", nonce: "nonce:activity-result",
      originRunId: h.initial.run.id, activityId: "background", activityGeneration: 1, toolRef: ref, body: "registered original result", completion: "done",
      disposition: { kind: "answer", requestIds: ["A"] } };
    return { h, action: "activity", packet: await activityPacket(h, intent) };
  } catch (error) { h.cleanup(); throw error; }
}
function commit(store: EngineStore, room: string, p: Prepared) {
  return p.action === "operation" ? store.commitOperation(room, p.packet) : store.commitActivity(room, p.packet);
}
function workerInput(p: Prepared, path: string): OperationWorkerInput {
  return p.action === "operation" ? { action: "operation", packet: p.packet, room: p.h.d.room, path }
    : { action: "activity", packet: p.packet, room: p.h.d.room, path };
}

for (const kind of ["view", "consume", "finish", "register", "activity-result"] as const)
  test(`real SQLite SIGKILL around atomic ${kind} receipt/effects/bindings/claims; source T3 is simulated`, async (t) => {
    const p = await prepare(kind), h = p.h;
    try {
      const base = immutableCopy(h, "baseline.sqlite"), before = h.d.store.load(h.d.room);
      const probe = new EngineStore(clone(base, join(h.d.dir, "expected.sqlite")));
      let expected: RoomEvent[], responseJSON: string;
      try { responseJSON = commit(probe, h.d.room, p).receipt.responseJSON; expected = probe.load(h.d.room); parity(probe, h.d.room); }
      finally { probe.close(); }
      const count = expected!.length - before.length; assert.ok(count > 0);
      if (kind === "finish") assert.equal(answered(expected!), 1);
      const faults = ["before_begin", "after_begin", "after_read", "after_decide", ...Array.from({ length: count }, (_, i) => `after_event:${i}`),
        "after_events", "after_index_delete", "after_projection", "after_indices", "before_commit", "after_commit"];
      t.diagnostic(`${count} batch events; ${faults.length} real SIGKILL injections`);
      for (const [index, fault] of faults.entries()) {
        const path = clone(base, join(h.d.dir, `kill-${index}.sqlite`)), marker = join(h.d.dir, `marker-${index}`);
        const result = await worker({ ...workerInput(p, path), fault, marker });
        assert.equal(result.signal, "SIGKILL", `${fault}: ${result.stdout} ${result.stderr}`);
        assert.equal(readFileSync(marker, "utf8"), fault);
        const store = new EngineStore(path);
        try {
          assert.deepEqual(store.load(h.d.room), fault === "after_commit" ? expected! : before, fault);
          parity(store, h.d.room);
          const recovery = commit(store, h.d.room, p); assert.equal(recovery.replayed, fault === "after_commit", fault);
          assert.equal(recovery.receipt.responseJSON, responseJSON!, fault);
          assert.deepEqual(store.load(h.d.room), expected!, fault);
          const head = store.load(h.d.room).length; assert.equal(commit(store, h.d.room, p).replayed, true);
          assert.equal(store.load(h.d.room).length, head); store.rebuild(h.d.room); parity(store, h.d.room);
          if (kind === "finish") assert.equal(answered(store.load(h.d.room)), 1);
          if (kind === "activity-result") { assert.equal(store.project(h.d.room).activities.get("background")!.status, "done"); assert.equal(store.project(h.d.room).toolResults.size, 1); }
        } finally { store.close(); }
      }
    } finally { h.cleanup(); }
  });

test("aftercommit process-loss replays original frozen HTTP response before disabled provider reads and fresh sequence", async () => {
  const p = await prepare("finish"), h = p.h;
  try {
    const base = immutableCopy(h, "receipt-first.sqlite"), marker = join(h.d.dir, "aftercommit");
    const result = await worker({ ...workerInput(p, base), fault: "after_commit", marker }); assert.equal(result.signal, "SIGKILL");
    const store = new EngineStore(base);
    try {
      const original = store.lookupOperation(h.d.room, p.packet.capabilityId, p.packet.intentJSON)!;
      const observation = store.project(h.d.room).providerObservations.get("W")!;
      store.execute(h.d.room, { type: "observe_provider", actor: "$system", id: "advanced-source", observation: { ...observation, sequence: observation.sequence + 10 }, pending: observation.pending, settled: [] });
      h.source.disabled = true; const reads = [h.source.contractReads, h.source.snapshotReads, h.source.detailReads];
      const protocol = new EngineLocalProtocol(store, h.source.adapter);
      const response = await protocol.handle(h.d.room, new Request("http://simulation.invalid/local", { method: "POST",
        headers: { "content-type": "application/json", authorization: h.initial.authorization }, body: JSON.stringify({ intent: p.packet.intent, itemId: "projection-now-missing" }) }));
      assert.equal(response.status, 200); assert.equal(await response.text(), original.responseJSON);
      assert.deepEqual([h.source.contractReads, h.source.snapshotReads, h.source.detailReads], reads);
      assert.equal(store.project(h.d.room).operationReceipts.size, 1); assert.equal(store.project(h.d.room).toolResults.size, 1);
      assert.equal(answered(store.load(h.d.room)), 1); parity(store, h.d.room);
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

test("activity-result aftercommit loss replays original HTTP activity receipt before changed checkpoint and disabled source", async () => {
  const p = await prepare("activity-result"), h = p.h;
  try {
    assert.equal(p.action, "activity");
    const path = immutableCopy(h, "activity-receipt-first.sqlite"), marker = join(h.d.dir, "activity-aftercommit");
    assert.equal((await worker({ ...workerInput(p, path), fault: "after_commit", marker })).signal, "SIGKILL");
    const store = new EngineStore(path);
    try {
      const original = store.lookupActivity(h.d.room, p.packet.capabilityId, p.packet.intentJSON)!;
      const observation = store.project(h.d.room).providerObservations.get("W")!;
      store.execute(h.d.room, { type: "observe_provider", actor: "$system", id: "advanced-activity-source",
        observation: { ...observation, sequence: observation.sequence + 10 }, pending: observation.pending, settled: [] });
      h.source.disabled = true; const reads = [h.source.contractReads, h.source.snapshotReads, h.source.detailReads];
      const protocol = new EngineLocalProtocol(store, h.source.adapter);
      const response = await protocol.handle(h.d.room, new Request("http://simulation.invalid/activities", { method: "POST",
        headers: { "content-type": "application/json", authorization: h.initial.authorization }, body: JSON.stringify({ intent: p.packet.intent, itemId: "projection-missing" }) }));
      assert.equal(response.status, 200); assert.equal(await response.text(), original.responseJSON);
      assert.deepEqual([h.source.contractReads, h.source.snapshotReads, h.source.detailReads], reads);
      assert.equal(store.project(h.d.room).activityReceipts.size, 2); assert.equal(store.project(h.d.room).toolResults.size, 1);
      assert.equal(store.project(h.d.room).activities.get("background")!.status, "done"); parity(store, h.d.room);
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

async function race(p: Prepared, a: OperationWorkerInput, b: OperationWorkerInput): Promise<WorkerResponse[]> {
  const dir = p.h.d.dir, readyA = join(dir, "race-ready-a"), readyB = join(dir, "race-ready-b"), go = join(dir, "race-go");
  const tasks = [worker({ ...a, ready: readyA, go }), worker({ ...b, ready: readyB, go })];
  await waitForFiles([readyA, readyB]); writeFileSync(go, "go");
  const results = await Promise.all(tasks);
  return results.map((r) => { assert.equal(r.signal, null, r.stderr); return JSON.parse(r.stdout) as WorkerResponse; });
}

test("two SQLite processes with identical raw intent and two exact native aliases return same original receipt, one effect/claim", async () => {
  const h = await operationRoom();
  try {
    const ref = await pwdRef(h), intent = h.intent(h.initial, "concurrent", "finish", { toolRefs: [ref], body: "one result", disposition: { kind: "answer", requestIds: ["A"] } });
    const packet = await operationPacket(h, intent, "alias-a", ["alias-b"]);
    const other = { ...packet, source: packet.aliases![0]!, aliases: [packet.source] }, p: Prepared = { h, action: "operation", packet };
    const path = immutableCopy(h, "concurrent.sqlite");
    const results = await race(p, workerInput(p, path), { action: "operation", packet: other, path, room: h.d.room });
    assert.ok(results.every((r) => r.ok), JSON.stringify(results)); assert.equal(results.filter((r) => r.replayed).length, 1);
    assert.equal(results[0]!.responseJSON, results[1]!.responseJSON); assert.equal(results[0]!.packetDigest, results[1]!.packetDigest);
    const store = new EngineStore(path);
    try { const projection = store.project(h.d.room); assert.equal(projection.operationReceipts.size, 1); assert.equal(projection.operationBindings.size, 2);
      assert.equal(projection.toolResults.size, 1); assert.equal(answered(store.load(h.d.room)), 1);
      assert.equal(projection.requests.get("A")!.state, "answered"); parity(store, h.d.room); }
    finally { store.close(); }
  } finally { h.cleanup(); }
});

test("serialized raw-client conflict loser appends zero additional effects", async () => {
  const p = await prepare("finish"), h = p.h;
  try {
    const path = immutableCopy(h, "raw-conflict.sqlite"), changedIntent = { ...p.packet.intent, nonce: "changed-raw-nonce" };
    const changed = { ...p.packet, intent: changedIntent, intentJSON: canonicalJSON(changedIntent) } as LocalOperationPacket;
    const store = new EngineStore(path);
    try {
      store.commitOperation(h.d.room, p.packet as LocalOperationPacket); const before = store.load(h.d.room);
      const result = await worker({ action: "operation", packet: changed, path, room: h.d.room });
      assert.equal(result.code, 1); assert.match((JSON.parse(result.stdout) as WorkerResponse).error!, /conflicting raw client intent/);
      assert.deepEqual(store.load(h.d.room), before); assert.equal(answered(before), 1); parity(store, h.d.room);
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

test("concurrent lawful source packets reusing one client with changed raw intent have one winner and zero loser effects", async () => {
  const h = await operationRoom();
  try {
    const ref = await pwdRef(h), original = h.intent(h.initial, "conflicted-client", "finish", { toolRefs: [ref], body: "first lawful body", disposition: { kind: "answer", requestIds: ["A"] } });
    const changed = { ...original, nonce: "second-nonce", body: "changed lawful body" } as OperationIntent;
    h.projectOperation(h.initial, original, "conflict-a"); h.projectOperation(h.initial, changed, "conflict-b");
    const a = await h.source.adapter.detail("thread:W", "conflict-a"), b = await h.source.adapter.detail("thread:W", "conflict-b");
    const tool = await h.source.adapter.detail("thread:W", ref.itemId), snapshot = await h.source.adapter.inspect("thread:W");
    assert.equal(h.x.observe(h.d.room, "W", await h.source.adapter.contract(), snapshot), true);
    const packet: LocalOperationPacket = { capabilityId: h.initial.capabilityId, intent: original, intentJSON: canonicalJSON(original), source: a,
      tools: [{ ref, source: tool }], view: [], sequence: snapshot.sequence, sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
    const other: LocalOperationPacket = { ...packet, intent: changed, intentJSON: canonicalJSON(changed), source: b };
    const p: Prepared = { h, action: "operation", packet }, path = immutableCopy(h, "concurrent-conflict.sqlite");
    const results = await race(p, workerInput(p, path), { action: "operation", packet: other, path, room: h.d.room });
    assert.equal(results.filter((r) => r.ok).length, 1); assert.match(results.find((r) => !r.ok)!.error!, /conflicting raw client intent/);
    const store = new EngineStore(path);
    try { const projected = store.project(h.d.room); assert.equal(projected.operationReceipts.size, 1); assert.equal(projected.operationBindings.size, 1);
      assert.equal(projected.toolResults.size, 1); assert.equal(store.load(h.d.room).filter((e) => e.data.kind === "output").length, 1);
      // The other exact originating invocation remains unknown causal work, so neither body may answer early.
      assert.equal(projected.requests.get("A")!.state, "open"); assert.equal(answered(store.load(h.d.room)), 0); parity(store, h.d.room); }
    finally { store.close(); }
  } finally { h.cleanup(); }
});

test("SQLite writer blocked behind a newer checkpoint rejects old packet without receipt/result/binding/claim", async () => {
  const p = await prepare("finish"), h = p.h;
  try {
    const path = immutableCopy(h, "stale-writer.sqlite"), observation = h.d.p.providerObservations.get("W")!;
    const command: Command = { type: "observe_provider", actor: "$system", id: "winning-checkpoint", observation: { ...observation, sequence: observation.sequence + 1 }, pending: observation.pending, settled: [] };
    const readyA = join(h.d.dir, "stale-ready-a"), readyB = join(h.d.dir, "stale-ready-b"), goA = join(h.d.dir, "stale-go-a"), goB = join(h.d.dir, "stale-go-b"),
      holdReady = join(h.d.dir, "writer-lock-held"), holdGo = join(h.d.dir, "writer-release");
    const a = worker({ action: "command", command, path, room: h.d.room, ready: readyA, go: goA, holdReady, holdGo });
    const b = worker({ ...workerInput(p, path), ready: readyB, go: goB });
    await waitForFiles([readyA, readyB]); writeFileSync(goA, "go"); await waitForFiles([holdReady]);
    writeFileSync(goB, "go"); writeFileSync(holdGo, "release");
    const results = await Promise.all([a, b]); assert.equal(results[0]!.code, 0); assert.equal(results[1]!.code, 1);
    assert.match((JSON.parse(results[1]!.stdout) as WorkerResponse).error!, /checkpoint changed/);
    const store = new EngineStore(path);
    try { const projected = store.project(h.d.room); assert.equal(projected.operationReceipts.size, 0); assert.equal(projected.operationBindings.size, 0);
      assert.equal(projected.toolResults.size, 0); assert.equal(answered(store.load(h.d.room)), 0); parity(store, h.d.room); }
    finally { store.close(); }
  } finally { h.cleanup(); }
});

test("two activity-result writers replay one original receipt and record one original-generation result", async () => {
  const p = await prepare("activity-result"), h = p.h;
  try {
    const path = immutableCopy(h, "concurrent-activity.sqlite"), results = await race(p, workerInput(p, path), workerInput(p, path));
    assert.ok(results.every((r) => r.ok)); assert.equal(results.filter((r) => r.replayed).length, 1);
    assert.equal(results[0]!.responseJSON, results[1]!.responseJSON); assert.equal(results[0]!.packetDigest, results[1]!.packetDigest);
    const store = new EngineStore(path);
    try { const projected = store.project(h.d.room); assert.equal(projected.activityReceipts.size, 2); assert.equal(projected.toolResults.size, 1);
      assert.equal(projected.activities.get("background")!.status, "done"); assert.equal(store.load(h.d.room).filter((e) => e.data.kind === "output").length, 1);
      parity(store, h.d.room); }
    finally { store.close(); }
  } finally { h.cleanup(); }
});

test("wrong capability identity cannot enter trusted local effects transaction", async () => {
  const p = await prepare("finish"), h = p.h;
  try {
    const path = immutableCopy(h, "unknown-capability.sqlite"), store = new EngineStore(path), before = store.load(h.d.room);
    try {
      const packet = { ...p.packet, capabilityId: "cap-00000000-0000-0000-0000-000000000000" } as LocalOperationPacket;
      const result = await worker({ action: "operation", packet, path, room: h.d.room });
      assert.equal(result.code, 1); assert.match((JSON.parse(result.stdout) as WorkerResponse).error!, /unknown run capability/);
      assert.deepEqual(store.load(h.d.room), before); assert.equal(store.project(h.d.room).operationReceipts.size, 0); parity(store, h.d.room);
    } finally { store.close(); }
  } finally { h.cleanup(); }
});

test("new local receipts/effects/bindings are reconstructed solely from retained event log after deleting every disposable index", async () => {
  const p = await prepare("finish"), h = p.h;
  try {
    const path = immutableCopy(h, "index-rebuild.sqlite"), store = new EngineStore(path);
    let response: string, log: RoomEvent[];
    try { response = commit(store, h.d.room, p).receipt.responseJSON; log = store.load(h.d.room); }
    finally { store.close(); }
    const raw = new DatabaseSync(path);
    try { raw.exec("DELETE FROM engine_head; DELETE FROM engine_command; DELETE FROM engine_projection; DELETE FROM engine_key;"); }
    finally { raw.close(); }
    const rebuilt = new EngineStore(path);
    try { assert.equal(rebuilt.audit(h.d.room).ok, false); rebuilt.rebuild(h.d.room); parity(rebuilt, h.d.room);
      assert.deepEqual(rebuilt.load(h.d.room), log!); assert.equal(commit(rebuilt, h.d.room, p).receipt.responseJSON, response!);
      assert.equal(rebuilt.project(h.d.room).operationReceipts.size, 1); assert.equal(rebuilt.project(h.d.room).operationBindings.size, 1);
      assert.equal(rebuilt.project(h.d.room).toolResults.size, 1); assert.equal(answered(log!), 1); }
    finally { rebuilt.close(); }
  } finally { h.cleanup(); }
});

test("original-generation activity receipts/results/settlement rebuild solely from the event log", async () => {
  const p = await prepare("activity-result"), h = p.h;
  try {
    const path = immutableCopy(h, "activity-index-rebuild.sqlite"), store = new EngineStore(path);
    let response: string, log: RoomEvent[];
    try { response = commit(store, h.d.room, p).receipt.responseJSON; log = store.load(h.d.room); }
    finally { store.close(); }
    const raw = new DatabaseSync(path);
    try { raw.exec("DELETE FROM engine_head; DELETE FROM engine_command; DELETE FROM engine_projection; DELETE FROM engine_key;"); }
    finally { raw.close(); }
    const rebuilt = new EngineStore(path);
    try { assert.equal(rebuilt.audit(h.d.room).ok, false); rebuilt.rebuild(h.d.room); parity(rebuilt, h.d.room);
      assert.deepEqual(rebuilt.load(h.d.room), log!); assert.equal(commit(rebuilt, h.d.room, p).receipt.responseJSON, response!);
      assert.equal(rebuilt.project(h.d.room).activityReceipts.size, 2); assert.equal(rebuilt.project(h.d.room).toolResults.size, 1);
      assert.equal(rebuilt.project(h.d.room).activities.get("background")!.status, "done"); }
    finally { rebuilt.close(); }
  } finally { h.cleanup(); }
});
