import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, deliveredInputs, envelopeBytes, fold, inputTree, selectPrefix, unread } from "../../src/engine/index.ts";
import type { Command, RoomEvent } from "../../src/engine/index.ts";
import { assertions, outcomes, Room } from "./helpers.ts";

test("source reuse cannot silently replace immutable content or explicit disposition", () => {
  const r = new Room(); r.request("A"); const run = r.reserve("W")!;
  r.output(run, { kind: "answer", requestIds: ["A"] }, false, { sourceKey: "emission", body: "original" });
  assert.throws(() => r.output(run, { kind: "answer", requestIds: ["A"] }, false, { sourceKey: "emission", body: "changed" }), /source identity conflicts/);
  assert.throws(() => r.output(run, { kind: "yield" }, false, { sourceKey: "emission", body: "original" }), /source identity conflicts/);
  assert.equal(r.output(run, { requestIds: ["A"], kind: "answer" }, false, { association: { id: run.id, kind: "run" }, sourceKey: "emission", body: "original" }).outcome, "duplicate");
  assert.equal(r.p.requests.get("A")!.answerId !== null, true);
});

test("a live reply cannot overwrite a cancel-generated interruption control identity", () => {
  const r = new Room(); r.request("A"); const run = r.reserve("W")!;
  r.add({ type: "request", id: "Q", actor: "W", to: "$user", body: "approve", parentId: "A", live: { runId: run.id, providerRequestId: "provider-question" } });
  r.add({ type: "cancel", id: "cancel", actor: "$user", requestId: "A" });
  const before = JSON.stringify(r.log);
  assert.throws(() => r.add({ type: "runtime_reply", id: "cancel/interrupt", actor: "$user", requestId: "Q", body: "yes", commandId: "response" }), /fresh control identity/);
  assert.equal(JSON.stringify(r.log), before); assert.equal(r.p.controls.get("cancel/interrupt")!.kind, "interrupt");
  const control = r.p.controls.get("cancel/interrupt")!;
  assert.throws(() => fold([...r.log, { id: "corrupt", seq: r.log.length + 1, commandKey: "corrupt", data: { kind: "control.prepared", control, recipients: [] } }]), /control identity reused/);
});

test("normal worker/reviewer exchange resumes original roots and ends without acknowledgement returns", () => {
  const r = new Room();
  r.request("U", "O", "$user");
  const o = r.reserve("O")!;
  r.request("A", "W", "O", "U");
  r.output(o, { kind: "yield" });
  assert.equal(r.reserve("O"), null);
  const w = r.reserve("W")!;
  r.add({ type: "post", actor: "W", intent: "progress", requestIds: ["A"], body: "Proposal ready; reviewing" });
  r.request("R", "V", "W", "A");
  r.output(w, { kind: "yield" });
  assert.equal(r.reserve("O"), null);
  const v = r.reserve("V")!;
  r.finish(v, "R");
  const w2 = r.reserve("W")!;
  assert.deepEqual(w2.envelope.inputs.map((i) => i.intent), ["result"]);
  assert.equal(w2.envelope.openRequests[0]!.id, "A");
  assert.equal(w2.envelope.openRequests[0]!.returnTo, "O");
  r.request("R2", "V", "W", "A");
  r.output(w2, { kind: "yield" });
  r.finish(r.reserve("V")!, "R2");
  r.finish(r.reserve("W")!, "A");
  const o2 = r.reserve("O")!;
  assert.deepEqual(o2.envelope.inputs.map((i) => i.requestIds), [["A"]]);
  r.finish(o2, "U");
  for (const id of ["U", "A", "R", "R2"]) assert.equal(r.p.requests.get(id)!.rootId, "U");
  assert.deepEqual(unread(r.p, "$user").map((i) => i.requestIds), [["U"]]);
  r.idle("O", "W", "V"); assertions(r);
});

