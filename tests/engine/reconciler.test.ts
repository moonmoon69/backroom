import assert from "node:assert/strict";
import { test } from "node:test";
import { DiskRoom } from "./store-fixture.ts";
import { EngineReconciler } from "../../src/engine/reconciler.ts";
import { FakeEngineProvider } from "../../src/adapter/engine-fake.ts";
import { hash } from "../../src/engine/provider.ts";
import type { ProviderEmission, ProviderSnapshot } from "../../src/engine/provider.ts";
import type { Run } from "../../src/engine/types.ts";
import { unread } from "../../src/engine/index.ts";

async function fixture() {
  const d = new DiskRoom(), f = new FakeEngineProvider();
  d.request("A"); const r = d.reserve("W", false);
  const x = new EngineReconciler(d.store, f);
  await x.prepareRun(d.room, r.id, { instanceId: "FAKE", model: "FAKE-model" });
  return { d, f, r, x };
}
async function accepted() {
  const v = await fixture(); await v.x.tick(v.d.room, "W"); await v.x.tick(v.d.room, "W"); return v;
}
function snapshot(f: FakeEngineProvider, thread = "thread:W"): ProviderSnapshot { return f.state.snapshots[thread]!; }
function finish(f: FakeEngineProvider, r: Run, extra: Partial<ProviderEmission> = {}): ProviderEmission {
  const s = snapshot(f), n = s.runs.find((n) => n.userMessageId === r.dispatchMessageId)!;
  n.status = "completed"; s.pending = []; s.idle = true; s.sequence++;
  const e: ProviderEmission = { id: "out:A", runId: n.id, activityId: null, body: "Answer A", disposition: { kind: "answer", requestIds: ["A"] }, receipts: [], final: true, complete: true, ...extra };
  s.emissions.push(e); return e;
}
function claims(d: DiskRoom): number { return d.store.load(d.room).flatMap((e) => e.data.kind === "output" ? e.data.claims : []).filter((c) => c.outcome === "answered").length; }

for (const boundary of ["after_freeze", "before_send", "after_send"] as const) test(`reload after response loss at ${boundary} recovers SAME run and IDs`, async () => {
  const { d, f, r } = await fixture();
  try {
    if (boundary === "after_freeze") {
      // Re-open freezes already committed bytes without invoking its hook or a provider write.
      assert.equal(f.state.sends.length, 0);
    } else {
      const x = new EngineReconciler(d.store, f, { onBoundary(b) { if (b === boundary) throw new Error("simulated owner loss"); } });
      await assert.rejects(x.tick(d.room, "W"), /owner loss/);
    }
    const wire = d.p.runs.get(r.id)!.transport!.wireJSON;
    d.reopen(); const x = new EngineReconciler(d.store, f);
    await x.prepareRun(d.room, r.id, { instanceId: "CHANGED", model: "CHANGED" });
    assert.equal(d.p.runs.get(r.id)!.transport!.wireJSON, wire);
    await x.tick(d.room, "W"); await x.tick(d.room, "W");
    assert.equal(f.state.sends.length, 1); assert.equal(d.p.runs.size, 1);
    assert.equal(d.p.runs.get(r.id)!.phase, "accepted"); assert.equal(d.p.seats.get("W")!.cursor, 0);
    assert.deepEqual(JSON.parse(f.state.sends[0]!), JSON.parse(wire)); d.parity();
  } finally { d.cleanup(); }
});

test("accepted before local receipt: full frozen input binds existing run without a resend", async () => {
  const { d, f, r, x } = await fixture();
  try { f.loseResponse = true; await x.tick(d.room, "W"); assert.equal(d.p.runs.get(r.id)!.phase, "uncertain");
    d.reopen(); const y = new EngineReconciler(d.store, f); await y.tick(d.room, "W"); await y.tick(d.room, "W");
    assert.equal(f.state.sends.length, 1); assert.ok(d.p.runs.get(r.id)!.providerRunId); assert.equal(d.p.runs.get(r.id)!.phase, "accepted");
  } finally { d.cleanup(); }
});

