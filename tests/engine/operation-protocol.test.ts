import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineStore } from "../../src/engine/store.ts";
import { EngineLocalProtocol } from "../../src/engine/protocol.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { canonicalJSON, resultDigest, sourceKey } from "../../src/engine/result.ts";
import { unread } from "../../src/engine/index.ts";
import type { ActivityV1Intent, OperationIntent, ToolRef } from "../../src/engine/operation-types.ts";
import type { Disposition } from "../../src/engine/types.ts";
import { operationRoom } from "./operation-fixture.ts";
import type { OperationContext, OperationRoom } from "./operation-fixture.ts";

/** Every native projection/RPC in this file is simulated locally, not provider-run evidence. */
async function invoke(v: OperationRoom, context: OperationContext, intent: OperationIntent, itemId = intent.clientId) {
  const item = v.projectOperation(context, intent, itemId), response = await v.call(context, intent, item.id);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return { item, text, result: JSON.parse(text) as { result: { recorded: true; view: { itemId: string; digest: string; status: string;
    closed?: boolean; closureKey?: string; outcome?: "done" | "failed"; availability?: Record<string, { status: string }>; limitations?: string[] }[];
    claims: { requestId: string; outcome: string }[] }; receipt: { clientId: string; intentDigest: string; resultDigest: string } } };
}
async function delivered(v: OperationRoom, context: OperationContext, intent: OperationIntent, itemId = intent.clientId) {
  const out = await invoke(v, context, intent, itemId);
  v.source.completeTool(out.item, out.text); await v.x.tick(v.d.room, "W");
  assert.equal(v.d.p.operationBindings.get(sourceKey(v.receipt(intent.clientId).packet.source))!.confirmed, true);
  return out;
}
const answer = (ids: string[]): Disposition => ({ kind: "answer", requestIds: ids });
const finish = (v: OperationRoom, context: OperationContext, clientId: string, ids = ["A"], extra: Record<string, unknown> = {}) =>
  v.intent(context, clientId, "finish", { toolRefs: [], body: `Explicit result ${clientId}`, disposition: answer(ids), ...extra });
/** Positive closure may clear a hold, but its original causal provenance remains journaled. */
function originalNativeHold(v: OperationRoom, id: string) {
  const hold = [...v.d.p.providerHolds.values()].find((h) => h.code === `native_activity:${id}`);
  assert.ok(hold, "the original native observation must remain durably represented even after closure");
  return hold;
}

test("R2 finite projected MCP own-view -> consume -> finish commits one answer without consuming its own future response", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, originalH = c.run.through;
    v.source.addTool(c.run, "pwd", { type: "command_execution", input: "pwd", output: "/simulation/project\n", status: "completed", exitCode: 0 });
    const view = await delivered(v, c, v.intent(c, "view", "own_run_view"));
    assert.deepEqual(view.result.result.view.map((r) => r.itemId), ["pwd"]);
    const ref: ToolRef = { itemId: "pwd", digest: view.result.result.view[0]!.digest, requestIds: ["A"] };
    assert.equal(ref.digest.length, 64);
    const consume = await delivered(v, c, v.intent(c, "consume", "consume_tool_result", { toolRefs: [ref] }));
    assert.equal(consume.result.result.recorded, true);
    const recorded = [...v.d.p.toolResults.values()];
    assert.equal(recorded.length, 1); assert.equal(recorded[0]!.source.output, "/simulation/project\n");
    assert.equal(recorded[0]!.source.exitCode, 0); assert.equal(recorded[0]!.through, originalH);
    v.d.request("B");
    const completed = await invoke(v, c, finish(v, c, "finish"));
    assert.deepEqual(completed.result.result.claims, [{ requestId: "A", outcome: "answered", returnTo: "O" }]);
    assert.equal(v.source.native(c.run).id, v.d.p.runs.get(c.run.id)!.providerRunId);
    assert.equal(v.source.detailItems.get("finish")!.status, "running");
    assert.equal(Object.hasOwn(v.source.detailItems.get("finish")!, "output"), false);
    assert.equal(v.d.p.requests.get("A")!.state, "answered");
    assert.equal(v.d.p.seats.get("W")!.activeRunId, c.run.id);
    assert.equal(v.d.p.seats.get("W")!.cursor, 0);
    assert.ok(v.held().some((h) => h.code.startsWith("own_delivery:") && h.scope === "reseat"));
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
    v.source.completeTool(completed.item, completed.text);
    v.source.endRun(c.run, answer(["A"]), "Later provider final body retained");
    await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.operationReceipts.size, 3); assert.equal(v.d.p.operationBindings.size, 3);
    assert.equal(v.d.p.toolResults.size, 1); assert.equal(v.claims().length, 1);
    assert.equal(v.d.p.runs.get(c.run.id)!.phase, "terminal");
    assert.equal(v.d.p.seats.get("W")!.cursor, originalH);
    assert.deepEqual(unread(v.d.p, "W").map((i) => i.eventId), ["B"]);
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "output" && e.data.body === "Later provider final body retained"));
    assert.equal(v.source.appRuns, 1);
    assert.equal(v.source.frames.filter((f) => f.tag === "orchestration.dispatchCommand").length, 1);
    assert.ok(v.source.detailReads >= 6, "ordinary and local results were actually fetched by getTurnItem");
    v.d.parity();
  } finally { v.cleanup(); }
});

test("G5 committed raw intent replays frozen bytes after restart and changed sequence with ALL provider reads disabled", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = finish(v, c, "lost-local-response");
    const first = await invoke(v, c, raw), receipt = v.receipt(raw.clientId);
    const evidence = canonicalJSON(receipt.packet), counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    const head = v.d.store.load(v.d.room).length;
    // Discard the delivered HTTP response: committed state is the only authority on retry.
    v.d.reopen(); v.source.snapshot.snapshotSequence += 50; v.source.disabled = true;
    const protocol = new EngineLocalProtocol(v.d.store, v.source.adapter);
    const replay = await protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
      method: "POST", headers: { authorization: c.authorization }, body: JSON.stringify({ intent: raw, itemId: "new-lagging-alias" }),
    }));
    assert.equal(replay.status, 200); assert.equal(await replay.text(), first.text);
    assert.equal(canonicalJSON(v.receipt(raw.clientId).packet), evidence);
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    assert.equal(v.d.store.load(v.d.room).length, head); assert.equal(v.claims().length, 1);
    assert.equal(v.d.p.operationReceipts.size, 1); assert.equal(v.source.appRuns, 1);
    assert.ok(v.held().some((h) => h.code.startsWith("own_delivery:")), "replaying receipt never proves a missing native response");
    const changed = { ...raw, body: "Changed raw intent under same client ID" };
    const rejected = await protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
      method: "POST", headers: { authorization: c.authorization }, body: JSON.stringify({ intent: changed, itemId: first.item.id }),
    }));
    assert.equal(rejected.status, 409);
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    assert.equal(v.d.store.load(v.d.room).length, head); v.d.parity();
  } finally { v.cleanup(); }
});

test("mandatory omission 1: concurrent HTTP raw-intent calls from TWO native aliases share ONE SQLite receipt and ONE effect", async () => {
  const v = await operationRoom(), secondStore = new EngineStore(v.d.path);
  try {
    const c = v.initial, raw = finish(v, c, "concurrent-finish");
    const one = v.projectOperation(c, raw, "native-alias:one"), two = v.projectOperation(c, raw, "native-alias:two");
    const other = new EngineLocalProtocol(secondStore, v.source.adapter);
    const secondRequest = new Request("http://backroom-simulation.invalid/local", { method: "POST", headers: { authorization: c.authorization },
      body: JSON.stringify({ intent: raw, itemId: two.id }) });
    const responses = await Promise.all([v.call(c, raw, one.id), other.handle(v.d.room, secondRequest)]);
    const texts = await Promise.all(responses.map((r) => r.text()));
    assert.deepEqual(responses.map((r) => r.status), [200, 200], texts.join("\n"));
    assert.equal(texts[0], texts[1]); assert.equal(v.d.p.operationReceipts.size, 1);
    assert.equal(v.claims().length, 1);
    assert.deepEqual([...v.d.p.operationBindings.values()].map((b) => b.source.itemId).sort(), [one.id, two.id].sort());
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "output").length, 1);
    v.source.completeTool(one, texts[0]!); v.source.completeTool(two, texts[1]!); await v.x.tick(v.d.room, "W");
    assert.equal([...v.d.p.operationBindings.values()].every((b) => b.confirmed), true);
    assert.equal(v.d.p.operationReceipts.size, 1); assert.equal(v.claims().length, 1); assert.equal(v.source.appRuns, 1);
    v.d.parity();
  } finally { secondStore.close(); v.cleanup(); }
});

test("mandatory omission 2: node-before-item exact alias clears only its invocation; ordinary closure and independent background remain separate", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = v.intent(c, "node-first", "own_run_view");
    const item = v.projectOperation(c, raw, "node-first-item", false);
    v.source.addTool(c.run, "unrelated-command", { type: "command_execution", input: "pwd", output: "/other\n", exitCode: 0, status: "completed" });
    v.source.snapshot.projection.providerThreads[0]!.pendingBackgroundTasks = [{ taskId: "unrelated-background" }];
    v.source.snapshot.snapshotSequence++;
    await v.x.tick(v.d.room, "W");
    assert.ok(v.held().some((h) => h.code === `native_activity:${item.nodeId}`));
    v.source.project(item);
    const response = await v.call(c, raw, item.id), text = await response.text();
    assert.equal(response.status, 200, text);
    for (const id of [item.id, String(item.nodeId)]) assert.equal(v.held().some((h) => h.code === `native_activity:${id}`), false);
    assert.equal(v.held().some((h) => h.code === "native_activity:unrelated-command"), false);
    assert.ok([...v.d.p.toolClosures.values()].some((r) => r.source.itemId === "unrelated-command" && r.evidence.retained.output === "/other\n"));
    assert.ok(v.d.p.providerObservations.get("W")!.pending.some((key) => key.includes("unrelated-background")));
    assert.ok(v.held().some((h) => h.code.startsWith("own_delivery:")));
    v.source.completeTool(item, text); await v.x.tick(v.d.room, "W");
    assert.equal(v.held().some((h) => h.code === `native_activity:${item.nodeId}`), false);
    assert.equal(v.held().some((h) => h.code === "native_activity:unrelated-command"), false);
    assert.ok(v.d.p.providerObservations.get("W")!.pending.some((key) => key.includes("unrelated-background")));
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict").length, 0, "genuine node-before-item source edges are not contradictions");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); v.d.parity();
  } finally { v.cleanup(); }
});

test("mandatory omission 3: changed native response AFTER confirmation is retained as durable conflict before quiescence/transfer", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = finish(v, c, "confirmed-finish"), original = await delivered(v, c, raw);
    v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
    const changed = { ...JSON.parse(original.text), changedBody: "Postconfirmation response body that must remain visible" };
    original.item.output = changed; original.item.updatedAt = "2026-10-07T04:01:00.000Z"; v.source.project(original.item);
    // No intervening tick: the transfer proof itself must import the conflict.
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
    const conflict = v.d.store.load(v.d.room).findLast((e) => e.data.kind === "provider.conflict");
    assert.ok(conflict && conflict.data.kind === "provider.conflict"); assert.deepEqual(conflict.data.source.output, changed);
    assert.match(conflict.data.code, /^own_response_conflict:/);
    assert.equal(v.receipt(raw.clientId).responseJSON, original.text);
    assert.equal(v.claims().length, 1); assert.equal(v.d.p.requests.get("A")!.state, "answered");
    assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
      owned: [], awaited: [], body: "reseat", evidence: "stale formerly-quiescent proof" }), /held|uncertain|provider/i);
    v.d.reopen(); assert.ok(v.held().some((h) => h.code.startsWith("own_response_conflict:"))); v.d.parity();
  } finally { v.cleanup(); }
});

for (const fault of ["missing_auth", "wrong_secret", "origin", "generation", "nonce", "provenance", "tool_name", "native_ref", "claimed_actor", "trusted_boolean", "extra_recorded", "source_item", "partial_history", "history_cursor", "version", "endpoint"] as const)
  test(`authenticated local intent/source rejects ${fault} with NO receipt/effects/claim`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, raw = finish(v, c, `reject:${fault}`), item = v.projectOperation(c, raw);
      let auth: string | null | undefined;
      if (fault === "missing_auth") auth = null;
      if (fault === "wrong_secret") auth = `${c.authorization.slice(0, -1)}${c.authorization.endsWith("a") ? "b" : "a"}`;
      if (fault === "origin") raw.originRunId = "unregistered-original-run";
      if (fault === "generation") v.source.snapshot.projection.attempts[0]!.attemptOrdinal = 2;
      if (fault === "nonce") item.input = { ...raw, nonce: "different-native-correlation-nonce" };
      if (fault === "provenance") item.toolSource = { key: "mcp:other-server", name: "Backroom", kind: "integration" };
      if (fault === "tool_name") item.toolName = "backroom-board.own_run_view";
      if (fault === "native_ref") item.nativeItemRef = { driver: "codex", nativeId: "wrong-original-source", strength: "strong" };
      if (fault === "claimed_actor") Object.assign(raw, { actor: "O" });
      if (fault === "trusted_boolean") Object.assign(raw, { trusted: true });
      if (fault === "extra_recorded") Object.assign(raw, { recorded: true });
      if (fault === "source_item") v.source.onDetail = () => ({ ...item, id: "foreign-item" });
      if (fault === "partial_history") v.source.snapshot.hasMoreHistory = true;
      if (fault === "history_cursor") v.source.snapshot.historyCursor = "older-history-unread";
      if (fault === "version") v.source.version = "unreviewed-provider-version";
      if (fault === "endpoint") v.source.environmentId = "foreign-environment";
      v.source.project(item);
      const response = await v.call(c, raw, item.id, auth === undefined ? {} : { authorization: auth });
      assert.equal(response.status, auth === undefined ? 409 : 401, await response.text());
      assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.operationBindings.size, 0);
      assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

test("tool name and generic recorded:true are never authority for automatic native activity consumption", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = finish(v, c, "unhandled-native-call");
    const item = v.projectOperation(c, raw);
    v.source.completeTool(item, JSON.stringify({ recorded: true, actor: "W", trusted: true }));
    v.source.endRun(c.run, answer(["A"]), "Native prose claims done"); await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.operationBindings.size, 0);
    assert.ok(v.held().some((h) => h.code === `native_activity:${item.id}`));
    assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); v.d.parity();
  } finally { v.cleanup(); }
});