test("K1 case 7: a review answer that lands before the worker's turn ends supersedes its final until delivered", () => {
  const r = new Room();
  r.request("U", "O", "$user");
  const o = r.reserve("O")!;
  r.request("A", "W", "O", "U");
  r.output(o, { kind: "yield" });
  const w = r.reserve("W")!;
  r.request("R", "V", "W", "A");
  r.finish(r.reserve("V")!, "R");
  assert.deepEqual(outcomes(r.finish(w, "A")), ["superseded"]);
  assert.equal(r.p.requests.get("A")!.state, "open");
  assert.equal(r.reserve("O"), null);
  const w2 = r.reserve("W")!;
  assert.deepEqual(w2.envelope.inputs.map((i) => [i.intent, i.requestIds]), [["result", ["R"]]]);
  assert.deepEqual(outcomes(r.finish(w2, "A")), ["answered"]);
  assert.equal(r.log.filter((e) => e.data.kind === "output" && e.data.recipients.includes("O")
    && e.data.claims.some((c) => c.requestId === "A" && c.outcome === "answered")).length, 1);
  const o2 = r.reserve("O")!;
  assert.deepEqual(o2.envelope.inputs.map((i) => i.requestIds), [["A"]]);
  r.finish(o2, "U");
  assert.equal([...r.p.runs.values()].filter((run) => run.seatId === "O").length, 2);
  r.idle("O", "W", "V"); assertions(r);
});

test("K1 an unread result supersedes only the open request it walks up to", () => {
  const r = new Room(); r.request("A"); r.request("B"); const w = r.reserve("W")!;
  r.request("R", "V", "W", "B"); r.request("root", "V", "W");
  const v = r.reserve("V")!; r.finish(v, "R", "root");
  assert.deepEqual(outcomes(r.finish(w, "A", "B")), ["answered", "superseded"]);
  const w2 = r.reserve("W")!;
  assert.deepEqual(w2.envelope.inputs.map((i) => i.requestIds), [["R", "root"]]);
  assert.deepEqual(outcomes(r.finish(w2, "B")), ["answered"]);
  assert.deepEqual(unread(r.p, "O").map((i) => i.requestIds), [["A"], ["B"]]);
  r.idle("W", "V"); assertions(r);
});

test("K1 a result already seen through a confirmed sync or a later run does not supersede", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.request("R", "V", "W", "A"); r.finish(r.reserve("V")!, "R");
  const receipt = r.sync(w);
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, true, { receipts: [receipt] })), ["answered"]);
  r.request("B"); const w2 = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "bg", runId: w2.id, requestIds: ["B"], status: "pending" });
  r.request("R2", "V", "W", "B"); r.output(w2, { kind: "yield" });
  r.finish(r.reserve("V")!, "R2");
  r.output(r.reserve("W")!, { kind: "yield" });
  assert.deepEqual(outcomes(r.add({ type: "output", actor: "$system", author: "W", sourceKey: "bg-final", association: { kind: "activity", id: "bg" },
    activityCompletion: "done", disposition: { kind: "answer", requestIds: ["B"] }, body: "Background work finished" })), ["answered"]);
  assert.deepEqual(unread(r.p, "O").map((i) => i.requestIds), [["A"], ["B"]]);
  r.idle("W", "V"); assertions(r);
});

test("T1 busy arrivals batch once and a reservation race preserves later input", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.request("B"); r.request("C"); r.output(w, { kind: "yield" });
  const w2 = r.reserve("W")!; r.request("D");
  assert.deepEqual(w2.envelope.inputs.map((i) => i.requestIds), [["B"], ["C"]]);
  r.output(w2, { kind: "yield" });
  const w3 = r.reserve("W")!;
  assert.deepEqual(w3.envelope.inputs.map((i) => i.requestIds), [["D"]]);
  r.output(w3, { kind: "yield" }); r.idle("W"); assertions(r);
});

for (const confirmed of [false, true]) test(`T2 ${confirmed ? "confirmed" : "lost"} sync preserves the exact delivery boundary`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.request("B"); r.request("C"); const receipt = r.sync(w); r.request("D");
  // An arbitrary read or citation changes no state; only exact receipt exposure counts.
  assert.equal(unread(r.p, "W").length, 4);
  r.output(w, { kind: "yield" }, true, { body: "I read C", receipts: confirmed ? [receipt] : [] });
  assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), confirmed ? [["D"]] : [["B"], ["C"], ["D"]]);
  assert.equal(r.p.seats.get("W")!.cursor, confirmed ? r.p.runs.get(w.id)!.receipts[0]!.envelope.through : w.envelope.through);
  assertions(r);
});