test("definite rejection differs from unknown acceptance and never advances cursor", async () => {
  const v = await fixture();
  try { v.f.reject = true; await v.x.tick(v.d.room, "W");
    assert.equal(v.d.p.runs.get(v.r.id)!.phase, "rejected");
    for (let i = 0; i < 8; i++) await v.x.tick(v.d.room, "W");
    assert.equal(v.f.state.sends.length, 1); assert.equal(v.d.p.seats.get("W")!.cursor, 0);
  } finally { v.d.cleanup(); }
  const w = await fixture();
  try { w.f.unknownWithoutAcceptance = true; w.f.capabilities.receiptLookup = false; await w.x.tick(w.d.room, "W");
    w.d.request("B"); w.d.reopen(); const y = new EngineReconciler(w.d.store, w.f);
    for (let i = 0; i < 8; i++) await y.tick(w.d.room, "W");
    assert.equal(w.f.state.sends.length, 1); assert.equal(w.d.p.runs.get(w.r.id)!.phase, "uncertain");
    assert.equal(w.d.p.runs.size, 1); assert.deepEqual(unread(w.d.p, "W").map((i) => i.eventId), ["A", "B"]);
    assert.ok((await y.tick(w.d.room, "W")).held.length); w.d.parity();
  } finally { w.d.cleanup(); }
});

test("resend requires durable same-ID dedupe AND authoritative receipt absence, and attempts are bounded", async () => {
  for (const disabled of ["durableSameId", "authoritativeAbsence", null] as const) {
    const { d, f, x, r } = await fixture();
    try { f.unknownWithoutAcceptance = true; if (disabled) f.capabilities[disabled] = false;
      await x.tick(d.room, "W"); for (let i = 0; i < 9; i++) await x.tick(d.room, "W");
      assert.equal(f.state.sends.length, disabled ? 1 : 2);
      assert.equal(new Set(f.state.sends).size, 1); assert.equal(d.p.runs.size, 1);
      assert.equal(d.p.runs.get(r.id)!.phase, "uncertain");
    } finally { d.cleanup(); }
  }
});

test("concurrent duplicate ticks acquire one durable attempt; no double dispatch", async () => {
  const { d, f, x } = await fixture();
  try { await Promise.all([x.tick(d.room, "W"), x.tick(d.room, "W"), x.tick(d.room, "W")]);
    assert.equal(f.state.sends.length, 1); d.parity();
  } finally { d.cleanup(); }
});

test("busy arrivals stay board input; no queue dispatch, rerender or new run", async () => {
  const { d, f, x, r } = await fixture();
  try { f.state.snapshots["thread:W"] = { ...(await f.inspect("thread:W")), idle: false, pending: ["runs:other"] };
    d.request("B"); await x.tick(d.room, "W"); assert.equal(f.state.sends.length, 0);
    assert.equal(d.p.runs.size, 1); assert.equal(d.p.runs.get(r.id)!.envelope.inputs.length, 1);
    assert.equal(unread(d.p, "W").length, 2);
  } finally { d.cleanup(); }
});

for (const fault of ["partial", "truncated", "wrong_thread"] as const) test(`${fault} history cannot establish absence or import output`, async () => {
  const { d, f, x, r } = await accepted();
  try { const e = finish(f, r); const s = snapshot(f);
    if (fault === "partial") s.complete = false;
    if (fault === "truncated") e.complete = false;
    if (fault === "wrong_thread") s.threadId = "thread:OTHER";
    await x.tick(d.room, "W"); d.reopen(); const y = new EngineReconciler(d.store, f);
    await y.tick(d.room, "W"); assert.equal(claims(d), 0); assert.equal(d.p.seats.get("W")!.cursor, 0); assert.ok((await y.tick(d.room, "W")).held.length);
    assert.equal(f.state.sends.length, 1);
  } finally { d.cleanup(); }
});

test("stable output imports once; delayed terminal observation is separate, later input survives", async () => {
  const { d, f, x, r } = await accepted();
  try { const e = finish(f, r); snapshot(f).runs[0]!.status = "running"; e.final = false;
    await x.tick(d.room, "W"); assert.equal(claims(d), 1); assert.equal(d.p.runs.get(r.id)!.phase, "accepted");
    d.request("B"); d.reopen(); const y = new EngineReconciler(d.store, f);
    snapshot(f).runs[0]!.status = "completed"; e.final = true;
    await y.tick(d.room, "W"); const count = d.store.load(d.room).length;
    for (let i = 0; i < 8; i++) await y.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, count); assert.equal(claims(d), 1);
    assert.equal(d.p.runs.get(r.id)!.phase, "terminal"); assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), ["B"]);
    assert.equal(f.state.sends.length, 1); d.parity();
  } finally { d.cleanup(); }
});