test("own-operation receipt cannot be re-consumed as an ordinary result, and a matching native name has no recursive exemption", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, view = await delivered(v, c, v.intent(c, "own-view", "own_run_view"));
    const ordinaryDigest = resultDigest(await v.source.adapter.detail("thread:W", view.item.id));
    const raw = v.intent(c, "recursive-consume", "consume_tool_result", { toolRefs: [{ itemId: view.item.id, digest: ordinaryDigest, requestIds: ["A"] }] });
    const item = v.projectOperation(c, raw), response = await v.call(c, raw, item.id);
    assert.equal(response.status, 409); assert.equal(v.d.p.operationReceipts.size, 1);
    assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0); v.d.parity();
  } finally { v.cleanup(); }
});

for (const output of [null, "", " \n\t ", false, { finite: [null, false, "text", 42] }])
  test(`G6 actual ordinary detail with PRESENT ${JSON.stringify(output)} is retained losslessly and consumed once`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      v.source.addTool(c.run, "ordinary-json", { input: { query: "finite" }, output, status: "completed", operation: "external-tool" });
      const before = v.source.detailReads, view = await delivered(v, c, v.intent(c, "view-json", "own_run_view"));
      assert.ok(v.source.detailReads - before >= 4);
      const ref = { itemId: "ordinary-json", digest: view.result.result.view[0]!.digest, requestIds: ["A"] };
      await delivered(v, c, v.intent(c, "consume-json", "consume_tool_result", { toolRefs: [ref] }));
      assert.equal(v.d.p.toolResults.size, 1); assert.deepEqual([...v.d.p.toolResults.values()][0]!.source.output, output);
      assert.equal(v.held().some((h) => h.code === "native_activity:ordinary-json"), false); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const fault of ["transport_marker", "unserializable_marker", "recursive_image", "opaque_source", "summary", "oversize", "oversize_input", "image_input", "missing_output", "missing_exit_code", "wrong_exit_code", "detail_failure", "partial_detail", "unstable_output", "unstable_input"] as const)
  test(`G6 strict byte consumption remains unavailable for ${fault}; positive invocation closure is separate`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      const ordinary = v.source.addTool(c.run, "ordinary-unsupported", { type: "command_execution", input: "pwd", output: "/valid\n", exitCode: 0, status: "completed" });
      if (fault === "transport_marker") ordinary.output = "valid prefix [output truncated for transport]";
      if (fault === "unserializable_marker") ordinary.output = "Unserializable tool value";
      if (fault === "recursive_image") { ordinary.type = "dynamic_tool"; ordinary.input = {}; ordinary.output = { nested: [{ type: "image", data: "omitted", mimeType: "image/png" }] }; }
      if (fault === "opaque_source") { ordinary.type = "dynamic_tool"; ordinary.input = {}; ordinary.output = { source: "omitted bytes" }; }
      if (fault === "summary") ordinary.output = "[summary: compacted ordinary result]";
      if (fault === "oversize") ordinary.output = "x".repeat(8192);
      if (fault === "oversize_input") ordinary.input = "x".repeat(8192);
      if (fault === "image_input") { ordinary.type = "dynamic_tool"; ordinary.input = { nested: [{ type: "image", source: "omitted" }] }; }
      if (fault === "missing_output") delete ordinary.output;
      if (fault === "missing_exit_code") delete ordinary.exitCode;
      if (fault === "partial_detail") ordinary.partial = true;
      v.source.project(ordinary);
      if (fault === "detail_failure") v.source.onDetail = (id) => { if (id === ordinary.id) throw new Error("simulated detail failure"); return v.source.detailItems.get(id)!; };
      if (fault === "wrong_exit_code") v.source.onDetail = (id) => id === ordinary.id ? { ...ordinary, exitCode: 99 } : v.source.detailItems.get(id)!;
      if (fault === "unstable_output" || fault === "unstable_input") {
        let count = 0;
        v.source.onDetail = (id) => id === ordinary.id ? { ...ordinary, [fault === "unstable_input" ? "input" : "output"]: ++count % 2 ? "first" : "different" } : v.source.detailItems.get(id)!;
      }
      const view = await delivered(v, c, v.intent(c, `view:${fault}`, "own_run_view"));
      const positive = ["transport_marker", "unserializable_marker", "recursive_image", "opaque_source", "summary", "oversize", "missing_output", "partial_detail"].includes(fault);
      assert.equal(view.result.result.view.length, 1); assert.equal(view.result.result.view[0]!.itemId, ordinary.id);
      assert.equal(view.result.result.view[0]!.digest, "", "positive closure never supplies a synthetic strict byte digest");
      assert.equal(view.result.result.view[0]!.closed === true, positive);
      if (positive) {
        assert.equal(view.result.result.view[0]!.outcome, "done"); assert.ok(view.result.result.view[0]!.availability);
        const closed = [...v.d.p.toolClosures.values()].find((r) => r.source.itemId === ordinary.id)!;
        assert.ok(closed); if (Object.hasOwn(ordinary, "output")) assert.deepEqual(closed.evidence.retained.output, ordinary.output);
        assert.equal(v.held().some((h) => h.code === `native_activity:${ordinary.id}`), false);
      } else assert.ok(v.held().some((h) => h.scope === "work" && h.runId === c.run.id), "source/input/outcome/freshness uncertainty still holds original A");
      const f = await invoke(v, c, finish(v, c, `finish:${fault}`));
      assert.equal(f.result.result.claims[0]!.outcome, positive ? "answered" : "pending_activity");
      assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, positive ? 1 : 0);
      assert.equal(v.d.p.requests.get("A")!.state, positive ? "answered" : "open");
      const consume = v.intent(c, `strict-consume:${fault}`, "consume_tool_result", { toolRefs: [{ itemId: ordinary.id, digest: "0".repeat(64), requestIds: ["A"] }] });
      const consumeItem = v.projectOperation(c, consume), rejected = await v.call(c, consume, consumeItem.id);
      assert.equal(rejected.status, 409, "the OPTIONAL strict lossless byte-receipt API keeps its original guards");
      assert.equal(v.d.p.toolResults.size, 0);
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.ok(v.source.detailReads > 0); assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

test("failed/nonzero ordinary command retains exact code/body without inferring request success", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    v.source.addTool(c.run, "failed-command", { type: "command_execution", input: "failing-command", output: "Exact stderr/stdout\n", exitCode: 7, status: "failed" });
    const view = await delivered(v, c, v.intent(c, "view-failed-command", "own_run_view"));
    assert.equal(view.result.result.view[0]!.status, "failed");
    const ref = { itemId: "failed-command", digest: view.result.result.view[0]!.digest, requestIds: ["A"] };
    await delivered(v, c, v.intent(c, "consume-failed-command", "consume_tool_result", { toolRefs: [ref] }));
    const result = [...v.d.p.toolResults.values()][0]!;
    assert.equal(result.source.status, "failed"); assert.equal(result.source.exitCode, 7); assert.equal(result.source.output, "Exact stderr/stdout\n");
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
    await delivered(v, c, finish(v, c, "report-command-failure", [], { body: "Failed result recorded; work remains open", disposition: { kind: "progress", requestIds: ["A"] } }));
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0); v.d.parity();
  } finally { v.cleanup(); }
});

test("unread request refs cannot be attached to an ordinary result, and a failed packet commits no partial binding/result/claim", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    v.source.addTool(c.run, "scoped-command", { type: "command_execution", input: "pwd", output: "/scope\n", exitCode: 0, status: "completed" });
    const view = await delivered(v, c, v.intent(c, "view-scoped-result", "own_run_view"));
    v.d.request("B");
    const raw = finish(v, c, "misassociated-finish", ["A"], { toolRefs: [{ itemId: "scoped-command", digest: view.result.result.view[0]!.digest, requestIds: ["A", "B"] }] });
    const item = v.projectOperation(c, raw), response = await v.call(c, raw, item.id);
    assert.equal(response.status, 409); assert.equal(v.d.p.operationReceipts.size, 1);
    assert.equal(v.d.p.operationBindings.size, 1); assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0);
    assert.equal(v.held().some((h) => h.code === "native_activity:scoped-command"), false);
    assert.ok([...v.d.p.toolClosures.values()].some((r) => r.source.itemId === "scoped-command" && canonicalJSON(r.requestIds) === '["A"]'));
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.requests.get("B")!.state, "open"); v.d.parity();
  } finally { v.cleanup(); }
});

test("provider-native continuation needs explicit original activity authorization; original root credential cannot bind its calls", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, native = v.source.continuation(c.run), raw = finish(v, c, "unauthorized-native-continuation");
    const item = v.source.addTool(native, raw.clientId, { input: raw, operation: raw.operation });
    const response = await v.call(c, raw, item.id);
    assert.equal(response.status, 409); assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.operationBindings.size, 0);
    assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.throws(() => v.protocol.authorizeRun(v.d.room, c.run.id, { generation: 1, server: "backroom-board", nativeRunId: v.source.native(native).id }), /activity.*authorization|original activity/);
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("G2 row-only native child holds original A before output and through terminal/empty roster, while independent B still answers", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    v.source.snapshot.projection.subagents.push({ id: "row-only-child", threadId: "thread:W", runId: v.source.native(c.run).id,
      origin: "provider_native", status: "running" });
    v.source.snapshot.snapshotSequence++; await v.x.tick(v.d.room, "W");
    assert.ok(v.held().some((h) => h.code === "native_activity:row-only-child" && h.scope === "work" && h.requestIds?.includes("A")));
    const early = await delivered(v, c, finish(v, c, "row-child-before-output"));
    assert.equal(early.result.result.claims[0]!.outcome, "pending_activity");
    v.source.snapshot.projection.subagents[0]!.status = "completed"; v.source.snapshot.snapshotSequence++;
    v.source.endRun(c.run, { kind: "yield" }, "Root ends while original child's result is unrecorded"); await v.x.tick(v.d.room, "W");
    assert.ok(v.held().some((h) => h.code === "native_activity:row-only-child"));
    v.source.snapshot.projection.subagents = []; v.source.snapshot.snapshotSequence++; await v.x.tick(v.d.room, "W");
    assert.ok(v.held().some((h) => h.code === "native_activity:row-only-child"));
    v.d.request("B"); const next = await v.start();
    const independent = await delivered(v, next, finish(v, next, "row-child-independent-B", ["A", "B"]));
    assert.deepEqual(independent.result.result.claims.map((c) => [c.requestId, c.outcome]), [["A", "pending_activity"], ["B", "answered"]]);
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.requests.get("B")!.state, "answered");
    assert.equal(v.receipt("row-child-before-output").result.claims[0]!.outcome, "pending_activity");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); assert.equal(v.source.appRuns, 2); v.d.parity();
  } finally { v.cleanup(); }
});

for (const changed of ["correction", "cancellation", "pending_activity", "unread_child"] as const)
  test(`finish records explicit disposition/body but ${changed} fences the original answer without silent later upgrade`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      if (changed === "correction") v.d.add({ type: "correct", actor: "O", requestId: "A", body: "Unread original-request correction" });
      if (changed === "cancellation") v.d.add({ type: "cancel", actor: "O", requestId: "A" });
      if (changed === "pending_activity") v.d.add({ type: "activity_start", actor: "W", activityId: "registered-background", runId: c.run.id,
        requestIds: ["A"], status: "uncertain", generation: 1, nativeSource: { providerRunId: v.source.native(c.run).id, generation: 1, nativeId: "child-native" } });
      if (changed === "unread_child") v.d.add({ type: "request", actor: "W", id: "review-child", to: "V", parentId: "A", body: "Associated review remains pending" });
      const out = await invoke(v, c, finish(v, c, `fenced:${changed}`));
      assert.equal(out.result.result.claims[0]!.outcome, changed === "correction" ? "superseded" : changed === "cancellation" ? "late" : "pending_activity");
      assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "output" && e.data.body === `Explicit result fenced:${changed}`));
      v.source.completeTool(out.item, out.text); v.source.endRun(c.run, { kind: "yield" }, "Later root final"); await v.x.tick(v.d.room, "W");
      assert.equal(v.claims().length, 0); assert.equal(v.receipt(`fenced:${changed}`).result.claims[0]!.outcome, out.result.result.claims[0]!.outcome);
      assert.ok(unread(v.d.p, "W").some((i) => i.intent === "correction") || changed !== "correction"); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const controlResponse of ["accepted", "unknown"] as const)
  test(`G1/G4 ${controlResponse} original causal runtime control fences A across runs while independent B executes and answers`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, native = v.source.native(c.run);
      v.d.add({ type: "request", id: "Q", actor: "W", to: "O", parentId: "A", body: "Original runtime question",
        live: { runId: c.run.id, providerRequestId: "native-question" } });
      v.source.snapshot.projection.runtimeRequests.push({ id: "native-question", threadId: "thread:W", nodeId: native.rootId,
        status: "pending", responseCapability: { type: "live" }, kind: "user_input" });
      v.source.snapshot.snapshotSequence++; v.source.controlResponse = controlResponse;
      v.d.add({ type: "runtime_reply", id: "reply:Q", actor: "O", requestId: "Q", commandId: "control:original-Q", body: JSON.stringify({ answers: { choice: "continue" } }) });
      await v.x.tick(v.d.room, "W");
      assert.equal(v.d.p.controls.get("reply:Q")!.phase, controlResponse === "accepted" ? "accepted" : "uncertain");
      const first = await delivered(v, c, finish(v, c, "first-attempt-A"));
      assert.equal(first.result.result.claims[0]!.outcome, "pending_activity");
      v.source.endRun(c.run, { kind: "yield" }, "Yield pending original runtime effect"); await v.x.tick(v.d.room, "W");
      v.d.request("B"); const next = await v.start();
      const out = await delivered(v, next, finish(v, next, "independent-B", ["A", "B"]));
      assert.deepEqual(out.result.result.claims.map((c) => [c.requestId, c.outcome]), [["A", "pending_activity"], ["B", "answered"]]);
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.requests.get("B")!.state, "answered");
      v.source.endRun(next.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.equal(v.source.appRuns, 2);
      assert.equal(v.source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1, "uncertain controls are never blindly replayed");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A")));
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B") && h.code.includes("control")), false);
      v.d.parity();
    } finally { v.cleanup(); }
  });

