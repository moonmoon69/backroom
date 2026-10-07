import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { canonicalJSON, resultDigest, sourceKey } from "../../src/engine/result.ts";
import type { ActivityV2Intent, OperationIntent, ToolView, DeclaredActivityView } from "../../src/engine/operation-types.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { OperationRoom } from "./operation-fixture.ts";

const structuredOutput = () => Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, `value_${i}`]));
function ordinary(v: OperationRoom, id: string, output: unknown) {
  const item = v.source.addTool(v.initial.run, id, { input: { query: "small structured metadata" }, output, status: "completed" });
  item.toolName = "native.metadata"; item.toolSource = { kind: "native", key: "native:metadata" };
  v.source.project(item);
  return item;
}
async function view(v: OperationRoom, clientId: string, offset = 0, nonce = `nonce:${clientId}`) {
  const intent = { ...v.intent(v.initial, clientId, "own_run_view", { offset }), nonce } as OperationIntent;
  const item = v.projectOperation(v.initial, intent, `view-item:${v.source.detailItems.size}`);
  const response = await v.call(v.initial, intent, item.id), text = await response.text();
  assert.equal(response.status, 200, text); assert.ok(Buffer.byteLength(text) < 8192);
  const body = JSON.parse(text) as { result: { view: ToolView[]; activities: DeclaredActivityView[] } };
  assert.ok(Buffer.byteLength(canonicalJSON(body.result.view)) <= 3500);
  assert.ok(Buffer.byteLength(canonicalJSON(body.result.activities)) <= 3500);
  v.source.completeTool(item, text); await v.x.tick(v.d.room, "W");
  return { intent, item, text, body };
}
function declared(v: OperationRoom, options: { clientGlyph?: string } = {}) {
  let serial = 0;
  return async (activityId: string, operation: ActivityV2Intent["operation"], extra: Record<string, unknown>) => {
    const i = ++serial, clientId = `c${i}`.padEnd(256, options.clientGlyph ?? "x");
    const raw = { schema: "backroom.activity.v2", provenance: "member_declared", operation, clientId,
      nonce: `n${i}`.padEnd(256, options.clientGlyph ?? "x"), originRunId: v.initial.run.id,
      activityId, activityGeneration: 1, ...extra } as ActivityV2Intent;
    const item = v.source.addTool(v.initial.run, `activity-call:${v.source.detailItems.size}`, { input: raw, operation });
    const body = JSON.stringify({ intent: raw, itemId: item.id }); assert.ok(Buffer.byteLength(body) < 8192);
    const response = await v.protocol.handle(v.d.room, new Request("http://view-bounds.invalid/activities", {
      method: "POST", headers: { authorization: v.initial.authorization, "content-type": "application/json" }, body,
    }));
    const text = await response.text(); assert.equal(response.status, 200, text);
    assert.ok(Buffer.byteLength(text) < 8192);
    v.source.completeTool(item, text); await v.x.tick(v.d.room, "W");
    return JSON.parse(text).receiptKey as string;
  };
}

test("R4 ordinary full entries retain existing evidence and declaration fields when they fit", async () => {
  const v = await operationRoom();
  try {
    const item = ordinary(v, "ordinary-small", "Exact small original result"); await v.x.tick(v.d.room, "W");
    const source = await v.source.adapter.detail("thread:W", item.id), call = declared(v);
    const registrationReceiptKey = await call("X", "register_activity", { requestIds: ["A"], nativeId: null });
    const nativeHandle = { namespace: "process", value: "original-opaque-handle" };
    const bindingReceiptKey = await call("X", "bind_activity", { registrationReceiptKey, nativeHandle, originalSourceRef: null });
    const unavailableReason = "No original native result reference exists for this opaque handle";
    const resultReceiptKey = await call("X", "record_activity_result", { bindingReceiptKey, completion: "done",
      body: "Original declared result", resultRef: null, unavailableReason });
    const out = await view(v, "full-view"), [tool] = out.body.result.view, [activity] = out.body.result.activities;
    assert.ok(tool && activity); assert.equal(tool.closureKey, sourceKey(source)); assert.equal(tool.digest, resultDigest(source));
    assert.equal(Object.hasOwn(tool, "availabilitySummary"), false);
    assert.deepEqual(tool.availability, v.d.p.toolClosures.get(sourceKey(source))!.evidence.availability);
    assert.equal(activity.registrationReceiptKey, registrationReceiptKey); assert.equal(activity.bindingReceiptKey, bindingReceiptKey);
    assert.equal(activity.resultReceiptKey, resultReceiptKey); assert.deepEqual(activity.nativeHandle, nativeHandle);
    assert.equal(activity.unavailableReason, unavailableReason); assert.equal(activity.originalResultRef, null);
    assert.equal(Object.hasOwn(activity, "detailSummary"), false); v.d.parity();
  } finally { v.cleanup(); }
});

