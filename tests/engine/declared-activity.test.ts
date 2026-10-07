import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { canonicalJSON, sourceKey } from "../../src/engine/result.ts";
import type { ActivityV2Intent, NativeHandle, OperationIntent } from "../../src/engine/operation-types.ts";
import type { Run } from "../../src/engine/types.ts";
import { operationRoom, SimulatedOperationSource } from "./operation-fixture.ts";
import type { OperationContext, OperationRoom } from "./operation-fixture.ts";

type Item = ReturnType<SimulatedOperationSource["addTool"]>;
interface Rig { store: EngineStore; room: string; source: SimulatedOperationSource; serial: number }
interface Reply { status: number; text: string; body: Record<string, unknown>; item: Item; intent: ActivityV2Intent }
const rigFor = (v: OperationRoom): Rig => ({ store: v.d.store, room: v.d.room, source: v.source, serial: 0 });
function intent(rig: Rig, context: OperationContext, operation: ActivityV2Intent["operation"], activityId: string,
  extra: Record<string, unknown>, clientId = `declared:${operation}:${++rig.serial}`): ActivityV2Intent {
  return { schema: "backroom.activity.v2", provenance: "member_declared", operation, clientId,
    nonce: `nonce:${clientId}`, originRunId: context.run.id, activityId, activityGeneration: 1, ...extra } as ActivityV2Intent;
}
async function tick(rig: Rig) { await new EngineReconciler(rig.store, rig.source.adapter).tick(rig.room, "W"); }
async function post(rig: Rig, context: OperationContext, raw: ActivityV2Intent,
  options: { item?: Item; nativeRun?: Run; complete?: boolean; authorization?: string } = {}): Promise<Reply> {
  const item = options.item ?? rig.source.addTool(options.nativeRun ?? context.run, raw.clientId,
    { input: raw, operation: raw.operation });
  const response = await new EngineLocalProtocol(rig.store, rig.source.adapter).handle(rig.room,
    new Request("http://declaration-simulation.invalid/activities", { method: "POST",
      headers: { "content-type": "application/json", authorization: options.authorization ?? context.authorization },
      body: JSON.stringify({ intent: raw, itemId: item.id }) }));
  const text = await response.text(), body = JSON.parse(text) as Record<string, unknown>;
  if (options.complete !== false) { rig.source.completeTool(item, text); await tick(rig); }
  return { status: response.status, text, body, item, intent: raw };
}
function receipt(reply: Reply): string {
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.provenance, "member_declared"); assert.equal(typeof reply.body.receiptKey, "string");
  return reply.body.receiptKey as string;
}
const register = (r: Rig, c: OperationContext, id = "X", requestIds = ["A"]) =>
  post(r, c, intent(r, c, "register_activity", id, { requestIds, nativeId: null }));
const bind = (r: Rig, c: OperationContext, id: string, registrationReceiptKey: string, nativeHandle: NativeHandle,
  originalSourceRef: null | { itemId: string } = null) => post(r, c, intent(r, c, "bind_activity", id,
    { registrationReceiptKey, nativeHandle, originalSourceRef }));
const resultIntent = (r: Rig, c: OperationContext, id: string, bindingReceiptKey: string, resultRef: null | { itemId: string },
  extra: Record<string, unknown> = {}) => intent(r, c, "record_activity_result", id,
    { bindingReceiptKey, completion: "done", body: "Original member result retained", resultRef,
      unavailableReason: resultRef ? null : "The provider exposes no original native result reference for this opaque handle", ...extra });
function command(r: Rig, c: OperationContext, id: string, status = "running", output?: string): Item {
  return r.source.addTool(c.run, id, { type: "command_execution", input: "npm test -- focused", status, exitCode: 0,
    ...(output === undefined ? {} : { output }) });
}
async function finish(rig: Rig, c: OperationContext, requestIds = ["A"], id = `finish:${++rig.serial}`) {
  const raw: OperationIntent = { schema: "backroom.operation.v1", operation: "finish", clientId: id,
    nonce: `nonce:${id}`, originRunId: c.run.id, toolRefs: [], body: "Explicit original request result", disposition: { kind: "answer", requestIds } };
  const item = rig.source.addTool(c.run, id, { input: raw, operation: "finish" });
  const response = await new EngineLocalProtocol(rig.store, rig.source.adapter).handle(rig.room,
    new Request("http://declaration-simulation.invalid/operations", { method: "POST", headers: { authorization: c.authorization,
      "content-type": "application/json" }, body: JSON.stringify({ intent: raw, itemId: item.id }) }));
  const text = await response.text(); assert.equal(response.status, 200, text);
  rig.source.completeTool(item, text); await tick(rig);
  return JSON.parse(text) as { result: { claims: { requestId: string; outcome: string }[] } };
}
const activity = (r: Rig, id = "X") => r.store.project(r.room).activities.get(id)!;
const receipts = (r: Rig) => r.store.project(r.room).activityReceipts;
const claims = (r: Rig) => r.store.load(r.room).flatMap((e) => e.data.kind === "output" ? e.data.claims : []);