test("passive progress, subscribed milestone and silent local finish use the board cursor without self-wake or acknowledgement output", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    const passive = await delivered(v, c, finish(v, c, "passive-progress", [], { disposition: { kind: "progress", requestIds: ["A"] }, body: "Working" }));
    assert.deepEqual(passive.result.result.claims, []); assert.equal(unread(v.d.p, "O").length, 0);
    v.d.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["review-ready"], enabled: true });
    const subscribed = await delivered(v, c, finish(v, c, "milestone", [], { disposition: { kind: "progress", requestIds: ["A"], milestone: "review-ready" }, body: "Review ready" }));
    assert.deepEqual(subscribed.result.result.claims, []);
    assert.deepEqual(unread(v.d.p, "O").map((i) => i.intent), ["progress"]);
    assert.deepEqual(unread(v.d.p, "W").map((i) => i.intent), ["request"]);
    await delivered(v, c, finish(v, c, "silent", [], { disposition: { kind: "silent" }, body: "" }));
    assert.equal(v.d.p.requests.get("A")!.state, "open"); v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal(unread(v.d.p, "W").length, 0);
    const o = v.d.reserve("O");
    v.d.add(v.d.outputCommand(o, { kind: "silent" }, { body: "" }));
    assert.equal(unread(v.d.p, "O").length, 0);
    assert.equal(v.d.add(v.d.reserveCommand("O")).outcome, "idle");
    assert.equal(v.d.add(v.d.reserveCommand("W")).outcome, "idle");
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("local error is visible and bounded; error-only recipient failure adds no reciprocal/self wake", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    await delivered(v, c, finish(v, c, "error", [], { disposition: { kind: "error", requestIds: ["A"] }, body: "Explicit simulated worker failure" }));
    v.source.endRun(c.run, { kind: "error", requestIds: [] }, "Provider failure final"); await v.x.tick(v.d.room, "W");
    assert.equal(unread(v.d.p, "W").length, 0); assert.equal(v.claims().length, 0);
    assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "notice" && e.data.intent === "error").length, 1);
    const o = v.d.reserve("O"); v.d.add(v.d.outputCommand(o, { kind: "error", requestIds: [] }, { body: "Recovery failed on error-only input" }));
    assert.equal(unread(v.d.p, "W").length, 0); assert.equal(unread(v.d.p, "O").length, 0);
    const head = v.d.store.load(v.d.room).length;
    for (let i = 0; i < 4; i++) await v.x.tick(v.d.room, "W");
    assert.equal(v.d.store.load(v.d.room).length, head); assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("retired seat capability cannot replay even an existing frozen receipt", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = finish(v, c, "retire-finish"), out = await delivered(v, c, raw);
    v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    const proof = await v.x.quiescence(v.d.room, "W"); assert.equal(proof.proven, true);
    v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Retire original generation", evidence: proof.evidence });
    const counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    const response = await v.call(c, raw, out.item.id);
    assert.equal(response.status, 401); assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    assert.equal(v.claims().length, 1); v.d.parity();
  } finally { v.cleanup(); }
});

const activityIntent = (context: OperationContext, clientId: string, operation: ActivityV1Intent["operation"], extra: Record<string, unknown>) =>
  ({ schema: "backroom.activity.v1", operation, clientId, nonce: `nonce:${clientId}`, originRunId: context.run.id,
    activityId: "background:A", activityGeneration: 1, ...extra }) as ActivityV1Intent;
const activityCall = (v: OperationRoom, context: OperationContext, raw: ActivityV1Intent, itemId: string) =>
  v.protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/activities", {
    method: "POST", headers: { authorization: context.authorization }, body: JSON.stringify({ intent: raw, itemId }),
  }));
async function registerBackground(v: OperationRoom, context: OperationContext, nativeId: string | null = "native-item:background-result") {
  const raw = activityIntent(context, "register-background", "register_activity", { requestIds: ["A"], nativeId });
  const item = v.source.addTool(context.run, raw.clientId, { input: raw, operation: raw.operation });
  const response = await activityCall(v, context, raw, item.id), text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
  const binding = v.d.p.operationBindings.get(sourceKey([...v.d.p.activityReceipts.values()].find((r) => r.packet.intent.clientId === raw.clientId)!.packet.source))!;
  assert.equal(binding.receiptKind, "activity", "authenticated committed activity effects close only this original invocation");
  assert.equal(binding.confirmed, false, "committed effects do not prove native delivery");
  v.source.completeTool(item, text);
  await v.x.tick(v.d.room, "W");
  assert.equal(v.d.p.operationBindings.get(binding.key)!.confirmed, true);
  assert.equal(v.d.p.activities.get("background:A")!.status, "pending", "closing register's call never completes its activity");
  return { raw, item, text };
}

test("authenticated prelaunch activity registration and original recorded result are finite, atomic, and lifecycle alone never completes work", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    await registerBackground(v, c);
    const background = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "background-command", status: "completed",
      output: "Original stable background body\n", exitCode: 0 });
    await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
    const early = await delivered(v, c, finish(v, c, "before-result-registration"));
    assert.equal(early.result.result.claims[0]!.outcome, "pending_activity");
    const digest = resultDigest(await v.source.adapter.detail("thread:W", background.id));
    const raw = activityIntent(c, "record-background", "record_activity_result", { toolRef: { itemId: background.id, digest, requestIds: ["A"] },
      body: "Authenticated original background result body", disposition: answer(["A"]), completion: "done" });
    const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
    const response = await activityCall(v, c, raw, item.id), text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(v.d.p.activities.get("background:A")!.status, "done");
    assert.equal(v.d.p.activityReceipts.size, 2);
    assert.deepEqual(JSON.parse(text).claims.map((c: { outcome: string }) => c.outcome), ["pending_activity"], "the ordinary result-recording invocation still needs its own result consumed");
    const batch = v.d.store.load(v.d.room).filter((e) => e.commandKey.includes("activity-operation:") &&
      (e.data.kind === "activity.operation_receipt" && e.data.receipt.packet.intent.clientId === raw.clientId || e.data.kind === "activity.status" || e.data.kind === "tool.result" || e.data.kind === "output"));
    assert.ok(batch.some((e) => e.data.kind === "tool.result"));
    assert.ok(batch.some((e) => e.data.kind === "activity.status"));
    assert.ok(batch.some((e) => e.data.kind === "output"));
    assert.ok(batch.some((e) => e.data.kind === "activity.operation_receipt"));
    assert.equal(new Set(batch.map((e) => e.commandKey)).size, 1, "original result/effects/completion/receipt share one journal batch");
    v.source.completeTool(item, text);
    await v.x.tick(v.d.room, "W");
    assert.ok([...v.d.p.operationBindings.values()].some((b) => b.source.itemId === item.id && b.receiptKind === "activity" && b.confirmed));
    const final = await delivered(v, c, finish(v, c, "after-background-result"));
    assert.equal(final.result.result.claims[0]!.outcome, "answered");
    assert.equal(v.claims().length, 1);
    assert.equal(v.receipt("before-result-registration").result.claims[0]!.outcome, "pending_activity", "earlier finish is immutable");
    assert.ok([...v.d.p.toolResults.values()].some((r) => r.source.output === "Original stable background body\n"));
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "output" && e.data.body === "Authenticated original background result body"));
    v.source.endRun(c.run, answer(["A"]), "Background owner's later provider final retained"); await v.x.tick(v.d.room, "W");
    assert.equal(v.claims().length, 1); assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("activity receipt-first replay precedes changed source/detail reads and never duplicates registration", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = activityIntent(c, "raw-register-replay", "register_activity", { requestIds: ["A"], nativeId: null });
    const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
    const original = await activityCall(v, c, raw, item.id), text = await original.text(); assert.equal(original.status, 200, text);
    const head = v.d.store.load(v.d.room).length, counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    v.source.snapshot.snapshotSequence += 10; v.source.disabled = true;
    const replay = await activityCall(v, c, raw, "different-projected-alias");
    assert.equal(replay.status, 200); assert.equal(await replay.text(), text);
    assert.equal(v.d.p.activities.size, 1); assert.equal(v.d.p.activityReceipts.size, 1);
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    assert.equal(v.d.store.load(v.d.room).length, head);
    const changed = { ...raw, activityId: "changed-activity-under-same-client" };
    assert.equal((await activityCall(v, c, changed, item.id)).status, 409);
    assert.equal(v.d.store.load(v.d.room).length, head); v.d.parity();
  } finally { v.cleanup(); }
});

for (const fault of ["already_launched", "foreign_request", "wrong_generation", "claimed_actor", "wrong_provenance"] as const)
  test(`authenticated prelaunch register_activity rejects ${fault} without speculative activity/receipt/effects`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, raw = activityIntent(c, `registration:${fault}`, "register_activity", { requestIds: ["A"], nativeId: "native-item:background-result" });
      if (fault === "already_launched") v.source.addTool(c.run, "background-result", { type: "command_execution", input: "bg", status: "running" });
      if (fault === "foreign_request") Object.assign(raw, { requestIds: ["unregistered-request"] });
      if (fault === "wrong_generation") raw.activityGeneration = 2;
      if (fault === "claimed_actor") Object.assign(raw, { actor: "O", trusted: true });
      const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
      if (fault === "wrong_provenance") { item.toolSource = { kind: "integration", key: "mcp:unconfigured" }; v.source.project(item); }
      const response = await activityCall(v, c, raw, item.id);
      assert.equal(response.status, 409, await response.text());
      assert.equal(v.d.p.activities.size, 0); assert.equal(v.d.p.activityReceipts.size, 0);
      assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const fault of ["wrong_activity", "generation", "digest", "request_association", "result_origin", "result_native_ref", "lossy_result", "missing_detail"] as const)
  test(`authenticated original activity result rejects ${fault} with original activity and result unsettled`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial; await registerBackground(v, c);
      const background = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "background-command", output: "Original body\n", exitCode: 0, status: "completed" });
      const digest = resultDigest(await v.source.adapter.detail("thread:W", background.id));
      const raw = activityIntent(c, `record:${fault}`, "record_activity_result", { toolRef: { itemId: background.id, digest, requestIds: ["A"] }, body: "Retain declared result", disposition: answer(["A"]), completion: "done" });
      if (fault === "wrong_activity") raw.activityId = "wrong-activity";
      if (fault === "generation") raw.activityGeneration = 2;
      if (fault === "digest" && raw.operation === "record_activity_result") raw.toolRef.digest = "a".repeat(64);
      if (fault === "request_association" && raw.operation === "record_activity_result") raw.toolRef.requestIds = ["B"];
      if (fault === "result_origin") background.runId = "foreign-native-root";
      if (fault === "result_native_ref") {
        background.nativeItemRef = { driver: "codex", nativeId: "different-bg-native", strength: "strong" };
        v.source.snapshot.projection.nodes.find((n) => n.id === background.nodeId)!.nativeItemRef = background.nativeItemRef;
      }
      if (fault === "lossy_result") background.output = "[output truncated for transport]";
      v.source.project(background);
      const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
      if (fault === "missing_detail") v.source.onDetail = (id) => { if (id === background.id) throw new Error("simulated missing original result"); return v.source.detailItems.get(id)!; };
      const response = await activityCall(v, c, raw, item.id);
      assert.equal(response.status, 409, await response.text());
      assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
      assert.equal(v.d.p.activityReceipts.size, 1);
      assert.equal([...v.d.p.toolResults.values()].some((r) => r.source.itemId === background.id), false);
      assert.equal(v.claims().length, 0); v.d.parity();
    } finally { v.cleanup(); }
  });

test("explicit original activity continuation records late A result after independent B, without latest-run association", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial; await registerBackground(v, c);
    await delivered(v, c, finish(v, c, "original-yield", [], { body: "Waiting on registered background", disposition: { kind: "yield" } }));
    v.source.endRun(c.run, { kind: "yield" }, "Original root ended while activity remains pending"); await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
    v.d.request("B"); const next = await v.start();
    const b = await delivered(v, next, finish(v, next, "finish-independent-B", ["A", "B"]));
    assert.deepEqual(b.result.result.claims.map((c) => [c.requestId, c.outcome]), [["A", "pending_activity"], ["B", "answered"]]);
    v.source.endRun(next.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    const background = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "late background", output: "Late original A result\n", exitCode: 0, status: "completed" });
    const continuation = v.source.continuation(c.run);
    const auth = v.protocol.authorizeRun(v.d.room, c.run.id, { generation: 1, server: "backroom-board", activityId: "background:A", nativeRunId: v.source.native(continuation).id });
    const originalContext = { run: c.run, ...auth };
    const digest = resultDigest(await v.source.adapter.detail("thread:W", background.id));
    const raw = activityIntent(originalContext, "record-late-A", "record_activity_result", { toolRef: { itemId: background.id, digest, requestIds: ["A"] },
      body: "Late A body tied to original generation", disposition: answer(["A"]), completion: "done" });
    const item = v.source.addTool(continuation, raw.clientId, { input: raw, operation: raw.operation });
    const response = await activityCall(v, originalContext, raw, item.id), text = await response.text(); assert.equal(response.status, 200, text);
    assert.equal(v.d.p.activities.get("background:A")!.status, "done");
    assert.equal(v.d.p.activities.get("background:A")!.runId, c.run.id);
    v.source.completeTool(item, text);
    // The actual continuation's own result invocation closes through its authenticated
    // activity receipt, retaining the immutable original A run and request route.
    await v.x.tick(v.d.room, "W");
    assert.ok([...v.d.p.operationBindings.values()].some((b) => b.source.itemId === item.id && b.receiptKind === "activity" && b.confirmed));
    const finishIntent = finish(v, originalContext, "finish-late-A");
    const finishItem = v.source.addTool(continuation, finishIntent.clientId, { input: finishIntent, operation: finishIntent.operation });
    const late = await v.call(originalContext, finishIntent, finishItem.id), lateText = await late.text(); assert.equal(late.status, 200, lateText);
    assert.equal(JSON.parse(lateText).result.claims[0]!.outcome, "answered");
    v.source.completeTool(finishItem, lateText); await v.x.tick(v.d.room, "W");
    assert.deepEqual(v.claims().map((c) => c.requestId), ["B", "A"]);
    const originalResult = [...v.d.p.toolResults.values()].find((r) => r.source.itemId === background.id)!;
    assert.equal(originalResult.runId, c.run.id); assert.equal(originalResult.through, c.run.through);
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "output" && e.data.body === "Late A body tied to original generation" && e.data.association.kind === "activity"));
    assert.equal(v.source.appRuns, 2); assert.equal(v.d.p.runs.size, 2, "native wake never manufactured another board reservation");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false, "live native continuation delivery is still held");
    v.d.parity();
  } finally { v.cleanup(); }
});

for (const timing of ["before_registration", "after_registration"] as const)
  test(`review regression: ${timing} unrelated result cannot settle null-nativeId background by temporal/run association`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      const unrelated = () => v.source.addTool(c.run, "unrelated-pwd", { type: "command_execution", input: "pwd", output: "/unrelated\n", exitCode: 0, status: "completed" });
      let old: ReturnType<typeof unrelated> | undefined;
      if (timing === "before_registration") { old = unrelated(); await v.x.tick(v.d.room, "W"); }
      await registerBackground(v, c, null);
      if (timing === "after_registration") old = unrelated();
      const source = old; assert.ok(source);
      const digest = resultDigest(await v.source.adapter.detail("thread:W", source.id));
      const raw = activityIntent(c, `record-unrelated:${timing}`, "record_activity_result", {
        toolRef: { itemId: source.id, digest, requestIds: ["A"] }, body: "A claimed result from an unrelated ordinary invocation",
        disposition: answer(["A"]), completion: "done",
      });
      const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
      const response = await activityCall(v, c, raw, item.id), body = await response.text();
      assert.equal(response.status, 409, body);
      assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
      assert.equal(v.d.p.activityReceipts.size, 1);
      assert.equal([...v.d.p.toolResults.values()].some((r) => r.source.itemId === source.id), false);
      assert.equal(v.claims().length, 0);
      assert.equal(v.held().some((h) => h.code === `native_activity:${source.id}`), false, "unrelated coherent command closes only its own invocation");
      assert.ok([...v.d.p.toolClosures.values()].some((r) => r.source.itemId === source.id));
      v.d.parity();
    } finally { v.cleanup(); }
  });

