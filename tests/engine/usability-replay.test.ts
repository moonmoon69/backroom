import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalJSON } from "../../src/engine/result.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { Projection, RoomEvent } from "../../src/engine/types.ts";
import type { ActivityV2Intent } from "../../src/engine/operation-types.ts";

const accepted = "/tmp/backroom-p-sol-280/revision-v5/candidate";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifestPath = "/tmp/backroom-p-sol-280/final-p-handoff/source-manifest.json";
assert.equal(digest(readFileSync(manifestPath)), "f3ab6d5ff1395216d5b23b0b1386a57f20804532915dc4cd6b1c47167cc8310f");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
for (const [path, sha] of Object.entries(manifest)) assert.equal(digest(readFileSync(`${accepted}/${path}`)), sha);
const historical = await import(pathToFileURL(`${accepted}/src/engine/fold.ts`).href) as {
  emptyProjection: (log: RoomEvent[]) => Projection; applyEvent: (p: Projection, e: RoomEvent) => void };
const historicalHistory = await import(pathToFileURL(`${accepted}/src/engine/incremental.ts`).href) as {
  rememberEvent: (p: Projection, e: RoomEvent) => void };

/** Independent frozen P fold handles every retained event. Only the three approved new
 * event types are replayed here in a simple full-log reference, without importing U's
 * reducer, overlay, transitions or store decision machinery. */
function reference(log: RoomEvent[]): Projection {
  const p = historical.emptyProjection(log); p.toolClosures = new Map();
  for (const [index, e] of log.entries()) {
    assert.equal(e.seq, index + 1); const d = e.data;
    if (!["tool.closed", "activity.declared_bound", "activity.declared_result"].includes(d.kind)) historical.applyEvent(p, e);
    else { historicalHistory.rememberEvent(p, e); p.commandKeys.add(e.commandKey); }
    if (d.kind === "tool.closed") { assert.ok(!p.toolClosures.has(d.closure.key)); p.toolClosures.set(d.closure.key, structuredClone(d.closure)); }
    if (d.kind === "activity.declared_bound") {
      const a = p.activities.get(d.activityId)!; assert.ok(a.declaration && !a.declaration.binding);
      a.declaration.binding = structuredClone(d.binding);
    }
    if (d.kind === "activity.declared_result") {
      const a = p.activities.get(d.activityId)!; assert.ok(a.declaration?.binding && !a.declaration.result);
      assert.equal(a.declaration.binding.bindingReceiptKey, d.result.bindingReceiptKey); a.declaration.result = structuredClone(d.result);
    }
  }
  return p;
}
test("U full journal replay uses frozen P reducer plus explicit new-event reference, matching incremental/cold/suffix/rebuild and stored rows", async () => {
  const h = await operationRoom(); let serial = 0;
  const check = () => {
    const log = h.d.store.load(h.d.room), expected = reference(log); assert.deepEqual(h.d.p, expected);
    const db = new DatabaseSync(h.d.path);
    try {
      const actual = db.prepare("SELECT kind,id,value FROM engine_projection WHERE room=?").all(h.d.room) as { kind: string; id: string; value: string }[];
      for (const row of actual) if (expected[row.kind as keyof Projection] instanceof Map)
        assert.equal(row.value, canonicalJSON((expected[row.kind as keyof Projection] as Map<string, unknown>).get(row.id)));
      const expectedMaps = Object.entries(expected).filter(([, value]) => value instanceof Map && ![expected.sourceKeys].includes(value))
        .flatMap(([kind, value]) => [...value as Map<string, unknown>].map(([id]) => canonicalJSON([kind, id]))).sort();
      assert.deepEqual(actual.filter((r) => expected[r.kind as keyof Projection] instanceof Map).map((r) => canonicalJSON([r.kind, r.id])).sort(), expectedMaps);
      const owners = db.prepare("SELECT key,owner FROM engine_key WHERE room=? AND kind='declared-handle'").all(h.d.room);
      assert.deepEqual(JSON.parse(JSON.stringify(owners)), [...expected.activities.values()].filter((a) => a.declaration?.binding)
        .map((a) => ({ key: a.declaration!.binding!.ownershipKey, owner: a.id })));
    } finally { db.close(); }
    h.d.parity();
  };
  const call = async (operation: ActivityV2Intent["operation"], extra: Record<string, unknown>) => {
    const raw = { schema: "backroom.activity.v2", provenance: "member_declared", operation, clientId: `replay:${++serial}`,
      nonce: `nonce:${serial}`, originRunId: h.initial.run.id, activityId: "X", activityGeneration: 1, ...extra } as ActivityV2Intent;
    const item = h.source.addTool(h.initial.run, raw.clientId, { input: raw, operation });
    const response = await h.protocol.handle(h.d.room, new Request("http://replay-simulation.invalid/activities", { method: "POST",
      headers: { authorization: h.initial.authorization, "content-type": "application/json" }, body: JSON.stringify({ intent: raw, itemId: item.id }) }));
    const text = await response.text(); assert.equal(response.status, 200, text); check();
    h.source.completeTool(item, text); await h.x.tick(h.d.room, "W"); check();
    return JSON.parse(text).receiptKey as string;
  };
  try {
    check(); const registrationReceiptKey = await call("register_activity", { requestIds: ["A"], nativeId: null });
    const native = h.source.addTool(h.initial.run, "actual-command", { type: "command_execution", input: "npm test -- focused", status: "running", exitCode: 0 });
    await h.x.tick(h.d.room, "W"); check();
    const bindingReceiptKey = await call("bind_activity", { registrationReceiptKey, nativeHandle: { namespace: "provider_item", value: "native-item:actual-command" }, originalSourceRef: { itemId: native.id } });
    h.source.completeTool(native, JSON.stringify("x".repeat(65536))); await h.x.tick(h.d.room, "W"); check();
    await call("record_activity_result", { bindingReceiptKey, completion: "done", body: "Original evidence retained", resultRef: { itemId: native.id }, unavailableReason: null });
    h.d.reopen(); check(); h.d.store.rebuild(h.d.room); check();
    const { EngineStore } = await import("../../src/engine/store.ts"); const foreign = new EngineStore(h.d.path);
    try { foreign.execute(h.d.room, { type: "post", actor: "O", id: "foreign-u-suffix", intent: "note", body: "Complete valid U suffix" }); }
    finally { foreign.close(); }
    h.d.store.execute(h.d.room, { type: "post", actor: "O", id: "warm-after-u-suffix", intent: "note", body: "Known keys remain immutable" }); check();
  } finally { h.cleanup(); }
});