test("T2 transcript confirmation survives fold and overlapping receipts never skip genuine input", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.request("B"); const first = r.sync(w); r.request("C"); const second = r.sync(w);
  assert.throws(() => r.add({ type: "confirm_sync", actor: "$system", runId: w.id, receiptId: first.id, digest: "fake", evidence: "transcript" }), /invalid sync/);
  r.add({ type: "confirm_sync", actor: "$system", runId: w.id, receiptId: second.id, digest: second.digest, evidence: "verified complete tool result in transcript" });
  r.restart(); r.request("D");
  r.output(w, { kind: "yield" }, true, { receipts: [first] });
  assert.deepEqual(deliveredInputs(r.p, w.id).map((i) => i.requestIds), [["A"], ["B"], ["C"]]);
  assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), [["D"]]); assertions(r);
});

test("T3 own output, prose mentions, notes and transport events do not wake", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "post", actor: "W", intent: "note", body: "@O @V please acknowledge" });
  r.finish(w, "A"); r.output(w, { kind: "yield" }, false);
  assert.equal(r.reserve("V"), null); r.idle("W");
  const o = r.reserve("O")!;
  r.output(o, { kind: "yield" }); r.idle("O", "W", "V"); assertions(r);
});

test("T4 correction-after-H supersedes answer; confirmed correction later permits one claim", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "correct", id: "edit", actor: "O", requestId: "A", body: "Use revised requirements" });
  assert.deepEqual(outcomes(r.finish(w, "A")), ["superseded"]);
  assert.equal(r.p.requests.get("A")!.answerId, null);
  const w2 = r.reserve("W")!;
  assert.deepEqual(w2.envelope.inputs.map((i) => i.eventId), ["edit"]);
  r.output(w2, { kind: "yield" });
  r.request("signal", "W", "X");
  const w3 = r.reserve("W")!;
  assert.equal(w3.envelope.openRequests.find((q) => q.id === "A")!.corrections[0]!.body, "Use revised requirements");
  assert.deepEqual(outcomes(r.finish(w3, "A")), ["answered"]);
  assert.throws(() => r.add({ type: "correct", actor: "O", requestId: "A", body: "New work" }), /new request/);
  assertions(r);
});

test("T4 confirmed sync makes racing correction available without another turn", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "correct", actor: "O", requestId: "A", body: "Correction" });
  const receipt = r.sync(w);
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, true, { receipts: [receipt] })), ["answered"]);
  r.idle("W"); assertions(r);
});

for (const cancelFirst of [true, false]) test(`T5 serialized ${cancelFirst ? "cancel" : "answer"}-first race keeps one lawful outcome`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  if (cancelFirst) r.add({ type: "cancel", actor: "$user", requestId: "A" });
  assert.deepEqual(outcomes(r.finish(w, "A")), [cancelFirst ? "late" : "answered"]);
  if (!cancelFirst) r.add({ type: "cancel", actor: "$user", requestId: "A" });
  assert.equal(r.p.requests.get("A")!.state, cancelFirst ? "cancelled" : "answered");
  if (cancelFirst) {
    assert.deepEqual(unread(r.p, "W").map((i) => i.intent), ["cancel"]);
    r.output(r.reserve("W")!, { kind: "silent" });
  }
  r.idle("W"); assertions(r);
});

test("T12 multiple requesters require explicit selection and immutable independent return addresses", () => {
  const r = new Room(); r.request("A", "W", "O"); r.request("B", "W", "X"); const w = r.reserve("W")!;
  assert.throws(() => r.output(w, { kind: "answer", requestIds: [] }), /explicit nonempty/);
  assert.throws(() => r.add({ type: "output", actor: "V", author: "V", sourceKey: "wrong", association: { kind: "run", id: w.id }, body: "Fake", disposition: { kind: "answer", requestIds: ["A"] } }), /association mismatch/);
  r.finish(w, "A");
  assert.equal(r.p.requests.get("B")!.state, "open");
  assert.deepEqual(unread(r.p, "O").map((i) => i.requestIds), [["A"]]);
  assert.equal(unread(r.p, "X").length, 0);
  r.request("resume", "W", "O"); const w2 = r.reserve("W")!; r.finish(w2, "B");
  assert.deepEqual(unread(r.p, "X").map((i) => i.requestIds), [["B"]]); assertions(r);
});

