import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { canonicalJSON } from "../../src/engine/result.ts";
import { hash } from "../../src/engine/provider.ts";
import type { ActivityIntent, ActivityPacket, ActivityV2Intent, LocalOperationPacket, OperationIntent } from "../../src/engine/operation-types.ts";
import type { Command } from "../../src/engine/types.ts";
import { operationRoom, SimulatedOperationSource } from "./operation-fixture.ts";
import type { OperationContext, OperationRoom } from "./operation-fixture.ts";
import { worker, waitForFiles } from "./store-fixture.ts";

interface Rig { store: EngineStore; room: string; source: SimulatedOperationSource; context: OperationContext }
let serial = 0;
const initialRig = (v: OperationRoom): Rig => ({ store: v.d.store, room: v.d.room, source: v.source, context: v.initial });
const projection = (r: Rig) => r.store.project(r.room);
const protocol = (r: Rig) => new EngineLocalProtocol(r.store, r.source.adapter);
const tick = (r: Rig) => new EngineReconciler(r.store, r.source.adapter).tick(r.room, "W");
function raw(r: Rig, operation: ActivityV2Intent["operation"], extra: Record<string, unknown>, activityId = "X"): ActivityV2Intent {
  const clientId = `global:${++serial}`;
  return { schema: "backroom.activity.v2", provenance: "member_declared", operation, clientId, nonce: `nonce:${clientId}`,
    originRunId: r.context.run.id, activityId, activityGeneration: 1, ...extra } as ActivityV2Intent;
}
function strictRegistration(r: Rig, nativeId: string | null, activityId = "strict-X"): ActivityIntent {
  const clientId = `strict:${++serial}`;
  return { schema: "backroom.activity.v1", operation: "register_activity", clientId, nonce: `nonce:${clientId}`,
    originRunId: r.context.run.id, activityId, activityGeneration: 1, requestIds: ["A2"], nativeId };
}
async function post(r: Rig, intent: ActivityIntent, capture = false) {
  const item = r.source.addTool(r.context.run, `global-item:${++serial}`, { input: intent, operation: intent.operation });
  let packet: ActivityPacket | undefined;
  const commit = r.store.commitActivity.bind(r.store);
  if (capture) r.store.commitActivity = (_room, value) => { packet = structuredClone(value); throw new Error("capture actual authenticated packet before transaction"); };
  try {
    const response = await protocol(r).handle(r.room, new Request("http://global-simulation.invalid/activities", { method: "POST",
      headers: { authorization: r.context.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent, itemId: item.id }) }));
    const text = await response.text(), body = JSON.parse(text) as { receiptKey?: string; error?: string };
    if (!capture) { r.source.completeTool(item, text); await tick(r); }
    return { status: response.status, text, body, packet };
  } finally { r.store.commitActivity = commit; }
}
async function register(r: Rig, requestId: string, id = "X") {
  const response = await post(r, raw(r, "register_activity", { requestIds: [requestId], nativeId: null }, id));
  assert.equal(response.status, 200, response.text); return response.body.receiptKey!;
}
async function bind(r: Rig, registrationReceiptKey: string, namespace: "task" | "provider_item" | "process", value: string,
  itemId: string | null = null, capture = false) {
  return post(r, raw(r, "bind_activity", { registrationReceiptKey, nativeHandle: { namespace, value },
    originalSourceRef: itemId ? { itemId } : null }), capture);
}
async function secondRig(v: OperationRoom, suffix = "2", config: { providerThreadId?: string; environmentId?: string; sequence?: number } = {}): Promise<Rig> {
  const store = new EngineStore(v.d.path), source = new SimulatedOperationSource(), room = `room${suffix}`;
  source.appRuns = 20 + serial * 10; source.snapshot.snapshotSequence = config.sequence ?? v.source.snapshot.snapshotSequence + 100 + serial;
  if (config.environmentId) source.environmentId = config.environmentId;
  if (config.providerThreadId) source.onSnapshot = () => {
    for (const thread of source.snapshot.projection.providerThreads) thread.id = config.providerThreadId!;
    for (const list of [source.snapshot.projection.nodes, source.snapshot.projection.attempts, source.snapshot.projection.providerTurns,
      source.snapshot.projection.turnItems, [...source.detailItems.values()]])
      for (const row of list) if ("providerThreadId" in row) row.providerThreadId = config.providerThreadId;
    return source.snapshot;
  };
  for (const seatId of ["O", "W"]) store.execute(room, { type: "seat", actor: "$user", id: `seat:${seatId}`, seatId,
    threadId: `thread:${seatId}`, orchestrator: seatId === "O" });
  store.execute(room, { type: "request", actor: "$user", id: "A2", to: "W", body: "Other original room work" });
  store.reserveNative(room, "W", 1_000_000); const run = [...store.project(room).runs.values()][0]!;
  const reconciler = new EngineReconciler(store, source.adapter);
  await reconciler.prepareRun(room, run.id, { instanceId: "codex", model: "simulated-model" });
  const auth = new EngineLocalProtocol(store, source.adapter).authorizeRun(room, run.id, { generation: 1, server: "backroom-board" });
  await reconciler.tick(room, "W"); await reconciler.tick(room, "W");
  assert.notEqual(store.project(room).runs.get(run.id)!.providerRunId, v.d.p.runs.get(v.initial.run.id)!.providerRunId);
  return { store, room, source, context: { run, ...auth } };
}
const close = (r: Rig | undefined) => { if (r) { r.source.close(); r.store.close(); } };
async function finish(r: Rig) {
  const clientId = `finish:${++serial}`, intent: OperationIntent = { schema: "backroom.operation.v1", operation: "finish", clientId,
    nonce: clientId, originRunId: r.context.run.id, body: "Explicit original final", disposition: { kind: "answer", requestIds: ["A2"] }, toolRefs: [] };
  const item = r.source.addTool(r.context.run, clientId, { input: intent, operation: "finish" });
  const response = await protocol(r).handle(r.room, new Request("http://global-simulation.invalid/operations", { method: "POST",
    headers: { authorization: r.context.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent, itemId: item.id }) }));
  assert.equal(response.status, 200); const body = await response.json() as { result: { claims: { outcome: string }[] } };
  return body.result.claims[0]!.outcome;
}
async function knownTask(v: OperationRoom) {
  const thread = v.source.snapshot.projection.providerThreads[0]!;
  thread.pendingBackgroundTasks = [{ taskId: "known-prior-task", kind: "command" }]; v.source.snapshot.snapshotSequence++;
  await v.x.tick(v.d.room, "W");
  thread.pendingBackgroundTasks = []; v.source.snapshot.snapshotSequence++; await v.x.tick(v.d.room, "W");
  assert.ok(v.d.p.providerObservations.get("W")!.pending.includes("background:provider-thread:known-prior-task"));
}