for (const confirmed of [false, true]) for (const fault of ["missing", "unstable", "response_conflict"] as const)
  test(`review regression: ${fault} native own response after committed A has reseat-only holds and independent B proceeds; priorConfirmed=${confirmed}`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, raw = finish(v, c, "finished-A-response");
      const original = confirmed ? await delivered(v, c, raw) : await invoke(v, c, raw);
      assert.equal(v.d.p.requests.get("A")!.state, "answered");
      if (!confirmed) v.source.completeTool(original.item, original.text);
      if (fault === "missing") v.source.onDetail = (id) => { if (id === original.item.id) throw new Error("simulated missing committed operation response"); return v.source.detailItems.get(id)!; };
      if (fault === "unstable") {
        let reads = 0;
        v.source.onDetail = (id) => id === original.item.id ? { ...original.item, output: ++reads % 2 ? JSON.parse(original.text) : { changedBetweenDetailReads: true } } : v.source.detailItems.get(id)!;
      }
      if (fault === "response_conflict") {
        original.item.output = { ...JSON.parse(original.text), changedBody: "A's native response body changed after its durable effects" };
        v.source.project(original.item);
      }
      v.source.endRun(c.run, { kind: "yield" }, "Original root ends; its known local work is complete"); await v.x.tick(v.d.room, "W");
      assert.equal(v.d.p.runs.get(c.run.id)!.phase, "terminal");
      const oldHolds = v.held().filter((h) => h.runId === c.run.id);
      assert.ok(oldHolds.length > 0);
      assert.equal(oldHolds.every((h) => h.scope === "reseat" && h.requestIds?.length === 0), true,
        JSON.stringify(oldHolds.map((h) => ({ code: h.code, scope: h.scope, requestIds: h.requestIds }))));
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
        owned: [], awaited: [], body: "Delivery remains unsettled", evidence: "false quiescence proof" }), /held|uncertain|provider/i);
      v.d.request("B"); const next = await v.start();
      const b = await delivered(v, next, finish(v, next, "independent-B-response", ["B"]));
      assert.equal(b.result.result.claims[0]!.outcome, "answered");
      assert.deepEqual(v.claims().map((c) => c.requestId), ["A", "B"]);
      assert.equal(v.receipt(raw.clientId).responseJSON, original.text);
      if (fault === "response_conflict") {
        const conflict = v.d.store.load(v.d.room).findLast((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === original.item.id);
        assert.ok(conflict && conflict.data.kind === "provider.conflict");
        assert.deepEqual(conflict.data.source.output, original.item.output);
      }
      assert.equal(v.source.appRuns, 2);
      assert.equal(v.source.frames.filter((f) => f.payload.type === "message.dispatch").length, 2);
      v.d.parity();
    } finally { v.cleanup(); }
  });

test("review regression: accepted control phase and causal effect hold commit atomically before interruption/reopen or an HTTP claim", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, native = v.source.native(c.run);
    v.d.add({ type: "request", id: "Q-atomic", actor: "W", to: "O", parentId: "A", body: "Original causal runtime question",
      live: { runId: c.run.id, providerRequestId: "native-question-atomic" } });
    v.source.snapshot.projection.runtimeRequests.push({ id: "native-question-atomic", threadId: "thread:W", nodeId: native.rootId,
      status: "pending", responseCapability: { type: "live" }, kind: "user_input" });
    v.source.snapshot.snapshotSequence++;
    v.d.add({ type: "runtime_reply", id: "reply:atomic", actor: "O", requestId: "Q-atomic", commandId: "control:atomic", body: JSON.stringify({ answers: { choice: "continue" } }) });
    const originalExecute = v.d.store.execute.bind(v.d.store);
    let interrupted = false;
    v.d.store.execute = (room, command) => {
      const result = originalExecute(room, command);
      if (command.type === "control_phase" && command.phase === "accepted") { interrupted = true; throw new Error("simulated process interruption immediately after control acceptance commit"); }
      return result;
    };
    await assert.rejects(v.x.tick(v.d.room, "W"), /immediately after control acceptance commit/);
    v.d.store.execute = originalExecute; assert.equal(interrupted, true);
    assert.equal(v.d.p.controls.get("reply:atomic")!.phase, "accepted");
    const phase = v.d.store.load(v.d.room).findLast((e) => e.data.kind === "control.phase" && e.data.controlId === "reply:atomic" && e.data.phase === "accepted")!;
    const effect = v.d.store.load(v.d.room).findLast((e) => e.data.kind === "provider.hold" && e.data.hold.code === "control_effect:reply:atomic" && e.data.hold.held);
    assert.ok(effect, "the crash boundary cannot leave accepted with an absent causal effect hold");
    assert.equal(effect.commandKey, phase.commandKey, "phase and effect hold share the serialized SQLite batch");
    assert.ok(effect.data.kind === "provider.hold" && effect.data.hold.scope === "work" && effect.data.hold.requestIds?.includes("A"));
    v.d.reopen();
    const recoveredProtocol = new EngineLocalProtocol(v.d.store, v.source.adapter), recoveredX = new EngineReconciler(v.d.store, v.source.adapter);
    const raw = finish(v, c, "finish-during-control-gap"), item = v.projectOperation(c, raw);
    const response = await recoveredProtocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
      method: "POST", headers: { authorization: c.authorization }, body: JSON.stringify({ intent: raw, itemId: item.id }),
    })), body = await response.text(); assert.equal(response.status, 200, body);
    assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
    assert.equal(v.d.p.requests.get("A")!.state, "open");
    v.source.completeTool(item, body); v.source.endRun(c.run, { kind: "yield" }, "Originating root ended with unproven runtime effect"); await recoveredX.tick(v.d.room, "W");
    v.d.request("B"); const next = v.d.reserve("W", false); await recoveredX.prepareRun(v.d.room, next.id, { instanceId: "codex", model: "simulated-model" });
    const auth = recoveredProtocol.authorizeRun(v.d.room, next.id, { generation: 1, server: "backroom-board" });
    await recoveredX.tick(v.d.room, "W"); await recoveredX.tick(v.d.room, "W");
    const context = { run: next, ...auth }, final = finish(v, context, "finish-independent-B-after-gap", ["A", "B"]), finalItem = v.projectOperation(context, final);
    const finished = await recoveredProtocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
      method: "POST", headers: { authorization: auth.authorization }, body: JSON.stringify({ intent: final, itemId: finalItem.id }),
    })), finalBody = await finished.text(); assert.equal(finished.status, 200, finalBody);
    assert.deepEqual(JSON.parse(finalBody).result.claims.map((c: { requestId: string; outcome: string }) => [c.requestId, c.outcome]), [["A", "pending_activity"], ["B", "answered"]]);
    assert.equal(v.source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1);
    assert.equal((await recoveredX.quiescence(v.d.room, "W")).proven, false); v.d.parity();
  } finally { v.cleanup(); }
});

test("review regression: changed prior own source nonce is a durable causal conflict BEFORE the next HTTP finish can claim A", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, raw = v.intent(c, "prior-view-A", "own_run_view"), original = await delivered(v, c, raw);
    original.item.input = { ...raw, nonce: "changed-prior-source-nonce" }; v.source.project(original.item);
    const fin = finish(v, c, "finish-after-prior-source-change"), item = v.projectOperation(c, fin);
    const response = await v.call(c, fin, item.id), body = await response.text();
    assert.ok(response.status === 200 || response.status === 409, body);
    if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
    const conflict = v.d.store.load(v.d.room).findLast((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === original.item.id);
    assert.ok(conflict && conflict.data.kind === "provider.conflict", "the HTTP observation itself records the conflict, without a later reconciler tick");
    assert.deepEqual(conflict.data.source.input, original.item.input);
    assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("source_conflict")));
    assert.equal(v.receipt(raw.clientId).responseJSON, original.text);
    const counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    const replay = await v.call(c, raw, original.item.id); assert.equal(replay.status, 200); assert.equal(await replay.text(), original.text);
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    v.d.parity();
  } finally { v.cleanup(); }
});

test("review paired positive: host binds null-nativeId activity before launch; only exact original native ID/generation/result settles it", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial; await registerBackground(v, c, null);
    await v.protocol.bindActivity(v.d.room, "background:A", { nativeId: "native-item:background-result", generation: 1 });
    assert.equal(v.d.p.activities.get("background:A")!.nativeSource!.nativeId, "native-item:background-result");
    const nativeBinding = v.d.store.load(v.d.room).filter((e) => e.data.kind === "activity.native_bound");
    assert.equal(nativeBinding.length, 1);
    const background = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "host-bound-background", output: "Exact host-bound result\n", exitCode: 0, status: "completed" });
    const digest = resultDigest(await v.source.adapter.detail("thread:W", background.id));
    const raw = activityIntent(c, "record-host-bound-background", "record_activity_result", {
      toolRef: { itemId: background.id, digest, requestIds: ["A"] }, body: "Original host-bound result body", disposition: answer(["A"]), completion: "done",
    });
    const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
    const response = await activityCall(v, c, raw, item.id), body = await response.text(); assert.equal(response.status, 200, body);
    assert.equal(v.d.p.activities.get("background:A")!.status, "done");
    assert.equal(v.d.p.activityReceipts.size, 2);
    assert.ok([...v.d.p.toolResults.values()].some((r) => r.source.itemId === background.id && r.source.output === "Exact host-bound result\n"));
    v.source.completeTool(item, body);
    await v.x.tick(v.d.room, "W");
    assert.ok([...v.d.p.operationBindings.values()].some((b) => b.source.itemId === item.id && b.receiptKind === "activity" && b.confirmed));
    const final = await delivered(v, c, finish(v, c, "finish-host-bound-background"));
    assert.equal(final.result.result.claims[0]!.outcome, "answered"); assert.equal(v.claims().length, 1); v.d.parity();
  } finally { v.cleanup(); }
});

for (const fault of ["already_observed", "observed_then_removed", "wrong_generation", "rebind", "reuse"] as const)
  test(`review paired negative: host activity binding rejects ${fault} without replacing an immutable original binding`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial; await registerBackground(v, c, null);
      let target = "background:A", nativeId = "native-item:background-result", generation = 1;
      if (fault === "already_observed" || fault === "observed_then_removed") {
        const launched = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "already-launched", output: "unrelated", exitCode: 0, status: "completed" });
        await v.x.tick(v.d.room, "W");
        if (fault === "observed_then_removed") {
          v.source.snapshot.projection.turnItems = v.source.snapshot.projection.turnItems.filter((r) => r.id !== launched.id);
          v.source.snapshot.projection.nodes = v.source.snapshot.projection.nodes.filter((r) => r.id !== launched.nodeId);
          v.source.snapshot.snapshotSequence++;
        }
      }
      if (fault === "wrong_generation") generation = 2;
      if (fault === "rebind" || fault === "reuse") {
        await v.protocol.bindActivity(v.d.room, target, { nativeId, generation: 1 });
        if (fault === "rebind") nativeId = "changed-native-identity";
        if (fault === "reuse") {
          const second = { ...activityIntent(c, "register-second-null-activity", "register_activity", { requestIds: ["A"], nativeId: null }), activityId: "background:second" } as ActivityV1Intent;
          const item = v.source.addTool(c.run, second.clientId, { input: second, operation: second.operation });
          const response = await activityCall(v, c, second, item.id); assert.equal(response.status, 200, await response.text());
          target = second.activityId;
        }
      }
      const bindingEvents = v.d.store.load(v.d.room).filter((e) => e.data.kind === "activity.native_bound").length;
      await assert.rejects(v.protocol.bindActivity(v.d.room, target, { nativeId, generation }), /activity|native|binding|generation/i);
      assert.equal(v.d.store.load(v.d.room).filter((e) => e.data.kind === "activity.native_bound").length, bindingEvents);
      assert.equal(v.d.p.activities.get(target)!.nativeSource!.nativeId, fault === "rebind" ? "native-item:background-result" : null);
      assert.equal(v.d.p.activities.get(target)!.status, "pending"); assert.equal(v.claims().length, 0); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const identity of ["nonce", "provenance", "root", "native_ref", "origin"] as const) for (const changedOutput of [false, true])
  test(`V2 review O1: prior own detail-race ${identity} is causal before finish; changedOutput=${changedOutput}`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, raw = v.intent(c, "detail-race-prior", "own_run_view"), original = await delivered(v, c, raw);
      const originalReceipt = canonicalJSON(v.receipt(raw.clientId)), originalDetail = v.source.adapter.detail.bind(v.source.adapter);
      let mutated = false;
      v.source.adapter.detail = async (thread, id) => {
        if (id === original.item.id && !mutated) {
          mutated = true;
          const node = v.source.snapshot.projection.nodes.find((n) => n.id === original.item.nodeId)!;
          if (identity === "nonce") original.item.input = { ...raw, nonce: "contradictory-nonce-during-real-detail-read" };
          if (identity === "provenance") original.item.toolSource = { kind: "integration", key: "mcp:foreign-server", name: "Foreign source" };
          if (identity === "root") node.rootNodeId = "different-native-root";
          if (identity === "native_ref") original.item.nativeItemRef = node.nativeItemRef = { driver: "codex", nativeId: "different-native-invocation", strength: "strong" };
          if (identity === "origin") original.item.threadId = "foreign-thread-origin";
          if (changedOutput) original.item.output = { ...JSON.parse(original.text), changedBody: "Contradictory body accompanies changed source identity" };
          v.source.project(original.item);
        }
        // This wrapper only schedules the real projection mutation; every detail
        // result comes from the unmodified HTTP adapter and actual simulated RPC.
        return originalDetail(thread, id);
      };
      const fin = finish(v, c, "finish-after-detail-race"), item = v.projectOperation(c, fin);
      const response = await v.call(c, fin, item.id), body = await response.text();
      assert.equal(mutated, true); assert.ok(response.status === 200 || response.status === 409, body);
      if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
      const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict" &&
        (e.data.source.itemId === original.item.id || e.data.source.nodeId === original.item.nodeId));
      assert.ok(conflicts.length, "identity found by detail is durably conflicted before the new finish commits");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
      assert.equal(canonicalJSON(v.receipt(raw.clientId)), originalReceipt);
      if (changedOutput && ["nonce", "provenance", "native_ref"].includes(identity))
        assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && Object.hasOwn(e.data.source, "output")
          && canonicalJSON(e.data.source.output) === canonicalJSON(original.item.output)), "actual changed detail body is retained with its identity conflict");
      const counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
      const replay = await v.call(c, raw, original.item.id); assert.equal(replay.status, 200); assert.equal(await replay.text(), original.text);
      assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const fault of ["missing", "unstable"] as const)
  test(`V2 review O1/F6 paired: ${fault} prior own response with unchanged identity permits A and later B; reseat stays held`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, raw = v.intent(c, "unchanged-prior-view", "own_run_view"), original = await delivered(v, c, raw);
      if (fault === "missing") v.source.onDetail = (id) => { if (id === original.item.id) throw new Error("unchanged source response unavailable"); return v.source.detailItems.get(id)!; };
      if (fault === "unstable") {
        let count = 0;
        v.source.onDetail = (id) => id === original.item.id ? { ...original.item, output: ++count % 2 ? JSON.parse(original.text) : { onlyResponseBodyUnstable: true } } : v.source.detailItems.get(id)!;
      }
      const done = await delivered(v, c, finish(v, c, "finish-with-unchanged-prior-response"));
      assert.equal(done.result.result.claims[0]!.outcome, "answered");
      v.source.endRun(c.run, { kind: "yield" }, "Known local work complete; response delivery remains uncertain"); await v.x.tick(v.d.room, "W");
      assert.equal(v.held().filter((h) => h.runId === c.run.id).every((h) => h.scope === "reseat" && h.requestIds?.length === 0), true);
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Unsettled delivery", evidence: "unproven" }), /held|uncertain|provider/i);
      v.d.request("B"); const next = await v.start(); const b = await delivered(v, next, finish(v, next, "finish-B-after-unchanged-prior", ["B"]));
      assert.equal(b.result.result.claims[0]!.outcome, "answered"); assert.deepEqual(v.claims().map((c) => c.requestId), ["A", "B"]);
      assert.equal(v.source.appRuns, 2); v.d.parity();
    } finally { v.cleanup(); }
  });

