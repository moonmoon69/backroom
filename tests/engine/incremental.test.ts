import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EngineStore, decide, fold } from "../../src/engine/index.ts";
import type { Command, LocalOperationPacket, NativeToolSource, Projection, RunCapability, StoreBoundary } from "../../src/engine/index.ts";
import { hash, T3_CONTRACT_ID, T3_SERVER_VERSION } from "../../src/engine/provider.ts";
import { canonicalJSON } from "../../src/engine/result.ts";
import { EntryOverlay } from "../../src/engine/incremental.ts";
import { DiskRoom, waitForFiles, worker } from "./store-fixture.ts";
import type { WorkerInput, WorkerResult } from "./store-fixture.ts";
import type { IncrementalWorkerInput } from "./incremental-worker.ts";

interface Probe {
  db: DatabaseSync;
  caches: Map<string, { p: Projection }>;
  coldCache(room: string, version: number): unknown;
  rows(room: string, after?: number): unknown[];
  replaceIndices(room: string, derived: unknown, instrument: boolean): void;
}
function probe(store: EngineStore): Probe { return store as unknown as Probe; }
function parity(r: DiskRoom): void {
  assert.deepEqual(r.p, fold(r.store.load(r.room)));
  assert.deepEqual(r.store.audit(r.room), { ok: true, mismatches: [], head: r.store.load(r.room).length });
}
const mutations: [string, (db: DatabaseSync, room: string) => void][] = [
  ["projection", (db, room) => { db.prepare("UPDATE engine_projection SET value='{}' WHERE room=? AND kind='requests' AND id='B'").run(room); }],
  ["command", (db, room) => { db.prepare("UPDATE engine_command SET digest=? WHERE room=? AND key=?").run("f".repeat(64), room, JSON.stringify(["O", "B"])); }],
  ["key", (db, room) => { db.prepare("UPDATE engine_key SET owner='forged-owner' WHERE room=? AND kind='thread' AND key='thread:V'").run(room); }],
  ["missing projection", (db, room) => { db.prepare("DELETE FROM engine_projection WHERE room=? AND kind='requests' AND id='B'").run(room); }],
  ["missing command", (db, room) => { db.prepare("DELETE FROM engine_command WHERE room=? AND key=?").run(room, JSON.stringify(["O", "B"])); }],
  ["missing key", (db, room) => { db.prepare("DELETE FROM engine_key WHERE room=? AND kind='thread' AND key='thread:V'").run(room); }],
];
function seed(r: DiskRoom): void { r.request("A"); r.request("B", "V"); r.reserve(); r.store.project(r.room); }

for (const foreign of [false, true]) test(`incremental ${foreign ? "foreign suffix" : "own mutation"} audit uses verified canonical cache without refolding history`, () => {
  const r = new DiskRoom(); let other: EngineStore | undefined;
  try {
    seed(r); const instrument = probe(r.store);
    let cold = 0, historicalReplay = 0;
    const originalCold = instrument.coldCache.bind(r.store), originalRows = instrument.rows.bind(r.store);
    instrument.coldCache = (...args) => { cold++; return originalCold(...args); };
    instrument.rows = (room, after = 0) => { if (!after) historicalReplay++; return originalRows(room, after); };
    if (foreign) {
      other = new EngineStore(r.path);
      other.execute(r.room, { type: "post", actor: "O", id: "foreign-cache-audit", intent: "note", body: "Valid suffix" });
      const raw = new DatabaseSync(r.path);
      try { mutations[0]![1](raw, r.room); } finally { raw.close(); }
    } else mutations[0]![1](instrument.db, r.room);
    assert.equal(r.add({ type: "request", id: "B", actor: "O", to: "V", body: "Content B" }).replayed, true);
    assert.deepEqual({ cold, historicalReplay }, { cold: 0, historicalReplay: 0 });
    instrument.coldCache = originalCold; instrument.rows = originalRows;
    parity(r);
  } finally { other?.close(); r.cleanup(); }
});