for (const restored of [false, true]) test(`R1 exact cross-room known task survives roster disappearance${restored ? ", restart and rebuild" : ""}; no bind/result/answer`, async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    await knownTask(v);
    if (restored) { v.d.reopen(); v.d.store.rebuild(v.d.room); }
    other = await secondRig(v); const registration = await register(other, "A2");
    assert.equal(projection(other).activities.get("X")!.declaration!.registration.sourceHistoryHeads![v.d.room], v.d.store.load(v.d.room).length);
    assert.equal((await bind(other, registration, "task", "known-prior-task")).status, 409);
    const before = projection(other); assert.equal(before.activities.get("X")!.declaration!.binding, undefined);
    assert.equal(before.activityReceipts.size, 1);
    assert.equal((await post(other, raw(other, "record_activity_result", { bindingReceiptKey: "invented-bind", completion: "done", body: "Stale work called done",
      resultRef: null, unavailableReason: "No current native source" }))).status, 409);
    assert.equal(await finish(other), "pending_activity"); assert.equal(projection(other).requests.get("A2")!.state, "open");
    assert.equal(projection(other).activities.get("X")!.status, "pending"); assert.equal(other.store.audit(other.room).ok, true); v.d.parity();
  } finally { close(other); v.cleanup(); }
});

test("R1 foreign history floors are store-collected and cannot be supplied by a member registration", async () => {
  const v = await operationRoom(), r = initialRig(v);
  try {
    const intent = raw(r, "register_activity", { requestIds: ["A"], nativeId: null, sourceHistoryHeads: { room: 0 }, trusted: true });
    assert.equal((await post(r, intent)).status, 409);
    assert.equal(projection(r).activities.has("X"), false); assert.equal(projection(r).activityReceipts.size, 0); v.d.parity();
  } finally { v.cleanup(); }
});

for (const scope of ["provider-thread", "environment"] as const) test(`R1 genuinely different ${scope} is a distinct known-history scope`, async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    await knownTask(v); other = await secondRig(v, "positive", scope === "provider-thread"
      ? { providerThreadId: "genuinely-other-provider-thread" } : { environmentId: "genuinely-other-environment" });
    const registration = await register(other, "A2"), bound = await bind(other, registration, "task", "known-prior-task");
    assert.equal(bound.status, 200, bound.text); const binding = projection(other).activities.get("X")!.declaration!.binding!;
    assert.equal(binding.correlation, "unverified"); assert.equal(binding.availability, "reference_unavailable");
    assert.equal(binding.provenance, "member_declared"); assert.equal(other.store.audit(other.room).ok, true); v.d.parity();
  } finally { close(other); v.cleanup(); }
});

test("R1 frozen foreign known prefix remains negative even when a different room supplies an earlier native clock", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    v.source.snapshot.snapshotSequence += 1000; await knownTask(v);
    other = await secondRig(v, "lower-clock", { sequence: 1 }); const registration = await register(other, "A2");
    const reg = projection(other).activities.get("X")!.declaration!.registration;
    assert.ok(reg.sourceSequenceFloor < v.d.p.providerObservations.get("W")!.sequence);
    assert.ok(reg.sourceHistoryHeads![v.d.room]! > 0);
    assert.equal((await bind(other, registration, "task", "known-prior-task")).status, 409);
    assert.equal(projection(other).activities.get("X")!.declaration!.binding, undefined);
  } finally { close(other); v.cleanup(); }
});

test("R1 a genuinely later foreign task observation supplies no binding; explicit member declaration stays unverified", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    other = await secondRig(v); const registration = await register(other, "A2");
    const reg = projection(other).activities.get("X")!.declaration!.registration;
    v.source.snapshot.snapshotSequence = other.source.snapshot.snapshotSequence + 100;
    v.source.snapshot.projection.providerThreads[0]!.pendingBackgroundTasks = [{ taskId: "post-registration-task", kind: "command" }];
    await v.x.tick(v.d.room, "W");
    assert.equal(projection(other).activities.get("X")!.declaration!.binding, undefined);
    assert.ok(v.d.store.load(v.d.room).length > reg.sourceHistoryHeads![v.d.room]!);
    const response = await bind(other, registration, "task", "post-registration-task"); assert.equal(response.status, 200, response.text);
    assert.equal(projection(other).activities.get("X")!.declaration!.binding!.correlation, "unverified");
    assert.ok(v.d.p.providerObservations.get("W")!.pending.includes("background:provider-thread:post-registration-task"));
  } finally { close(other); v.cleanup(); }
});

for (const settled of [false, true]) test(`R1/D6 later foreign contradiction blocks a new ${settled ? "finish" : "result"} without erasing the original opaque declaration`, async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    other = await secondRig(v); const registration = await register(other, "A2");
    const bound = await bind(other, registration, "process", "native-item:late-foreign-native"); assert.equal(bound.status, 200);
    const resultIntent = raw(other, "record_activity_result", { bindingReceiptKey: bound.body.receiptKey, completion: "done", body: "Original declared result",
      resultRef: null, unavailableReason: "No native result reference was observed" });
    if (settled) assert.equal((await post(other, resultIntent)).status, 200);
    const original = canonicalJSON(projection(other).activities.get("X")!.declaration);
    v.source.snapshot.snapshotSequence = other.source.snapshot.snapshotSequence + 100;
    const native = v.source.addTool(v.initial.run, "late-foreign-native", { type: "command_execution", input: "Actual conflicting original native command", status: "running", exitCode: 0 });
    await v.x.tick(v.d.room, "W");
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.observed" && e.data.observation.sources?.some((s) => s.itemId === native.id)));
    if (!settled) assert.equal((await post(other, resultIntent)).status, 409);
    else {
      const clientId = `late-finish:${++serial}`, intent: OperationIntent = { schema: "backroom.operation.v1", operation: "finish", clientId,
        nonce: clientId, originRunId: other.context.run.id, body: "New affected claim", disposition: { kind: "answer", requestIds: ["A2"] }, toolRefs: [] };
      const item = other.source.addTool(other.context.run, clientId, { input: intent, operation: "finish" });
      const response = await protocol(other).handle(other.room, new Request("http://global-simulation.invalid/operations", { method: "POST",
        headers: { authorization: other.context.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent, itemId: item.id }) }));
      assert.equal(response.status, 409);
    }
    assert.equal(canonicalJSON(projection(other).activities.get("X")!.declaration), original);
    assert.equal(projection(other).requests.get("A2")!.state, "open"); assert.equal(other.store.audit(other.room).ok, true);
  } finally { close(other); v.cleanup(); }
});