async function recordedSource(v: OperationRoom, kind: "ordinary" | "own") {
  const c = v.initial;
  if (kind === "own") {
    const original = await delivered(v, c, v.intent(c, "classified-own", "own_run_view"));
    return { item: original.item, frozen: () => canonicalJSON(v.receipt("classified-own")), original: canonicalJSON(v.receipt("classified-own")) };
  }
  const item = v.source.addTool(c.run, "classified-ordinary", { type: "command_execution", input: "pwd", output: "/immutable-original\n", exitCode: 0, status: "completed" });
  const digest = resultDigest(await v.source.adapter.detail("thread:W", item.id));
  await delivered(v, c, v.intent(c, "consume-classified-ordinary", "consume_tool_result", { toolRefs: [{ itemId: item.id, digest, requestIds: ["A"] }] }));
  const frozen = () => canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === item.id));
  return { item, frozen, original: frozen() };
}

const edgeChanges = ["unsupported_kind", "removed_root", "removed_thread", "removed_provider_thread", "removed_native_ref", "removed_run", "removed_turn",
  "retained_root", "retained_thread", "retained_provider_thread", "retained_native_ref", "retained_run", "retained_turn"] as const;
for (const kind of ["ordinary", "own"] as const) for (const change of edgeChanges)
  test(`V2 review O2/O3: classified ${kind} ${change} retains causal contradiction before HTTP claims and quiescence/transfer`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, prior = await recordedSource(v, kind), item = prior.item;
      const node = v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!;
      if (change === "unsupported_kind") { item.type = "file_change"; item.fileName = "contradictory.ts"; item.diffStr = "+changed-native-effect"; delete item.input; v.source.project(item); }
      else {
        if (change.startsWith("removed_")) v.source.snapshot.projection.turnItems = v.source.snapshot.projection.turnItems.filter((r) => r.id !== item.id);
        if (change.endsWith("_root")) node.rootNodeId = "contradictory-root";
        if (change.endsWith("_thread") && !change.endsWith("_provider_thread")) node.threadId = "contradictory-thread";
        if (change.endsWith("_provider_thread")) node.providerThreadId = "contradictory-provider-thread";
        if (change.endsWith("_native_ref")) node.nativeItemRef = { driver: "codex", nativeId: "contradictory-native-ref", strength: "strong" };
        if (change.endsWith("_run")) node.runId = "contradictory-native-run";
        if (change.endsWith("_turn")) node.providerTurnId = "contradictory-provider-turn";
        v.source.snapshot.snapshotSequence++;
      }
      const raw = finish(v, c, "finish-after-classified-edge-change"), final = v.projectOperation(c, raw), response = await v.call(c, raw, final.id), body = await response.text();
      assert.ok(response.status === 200 || response.status === 409, body);
      if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
      const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict" && (e.data.source.itemId === item.id || e.data.source.nodeId === item.nodeId));
      assert.ok(conflicts.length, "a previously classified item cannot disappear behind an unsupported type or contradictory node alias");
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
      assert.equal(prior.frozen(), prior.original, "original recorded result/receipt is immutable");
      v.source.completeTool(final, body); v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: [], body: "Contradictory native source", evidence: "unproven" }), /held|uncertain|provider|activity/i);
      assert.equal(prior.frozen(), prior.original); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const status of ["running", "failed", "completed"] as const) for (const outputPresent of [false, true])
  test(`V2 review O4: recorded ordinary status/exit contradiction fences work independently of output; status=${status}, outputPresent=${outputPresent}`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, prior = await recordedSource(v, "ordinary"), item = prior.item;
      item.status = status; if (status === "completed") item.exitCode = 7;
      if (status === "running") item.completedAt = null;
      if (!outputPresent) delete item.output;
      v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = status;
      v.source.project(item);
      const raw = finish(v, c, "finish-after-terminal-result-contradiction"), final = v.projectOperation(c, raw), response = await v.call(c, raw, final.id), body = await response.text();
      assert.ok(response.status === 200 || response.status === 409, body);
      if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0);
      assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === item.id));
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
      assert.equal(prior.frozen(), prior.original); assert.equal([...v.d.p.toolResults.values()].find((r) => r.source.itemId === item.id)!.source.exitCode, 0);
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const activeControl of ["reply-A", "different-A"] as const)
  test(`V2 review O5: obsolete reply control for B cannot steal causal scope from exact ${activeControl} control for A`, async () => {
    const v = await operationRoom(["A", "B"]);
    try {
      const c = v.initial, native = v.source.native(c.run);
      function question(id: string, parentId: string, status: string, controlId: string) {
        v.d.add({ type: "request", id, actor: "W", to: "O", parentId, body: `Runtime question ${id}`, live: { runId: c.run.id, providerRequestId: `native-${id}` } });
        v.source.snapshot.projection.runtimeRequests.push({ id: `native-${id}`, threadId: "thread:W", nodeId: native.rootId, status, responseCapability: { type: "live" }, kind: "user_input" });
        v.source.snapshot.snapshotSequence++;
        v.d.add({ type: "runtime_reply", id: controlId, actor: "O", requestId: id, commandId: `command-${id}`, body: JSON.stringify({ answers: { choice: "continue" } }) });
      }
      question("QB-prefix", "B", "resolved", "reply"); await v.x.tick(v.d.room, "W");
      assert.equal(v.d.p.controls.get("reply")!.phase, "obsolete");
      question("QA-prefix", "A", "pending", activeControl); v.source.controlResponse = "unknown"; await v.x.tick(v.d.room, "W");
      assert.equal(v.d.p.controls.get(activeControl)!.phase, "uncertain");
      const relevant = v.held().filter((h) => h.code === `unknown:control:${activeControl}`);
      assert.equal(relevant.length, 1); assert.equal(relevant[0]!.scope, "work");
      assert.deepEqual(relevant[0]!.requestIds?.slice().sort(), ["QA-prefix", "A"].sort());
      const done = await delivered(v, c, finish(v, c, "finish-prefix-control-AB", ["A", "B"]));
      assert.deepEqual(done.result.result.claims.map((c) => [c.requestId, c.outcome]), [["A", "pending_activity"], ["B", "answered"]]);
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.requests.get("B")!.state, "answered");
      assert.equal(v.source.frames.filter((f) => f.payload.type === "runtime-request.respond").length, 1);
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const identity of ["nonce", "provenance", "root", "native_ref", "origin"] as const) for (const changedOutput of [false, true])
  test(`V2 review O1/O3 paired ordinary: detail-race ${identity} is causal before finish; changedOutput=${changedOutput}`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      const item = v.source.addTool(c.run, "ordinary-detail-race", { input: { nonce: "original-ordinary-nonce" }, output: { answer: "exact original ordinary body" }, status: "completed", operation: "external-finite-tool" });
      const digest = resultDigest(await v.source.adapter.detail("thread:W", item.id));
      await delivered(v, c, v.intent(c, "consume-before-detail-race", "consume_tool_result", { toolRefs: [{ itemId: item.id, digest, requestIds: ["A"] }] }));
      const frozen = canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === item.id));
      const originalDetail = v.source.adapter.detail.bind(v.source.adapter); let mutated = false;
      v.source.adapter.detail = async (thread, id) => {
        if (id === item.id && !mutated) {
          mutated = true;
          const node = v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!;
          if (identity === "nonce") item.input = { nonce: "changed-ordinary-nonce" };
          if (identity === "provenance") item.toolSource = { kind: "integration", key: "mcp:changed-ordinary-source" };
          if (identity === "root") node.rootNodeId = "changed-ordinary-root";
          if (identity === "native_ref") item.nativeItemRef = node.nativeItemRef = { driver: "codex", nativeId: "changed-ordinary-native-ref", strength: "strong" };
          if (identity === "origin") item.threadId = "changed-ordinary-origin";
          if (changedOutput) item.output = { answer: "changed ordinary detail body" };
          v.source.project(item);
        }
        return originalDetail(thread, id);
      };
      const raw = finish(v, c, "finish-after-ordinary-detail-race"), final = v.projectOperation(c, raw), response = await v.call(c, raw, final.id), body = await response.text();
      assert.equal(mutated, true); assert.ok(response.status === 200 || response.status === 409, body);
      if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
      assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && (e.data.source.itemId === item.id || e.data.source.nodeId === item.nodeId)));
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
      assert.equal(canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === item.id)), frozen);
      v.d.parity();
    } finally { v.cleanup(); }
  });

async function consumedPair(v: OperationRoom) {
  const c = v.initial;
  const first = v.source.addTool(c.run, "coverage-first", { type: "command_execution", input: "pwd", output: "Immutable first result\n", status: "completed", exitCode: 0 });
  const second = v.source.addTool(c.run, "coverage-second", { type: "command_execution", input: "pwd", output: "Immutable second result\n", status: "completed", exitCode: 0 });
  const refs: ToolRef[] = [];
  for (const item of [first, second]) refs.push({ itemId: item.id, digest: resultDigest(await v.source.adapter.detail("thread:W", item.id)), requestIds: ["A"] });
  const consume = await delivered(v, c, v.intent(c, "coverage-consume", "consume_tool_result", { toolRefs: refs }));
  const original = canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === first.id));
  return { first, second, consume, original };
}

test("V3 review N1: later real detail cannot hide a changed earlier confirmed own body from quiescence or actual transfer", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial;
    const first = await delivered(v, c, v.intent(c, "coverage-view", "own_run_view"));
    const second = await delivered(v, c, finish(v, c, "coverage-finish"));
    v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    const priorProof = await v.x.quiescence(v.d.room, "W"); assert.equal(priorProof.proven, true);
    const frozen = canonicalJSON(v.receipt("coverage-view")), changed = { ...JSON.parse(first.text), changedBody: "Changed confirmed response after its detail and during a later real source read" };
    const realDetail = v.source.adapter.detail.bind(v.source.adapter); let earlierRead = false, mutated = false;
    const reads = v.source.detailReads;
    v.source.adapter.detail = async (thread, id) => {
      if (id === second.item.id && !mutated) {
        assert.equal(earlierRead, true, "the earlier source was already validated by the real adapter");
        mutated = true; first.item.output = changed; first.item.updatedAt = "2026-10-07T05:01:00.000Z"; v.source.project(first.item);
      }
      const full = await realDetail(thread, id); if (id === first.item.id) earlierRead = true; return full;
    };
    const proof = await v.x.quiescence(v.d.room, "W"); assert.equal(mutated, true);
    assert.equal(proof.proven, false, "a later refresh superseding an earlier response detail cannot establish quiescence");
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === first.item.id
      && Object.hasOwn(e.data.source, "output") && canonicalJSON(e.data.source.output) === canonicalJSON(changed)), "the changed real response body is durably retained");
    assert.equal(canonicalJSON(v.receipt("coverage-view")), frozen); assert.equal(v.claims().length, 1);
    assert.equal(v.held().some((h) => h.code.includes(first.item.id) && h.scope === "reseat"), true);
    assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
      owned: [], awaited: [], body: "Attempt transfer with formerly valid proof", evidence: priorProof.evidence }), /held|uncertain|provider/i);
    assert.equal(v.d.p.seats.get("W")!.status, "active"); assert.equal(v.d.p.seats.has("W2"), false);
    assert.ok(v.source.detailReads - reads <= 64, "source revalidation is bounded within this call");
    const counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    const replay = await v.call(c, v.intent(c, "coverage-view", "own_run_view"), first.item.id);
    assert.equal(replay.status, 200); assert.equal(await replay.text(), first.text);
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts, "raw receipt recovery still precedes source reads");
    v.d.reopen(); assert.ok(v.held().some((h) => h.code.includes(first.item.id))); v.d.parity();
  } finally { v.cleanup(); }
});

