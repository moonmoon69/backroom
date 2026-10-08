/**
 * L6 gate: release closure ("Lean semantics" §6, with L4b's retire and designate). Every unresolved state a kept command
 * can create is released by a kept command. One test per row of the release table, then 1,000 seeded random histories
 * of kept commands: from every state they reach, cancel (or an answer) closes every open request, a terminal output
 * (after the phase T3 would report) ends every run, and activity_status resolves every activity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, deliveryDisposition, fold, unread } from "../../src/engine/index.ts";
import type { Command, Decision, Projection, RoomEvent, Run } from "../../src/engine/index.ts";
import { outcomes, Room } from "./helpers.ts";

const MiB = 1024 * 1024;

test("row: an open request is released by an output that answers it, or by cancel", () => {
  const r = new Room(); r.request("A"); r.request("B");
  const w = r.reserve("W")!;
  assert.deepEqual(outcomes(r.finish(w, "A")), ["answered"]);
  r.add({ type: "cancel", actor: "O", requestId: "B" });
  assert.equal(r.p.requests.get("A")!.state, "answered");
  assert.equal(r.p.requests.get("B")!.state, "cancelled");
});

test("row: a request blocked by an open child is released by the child's answer, or by cancelling the child", () => {
  for (const release of ["answer", "cancel"] as const) {
    const r = new Room(); r.request("A");
    const w = r.reserve("W")!;
    r.request("R", "V", "W", "A");
    assert.deepEqual(outcomes(r.finish(w, "A")), ["pending_activity"]);
    if (release === "answer") {
      r.finish(r.reserve("V")!, "R");
      assert.deepEqual(outcomes(r.finish(r.reserve("W")!, "A")), ["answered"], "the answer wakes W, whose final answers A");
    } else {
      r.add({ type: "cancel", actor: "W", requestId: "R" });
      // W asked for R itself, so nothing wakes it: its explicit answer goes with the run that carried A.
      assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, false)), ["answered"]);
    }
  }
});

test("row: a request blocked by an activity is released by activity_status, or by an output with activityCompletion", () => {
  for (const release of ["status", "completion"] as const) {
    const r = new Room(); r.request("A");
    const w = r.reserve("W")!;
    r.add({ type: "activity_start", actor: "$system", activityId: "bg", runId: w.id, requestIds: ["A"], status: "pending" });
    assert.deepEqual(outcomes(r.finish(w, "A")), ["pending_activity"]);
    if (release === "status") {
      r.add({ type: "activity_status", actor: "$system", activityId: "bg", status: "done", evidence: "background work ended" });
      assert.deepEqual(outcomes(r.add({ type: "output", actor: "$system", author: "W", sourceKey: "later", association: { kind: "run", id: w.id }, body: "Done", disposition: { kind: "answer", requestIds: ["A"] } })), ["answered"]);
    } else {
      assert.deepEqual(outcomes(r.add({ type: "output", actor: "$system", author: "W", sourceKey: "settle", association: { kind: "activity", id: "bg" }, activityCompletion: "done", body: "Done", disposition: { kind: "answer", requestIds: ["A"] } })), ["answered"]);
    }
    assert.equal(r.p.activities.get("bg")!.status, "done", release);
    assert.equal(r.p.requests.get("A")!.state, "answered", release);
  }
});

test("row: a run prepared, sending, accepted, running or uncertain is ended by a terminal output or observe_end (after a phase where T3 has not taken it yet)", () => {
  const paths: Record<string, Run["phase"][]> = {
    prepared: [], sending: ["sending"], accepted: ["accepted"], running: ["accepted", "running"], uncertain: ["uncertain"],
  };
  for (const [phase, steps] of Object.entries(paths)) for (const end of ["output", "observe_end"] as const) {
    const r = new Room(); r.request("A");
    r.add({ type: "reserve", actor: "$system", seatId: "W", runId: "run", dispatchCommandId: "d", dispatchMessageId: "m", maxBytes: MiB });
    for (const next of steps) r.add({ type: "phase", actor: "$system", runId: "run", phase: next as "sending", evidence: next });
    assert.equal(r.p.runs.get("run")!.phase, phase);
    // T3 has the run once it is accepted, running or uncertain; before that, the phase that says so comes first.
    if (phase === "prepared" || phase === "sending") r.add({ type: "phase", actor: "$system", runId: "run", phase: "uncertain", evidence: "T3 has no record of it" });
    if (end === "output") r.add({ type: "output", actor: "$system", author: "W", sourceKey: "final", association: { kind: "run", id: "run" }, body: "Done", disposition: { kind: "answer", requestIds: ["A"] }, terminal: true });
    else {
      r.add({ type: "output", actor: "$system", author: "W", sourceKey: "final", association: { kind: "run", id: "run" }, body: "Done", disposition: { kind: "answer", requestIds: ["A"] } });
      r.add({ type: "observe_end", actor: "$system", runId: "run", sourceKey: "final", failure: null, evidence: "T3 run completed" });
    }
    assert.equal(r.p.runs.get("run")!.phase, "terminal", `${phase} ${end}`);
    assert.equal(r.p.seats.get("W")!.activeRunId, null, `${phase} ${end}`);
  }
});

test("row: a rejected run is released by retry, or by cancel", () => {
  for (const release of ["retry", "cancel"] as const) {
    const r = new Room(); r.request("A");
    r.add({ type: "reserve", actor: "$system", seatId: "W", runId: "run", dispatchCommandId: "d", dispatchMessageId: "m", maxBytes: MiB });
    r.add({ type: "phase", actor: "$system", runId: "run", phase: "rejected", evidence: "T3 refused it" });
    if (release === "retry") r.add({ type: "retry", actor: "$user", runId: "run", body: "Again" });
    else r.add({ type: "cancel", actor: "O", requestId: "A" });
    assert.equal(r.p.runs.get("run")!.phase, "terminal", release);
    assert.equal(r.p.seats.get("W")!.activeRunId, null, release);
    if (release === "retry") assert.ok(r.reserve("W"), "the retry is delivered");
  }
});

test("row: delivery.blocked is not reachable through the host (posts over 1 MiB are refused, the host reserves with 4 MiB); a larger budget releases it", () => {
  const r = new Room();
  r.add({ type: "request", id: "A", actor: "O", to: "W", body: "x".repeat(MiB) });
  assert.ok(r.reserve("W", 4 * MiB), "the largest post the board accepts fits the host's budget");
  const small = new Room(); small.request("A");
  const blocked = small.add({ type: "reserve", actor: "$system", seatId: "W", runId: "tiny", dispatchCommandId: "d", dispatchMessageId: "m", maxBytes: 10 });
  assert.equal(blocked.outcome, "blocked");
  assert.equal(small.p.blocked.get("W"), "A");
  assert.ok(small.reserve("W", 4 * MiB));
  assert.equal(small.p.blocked.has("W"), false);
});

test("row: a retired seat (retire or transfer) is terminal by design; later input becomes an undeliverable notice", () => {
  for (const leave of ["retire", "transfer"] as const) {
    const r = new Room();
    if (leave === "retire") r.add({ type: "retire", actor: "O", seatId: "W", evidence: "idle" });
    else r.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Take over", evidence: "idle" });
    const d = r.add({ type: "request", id: "late", actor: "O", to: "W", body: "Still there?" });
    const notice = d.events.find((e) => e.data.kind === "notice");
    assert.ok(notice && notice.data.kind === "notice" && notice.data.intent === "attention", leave);
    assert.equal(deliveryDisposition(r.p, d.events[0]!, "W"), "undeliverable", leave);
    assert.throws(() => r.reserve("W"), /not active/, leave);
    r.add({ type: "cancel", actor: "O", requestId: "late" });
    assert.equal(r.p.requests.get("late")!.state, "cancelled", "its request is still closed by cancel");
  }
});

test("row: the orchestrator is changed by designate, cleared by retiring it, moved by transfer; it is not an unresolved state", () => {
  const r = new Room();
  r.add({ type: "designate", actor: "$user", seatId: "X" });
  assert.equal(r.p.orchestrator, "X");
  r.add({ type: "transfer", actor: "$user", oldSeatId: "X", newSeatId: "X2", threadId: "thread:X2", owned: [], awaited: [], body: "Take over", evidence: "idle" });
  assert.equal(r.p.orchestrator, "X2");
  r.add({ type: "retire", actor: "$user", seatId: "X2", evidence: "idle" });
  assert.equal(r.p.orchestrator, null);
  r.add({ type: "designate", actor: "$user", seatId: "O" });
  assert.equal(r.p.orchestrator, "O");
});

test("row: an unconfirmed sync.offered is settled by confirm_sync; unconfirmed, it has no effect", () => {
  for (const confirmed of [true, false]) {
    const r = new Room(); r.request("A");
    const w = r.reserve("W")!;
    r.request("B");
    const receipt = r.sync(w);
    if (confirmed) r.confirm(w, receipt);
    r.output(w, { kind: "yield" });
    assert.equal(r.p.runs.get(w.id)!.receipts[0]!.confirmed, confirmed);
    assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), confirmed ? [] : [["B"]]);
  }
});

test("row: a subscription is released by subscribe enabled:false", () => {
  const r = new Room(); r.request("A");
  r.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["working"], enabled: true });
  assert.equal(r.p.subscriptions.length, 1);
  r.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["working"], enabled: false });
  assert.equal(r.p.subscriptions.length, 0);
});

// ---------------- 1,000 seeded random histories ----------------

/** mulberry32: a small seeded PRNG, so a failing history can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIVE: Run["phase"][] = ["accepted", "running", "uncertain"];
const NEXT: Record<string, Run["phase"][]> = {
  prepared: ["sending", "accepted", "uncertain", "rejected"], sending: ["accepted", "uncertain", "rejected"],
  accepted: ["running", "uncertain"], running: ["uncertain"], uncertain: ["accepted", "running", "rejected"],
};

/** One random kept command against the room as it is. Many are refused; a refusal changes nothing. */
function randomCommand(p: Projection, random: () => number, n: number): Command {
  const pick = <T>(items: readonly T[]): T | undefined => items.length ? items[Math.floor(random() * items.length)] : undefined;
  const some = <T>(items: readonly T[]): T[] => items.filter(() => random() < 0.5);
  const seats = [...p.seats.values()];
  const active = seats.filter((s) => s.status === "active").map((s) => s.id);
  const anySeat = () => pick(seats.map((s) => s.id)) ?? "W";
  const requests = [...p.requests.values()];
  const open = requests.filter((q) => q.state === "open");
  const runs = [...p.runs.values()];
  const live = runs.filter((r) => r.phase !== "terminal");
  const activities = [...p.activities.values()];
  const id = `x${n}`;
  const actor = () => pick(["$user", ...active]) ?? "$user";
  const kind = pick(["request", "request", "request", "reserve", "reserve", "phase", "phase", "output", "output", "output", "observe_end", "correct",
    "cancel", "post", "subscribe", "sync", "confirm_sync", "activity_start", "activity_status", "retry", "transfer", "retire", "designate", "seat"] as const)!;
  switch (kind) {
    case "seat": return { type: "seat", id, actor: pick(["$user", p.orchestrator ?? "$user"])!, seatId: `S${n}`, threadId: `thread:S${n}`, ...(random() < 0.2 ? { orchestrator: true } : {}) };
    case "retire": return { type: "retire", id, actor: pick(["$user", p.orchestrator ?? "$user"])!, seatId: anySeat(), evidence: "thread idle" };
    case "designate": return { type: "designate", id, actor: "$user", seatId: random() < 0.2 ? null : anySeat() };
    case "request": {
      const parent = random() < 0.4 ? pick(open) : undefined;
      const from = parent ? pick([parent.owner, parent.returnTo, "$user"])! : actor();
      return { type: "request", id, actor: from, to: random() < 0.05 ? "$user" : pick(active.filter((s) => s !== from)) ?? anySeat(), body: `request ${n}`, ...(parent ? { parentId: parent.id } : {}) };
    }
    case "correct": { const q = pick(open); return { type: "correct", id, actor: q ? pick([q.returnTo, "$user"])! : "$user", requestId: q?.id ?? "none", body: `correction ${n}` }; }
    case "cancel": { const q = pick(requests); return { type: "cancel", id, actor: q ? pick([q.returnTo, "$user", p.orchestrator ?? "$user"])! : "$user", requestId: q?.id ?? "none" }; }
    case "post": {
      const author = actor();
      const owned = open.filter((q) => q.owner === author).map((q) => q.id);
      return { type: "post", id, actor: author, intent: random() < 0.5 ? "note" : "progress", body: `post ${n}`, requestIds: some(owned), ...(random() < 0.5 ? { milestone: "working" } : {}) };
    }
    case "subscribe": { const q = pick(requests); return { type: "subscribe", id, actor: pick(active) ?? "W", requestId: q?.id ?? "none", milestones: ["working"], enabled: random() < 0.7 }; }
    case "reserve": return { type: "reserve", id, actor: "$system", seatId: pick(active) ?? "W", runId: `run${n}`, dispatchCommandId: `d${n}`, dispatchMessageId: `m${n}`, maxBytes: random() < 0.05 ? 200 : MiB };
    case "phase": {
      const r = pick(live);
      const next = r ? pick(NEXT[r.phase] ?? []) ?? "uncertain" : "accepted";
      const t3 = LIVE.includes(next) && random() < 0.5 ? { providerRunId: r?.providerRunId ?? `t3:${r?.id ?? n}` } : {};
      return { type: "phase", id, actor: "$system", runId: r?.id ?? "none", phase: next as "accepted", evidence: `t3 says ${next}`, ...t3 };
    }
    case "sync": { const r = pick(live); return { type: "sync", id, actor: "$system", runId: r?.id ?? "none", receiptId: `receipt${n}`, maxBytes: MiB }; }
    case "confirm_sync": {
      const r = pick(live.filter((x) => x.receipts.some((q) => !q.confirmed)));
      const q = r?.receipts.find((x) => !x.confirmed);
      return { type: "confirm_sync", id, actor: "$system", runId: r?.id ?? "none", receiptId: q?.id ?? "none", digest: q?.digest ?? "none", evidence: "in the transcript" };
    }
    case "output": {
      const a = random() < 0.2 ? pick(activities) : undefined;
      const r = a ? p.runs.get(a.runId) : pick(runs);
      const allowed = r ? [...new Set([...r.envelope.openRequests.map((q) => q.id), ...r.envelope.inputs.flatMap((i) => i.requestIds)])] : [];
      const ids = a ? some(a.requestIds) : some(allowed);
      const disposition = pick([
        { kind: "answer" as const, requestIds: ids.length ? ids : allowed.slice(0, 1) },
        { kind: "progress" as const, requestIds: ids, milestone: "working" },
        { kind: "error" as const, requestIds: ids },
        { kind: "yield" as const }, { kind: "silent" as const },
      ])!;
      return { type: "output", id, actor: "$system", author: r?.seatId ?? "W", sourceKey: `source${n}`, association: a ? { kind: "activity", id: a.id } : { kind: "run", id: r?.id ?? "none" },
        body: disposition.kind === "silent" ? "" : `output ${n}`, disposition, ...(a ? (random() < 0.5 ? { activityCompletion: pick(["done", "failed"] as const)! } : {}) : { terminal: random() < 0.6 }) };
    }
    case "observe_end": {
      const r = pick(live);
      const key = r ? [...p.sourceKeys.keys()].find((k) => p.events.find((e) => e.id === p.sourceKeys.get(k))?.data.kind === "output"
        && (p.events.find((e) => e.id === p.sourceKeys.get(k))!.data as { association: { kind: string; id?: string } }).association.id === r.id) : undefined;
      return { type: "observe_end", id, actor: "$system", runId: r?.id ?? "none", sourceKey: key ?? "none", failure: random() < 0.2 ? "T3 run failed" : null, evidence: "T3 run ended" };
    }
    case "activity_start": {
      const r = pick(live);
      const owned = r ? open.filter((q) => q.owner === r.seatId).map((q) => q.id) : [];
      return { type: "activity_start", id, actor: "$system", activityId: `bg${n}`, runId: r?.id ?? "none", requestIds: some(owned).length ? some(owned) : owned.slice(0, 1), status: random() < 0.8 ? "pending" : "uncertain" };
    }
    case "activity_status": { const a = pick(activities); return { type: "activity_status", id, actor: "$system", activityId: a?.id ?? "none", status: pick(["done", "failed", "uncertain"] as const)!, evidence: "T3 says so" }; }
    case "retry": { const r = pick(runs); return { type: "retry", id, actor: pick(["$user", p.orchestrator ?? "$user"])!, runId: r?.id ?? "none", body: "Again" }; }
    case "transfer": {
      const from = anySeat();
      const owned = open.filter((q) => q.owner === from).map((q) => q.id);
      const awaited = open.filter((q) => q.returnTo === from).map((q) => q.id);
      return { type: "transfer", id, actor: "$user", oldSeatId: from, newSeatId: `T${n}`, threadId: `thread:T${n}`, owned, awaited, body: "Take over", evidence: "idle" };
    }
  }
}