test("changed emission content/disposition and source association fail closed without duplicate claims", async () => {
  for (const change of ["body", "disposition", "run"] as const) {
    const { d, f, x, r } = await accepted();
    try { const e = finish(f, r); await x.tick(d.room, "W");
      if (change === "body") e.body = "changed";
      if (change === "disposition") e.disposition = { kind: "yield" };
      if (change === "run") e.runId = "unrelated";
      const out = await x.tick(d.room, "W"); assert.equal(claims(d), 1); assert.ok(out.held.some((h) => h.code.startsWith("source_conflict"))); d.parity();
    } finally { d.cleanup(); }
  }
});

test("no normal-final default: undeclared prose holds; explicit silent/yield/progress never closes work", async () => {
  for (const kind of [null, "silent", "yield", "progress"] as const) {
    const { d, f, x, r } = await accepted();
    try { finish(f, r, { body: kind === "silent" ? "" : "I am done!", disposition: kind === null ? null : kind === "progress" ? { kind, requestIds: ["A"] } : { kind } });
      await x.tick(d.room, "W"); assert.equal(d.p.requests.get("A")!.state, "open"); assert.equal(claims(d), 0);
      assert.equal(d.p.runs.get(r.id)!.phase, kind === null ? "accepted" : "terminal");
      assert.equal(unread(d.p, "O").length, 0); d.parity();
    } finally { d.cleanup(); }
  }
});

test("known native child work holds finish/transfer after latest run ends; disappearance is not completion T20", async () => {
  const { d, f, x, r } = await accepted();
  try { const s = snapshot(f), activityId = JSON.stringify(["native", "thread:W", "child"]);
    d.add({ type: "activity_start", actor: "$system", activityId, runId: r.id, requestIds: ["A"], status: "pending" });
    s.activities.push({ id: "child", runId: s.runs[0]!.id, requestIds: ["A"], status: "running" }); s.pending.push("subagents:child");
    finish(f, r); s.pending.push("subagents:child"); await x.tick(d.room, "W");
    assert.equal(d.p.requests.get("A")!.state, "open"); assert.equal((await x.quiescence(d.room, "W")).proven, false);
    s.activities = []; s.pending = []; await x.tick(d.room, "W"); assert.equal((await x.quiescence(d.room, "W")).proven, false);
    assert.equal(d.p.activities.size, 1); d.reopen(); const y = new EngineReconciler(d.store, f); assert.equal((await y.quiescence(d.room, "W")).proven, false);
    s.activities.push({ id: "child", runId: s.runs[0]!.id, requestIds: ["A"], status: "completed" });
    s.settled = ["subagents:child"]; // Explicit terminal native entity, rather than roster disappearance.
    await y.tick(d.room, "W"); assert.equal([...d.p.activities.values()][0]!.status, "pending");
    assert.equal((await y.quiescence(d.room, "W")).proven, false);
    // A trusted original logical result, rather than the lifecycle row, settles work.
    d.add({ type: "output", actor: "$system", author: "W", sourceKey: "registered-child-result", association: { kind: "activity", id: activityId },
      body: "Original child result retained", disposition: { kind: "yield" }, activityCompletion: "done" });
    await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, true);
    assert.equal(d.p.requests.get("A")!.state, "open");
  } finally { d.cleanup(); }
});

for (const drift of ["environmentId", "serverVersion", "id", "threadId"] as const)
  test(`direct quiescence validates historical frozen ${drift} and can recover the same origin`, async () => {
    const { d, f, x, r } = await accepted();
    try {
      finish(f, r, { disposition: { kind: "yield" } }); await x.tick(d.room, "W");
      assert.equal((await x.quiescence(d.room, "W")).proven, true);
      const old = drift === "threadId" ? snapshot(f).threadId : f.capabilities[drift];
      if (drift === "threadId") snapshot(f).threadId = "thread:OTHER";
      else f.capabilities[drift] = "OTHER-ORIGIN";
      assert.equal((await x.quiescence(d.room, "W")).proven, false);
      d.reopen(); const y = new EngineReconciler(d.store, f);
      assert.equal((await y.quiescence(d.room, "W")).proven, false);
      if (drift === "threadId") snapshot(f).threadId = old;
      else f.capabilities[drift] = old;
      assert.equal((await y.quiescence(d.room, "W")).proven, true);
      assert.equal(f.state.sends.length, 1); d.parity();
    } finally { d.cleanup(); }
  });

