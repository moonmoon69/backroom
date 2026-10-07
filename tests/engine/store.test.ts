import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { EngineStore, unread } from "../../src/engine/index.ts";
import type { Command } from "../../src/engine/index.ts";
import { DiskRoom } from "./store-fixture.ts";

test("durable command receipts replay original whole batch after lost local commit receipt; conflicting reuse is rejected", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve(); r.request("B"); const receipt = r.sync(run); r.request("C");
    const command = r.outputCommand(run, { kind: "answer", requestIds: ["A", "B"] }, { receipts: [receipt] });
    r.reopen({ onBoundary(point) { if (point === "after_commit") throw new Error("lost local commit receipt"); } });
    assert.throws(() => r.add(command), /lost local/);
    r.reopen();
    const head = r.store.load(r.room).length;
    const replay = r.add(command);
    assert.equal(replay.replayed, true); assert.equal(replay.head, head); assert.equal(replay.events.length, 3);
    assert.deepEqual(replay.events.map((e) => e.data.kind), ["sync.confirmed", "output", "run.ended"]);
    assert.throws(() => r.add({ ...command, body: "changed" } as Command), /conflicting command/);
    assert.equal(r.p.runs.get(run.id)!.phase, "terminal"); assert.equal(r.p.seats.get("W")!.activeRunId, null);
    assert.deepEqual(unread(r.p, "W").map((i) => i.eventId), ["C"]);
    r.parity();
  } finally { r.cleanup(); }
});

test("canonical command replay ignores property insertion order, frozen caller data cannot mutate persisted inputs", () => {
  const r = new DiskRoom();
  try {
    const c: Command = { id: "A", actor: "O", type: "request", to: "W", body: "original" };
    r.add(c); r.reopen();
    assert.equal(r.add({ body: "original", to: "W", type: "request", actor: "O", id: "A" }).replayed, true);
    const reserve = r.reserveCommand(); r.add(reserve); const before = structuredClone(r.p.runs.values().next().value!);
    c.body = "external mutation"; r.request("B"); r.reopen();
    assert.deepEqual(r.p.runs.get(before.id), before); assert.equal(r.p.requests.get("A")!.body, "original");
    r.parity();
  } finally { r.cleanup(); }
});

test("T6 prepared/sending/uncertain/rejected reservations reopen with SAME frozen IDs, no automatic run or retry", () => {
  for (const phase of ["prepared", "sending", "uncertain", "rejected"] as const) {
    const r = new DiskRoom();
    try {
      r.request("A"); const run = r.reserve("W", false);
      if (phase !== "prepared") r.add({ type: "phase", actor: "$system", runId: run.id, phase, evidence: "FAKE provider evidence only" });
      r.request("B"); const frozen = r.p.runs.get(run.id)!; const log = r.store.load(r.room); r.reopen();
      assert.deepEqual(r.store.recovery(r.room).runs, [frozen]); assert.deepEqual(r.store.load(r.room), log);
      assert.throws(() => r.add(r.reserveCommand()), /unresolved/);
      if (phase !== "rejected") assert.throws(() => r.add({ type: "retry", actor: "$user", runId: run.id, body: "retry" }), /known failed/);
      assert.equal(r.p.seats.get("W")!.cursor, 0); assert.equal(frozen.envelope.inputs.some((i) => i.eventId === "B"), false);
      r.parity();
    } finally { r.cleanup(); }
  }
});

test("T8 same emission imported before terminal observation closes SAME run once and rejects changed source content", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    const emission = r.outputCommand(run, { kind: "answer", requestIds: ["A"] }, { terminal: false });
    r.add(emission); r.reopen();
    const source = (emission as Extract<Command, { type: "output" }>).sourceKey;
    assert.throws(() => r.add({ ...emission, id: "bad", body: "different content" } as Command), /conflicting provider source/);
    assert.throws(() => r.add({ ...emission, id: "bad2", disposition: { kind: "yield" } } as Command), /conflicting provider source/);
    const terminal: Command = { ...emission, id: "terminal-observation", terminal: true } as Command;
    const result = r.add(terminal); assert.deepEqual(result.events.map((e) => e.data.kind), ["run.ended"]);
    r.reopen(); assert.equal(r.add(terminal).replayed, true);
    assert.equal(r.p.sourceKeys.get(source), emission.id); assert.equal(r.p.requests.get("A")!.answerId, emission.id);
    assert.equal(r.p.seats.get("W")!.activeRunId, null); r.parity();
  } finally { r.cleanup(); }
});