for (const timing of ["later_detail", "own_refresh"] as const) for (const change of ["body", "exit_code"] as const)
  test(`V3 review N1: recorded ordinary ${change} changed after detail at ${timing} fences fresh HTTP finish and retains originals`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, pair = await consumedPair(v);
      const realDetail = v.source.adapter.detail.bind(v.source.adapter); let earlierRead = false, mutated = false;
      const mutate = () => {
        assert.equal(earlierRead, true); mutated = true;
        if (change === "body") pair.first.output = "Changed original result after a previously successful real detail\n";
        else pair.first.exitCode = 7;
        pair.first.updatedAt = "2026-10-07T05:01:00.000Z"; v.source.project(pair.first);
      };
      const reads = v.source.detailReads;
      v.source.adapter.detail = async (thread, id) => {
        if (timing === "later_detail" && id === pair.second.id && !mutated) mutate();
        const full = await realDetail(thread, id);
        if (id === pair.first.id) { earlierRead = true; if (timing === "own_refresh" && !mutated) mutate(); }
        return full;
      };
      const raw = finish(v, c, "finish-after-stale-result-detail"), item = v.projectOperation(c, raw);
      const response = await v.call(c, raw, item.id), body = await response.text();
      assert.equal(mutated, true); assert.ok(response.status === 200 || response.status === 409, body);
      if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
      assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open");
      const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === pair.first.id);
      assert.ok(conflicts.length, "the refreshed ordinary revision/outcome is a causal contradiction before claims");
      if (change === "body") assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && e.data.source.output === pair.first.output), "changed body survives in the durable conflict");
      assert.equal(canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === pair.first.id)), pair.original);
      assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
      assert.ok(v.source.detailReads - reads <= 64, "there is no open-ended source retry");
      v.source.completeTool(item, body); v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, false);
      assert.throws(() => v.d.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
        owned: ["A"], awaited: [], body: "Transfer contradictory ordinary result", evidence: "unproven" }), /held|uncertain|provider|activity/i);
      v.d.store.rebuild(v.d.room); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const route of ["operation", "activity"] as const) for (const kind of ["own", "ordinary"] as const) for (const change of ["updated_at", "node_status"] as const)
  test(`V3 review N1 writer: second SQLite writer changes prior ${kind} ${change} at the same sequence before ${route} commit; no fresh effects`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      if (route === "activity") await registerBackground(v, c);
      const prior = await recordedSource(v, kind), before = {
        operations: v.d.p.operationReceipts.size, activities: v.d.p.activityReceipts.size, results: v.d.p.toolResults.size,
      };
      let injected = false;
      const inject = () => {
        const writer = new EngineStore(v.d.path);
        try {
          const observed = structuredClone(writer.project(v.d.room).providerObservations.get("W")!);
          const source = observed.sources!.find((s) => s.itemId === prior.item.id)!;
          assert.ok(source, "the fresh provider checkpoint contains the original classified source");
          if (change === "updated_at") source.updatedAt = "2026-10-07T05:02:00.000Z";
          else source.nodeStatus = "running";
          // A same-sequence competing observation is permitted by the store; its
          // source metadata must still invalidate a packet prepared before it.
          writer.execute(v.d.room, { type: "observe_provider", actor: "$system", id: `competing-prior:${route}:${kind}:${change}`,
            observation: observed, pending: observed.pending, settled: [] }); injected = true;
        } finally { writer.close(); }
      };
      let response: Response;
      if (route === "operation") {
        const commit = v.d.store.commitOperation.bind(v.d.store);
        v.d.store.commitOperation = (room, packet) => { inject(); return commit(room, packet); };
        const raw = finish(v, c, "finish-competing-prior-checkpoint"), item = v.projectOperation(c, raw);
        response = await v.call(c, raw, item.id);
      } else {
        const background = v.source.addTool(c.run, "background-result", { type: "command_execution", input: "Registered original activity", output: "Original activity detail\n", exitCode: 0, status: "completed" });
        const raw = activityIntent(c, "record-competing-prior-checkpoint", "record_activity_result", {
          toolRef: { itemId: background.id, digest: resultDigest(await v.source.adapter.detail("thread:W", background.id)), requestIds: ["A"] },
          body: "Original activity completion", disposition: answer(["A"]), completion: "done",
        });
        const item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation }), commit = v.d.store.commitActivity.bind(v.d.store);
        v.d.store.commitActivity = (room, packet) => { inject(); return commit(room, packet); };
        response = await activityCall(v, c, raw, item.id);
      }
      const body = await response.text(); assert.equal(injected, true); assert.equal(response.status, 409, body);
      assert.deepEqual({ operations: v.d.p.operationReceipts.size, activities: v.d.p.activityReceipts.size, results: v.d.p.toolResults.size }, before);
      assert.equal(v.claims().length, 0); assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(prior.frozen(), prior.original);
      if (route === "activity") assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
      v.d.parity();
    } finally { v.cleanup(); }
  });

for (const kind of ["own", "ordinary"] as const)
  test(`V3 review N1 paired: one newer ${kind} revision with identical body settles without a false conflict or endless reads`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial;
      const own = kind === "own" ? await delivered(v, c, v.intent(c, "revision-only-view", "own_run_view")) : null;
      const pair = kind === "ordinary" ? await consumedPair(v) : null;
      const first = own?.item ?? pair!.first;
      const second = pair?.second ?? (await delivered(v, c, v.intent(c, "revision-only-later-view", "own_run_view"))).item;
      const original = canonicalJSON(first.output), realDetail = v.source.adapter.detail.bind(v.source.adapter);
      let earlierRead = false, mutated = false; const reads = v.source.detailReads;
      v.source.adapter.detail = async (thread, id) => {
        if (id === second.id && !mutated) {
          assert.equal(earlierRead, true); mutated = true; first.updatedAt = "2026-10-07T05:01:00.000Z"; v.source.project(first);
        }
        const full = await realDetail(thread, id); if (id === first.id) earlierRead = true; return full;
      };
      const done = await delivered(v, c, finish(v, c, "finish-revision-only"));
      assert.equal(mutated, true); assert.equal(done.result.result.claims[0]!.outcome, "answered");
      assert.equal(canonicalJSON(first.output), original); assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict"), false);
      v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
      assert.ok(v.source.detailReads - reads <= 96, "a finite unchanged revision does not trigger perpetual reconciliation"); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const kind of ["own", "ordinary"] as const)
  test(`V3 review N1 bounded: ${kind} revision advancing after every real detail keeps only its required hold and stops reading`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, prior = await recordedSource(v, kind), realDetail = v.source.adapter.detail.bind(v.source.adapter);
      const reads = v.source.detailReads; let revisions = 0;
      v.source.adapter.detail = async (thread, id) => {
        const full = await realDetail(thread, id);
        // Real provider data becomes newer immediately after every actual detail;
        // no wrapper manufactures a source or result returned by the adapter.
        prior.item.updatedAt = `2026-10-07T05:03:${String(++revisions).padStart(2, "0")}.000Z`; v.source.project(prior.item);
        return full;
      };
      const done = await invoke(v, c, finish(v, c, "finish-unsettled-source-revisions"));
      assert.ok(revisions > 0); assert.ok(v.source.detailReads - reads <= 64, "unstable revisions cannot drive open-ended reads");
      assert.equal(done.result.result.claims[0]!.outcome, kind === "own" ? "answered" : "pending_activity");
      assert.equal(prior.frozen(), prior.original); assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict"), false);
      assert.ok(v.held().some((h) => h.code.includes(prior.item.id) && h.scope === (kind === "own" ? "reseat" : "work")), "an uncovered revision is delivery-only for committed own effects and original work for ordinary results");
      assert.equal(v.held().some((h) => kind === "own" && h.scope === "work" && h.requestIds?.includes("A")), false);
      const settledCounts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
      const replay = await v.call(c, finish(v, c, "finish-unsettled-source-revisions"), done.item.id);
      assert.equal(replay.status, 200); assert.equal(await replay.text(), done.text);
      assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], settledCounts, "the operation stops; receipt retry performs zero automatic provider work");
      v.d.parity();
    } finally { v.cleanup(); }
  });

for (const continuous of [false, true])
  test(`V3 review N1/N3 paired: consumed refs[A] in one A+B run keep B answerable when ordinary revision ${continuous ? "keeps advancing" : "advances once then stabilizes"}`, async () => {
    const v = await operationRoom(["A", "B"]);
    try {
      const c = v.initial, prior = await recordedSource(v, "ordinary"), realDetail = v.source.adapter.detail.bind(v.source.adapter);
      const recorded = [...v.d.p.toolResults.values()].find((r) => r.source.itemId === prior.item.id)!;
      assert.deepEqual(recorded.requestIds, ["A"]); assert.deepEqual(c.run.envelope.openRequests.map((q) => q.id), ["A", "B"]);
      let revisions = 0; const reads = v.source.detailReads;
      v.source.adapter.detail = async (thread, id) => {
        const full = await realDetail(thread, id);
        if (id === prior.item.id && (continuous || revisions === 0)) {
          prior.item.updatedAt = `2026-10-07T05:04:${String(++revisions).padStart(2, "0")}.000Z`; v.source.project(prior.item);
        }
        return full;
      };
      const raw = finish(v, c, "finish-fixed-result-AB", ["A", "B"]), done = await invoke(v, c, raw);
      assert.ok(revisions > 0); assert.ok(v.source.detailReads - reads <= 64);
      assert.deepEqual(done.result.result.claims.map((q) => [q.requestId, q.outcome]), [["A", continuous ? "pending_activity" : "answered"], ["B", "answered"]]);
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      if (continuous) {
        const held = v.held().find((h) => h.code === `recorded_result_revision:${prior.item.id}`)!;
        assert.ok(held); assert.equal(held.scope, "work"); assert.deepEqual(held.requestIds, ["A"]);
        assert.equal(v.d.p.requests.get("A")!.state, "open");
      } else assert.equal(v.d.p.requests.get("A")!.state, "answered");
      assert.equal(v.d.p.requests.get("B")!.state, "answered"); assert.equal(prior.frozen(), prior.original);
      assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict"), false);
      const counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads], replay = await v.call(c, raw, done.item.id);
      assert.equal(replay.status, 200); assert.equal(await replay.text(), done.text);
      assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const transplanted of [false, true])
  test(`V3 review N3: first-observed unconsumed native A origin remains fixed across later B${transplanted ? " transplant/restoration/rebuild/reopen" : " unchanged positive"}`, async () => {
    const v = await operationRoom();
    try {
      const a = v.initial;
      const ordinary = v.source.addTool(a.run, "unconsumed-origin-A", { type: "command_execution", input: "Original A work", output: "A result remains unconsumed", status: "completed", exitCode: 0 });
      await v.x.tick(v.d.room, "W");
      const originalHold = originalNativeHold(v, ordinary.id);
      assert.equal(originalHold.runId, a.run.id); assert.deepEqual(originalHold.requestIds, ["A"]); assert.equal(v.d.p.toolResults.size, 0);
      const originalClosure = [...v.d.p.toolClosures.values()].find((r) => r.source.itemId === ordinary.id)!;
      assert.ok(originalClosure); const frozenClosure = canonicalJSON(originalClosure);
      v.source.endRun(a.run, { kind: "yield" }, "A root ends with its original result still unconsumed"); await v.x.tick(v.d.room, "W");
      v.d.request("B"); const b = await v.start(), originalNode = v.source.snapshot.projection.nodes.find((n) => n.id === ordinary.nodeId)!;
      const originalEdges = { node: { runId: originalNode.runId, rootNodeId: originalNode.rootNodeId, parentNodeId: originalNode.parentNodeId, providerTurnId: originalNode.providerTurnId },
        item: { runId: ordinary.runId, providerTurnId: ordinary.providerTurnId } };
      if (transplanted) {
        const native = v.source.native(b.run);
        Object.assign(originalNode, { runId: native.id, rootNodeId: native.rootId, parentNodeId: native.rootId, providerTurnId: native.turnId });
        Object.assign(ordinary, { runId: native.id, providerTurnId: native.turnId }); v.source.project(ordinary);
      }
      const done = await delivered(v, b, finish(v, b, "finish-B-with-old-A-native", ["B"]));
      assert.equal(done.result.result.claims[0]!.outcome, "answered", "an old exact native ID cannot create a second causal association to B");
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.requests.get("B")!.state, "answered");
      assert.equal(originalNativeHold(v, ordinary.id).runId, a.run.id);
      assert.deepEqual(originalNativeHold(v, ordinary.id).requestIds, ["A"]);
      assert.equal(originalNativeHold(v, ordinary.id).held, transplanted, "coherent original invocation closes; visible transplant reopens only original A work uncertainty");
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      if (transplanted) {
        assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.runId === a.run.id
          && (e.data.source.itemId === ordinary.id || e.data.source.nodeId === ordinary.nodeId)), "origin transplant is retained against the original A run");
        Object.assign(originalNode, originalEdges.node); Object.assign(ordinary, originalEdges.item); v.source.project(ordinary);
        const retry = await delivered(v, b, finish(v, b, "finish-B-after-A-origin-restored", ["B"]));
        assert.equal(retry.result.result.claims[0]!.outcome, "already_answered");
      } else assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict"), false);
      v.d.store.rebuild(v.d.room); v.d.parity(); v.d.reopen();
      const x = new EngineReconciler(v.d.store, v.source.adapter), protocol = new EngineLocalProtocol(v.d.store, v.source.adapter);
      await x.tick(v.d.room, "W");
      const raw = finish(v, b, "finish-B-after-native-origin-rebuild", ["B"]), item = v.projectOperation(b, raw);
      const response = await protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
        method: "POST", headers: { authorization: b.authorization }, body: JSON.stringify({ intent: raw, itemId: item.id }),
      }));
      assert.equal(response.status, 200); const body = await response.text(); assert.equal(JSON.parse(body).result.claims[0]!.outcome, "already_answered");
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      assert.equal(originalNativeHold(v, ordinary.id).runId, a.run.id);
      assert.deepEqual(originalNativeHold(v, ordinary.id).requestIds, ["A"]);
      assert.equal(originalNativeHold(v, ordinary.id).held, false, "restored coherent invocation can close without erasing a durable contradiction");
      assert.equal(v.held().some((h) => h.runId === a.run.id && h.scope === "work" && h.code.includes("conflict") && canonicalJSON(h.requestIds) === '["A"]'), transplanted);
      assert.equal(canonicalJSON(v.d.p.toolClosures.get(originalClosure.key)), frozenClosure, "original source/outcome/available body survives restoration, rebuild and restart");
      assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.source.appRuns, 2); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const changed of [false, true])
  test(`final N1 quiescence fence: actual second SQLite reader${changed ? " journals a newer normalized own source after validation" : " leaves the validated native source unchanged"}`, async () => {
    const v = await operationRoom();
    try {
      const { normalizeT3Snapshot } = await import("../../src/adapter/engine-http.ts");
      const c = v.initial, raw = finish(v, c, "closed-own-quiescence-fence"), original = await delivered(v, c, raw);
      v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
      const frozen = canonicalJSON(v.receipt(raw.clientId)), seats = canonicalJSON([...v.d.p.seats]), beforeReads = v.source.detailReads;
      const recover = v.d.store.recovery.bind(v.d.store); let intercepted = false;
      const changedBody = { ...JSON.parse(original.text), changedBody: "Native response changed after completed detail validation, before the final recovery inventory" };
      v.d.store.recovery = (room) => {
        assert.equal(intercepted, false); intercepted = true;
        assert.ok(v.source.detailReads > beforeReads, "the quiescence call first completed actual native detail validation");
        const writer = new EngineStore(v.d.path);
        try {
          const prior = writer.project(room).providerObservations.get("W")!;
          if (changed) {
            original.item.output = changedBody; original.item.updatedAt = "2026-10-07T05:06:00.000Z"; v.source.project(original.item);
            const fresh = normalizeT3Snapshot(v.source.snapshot, "thread:W");
            assert.equal(fresh.complete, true); assert.equal(fresh.idle, true); assert.ok(fresh.sequence > prior.sequence);
            assert.equal(fresh.toolSources!.find((s) => s.itemId === original.item.id)!.updatedAt, original.item.updatedAt);
            writer.execute(room, { type: "observe_provider", actor: "$system", id: "late-normalized-quiescence-checkpoint",
              observation: { ...prior, sequence: fresh.sequence, sources: fresh.toolSources! }, pending: fresh.pending, settled: fresh.settled ?? [] });
          } else {
            const same = normalizeT3Snapshot(v.source.snapshot, "thread:W");
            assert.equal(same.sequence, prior.sequence); assert.equal(canonicalJSON(same.toolSources), canonicalJSON(prior.sources));
          }
        } finally { writer.close(); }
        return recover(room);
      };
      const proof = await v.x.quiescence(v.d.room, "W");
      assert.equal(intercepted, true); assert.equal(proof.proven, !changed, "the reported proof must describe the current journal/source checkpoint");
      assert.equal(canonicalJSON([...v.d.p.seats]), seats); assert.equal(v.d.p.seats.has("W2"), false);
      assert.equal(canonicalJSON(v.receipt(raw.clientId)), frozen); assert.equal(v.claims().length, 1); assert.equal(v.source.appRuns, 1);
      if (changed) {
        assert.ok(v.d.store.load(v.d.room).some((e) => e.commandKey.includes("late-normalized-quiescence-checkpoint")));
        assert.equal(v.d.p.providerObservations.get("W")!.sources!.find((s) => s.itemId === original.item.id)!.updatedAt, original.item.updatedAt);
        assert.deepEqual(v.source.detailItems.get(original.item.id)!.output, changedBody, "the actual native result remains visible for the next explicit reconciliation");
      }
      // This slice does not invent a transfer API: stage4 must accept only proven
      // evidence against its unchanged journal head before executing a transfer.
      v.d.parity();
    } finally { v.cleanup(); }
  });