test("R1 source known in another room without registered owner cannot be reused as an original provider_item", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    v.source.addTool(v.initial.run, "known-original", { type: "command_execution", input: "actual old command", status: "running", exitCode: 0 });
    await v.x.tick(v.d.room, "W"); other = await secondRig(v); const registration = await register(other, "A2");
    const native = other.source.addTool(other.context.run, "known-original", { type: "command_execution", input: "new command", status: "running", exitCode: 0 });
    assert.equal((await bind(other, registration, "provider_item", "native-item:known-original", native.id)).status, 409);
    assert.equal(projection(other).activities.get("X")!.declaration!.binding, undefined); assert.equal(other.store.audit(other.room).ok, true);
  } finally { close(other); v.cleanup(); }
});

async function ownedV2(v: OperationRoom, state: "pending" | "settled" | "cancelled") {
  const r = initialRig(v), registration = await register(r, "A");
  const native = v.source.addTool(v.initial.run, "owned-original", { type: "command_execution", input: "actual original command", status: "running", exitCode: 0 });
  const bound = await bind(r, registration, "provider_item", "native-item:owned-original", native.id); assert.equal(bound.status, 200, bound.text);
  if (state === "settled") {
    v.source.completeTool(native, JSON.stringify("Original retained native result")); await tick(r);
    const result = await post(r, raw(r, "record_activity_result", { bindingReceiptKey: bound.body.receiptKey, completion: "done", body: "Original result",
      resultRef: { itemId: native.id }, unavailableReason: null })); assert.equal(result.status, 200, result.text);
  } else if (state === "cancelled") v.d.store.execute(v.d.room, { type: "cancel", actor: "$user", id: `cancel:${++serial}`, requestId: "A" });
  const original = canonicalJSON(v.d.p.activities.get("X")!.declaration!.binding);
  v.d.reopen(); v.d.store.rebuild(v.d.room); assert.equal(canonicalJSON(v.d.p.activities.get("X")!.declaration!.binding), original);
}
for (const state of ["pending", "settled", "cancelled"] as const) test(`R2 ${state} v2 ownership tombstone rejects strict v1 registration AND host binding after restart`, async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    await ownedV2(v, state); other = await secondRig(v);
    assert.equal((await post(other, strictRegistration(other, "native-item:owned-original"))).status, 409);
    assert.equal(projection(other).activities.has("strict-X"), false);
    const registered = await post(other, strictRegistration(other, null)); assert.equal(registered.status, 200, registered.text);
    await assert.rejects(protocol(other).bindActivity(other.room, "strict-X", { nativeId: "native-item:owned-original", generation: 1 }), /already owned/);
    assert.equal(projection(other).activities.get("strict-X")!.nativeSource!.nativeId, null);
    assert.equal(projection(other).activityReceipts.size, 1); assert.equal(other.store.audit(other.room).ok, true); v.d.parity();
  } finally { close(other); v.cleanup(); }
});

test("R2 strict v1 original owner also rejects new v2 ownership across rooms after settlement/restart", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    const r = initialRig(v), strict = { ...strictRegistration(r, "native-item:owned-strict"), requestIds: ["A"] } as ActivityIntent;
    assert.equal((await post(r, strict)).status, 200);
    v.d.store.execute(v.d.room, { type: "activity_status", actor: "$system", id: "strict-original-settled", activityId: "strict-X", status: "done", evidence: "Explicit original result proof fixture" });
    v.d.reopen(); v.d.store.rebuild(v.d.room); other = await secondRig(v);
    const registration = await register(other, "A2"), native = other.source.addTool(other.context.run, "owned-strict", { type: "command_execution", input: "new actual command", status: "running", exitCode: 0 });
    assert.equal((await bind(other, registration, "provider_item", "native-item:owned-strict", native.id)).status, 409);
    assert.equal(projection(other).activities.get("X")!.declaration!.binding, undefined); assert.equal(other.store.audit(other.room).ok, true);
  } finally { close(other); v.cleanup(); }
});

function packetCommand(packet: ActivityPacket): Command {
  const key = canonicalJSON([packet.capabilityId, packet.intent.clientId]);
  return { type: "activity_operation", actor: "$system", id: `activity-operation:${hash(canonicalJSON(key))}`, packet };
}
test("R3 public execute exact v2 bind recovers original receipt/batch/current head warm,cold,rebuild; changed digest still rejects", async () => {
  const v = await operationRoom(), r = initialRig(v);
  try {
    const registration = await register(r, "A"), bound = await bind(r, registration, "process", "public-execute-original"); assert.equal(bound.status, 200);
    const receipt = projection(r).activityReceipts.get(bound.body.receiptKey!)!, command = packetCommand(receipt.packet);
    const events = v.d.store.load(v.d.room).filter((event) => event.commandKey === JSON.stringify([command.actor, command.id])); assert.ok(events.length);
    v.d.store.execute(v.d.room, { type: "post", actor: "O", id: "later-head", intent: "note", body: "Later unrelated journal head" });
    const head = v.d.store.load(v.d.room).length;
    for (const mode of ["warm", "cold", "rebuilt"] as const) {
      if (mode !== "warm") { v.d.reopen(); r.store = v.d.store; }
      if (mode === "rebuilt") r.store.rebuild(r.room);
      const recovered = r.store.execute(r.room, command); assert.equal(recovered.replayed, true);
      assert.equal(recovered.expectedSeq, events[0]!.seq - 1); assert.deepEqual(recovered.events, events); assert.equal(recovered.head, head);
      const altered = structuredClone(command) as Extract<Command, { type: "activity_operation" }>;
      assert.equal(altered.packet.intent.operation, "bind_activity");
      if (altered.packet.intent.operation === "bind_activity") altered.packet.intent.nativeHandle.value = "changed-authoritative-handle";
      assert.throws(() => r.store.execute(r.room, altered), /conflicting command identity reuse/);
      assert.equal(r.store.load(r.room).length, head); assert.equal(r.store.commitActivity(r.room, receipt.packet).receipt.responseJSON, bound.text);
    }
    v.d.parity();
  } finally { v.cleanup(); }
});