/** Public T3 projections and provider outcomes are source-shaped local fixtures; no live provider turns. */
test("U D5 actual v2 register before command -> explicit member bind -> retained result settles only X; no consume recursion", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), regKey = receipt(reg), frozen = canonicalJSON(activity(r).declaration!.registration);
    assert.equal(activity(r).status, "pending"); assert.equal(activity(r).nativeSource, undefined);
    assert.equal(reg.body.operation, "register_activity"); assert.deepEqual(reg.body.claims, []);
    const native = command(r, c, "original-tool:postlaunch"); await tick(r);
    assert.equal(activity(r).declaration!.binding, undefined, "observation alone never binds");
    const bound = await bind(r, c, "X", regKey, { namespace: "provider_item", value: String(Reflect.get(native.nativeItemRef as object, "nativeId")) }, { itemId: native.id });
    const boundKey = receipt(bound); assert.equal(activity(r).status, "pending");
    assert.equal(canonicalJSON(activity(r).declaration!.registration), frozen);
    assert.equal(activity(r).declaration!.binding!.originalSource!.itemId, native.id);
    assert.equal(activity(r).declaration!.binding!.correlation, "strong_native_reference");
    assert.equal((await finish(r, c)).result.claims[0]!.outcome, "pending_activity");
    v.source.completeTool(native, JSON.stringify("Actual original stdout/stderr retained\n")); await tick(r);
    const out = await post(r, c, resultIntent(r, c, "X", boundKey, { itemId: native.id })); receipt(out);
    const a = activity(r); assert.equal(a.status, "done"); assert.equal(a.declaration!.result!.originalSource!.output, "Actual original stdout/stderr retained\n");
    assert.equal(a.declaration!.result!.bindingReceiptKey, boundKey); assert.deepEqual(out.body.claims, []);
    assert.equal(r.store.project(r.room).requests.get("A")!.state, "open", "logical result cannot claim A");
    assert.equal(r.store.project(r.room).toolResults.size, 0, "no ordinary consumption receipt fabricated");
    assert.ok(r.store.project(r.room).operationBindings.get(sourceKey(receipts(r).get(regKey)!.packet.source))!.confirmed);
    assert.equal((await finish(r, c)).result.claims[0]!.outcome, "answered");
    assert.equal(claims(r).filter((x) => x.outcome === "answered").length, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("U2 progress and parent turn end do not settle pending X; independent B finishes without adopting X", async () => {
  const v = await operationRoom(), r = rigFor(v), a = v.initial;
  try {
    const reg = await register(r, a), bound = await bind(r, a, "X", receipt(reg), { namespace: "process", value: "opaque-process:pending" }); receipt(bound);
    v.source.endRun(a.run, { kind: "progress", requestIds: ["A"] }, "Original A progress, background X still pending"); await tick(r);
    assert.equal(activity(r).status, "pending"); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open");
    v.d.request("B"); const b = await v.start();
    assert.equal((await finish(r, b, ["B"])).result.claims[0]!.outcome, "answered");
    assert.equal(activity(r).status, "pending"); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open");
    assert.equal((await finish(r, a, ["A"])).result.claims[0]!.outcome, "pending_activity");
    assert.ok(r.store.load(r.room).some((e) => e.data.kind === "output" && e.data.body.includes("Original A progress")));
    const events = r.store.load(r.room).length, launches = v.source.appRuns;
    for (let i = 0; i < 5; i++) await tick(r);
    assert.equal(r.store.load(r.room).length, events); assert.equal(v.source.appRuns, launches); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 early original result remains retained/pending without settled result receipt; explicit bind+retry records once", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), native = command(r, c, "original-result-before-bind", "completed", "Original early result\n"); await tick(r);
    const before = receipts(r).size, early = await post(r, c, resultIntent(r, c, "X", "not-an-issued-binding-receipt", { itemId: native.id }));
    assert.equal(early.status, 409); assert.equal(receipts(r).size, before); assert.equal(activity(r).status, "pending");
    assert.equal(activity(r).declaration!.result, undefined); assert.equal(v.source.detailItems.get(native.id)!.output, "Original early result\n");
    assert.ok([...r.store.project(r.room).toolClosures.values()].some((x) => x.source.itemId === native.id && x.source.output === "Original early result\n"));
    const bound = await bind(r, c, "X", receipt(reg), { namespace: "provider_item", value: `native-item:${native.id}` }, { itemId: native.id });
    const raw = resultIntent(r, c, "X", receipt(bound), { itemId: native.id }), out = await post(r, c, raw); receipt(out);
    const result = canonicalJSON(activity(r).declaration!.result), head = r.store.load(r.room).length;
    const replay = await post(r, c, raw, { item: out.item, complete: false });
    assert.equal(replay.text, out.text); assert.equal(r.store.load(r.room).length, head); assert.equal(canonicalJSON(activity(r).declaration!.result), result);
    assert.equal(activity(r).status, "done"); assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "activity.declared_result").length, 1); v.d.parity();
  } finally { v.cleanup(); }
});