test("final N3 writer: B cannot consume an original unconsumed A native source transplanted into B; explicit failed-call settlement permits B finish", async () => {
  const v = await operationRoom();
  try {
    const a = v.initial, ordinary = v.source.addTool(a.run, "writer-original-A-result", { type: "command_execution", input: "Original unconsumed A effect", output: "Immutable A native result\n", exitCode: 0, status: "completed" });
    await v.x.tick(v.d.room, "W");
    const firstHold = originalNativeHold(v, ordinary.id);
    assert.equal(firstHold.runId, a.run.id); assert.deepEqual(firstHold.requestIds, ["A"]);
    v.source.endRun(a.run, { kind: "yield" }); await v.x.tick(v.d.room, "W");
    v.d.request("B"); const b = await v.start(), native = v.source.native(b.run), node = v.source.snapshot.projection.nodes.find((n) => n.id === ordinary.nodeId)!;
    Object.assign(node, { runId: native.id, rootNodeId: native.rootId, parentNodeId: native.rootId, providerTurnId: native.turnId });
    Object.assign(ordinary, { runId: native.id, providerTurnId: native.turnId }); v.source.project(ordinary);
    const raw = v.intent(b, "consume-transplanted-A-as-B", "consume_tool_result", {
      toolRefs: [{ itemId: ordinary.id, digest: resultDigest(await v.source.adapter.detail("thread:W", ordinary.id)), requestIds: ["B"] }],
    }), rejected = v.projectOperation(b, raw);
    const response = await v.call(b, raw, rejected.id), body = await response.text(); assert.equal(response.status, 409, body);
    assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.claims().length, 0);
    assert.equal(v.d.p.requests.get("B")!.state, "open");
    assert.ok(v.held().some((h) => h.runId === a.run.id && h.scope === "work" && canonicalJSON(h.requestIds) === '["A"]'));
    // A rejected authenticated native call still has its own original B result.
    // Return its exact finite error, then explicitly consume that failed response.
    v.source.completeTool(rejected, body); rejected.status = "failed";
    v.source.snapshot.projection.nodes.find((n) => n.id === rejected.nodeId)!.status = "failed"; v.source.project(rejected);
    const failureRef: ToolRef = { itemId: rejected.id, digest: resultDigest(await v.source.adapter.detail("thread:W", rejected.id)), requestIds: ["B"] };
    await delivered(v, b, v.intent(b, "consume-original-B-rejection", "consume_tool_result", { toolRefs: [failureRef] }));
    const failure = [...v.d.p.toolResults.values()].find((r) => r.source.itemId === rejected.id)!;
    assert.equal(failure.source.status, "failed"); assert.deepEqual(failure.source.output, JSON.parse(body)); assert.deepEqual(failure.requestIds, ["B"]);
    assert.equal([...v.d.p.toolResults.values()].some((r) => r.source.itemId === ordinary.id), false, "the original A result never acquires B consumption effects");
    const done = await delivered(v, b, finish(v, b, "finish-B-after-original-error-consumed", ["B"]));
    assert.equal(done.result.result.claims[0]!.outcome, "answered"); assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.ok(v.held().some((h) => h.runId === a.run.id && h.scope === "work" && canonicalJSON(h.requestIds) === '["A"]'));
    assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
    assert.equal(v.source.appRuns, 2); v.d.parity();
  } finally { v.cleanup(); }
});

test("final N3 writer: first-observed uncommitted A own native source cannot become a new B own intent; unique B source still answers", async () => {
  const v = await operationRoom();
  try {
    const a = v.initial, firstIntent = v.intent(a, "uncommitted-own-A", "own_run_view"), old = v.projectOperation(a, firstIntent, "writer-first-own-native-A");
    await v.x.tick(v.d.room, "W"); assert.equal(v.d.p.operationReceipts.size, 0);
    const originalHold = originalNativeHold(v, old.id);
    assert.equal(originalHold.runId, a.run.id); assert.deepEqual(originalHold.requestIds, ["A"]);
    v.source.endRun(a.run, { kind: "yield" }); await v.x.tick(v.d.room, "W");
    v.d.request("B"); const b = await v.start(), native = v.source.native(b.run), node = v.source.snapshot.projection.nodes.find((n) => n.id === old.nodeId)!;
    const replacement = finish(v, b, "replacement-B-intent-on-A-native-id", ["B"]);
    Object.assign(node, { runId: native.id, rootNodeId: native.rootId, parentNodeId: native.rootId, providerTurnId: native.turnId });
    Object.assign(old, { runId: native.id, providerTurnId: native.turnId, input: replacement,
      toolName: "backroom-board.finish", toolSource: { kind: "integration", key: "mcp:backroom-board" }, updatedAt: "2026-10-07T05:07:00.000Z" });
    v.source.project(old);
    const response = await v.call(b, replacement, old.id), body = await response.text(); assert.equal(response.status, 409, body);
    assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0);
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.runId === a.run.id && e.data.source.itemId === old.id));
    assert.ok(v.held().some((h) => h.key === originalHold.key && h.runId === a.run.id && canonicalJSON(h.requestIds) === '["A"]'));
    assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
    const done = await delivered(v, b, finish(v, b, "unique-native-B-finish", ["B"]));
    assert.equal(done.result.result.claims[0]!.outcome, "answered"); assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.equal(v.receipt(replacement.clientId), undefined); assert.equal(v.d.p.operationReceipts.size, 1);
    assert.equal(v.source.appRuns, 2); v.d.parity();
  } finally { v.cleanup(); }
});

test("same timestamp N1: earlier confirmed own body changes during later actual detail with unchanged updatedAt; native sequence invalidates quiescence", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, first = await delivered(v, c, v.intent(c, "same-time-own-view", "own_run_view"));
    const second = await delivered(v, c, finish(v, c, "same-time-own-finish"));
    v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
    assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true);
    const timestamp = first.item.updatedAt, sequence = v.source.snapshot.snapshotSequence;
    const frozen = canonicalJSON(v.receipt("same-time-own-view")), changedBody = { ...JSON.parse(first.text), changedBody: "Different native response in the same clock timestamp" };
    const realDetail = v.source.adapter.detail.bind(v.source.adapter); let earlierRead = false, mutated = false;
    const reads = v.source.detailReads;
    v.source.adapter.detail = async (thread, id) => {
      if (id === second.item.id && !mutated) {
        assert.equal(earlierRead, true); mutated = true; first.item.output = changedBody; v.source.project(first.item);
        assert.equal(first.item.updatedAt, timestamp); assert.ok(v.source.snapshot.snapshotSequence > sequence);
      }
      const full = await realDetail(thread, id); if (id === first.item.id) earlierRead = true; return full;
    };
    const proof = await v.x.quiescence(v.d.room, "W"); assert.equal(mutated, true); assert.equal(proof.proven, false);
    assert.equal(first.item.updatedAt, timestamp, "a clock timestamp is not a unique source revision");
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === first.item.id
      && Object.hasOwn(e.data.source, "output") && canonicalJSON(e.data.source.output) === canonicalJSON(changedBody)), "actual newer body is retained despite identical item metadata");
    assert.equal(canonicalJSON(v.receipt("same-time-own-view")), frozen); assert.equal(v.claims().length, 1);
    assert.equal(v.d.p.seats.get("W")!.status, "active"); assert.equal(v.d.p.seats.has("W2"), false);
    assert.ok(v.source.detailReads - reads <= 64); v.d.parity();
  } finally { v.cleanup(); }
});

test("same timestamp N1: consumed ordinary body changes after actual detail before its refresh with unchanged updatedAt; A stays pending and body is retained", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, pair = await consumedPair(v), timestamp = pair.first.updatedAt;
    const realDetail = v.source.adapter.detail.bind(v.source.adapter), changedBody = "Contradictory ordinary result in the same clock timestamp\n";
    let mutated = false; const reads = v.source.detailReads;
    v.source.adapter.detail = async (thread, id) => {
      const full = await realDetail(thread, id);
      if (id === pair.first.id && !mutated) {
        mutated = true; const sequence = v.source.snapshot.snapshotSequence;
        pair.first.output = changedBody; v.source.project(pair.first);
        assert.equal(pair.first.updatedAt, timestamp); assert.ok(v.source.snapshot.snapshotSequence > sequence);
      }
      return full;
    };
    const raw = finish(v, c, "finish-same-time-ordinary-change"), item = v.projectOperation(c, raw), response = await v.call(c, raw, item.id), body = await response.text();
    assert.equal(mutated, true); assert.ok(response.status === 200 || response.status === 409, body);
    if (response.status === 200) assert.equal(JSON.parse(body).result.claims[0]!.outcome, "pending_activity");
    assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.claims().length, 0); assert.equal(pair.first.updatedAt, timestamp);
    assert.ok(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict" && e.data.source.itemId === pair.first.id && e.data.source.output === changedBody));
    assert.ok(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("A") && h.code.includes("conflict")));
    assert.equal(canonicalJSON([...v.d.p.toolResults.values()].find((r) => r.source.itemId === pair.first.id)), pair.original);
    assert.ok(v.source.detailReads - reads <= 64); v.d.parity();
  } finally { v.cleanup(); }
});

test("incoming N1 result: new ordinary body changes after actual detail before final refresh at the same timestamp; fresh finish rejects without effects", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, ordinary = v.source.addTool(c.run, "incoming-unconsumed-ordinary", { type: "command_execution", input: "Original A command", output: "Original unconsumed ordinary body\n", status: "completed", exitCode: 0 });
    await v.x.tick(v.d.room, "W");
    const originalHold = originalNativeHold(v, ordinary.id);
    assert.equal(originalHold.scope, "work"); assert.deepEqual(originalHold.requestIds, ["A"]);
    const ref: ToolRef = { itemId: ordinary.id, digest: resultDigest(await v.source.adapter.detail("thread:W", ordinary.id)), requestIds: ["A"] };
    const raw = finish(v, c, "finish-incoming-stale-ordinary", ["A"], { toolRefs: [ref] }), item = v.projectOperation(c, raw);
    const stamp = ordinary.updatedAt, status = ordinary.status, realDetail = v.source.adapter.detail.bind(v.source.adapter);
    const changedBody = "Different unconsumed ordinary body at the same timestamp\n"; let mutated = false;
    v.source.adapter.detail = async (thread, id) => {
      const full = await realDetail(thread, id);
      if (id === ordinary.id && !mutated) {
        mutated = true; ordinary.output = changedBody; v.source.project(ordinary);
        assert.equal(ordinary.updatedAt, stamp); assert.equal(ordinary.status, status);
        assert.ok(full.sequence < v.source.snapshot.snapshotSequence, "the genuine detail was superseded before the final own checkpoint");
      }
      return full;
    };
    const response = await v.call(c, raw, item.id), body = await response.text();
    assert.equal(mutated, true); assert.equal(response.status, 409, body);
    assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.claims().length, 0);
    assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.ok(v.held().some((h) => h.runId === originalHold.runId && h.scope === "work"
      && h.code === `recorded_result_conflict:${ordinary.id}` && canonicalJSON(h.requestIds) === '["A"]'));
    assert.equal(v.source.detailItems.get(ordinary.id)!.output, changedBody, "the current ordinary result remains visible and unconsumed");
    // Deliver the real HTTP rejection as a finite failed native response. Lifecycle
    // alone cannot consume that invocation or release the original ordinary work.
    v.source.completeTool(item, body); item.status = "failed";
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = "failed"; v.source.project(item); await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.claims().length, 0);
    assert.ok(v.held().some((h) => h.runId === originalHold.runId && h.scope === "work"
      && h.code === `recorded_result_conflict:${ordinary.id}` && canonicalJSON(h.requestIds) === '["A"]'));
    assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

