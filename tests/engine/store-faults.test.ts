import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EngineStore, decide, unread } from "../../src/engine/index.ts";
import type { Command } from "../../src/engine/index.ts";
import { DiskRoom, waitForFiles, worker } from "./store-fixture.ts";

interface Scenario { name: string; setup: (r: DiskRoom) => Command }
const scenarios: Scenario[] = [
  { name: "sending-to-uncertain evidence and held reservation", setup(r) {
    r.request("A"); const run = r.reserve("W", false);
    r.add({ type: "phase", actor: "$system", runId: run.id, phase: "sending", evidence: "FAKE about to send" });
    return { type: "phase", id: "uncertain", actor: "$system", runId: run.id, phase: "uncertain", evidence: "FAKE loss of acceptance knowledge" };
  } },
  { name: "offered complete-prefix sync receipt without exposure", setup(r) {
    r.request("A"); const run = r.reserve(); r.request("B");
    return { type: "sync", actor: "$system", id: "offer", runId: run.id, receiptId: "receipt", maxBytes: 1_000_000 };
  } },
  { name: "confirmed complete-prefix sync evidence without cursor advance", setup(r) {
    r.request("A"); const run = r.reserve(); r.request("B"); const receipt = r.sync(run);
    return { type: "confirm_sync", actor: "$system", id: "exposure", runId: run.id, receiptId: receipt.id, digest: receipt.digest, evidence: "FAKE transcript exposure" };
  } },
  { name: "registered uncertain child association", setup(r) {
    r.request("A"); const run = r.reserve();
    return { type: "activity_start", id: "start-child", actor: "W", runId: run.id, activityId: "child", requestIds: ["A"], status: "uncertain" };
  } },
  { name: "explicit background activity resolution evidence", setup(r) {
    r.request("A"); const run = r.reserve();
    r.add({ type: "activity_start", actor: "W", runId: run.id, activityId: "child", requestIds: ["A"], status: "uncertain" });
    return { type: "activity_status", id: "done-child", actor: "$system", activityId: "child", status: "done", evidence: "FAKE correlated proof" };
  } },
  { name: "named status subscription", setup(r) {
    r.request("A"); return { type: "subscribe", actor: "O", id: "subscribe", requestId: "A", milestones: ["ready"], enabled: true };
  } },
  { name: "silent status consumption without acknowledgement", setup(r) {
    r.request("A"); const run = r.reserve();
    r.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["ready"], enabled: true });
    r.add(r.outputCommand(run, { kind: "progress", requestIds: ["A"], milestone: "ready" }));
    const observer = r.reserve("O"); return r.outputCommand(observer, { kind: "silent" });
  } },
  { name: "reserve with exact frozen input and dispatch IDs (T6)", setup(r) { r.request("A"); return r.reserveCommand(); } },
  { name: "output/multiple-claims/cursor/release finish after a confirmed sync (T8)", setup(r) {
    r.request("A"); r.request("B"); const run = r.reserve(); r.request("C"); const receipt = r.sync(run); r.request("D");
    r.add({ type: "confirm_sync", actor: "$system", id: "confirm", runId: run.id, receiptId: receipt.id, digest: receipt.digest, evidence: "FAKE exact receipt in the transcript" });
    return r.outputCommand(run, { kind: "answer", requestIds: ["A", "B", "C"] });
  } },
  { name: "error/output/bounded-notice/cursor/release", setup(r) {
    r.request("A"); const run = r.reserve(); return r.outputCommand(run, { kind: "error", requestIds: ["A"] }, { body: "failed" });
  } },
  { name: "cancel during a run", setup(r) {
    r.request("A"); r.reserve(); return { type: "cancel", actor: "$user", id: "cancel", requestId: "A" };
  } },
  { name: "transfer retirement/ownership/return endpoint/unread bundle", setup(r) {
    r.request("A"); r.request("review", "V", "W", "A"); const v = r.reserve("V");
    r.add(r.outputCommand(v, { kind: "answer", requestIds: ["review"] }));
    r.request("awaited", "X", "W", "A");
    return { type: "transfer", actor: "$user", id: "transfer", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2",
      owned: ["A"], awaited: ["awaited"], body: "replacement", evidence: "FAKE quiescence evidence only" };
  } },
  { name: "background activity evidence/output/answer claims", setup(r) {
    r.request("A"); const run = r.reserve();
    r.add({ type: "activity_start", actor: "W", activityId: "child", runId: run.id, requestIds: ["A"], status: "pending" });
    r.add(r.outputCommand(run, { kind: "yield" }));
    return r.outputCommand(run, { kind: "answer", requestIds: ["A"] }, { association: { kind: "activity", id: "child" }, terminal: false, activityCompletion: "done" });
  } },
  { name: "explicit rejected-run release and deliberate retry input", setup(r) {
    r.request("A"); const run = r.reserve("W", false);
    r.add({ type: "phase", actor: "$system", runId: run.id, phase: "rejected", evidence: "FAKE definite rejection" });
    return { type: "retry", actor: "$user", id: "retry", runId: run.id, body: "explicit retry" };
  } },
];