for (const fault of ["missing_native_ref", "different_native_ref", "namespace_process", "pre_registration_source", "wrong_registration_receipt"] as const)
  test(`U7 available native source bind rejects ${fault} with original registration untouched`, async () => {
    const v = await operationRoom(), r = rigFor(v), c = v.initial;
    try {
      let native: Item | undefined;
      if (fault === "pre_registration_source") { native = command(r, c, "old-before-registration"); await tick(r); }
      const reg = await register(r, c), original = canonicalJSON(activity(r).declaration!.registration);
      native ??= command(r, c, `native-bind:${fault}`); await tick(r);
      const response = await bind(r, c, "X", fault === "wrong_registration_receipt" ? "another-registration" : receipt(reg),
        { namespace: fault === "namespace_process" ? "process" : "provider_item",
          value: fault === "different_native_ref" ? "native-item:unrelated" : `native-item:${native.id}` },
        fault === "missing_native_ref" ? null : { itemId: native.id });
      assert.equal(response.status, 409); assert.equal(activity(r).declaration!.binding, undefined);
      assert.equal(canonicalJSON(activity(r).declaration!.registration), original); assert.equal(activity(r).status, "pending");
      assert.equal(receipts(r).size, 1); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open"); v.d.parity();
    } finally { v.cleanup(); }
  });

test("U7 known available native result cannot be hidden by null; referenced native failure cannot become declared success", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), native = command(r, c, "real-failing-original"); await tick(r);
    const bound = await bind(r, c, "X", receipt(reg), { namespace: "provider_item", value: `native-item:${native.id}` }, { itemId: native.id }), key = receipt(bound);
    Object.assign(native, { status: "failed", exitCode: 7, output: "Actual failure code7\n" });
    v.source.snapshot.projection.nodes.find((n) => n.id === native.nodeId)!.status = "failed"; v.source.project(native); await tick(r);
    const size = receipts(r).size, hidden = await post(r, c, resultIntent(r, c, "X", key, null));
    assert.equal(hidden.status, 409); assert.equal(receipts(r).size, size); assert.equal(activity(r).status, "pending");
    const wrong = await post(r, c, resultIntent(r, c, "X", key, { itemId: native.id }));
    assert.equal(wrong.status, 409); assert.equal(receipts(r).size, size); assert.equal(activity(r).declaration!.result, undefined);
    const failed = await post(r, c, resultIntent(r, c, "X", key, { itemId: native.id }, { completion: "failed" })); receipt(failed);
    assert.equal(activity(r).status, "failed"); assert.equal(activity(r).declaration!.result!.originalSource!.exitCode, 7);
    assert.equal(activity(r).declaration!.result!.originalSource!.output, "Actual failure code7\n");
    assert.equal(r.store.project(r.room).requests.get("A")!.state, "open"); assert.deepEqual(failed.body.claims, []); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 original continuation may record late X after B; generic later-run capability cannot adopt original X", async () => {
  const v = await operationRoom(), r = rigFor(v), a = v.initial;
  try {
    const reg = await register(r, a), bound = await bind(r, a, "X", receipt(reg), { namespace: "task", value: "opaque-original-task" }), key = receipt(bound);
    v.source.endRun(a.run, { kind: "yield" }, "Original root yields while X stays pending"); await tick(r);
    v.d.request("B"); const b = await v.start(); await finish(r, b, ["B"]);
    const size = receipts(r).size, wrong = resultIntent(r, a, "X", key, null);
    const adopted = await post(r, b, wrong); assert.equal(adopted.status, 409); assert.equal(receipts(r).size, size); assert.equal(activity(r).status, "pending");
    v.source.endRun(b.run, { kind: "silent" }); await tick(r);
    const wake = v.source.continuation(a.run), nativeRunId = v.source.native(wake).id;
    const auth = new EngineLocalProtocol(r.store, v.source.adapter).authorizeRun(r.room, a.run.id,
      { generation: 1, server: "backroom-board", activityId: "X", nativeRunId });
    const original: OperationContext = { run: a.run, ...auth };
    const late = await post(r, original, resultIntent(r, original, "X", key, null), { nativeRun: wake }); receipt(late);
    assert.equal(activity(r).status, "done"); assert.equal(activity(r).runId, a.run.id);
    assert.equal(activity(r).declaration!.registration.providerRunId, v.source.native(a.run).id);
    assert.equal(r.store.project(r.room).requests.get("B")!.state, "answered"); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open"); v.d.parity();
  } finally { v.cleanup(); }
});