for (const [name, mutate] of mutations) test(`incremental same-connection ${name} corruption audits despite unchanged head/data_version`, () => {
  const r = new DiskRoom();
  try {
    seed(r); const db = probe(r.store).db;
    const version = db.prepare("PRAGMA data_version").get(), head = db.prepare("SELECT seq FROM engine_head WHERE room=?").get(r.room);
    mutate(db, r.room);
    assert.deepEqual(db.prepare("PRAGMA data_version").get(), version);
    assert.deepEqual(db.prepare("SELECT seq FROM engine_head WHERE room=?").get(r.room), head);
    const replay = r.add({ type: "request", id: "B", actor: "O", to: "V", body: "Content B" });
    assert.equal(replay.replayed, true); parity(r);
    assert.throws(() => r.add({ type: "request", id: "B", actor: "O", to: "V", body: "Conflicting B" }), /conflicting command/);
    parity(r);
  } finally { r.cleanup(); }
});

for (const [name, mutate] of mutations) test(`incremental foreign complete suffix plus untouched ${name} corruption audits all rows`, () => {
  const r = new DiskRoom(); let other: EngineStore | undefined;
  try {
    seed(r); other = new EngineStore(r.path);
    other.execute(r.room, { type: "post", actor: "O", id: "foreign-note", intent: "note", body: "Valid foreign complete batch" });
    const raw = new DatabaseSync(r.path); try { mutate(raw, r.room); } finally { raw.close(); }
    r.add({ type: "post", actor: "O", intent: "note", body: "Warm local append after foreign mutation" });
    parity(r);
    assert.throws(() => r.add({ type: "request", id: "B", actor: "O", to: "V", body: "Conflicting B" }), /conflicting command/);
    assert.equal(r.p.requests.get("B")!.body, "Content B");
  } finally { other?.close(); r.cleanup(); }
});

for (const removal of ["reservation", "blocked delivery", "subscription"] as const) test(`incremental first command after foreign suffix removes its ${removal} row`, () => {
  const r = new DiskRoom(); let other: EngineStore | undefined;
  try {
    r.request("A"); r.store.project(r.room);
    const prefixHead = probe(r.store).caches.get(r.room)!.p.events.length;
    other = new EngineStore(r.path);
    let command: Command;
    if (removal === "reservation") {
      const reserve = r.reserveCommand("W", "foreign-reservation") as Extract<Command, { type: "reserve" }>;
      other.execute(r.room, reserve);
      other.execute(r.room, { type: "phase", actor: "$system", id: "foreign-accept", runId: reserve.runId, phase: "accepted", evidence: "isolated receipt" });
      command = r.outputCommand(other.project(r.room).runs.get(reserve.runId)!, { kind: "answer", requestIds: ["A"] });
    } else if (removal === "blocked delivery") {
      const blocked = other.execute(r.room, { ...r.reserveCommand("W", "foreign-blocked"), maxBytes: 1 } as Command);
      assert.equal(blocked.outcome, "blocked");
      assert.equal(other.project(r.room).blocked.has("W"), true);
      command = r.reserveCommand("W", "local-reservation");
    } else {
      other.execute(r.room, { type: "subscribe", actor: "O", id: "foreign-subscription", requestId: "A", milestones: ["ready"], enabled: true });
      assert.equal(other.project(r.room).subscriptions.length, 1);
      command = { type: "subscribe", actor: "O", id: "local-unsubscribe", requestId: "A", milestones: ["ready"], enabled: false };
    }
    // No load/project/retry on the warm writer may absorb the suffix before this command.
    assert.equal(probe(r.store).caches.get(r.room)!.p.events.length, prefixHead);
    const winningHead = (probe(r.store).db.prepare("SELECT seq FROM engine_head WHERE room=?").get(r.room) as { seq: number }).seq;
    assert.ok(winningHead > prefixHead);
    const receipt = r.add(command);
    assert.equal(receipt.expectedSeq, winningHead);
    assert.equal(receipt.outcome, "appended");
    if (removal === "reservation") assert.equal(r.p.requests.get("A")!.state, "answered");
    else if (removal === "blocked delivery") assert.equal(r.p.blocked.has("W"), false);
    else assert.equal(r.p.subscriptions.length, 0);
    assert.equal(r.add(command).replayed, true); parity(r);
    r.reopen(); parity(r); r.store.rebuild(r.room); parity(r);
  } finally { other?.close(); r.cleanup(); }
});