test("sequence floor and known background IDs survive restart, stale idle and newer roster disappearance T20", async () => {
  const { d, f, x, r } = await accepted();
  try {
    finish(f, r, { disposition: { kind: "yield" } }); await x.tick(d.room, "W");
    const older = structuredClone(snapshot(f)), current = snapshot(f), key = "background:pt:child";
    current.sequence = 12; current.pending = [key]; current.idle = false;
    await x.tick(d.room, "W");
    assert.deepEqual(d.p.providerObservations.get("W")!.pending, [key]);
    d.reopen(); const y = new EngineReconciler(d.store, f);
    f.state.snapshots["thread:W"] = older;
    assert.equal((await y.quiescence(d.room, "W")).proven, false); // No tick prerequisite.
    const held = await y.tick(d.room, "W"); assert.ok(held.held.some((h) => h.code === "snapshot_order"));
    assert.equal(d.p.providerObservations.get("W")!.sequence, 12);
    f.state.snapshots["thread:W"] = { ...older, sequence: 13 };
    await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, false);
    assert.deepEqual(d.p.providerObservations.get("W")!.pending, [key]);
    const n = d.store.load(d.room).length;
    for (let i = 0; i < 5; i++) await y.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, n); assert.equal(f.state.sends.length, 1);
    // The stronger fake contract supplies an explicit SAME-key settlement. Public T3
    // has no uniform opaque-roster completion receipt and cannot invent this observation.
    f.state.snapshots["thread:W"] = { ...older, sequence: 14, settled: [key] };
    await y.tick(d.room, "W"); assert.equal((await y.quiescence(d.room, "W")).proven, true); d.parity();
  } finally { d.cleanup(); }
});

for (const resend of [false, true]) test(`durable native work gates an already-prepared ${resend ? "same-ID resend" : "initial send"} after idle roster omission`, async () => {
  const { d, f, x, r } = await fixture();
  try {
    if (resend) { f.unknownWithoutAcceptance = true; await x.tick(d.room, "W"); }
    const firstCount = resend ? 1 : 0, idle = await f.inspect("thread:W"), key = "background:pt:notification-in-flight";
    const wire = d.p.runs.get(r.id)!.transport!.wireJSON;
    f.state.snapshots["thread:W"] = { ...idle, sequence: 10, idle: false, pending: [key] };
    await x.tick(d.room, "W"); assert.equal(f.state.sends.length, firstCount);
    d.request("B"); d.reopen(); const y = new EngineReconciler(d.store, f);
    f.state.snapshots["thread:W"] = { ...idle, sequence: 11 };
    assert.equal((await y.tick(d.room, "W")).sent, 0);
    const n = d.store.load(d.room).length;
    for (let i = 0; i < 5; i++) await y.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, n); assert.equal(f.state.sends.length, firstCount);
    assert.equal(d.p.runs.get(r.id)!.transport!.attempts, firstCount);
    assert.equal(d.p.runs.get(r.id)!.transport!.wireJSON, wire);
    assert.deepEqual(d.p.providerObservations.get("W")!.pending, [key]);
    assert.ok([...d.p.providerHolds.values()].some((h) => h.held && h.code === "native_pending"));
    // Direct callers must obey the same durable barrier under the SQLite attempt lock.
    assert.throws(() => d.add({ type: "transport_attempt", actor: "$system", target: { kind: "run", id: r.id },
      expectedAttempts: firstCount, evidence: "FAKE absence alone cannot override native work" }), /known native work/);
    assert.equal(d.store.load(d.room).length, n); d.parity();
    // Only stronger FAKE exact settlement evidence makes this original wire eligible again.
    f.state.snapshots["thread:W"] = { ...idle, sequence: 12, settled: [key] }; f.unknownWithoutAcceptance = false;
    assert.equal((await y.tick(d.room, "W")).sent, 1);
    assert.equal(f.state.sends.length, firstCount + 1); assert.ok(f.state.sends.every((w) => w === wire));
    assert.equal(d.p.runs.size, 1); assert.equal(d.p.runs.get(r.id)!.phase, "accepted");
    assert.equal(d.p.seats.get("W")!.cursor, 0);
    assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), ["A", "B"]); d.parity();
  } finally { d.cleanup(); }
});

test("exact interruption control remains operable while durable native work gates new run sends", async () => {
  const { d, f, x, r } = await accepted();
  try {
    const s = snapshot(f); s.sequence = 10; s.pending.push("background:pt:child");
    d.add({ id: "cancel", type: "cancel", actor: "O", requestId: "A" });
    const result = await x.tick(d.room, "W");
    assert.equal(result.sent, 1); assert.equal(f.state.sends.length, 2);
    assert.equal(JSON.parse(f.state.sends[1]!).type, "run.interrupt");
    assert.equal(d.p.controls.get("cancel/interrupt")!.phase, "accepted");
    assert.equal(d.p.runs.get(r.id)!.phase, "accepted");
    assert.ok(result.held.some((h) => h.code === "native_pending"));
    assert.equal((await x.quiescence(d.room, "W")).proven, false); d.parity();
  } finally { d.cleanup(); }
});