test("U8 D6 unobserved stale opaque process is accepted only as unverified member provenance; discovered contradiction blocks new affected finish", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), value = "previously-unreported-stale-process", bound = await bind(r, c, "X", receipt(reg), { namespace: "process", value });
    const out = await post(r, c, resultIntent(r, c, "X", receipt(bound), null)); receipt(out);
    const original = canonicalJSON(activity(r).declaration);
    assert.equal(activity(r).declaration!.binding!.availability, "reference_unavailable");
    assert.equal(activity(r).declaration!.binding!.correlation, "unverified");
    assert.ok(activity(r).declaration!.binding!.limitations.includes("physical_result_truth_unverified"));
    assert.ok(activity(r).declaration!.binding!.limitations.includes("member_declared_intent_not_provider_certified_launch"));
    assert.equal(activity(r).declaration!.result!.evidence, null); assert.equal(activity(r).status, "done");
    const stale = command(r, c, "now-visible-stale-native", "completed", "Actual older source result remains retained\n");
    const nativeRef = { driver: "codex", nativeId: value, strength: "strong" };
    stale.nativeItemRef = nativeRef; v.source.snapshot.projection.nodes.find((n) => n.id === stale.nodeId)!.nativeItemRef = nativeRef;
    v.source.project(stale); await tick(r);
    assert.equal(canonicalJSON(activity(r).declaration), original, "conflict must not erase historical declarations");
    assert.ok(r.store.load(r.room).some((e) => e.data.kind === "provider.conflict" && e.data.code.includes("declared")));
    assert.equal((await finish(r, c)).result.claims[0]!.outcome, "pending_activity");
    assert.equal(r.store.project(r.room).requests.get("A")!.state, "open"); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 register/bind/result raw replay after restart precedes disabled provider reads and changed authoritative body conflicts", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "process", value: "raw-replay-opaque" });
    const out = await post(r, c, resultIntent(r, c, "X", receipt(bound), null)); receipt(out);
    const records = [reg, bound, out], head = r.store.load(r.room).length, original = canonicalJSON(activity(r).declaration);
    v.d.reopen(); r.store = v.d.store; v.source.disabled = true; v.source.snapshot.snapshotSequence += 20;
    const reads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads];
    for (const record of records) {
      const replay = await post(r, c, record.intent, { item: record.item, complete: false });
      assert.equal(replay.status, 200); assert.equal(replay.text, record.text);
    }
    const changed = { ...out.intent, body: "Changed authoritative original result body" } as ActivityV2Intent;
    const rejected = await post(r, c, changed, { item: out.item, complete: false }); assert.equal(rejected.status, 409);
    assert.equal(r.store.load(r.room).length, head); assert.equal(canonicalJSON(activity(r).declaration), original);
    assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], reads); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 two authenticated native aliases of identical register intent commit one declaration and frozen receipt", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  const other = new EngineStore(v.d.path);
  try {
    const raw = intent(r, c, "register_activity", "X", { requestIds: ["A"], nativeId: null });
    const first = v.source.addTool(c.run, "register-alias:one", { input: raw, operation: raw.operation });
    const second = v.source.addTool(c.run, "register-alias:two", { input: raw, operation: raw.operation });
    const replies = await Promise.all([post(r, c, raw, { item: first, complete: false }),
      post({ ...r, store: other }, c, raw, { item: second, complete: false })]);
    assert.deepEqual(replies.map((x) => x.status), [200, 200]); assert.equal(replies[0]!.text, replies[1]!.text);
    assert.equal(receipts(r).size, 1); assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "activity.started").length, 1);
    assert.equal(activity(r).status, "pending"); assert.equal(claims(r).length, 0);
    for (const out of replies) v.source.completeTool(out.item, out.text); await tick(r); v.d.parity();
  } finally { other.close(); v.cleanup(); }
});