test("R2 cross-schema concurrent SQLite ownership writers choose one owner and preserve the loser pending", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    const r = initialRig(v), registration = await register(r, "A");
    const native = v.source.addTool(v.initial.run, "racing-owner", { type: "command_execution", input: "actual native command", status: "running", exitCode: 0 });
    const first = await bind(r, registration, "provider_item", "native-item:racing-owner", native.id, true); assert.ok(first.packet);
    other = await secondRig(v); const second = await post(other, strictRegistration(other, "native-item:racing-owner"), true); assert.ok(second.packet);
    const ready = [join(v.d.dir, "owner-ready-1"), join(v.d.dir, "owner-ready-2")], go = join(v.d.dir, "owner-go");
    const jobs = [worker({ path: v.d.path, room: r.room, command: packetCommand(first.packet), ready: ready[0]!, go }),
      worker({ path: v.d.path, room: other.room, command: packetCommand(second.packet), ready: ready[1]!, go })];
    await waitForFiles(ready); writeFileSync(go, "go"); const results = (await Promise.all(jobs)).map((value) => JSON.parse(value.stdout) as { ok: boolean; error?: string });
    assert.equal(results.filter((value) => value.ok).length, 1, JSON.stringify(results));
    assert.match(results.find((value) => !value.ok)!.error!, /already owned|strict v1 activity tombstone/);
    assert.equal(Number(!!projection(r).activities.get("X")!.declaration!.binding) + Number(projection(other).activities.has("strict-X")), 1);
    assert.equal(projection(r).requests.get("A")!.state, "open"); assert.equal(projection(other).requests.get("A2")!.state, "open");
    assert.equal(v.d.store.audit(v.d.room).ok, true); assert.equal(other.store.audit(other.room).ok, true);
  } finally { close(other); v.cleanup(); }
});

test("R1 a waiting bind writer rereads foreign known history after the observation writer commits", async () => {
  const v = await operationRoom(); let other: Rig | undefined;
  try {
    const old = initialRig(v), observation = v.d.p.providerObservations.get("W")!;
    other = await secondRig(v); const registration = await register(other, "A2"), captured = await bind(other, registration, "task", "concurrent-known-task", null, true);
    assert.ok(captured.packet);
    const command: Command = { type: "observe_provider", actor: "$system", id: "foreign-original-known-task",
      observation: { ...observation, sequence: observation.sequence + 1 }, pending: ["background:provider-thread:concurrent-known-task"], settled: [] };
    const held = join(v.d.dir, "history-lock-held"), release = join(v.d.dir, "history-release"), waiterReady = join(v.d.dir, "bind-waiter-ready"), waiterGo = join(v.d.dir, "bind-waiter-go");
    // Open the waiting connection before holding the first writer's lock.
    const waiter = worker({ path: v.d.path, room: other.room, command: packetCommand(captured.packet), ready: waiterReady, go: waiterGo });
    await waitForFiles([waiterReady]);
    const writer = worker({ path: v.d.path, room: old.room, command, holdReady: held, holdGo: release });
    await waitForFiles([held]); writeFileSync(waiterGo, "go"); writeFileSync(release, "commit original known history");
    const [first, second] = await Promise.all([writer, waiter]); assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(second.code, 1); assert.match(second.stdout, /task already known/);
    assert.equal(projection(other).activities.get("X")!.declaration!.binding, undefined);
    assert.equal(projection(other).activityReceipts.size, 1); assert.equal(other.store.audit(other.room).ok, true); v.d.parity();
  } finally { close(other); v.cleanup(); }
});