test("quiescence alone journals pending observation and uses current local state after provider read", async () => {
  const d = new DiskRoom(), f = new FakeEngineProvider(), x = new EngineReconciler(d.store, f);
  try {
    f.state.snapshots["thread:W"] = { ...(await f.inspect("thread:W")), sequence: 12, idle: false, pending: ["background:pt:child"] };
    assert.equal((await x.quiescence(d.room, "W")).proven, false);
    const observation = d.store.load(d.room).findLast((e) => e.data.kind === "provider.observed")!;
    const hold = d.store.load(d.room).findLast((e) => e.data.kind === "provider.hold")!;
    assert.equal(observation.commandKey, hold.commandKey);
    d.reopen(); const y = new EngineReconciler(d.store, f);
    f.state.snapshots["thread:W"] = { ...(await f.inspect("thread:W")), sequence: 2, idle: true, pending: [] };
    assert.equal((await y.quiescence(d.room, "W")).proven, false); d.parity();

    // A separate idle seat acquires a local reservation during the asynchronous read.
    const inspect = f.inspect.bind(f);
    f.inspect = async (thread) => { if (thread === "thread:V") { d.request("B", "V"); d.reserve("V", false); } return inspect(thread); };
    assert.equal((await y.quiescence(d.room, "V")).proven, false); d.parity();
  } finally { d.cleanup(); }
});

test("store observer refuses lower sequence, changed origin/thread and conflicting native facts without mutation", async () => {
  const d = new DiskRoom();
  try {
    const observation = { seatId: "W", threadId: "thread:W", environmentId: "FAKE-env", serverVersion: "FAKE-version", contract: "FAKE-contract-v1", sequence: 12 };
    d.add({ type: "observe_provider", actor: "$system", observation, pending: ["native:child"], settled: [] });
    const n = d.store.load(d.room).length;
    for (const change of [{ sequence: 2 }, { environmentId: "OTHER" }, { threadId: "thread:OTHER" }, { contract: "OTHER" }])
      assert.throws(() => d.add({ type: "observe_provider", actor: "$system", observation: { ...observation, ...change }, pending: [], settled: ["native:child"] }), /observation/);
    assert.throws(() => d.add({ type: "observe_provider", actor: "$system", observation, pending: ["native:child"], settled: ["native:child"] }), /conflicts/);
    assert.equal(d.store.load(d.room).length, n); d.parity();
  } finally { d.cleanup(); }
});

test("unassociated native activity and output remain visible holds/orphans, never latest-job completion", async () => {
  const { d, f, x, r } = await accepted();
  try { finish(f, r, { runId: "NATIVE-unbound" }); snapshot(f).activities.push({ id: "background", runId: null, requestIds: null, status: "running" });
    await x.tick(d.room, "W"); const length = d.store.load(d.room).length; await x.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, length); assert.equal(claims(d), 0);
    assert.equal(d.store.load(d.room).filter((e) => e.data.kind === "output" && e.data.association.kind === "orphan").length, 1);
    assert.equal((await x.quiescence(d.room, "W")).proven, false);
  } finally { d.cleanup(); }
});

async function liveFixture() {
  const v = await accepted(); const q = "Q";
  v.d.add({ id: q, type: "request", actor: "W", to: "O", parentId: "A", body: "Which option?", live: { runId: v.r.id, providerRequestId: "runtime:Q" } });
  v.d.add({ id: "reply:Q", type: "runtime_reply", actor: "O", requestId: q, body: JSON.stringify({ answers: { option: "yes" } }), commandId: "response:Q" });
  snapshot(v.f).questions.push({ id: "runtime:Q", runId: snapshot(v.f).runs[0]!.id, status: "pending", mode: "live", kind: "user_input" });
  return v;
}

test("live reply lost acknowledgement reconciles SAME response after terminal; non-waking and outside prefix T19", async () => {
  const { d, f, x, r } = await liveFixture();
  try { d.request("B"); f.loseResponse = true; await x.tick(d.room, "W"); assert.equal(d.p.controls.get("reply:Q")!.phase, "uncertain");
    finish(f, r, { disposition: { kind: "yield" } }); snapshot(f).questions[0]!.status = "resolved";
    d.reopen(); const y = new EngineReconciler(d.store, f); await y.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply:Q")!.phase, "accepted"); assert.equal(f.state.sends.length, 2);
    assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), ["B"]); assert.equal(d.p.requests.get("A")!.state, "open"); d.parity();
  } finally { d.cleanup(); }
});

