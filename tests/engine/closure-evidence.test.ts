import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeT3Snapshot } from "../../src/adapter/engine-http.ts";
import { hash } from "../../src/engine/provider.ts";
import { canonicalJSON, exactAlias, resultDigest, sourceIdentity, toolClosure } from "../../src/engine/result.ts";
import { operationRoom, simulatedThread } from "./operation-fixture.ts";

test("stable real command detail retains 65,536 bytes without a consumed receipt or serialization cap", async () => {
  const v = await operationRoom();
  try {
    const output = `${"quoted \"line\"\n".repeat(4500)}${"x".repeat(2536)}`;
    assert.equal(Buffer.byteLength(output), 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) > 65536);
    v.source.addTool(v.initial.run, "command:large", { type: "command_execution", input: "run focused tests", output, status: "completed", exitCode: 0 });
    const detail = await v.source.adapter.detail(simulatedThread, "command:large"), closed = toolClosure(detail)!;
    assert.ok(closed); assert.equal(closed.outcome, "done"); assert.equal(closed.retained.output, output);
    assert.equal(closed.availability.output!.status, "complete"); assert.equal(closed.retained.exitCode, 0);
    assert.equal(closed.availability.exitCode!.status, "complete");
    assert.equal(closed.availability["resultMetadata.completedAt"]!.status, "complete");
    assert.equal(closed.retainedDigest, hash(canonicalJSON(closed.retained)));
    assert.equal(closed.source.providerRunId, v.source.native(v.initial.run).id);
    assert.equal(closed.source.generation, 1); assert.equal(closed.checkpoint.sequence, v.source.snapshot.snapshotSequence);
    assert.equal(v.source.detailReads, 2); assert.throws(() => resultDigest(detail), /unavailable/);
    assert.equal(v.d.p.toolResults.size, 0, "positive invocation evidence is separate from optional byte consumption");
  } finally { v.cleanup(); }
});

for (const [status, exitCode, outcome] of [["completed", 0, "done"], ["completed", 7, "failed"], ["failed", 9, "failed"],
  ["failed", 0, null], ["interrupted", 7, null], ["cancelled", 7, null]] as const)
  test(`command closure uses actual integer exitCode and coherent ${status}/${exitCode}`, async () => {
    const v = await operationRoom();
    try {
      v.source.addTool(v.initial.run, "command:outcome", { type: "command_execution", input: "verify", output: "actual original output", status, exitCode });
      const detail = await v.source.adapter.detail(simulatedThread, "command:outcome");
      assert.equal(toolClosure(detail)?.outcome ?? null, outcome);
      if (outcome) assert.equal(toolClosure(detail)!.retained.output, "actual original output");
    } finally { v.cleanup(); }
  });

test("command exit evidence can close an invocation with truthful unavailable output", async () => {
  const v = await operationRoom();
  try {
    v.source.addTool(v.initial.run, "command:omitted", { type: "command_execution", input: "true", status: "completed", exitCode: 0 });
    const detail = await v.source.adapter.detail(simulatedThread, "command:omitted"), closed = toolClosure(detail)!;
    assert.ok(closed); assert.equal(closed.outcome, "done"); assert.equal(Object.hasOwn(closed.retained, "output"), false);
    assert.equal(closed.availability.output!.status, "unavailable"); assert.throws(() => resultDigest(detail), /unavailable/);
  } finally { v.cleanup(); }
});

test("completed dynamic source without an actual returned payload remains unavailable", async () => {
  const v = await operationRoom();
  try {
    v.source.addTool(v.initial.run, "dynamic:missing", { input: { task: "original" }, status: "completed" });
    const detail = await v.source.adapter.detail(simulatedThread, "dynamic:missing");
    assert.equal(toolClosure(detail), null); assert.equal(detail.payloadAvailability!.output!.status, "unavailable");
  } finally { v.cleanup(); }
});