// S1 exercises retained foreign revisions through actual adapter/HTTP/store paths.
async function originalBinding(v: OperationRoom, running = false) {
  const r = initialRig(v), registration = await register(r, "A");
  const native = v.source.addTool(v.initial.run, "s1-original", { type: "command_execution", input: "original test command",
    status: running ? "running" : "completed", exitCode: 0, ...(running ? {} : { output: "Original success" }) });
  await tick(r);
  const bound = await bind(r, registration, "provider_item", "native-item:s1-original", native.id);
  assert.equal(bound.status, 200, bound.text);
  const result = () => raw(r, "record_activity_result", { bindingReceiptKey: bound.body.receiptKey, completion: "done",
    body: "Original success declared", resultRef: { itemId: native.id }, unavailableReason: null });
  return { r, native, result };
}
async function foreignHistory(v: OperationRoom, scope?: "provider-thread" | "environment") {
  const source = new SimulatedOperationSource(), room = `s1-foreign:${++serial}`;
  v.d.store.execute(room, { type: "seat", actor: "$user", id: "foreign-seat", seatId: "W", threadId: "thread:W", orchestrator: true });
  Object.assign(source.snapshot, structuredClone(v.source.snapshot));
  for (const [id, item] of v.source.detailItems) source.detailItems.set(id, structuredClone(item));
  source.snapshot.snapshotSequence = v.source.snapshot.snapshotSequence + 100;
  if (scope === "environment") source.environmentId = "different-actual-environment";
  if (scope === "provider-thread") {
    for (const thread of source.snapshot.projection.providerThreads) thread.id = "different-actual-provider-thread";
    for (const rows of [source.snapshot.projection.nodes, source.snapshot.projection.attempts, source.snapshot.projection.providerTurns,
      source.snapshot.projection.turnItems, [...source.detailItems.values()]]) for (const row of rows)
        if ("providerThreadId" in row) row.providerThreadId = "different-actual-provider-thread";
  }
  const observe = async () => {
    const x = new EngineReconciler(v.d.store, source.adapter);
    assert.equal(x.observe(room, "W", await source.adapter.contract(), await source.adapter.inspect("thread:W")), true);
  };
  const inputs = (id: string) => v.d.store.load(room).flatMap((e) => e.data.kind === "provider.observed"
    ? e.data.observation.sources ?? [] : []).filter((s) => s.itemId === id).map((s) => s.input);
  return { source, room, observe, inputs };
}
function originalFinish(r: Rig): OperationIntent {
  const clientId = `s1-finish:${++serial}`;
  return { schema: "backroom.operation.v1", operation: "finish", clientId, nonce: clientId, originRunId: r.context.run.id,
    body: "Explicit original final", disposition: { kind: "answer", requestIds: ["A"] }, toolRefs: [] };
}
async function finishResponse(r: Rig, capture = false) {
  const intent = originalFinish(r), item = r.source.addTool(r.context.run, intent.clientId, { input: intent, operation: "finish" });
  let packet: LocalOperationPacket | undefined;
  const commit = r.store.commitOperation.bind(r.store);
  if (capture) r.store.commitOperation = (_room, value) => { packet = structuredClone(value); throw new Error("capture actual authenticated finish before commit"); };
  try {
    const response = await protocol(r).handle(r.room, new Request("http://s1-simulation.invalid/operations", { method: "POST",
      headers: { authorization: r.context.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent, itemId: item.id }) }));
    const text = await response.text(); return { status: response.status, text, body: JSON.parse(text), packet };
  } finally { r.store.commitOperation = commit; }
}
for (const restart of [false, true]) for (const settled of [false, true])
  test(`S1 foreign complete input changed then restored blocks fresh ${settled ? "finish" : "result and finish"}${restart ? " after reopen/rebuild" : ""}`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v), intent = result();
      const saved = settled ? await post(r, intent) : null; if (saved) assert.equal(saved.status, 200, saved.text);
      const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignHistory(v); await f.observe();
      const changed = f.source.detailItems.get(native.id)!;
      changed.input = "CHANGED COMPLETE ORIGINAL COMMAND"; f.source.project(changed); await f.observe();
      changed.input = "original test command"; f.source.project(changed); await f.observe();
      assert.deepEqual(f.inputs(native.id), ["original test command", "CHANGED COMPLETE ORIGINAL COMMAND", "original test command"]);
      if (restart) { v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); r.store.rebuild(f.room); }
      v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
      if (!settled) assert.equal((await post(r, intent)).status, 409);
      assert.equal((await finishResponse(r)).status, 409);
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      assert.equal(projection(r).activities.get("X")!.status, settled ? "done" : "pending");
      assert.equal(projection(r).requests.get("A")!.state, "open");
      assert.equal(projection(r).activityReceipts.size, settled ? 3 : 2);
      if (saved) {
        const receipt = projection(r).activityReceipts.get(saved.body.receiptKey!)!;
        const reads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads]; v.source.disabled = true;
        const replay = await protocol(r).handle(r.room, new Request("http://s1-simulation.invalid/activities", { method: "POST",
          headers: { authorization: r.context.authorization, "content-type": "application/json" },
          body: JSON.stringify({ intent, itemId: receipt.packet.source.itemId }) }));
        assert.equal(replay.status, 200); assert.equal(await replay.text(), saved.text);
        assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], reads);
        assert.equal(r.store.execute(r.room, packetCommand(receipt.packet)).replayed, true);
      }
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const kind of ["unchanged", "node-first", "partial-first", "running-to-ended"] as const)
  test(`S1 foreign ${kind} history preserves genuine original-source result/finish`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v, kind === "running-to-ended");
      f = await foreignHistory(v); const item = f.source.detailItems.get(native.id)!;
      if (kind === "node-first") f.source.snapshot.projection.turnItems = f.source.snapshot.projection.turnItems.filter((s) => s.id !== native.id);
      if (kind === "partial-first") { delete item.input; f.source.project(item); }
      await f.observe();
      item.input = "original test command";
      if (kind === "running-to-ended") {
        f.source.completeTool(item, JSON.stringify("Original success")); v.source.completeTool(native, JSON.stringify("Original success"));
      } else f.source.project(item);
      await f.observe(); f.source.project(item); await f.observe();
      v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
      const recorded = await post(r, result()); assert.equal(recorded.status, 200, recorded.text);
      const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
      assert.equal(finished.body.result.claims[0].outcome, "answered");
      assert.equal(projection(r).activities.get("X")!.status, "done"); assert.equal(projection(r).requests.get("A")!.state, "answered");
      const retained = projection(r).activities.get("X")!.declaration!.result!.originalSource!;
      assert.equal(retained.input, "original test command"); assert.equal(retained.output, "Original success");
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const scope of ["environment", "provider-thread"] as const)
  test(`S1 genuine different ${scope} may reuse handle/item names without contaminating the original prefix`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v); f = await foreignHistory(v, scope);
      const item = f.source.detailItems.get(native.id)!; item.input = "Actual different-scope command"; f.source.project(item); await f.observe();
      v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
      const recorded = await post(r, result()); assert.equal(recorded.status, 200, recorded.text);
      const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
      assert.equal(finished.body.result.claims[0].outcome, "answered");
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

