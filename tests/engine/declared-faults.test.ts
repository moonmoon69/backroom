import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, fold } from "../../src/engine/index.ts";
import { canonicalJSON } from "../../src/engine/result.ts";
import { hash } from "../../src/engine/provider.ts";
import { operationKey } from "../../src/engine/operations.ts";
import type { ActivityPacket, ActivityV2Intent } from "../../src/engine/operation-types.ts";
import type { Command } from "../../src/engine/types.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { OperationRoom } from "./operation-fixture.ts";
import { worker } from "./store-fixture.ts";

function raw(h: OperationRoom, operation: ActivityV2Intent["operation"], extra: Record<string, unknown>): ActivityV2Intent {
  return { schema: "backroom.activity.v2", provenance: "member_declared", operation, clientId: `crash:${operation}`,
    nonce: `nonce:${operation}`, originRunId: h.initial.run.id, activityId: "X", activityGeneration: 1, ...extra } as ActivityV2Intent;
}
async function invoke(h: OperationRoom, intent: ActivityV2Intent, intercept = false): Promise<ActivityPacket | string> {
  const item = h.source.addTool(h.initial.run, intent.clientId, { input: intent, operation: intent.operation });
  const original = h.d.store.commitActivity.bind(h.d.store); let captured: ActivityPacket | undefined;
  if (intercept) h.d.store.commitActivity = (_room, packet) => { captured = structuredClone(packet); throw new Error("test capture before effect transaction"); };
  try {
    const response = await h.protocol.handle(h.d.room, new Request("http://fault-simulation.invalid/activities", { method: "POST",
      headers: { authorization: h.initial.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent, itemId: item.id }) }));
    const text = await response.text();
    if (intercept) { assert.equal(response.status, 409); assert.ok(captured); return captured; }
    assert.equal(response.status, 200, text); h.source.completeTool(item, text); await h.x.tick(h.d.room, "W");
    return String(JSON.parse(text).receiptKey);
  } finally { h.d.store.commitActivity = original; }
}
async function packetFor(h: OperationRoom, stage: "register" | "bind" | "result"): Promise<ActivityPacket> {
  const registration = raw(h, "register_activity", { requestIds: ["A"], nativeId: null });
  if (stage === "register") return await invoke(h, registration, true) as ActivityPacket;
  const registrationReceiptKey = await invoke(h, registration) as string;
  const native = h.source.addTool(h.initial.run, "original-command", { type: "command_execution", input: "npm test -- focused",
    status: "running", exitCode: 0 });
  const binding = raw(h, "bind_activity", { registrationReceiptKey,
    nativeHandle: { namespace: "provider_item", value: "native-item:original-command" }, originalSourceRef: { itemId: native.id } });
  if (stage === "bind") return await invoke(h, binding, true) as ActivityPacket;
  const bindingReceiptKey = await invoke(h, binding) as string;
  h.source.completeTool(native, JSON.stringify("Actual original result retained\n"));
  return await invoke(h, raw(h, "record_activity_result", { bindingReceiptKey, completion: "done", body: "Original member report",
    resultRef: { itemId: native.id }, unavailableReason: null }), true) as ActivityPacket;
}
const boundaries = ["before_begin", "after_begin", "after_read", "after_decide", "after_events", "after_index_delete", "after_projection",
  "after_affected_first", "after_affected_last", "after_indices", "after_head", "before_commit", "after_commit", "before_cache_publish", "after_cache_publish"];