test("incremental entry overlays retain native Map order through repeated insertion, deletion and nested publication", () => {
  const base = new Map([["W", 1], ["V", 2], ["X", 3]]), initial = [...base];
  const overlay = new EntryOverlay(base), expected = new Map(base);
  const check = (map: Map<string, number>) => {
    assert.deepEqual([...map], [...expected]);
    assert.deepEqual([...map.keys()], [...expected.keys()]);
    assert.deepEqual([...map.values()], [...expected.values()]);
    const visits: [string, number][] = []; map.forEach((v, k) => visits.push([k, v]));
    assert.deepEqual(visits, [...expected]); assert.equal(map.size, expected.size);
  };
  // Replacement stays in place; deleting/reinserting base and newly added entries moves them.
  overlay.set("W", 4); expected.set("W", 4);
  overlay.set("new", 5); expected.set("new", 5);
  overlay.delete("W"); expected.delete("W"); overlay.set("W", 6); expected.set("W", 6);
  overlay.delete("new"); expected.delete("new"); overlay.set("other", 7); expected.set("other", 7);
  overlay.set("new", 8); expected.set("new", 8); check(overlay);
  assert.deepEqual([...base], initial);
  const nested = new EntryOverlay(overlay), parentBefore = [...overlay];
  nested.delete("V"); expected.delete("V"); nested.set("V", 9); expected.set("V", 9);
  nested.set("W", 10); expected.set("W", 10);
  nested.delete("other"); expected.delete("other"); nested.set("other", 11); expected.set("other", 11);
  check(nested); assert.deepEqual([...overlay], parentBefore); assert.deepEqual([...base], initial);
  nested.publish(); check(overlay); assert.deepEqual([...base], initial);
  overlay.publish(); check(base);
});

test("incremental overlay order matches native Map after deterministic mixed edits and discarded changes", () => {
  let state = 0x6c91b342;
  const random = (n: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  for (let round = 0; round < 30; round++) {
    const base = new Map<string, number>(Array.from({ length: 6 }, (_, i) => [`key:${i}`, i] as const)), initial = [...base];
    const overlay = new EntryOverlay<string, number>(base), expected = new Map<string, number>(base);
    for (let i = 0; i < 120; i++) {
      const key = `key:${random(12)}`, operation = random(8);
      if (operation < 4) { overlay.set(key, i); expected.set(key, i); }
      else if (operation < 7) assert.equal(overlay.delete(key), expected.delete(key));
      else { overlay.clear(); expected.clear(); }
      assert.deepEqual([...overlay], [...expected]); assert.equal(overlay.size, expected.size);
      assert.deepEqual([...base], initial);
    }
    overlay.publish(); assert.deepEqual([...base], [...expected]);
    const discarded = new EntryOverlay(base);
    discarded.delete("key:0"); discarded.set("key:0", -1); discarded.set("discarded", -2);
    discarded.discardChanges(); assert.deepEqual([...discarded], [...base]);
    discarded.publish(); assert.deepEqual([...base], [...expected]);
  }
});

for (const action of ["read", "append", "abort"] as const) test(`incremental ordered blocked entries match replay after foreign delete/reinsert and ${action}`, () => {
  const r = new DiskRoom(); let other: EngineStore | undefined, armed = false;
  try {
    r.request("A"); r.request("B", "V");
    for (const seatId of ["W", "V"]) assert.equal(r.add({ ...r.reserveCommand(seatId), maxBytes: 1 } as Command).outcome, "blocked");
    if (action === "abort") r.reopen({ onBoundary(point) { if (armed && point === "after_decide") throw new Error("abort ordered suffix overlay"); } });
    assert.deepEqual([...r.p.blocked.keys()], ["W", "V"]);
    const committed = probe(r.store).caches.get(r.room)!.p;
    other = new EngineStore(r.path);
    const reserve = r.reserveCommand("W", "foreign-ordered-reserve") as Extract<Command, { type: "reserve" }>;
    other.execute(r.room, reserve);
    other.execute(r.room, { type: "phase", id: "foreign-ordered-accept", actor: "$system", runId: reserve.runId, phase: "accepted", evidence: "isolated receipt" });
    other.execute(r.room, r.outputCommand(other.project(r.room).runs.get(reserve.runId)!, { kind: "answer", requestIds: ["A"] }));
    other.execute(r.room, { type: "request", id: "A2", actor: "O", to: "W", body: "New work W" });
    assert.equal(other.execute(r.room, { ...r.reserveCommand("W", "foreign-ordered-blocked"), maxBytes: 1 } as Command).outcome, "blocked");
    assert.deepEqual([...committed.blocked.keys()], ["W", "V"]);
    const expected = [...fold(other.load(r.room)).blocked]; assert.deepEqual(expected.map(([k]) => k), ["V", "W"]);
    const note: Command = { type: "post", id: "ordered-local-note", actor: "O", intent: "note", body: "Keep ordered suffix" };
    if (action === "abort") {
      const journal = other.load(r.room); armed = true;
      assert.throws(() => r.add(note), /abort ordered suffix overlay/); armed = false;
      assert.deepEqual([...committed.blocked.keys()], ["W", "V"]);
      assert.deepEqual(other.load(r.room), journal);
      r.add(note);
    } else if (action === "append") r.add(note);
    assert.deepEqual([...r.p.blocked], expected);
    assert.deepEqual([...probe(r.store).caches.get(r.room)!.p.blocked], expected);
    assert.deepEqual([...r.p.blocked], expected); parity(r);
    r.reopen(); assert.deepEqual([...r.p.blocked], expected);
    r.store.rebuild(r.room); assert.deepEqual([...r.p.blocked], expected); parity(r);
  } finally { armed = false; other?.close(); r.cleanup(); }
});

for (const name of ["source", "claim"]) test(`incremental erased ${name} index cannot authorize conflicting source or duplicate claim`, () => {
  const r = new DiskRoom();
  try {
    r.request("A"); const run = r.reserve();
    const original = r.outputCommand(run, { kind: "answer", requestIds: ["A"] }); r.add(original);
    probe(r.store).db.prepare("DELETE FROM engine_key WHERE room=? AND kind=?").run(r.room, name);
    r.add({ type: "post", actor: "O", intent: "note", body: "Validate private-connection mutation" }); parity(r);
    assert.throws(() => r.add({ ...original, id: "changed-source", body: "Conflicting source" } as Command), /conflicting provider source/);
    const second = r.add({ ...original, id: "independent-source", sourceKey: "another-source", terminal: false } as Command);
    const output = second.events.find((e) => e.data.kind === "output")!;
    if (output.data.kind === "output") assert.equal(output.data.claims[0]!.outcome, "already_answered");
    assert.equal(r.store.load(r.room).flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.outcome === "answered").length, 1);
    parity(r);
  } finally { r.cleanup(); }
});