test("terminal or resolved request cannot settle unknown live response; no blind resend T19", async () => {
  const { d, f, x, r } = await liveFixture();
  try { f.loseResponse = true; f.capabilities.receiptLookup = false; await x.tick(d.room, "W");
    finish(f, r, { disposition: { kind: "yield" } }); snapshot(f).questions[0]!.status = "resolved";
    for (let i = 0; i < 8; i++) await x.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply:Q")!.phase, "uncertain"); assert.equal(f.state.sends.length, 2); assert.equal((await x.quiescence(d.room, "W")).proven, false);
    assert.equal(d.store.load(d.room).filter((e) => e.data.kind === "notice" && e.data.body.includes("not applied")).length, 0);
  } finally { d.cleanup(); }
});

test("proven rejected live reply becomes obsolete once, retains original answer with bounded attention T19", async () => {
  const { d, f, x } = await liveFixture();
  try { f.reject = true; await x.tick(d.room, "W"); const length = d.store.load(d.room).length;
    for (let i = 0; i < 8; i++) await x.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply:Q")!.phase, "obsolete"); assert.equal(d.store.load(d.room).length, length);
    const notices = d.store.load(d.room).filter((e) => e.data.kind === "notice" && e.data.body.includes("Live response not applied"));
    assert.equal(notices.length, 1); assert.ok(JSON.stringify(notices).includes("yes")); assert.equal(f.state.sends.length, 2);
  } finally { d.cleanup(); }
});

test("message/nonresumable question fails closed with ordinary-board fallback", async () => {
  for (const mode of ["message", "not_resumable"] as const) {
    const { d, f, x } = await liveFixture();
    try { snapshot(f).questions[0]!.mode = mode; const result = await x.tick(d.room, "W");
      assert.equal(f.state.sends.length, 1); assert.ok(result.held.some((h) => h.detail.includes("ordinary board")));
    } finally { d.cleanup(); }
  }
});

test("interrupt acceptance is not run termination or quiescence", async () => {
  const { d, f, x, r } = await accepted();
  try { d.add({ id: "cancel:A", type: "cancel", actor: "O", requestId: "A" }); await x.tick(d.room, "W");
    assert.equal([...d.p.controls.values()][0]!.phase, "accepted"); assert.equal(d.p.runs.get(r.id)!.phase, "accepted");
    assert.equal(d.p.seats.get("W")!.activeRunId, r.id); assert.equal((await x.quiescence(d.room, "W")).proven, false);
    finish(f, r, { disposition: { kind: "yield" } }); snapshot(f).runs[0]!.status = "interrupted";
    await x.tick(d.room, "W"); assert.equal(d.p.runs.get(r.id)!.phase, "terminal"); assert.match(d.p.runs.get(r.id)!.failure!, /interrupted/);
    assert.equal(claims(d), 0); assert.equal(f.state.sends.length, 2); d.parity();
  } finally { d.cleanup(); }
});

test("exact sync echo extends one complete prefix; arbitrary mention and new legitimate input are preserved", async () => {
  for (const echo of [true, false]) {
    const { d, f, x, r } = await accepted();
    try { d.request("B"); const receipt = d.sync(r); d.request("C");
      finish(f, r, { disposition: { kind: "yield" }, body: `read receipt ${receipt.id} ${receipt.digest}`, receipts: echo ? [receipt] : [] });
      await x.tick(d.room, "W"); assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), echo ? ["C"] : ["B", "C"]);
      assert.equal(d.p.runs.get(r.id)!.receipts[0]!.confirmed, echo); d.parity();
    } finally { d.cleanup(); }
  }
});

test("terminal with no output records one bounded error, releases SAME run and preserves later input", async () => {
  const { d, f, x, r } = await accepted();
  try { d.request("B"); snapshot(f).runs[0]!.status = "failed"; snapshot(f).pending = []; snapshot(f).idle = true;
    await x.tick(d.room, "W"); const count = d.store.load(d.room).length;
    for (let i = 0; i < 9; i++) await x.tick(d.room, "W");
    assert.equal(d.store.load(d.room).length, count); assert.equal(d.p.runs.get(r.id)!.phase, "terminal"); assert.ok(d.p.runs.get(r.id)!.failure);
    assert.deepEqual(unread(d.p, "W").map((i) => i.eventId), ["B"]); assert.equal(f.state.sends.length, 1);
  } finally { d.cleanup(); }
});