test("S1 retained foreign changed-FIRST-complete evidence cannot authenticate the immutable binding", async () => {
  const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
  try {
    const { r, native, result } = await originalBinding(v); f = await foreignHistory(v);
    const item = f.source.detailItems.get(native.id)!; item.input = "WRONG FIRST COMPLETE"; f.source.project(item); await f.observe();
    item.input = "original test command"; f.source.project(item); await f.observe();
    v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
    assert.equal((await post(r, result())).status, 409); assert.equal((await finishResponse(r)).status, 409);
    assert.equal(projection(r).activities.get("X")!.status, "pending"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
  } finally { f?.source.close(); v.cleanup(); }
});

test("S1 changed native-ref alias then restored cannot escape retained foreign item/node identity", async () => {
  const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
  try {
    const { r, native, result } = await originalBinding(v); f = await foreignHistory(v); await f.observe();
    const item = f.source.detailItems.get(native.id)!;
    item.nativeItemRef = { driver: "codex", strength: "strong", nativeId: "different-native-reference" }; f.source.project(item); await f.observe();
    item.nativeItemRef = { driver: "codex", strength: "strong", nativeId: "native-item:s1-original" }; f.source.project(item); await f.observe();
    v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
    assert.equal((await post(r, result())).status, 409); assert.equal((await finishResponse(r)).status, 409);
    assert.equal(projection(r).activities.get("X")!.status, "pending"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
  } finally { f?.source.close(); v.cleanup(); }
});

test("S1 retained foreign detail-only conflict remains a fence despite unchanged restored observation", async () => {
  const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
  try {
    const { r, native, result } = await originalBinding(v); f = await foreignHistory(v); await f.observe();
    const item = f.source.detailItems.get(native.id)!; item.input = "CHANGED DETAIL ONLY";
    const changed = await f.source.adapter.detail!("thread:W", native.id);
    assert.equal(changed.input, "CHANGED DETAIL ONLY"); assert.deepEqual(f.inputs(native.id), ["original test command"]);
    // The foreign host retains actual native detail in its diagnostic run; it does
    // not bind/adopt the original logical activity or certify a physical launch.
    r.store.execute(f.room, { type: "request", actor: "$user", id: "foreign-diagnostic-request", to: "W", body: "Retain original native source diagnostic" });
    r.store.reserveNative(f.room, "W", 1_000_000); const diagnostic = [...r.store.project(f.room).runs.values()][0]!;
    r.store.execute(f.room, { type: "source_conflict", actor: "$system", id: "foreign-detail-conflict", seatId: "W",
      runId: diagnostic.id, source: changed, code: "native_source_conflict:s1-original" });
    item.input = "original test command"; f.source.project(item); await f.observe();
    v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
    assert.equal((await post(r, result())).status, 409); assert.equal((await finishResponse(r)).status, 409);
    assert.ok(r.store.load(f.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.input === "CHANGED DETAIL ONLY"));
    assert.deepEqual(f.inputs(native.id), ["original test command", "original test command"]);
    assert.equal(projection(r).activities.get("X")!.status, "pending"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
  } finally { f?.source.close(); v.cleanup(); }
});

for (const action of ["result", "finish"] as const)
  test(`S1 serialized ${action} commit rejects foreign changed-restored history learned after actual packet capture`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v);
      if (action === "finish") assert.equal((await post(r, result())).status, 200);
      const captured = action === "result" ? await post(r, result(), true) : await finishResponse(r, true);
      assert.equal(captured.status, 409); assert.ok(captured.packet);
      const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignHistory(v); await f.observe(); const changed = f.source.detailItems.get(native.id)!;
      changed.input = "CHANGED AFTER PACKET CAPTURE"; f.source.project(changed); await f.observe();
      changed.input = "original test command"; f.source.project(changed); await f.observe();
      const head = r.store.load(r.room).length;
      assert.throws(() => action === "result" ? r.store.commitActivity(r.room, captured.packet as ActivityPacket)
        : r.store.commitOperation(r.room, captured.packet as LocalOperationPacket), /first authoritative origin|retained native source/);
      assert.equal(r.store.load(r.room).length, head); assert.equal(projection(r).requests.get("A")!.state, "open");
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const action of ["result", "finish"] as const)
  test(`S1 waiting ${action} writer checks foreign complete-input revision after the observation writer commits`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v);
      if (action === "finish") assert.equal((await post(r, result())).status, 200);
      const captured = action === "result" ? await post(r, result(), true) : await finishResponse(r, true);
      assert.ok(captured.packet); const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignHistory(v); await f.observe(); const item = f.source.detailItems.get(native.id)!;
      item.input = "CHANGED BY OBSERVATION WRITER"; f.source.project(item);
      const snapshot = await f.source.adapter.inspect("thread:W"), prior = r.store.project(f.room).providerObservations.get("W")!;
      assert.ok(snapshot.toolSources?.some((s) => s.itemId === native.id && s.input === "CHANGED BY OBSERVATION WRITER"));
      const observation: Command = { type: "observe_provider", actor: "$system", id: "serialized-foreign-native-input",
        observation: { ...prior, sequence: snapshot.sequence, activities: snapshot.activities, sources: snapshot.toolSources ?? [] },
        pending: snapshot.pending, settled: snapshot.settled ?? [] };
      const packet = captured.packet, key = canonicalJSON([packet.capabilityId, packet.intent.clientId]);
      const command: Command = action === "result" ? packetCommand(packet as ActivityPacket)
        : { type: "local_operation", actor: "$system", id: `operation:${hash(canonicalJSON(key))}`, packet: packet as LocalOperationPacket };
      const held = join(v.d.dir, "s1-history-held"), release = join(v.d.dir, "s1-history-release"), ready = join(v.d.dir, "s1-waiter-ready"), go = join(v.d.dir, "s1-waiter-go");
      const waiter = worker({ path: v.d.path, room: r.room, command, ready, go }); await waitForFiles([ready]);
      const writer = worker({ path: v.d.path, room: f.room, command: observation, holdReady: held, holdGo: release });
      await waitForFiles([held]); writeFileSync(go, "go"); writeFileSync(release, "commit retained revision");
      const [first, second] = await Promise.all([writer, waiter]); assert.equal(first.code, 0, first.stdout + first.stderr);
      assert.equal(second.code, 1, second.stdout + second.stderr); assert.match(second.stdout, /first authoritative origin/);
      item.input = "original test command"; f.source.project(item); await f.observe();
      assert.deepEqual(f.inputs(native.id), ["original test command", "CHANGED BY OBSERVATION WRITER", "original test command"]);
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      assert.equal(projection(r).requests.get("A")!.state, "open"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

// #443: a retained foreign terminal outcome of the bound original is evidence too.
// A later restoration or an earlier settlement cannot erase it from new claims.
type Outcome = { status: string; exitCode: number; output: string };
const success: Outcome = { status: "completed", exitCode: 0, output: "Original success" };
const failure: Outcome = { status: "failed", exitCode: 1, output: "Actual native failure" };
function setOutcome(source: SimulatedOperationSource, id: string, outcome: Outcome) {
  const item = source.detailItems.get(id)!, node = source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!;
  Object.assign(item, { ...outcome, completedAt: "2026-10-07T04:00:00.000Z" }); node.status = outcome.status; source.project(item);
}
const outcomes = (r: Rig, room: string, id: string) => r.store.load(room).flatMap((e) => e.data.kind === "provider.observed"
  ? e.data.observation.sources ?? [] : []).filter((s) => s.itemId === id).map((s) => `${s.status}:${s.exitCode}`);
async function foreignFailure(v: OperationRoom, id: string, history: "restored" | "failed-first") {
  const f = await foreignHistory(v);
  if (history === "failed-first") { setOutcome(f.source, id, failure); await f.observe(); }
  else { await f.observe(); setOutcome(f.source, id, failure); await f.observe(); setOutcome(f.source, id, success); await f.observe(); }
  v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
  return f;
}

for (const restart of [false, true]) for (const settled of [false, true])
  test(`S1 retained foreign failure of the bound original, then restored, blocks fresh ${settled ? "finish after the earlier result" : "result and finish"}${restart ? " after reopen/rebuild" : ""}`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v), intent = result();
      const saved = settled ? await post(r, intent) : null; if (saved) assert.equal(saved.status, 200, saved.text);
      const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignFailure(v, native.id, "restored");
      assert.deepEqual(outcomes(r, f.room, native.id), ["completed:0", "failed:1", "completed:0"]);
      if (restart) { v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); r.store.rebuild(f.room); }
      if (!settled) assert.equal((await post(r, intent)).status, 409);
      const finished = await finishResponse(r); assert.equal(finished.status, 409, finished.text);
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      assert.equal(projection(r).activities.get("X")!.status, settled ? "done" : "pending");
      assert.equal(projection(r).requests.get("A")!.state, "open");
      assert.equal(projection(r).activityReceipts.size, settled ? 3 : 2);
      if (saved) {
        const receipt = projection(r).activityReceipts.get(saved.body.receiptKey!)!;
        const reads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads]; v.source.disabled = true;
        const replay = await protocol(r).handle(r.room, new Request("http://s1-simulation.invalid/activities", { method: "POST",
          headers: { authorization: r.context.authorization, "content-type": "application/json" },
          body: JSON.stringify({ intent, itemId: receipt.packet.source.itemId }) }));
        assert.equal(replay.status, 200); assert.equal(await replay.text(), saved.text);
        assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], reads);
        assert.equal(r.store.execute(r.room, packetCommand(receipt.packet)).replayed, true);
      }
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const settled of [false, true])
  test(`S1 foreign room that first observes the bound original as failed blocks fresh ${settled ? "finish after the earlier result" : "result and finish"}`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v), intent = result();
      if (settled) assert.equal((await post(r, intent)).status, 200);
      f = await foreignFailure(v, native.id, "failed-first"); assert.deepEqual(outcomes(r, f.room, native.id), ["failed:1"]);
      if (!settled) assert.equal((await post(r, intent)).status, 409);
      assert.equal((await finishResponse(r)).status, 409);
      assert.equal(projection(r).activities.get("X")!.status, settled ? "done" : "pending");
      assert.equal(projection(r).requests.get("A")!.state, "open"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

test("S1 foreign failure blocks an unreferenced success claim while the original room still sees the native running", async () => {
  const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
  try {
    const { r, native } = await originalBinding(v, true), binding = projection(r).activities.get("X")!.declaration!.binding!;
    f = await foreignFailure(v, native.id, "failed-first");
    const claim = (completion: "done" | "failed") => raw(r, "record_activity_result", { bindingReceiptKey: binding.bindingReceiptKey, completion,
      body: `Declared ${completion} without a native result`, resultRef: null, unavailableReason: "The original room has not observed the native result" });
    assert.equal((await post(r, claim("done"))).status, 409); assert.equal(projection(r).activities.get("X")!.status, "pending");
    const failed = await post(r, claim("failed")); assert.equal(failed.status, 200, failed.text);
    assert.equal(projection(r).activities.get("X")!.declaration!.result!.completion, "failed");
    v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
  } finally { f?.source.close(); v.cleanup(); }
});

for (const action of ["result", "finish"] as const)
  test(`S1 ${action} packet captured before the foreign failure does not commit after that failure is journaled`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v);
      if (action === "finish") assert.equal((await post(r, result())).status, 200);
      const captured = action === "result" ? await post(r, result(), true) : await finishResponse(r, true);
      assert.equal(captured.status, 409); assert.ok(captured.packet);
      const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignFailure(v, native.id, "restored"); const head = r.store.load(r.room).length;
      assert.throws(() => action === "result" ? r.store.commitActivity(r.room, captured.packet as ActivityPacket)
        : r.store.commitOperation(r.room, captured.packet as LocalOperationPacket), /native invocation outcome|retained native outcome/);
      assert.equal(r.store.load(r.room).length, head); assert.equal(projection(r).requests.get("A")!.state, "open");
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const action of ["result", "finish"] as const)
  test(`S1 waiting ${action} writer checks the foreign failure after the observation writer commits`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v);
      if (action === "finish") assert.equal((await post(r, result())).status, 200);
      const captured = action === "result" ? await post(r, result(), true) : await finishResponse(r, true);
      assert.ok(captured.packet); const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      f = await foreignHistory(v); await f.observe(); setOutcome(f.source, native.id, failure);
      const snapshot = await f.source.adapter.inspect("thread:W"), prior = r.store.project(f.room).providerObservations.get("W")!;
      assert.ok(snapshot.toolSources?.some((s) => s.itemId === native.id && s.status === "failed" && s.exitCode === 1));
      const observation: Command = { type: "observe_provider", actor: "$system", id: "serialized-foreign-native-failure",
        observation: { ...prior, sequence: snapshot.sequence, activities: snapshot.activities, sources: snapshot.toolSources ?? [] },
        pending: snapshot.pending, settled: snapshot.settled ?? [] };
      const packet = captured.packet, key = canonicalJSON([packet.capabilityId, packet.intent.clientId]);
      const command: Command = action === "result" ? packetCommand(packet as ActivityPacket)
        : { type: "local_operation", actor: "$system", id: `operation:${hash(canonicalJSON(key))}`, packet: packet as LocalOperationPacket };
      const held = join(v.d.dir, "s1-failure-held"), release = join(v.d.dir, "s1-failure-release"), ready = join(v.d.dir, "s1-failure-ready"), go = join(v.d.dir, "s1-failure-go");
      const waiter = worker({ path: v.d.path, room: r.room, command, ready, go }); await waitForFiles([ready]);
      const writer = worker({ path: v.d.path, room: f.room, command: observation, holdReady: held, holdGo: release });
      await waitForFiles([held]); writeFileSync(go, "go"); writeFileSync(release, "commit retained failure");
      const [first, second] = await Promise.all([writer, waiter]); assert.equal(first.code, 0, first.stdout + first.stderr);
      assert.equal(second.code, 1, second.stdout + second.stderr); assert.match(second.stdout, /native invocation outcome|retained native outcome/);
      assert.deepEqual(outcomes(r, f.room, native.id), ["completed:0", "failed:1"]);
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      assert.equal(projection(r).requests.get("A")!.state, "open"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

for (const restart of [false, true])
  test(`S1 unchanged foreign success control records the result and answers${restart ? " after reopen/rebuild" : ""}`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v); f = await foreignHistory(v);
      for (let i = 0; i < 3; i++) { setOutcome(f.source, native.id, success); await f.observe(); }
      assert.deepEqual(outcomes(r, f.room, native.id), ["completed:0", "completed:0", "completed:0"]);
      if (restart) { v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); r.store.rebuild(f.room); }
      v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
      const recorded = await post(r, result()); assert.equal(recorded.status, 200, recorded.text);
      const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
      assert.equal(finished.body.result.claims[0].outcome, "answered"); assert.equal(projection(r).requests.get("A")!.state, "answered");
      v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