for (const damage of ["batch-size", "batch-digest", "batch-start", "gap", "unknown-event-kind", "head-rollback"]) test(`incremental malformed foreign ${damage} fails closed without journal rewrite`, () => {
  const r = new DiskRoom(); let other: EngineStore | undefined;
  try {
    r.request("A"); const run = r.reserve(); r.store.project(r.room); other = new EngineStore(r.path);
    const output = r.outputCommand(run, { kind: "answer", requestIds: ["A"] }); other.execute(r.room, output);
    const raw = new DatabaseSync(r.path);
    try {
      raw.exec("DROP TRIGGER engine_event_no_update; DROP TRIGGER engine_event_no_delete");
      const first = (raw.prepare("SELECT MIN(seq) AS n FROM engine_event WHERE room=? AND command_key=?").get(r.room, JSON.stringify([output.actor, output.id])) as { n: number }).n;
      if (damage === "batch-size") raw.prepare("UPDATE engine_event SET batch_size=batch_size+1 WHERE room=? AND seq=?").run(r.room, first);
      if (damage === "batch-digest") raw.prepare("UPDATE engine_event SET command_digest=? WHERE room=? AND seq=?").run("a".repeat(64), r.room, first + 1);
      if (damage === "batch-start") raw.prepare("UPDATE engine_event SET batch_start=batch_start+1 WHERE room=? AND seq=?").run(r.room, first);
      if (damage === "gap") raw.prepare("DELETE FROM engine_event WHERE room=? AND seq=?").run(r.room, first + 1);
      if (damage === "unknown-event-kind") raw.prepare("UPDATE engine_event SET data='{}' WHERE room=? AND seq=?").run(r.room, first);
      if (damage === "head-rollback") raw.prepare("UPDATE engine_head SET seq=seq-1 WHERE room=?").run(r.room);
      const before = raw.prepare("SELECT * FROM engine_event WHERE room=? ORDER BY seq").all(r.room);
      assert.throws(() => r.add({ type: "post", actor: "O", intent: "note", body: "Cannot append against malformed authority" }));
      assert.deepEqual(raw.prepare("SELECT * FROM engine_event WHERE room=? ORDER BY seq").all(r.room), before);
    } finally { raw.close(); }
  } finally { other?.close(); r.cleanup(); }
});