for (const phase of ["settlement", "cancel"] as const)
  test(`U7 native ownership tombstone survives ${phase}, restart/rebuild and newer logical activity IDs`, async () => {
    const v = await operationRoom(["A", "B"]), r = rigFor(v), c = v.initial;
    try {
      const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "process", value: "same-scope-reused-handle" }), binding = activity(r).declaration!.binding!;
      if (phase === "settlement") receipt(await post(r, c, resultIntent(r, c, "X", receipt(bound), null)));
      else v.d.add({ type: "cancel", actor: "$user", requestId: "A" });
      const key = binding.ownershipKey, original = canonicalJSON(binding);
      v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room);
      const reg2 = await register(r, c, "X-next-logical-id", ["B"]);
      const attempted = await bind(r, c, "X-next-logical-id", receipt(reg2), { namespace: "process", value: "same-scope-reused-handle" });
      assert.equal(attempted.status, 409); assert.equal(activity(r, "X-next-logical-id").declaration!.binding, undefined);
      assert.equal(canonicalJSON(activity(r).declaration!.binding), original); assert.equal(activity(r).declaration!.binding!.ownershipKey, key);
      assert.equal(activity(r, "X-next-logical-id").status, "pending"); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const change of ["body", "binding_receipt", "caller_checkpoint", "provenance_upgrade", "request_override"] as const)
  test(`U7 immutable original declaration rejects ${change} without replacing binding/result`, async () => {
    const v = await operationRoom(), r = rigFor(v), c = v.initial;
    try {
      const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "task", value: `immutable:${change}` }), key = receipt(bound);
      const raw = resultIntent(r, c, "X", key, null);
      if (change === "body") {
        const first = await post(r, c, raw); receipt(first);
        const before = canonicalJSON(activity(r).declaration!.result), head = r.store.load(r.room).length;
        const changed = { ...raw, body: "Changed body under the original raw client ID" } as ActivityV2Intent;
        const rejected = await post(r, c, changed, { item: first.item, complete: false });
        assert.equal(rejected.status, 409); assert.equal(r.store.load(r.room).length, head); assert.equal(canonicalJSON(activity(r).declaration!.result), before);
      } else {
        const extra = change === "binding_receipt" ? { bindingReceiptKey: "other-original-binding" }
          : change === "caller_checkpoint" ? { sourceCheckpointDigest: "caller-supplied-authority", trusted: true }
          : change === "provenance_upgrade" ? { provenance: "provider_correlated" } : { requestIds: ["B"] };
        const rejected = await post(r, c, { ...raw, ...extra } as ActivityV2Intent);
        assert.equal(rejected.status, 409); assert.equal(activity(r).declaration!.result, undefined); assert.equal(activity(r).status, "pending");
      }
      assert.equal(activity(r).declaration!.binding!.bindingReceiptKey, key); v.d.parity();
    } finally { v.cleanup(); }
  });

test("U7 store-wide writer serialization rejects same environment/provider-thread handle across rooms", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial, other = new EngineStore(v.d.path), source = new SimulatedOperationSource();
  try {
    const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "process", value: "crossroom-owned-handle" }); receipt(bound);
    const room = "another-room";
    for (const seatId of ["O", "W"]) other.execute(room, { type: "seat", actor: "$user", id: `seat:${seatId}`, seatId,
      threadId: `thread:${seatId}`, orchestrator: seatId === "O" });
    other.execute(room, { type: "request", actor: "$user", id: "A2", to: "W", body: "Independent other-room work" });
    other.reserveNative(room, "W", 1_000_000); const run = [...other.project(room).runs.values()][0]!;
    const reconciler = new EngineReconciler(other, source.adapter); await reconciler.prepareRun(room, run.id, { instanceId: "codex", model: "simulated-model" });
    const auth = new EngineLocalProtocol(other, source.adapter).authorizeRun(room, run.id, { generation: 1, server: "backroom-board" });
    await reconciler.tick(room, "W"); await reconciler.tick(room, "W");
    const second: OperationContext = { run, ...auth }, r2: Rig = { store: other, room, source, serial: 0 };
    const reg2 = await register(r2, second, "X2", ["A2"]);
    const lost = await bind(r2, second, "X2", receipt(reg2), { namespace: "process", value: "crossroom-owned-handle" });
    assert.equal(lost.status, 409); assert.equal(activity(r2, "X2").declaration!.binding, undefined);
    assert.equal(activity(r).declaration!.binding!.nativeHandle.value, "crossroom-owned-handle");
    assert.equal(other.audit(room).ok, true); v.d.parity();
  } finally { source.close(); other.close(); v.cleanup(); }
});