test("offered receipts survive restart without consumption; confirmed receipts commit complete prefixes only", () => {
  for (const confirmed of [false, true]) {
    const r = new DiskRoom();
    try {
      r.request("A"); const run = r.reserve(); r.request("B"); const receipt = r.sync(run); r.request("C");
      if (confirmed) r.add({ type: "confirm_sync", actor: "$system", runId: run.id, receiptId: receipt.id, digest: receipt.digest, evidence: "FAKE durable exposure" });
      const frozenBytes = JSON.stringify(run.envelope);
      const offered = r.p.runs.get(run.id)!.receipts[0]!;
      const offeredBytes = JSON.stringify(offered.envelope);
      r.reopen(); assert.equal(r.p.seats.get("W")!.cursor, 0);
      assert.equal(JSON.stringify(r.p.runs.get(run.id)!.envelope), frozenBytes);
      const restored = r.p.runs.get(run.id)!.receipts[0]!;
      assert.equal(JSON.stringify(restored.envelope), offeredBytes);
      assert.equal(createHash("sha256").update(JSON.stringify([run.id, restored.id, restored.envelope])).digest("hex"), restored.digest);
      assert.equal(r.p.runs.get(run.id)!.receipts[0]!.confirmed, confirmed);
      r.add(r.outputCommand(run, { kind: "silent" })); r.reopen();
      assert.deepEqual(unread(r.p, "W").map((i) => i.eventId), confirmed ? ["C"] : ["B", "C"]);
      assert.equal(r.p.requests.get("A")!.state, "open"); r.parity();
    } finally { r.cleanup(); }
  }
});

test("live controls remain non-waking, claimed and uncertain across terminal and restart; accepted late proof settles only the control", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    r.add({ type: "request", id: "Q", actor: "W", to: "$user", body: "Approve?", parentId: "A", live: { runId: run.id, providerRequestId: "provider-Q" } });
    r.add({ type: "runtime_reply", id: "reply", actor: "$user", requestId: "Q", body: "approved", commandId: "response-command" });
    r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "uncertain", evidence: "FAKE lost receipt" });
    r.add(r.outputCommand(run, { kind: "answer", requestIds: ["A"] })); r.reopen();
    assert.equal(r.p.requests.get("A")!.state, "open"); assert.equal(r.p.requests.get("Q")!.answerId, "reply");
    assert.equal(r.store.recovery(r.room).controls[0]!.phase, "uncertain"); assert.equal(unread(r.p, "W").length, 0);
    const cursor = r.p.seats.get("W")!.cursor;
    r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "accepted", evidence: "FAKE durable late receipt" });
    r.reopen(); assert.equal(r.p.seats.get("W")!.cursor, cursor); assert.equal(r.store.recovery(r.room).controls.length, 0);
    assert.equal(r.p.requests.get("A")!.state, "open"); r.parity();
  } finally { r.cleanup(); }
});

test("user180 pending background work, passive/subscribed progress and silent consumption survive restart without acknowledgements", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); r.request("B", "W", "X"); const run = r.reserve();
    r.add({ type: "activity_start", actor: "W", activityId: "child", runId: run.id, requestIds: ["A"], status: "uncertain" });
    r.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["ready"], enabled: true });
    r.add(r.outputCommand(run, { kind: "progress", requestIds: ["A"], milestone: "passive" }, { terminal: false }));
    r.add(r.outputCommand(run, { kind: "progress", requestIds: ["A"], milestone: "ready" }, { terminal: false }));
    r.add(r.outputCommand(run, { kind: "progress", requestIds: ["A"], milestone: "ready" }, { terminal: false }));
    const finish = r.add(r.outputCommand(run, { kind: "answer", requestIds: ["A", "B"] }));
    const output = finish.events.find((e) => e.data.kind === "output")!;
    assert.equal(output.data.kind, "output"); if (output.data.kind === "output") assert.deepEqual(output.data.claims.map((c) => c.outcome), ["pending_activity", "answered"]);
    r.reopen(); assert.equal(r.store.recovery(r.room).activities[0]!.id, "child");
    assert.throws(() => r.add({ type: "transfer", actor: "$user", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: [], body: "transfer", evidence: "FAKE" }), /background/);
    const o = r.reserve("O"); assert.equal(o.envelope.inputs.length, 2);
    const silent = r.add(r.outputCommand(o, { kind: "silent" }));
    assert.ok(silent.events.every((e) => e.data.kind !== "output" || e.data.recipients.length === 0));
    r.reopen(); assert.equal(unread(r.p, "O").length, 0); assert.equal(unread(r.p, "W").length, 0);
    r.add({ type: "activity_status", actor: "$system", activityId: "child", status: "done", evidence: "FAKE correlated child completion" });
    r.add(r.outputCommand(run, { kind: "answer", requestIds: ["A"] }, { terminal: false, association: { kind: "activity", id: "child" } }));
    r.reopen(); assert.equal(r.p.requests.get("A")!.state, "answered"); assert.equal(r.store.recovery(r.room).activities.length, 0); r.parity();
  } finally { r.cleanup(); }
});

test("notice-only failure remains non-waking after restart, new genuine input can reserve without a synthetic retry", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const w = r.reserve(); r.add(r.outputCommand(w, { kind: "error", requestIds: ["A"] }, { body: "failure" }));
    const o = r.reserve("O"); r.add(r.outputCommand(o, { kind: "error", requestIds: [] }, { body: "notice failure" }));
    r.reopen(); assert.equal(unread(r.p, "O").length, 0); assert.equal(unread(r.p, "W").length, 0);
    r.request("new"); const fresh = r.reserve(); assert.deepEqual(fresh.envelope.inputs.map((i) => i.eventId), ["new"]);
    assert.equal(r.p.requests.get("A")!.state, "open"); r.parity();
  } finally { r.cleanup(); }
});