// About fifteen real child processes in a row: a limit well above the suite's 20 s default, for a loaded machine.
for (const scenario of scenarios) test(`process SIGKILL before/within/after transaction: ${scenario.name}`, { timeout: 120_000 }, async () => {
  // Each injection owns a real DB file and child process. Kill while the transaction
  // is open, never simulate durability by throwing from a mocked database method.
  const probe = new DiskRoom(); let eventCount: number;
  try { const command = scenario.setup(probe); eventCount = decide(probe.store.load(probe.room), command).events.length; }
  finally { probe.cleanup(); }
  assert.ok(eventCount! > 0);
  const faults = ["before_begin", "after_begin", "after_read", "after_decide",
    ...Array.from({ length: eventCount! }, (_, i) => `after_event:${i}`), "after_events", "after_index_delete",
    "after_projection", "after_indices", "before_commit", "after_commit"];
  for (const fault of faults) {
    const r = new DiskRoom();
    try {
      const command = scenario.setup(r);
      const before = r.store.load(r.room); const expected = decide(before, command);
      const marker = join(r.dir, "killed-at");
      const result = await worker({ path: r.path, room: r.room, command, fault, marker });
      assert.equal(result.signal, "SIGKILL", `${fault}: ${result.stdout} ${result.stderr}`);
      assert.equal(readFileSync(marker, "utf8"), fault);
      r.reopen();
      assert.deepEqual(r.store.load(r.room), fault === "after_commit" ? [...before, ...expected.events] : before, fault);
      r.parity();
      const replay = r.add(command);
      assert.equal(replay.replayed, fault === "after_commit", fault);
      assert.deepEqual(r.store.load(r.room), [...before, ...expected.events], fault);
      r.reopen(); r.parity();
      const head = r.store.load(r.room).length;
      assert.equal(r.add(command).replayed, true); assert.equal(r.store.load(r.room).length, head);
      if (scenario.name.includes("multiple-claims")) assert.deepEqual(unread(r.p, "W").map((i) => i.eventId), ["D"]);
      if (scenario.name.startsWith("transfer")) {
        assert.equal(r.p.seats.get("W")!.status, "retired");
        assert.equal(r.p.requests.get("awaited")!.returnTo, "W2");
        const transfer = unread(r.p, "W2")[0]!;
        assert.deepEqual(transfer.inherited.map((i) => i.eventId), ["A", before.find((e) => e.data.kind === "output")!.id]);
      }
    } finally { r.cleanup(); }
  }
});

test("process loss during index rebuild leaves either complete old or complete rebuilt indices, log unchanged", { timeout: 120_000 }, async () => {
  const r = new DiskRoom();
  try {
    r.request("A"); r.reserve(); const log = r.store.load(r.room);
    for (const fault of ["after_index_delete", "after_projection", "before_commit", "after_commit"] as const) {
      const raw = new DatabaseSync(r.path); raw.exec("DELETE FROM engine_projection"); raw.close();
      const beforeAudit = r.store.audit(r.room);
      assert.deepEqual(beforeAudit.mismatches, ["projections"]);
      const marker = join(r.dir, "killed-rebuild");
      const result = await worker({ path: r.path, room: r.room, command: r.reserveCommand(), action: "rebuild", fault, marker });
      assert.equal(result.signal, "SIGKILL", result.stdout + result.stderr);
      assert.equal(readFileSync(marker, "utf8"), fault);
      r.reopen();
      assert.deepEqual(r.store.audit(r.room), fault === "after_commit" ? { ...beforeAudit, ok: true, mismatches: [] } : beforeAudit);
      assert.deepEqual(r.store.load(r.room), log); r.store.rebuild(r.room); r.parity();
    }
  } finally { r.cleanup(); }
});

async function race(r: DiskRoom, a: Command, b: Command) {
  const ready = [join(r.dir, "ready-a"), join(r.dir, "ready-b")]; const go = join(r.dir, "go");
  const promises = [worker({ path: r.path, room: r.room, command: a, ready: ready[0]!, go }),
    worker({ path: r.path, room: r.room, command: b, ready: ready[1]!, go })];
  await waitForFiles(ready); writeFileSync(go, "go");
  const results = await Promise.all(promises); r.reopen(); r.parity();
  return results.map((r) => { assert.equal(r.signal, null, r.stderr); return JSON.parse(r.stdout) as { ok: boolean; error?: string; receipt?: { replayed: boolean; outcome: string } }; });
}

test("competing processes reserve only one unresolved run for one seat", async () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const results = await race(r, r.reserveCommand("W", "a"), r.reserveCommand("W", "b"));
    assert.equal(results.filter((r) => r.ok).length, 1); assert.match(results.find((r) => !r.ok)!.error!, /unresolved/);
    assert.equal(r.store.recovery(r.room).runs.length, 1); assert.equal(r.p.seats.get("W")!.cursor, 0);
  } finally { r.cleanup(); }
});