test("U7 changed original result body discovered at the same metadata timestamp rejects new declared result, retaining originals and pending X", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), native = command(r, c, "body-conflict-original"); await tick(r);
    const binding = await bind(r, c, "X", receipt(reg), { namespace: "provider_item", value: "native-item:body-conflict-original" }, { itemId: native.id });
    const bindingKey = receipt(binding);
    v.source.completeTool(native, JSON.stringify("Original immutable result\n")); await tick(r);
    const original = r.store.project(r.room).toolClosures.get(sourceKey(await v.source.adapter.detail("thread:W", native.id)))!;
    assert.equal(original.source.output, "Original immutable result\n");
    native.output = "Changed native body at the same timestamp\n"; // No fabricated sequence/digest authority.
    const rejected = await post(r, c, resultIntent(r, c, "X", bindingKey, { itemId: native.id }));
    assert.equal(rejected.status, 409); assert.equal(activity(r).status, "pending"); assert.equal(activity(r).declaration!.result, undefined);
    assert.equal(receipts(r).size, 2, "no result receipt commits after discovered contradiction");
    assert.equal(r.store.project(r.room).toolClosures.get(original.key)!.source.output, "Original immutable result\n");
    assert.ok(r.store.load(r.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === native.id
      && e.data.source.output === "Changed native body at the same timestamp\n"));
    v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); v.d.parity();
    assert.equal(activity(r).status, "pending"); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open");
  } finally { v.cleanup(); }
});

test("U7 exact known task handle before registration remains stale after roster disappearance and cannot be declared fresh", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const provider = v.source.snapshot.projection.providerThreads[0]!;
    provider.pendingBackgroundTasks = [{ taskId: "known-task-before-register", kind: "command" }];
    v.source.snapshot.snapshotSequence++; await tick(r);
    provider.pendingBackgroundTasks = []; v.source.snapshot.snapshotSequence++; await tick(r);
    const reg = await register(r, c), response = await bind(r, c, "X", receipt(reg),
      { namespace: "task", value: "known-task-before-register" });
    assert.equal(response.status, 409); assert.equal(activity(r).declaration!.binding, undefined);
    assert.equal(activity(r).status, "pending"); assert.equal(receipts(r).size, 1);
    assert.ok(r.store.project(r.room).providerObservations.get("W")!.pending.includes("background:provider-thread:known-task-before-register")); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 strict v1 registration cannot be downgraded to member-declared v2 or use v2 binding", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const raw = { schema: "backroom.activity.v1", operation: "register_activity", clientId: "strict-v1-registration",
      nonce: "nonce:strict-v1-registration", originRunId: c.run.id, activityId: "X", activityGeneration: 1,
      requestIds: ["A"], nativeId: null } as unknown as ActivityV2Intent;
    const original = await post(r, c, raw); assert.equal(original.status, 200, original.text);
    assert.equal(original.body.schema, "backroom.activity-result.v1"); assert.equal(activity(r).declaration, undefined);
    const saved = canonicalJSON(activity(r)), reg2 = await register(r, c);
    assert.equal(reg2.status, 409); assert.equal(canonicalJSON(activity(r)), saved);
    const bound = await bind(r, c, "X", JSON.stringify([c.capabilityId, raw.clientId]), { namespace: "process", value: "v2-downgrade-attempt" });
    assert.equal(bound.status, 409); assert.equal(activity(r).declaration, undefined); assert.equal(canonicalJSON(activity(r)), saved);
    assert.equal(receipts(r).size, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 concurrent changed bind intents choose one immutable handle with no loser binding receipt", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial, other = new EngineStore(v.d.path);
  try {
    const reg = await register(r, c), key = receipt(reg);
    const raws = ["one", "two"].map((name) => intent(r, c, "bind_activity", "X", { registrationReceiptKey: key,
      nativeHandle: { namespace: "process", value: `competing-opaque:${name}` }, originalSourceRef: null }));
    const items = raws.map((raw) => v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation }));
    const replies = await Promise.all(raws.map((raw, i) => post(i ? { ...r, store: other } : r, c, raw,
      { item: items[i]!, complete: false })));
    assert.deepEqual(replies.map((x) => x.status).sort(), [200, 409]);
    const winner = replies.find((x) => x.status === 200)!;
    assert.equal(activity(r).declaration!.binding!.bindingReceiptKey, receipt(winner)); assert.equal(receipts(r).size, 2);
    assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "activity.declared_bound").length, 1);
    assert.equal(activity(r).status, "pending"); assert.equal(activity(r).declaration!.result, undefined);
    for (const response of replies) v.source.completeTool(response.item, response.text); await tick(r); v.d.parity();
  } finally { other.close(); v.cleanup(); }
});