test("T12 one emission can answer several roots and delivers one event to each requester", () => {
  const r = new Room(); r.request("A"); r.request("B"); r.request("C", "W", "X");
  assert.deepEqual(outcomes(r.finish(r.reserve("W")!, "A", "B", "C")), ["answered", "answered", "answered"]);
  assert.deepEqual(unread(r.p, "O").map((i) => i.requestIds), [["A", "B"]]);
  assert.deepEqual(unread(r.p, "X").map((i) => i.requestIds), [["C"]]); assertions(r);
});

test("T13 context notes are optional; an oversized oldest input blocks once and is never bypassed", () => {
  const r = new Room();
  for (let i = 0; i < 20; i++) r.add({ type: "post", actor: "O", intent: "note", body: "x".repeat(1000) });
  r.add({ type: "request", id: "big", actor: "O", to: "W", body: "b".repeat(4000) }); r.request("small");
  assert.equal(r.reserve("W", 1000), null);
  const before = r.log.length;
  assert.equal(r.reserve("W", 1000), null); assert.equal(r.log.length, before);
  assert.equal(r.p.seats.get("W")!.cursor, 0);
  const w = r.reserve("W")!;
  assert.deepEqual(w.envelope.inputs.map((i) => i.eventId), ["big", "small"]);
  assert.equal(w.envelope.inputs[0]!.body.length, 4000);
  r.output(w, { kind: "yield" }); r.idle("W"); assertions(r);
});

test("T13 budget-limited complete prefix does not leak a later correction into resumable context", () => {
  const r = new Room(); r.request("A");
  r.add({ type: "correct", id: "large-edit", actor: "O", requestId: "A", body: "c".repeat(8000) });
  const selection = selectPrefix(r.p, "W", 1400);
  assert.equal(selection.kind, "ready");
  if (selection.kind !== "ready") throw new Error("expected prefix");
  assert.deepEqual(selection.envelope.inputs.map((i) => i.eventId), ["A"]);
  assert.equal(selection.envelope.openRequests[0]!.corrections.length, 0);
  assert.ok(envelopeBytes(selection.envelope) <= 1400);
  const w = r.reserve("W", 1400)!;
  assert.deepEqual(outcomes(r.finish(w, "A")), ["superseded"]);
  assert.deepEqual(unread(r.p, "W").map((i) => i.eventId), ["large-edit"]); assertions(r);
});

test("T14 native correlated result after turn end completes explicit activity; unknown output is a visible orphan", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "child", runId: w.id, requestIds: ["A"], status: "pending" });
  r.output(w, { kind: "yield" }); r.restart();
  r.add({ type: "output", actor: "$system", author: "W", sourceKey: "child-final", association: { kind: "activity", id: "child" },
    activityCompletion: "done", disposition: { kind: "answer", requestIds: ["A"] }, body: "Child finished after parent's turn ended" });
  assert.equal(r.p.requests.get("A")!.state, "answered");
  assert.equal(r.p.activities.get("child")!.status, "done");
  r.request("B");
  const orphan = r.add({ type: "output", actor: "$system", author: "W", sourceKey: "unknown-native", association: { kind: "orphan" }, disposition: { kind: "answer", requestIds: ["B"] }, body: "Unknown background result" });
  assert.equal(r.p.requests.get("B")!.state, "open");
  assert.equal(orphan.events.filter((e) => e.data.kind === "notice").length, 1);
  assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), [["B"]]); assertions(r);
});