test("endpoint/contract change blocks recovered command without rerender or dispatch", async () => {
  const { d, f, x, r } = await fixture();
  try { const original = d.p.runs.get(r.id)!.transport!; f.capabilities.environmentId = "different-env";
    await x.tick(d.room, "W"); assert.equal(f.state.sends.length, 0); assert.equal(d.p.runs.get(r.id)!.transport!.digest, original.digest);
    assert.equal(hash(original.wireJSON), original.digest);
  } finally { d.cleanup(); }
});

test("native correlated later output keeps its original activity after another run is reserved", async () => {
  const { d, f, x, r } = await accepted();
  try { const s = snapshot(f), native = s.runs[0]!.id;
    const registered = JSON.stringify(["native", "thread:W", "child"]);
    d.add({ type: "activity_start", actor: "$system", activityId: registered, runId: r.id, requestIds: ["A"], status: "pending" });
    s.activities.push({ id: "child", runId: native, requestIds: ["A"], status: "running" });
    finish(f, r, { disposition: { kind: "yield" } }); await x.tick(d.room, "W");
    const activityId = [...d.p.activities.keys()][0]!;
    s.activities[0]!.status = "completed"; s.pending = []; await x.tick(d.room, "W");
    d.request("B"); const second = d.reserve("W", false); assert.notEqual(second.id, r.id);
    s.emissions.push({ id: "late:child", runId: native, activityId, body: "A child result", disposition: { kind: "answer", requestIds: ["A"] }, complete: true, final: false, receipts: [] });
    await x.tick(d.room, "W"); assert.equal(d.p.requests.get("A")!.state, "open");
    assert.equal([...d.p.activities.values()][0]!.status, "pending");
    d.add({ type: "output", actor: "$system", author: "W", sourceKey: "exact-original-child-result", association: { kind: "activity", id: activityId },
      body: "A child result", disposition: { kind: "yield" }, activityCompletion: "done" });
    await x.tick(d.room, "W");
    d.add({ type: "output", actor: "$system", author: "W", sourceKey: "explicit-original-child-answer", association: { kind: "activity", id: activityId },
      body: "A child answer", disposition: { kind: "answer", requestIds: ["A"] } });
    assert.equal(d.p.requests.get("A")!.state, "answered"); assert.equal(d.p.requests.get("B")!.state, "open");
    assert.equal(d.p.seats.get("W")!.activeRunId, second.id); assert.equal(f.state.sends.length, 1); d.parity();
  } finally { d.cleanup(); }
});

test("provider holds gate real store transfer, and proved quiescence preserves unread inherited bundle T20", async () => {
  const { d, f, x, r } = await accepted();
  try { finish(f, r, { disposition: { kind: "yield" } }); snapshot(f).activities.push({ id: "unknown-child", runId: null, requestIds: null, status: "running" });
    await x.tick(d.room, "W"); d.request("B");
    assert.throws(() => d.add({ type: "transfer", actor: "$user", oldSeatId: "W", newSeatId: "NEW", threadId: "new-thread", owned: ["A", "B"], awaited: [], body: "reseat", evidence: "pretend latest terminal is enough" }), /provider uncertainty/);
    snapshot(f).activities[0]!.status = "completed"; await x.tick(d.room, "W");
    const proof = await x.quiescence(d.room, "W"); assert.equal(proof.proven, false);
    assert.throws(() => d.add({ type: "transfer", actor: "$user", oldSeatId: "W", newSeatId: "NEW", threadId: "new-thread", owned: ["A", "B"], awaited: [], body: "reseat", evidence: proof.evidence }), /provider uncertainty/);
    // New genuine input is independent of the unassociated work, while transfer stays held.
    assert.ok(d.reserve("W", false)); assert.equal(f.state.sends.length, 1); d.parity();
  } finally { d.cleanup(); }
});

test("pending native activity scoped to a confirmed sync blocks its newly exposed request", async () => {
  const { d, f, x, r } = await accepted();
  try { d.request("B"); const receipt = d.sync(r); d.add({ type: "confirm_sync", actor: "$system", runId: r.id, ...{receiptId:receipt.id,digest:receipt.digest}, evidence: "FAKE exact exposure" });
    const s = snapshot(f); s.activities.push({ id: "unassociated", runId: s.runs[0]!.id, status: "running", requestIds: null });
    finish(f, r, { body: "B attempt", disposition: { kind: "answer", requestIds: ["B"] } }); await x.tick(d.room, "W");
    assert.equal(d.p.requests.get("B")!.state, "open"); assert.equal(claims(d), 0);
  } finally { d.cleanup(); }
});