for (const changed of [false, true]) test(`U7 concurrent ${changed ? "conflicting" : "duplicate alias"} result intents commit one original result`, async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial, other = new EngineStore(v.d.path);
  try {
    const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "task", value: "concurrent-result-original" }), key = receipt(bound);
    const raw = resultIntent(r, c, "X", key, null);
    const raws = [raw, changed ? resultIntent(r, c, "X", key, null, { body: "Different member result body" }) : raw];
    const items = raws.map((value, i) => v.source.addTool(c.run, `native-result-alias:${i}`, { input: value, operation: value.operation }));
    const replies = await Promise.all(raws.map((value, i) => post(i ? { ...r, store: other } : r, c, value,
      { item: items[i]!, complete: false })));
    assert.deepEqual(replies.map((x) => x.status).sort(), changed ? [200, 409] : [200, 200]);
    if (!changed) assert.equal(replies[0]!.text, replies[1]!.text);
    const winner = replies.find((x) => x.status === 200)!;
    assert.equal(activity(r).declaration!.result!.resultReceiptKey, receipt(winner)); assert.equal(receipts(r).size, 3);
    assert.equal(activity(r).status, "done"); assert.equal(r.store.project(r.room).requests.get("A")!.state, "open");
    assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "activity.declared_result").length, 1);
    for (const response of replies) v.source.completeTool(response.item, response.text); await tick(r); v.d.parity();
  } finally { other.close(); v.cleanup(); }
});

test("U7 available result from another native item cannot replace immutable original result reference", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), original = command(r, c, "immutable-original-command"), other = command(r, c, "other-command-same-text"); await tick(r);
    const bound = await bind(r, c, "X", receipt(reg), { namespace: "provider_item", value: `native-item:${original.id}` }, { itemId: original.id });
    v.source.completeTool(original, JSON.stringify("Original output\n")); v.source.completeTool(other, JSON.stringify("Other output\n")); await tick(r);
    const rejected = await post(r, c, resultIntent(r, c, "X", receipt(bound), { itemId: other.id }));
    assert.equal(rejected.status, 409); assert.equal(activity(r).status, "pending"); assert.equal(activity(r).declaration!.result, undefined);
    assert.equal(activity(r).declaration!.binding!.originalSource!.itemId, original.id);
    assert.equal(v.source.detailItems.get(original.id)!.output, "Original output\n"); assert.equal(v.source.detailItems.get(other.id)!.output, "Other output\n"); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 declared result X cannot settle independent Y, native child, pending task or runtime control", async () => {
  const v = await operationRoom(["A", "B"]), r = rigFor(v), c = v.initial;
  try {
    const regX = await register(r, c), bindX = await bind(r, c, "X", receipt(regX), { namespace: "process", value: "only-X-result" });
    const regY = await register(r, c, "Y", ["B"]); await bind(r, c, "Y", receipt(regY), { namespace: "task", value: "Y-still-pending" });
    const native = v.source.native(c.run);
    v.source.snapshot.projection.subagents.push({ id: "independent-native-child", threadId: "thread:W", runId: native.id,
      origin: "provider_native", status: "running", result: null, childThreadId: "original-child-thread" });
    v.source.snapshot.projection.runtimeRequests.push({ id: "independent-runtime-control", threadId: "thread:W", nodeId: native.rootId,
      status: "pending", kind: "command", responseCapability: { type: "live" } });
    v.source.snapshot.projection.providerThreads[0]!.pendingBackgroundTasks = [{ taskId: "independent-native-task", kind: "command" }];
    v.source.snapshot.snapshotSequence++; await tick(r);
    const out = await post(r, c, resultIntent(r, c, "X", receipt(bindX), null)); receipt(out);
    assert.equal(activity(r).status, "done"); assert.equal(activity(r, "Y").status, "pending");
    const pending = r.store.project(r.room).providerObservations.get("W")!.pending;
    assert.ok(pending.includes("subagents:independent-native-child"));
    assert.ok(pending.includes("runtimeRequests:independent-runtime-control"));
    assert.ok(pending.includes("background:provider-thread:independent-native-task"));
    assert.ok([...r.store.project(r.room).providerHolds.values()].some((h) => h.held && h.code === "native_activity:independent-native-child"));
    const blocked = await finish(r, c, ["A", "B"]); assert.equal(blocked.result.claims.every((x) => x.outcome === "pending_activity"), true);
    assert.equal(r.store.project(r.room).requests.get("A")!.state, "open"); assert.equal(r.store.project(r.room).requests.get("B")!.state, "open"); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 original retired seat cannot replay frozen v2 receipt; transfer preserves ownership tombstone", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const reg = await register(r, c), bound = await bind(r, c, "X", receipt(reg), { namespace: "process", value: "original-transferred-tombstone" });
    const out = await post(r, c, resultIntent(r, c, "X", receipt(bound), null)); receipt(out);
    v.source.endRun(c.run, { kind: "silent" }); await tick(r);
    assert.equal((await new EngineReconciler(r.store, v.source.adapter).quiescence(r.room, "W")).proven, true);
    const original = canonicalJSON(activity(r).declaration), reads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads];
    v.d.add({ type: "transfer", actor: "$user", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
      owned: ["A"], awaited: [], body: "Explicit original transfer", evidence: "Actual fresh simulated native quiescence" });
    const head = r.store.load(r.room).length, replay = await post(r, c, out.intent, { item: out.item, complete: false });
    assert.equal(replay.status, 401); assert.equal(r.store.load(r.room).length, head);
    assert.equal(canonicalJSON(activity(r).declaration), original); assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], reads);
    v.d.reopen(); r.store = v.d.store; r.store.rebuild(r.room); assert.equal(canonicalJSON(activity(r).declaration), original); v.d.parity();
  } finally { v.cleanup(); }
});