test("incremental missing head metadata repairs from journal; incompatible projection version is fenced", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); r.reserve(); const before = r.store.load(r.room), db = probe(r.store).db;
    const header = db.prepare("SELECT seq,version FROM engine_head WHERE room=?").get(r.room) as { seq: number; version: number };
    db.prepare("DELETE FROM engine_head WHERE room=?").run(r.room);
    r.add({ type: "post", actor: "O", id: "after-missing-head", intent: "note", body: "Journal repairs disposable metadata" }); parity(r);
    assert.deepEqual(r.store.load(r.room).slice(0, before.length), before);
    db.prepare("UPDATE engine_head SET version=? WHERE room=?").run(header.version + 1, r.room);
    assert.throws(() => r.add({ type: "post", actor: "O", intent: "note", body: "Unknown projection version" }), /incompatible projection version/);
    r.store.rebuild(r.room); parity(r);
  } finally { r.cleanup(); }
});

for (const point of ["after_begin", "after_read", "after_decide", "after_events", "after_indices", "before_commit"] as const) test(`incremental unexplained hook writes at ${point} fail closed`, () => {
  const r = new DiskRoom(); let armed = false;
  try {
    seed(r); r.reopen({ onBoundary(current) {
      if (armed && current === point) probe(r.store).db.prepare("UPDATE engine_projection SET value='{}' WHERE room=? AND kind='requests' AND id='B'").run(r.room);
    } });
    const run = r.p.runs.values().next().value!; const before = r.store.load(r.room); armed = true;
    assert.throws(() => r.add(r.outputCommand(run, { kind: "answer", requestIds: ["A"] })), /unexplained.*writes/);
    armed = false; assert.deepEqual(r.store.load(r.room), before); parity(r);
    r.add(r.outputCommand(run, { kind: "answer", requestIds: ["A"] })); parity(r);
  } finally { armed = false; r.cleanup(); }
});

test("incremental warm notes do no full replay/replacement/old-payload cloning and preserve existing index rows", () => {
  const r = new DiskRoom();
  try {
    r.request("A"); r.request("B", "V"); r.reserve(); r.store.project(r.room);
    const instrument = probe(r.store), cache = instrument.caches.get(r.room)!;
    let cold = 0, fullRows = 0, replacements = 0, oldPayloadReads = 0;
    const originalCold = instrument.coldCache.bind(r.store), originalRows = instrument.rows.bind(r.store), originalReplace = instrument.replaceIndices.bind(r.store);
    instrument.coldCache = (...args) => { cold++; return originalCold(...args); };
    instrument.rows = (room, after = 0) => { if (!after) fullRows++; return originalRows(room, after); };
    instrument.replaceIndices = (...args) => { replacements++; return originalReplace(...args); };
    const request = cache.p.requests.get("B")!, body = request.body;
    Object.defineProperty(request, "body", { enumerable: true, configurable: true, get() { oldPayloadReads++; return body; } });
    const event = cache.p.events.find((e) => e.data.kind === "request" && e.data.request.id === "B")!;
    assert.equal(event.data.kind, "request");
    if (event.data.kind === "request") Object.defineProperty(event.data.request, "body", { enumerable: true, configurable: true, get() { oldPayloadReads++; return body; } });
    const existing = instrument.db.prepare("SELECT kind,id,value FROM engine_projection WHERE room=? ORDER BY kind,id").all(r.room);
    for (let i = 0; i < 30; i++) r.add({ type: "post", actor: "O", id: `warm-note:${i}`, intent: "note", body: "x".repeat(1024) });
    assert.deepEqual({ cold, fullRows, replacements, oldPayloadReads }, { cold: 0, fullRows: 0, replacements: 0, oldPayloadReads: 0 });
    assert.deepEqual(instrument.db.prepare("SELECT kind,id,value FROM engine_projection WHERE room=? ORDER BY kind,id").all(r.room), existing);
    Object.defineProperty(request, "body", { enumerable: true, configurable: true, writable: true, value: body });
    if (event.data.kind === "request") Object.defineProperty(event.data.request, "body", { enumerable: true, configurable: true, writable: true, value: body });
    instrument.coldCache = originalCold; instrument.rows = originalRows; instrument.replaceIndices = originalReplace;
    parity(r);
  } finally { r.cleanup(); }
});