for (const fault of ["noexit", "fractionalexit", "active_node", "different_node_outcome", "weak_ref", "different_node_ref", "foreign_origin", "unknown_type", "synthetic_failed"] as const)
  test(`real HTTP command detail does not close uncertainty ${fault}`, async () => {
    const v = await operationRoom();
    try {
      const item = v.source.addTool(v.initial.run, "command:negative", { type: "command_execution", input: "verify", output: "actual", status: "completed", exitCode: 0 });
      const node = v.source.snapshot.projection.nodes.find((n) => n.id === item.nodeId)!;
      if (fault === "noexit") delete item.exitCode;
      if (fault === "fractionalexit") item.exitCode = 0.5;
      if (fault === "active_node") node.status = "running";
      if (fault === "different_node_outcome") node.status = "failed";
      if (fault === "weak_ref") item.nativeItemRef = { driver: "codex", nativeId: "native-item:command:negative", strength: "weak" };
      if (fault === "different_node_ref") node.nativeItemRef = { driver: "codex", nativeId: "another", strength: "strong" };
      if (fault === "foreign_origin") node.runId = "different-native-run";
      if (fault === "unknown_type") item.type = "future_native_tool";
      if (fault === "synthetic_failed") { item.status = "failed"; node.status = "failed"; delete item.exitCode; item.output = "Interrupted before process result"; }
      v.source.project(item);
      if (fault === "unknown_type") await assert.rejects(v.source.adapter.detail(simulatedThread, item.id), /source item unavailable/);
      else assert.equal(toolClosure(await v.source.adapter.detail(simulatedThread, item.id)), null);
    } finally { v.cleanup(); }
  });

test("actual native edit closes with original file metadata and explicit omitted diff/old/new", async () => {
  const v = await operationRoom();
  try {
    const original = { fileName: "src/retry.ts", additions: 1, deletions: 1,
      diffStr: "@@ retry loop @@\n- const delay = retries * 100;\n+ const delay = Math.min(1000, 100 * 2 ** retries);\n",
      oldStr: "const delay = retries * 100;", newStr: "const delay = Math.min(1000, 100 * 2 ** retries);",
      changes: [{ operation: "update", path: "src/retry.ts", fileType: "file", mimeType: "text/typescript" }] };
    const originalBytes = canonicalJSON(original);
    const { diffStr: _diff, oldStr: _old, newStr: _new, ...projected } = original;
    // Pinned WireProjection success branch strips these exact fields for BOTH wire and detail.
    const item = v.source.addTool(v.initial.run, "edit:original", { input: {}, status: "completed" });
    delete item.input; delete item.toolName; delete item.toolSource;
    Object.assign(item, projected, { type: "file_change" }); v.source.project(item);
    const snapshot = normalizeT3Snapshot(v.source.snapshot, simulatedThread);
    const source = snapshot.toolSources!.find((s) => s.itemId === item.id)!;
    assert.equal(source.complete, true); assert.deepEqual(source.issues, []);
    assert.equal(snapshot.activities.some((a) => a.id === item.nodeId), false, "only supported coherent edit coalesces its physical alias");
    const detail = await v.source.adapter.detail(simulatedThread, item.id), closed = toolClosure(detail)!;
    assert.ok(closed); assert.equal(closed.outcome, "done"); assert.deepEqual(closed.retained.fileChange, projected);
    for (const field of ["diffStr", "oldStr", "newStr"] as const) {
      assert.equal(Object.hasOwn(closed.retained.fileChange!, field), false);
      assert.equal(closed.availability[`fileChange.${field}`]!.status, "omitted");
    }
    assert.equal(closed.availability["fileChange.fileName"]!.status, "complete");
    assert.equal(closed.availability.fileChange!.status, "partial");
    assert.equal(canonicalJSON(original), originalBytes, "original test evidence remains intact rather than replaced by detail");
    assert.throws(() => resultDigest(detail), /unavailable|ordinary invocation/);
    assert.notEqual(sourceIdentity(detail), sourceIdentity({ ...detail, fileChange: { ...projected, fileName: "different.ts" } }));
    const { fileChange: _fileChange, ...withoutFile } = source;
    const node = { ...withoutFile, itemId: null, type: "tool_node", complete: false, issues: ["tool_item_unavailable"] };
    assert.equal(exactAlias(node, source), true);
    assert.equal(exactAlias(node, { ...withoutFile, complete: false, issues: ["tool_file_metadata_unavailable"] }), false);
  } finally { v.cleanup(); }
});