test("incoming N1 result: registered background body changes after actual detail before final refresh at the same timestamp; result commit rejects atomically", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial; await registerBackground(v, c, null);
    await v.protocol.bindActivity(v.d.room, "background:A", { nativeId: "native-item:incoming-background-result", generation: 1 });
    const background = v.source.addTool(c.run, "incoming-background-result", { type: "command_execution", input: "Host-bound original background work", output: "Original registered background body\n", status: "completed", exitCode: 0 });
    await v.x.tick(v.d.room, "W");
    const originalActivity = canonicalJSON(v.d.p.activities.get("background:A")), before = {
      activities: v.d.p.activityReceipts.size, operations: v.d.p.operationReceipts.size, results: v.d.p.toolResults.size, claims: v.claims().length,
    };
    const declaredBody = "Declared activity completion must never partially commit";
    const raw = activityIntent(c, "record-incoming-stale-background", "record_activity_result", {
      toolRef: { itemId: background.id, digest: resultDigest(await v.source.adapter.detail("thread:W", background.id)), requestIds: ["A"] },
      body: declaredBody, disposition: answer(["A"]), completion: "done",
    }), item = v.source.addTool(c.run, raw.clientId, { input: raw, operation: raw.operation });
    const stamp = background.updatedAt, status = background.status, realDetail = v.source.adapter.detail.bind(v.source.adapter);
    const changedBody = "Different original background body at the same timestamp\n"; let mutated = false;
    v.source.adapter.detail = async (thread, id) => {
      const full = await realDetail(thread, id);
      if (id === background.id && !mutated) {
        mutated = true; background.output = changedBody; v.source.project(background);
        assert.equal(background.updatedAt, stamp); assert.equal(background.status, status);
        assert.ok(full.sequence < v.source.snapshot.snapshotSequence, "actual original-generation detail was superseded before activity checkpoint");
      }
      return full;
    };
    const response = await activityCall(v, c, raw, item.id), body = await response.text();
    assert.equal(mutated, true); assert.equal(response.status, 409, body);
    assert.deepEqual({ activities: v.d.p.activityReceipts.size, operations: v.d.p.operationReceipts.size, results: v.d.p.toolResults.size, claims: v.claims().length }, before);
    assert.equal(canonicalJSON(v.d.p.activities.get("background:A")), originalActivity); assert.equal(v.d.p.activities.get("background:A")!.status, "pending");
    assert.equal(v.d.p.requests.get("A")!.state, "open");
    assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "output" && e.data.body === declaredBody), false);
    assert.equal(v.source.detailItems.get(background.id)!.output, changedBody, "the original native background result remains visible");
    v.source.completeTool(item, body); item.status = "failed";
    v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!.status = "failed"; v.source.project(item); await v.x.tick(v.d.room, "W");
    assert.deepEqual({ activities: v.d.p.activityReceipts.size, operations: v.d.p.operationReceipts.size, results: v.d.p.toolResults.size, claims: v.claims().length }, before);
    assert.equal(v.d.p.activities.get("background:A")!.status, "pending"); assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});

type LineageKind = "ordinary_input" | "ordinary_type" | "ordinary_provenance" | "own_nonce" | "own_body" | "own_nonce_body";
type LineageOrder = "node_first" | "combined";
async function establishCompleteLineage(v: OperationRoom, kind: LineageKind, order: LineageOrder) {
  const c = v.initial, own = kind.startsWith("own_");
  const originalIntent = finish(v, c, "lineage-original-own", ["A"], { body: "Original complete uncommitted own intent" });
  const item = own ? v.projectOperation(c, originalIntent, "lineage-own-native", order === "combined")
    : v.source.addTool(c.run, "lineage-ordinary-native", kind === "ordinary_provenance"
      ? { input: { query: "Original A invocation" }, output: { answer: "Original external result" }, operation: "external_finite_tool", status: "completed", projectItem: order === "combined" }
      : { type: "command_execution", input: "pwd", output: "/original-workspace\n", status: "completed", exitCode: 0, projectItem: order === "combined" });
  await v.x.tick(v.d.room, "W");
  const sources = () => v.d.store.load(v.d.room).flatMap((e) => e.data.kind === "provider.observed"
    ? e.data.observation.sources ?? [] : []).filter((s) => s.nodeId === item.nodeId);
  if (order === "node_first") {
    assert.equal(sources()[0]!.itemId, null); assert.equal(sources()[0]!.complete, false);
    v.source.project(item); await v.x.tick(v.d.room, "W");
  }
  const firstComplete = () => sources().find((s) => s.itemId === item.id && s.complete)!;
  assert.ok(firstComplete(), "a complete original immutable item was actually journaled before mutation");
  assert.equal(firstComplete().type, own || kind === "ordinary_provenance" ? "dynamic_tool" : "command_execution");
  assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0);
  const firstHold = originalNativeHold(v, String(order === "node_first" ? item.nodeId : item.id));
  assert.equal(firstHold.runId, c.run.id); assert.deepEqual(firstHold.requestIds, ["A"]);
  return { item, originalIntent, firstComplete, frozenComplete: canonicalJSON(firstComplete()), originalItem: structuredClone(item), firstHold };
}

function changeCompleteLineage(v: OperationRoom, prior: Awaited<ReturnType<typeof establishCompleteLineage>>, kind: LineageKind) {
  const { item, originalIntent } = prior;
  let intent = originalIntent;
  if (kind === "ordinary_input") { item.input = "printf changed"; item.output = "Changed command result\n"; }
  if (kind === "ordinary_type") {
    item.type = "dynamic_tool"; item.input = { command: "Changed item kind" }; item.output = { answer: "Changed kind result" };
    item.toolName = "external-tools.execute"; item.toolSource = { kind: "integration", key: "mcp:external-tools", name: "External tools" }; delete item.exitCode;
  }
  if (kind === "ordinary_provenance") {
    item.toolName = "changed-external.external_finite_tool";
    item.toolSource = { kind: "integration", key: "mcp:changed-external", name: "Changed external integration" };
    item.output = { answer: "Changed provenance result" };
  }
  if (kind.startsWith("own_")) {
    intent = { ...originalIntent, ...(kind !== "own_body" ? { nonce: "changed-established-native-nonce" } : {}),
      ...(kind !== "own_nonce" ? { body: "Changed established complete own intent body" } : {}) } as OperationIntent;
    item.input = intent;
  }
  v.source.project(item); return intent;
}

for (const kind of ["ordinary_input", "ordinary_type", "ordinary_provenance", "own_nonce", "own_body", "own_nonce_body"] as const)
  for (const order of ["node_first", "combined"] as const)
    test(`V4 P2 immutable complete identity: ${kind} changed after ${order} observation rejects actual HTTP effects`, async () => {
      const v = await operationRoom();
      try {
        const c = v.initial, prior = await establishCompleteLineage(v, kind, order), changed = changeCompleteLineage(v, prior, kind);
        let raw = changed, item = prior.item;
        if (kind.startsWith("ordinary_")) {
          const full = await v.source.adapter.detail("thread:W", prior.item.id);
          assert.equal(full.complete, true, "the mutated item is a valid current public projection, so rejection must protect history");
          raw = finish(v, c, "finish-lineage-after-change", ["A"], { toolRefs: [{ itemId: prior.item.id, digest: resultDigest(full), requestIds: ["A"] }] });
          item = v.projectOperation(c, raw);
        }
        const response = await v.call(c, raw, item.id), body = await response.text(); assert.equal(response.status, 409, body);
        assert.equal(v.d.p.operationReceipts.size, 0); assert.equal(v.d.p.toolResults.size, 0); assert.equal(v.claims().length, 0);
        assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(canonicalJSON(prior.firstComplete()), prior.frozenComplete);
        const conflicts = v.d.store.load(v.d.room).filter((e) => e.data.kind === "provider.conflict" && e.data.runId === c.run.id
          && (e.data.source.itemId === prior.item.id || e.data.source.nodeId === prior.item.nodeId));
        assert.ok(conflicts.length, "complete item identity is protected even when earliest origin was only a node");
        assert.ok(v.held().some((h) => h.scope === "work" && h.runId === c.run.id && canonicalJSON(h.requestIds) === '["A"]' && h.code.includes("conflict")));
        if (kind.startsWith("own_")) assert.ok(conflicts.some((e) => e.data.kind === "provider.conflict" && canonicalJSON(e.data.source.input) === canonicalJSON(changed)), "changed raw nonce/body remains in the durable conflict");
        else assert.equal(canonicalJSON(v.source.detailItems.get(prior.item.id)!.output), canonicalJSON(prior.item.output), "unconsumed changed output remains visible at original native source");
        assert.equal(v.source.appRuns, 1); assert.equal(v.source.frames.filter((f) => f.payload.type === "message.dispatch").length, 1); v.d.parity();
      } finally { v.cleanup(); }
    });

for (const kind of ["ordinary_input", "own_nonce_body"] as const) for (const order of ["node_first", "combined"] as const)
  test(`V4 P2 unchanged positive: established ${kind} after ${order} ordering settles only exact invocation and answers`, async () => {
    const v = await operationRoom();
    try {
      const c = v.initial, prior = await establishCompleteLineage(v, kind, order);
      let raw = prior.originalIntent, item = prior.item;
      if (kind === "ordinary_input") {
        raw = finish(v, c, "finish-unchanged-lineage", ["A"], { toolRefs: [{ itemId: prior.item.id, digest: resultDigest(await v.source.adapter.detail("thread:W", prior.item.id)), requestIds: ["A"] }] });
        item = v.projectOperation(c, raw);
      }
      const response = await v.call(c, raw, item.id), body = await response.text(); assert.equal(response.status, 200, body);
      assert.equal(JSON.parse(body).result.claims[0]!.outcome, "answered"); assert.equal(v.claims().length, 1);
      assert.equal(v.d.p.toolResults.size, kind === "ordinary_input" ? 1 : 0); assert.equal(v.d.p.operationReceipts.size, 1);
      assert.equal(canonicalJSON(prior.firstComplete()), prior.frozenComplete);
      assert.equal(v.d.store.load(v.d.room).some((e) => e.data.kind === "provider.conflict"), false);
      for (const id of [prior.item.id, String(prior.item.nodeId)]) assert.equal(v.held().some((h) => h.code === `native_activity:${id}`), false);
      v.source.completeTool(item, body); v.source.endRun(c.run, { kind: "silent" }); await v.x.tick(v.d.room, "W");
      assert.equal((await v.x.quiescence(v.d.room, "W")).proven, true); assert.equal(v.source.appRuns, 1); v.d.parity();
    } finally { v.cleanup(); }
  });

for (const kind of ["ordinary_input", "own_nonce_body"] as const)
  test(`V4 P2 fixed origin: node-first ${kind} complete identity conflict holds original A while B answers through restoration/rebuild/reopen`, async () => {
    const v = await operationRoom();
    try {
      const a = v.initial, prior = await establishCompleteLineage(v, kind, "node_first"), changed = changeCompleteLineage(v, prior, kind);
      let raw = changed, rejected = prior.item;
      if (kind === "ordinary_input") {
        raw = finish(v, a, "reject-complete-A-change", ["A"], { toolRefs: [{ itemId: prior.item.id, digest: resultDigest(await v.source.adapter.detail("thread:W", prior.item.id)), requestIds: ["A"] }] });
        rejected = v.projectOperation(a, raw);
      }
      const response = await v.call(a, raw, rejected.id), body = await response.text(); assert.equal(response.status, 409, body);
      v.source.completeTool(rejected, body); rejected.status = "failed";
      v.source.snapshot.projection.nodes.find((n) => n.id === rejected.nodeId)!.status = "failed"; v.source.project(rejected);
      v.source.endRun(a.run, { kind: "yield" }); await v.x.tick(v.d.room, "W");
      v.d.request("B"); const b = await v.start(); const done = await delivered(v, b, finish(v, b, "finish-B-after-complete-A-conflict", ["B"]));
      assert.equal(done.result.result.claims[0]!.outcome, "answered"); assert.equal(v.d.p.requests.get("A")!.state, "open");
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      assert.ok(v.held().some((h) => h.scope === "work" && h.runId === a.run.id && canonicalJSON(h.requestIds) === '["A"]' && h.code.includes("conflict")));
      Object.assign(prior.item, prior.originalItem);
      v.source.snapshot.projection.nodes.find((n) => n.id === prior.item.nodeId)!.status = prior.originalItem.status;
      v.source.project(prior.item); await v.x.tick(v.d.room, "W");
      v.d.store.rebuild(v.d.room); v.d.parity(); v.d.reopen();
      const x = new EngineReconciler(v.d.store, v.source.adapter), protocol = new EngineLocalProtocol(v.d.store, v.source.adapter); await x.tick(v.d.room, "W");
      const retry = finish(v, b, "finish-B-after-complete-A-restored", ["B"]), item = v.projectOperation(b, retry);
      const result = await protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
        method: "POST", headers: { authorization: b.authorization }, body: JSON.stringify({ intent: retry, itemId: item.id }),
      }));
      assert.equal(result.status, 200); assert.equal(JSON.parse(await result.text()).result.claims[0]!.outcome, "already_answered");
      assert.equal(v.d.p.requests.get("A")!.state, "open"); assert.equal(v.d.p.toolResults.size, 0);
      assert.equal(canonicalJSON(prior.firstComplete()), prior.frozenComplete);
      assert.ok(v.held().some((h) => h.scope === "work" && h.runId === a.run.id && canonicalJSON(h.requestIds) === '["A"]' && h.code.includes("conflict")));
      assert.equal(v.held().some((h) => h.scope === "work" && h.requestIds?.includes("B")), false);
      assert.equal(v.source.appRuns, 2); v.d.parity();
    } finally { v.cleanup(); }
  });

test("V4 P2 receipt-first positive: node-first complete own receipt replays frozen bytes after later nonce/body/provenance changes with all provider reads disabled", async () => {
  const v = await operationRoom();
  try {
    const c = v.initial, prior = await establishCompleteLineage(v, "own_nonce_body", "node_first");
    const response = await v.call(c, prior.originalIntent, prior.item.id), body = await response.text(); assert.equal(response.status, 200, body);
    v.source.completeTool(prior.item, body); await v.x.tick(v.d.room, "W");
    const receipt = canonicalJSON(v.receipt(prior.originalIntent.clientId)), changed = changeCompleteLineage(v, prior, "own_nonce_body");
    prior.item.toolSource = { kind: "integration", key: "mcp:foreign-after-commit", name: "Changed source after original receipt" };
    prior.item.output = { changedBody: "Changed result after committed effects" }; v.source.project(prior.item);
    const head = v.d.store.load(v.d.room).length, counts = [v.source.contractReads, v.source.snapshotReads, v.source.detailReads];
    v.d.reopen(); v.source.disabled = true;
    const protocol = new EngineLocalProtocol(v.d.store, v.source.adapter);
    const call = (intent: OperationIntent) => protocol.handle(v.d.room, new Request("http://backroom-simulation.invalid/local", {
      method: "POST", headers: { authorization: c.authorization }, body: JSON.stringify({ intent, itemId: "unobserved-later-alias" }),
    }));
    const replay = await call(prior.originalIntent); assert.equal(replay.status, 200); assert.equal(await replay.text(), body);
    assert.equal((await call(changed)).status, 409, "a different raw intent cannot inherit the original receipt");
    assert.deepEqual([v.source.contractReads, v.source.snapshotReads, v.source.detailReads], counts);
    assert.equal(v.d.store.load(v.d.room).length, head); assert.equal(canonicalJSON(v.receipt(prior.originalIntent.clientId)), receipt);
    assert.equal(v.claims().length, 1); assert.equal(v.d.p.operationReceipts.size, 1); assert.equal(v.source.appRuns, 1); v.d.parity();
  } finally { v.cleanup(); }
});