test("lost interrupt acknowledgement reconciles command but still waits for exact run termination", async () => {
  const { d, f, x, r } = await accepted();
  try { d.add({ id: "cancel", type: "cancel", actor: "O", requestId: "A" }); f.loseResponse = true; await x.tick(d.room, "W");
    assert.equal([...d.p.controls.values()][0]!.phase, "uncertain"); d.reopen(); const y = new EngineReconciler(d.store, f); await y.tick(d.room, "W");
    assert.equal([...d.p.controls.values()][0]!.phase, "accepted"); assert.equal(d.p.runs.get(r.id)!.phase, "accepted"); assert.equal(f.state.sends.length, 2);
    assert.equal((await y.quiescence(d.room, "W")).proven, false);
  } finally { d.cleanup(); }
});

test("reordered old running snapshot cannot reopen a terminal run or replace its emission", async () => {
  const { d, f, x, r } = await accepted();
  try { const before = structuredClone(snapshot(f)); finish(f, r); await x.tick(d.room, "W");
    f.state.snapshots["thread:W"] = before; await x.tick(d.room, "W");
    assert.equal(d.p.runs.get(r.id)!.phase, "terminal"); assert.equal(claims(d), 1); assert.equal(f.state.sends.length, 1);
    assert.equal((await x.quiescence(d.room, "W")).proven, false); d.parity();
  } finally { d.cleanup(); }
});

test("app control acceptance without runtime-effect proof stays visible and blocks finish/transfer", async () => {
  const { d, f, x, r } = await liveFixture();
  try { f.capabilities.controlCompletion = false; await x.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply:Q")!.phase, "accepted");
    finish(f, r); snapshot(f).questions[0]!.status = "resolved";
    await x.tick(d.room, "W"); assert.equal(d.p.requests.get("A")!.state, "open");
    assert.equal((await x.quiescence(d.room, "W")).proven, false);
    assert.ok((await x.tick(d.room, "W")).held.some((h) => h.code.startsWith("control_effect"))); assert.equal(f.state.sends.length, 2);
  } finally { d.cleanup(); }
});

test("store boundary rejects frozen wire that drops required input or changes a live answer", async () => {
  const fresh = new DiskRoom(), f = new FakeEngineProvider();
  try { fresh.request("A"); const r = fresh.reserve("W", false), c = await f.contract();
    const json = JSON.stringify({ type: "message.dispatch", commandId: r.dispatchCommandId, threadId: "thread:W", messageId: r.dispatchMessageId,
      attachments: [], dispatchMode: { type: "start_immediately" }, text: JSON.stringify({ schema: "backroom.envelope.v1", runId: r.id, envelope: { ...r.envelope, inputs: [] } }) });
    assert.throws(() => fresh.add({ type: "freeze_transport", actor: "$system", target: { kind: "run", id: r.id }, transport: { wireJSON: json, digest: hash(json), environmentId: c.environmentId, serverVersion: c.serverVersion, contract: c.id } }), /complete reserved envelope/);
  } finally { fresh.cleanup(); }
  const { d, f: provider } = await liveFixture();
  try { const c = await provider.contract();
    const json = JSON.stringify({ type: "runtime-request.respond", commandId: "response:Q", threadId: "thread:W", requestId: "runtime:Q", answers: { option: "CHANGED" } });
    assert.throws(() => d.add({ type: "freeze_transport", actor: "$system", target: { kind: "control", id: "reply:Q" }, transport: { wireJSON: json, digest: hash(json), environmentId: c.environmentId, serverVersion: c.serverVersion, contract: c.id } }), /preserve the original live answer/);
  } finally { d.cleanup(); }
});

test("closed runtime request plus authoritative same-command absence resolves an unapplied lost reply T19", async () => {
  const { d, f, x, r } = await liveFixture();
  try { f.unknownWithoutAcceptance = true; await x.tick(d.room, "W");
    snapshot(f).questions[0]!.status = "expired"; snapshot(f).questions[0]!.mode = "not_resumable";
    finish(f, r, { disposition: { kind: "yield" } }); await x.tick(d.room, "W");
    assert.equal(d.p.controls.get("reply:Q")!.phase, "obsolete"); assert.equal(f.state.sends.length, 2);
    const notices = d.store.load(d.room).filter((e) => e.data.kind === "notice" && e.data.body.includes("Live response not applied"));
    assert.equal(notices.length, 1); assert.ok(JSON.stringify(notices).includes("yes"));
    assert.equal((await x.quiescence(d.room, "W")).proven, true); d.parity();
  } finally { d.cleanup(); }
});