for (const stage of ["register", "bind", "result"] as const) test(`U real SIGKILL ${stage}: journal/effects/key/receipt are whole-batch and raw recovery needs no provider`, async (t) => {
  // Each boundary uses a fresh actual HTTP/source-shaped packet and dedicated isolated DB.
  // after_event:N is enumerated from the full replay decision, not a fabricated event count.
  let killed = 0;
  const planning = await operationRoom();
  let eventCount: number;
  try {
    const packet = await packetFor(planning, stage);
    eventCount = decide(planning.d.store.load(planning.d.room), { type: "activity_operation", actor: "$system", id: "preview", packet }).events.length;
    assert.ok(eventCount > 0);
  } finally { planning.cleanup(); }
  for (const boundary of [...boundaries, ...Array.from({ length: eventCount }, (_, n) => `after_event:${n}`)]) {
    const h = await operationRoom();
    try {
      const packet = await packetFor(h, stage), key = operationKey(packet.capabilityId, packet.intent.clientId);
      const command: Command = { type: "activity_operation", actor: "$system", id: `activity-operation:${hash(canonicalJSON(key))}`, packet };
      const before = h.d.store.load(h.d.room), expected = decide(before, command), marker = join(h.d.dir, `killed-${stage}-${boundary.replace(":", "-")}`);
      const outcome = await worker({ path: h.d.path, room: h.d.room, command, fault: boundary, marker });
      assert.equal(outcome.signal, "SIGKILL", `${stage}/${boundary}: ${outcome.stdout} ${outcome.stderr}`); assert.ok(existsSync(marker)); killed++;
      h.d.reopen(); const log = h.d.store.load(h.d.room);
      assert.ok(log.length === before.length || log.length === before.length + expected.events.length, "no partial event/effect batch");
      assert.deepEqual(log, log.length === before.length ? before : [...before, ...expected.events]);
      assert.deepEqual(h.d.p, fold(log)); h.d.parity();
      // Recover through the public command API itself, including aftercommit loss.
      // Raw activity receipt replay alone must not conceal an execute regression.
      const publicRetry = h.d.store.execute(h.d.room, command);
      assert.equal(publicRetry.replayed, log.length !== before.length);
      assert.equal(publicRetry.expectedSeq, expected.expectedSeq);
      assert.deepEqual(publicRetry.events, expected.events);
      const publicHead = h.d.store.load(h.d.room).length;
      for (const recovery of ["warm", "cold"] as const) {
        if (recovery === "cold") h.d.reopen();
        const recovered = h.d.store.execute(h.d.room, command);
        assert.equal(recovered.replayed, true); assert.equal(recovered.expectedSeq, expected.expectedSeq);
        assert.deepEqual(recovered.events, expected.events); assert.equal(recovered.head, publicHead);
        assert.equal(h.d.store.load(h.d.room).length, publicHead);
      }
      const retry = h.d.store.commitActivity(h.d.room, packet), frozen = retry.receipt.responseJSON;
      const committed = h.d.store.load(h.d.room).length;
      assert.equal(h.d.store.commitActivity(h.d.room, packet).receipt.responseJSON, frozen);
      assert.equal(h.d.store.load(h.d.room).length, committed); h.d.store.rebuild(h.d.room); h.d.parity();
      h.source.disabled = true;
      const replay = await new (h.protocol.constructor as typeof import("../../src/engine/protocol.ts").EngineLocalProtocol)(h.d.store, h.source.adapter)
        .handle(h.d.room, new Request("http://fault-simulation.invalid/activities", { method: "POST", headers: {
          authorization: h.initial.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent: packet.intent, itemId: "pruned-original-call" }) }));
      assert.equal(replay.status, 200); assert.equal(await replay.text(), frozen); assert.equal(h.d.store.load(h.d.room).length, committed);
      assert.equal(h.d.p.activities.get("X")!.status, stage === "result" ? "done" : "pending");
      assert.equal(h.d.p.requests.get("A")!.state, "open");
    } finally { h.cleanup(); }
  }
  assert.equal(killed, boundaries.length + eventCount);
  t.diagnostic(`${stage}: ${killed} actual SIGKILL cases; ${eventCount} separately tested event positions; ${boundaries.join(",")}`);
});

test("U tool.closed real SIGKILL: retained original outcome/payload/exposure and invocation-only hold settlement are atomic", async (t) => {
  let killed = 0;
  // Closure emits one evidence record and only its own original invocation settlements.
  const points = [...boundaries, "after_event:0", "after_event:1"];
  for (const boundary of points) {
    const h = await operationRoom();
    try {
      const item = h.source.addTool(h.initial.run, "actual-command", { type: "command_execution", input: "npm test -- focused",
        status: "completed", exitCode: 0, output: "Actual original output retained" });
      const source = await h.source.adapter.detail("thread:W", item.id), snapshot = await h.source.adapter.inspect("thread:W");
      assert.equal(h.x.observe(h.d.room, "W", await h.source.adapter.contract(), snapshot), true);
      const command: Command = { type: "close_tool", actor: "$system", id: "original-positive-closure", runId: h.initial.run.id,
        source, sequence: snapshot.sequence, sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
      const before = h.d.store.load(h.d.room), expected = decide(before, command);
      assert.equal(expected.events.length, 2);
      const marker = join(h.d.dir, `closure-${boundary.replace(":", "-")}`);
      const result = await worker({ path: h.d.path, room: h.d.room, command, fault: boundary, marker });
      assert.equal(result.signal, "SIGKILL", result.stdout + result.stderr); assert.ok(existsSync(marker)); killed++;
      h.d.reopen(); const log = h.d.store.load(h.d.room);
      assert.deepEqual(log, log.length === before.length ? before : [...before, ...expected.events]); h.d.parity();
      h.source.disabled = true; h.d.store.execute(h.d.room, command); const head = h.d.store.load(h.d.room).length;
      assert.equal(h.d.store.execute(h.d.room, command).replayed, true); assert.equal(h.d.store.load(h.d.room).length, head);
      assert.equal(h.d.p.toolClosures.size, 1); assert.equal(h.d.p.toolResults.size, 0);
      const closure = [...h.d.p.toolClosures.values()][0]!;
      assert.equal(closure.source.output, "Actual original output retained"); assert.deepEqual(closure.requestIds, ["A"]);
      assert.equal(h.d.p.requests.get("A")!.state, "open"); h.d.store.rebuild(h.d.room); h.d.parity();
    } finally { h.cleanup(); }
  }
  assert.equal(killed, points.length); t.diagnostic(`tool.closed: ${killed} actual SIGKILL cases; ${points.join(",")}`);
});