test("user180 progress, activity output and provider turn end cannot implicitly finish pending or uncertain child work", () => {
  for (const status of ["pending", "uncertain"] as const) {
    const r = new Room(); r.request("A"); const w = r.reserve("W")!;
    r.add({ type: "activity_start", actor: "W", activityId: "child", runId: w.id, requestIds: ["A"], status });
    r.add({ type: "post", actor: "W", intent: "progress", requestIds: ["A"], body: "Done soon" });
    r.add({ type: "output", actor: "$system", author: "W", sourceKey: "child-progress", association: { kind: "activity", id: "child" },
      disposition: { kind: "progress", requestIds: ["A"] }, body: "Child still running" });
    assert.equal(r.p.activities.get("child")!.status, status);
    assert.deepEqual(outcomes(r.finish(w, "A")), ["pending_activity"]);
    assert.equal(r.p.requests.get("A")!.state, "open"); assert.equal(r.p.requests.get("A")!.answerId, null);
    assert.equal(r.p.seats.get("W")!.activeRunId, null); r.idle("W");
    assert.equal(unread(r.p, "O").length, 0);
    r.add({ type: "activity_status", actor: "$system", activityId: "child", status: "done", evidence: "explicit native completion receipt" });
    r.add({ type: "output", actor: "$system", author: "W", sourceKey: "later-native", association: { kind: "activity", id: "child" },
      disposition: { kind: "answer", requestIds: ["A"] }, body: "Causally associated final" });
    assert.equal(r.p.requests.get("A")!.state, "answered"); assertions(r);
  }
});

test("user180 mixed work keeps activity associations scoped; unrelated B can finish while A waits", () => {
  const r = new Room(); r.request("A"); r.request("B", "W", "X"); const w = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "child-A", runId: w.id, requestIds: ["A"], status: "pending" });
  assert.deepEqual(outcomes(r.finish(w, "A", "B")), ["pending_activity", "answered"]);
  assert.deepEqual(unread(r.p, "X").map((i) => i.requestIds), [["B"]]);
  assert.throws(() => r.add({ type: "output", actor: "$system", author: "W", sourceKey: "bad-child", association: { kind: "activity", id: "child-A" }, disposition: { kind: "answer", requestIds: ["B"] }, body: "Incorrect association" }), /causally associated/);
  r.add({ type: "output", actor: "$system", author: "W", sourceKey: "proper-child", association: { kind: "activity", id: "child-A" }, activityCompletion: "done", disposition: { kind: "answer", requestIds: ["A"] }, body: "A done" });
  assert.deepEqual(unread(r.p, "O").map((i) => i.requestIds), [["A"]]); assertions(r);
});

test("user180 open causal review/question prevents premature parent completion", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!; r.request("review", "V", "W", "A");
  assert.deepEqual(outcomes(r.finish(w, "A")), ["pending_activity"]);
  r.finish(r.reserve("V")!, "review"); r.finish(r.reserve("W")!, "A");
  assert.equal(r.p.requests.get("A")!.state, "answered"); assertions(r);
});

test("user180 passive progress never wakes; explicitly subscribed milestones coalesce and can be consumed silently", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "post", actor: "W", intent: "progress", requestIds: ["A"], body: "Working" });
  assert.equal(r.reserve("O"), null);
  r.add({ type: "subscribe", actor: "O", requestId: "A", milestones: ["review-ready"], enabled: true });
  r.add({ type: "post", id: "m1", actor: "W", intent: "progress", requestIds: ["A"], milestone: "review-ready", body: "First milestone" });
  r.add({ type: "post", actor: "W", intent: "progress", requestIds: ["A"], milestone: "unsubscribed", body: "Context only" });
  r.output(w, { kind: "progress", requestIds: ["A"], milestone: "review-ready" }, false, { sourceKey: "m2" });
  const o = r.reserve("O")!;
  assert.deepEqual(o.envelope.inputs.map((i) => i.intent), ["progress", "progress"]);
  assert.equal(r.p.requests.get("A")!.state, "open");
  r.output(o, { kind: "silent" }); r.idle("O");
  assert.equal(unread(r.p, "W").length, 1, "initial input remains uncommitted until worker terminal");
  r.output(w, { kind: "yield" }); r.idle("W", "O"); assertions(r);
});