test("R4 actual HTTP 1741B structured result remains visible with exact strict digest and original field-map reference", async () => {
  const v = await operationRoom();
  try {
    const output = structuredOutput(); assert.equal(Buffer.byteLength(JSON.stringify(output)), 1741);
    const item = ordinary(v, "ordinary-structured", output); await v.x.tick(v.d.room, "W");
    const original = await v.source.adapter.detail("thread:W", item.id), key = sourceKey(original), digest = resultDigest(original);
    const closure = v.d.p.toolClosures.get(key)!; assert.equal(closure.evidence.outcome, "done");
    const frozen = canonicalJSON(closure), out = await view(v, "view-structured");
    const [entry] = out.body.result.view;
    assert.ok(entry); assert.equal(entry.itemId, item.id); assert.equal(entry.closed, true); assert.equal(entry.outcome, "done");
    assert.equal(entry.digest, digest); assert.equal(entry.availabilitySummary?.mode, "top_level_and_counts");
    assert.equal(entry.availabilitySummary.fieldCount, Object.keys(closure.evidence.availability).length);
    const actualCounts = { complete: 0, partial: 0, omitted: 0, unavailable: 0 };
    for (const field of Object.values(closure.evidence.availability)) actualCounts[field.status]++;
    assert.deepEqual(entry.availabilitySummary.statusCounts, actualCounts);
    const ref = entry.originalEvidenceRef!;
    assert.equal(ref.kind, "tool.closed"); assert.equal(ref.itemIdField, "itemId");
    assert.equal(JSON.stringify([ref.threadId, entry.itemId, ref.providerRunId, ref.generation]), key);
    assert.deepEqual(entry.availabilitySummary.detailsRef, { kind: "tool.closed", refField: "originalEvidenceRef" });
    assert.deepEqual(entry.page, { offset: 0, nextOffset: 1, total: 1 });
    assert.equal(canonicalJSON(v.d.p.toolClosures.get(key)), frozen);
    assert.equal(v.d.p.toolResults.size, 0, "a view never manufactures consumption");
    const reads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads], events = v.d.store.load(v.d.room).length;
    v.source.disabled = true;
    const replay = await v.call(v.initial, out.intent, out.item.id);
    assert.equal(await replay.text(), out.text); assert.equal(replay.status, 200);
    assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], reads);
    assert.equal(v.d.store.load(v.d.room).length, events); v.source.disabled = false;
    const consume = v.intent(v.initial, "consume-original-structured", "consume_tool_result", {
      toolRefs: [{ itemId: item.id, digest: entry.digest, requestIds: ["A"] }],
    });
    const call = v.projectOperation(v.initial, consume), response = await v.call(v.initial, consume, call.id);
    const text = await response.text(); assert.equal(response.status, 200, text);
    assert.equal(v.d.p.toolResults.get(key)!.digest, digest);
    assert.deepEqual(v.d.p.toolResults.get(key)!.source.output, output);
    assert.equal(canonicalJSON(v.d.p.toolClosures.get(key)), frozen); v.d.parity();
    v.d.reopen(); assert.equal(canonicalJSON(v.d.p.toolClosures.get(key)), frozen);
    const restartReads = [v.source.detailReads, v.source.snapshotReads, v.source.contractReads];
    v.source.disabled = true;
    const restarted = await new EngineLocalProtocol(v.d.store, v.source.adapter).handle(v.d.room,
      new Request("http://view-bounds.invalid/local", { method: "POST", headers: { authorization: v.initial.authorization,
        "content-type": "application/json" }, body: JSON.stringify({ intent: out.intent, itemId: out.item.id }) }));
    assert.equal(restarted.status, 200); assert.equal(await restarted.text(), out.text);
    assert.deepEqual([v.source.detailReads, v.source.snapshotReads, v.source.contractReads], restartReads);
    v.d.parity();
  } finally { v.cleanup(); }
});