test("metadata-only image return closes its call without inventing image data or digest", async () => {
  const v = await operationRoom();
  try {
    const originalPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const original = { content: [{ type: "image", mimeType: "image/png", data: originalPNG }] };
    const detailOutput = { content: [{ type: "image", mimeType: "image/png" }] };
    v.source.addTool(v.initial.run, "image:return", { input: { path: "/original/result.png" }, output: detailOutput, status: "completed" });
    const detail = await v.source.adapter.detail(simulatedThread, "image:return"), closed = toolClosure(detail)!;
    assert.ok(closed); assert.deepEqual(closed.retained.output, detailOutput);
    assert.equal(closed.availability.output!.status, "partial");
    assert.equal(closed.availability["output.content.0.mimeType"]!.status, "complete");
    assert.equal(closed.availability["output.content.0.data"]!.status, "omitted");
    assert.equal(JSON.stringify(closed).includes(originalPNG), false); assert.equal(original.content[0]!.data, originalPNG);
    assert.ok(closed.limitations.some((s) => s.includes("image bytes were not captured")));
    assert.throws(() => resultDigest(detail), /unavailable/);
  } finally { v.cleanup(); }
});

test("actual partial dynamic return closes CALL and retains native background roster separately", async () => {
  const v = await operationRoom();
  try {
    const output = { content: [{ type: "text", text: "Actual available prefix\n… output truncated for transport" }], taskId: "bg:original" };
    v.source.addTool(v.initial.run, "dynamic:launch", { input: { command: "actual native task" }, output, status: "completed" });
    v.source.snapshot.projection.providerThreads[0]!.pendingBackgroundTasks = [{ taskId: "bg:original" }];
    const detail = await v.source.adapter.detail(simulatedThread, "dynamic:launch"), closed = toolClosure(detail)!;
    assert.ok(closed); assert.equal(closed.outcome, "done"); assert.deepEqual(closed.retained.output, output);
    assert.equal(closed.availability.output!.status, "partial");
    assert.ok(normalizeT3Snapshot(v.source.snapshot, simulatedThread).pending.includes("background:provider-thread:bg:original"));
    assert.ok(closed.limitations.some((s) => s.includes("does not settle any background job")));
  } finally { v.cleanup(); }
});

for (const mutation of ["same_sequence_detail", "advanced_final_checkpoint", "changed_file_metadata", "unsupported_edit_metadata"] as const)
  test(`closure detail retains existing source/freshness fence ${mutation}`, async () => {
    const v = await operationRoom();
    try {
      const item = v.source.addTool(v.initial.run, "closure:mutation", { type: "command_execution", input: "verify", output: "actual", status: "completed", exitCode: 0 });
      if (mutation === "same_sequence_detail") v.source.onDetail = (_id, count) => ({ ...item, output: count === 1 ? "actual" : "changed at same seq" });
      if (mutation === "advanced_final_checkpoint") v.source.onSnapshot = (count) => { if (count === v.source.snapshotReads && v.source.detailReads === 2) v.source.snapshot.snapshotSequence++; return v.source.snapshot; };
      if (mutation === "changed_file_metadata" || mutation === "unsupported_edit_metadata") {
        item.type = "file_change"; delete item.input; delete item.output; delete item.exitCode;
        Object.assign(item, { fileName: "original.ts", additions: mutation === "unsupported_edit_metadata" ? -1 : 1, deletions: 0 }); v.source.project(item);
        if (mutation === "changed_file_metadata") v.source.onDetail = (_id, count) => ({ ...item, fileName: count === 1 ? "original.ts" : "other.ts" });
      }
      if (mutation === "advanced_final_checkpoint") await assert.rejects(v.source.adapter.detail(simulatedThread, item.id), /Unproved detail coverage/);
      else {
        const detail = await v.source.adapter.detail(simulatedThread, item.id);
        assert.equal(toolClosure(detail), null);
        if (mutation !== "unsupported_edit_metadata") assert.ok(detail.issues.includes("unstable_detail"));
      }
    } finally { v.cleanup(); }
  });