test("T15 client dedupe differs from source dedupe and equal-text posts remain distinct", () => {
  const r = new Room();
  const post: Command = { type: "post", actor: "O", id: "same-key", intent: "note", body: "Identical" };
  r.add(post); assert.equal(r.add(post).outcome, "duplicate");
  r.add({ ...post, id: "new-key" });
  assert.equal(r.log.filter((e) => e.data.kind === "note").length, 2);
  r.request("A"); const w = r.reserve("W")!;
  r.output(w, { kind: "answer", requestIds: ["A"] }, false, { sourceKey: "early" });
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, true, { sourceKey: "final" })), ["already_answered"]);
  assert.equal(r.output(w, { kind: "answer", requestIds: ["A"] }, true, { sourceKey: "final" }).outcome, "duplicate");
  assert.equal(unread(r.p, "O").length, 1); r.idle("W"); assertions(r);
});

test("T16 deliberate new questions remain genuine input, while acknowledgement notes cannot manufacture a chain", () => {
  const r = new Room(); r.request("A"); r.finish(r.reserve("W")!, "A"); r.output(r.reserve("O")!, { kind: "yield" });
  r.add({ type: "post", actor: "O", intent: "note", body: "Accepted, thank you" });
  r.idle("O", "W");
  r.request("real-followup", "W", "O", "A");
  assert.deepEqual(r.reserve("W")!.envelope.inputs.map((i) => i.requestIds), [["real-followup"]]); assertions(r);
});

test("T18 clarification failure notifies affected reviewer once; notice-only failure stays silent after restart", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!; r.request("R", "V", "W", "A"); r.output(w, { kind: "yield" });
  const v = r.reserve("V")!; r.request("Q", "W", "V", "R"); r.output(v, { kind: "yield" });
  r.output(r.reserve("W")!, { kind: "error", requestIds: ["Q"] });
  const v2 = r.reserve("V")!;
  assert.deepEqual(v2.envelope.inputs.map((i) => i.intent), ["error"]);
  const failure = r.output(v2, { kind: "error", requestIds: ["R"] });
  const notices = failure.events.filter((e) => e.data.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.data.kind, "notice");
  if (notices[0]!.data.kind === "notice") assert.deepEqual(notices[0]!.data.recipients, []);
  r.idle("W", "V");
  r.output(r.reserve("O")!, { kind: "error", requestIds: [] }); r.idle("O", "W", "V"); assertions(r);
});

test("T18 error failure scope excludes unrelated old context and bounded notices in a mixed batch", () => {
  const r = new Room(); r.request("old", "W", "X"); r.output(r.reserve("W")!, { kind: "yield" });
  r.request("B"); const w = r.reserve("W")!;
  const decision = r.output(w, { kind: "error", requestIds: [] });
  const notices = decision.events.filter((e) => e.data.kind === "notice");
  assert.equal(notices.length, 1);
  if (notices[0]!.data.kind === "notice") {
    assert.deepEqual(notices[0]!.data.requestIds, ["B"]);
    assert.deepEqual(notices[0]!.data.recipients, ["O"]);
  }
  assert.equal(unread(r.p, "X").length, 0); r.idle("W"); assertions(r);
});

test("T19 live reply is a durable control outside the delivery cursor, including an intervening request", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "request", id: "live-Q", actor: "W", to: "$user", parentId: "A", body: "May I continue?", live: { runId: w.id, providerRequestId: "provider-Q" } });
  r.request("B");
  assert.throws(() => r.add({ type: "runtime_reply", actor: "V", requestId: "live-Q", commandId: "bad-reply", body: "Approve" }), /authorized/);
  r.add({ type: "runtime_reply", id: "reply", actor: "$user", requestId: "live-Q", commandId: "response:Q", body: "Continue" });
  assert.equal(r.p.seats.get("W")!.cursor, 0);
  assert.throws(() => r.add({ type: "runtime_reply", actor: "$user", requestId: "live-Q", commandId: "conflict", body: "No" }), /authorized/);
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "uncertain", evidence: "ack lost" });
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, false)), ["pending_activity"]);
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "accepted", evidence: "durable response receipt" });
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, false)), ["pending_activity"]);
  const effect = [...r.p.providerHolds.values()].find((h) => h.code === "control_effect:reply")!;
  assert.deepEqual(effect.requestIds, ["live-Q", "A"]);
  r.add({ type: "provider_hold", actor: "$system", hold: { ...effect, held: false, detail: "FAKE original runtime effect completion proof" } });
  r.finish(w, "A");
  assert.equal(r.p.requests.get("A")!.state, "answered");
  assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), [["B"]]);
  assert.equal(r.p.controls.get("reply")!.commandId, "response:Q"); assertions(r);
});