test("S1 a native failure every room agrees on is recorded as failed and the request is answered", async () => {
  const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
  try {
    const { r, native } = await originalBinding(v, true), binding = projection(r).activities.get("X")!.declaration!.binding!;
    f = await foreignHistory(v); await f.observe(); setOutcome(f.source, native.id, failure); await f.observe();
    setOutcome(v.source, native.id, failure); await tick(r); v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
    assert.deepEqual(outcomes(r, f.room, native.id), ["running:0", "failed:1"]);
    const recorded = await post(r, raw(r, "record_activity_result", { bindingReceiptKey: binding.bindingReceiptKey, completion: "failed",
      body: "Original native failure declared", resultRef: { itemId: native.id }, unavailableReason: null }));
    assert.equal(recorded.status, 200, recorded.text);
    const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
    assert.equal(finished.body.result.claims[0].outcome, "answered");
    assert.equal(projection(r).activities.get("X")!.declaration!.result!.originalSource!.exitCode, 1);
    v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
  } finally { f?.source.close(); v.cleanup(); }
});

for (const settled of [false, true])
  test(`S1 foreign failure seen only on the native node blocks fresh ${settled ? "finish after the earlier result" : "result and finish"}`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native, result } = await originalBinding(v);
      if (settled) assert.equal((await post(r, result())).status, 200);
      f = await foreignHistory(v); await f.observe();
      f.source.snapshot.projection.turnItems = f.source.snapshot.projection.turnItems.filter((s) => s.id !== native.id);
      f.source.snapshot.projection.nodes.find((n) => n.id === native.nodeId)!.status = "failed"; f.source.snapshot.snapshotSequence++; await f.observe();
      assert.ok(r.store.load(f.room).some((e) => e.data.kind === "provider.observed"
        && e.data.observation.sources?.some((s) => s.itemId === null && s.nodeId === native.nodeId && s.status === "failed")));
      v.source.snapshot.snapshotSequence = f.source.snapshot.snapshotSequence + 100;
      if (!settled) assert.equal((await post(r, result())).status, 409);
      assert.equal((await finishResponse(r)).status, 409);
      assert.equal(projection(r).activities.get("X")!.status, settled ? "done" : "pending");
      assert.equal(projection(r).requests.get("A")!.state, "open"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });

test("S1 the original room's own failure then restored success refuses the result and leaves the request open", async () => {
  const v = await operationRoom();
  try {
    const { r, native, result } = await originalBinding(v);
    setOutcome(v.source, native.id, failure); await tick(r); setOutcome(v.source, native.id, success); await tick(r);
    assert.deepEqual(outcomes(r, r.room, native.id).slice(-3), ["completed:0", "failed:1", "completed:0"]);
    assert.equal((await post(r, result())).status, 409);
    const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
    assert.equal(finished.body.result.claims[0].outcome, "pending_activity");
    assert.equal(projection(r).activities.get("X")!.status, "pending"); assert.equal(projection(r).requests.get("A")!.state, "open");
    v.d.parity();
  } finally { v.cleanup(); }
});

// Review F1: terminal outcomes are one value per scope, whichever room retained them.
async function twoForeignRooms(v: OperationRoom, id: string, first: Outcome) {
  const rooms = [await foreignHistory(v), await foreignHistory(v)];
  setOutcome(rooms[0]!.source, id, first); await rooms[0]!.observe(); setOutcome(rooms[1]!.source, id, failure); await rooms[1]!.observe();
  v.source.snapshot.snapshotSequence = Math.max(...rooms.map((f) => f.source.snapshot.snapshotSequence)) + 100;
  return rooms;
}
const nullRefFailed = (r: Rig) => raw(r, "record_activity_result", { bindingReceiptKey: projection(r).activities.get("X")!.declaration!.binding!.bindingReceiptKey,
  completion: "failed", body: "Declared failed without a native result", resultRef: null, unavailableReason: "The original room has not observed the native result" });
function reopenAll(v: OperationRoom, r: Rig, rooms: readonly { room: string }[]) {
  v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); for (const f of rooms) r.store.rebuild(f.room);
}

for (const restart of [false, true]) for (const settled of [false, true])
  test(`F1 two foreign rooms retaining different outcomes block a fresh ${settled ? "finish after the earlier result" : "result and finish"}${restart ? " after reopen/rebuild" : ""}`, async () => {
    const v = await operationRoom(); let rooms: Awaited<ReturnType<typeof foreignHistory>>[] = [];
    try {
      const { r, native } = await originalBinding(v, true), intent = nullRefFailed(r);
      if (settled) assert.equal((await post(r, intent)).status, 200);
      const immutable = canonicalJSON(projection(r).activities.get("X")!.declaration);
      rooms = await twoForeignRooms(v, native.id, success);
      assert.deepEqual(rooms.map((f) => outcomes(r, f.room, native.id)), [["completed:0"], ["failed:1"]]);
      if (restart) reopenAll(v, r, rooms);
      if (!settled) assert.equal((await post(r, intent)).status, 409);
      setOutcome(v.source, native.id, failure); await tick(r);
      const finished = await finishResponse(r); assert.equal(finished.status, 409, finished.text);
      assert.equal(canonicalJSON(projection(r).activities.get("X")!.declaration), immutable);
      assert.equal(projection(r).activities.get("X")!.status, settled ? "failed" : "pending");
      assert.equal(projection(r).requests.get("A")!.state, "open"); v.d.parity();
      for (const f of rooms) assert.equal(r.store.audit(f.room).ok, true);
    } finally { for (const f of rooms) f.source.close(); v.cleanup(); }
  });

for (const restart of [false, true])
  test(`F1 two foreign rooms agreeing on the failure record failed and answer${restart ? " after reopen/rebuild" : ""}`, async () => {
    const v = await operationRoom(); let rooms: Awaited<ReturnType<typeof foreignHistory>>[] = [];
    try {
      const { r, native } = await originalBinding(v, true); rooms = await twoForeignRooms(v, native.id, failure);
      if (restart) reopenAll(v, r, rooms);
      const recorded = await post(r, nullRefFailed(r)); assert.equal(recorded.status, 200, recorded.text);
      setOutcome(v.source, native.id, failure); await tick(r);
      const finished = await finishResponse(r); assert.equal(finished.status, 200, finished.text);
      assert.equal(finished.body.result.claims[0].outcome, "answered"); assert.equal(projection(r).activities.get("X")!.status, "failed");
      v.d.parity();
    } finally { for (const f of rooms) f.source.close(); v.cleanup(); }
  });

for (const own of ["success", "failure"] as const)
  test(`F1 the original room's own later ${own} joins the scope: finish ${own === "success" ? "is blocked" : "answers"} against a foreign failure`, async () => {
    const v = await operationRoom(); let f: Awaited<ReturnType<typeof foreignHistory>> | undefined;
    try {
      const { r, native } = await originalBinding(v, true); f = await foreignFailure(v, native.id, "failed-first");
      assert.equal((await post(r, nullRefFailed(r))).status, 200);
      setOutcome(v.source, native.id, own === "success" ? success : failure); await tick(r);
      assert.equal(outcomes(r, r.room, native.id).at(-1), own === "success" ? "completed:0" : "failed:1");
      const finished = await finishResponse(r);
      if (own === "success") { assert.equal(finished.status, 409, finished.text); assert.equal(projection(r).requests.get("A")!.state, "open"); }
      else { assert.equal(finished.status, 200, finished.text); assert.equal(finished.body.result.claims[0].outcome, "answered"); }
      assert.equal(projection(r).activities.get("X")!.status, "failed"); v.d.parity(); assert.equal(r.store.audit(f.room).ok, true);
    } finally { f?.source.close(); v.cleanup(); }
  });