test("all disposable indices are rebuildable solely from the event log; no authoritative work/inbox/queue exists", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve(); r.request("B"); r.sync(run);
    const finish = r.outputCommand(run, { kind: "answer", requestIds: ["A"] }); r.add(finish);
    const log = r.store.load(r.room); r.store.close();
    const raw = new DatabaseSync(r.path);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(tables, ["engine_command", "engine_event", "engine_head", "engine_key", "engine_projection"]);
    for (const table of tables.filter((t) => t !== "engine_event")) raw.exec(`DROP TABLE ${table}`);
    assert.throws(() => raw.exec("DELETE FROM engine_event"), /append-only/); raw.close();
    r.store = new EngineStore(r.path); assert.equal(r.store.audit(r.room).ok, false);
    assert.deepEqual(r.p.events, log); r.store.rebuild(r.room); r.parity();
    assert.deepEqual(r.store.load(r.room), log); assert.equal(r.add(finish).replayed, true);
    assert.throws(() => r.add({ ...finish, body: "changed" } as Command), /conflicting command/);
  } finally { r.cleanup(); }
});

test("indices never override causal state; parity detects corruption and transactional rebuild repairs it", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve(); const original = r.p.runs.get(run.id)!;
    const raw = new DatabaseSync(r.path);
    raw.prepare("UPDATE engine_projection SET value='{}' WHERE room=? AND kind='runs'").run(r.room);
    raw.prepare("UPDATE engine_head SET seq=999 WHERE room=?").run(r.room); raw.close();
    assert.deepEqual(r.p.runs.get(run.id), original); assert.deepEqual(r.store.audit(r.room).mismatches, ["head", "projections"]);
    assert.throws(() => r.add({ type: "post", actor: "O", intent: "note", body: "not committed" }), /rebuild required/);
    r.store.rebuild(r.room); r.parity(); r.reopen(); r.parity();
  } finally { r.cleanup(); }
});

test("identity scopes are isolated by room and unrelated DB schemas are refused", () => {
  const r = new DiskRoom();
  try {
    r.store.execute("second", { type: "seat", id: "seat", actor: "$user", seatId: "W", threadId: "thread:W" });
    r.store.execute("second", { type: "request", id: "A", actor: "$user", to: "W", body: "other room" });
    r.request("A"); assert.equal(r.store.project("second").requests.get("A")!.body, "other room"); r.parity();
    assert.equal(r.store.audit("second").ok, true);
    const path = `${r.dir}/legacy.sqlite`; const raw = new DatabaseSync(path); raw.exec("CREATE TABLE legacy (id TEXT)"); raw.close();
    assert.throws(() => new EngineStore(path), /dedicated/);
  } finally { r.cleanup(); }
});

test("eventless idle checks create no receipt or queue; the same unused identity can observe later genuine input", () => {
  const r = new DiskRoom();
  try {
    const c = r.reserveCommand(); const before = r.store.load(r.room);
    assert.equal(r.add(c).outcome, "idle"); r.reopen(); assert.deepEqual(r.store.load(r.room), before);
    assert.equal(r.add(c).replayed, false); r.request("A"); assert.equal(r.add(c).outcome, "appended");
    r.reopen(); assert.equal(r.add(c).replayed, true); r.parity();
    assert.equal(r.store.audit("unknown-room").ok, true);
  } finally { r.cleanup(); }
});

test("provider command IDs cannot alias a dispatch and a response; failed decision leaves no partial live answer claim", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    r.add({ type: "request", actor: "W", id: "Q", to: "$user", parentId: "A", body: "approve", live: { runId: run.id, providerRequestId: "provider-question" } });
    const before = r.store.load(r.room);
    assert.throws(() => r.add({ type: "runtime_reply", actor: "$user", id: "reply", requestId: "Q", body: "yes", commandId: run.dispatchCommandId }), /duplicate provider-command/);
    r.reopen(); assert.deepEqual(r.store.load(r.room), before); assert.equal(r.p.requests.get("Q")!.state, "open"); r.parity();
  } finally { r.cleanup(); }
});

test("activity completion cannot mutate an already imported source; separate evidence can resolve it", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    r.add({ type: "activity_start", actor: "W", runId: run.id, activityId: "child", requestIds: ["A"], status: "pending" });
    const emission = r.outputCommand(run, { kind: "progress", requestIds: ["A"] }, { terminal: false, association: { kind: "activity", id: "child" } });
    r.add(emission); r.reopen();
    assert.throws(() => r.add({ ...emission, id: "changed-completion", activityCompletion: "done" } as Command), /conflicting provider source/);
    assert.equal(r.p.activities.get("child")!.status, "pending");
    r.add({ type: "activity_status", actor: "$system", activityId: "child", status: "done", evidence: "FAKE independent completion proof" });
    r.reopen(); assert.equal(r.p.activities.get("child")!.status, "done"); r.parity();
  } finally { r.cleanup(); }
});