function finishPacket(r: DiskRoom): LocalOperationPacket {
  r.request("A"); const run = r.reserve();
  const wireJSON = JSON.stringify({ type: "message.dispatch", threadId: "thread:W", commandId: run.dispatchCommandId, messageId: run.dispatchMessageId,
    dispatchMode: { type: "start_immediately" }, attachments: [], text: JSON.stringify({ schema: "backroom.envelope.v1", runId: run.id, envelope: run.envelope }) });
  const transport = { wireJSON, digest: hash(wireJSON), environmentId: "local-simulation", serverVersion: T3_SERVER_VERSION, contract: T3_CONTRACT_ID };
  r.add({ type: "freeze_transport", actor: "$system", target: { kind: "run", id: run.id }, transport });
  r.add({ type: "bind_provider", actor: "$system", runId: run.id, providerRunId: "native-run", evidence: "isolated original receipt" });
  const capability: RunCapability = { id: "cap-original", tokenHash: hash("secret"), seatId: "W", threadId: "thread:W", runId: run.id, generation: 1,
    server: "backroom-board", environmentId: transport.environmentId, serverVersion: transport.serverVersion, contract: transport.contract };
  r.add({ type: "authorize_run", actor: "$system", capability });
  const intent: LocalOperationPacket["intent"] = { schema: "backroom.operation.v1", operation: "finish", clientId: "finish", nonce: "original-nonce", originRunId: run.id,
    toolRefs: [], body: "Explicit receipt answer", disposition: { kind: "answer", requestIds: ["A"] } };
  const source: NativeToolSource = { threadId: "thread:W", providerRunId: "native-run", itemId: "finish", nodeId: "node:finish", rootNodeId: "root",
    providerThreadId: "provider-thread", providerTurnId: "provider-turn", attemptId: "attempt", generation: 1,
    nativeRef: { driver: "codex", nativeId: "native-finish", strength: "strong" }, type: "dynamic_tool", status: "running",
    toolName: "backroom-board.finish", toolSource: { kind: "integration", key: "mcp:backroom-board" }, input: structuredClone(intent),
    updatedAt: "2026-10-07T04:00:00.000Z", sequence: 1, complete: true, issues: [] };
  r.add({ type: "observe_provider", actor: "$system", observation: { seatId: "W", threadId: "thread:W", environmentId: transport.environmentId,
    serverVersion: transport.serverVersion, contract: transport.contract, sequence: 1, sources: [source] }, pending: [], settled: [] });
  return { capabilityId: capability.id, intent, intentJSON: canonicalJSON(intent), source, tools: [], view: [], sequence: 1,
    sourceCheckpointDigest: hash(canonicalJSON([source])) };
}

for (const fault of ["after_event", "after_indices", "before_commit"] as const) test(`incremental nested finish rollback at ${fault} and returned receipt mutations stay isolated`, () => {
  const r = new DiskRoom(); let armed = false;
  try {
    const packet = finishPacket(r), before = r.p;
    r.reopen({ onBoundary(point) { if (armed && point === fault) throw new Error(`forced ${fault}`); } });
    armed = true; assert.throws(() => r.store.commitOperation(r.room, packet), /forced/); armed = false;
    assert.deepEqual(r.p, before); parity(r);
    const first = r.store.commitOperation(r.room, packet), bytes = first.receipt.responseJSON;
    first.receipt.result.claims.length = 0; first.receipt.packet.source.issues.push("caller-mutated"); first.receipt.responseJSON = "caller-mutated";
    const lookup = r.store.lookupOperation(r.room, packet.capabilityId, packet.intentJSON)!;
    lookup.result.claims.length = 0; lookup.packet.source.issues.push("caller-mutated lookup");
    const projected = r.p; projected.operationReceipts.clear(); projected.operationBindings.clear(); projected.providerHolds.clear(); projected.requests.get("A")!.state = "open";
    const unavailable: LocalOperationPacket = { ...packet, source: { ...packet.source, input: null, complete: false, issues: ["provider unavailable"] }, sequence: -1 };
    const recovered = r.store.commitOperation(r.room, unavailable);
    assert.equal(recovered.replayed, true); assert.equal(recovered.receipt.responseJSON, bytes); assert.equal(r.p.requests.get("A")!.state, "answered"); parity(r);
  } finally { armed = false; r.cleanup(); }
});