for (const outcome of ["accepted", "obsolete"] as const) test(`T19 lost control receipt can reconcile ${outcome} after terminal without a worker turn`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "request", id: "Q", actor: "W", to: "$user", parentId: "A", body: "Question", live: { runId: w.id, providerRequestId: "runtime:Q" } });
  r.add({ type: "runtime_reply", id: "reply", actor: "$user", requestId: "Q", body: "Answer retained", commandId: "cmd:reply" });
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "uncertain", evidence: "transport timeout" });
  r.output(w, { kind: "yield" }); r.restart();
  assert.throws(() => r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "sending", evidence: "retry blindly" }), /blindly resent/);
  const d = r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: outcome, evidence: outcome === "accepted" ? "durable late receipt" : "proven closed/unapplied runtime request" });
  assert.equal(d.events.filter((e) => e.data.kind === "notice").length, outcome === "obsolete" ? 1 : 0);
  if (outcome === "obsolete") assert.ok(d.events.some((e) => e.data.kind === "notice" && e.data.body.includes("Answer retained")));
  assert.equal(r.p.controls.get("reply")!.commandId, "cmd:reply"); r.idle("W"); assertions(r);
});

test("message-mode user question uses an ordinary result, distinct from live control", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.request("Q", "$user", "W", "A"); r.output(w, { kind: "yield" });
  r.add({ type: "user_answer", actor: "$user", requestId: "Q", body: "Message answer" });
  const w2 = r.reserve("W")!;
  assert.deepEqual(w2.envelope.inputs.map((i) => i.requestIds), [["Q"]]); r.finish(w2, "A"); assertions(r);
});

for (const beforeTransfer of [true, false]) test(`T20 result ${beforeTransfer ? "before" : "after"} atomic transfer is delivered once with required content`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!; r.request("R", "V", "W", "A"); r.output(w, { kind: "yield" });
  const v = r.reserve("V")!;
  if (beforeTransfer) r.finish(v, "R");
  const d = r.add({ type: "transfer", id: "reseat", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: beforeTransfer ? [] : ["R"], body: "Continue A", evidence: "adapter proven idle, no known background" });
  assert.equal(d.events.length, 1, "one atomic transfer event"); r.restart();
  if (!beforeTransfer) r.finish(v, "R");
  const next = r.reserve("W2")!;
  const required = inputTree(next.envelope.inputs);
  assert.equal(required.filter((i) => i.intent === "result" && i.requestIds.includes("R")).length, 1);
  assert.ok(required.some((i) => i.intent === "result" && i.body.includes(v.id)));
  assert.equal(next.envelope.openRequests.find((q) => q.id === "A")!.returnTo, "O");
  assert.deepEqual(outcomes(r.output(w, { kind: "answer", requestIds: ["A"] }, false)), ["late"]);
  assert.deepEqual(outcomes(r.finish(next, "A")), ["answered"]);
  assert.equal(r.p.requests.get("A")!.owner, "W2"); r.idle("W2"); assertions(r);
});

test("T20 even a terminal latest run cannot transfer across known background or uncertain live control", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "child", runId: w.id, requestIds: ["A"], status: "uncertain" });
  r.output(w, { kind: "yield" });
  const transfer: Command = { type: "transfer", id: "reseat", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: [], body: "Checkpoint", evidence: "latest turn ended" };
  assert.throws(() => r.add(transfer), /background/);
  r.add({ type: "activity_status", actor: "$system", activityId: "child", status: "done", evidence: "known child stopped" });
  r.add(transfer); assertions(r);
});