function apply(log: RoomEvent[], command: Command): RoomEvent[] {
  let d: Decision;
  try { d = decide(log, command); } catch { return log; }
  return [...log, ...d.events];
}

/** Commands that close one thing, as the host or a member would issue them. Each must be accepted and must close it. */
function closeRun(p: Projection, run: Run, id: string): Command[] {
  if (run.phase === "rejected") return [{ type: "retry", id, actor: "$user", runId: run.id, body: "Again" }];
  const commands: Command[] = [];
  if (!LIVE.includes(run.phase)) commands.push({ type: "phase", id: `${id}:phase`, actor: "$system", runId: run.id, phase: "uncertain", evidence: "T3 has no record of it" });
  const seat = p.seats.get(run.seatId)!;
  commands.push({ type: "output", id, actor: "$system", author: seat.id, sourceKey: `${id}:final`, association: { kind: "run", id: run.id }, body: "", disposition: { kind: "silent" }, terminal: true });
  return commands;
}

function checkClosure(log: RoomEvent[], where: string): void {
  const p = fold(log);
  let n = 0;
  for (const q of p.requests.values()) if (q.state === "open") {
    const after = fold(apply(log, { type: "cancel", id: `close-request:${n++}`, actor: "$user", requestId: q.id }));
    assert.equal(after.requests.get(q.id)!.state, "cancelled", `${where}: cancel closes ${q.id}`);
  }
  for (const run of p.runs.values()) if (run.phase !== "terminal") {
    let next = log;
    for (const command of closeRun(p, run, `close-run:${n++}`)) {
      const before = next.length;
      next = apply(next, command);
      assert.ok(next.length > before, `${where}: ${command.type} is accepted for run ${run.id} in ${run.phase}`);
    }
    assert.equal(fold(next).runs.get(run.id)!.phase, "terminal", `${where}: run ${run.id} ends`);
  }
  for (const a of p.activities.values()) if (a.status === "pending" || a.status === "uncertain") {
    const after = fold(apply(log, { type: "activity_status", id: `close-activity:${n++}`, actor: "$system", activityId: a.id, status: "done", evidence: "ended" }));
    assert.equal(after.activities.get(a.id)!.status, "done", `${where}: activity_status resolves ${a.id}`);
  }
  // And all of it together: the room can be brought to rest.
  let rest = log;
  for (const run of [...fold(rest).runs.values()].filter((r) => r.phase !== "terminal")) for (const command of closeRun(fold(rest), run, `rest-run:${run.id}`)) rest = apply(rest, command);
  for (const a of [...fold(rest).activities.values()].filter((x) => x.status === "pending" || x.status === "uncertain"))
    rest = apply(rest, { type: "activity_status", id: `rest-activity:${a.id}`, actor: "$system", activityId: a.id, status: "done", evidence: "ended" });
  for (const q of [...fold(rest).requests.values()].filter((x) => x.state === "open")) rest = apply(rest, { type: "cancel", id: `rest-request:${q.id}`, actor: "$user", requestId: q.id });
  const end = fold(rest);
  assert.deepEqual([...end.runs.values()].filter((r) => r.phase !== "terminal").map((r) => r.id), [], `${where}: every run ended`);
  assert.deepEqual([...end.activities.values()].filter((a) => a.status === "pending" || a.status === "uncertain").map((a) => a.id), [], `${where}: every activity resolved`);
  assert.deepEqual([...end.requests.values()].filter((q) => q.state === "open").map((q) => q.id), [], `${where}: every request closed`);
}