test("two open connections cannot reserve the same seat or mutate frozen input after the winning prefix", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const second = new EngineStore(r.path);
    try {
      const c = r.reserveCommand("W", "a"); r.add(c);
      second.execute(r.room, { type: "request", id: "B", actor: "O", to: "W", body: "arrived after prefix" });
      assert.throws(() => second.execute(r.room, r.reserveCommand("W", "b")), /unresolved/);
      const run = r.store.recovery(r.room).runs[0]!;
      assert.deepEqual(run.envelope.inputs.map((i) => i.eventId), ["A"]);
      assert.deepEqual(unread(r.p, "W").map((i) => i.eventId), ["A", "B"]);
    } finally { second.close(); }
    r.parity();
  } finally { r.cleanup(); }
});

test("competing same-command commits replay one receipt; conflicting same-command payload has exactly one winner", async () => {
  for (const conflict of [false, true]) {
    const r = new DiskRoom();
    try {
      const c: Command = { type: "request", id: "A", actor: "O", to: "W", body: "one" };
      const results = await race(r, c, conflict ? { ...c, body: "two" } : c);
      assert.equal(r.store.load(r.room).filter((e) => e.id === "A").length, 1);
      if (conflict) { assert.equal(results.filter((r) => r.ok).length, 1); assert.match(results.find((r) => !r.ok)!.error!, /conflicting command/); }
      else { assert.ok(results.every((r) => r.ok)); assert.equal(results.filter((r) => r.receipt!.replayed).length, 1); }
    } finally { r.cleanup(); }
  }
});

test("competing source imports commit one output/claim/cursor/release and changed source identity is rejected", async () => {
  for (const conflict of [false, true]) {
    const r = new DiskRoom();
    try {
      r.request("A"); const run = r.reserve(); const a = r.outputCommand(run, { kind: "answer", requestIds: ["A"] });
      const b = { ...a, id: "other-import", ...(conflict ? { body: "conflicting" } : {}) } as Command;
      const results = await race(r, a, b);
      if (conflict) { assert.equal(results.filter((r) => r.ok).length, 1); assert.match(results.find((r) => !r.ok)!.error!, /conflicting provider source/); }
      else assert.ok(results.every((r) => r.ok));
      assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "output").length, 1);
      assert.equal(r.store.load(r.room).filter((e) => e.data.kind === "run.ended").length, 1);
      assert.equal(r.p.requests.get("A")!.state, "answered"); assert.equal(r.p.seats.get("W")!.activeRunId, null);
    } finally { r.cleanup(); }
  }
});

for (const change of ["cancel", "correct"] as const) test(`competing ${change}/answer processes enforce the serialized lawful claim`, async () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    const command: Command = change === "cancel" ? { type: "cancel", actor: "$user", id: "change", requestId: "A" }
      : { type: "correct", actor: "$user", id: "change", requestId: "A", body: "amended requirements" };
    const results = await race(r, command, r.outputCommand(run, { kind: "answer", requestIds: ["A"] }));
    const log = r.store.load(r.room); const output = log.find((e) => e.data.kind === "output")!;
    const mutation = log.find((e) => e.id === "change");
    assert.equal(output.data.kind, "output");
    if (output.data.kind === "output") {
      const outcome = output.data.claims[0]!.outcome;
      assert.equal(outcome, mutation && mutation.seq < output.seq ? change === "cancel" ? "late" : "superseded" : "answered");
      assert.equal(r.p.requests.get("A")!.state, outcome === "answered" ? "answered" : change === "cancel" ? "cancelled" : "open");
    }
    if (change === "correct" && !mutation) assert.match(results.find((r) => !r.ok)!.error!, /closed request/);
  } finally { r.cleanup(); }
});

test("a process blocked behind another writer decides again from the winning head, never from its earlier observation", async () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve(); const oldHead = r.store.load(r.room).length;
    const readyA = join(r.dir, "ready-a"), readyB = join(r.dir, "ready-b"), goA = join(r.dir, "go-a"), goB = join(r.dir, "go-b");
    const holdReady = join(r.dir, "locked"), holdGo = join(r.dir, "release");
    const a = worker({ path: r.path, room: r.room, command: { type: "correct", actor: "$user", id: "correction", requestId: "A", body: "must see this" }, ready: readyA, go: goA, holdReady, holdGo });
    const b = worker({ path: r.path, room: r.room, command: r.outputCommand(run, { kind: "answer", requestIds: ["A"] }), ready: readyB, go: goB });
    await waitForFiles([readyA, readyB]); writeFileSync(goA, "go"); await waitForFiles([holdReady]);
    writeFileSync(goB, "go"); writeFileSync(holdGo, "release");
    const results = await Promise.all([a, b]); assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
    r.reopen(); r.parity();
    const output = r.store.load(r.room).find((e) => e.data.kind === "output")!;
    if (output.data.kind === "output") assert.equal(output.data.claims[0]!.outcome, "superseded");
    const receipt = JSON.parse(results[1]!.stdout).receipt;
    assert.equal(receipt.expectedSeq, oldHead + 1); assert.equal(r.p.requests.get("A")!.state, "open");
  } finally { r.cleanup(); }
});