test("U7 original child summary/run and original task-status return survive newer latestTerminal fields and pending child runs", async () => {
  const v = await operationRoom(), r = rigFor(v), c = v.initial;
  try {
    const native = v.source.native(c.run), child = { id: "original-child", threadId: "thread:W", runId: native.id,
      origin: "provider_native", status: "completed", childThreadId: "child-thread-original", result: "Original child summary C" };
    v.source.snapshot.projection.subagents.push(child);
    v.source.snapshot.projection.subagents.push({ id: "independent-new-pending-child", threadId: "thread:W", runId: native.id,
      origin: "provider_native", status: "running", childThreadId: "child-thread-new", result: null });
    v.source.snapshot.snapshotSequence++;
    const originalOutput = { taskId: child.id, childThreadId: child.childThreadId, childRunId: "child-run:C", childNodeId: child.id,
      status: "running", workState: "waiting_for_children", hasPendingChildRuns: true,
      latestTerminalRunId: "child-run:D", latestTerminalStatus: "completed", latestTerminalSummary: "Later terminal D summary",
      latestTerminalResultContextTransferId: "context:D", providerInstanceId: "codex", model: "simulated-model",
      summary: "Original child summary C", resultContextTransferId: "context:C", waitTimedOut: false };
    const first = v.source.addTool(c.run, "original-task-status-return", { input: { taskId: child.id }, output: originalOutput,
      type: "dynamic_tool", status: "completed", operation: "task_status" });
    first.toolName = "t3-code.task_status"; first.toolSource = { key: "mcp:t3-code", kind: "integration" }; v.source.project(first); await tick(r);
    const originalClosure = [...r.store.project(r.room).toolClosures.values()].find((x) => x.source.itemId === first.id)!;
    assert.ok(originalClosure); assert.deepEqual(originalClosure.source.output, originalOutput);
    const laterOutput = { ...originalOutput, latestTerminalRunId: "child-run:E", latestTerminalSummary: "Newer E summary", latestTerminalResultContextTransferId: "context:E" };
    const second = v.source.addTool(c.run, "new-task-status-return", { input: { taskId: child.id }, output: laterOutput,
      type: "dynamic_tool", status: "completed", operation: "task_status" });
    second.toolName = "t3-code.task_status"; second.toolSource = { key: "mcp:t3-code", kind: "integration" }; v.source.project(second); await tick(r);
    assert.deepEqual(r.store.project(r.room).toolClosures.get(originalClosure.key)!.source.output, originalOutput);
    const originalChild = r.store.project(r.room).providerObservations.get("W")!.activities!.find((x) => x.id === child.id)!.originalChild!;
    assert.deepEqual(originalChild.child, child); assert.equal((originalChild.child as typeof child).runId, native.id);
    assert.equal((originalChild.child as typeof child).result, "Original child summary C");
    assert.ok(r.store.project(r.room).providerObservations.get("W")!.pending.includes("subagents:independent-new-pending-child"));
    assert.equal((await finish(r, c)).result.claims[0]!.outcome, "pending_activity");
    v.d.reopen(); r.store = v.d.store;
    assert.deepEqual(r.store.project(r.room).toolClosures.get(originalClosure.key)!.source.output, originalOutput); v.d.parity();
  } finally { v.cleanup(); }
});