for (const glyph of ["a", "未", "\u0000"])
  test(`R4 actual HTTP maximum declaration identity/handle and multibyte reason remain visible (${JSON.stringify(glyph)})`, async () => {
    const v = await operationRoom();
    try {
      const activityId = glyph.repeat(256), reason = "未".repeat(1024), handle = glyph.repeat(256);
      const call = declared(v, glyph === "未" ? { clientGlyph: "字" } : {});
      const registrationReceiptKey = await call(activityId, "register_activity", { requestIds: ["A"], nativeId: null });
      const bindingReceiptKey = await call(activityId, "bind_activity", { registrationReceiptKey,
        nativeHandle: { namespace: "process", value: handle }, originalSourceRef: null });
      await call(activityId, "record_activity_result", { bindingReceiptKey, completion: "done", body: "Declared original result",
        resultRef: null, unavailableReason: reason });
      const activity = v.d.p.activities.get(activityId)!; assert.equal(activity.status, "done");
      const frozen = canonicalJSON(activity.declaration), out = await view(v, glyph.repeat(256), 0, "finite-view-nonce");
      const [entry] = out.body.result.activities;
      assert.ok(entry); assert.equal(entry.activityId, activityId); assert.equal(entry.status, "done");
      assert.equal(entry.provenance, "member_declared"); assert.equal(entry.generation, 1);
      assert.equal(entry.availability, "reference_unavailable"); assert.equal(entry.correlation, "unverified");
      assert.equal(entry.detailSummary?.mode, "original_record_reference");
      assert.deepEqual(entry.detailSummary.originalEvidenceRef, { kind: "activity.declaration", keyField: "activityId" });
      assert.equal(entry.detailSummary.unavailableReason.present, true);
      assert.equal(entry.detailSummary.unavailableReason.utf8Bytes, 3072);
      assert.ok(entry.detailSummary.omittedFields.includes("nativeHandle"));
      assert.ok(entry.detailSummary.omittedFields.includes("unavailableReason"));
      assert.equal(Object.hasOwn(entry, "unavailableReason"), false, "summary never substitutes null for a present reason");
      assert.equal(Object.hasOwn(entry, "nativeHandle"), false, "summary does not fabricate an absent handle");
      assert.deepEqual(entry.page, { offset: 0, nextOffset: 1, total: 1 });
      assert.equal(canonicalJSON(v.d.p.activities.get(activityId)!.declaration), frozen);
      assert.equal(activity.declaration!.result!.unavailableReason, reason);
      assert.deepEqual(activity.declaration!.binding!.nativeHandle, { namespace: "process", value: handle });
      v.d.parity();
    } finally { v.cleanup(); }
  });

test("R4 tool pages preserve ordered offsets, all original entries and exact strict digests", async () => {
  const v = await operationRoom();
  try {
    const expected = Array.from({ length: 6 }, (_, i) => `ordinary-page:${i}`);
    for (const id of expected) ordinary(v, id, structuredOutput());
    await v.x.tick(v.d.room, "W");
    const frozen = canonicalJSON([...v.d.p.toolClosures.values()]), seen: string[] = [];
    let offset = 0, pages = 0;
    while (offset < expected.length) {
      const out = await view(v, `tool-page:${pages++}`, offset), entries = out.body.result.view;
      assert.ok(entries.length > 0); assert.ok(entries.length <= 16);
      for (const [i, entry] of entries.entries()) {
        assert.equal(entry.itemId, expected[offset + i]); assert.equal(entry.closed, true); assert.equal(entry.outcome, "done");
        assert.deepEqual(entry.page, { offset: offset + i, nextOffset: offset + i + 1, total: expected.length });
        const original = await v.source.adapter.detail("thread:W", entry.itemId);
        assert.equal(entry.digest, resultDigest(original));
        seen.push(entry.itemId);
      }
      const next = entries.at(-1)!.page!.nextOffset; assert.ok(next > offset); offset = next;
    }
    assert.ok(pages > 1); assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, expected.length);
    const empty = await view(v, "empty-tool-page", expected.length); assert.deepEqual(empty.body.result.view, []);
    const atFour = await view(v, "offset-four", 4); assert.equal(atFour.body.result.view[0]!.itemId, expected[4]);
    assert.equal(canonicalJSON([...v.d.p.toolClosures.values()]), frozen);
    assert.equal(v.d.p.toolResults.size, 0); v.d.parity();
  } finally { v.cleanup(); }
});