test("T20 successive transfers preserve full inherited input and explicit future routes", () => {
  const r = new Room(); r.request("A");
  r.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: [], body: "First transfer", evidence: "idle" });
  r.add({ type: "transfer", actor: "O", oldSeatId: "W2", newSeatId: "W3", threadId: "thread:W3", owned: ["A"], awaited: [], body: "Second transfer", evidence: "idle" });
  const w = r.reserve("W3")!;
  assert.equal(inputTree(w.envelope.inputs).filter((i) => i.eventId === "A").length, 1);
  r.finish(w, "A"); r.idle("W3"); assertions(r);
});

test("T21 cancellation interrupts one co-batched run but does not silently finish independent requests", () => {
  const r = new Room(); r.request("A"); r.request("B", "W", "X"); r.request("old", "W", "V");
  r.output(r.reserve("W")!, { kind: "yield" });
  r.add({ type: "correct", actor: "O", requestId: "A", body: "A changes" });
  r.add({ type: "correct", actor: "X", requestId: "B", body: "B changes" });
  const w = r.reserve("W")!;
  r.add({ type: "cancel", id: "stop", actor: "$user", requestId: "A" });
  r.add({ type: "control_phase", actor: "$system", controlId: "stop/interrupt", phase: "accepted", evidence: "interrupt command accepted, not proof of termination" });
  assert.throws(() => r.reserve("W"), /unresolved/);
  const failure = r.output(w, { kind: "error", requestIds: ["B"] });
  const notice = failure.events.find((e) => e.data.kind === "notice")!;
  if (notice.data.kind === "notice") {
    assert.deepEqual(notice.data.requestIds, ["B"]);
    assert.deepEqual(notice.data.recipients, ["X", "O"]);
  }
  assert.equal(r.p.requests.get("B")!.state, "open"); assert.equal(unread(r.p, "V").length, 0);
  r.add({ type: "retry", actor: "$user", runId: w.id, body: "Deliberately retry independent B" });
  const next = r.reserve("W")!;
  assert.ok(inputTree(next.envelope.inputs).some((i) => i.requestIds.includes("B") && i.body === "B changes")); assertions(r);
});

test("guard/recovery records retain frozen identities without scheduling uncertain or rejected work", () => {
  const r = new Room(); r.request("A");
  r.add({ type: "reserve", actor: "$system", seatId: "W", runId: "fixed-run", dispatchCommandId: "fixed-command", dispatchMessageId: "fixed-message", maxBytes: 10000 });
  r.add({ type: "phase", actor: "$system", runId: "fixed-run", phase: "uncertain", evidence: "unknown acceptance" });
  r.restart(); r.request("B");
  assert.throws(() => r.reserve("W"), /unresolved/);
  assert.throws(() => r.add({ type: "retry", actor: "$user", runId: "fixed-run", body: "Retry" }), /known failed/);
  assert.equal(r.p.runs.get("fixed-run")!.dispatchCommandId, "fixed-command");
  r.add({ type: "phase", actor: "$system", runId: "fixed-run", phase: "rejected", evidence: "definitive provider non-acceptance" });
  assert.equal(r.p.seats.get("W")!.cursor, 0);
  r.add({ type: "retry", actor: "$user", runId: "fixed-run", body: "Explicit retry" });
  const next = r.reserve("W")!;
  assert.deepEqual(next.envelope.inputs.map((i) => i.intent), ["request", "request", "retry"]); assertions(r);
});

test("log fold and decision are deterministic and caller-owned frozen payloads never mutate", () => {
  const r = new Room(); r.request("A");
  const log = JSON.parse(JSON.stringify(r.log)) as RoomEvent[];
  const command: Command = { type: "reserve", id: "reserve", actor: "$system", seatId: "W", runId: "run", dispatchCommandId: "dispatch", dispatchMessageId: "message", maxBytes: 10000 };
  assert.deepEqual(decide(log, command), decide(log, command));
  const after = [...log, ...decide(log, command).events];
  const before = JSON.stringify(after); fold(after); fold(after); assert.equal(JSON.stringify(after), before);
  assert.deepEqual(fold(after), fold(JSON.parse(before) as RoomEvent[]));
  assert.throws(() => fold([...after, after[0]!]), /event order/);
});