test("1,000 seeded random histories of kept commands: from every reached state, every open request, run and activity can be closed", (t) => {
  const reached = { states: 0, appended: 0, openRequests: 0, userOwned: 0, liveRuns: 0, activities: 0, retired: 0, blocked: 0 };
  const kinds = new Set<string>();
  for (let seed = 1; seed <= 1000; seed++) {
    const random = rng(seed);
    let log = new Room().log;
    for (let n = 0; n < 30; n++) {
      const before = log.length;
      const command = randomCommand(fold(log), random, n);
      log = apply(log, command);
      if (log.length === before) continue;
      reached.appended += 1;
      kinds.add(command.type);
      const p = fold(log);
      reached.states += 1;
      reached.openRequests += [...p.requests.values()].filter((q) => q.state === "open").length;
      reached.userOwned += [...p.requests.values()].filter((q) => q.state === "open" && q.owner === "$user").length;
      reached.liveRuns += [...p.runs.values()].filter((r) => r.phase !== "terminal").length;
      reached.activities += [...p.activities.values()].filter((a) => a.status === "pending" || a.status === "uncertain").length;
      reached.retired += [...p.seats.values()].filter((s) => s.status === "retired").length;
      reached.blocked += p.blocked.size;
      checkClosure(log, `seed ${seed} step ${n + 1} (${command.type})`);
    }
  }
  // The histories reach every kept command and every kind of unresolved state.
  assert.deepEqual([...kinds].sort(), ["activity_start", "activity_status", "cancel", "confirm_sync", "correct", "designate", "observe_end", "output", "phase",
    "post", "request", "reserve", "retire", "retry", "seat", "subscribe", "sync", "transfer"]);
  for (const [key, count] of Object.entries(reached)) assert.ok(count > 0, `no reached state had ${key}`);
  t.diagnostic(`reached: ${JSON.stringify(reached)}`);
});