test("R4 combined lists remain finite for escaped max client/IDs and paginate every declared original", async () => {
  const v = await operationRoom();
  try {
    const toolIds = ["\u0000".repeat(256), "ordinary-second"];
    for (const id of toolIds) ordinary(v, id, structuredOutput());
    await v.x.tick(v.d.room, "W");
    const call = declared(v), ids = Array.from({ length: 2 }, (_, i) => `${i}`.padEnd(256, "\u0000"));
    for (const id of ids) {
      const registrationReceiptKey = await call(id, "register_activity", { requestIds: ["A"], nativeId: null });
      const bindingReceiptKey = await call(id, "bind_activity", { registrationReceiptKey,
        nativeHandle: { namespace: "process", value: `process:${id}`.slice(0, 256) }, originalSourceRef: null });
      await call(id, "record_activity_result", { bindingReceiptKey, completion: "done", body: "Original declared result retained",
        resultRef: null, unavailableReason: "未".repeat(1024) });
    }
    const frozen = canonicalJSON(ids.map((id) => v.d.p.activities.get(id)!.declaration));
    let offset = 0, pages = 0; const seen: string[] = [];
    while (offset < ids.length) {
      const clientId = `v${pages}`.padEnd(256, "\u0000"), out = await view(v, clientId, offset, `finite-nonce:${pages++}`);
      const entries = out.body.result.activities; assert.ok(entries.length > 0);
      if (offset === 0) {
        assert.equal(out.body.result.view[0]!.itemId, toolIds[0]);
        assert.equal(out.body.result.view[0]!.digest, resultDigest(await v.source.adapter.detail("thread:W", toolIds[0]!)));
        assert.equal(out.body.result.view[0]!.originalEvidenceRef?.itemIdField, "itemId");
      }
      for (const [i, entry] of entries.entries()) {
        assert.equal(entry.activityId, ids[offset + i]); assert.equal(entry.status, "done");
        assert.equal(entry.provenance, "member_declared"); assert.ok(entry.detailSummary);
        assert.deepEqual(entry.page, { offset: offset + i, nextOffset: offset + i + 1, total: ids.length }); seen.push(entry.activityId);
      }
      const next = entries.at(-1)!.page!.nextOffset; assert.ok(next > offset); offset = next;
    }
    assert.ok(pages > 1); assert.deepEqual(seen, ids); assert.equal(new Set(seen).size, ids.length);
    const empty = await view(v, "empty-activity-page", ids.length); assert.deepEqual(empty.body.result.activities, []);
    assert.equal(canonicalJSON(ids.map((id) => v.d.p.activities.get(id)!.declaration)), frozen);
    assert.equal(v.d.p.toolResults.size, 0); v.d.parity();
  } finally { v.cleanup(); }
});

test("R4 bounded view preserves large text/image availability without manufacturing strict consumption", async () => {
  const v = await operationRoom();
  try {
    const image = { type: "image", mimeType: "image/png", width: 16, height: 16 };
    const text = "t".repeat(65536);
    ordinary(v, "large-original", text); ordinary(v, "image-original", image); await v.x.tick(v.d.room, "W");
    const frozen = canonicalJSON([...v.d.p.toolClosures.values()]), out = await view(v, "view-large-image");
    assert.deepEqual(out.body.result.view.map((x) => x.itemId), ["large-original", "image-original"]);
    for (const entry of out.body.result.view) {
      assert.equal(entry.closed, true); assert.equal(entry.outcome, "done"); assert.equal(entry.digest, "");
      assert.throws(() => resultDigest([...v.d.p.toolClosures.values()].find((x) => x.source.itemId === entry.itemId)!.source));
      const consume = v.intent(v.initial, `reject-consume:${entry.itemId}`, "consume_tool_result", {
        toolRefs: [{ itemId: entry.itemId, digest: "0".repeat(64), requestIds: ["A"] }],
      });
      const item = v.projectOperation(v.initial, consume), response = await v.call(v.initial, consume, item.id);
      assert.equal(response.status, 409, await response.text());
    }
    const closure = [...v.d.p.toolClosures.values()];
    assert.equal(closure.find((x) => x.source.itemId === "large-original")!.source.output, text);
    assert.deepEqual(closure.find((x) => x.source.itemId === "image-original")!.source.output, image);
    assert.equal((out.body.result.view[1]!.availability!['output.data'] as { status: string }).status, "omitted");
    assert.equal(canonicalJSON([...v.d.p.toolClosures.values()]), frozen); assert.equal(v.d.p.toolResults.size, 0); v.d.parity();
  } finally { v.cleanup(); }
});