function incrementalWorker(input: IncrementalWorkerInput): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", new URL("./incremental-worker.ts", import.meta.url).pathname, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); }); child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`incremental worker timeout: ${stdout} ${stderr}`)); }, 12_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
const boundaries: StoreBoundary[] = ["after_suffix_load", "after_affected_first", "after_affected_last", "after_head", "after_commit", "before_cache_publish", "after_cache_publish"];
const durable = new Set<StoreBoundary>(["after_commit", "before_cache_publish", "after_cache_publish"]);
for (const scenario of ["note", "answer", "sync", "local receipt"] as const) for (const boundary of boundaries) test(`incremental real SIGKILL ${scenario} at ${boundary}`, async () => {
  const r = new DiskRoom(); let foreign: EngineStore | undefined;
  try {
    let command: Command, packet: LocalOperationPacket | undefined;
    if (scenario === "note") command = { type: "post", actor: "O", id: "killed-note", intent: "note", body: "Atomic passive note" };
    else if (scenario === "local receipt") { packet = finishPacket(r); command = { type: "post", actor: "O", id: "unused-command", intent: "note", body: "not executed" }; }
    else {
      r.request("A"); const run = r.reserve();
      if (scenario === "answer") command = r.outputCommand(run, { kind: "answer", requestIds: ["A"] });
      else { r.request("B"); command = { type: "sync", actor: "$system", id: "killed-sync", runId: run.id, receiptId: "killed-receipt", maxBytes: 1_000_000 }; }
    }
    const marker = join(r.dir, "kill-marker"), ready = join(r.dir, "worker-ready"), go = join(r.dir, "worker-go");
    const input: WorkerInput = { path: r.path, room: r.room, command, fault: boundary, marker };
    const suffix = boundary === "after_suffix_load";
    const pending = suffix || packet ? incrementalWorker({ ...input, warm: true, ...(packet ? { packet } : {}), ready, go }) : worker(input);
    if (suffix || packet) {
      await waitForFiles([ready]);
      if (suffix) { foreign = new EngineStore(r.path); foreign.execute(r.room, { type: "post", actor: "O", id: "foreign-before-kill", intent: "note", body: "Valid complete foreign suffix" }); }
    }
    const before = r.store.load(r.room), decision = packet ? null : decide(before, command);
    if (suffix || packet) writeFileSync(go, "execute target");
    const result = await pending;
    assert.equal(result.signal, "SIGKILL", `${boundary} not reached: ${result.stdout} ${result.stderr}`);
    assert.equal(readFileSync(marker, "utf8"), boundary); r.reopen();
    if (!durable.has(boundary)) assert.deepEqual(r.store.load(r.room), before);
    else if (decision) assert.deepEqual(r.store.load(r.room), [...before, ...decision.events]);
    parity(r);
    const recovered = packet ? r.store.commitOperation(r.room, packet) : r.add(command);
    assert.equal(recovered.replayed, durable.has(boundary)); parity(r);
    if (packet) {
      const responseJSON = r.store.lookupOperation(r.room, packet.capabilityId, packet.intentJSON)!.responseJSON;
      const replay = r.store.commitOperation(r.room, { ...packet, source: { ...packet.source, complete: false, issues: ["provider unavailable"] }, sequence: -1 });
      assert.equal(replay.replayed, true); assert.equal(replay.receipt.responseJSON, responseJSON);
      assert.equal(r.p.requests.get("A")!.state, "answered");
    }
    r.reopen(); parity(r);
  } finally { foreign?.close(); r.cleanup(); }
});
