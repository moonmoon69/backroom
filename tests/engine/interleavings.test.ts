import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryDisposition, unread } from "../../src/engine/index.ts";
import type { Command } from "../../src/engine/index.ts";
import { assertions, outcomes, Room } from "./helpers.ts";

/** Fifteen independent executable schedules against the implementation, not the /tmp model. */
for (const schedule of [
  ["edit", "cancel", "answer"], ["edit", "answer", "cancel"], ["cancel", "edit", "answer"],
  ["cancel", "answer", "edit"], ["answer", "edit", "cancel"], ["answer", "cancel", "edit"],
]) test(`interleaving ${schedule.join(" → ")}`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  let answerOutcome = "";
  for (const action of schedule) {
    if (action === "edit") {
      if (r.p.requests.get("A")!.state === "open") r.add({ type: "correct", actor: "O", requestId: "A", body: "Changed" });
      else assert.throws(() => r.add({ type: "correct", actor: "O", requestId: "A", body: "Changed" }), /closed request/);
    } else if (action === "cancel") r.add({ type: "cancel", actor: "$user", requestId: "A" });
    else answerOutcome = outcomes(r.finish(w, "A"))[0]!;
    r.restart();
  }
  const first = schedule[0];
  assert.equal(answerOutcome, first === "answer" ? "answered" : schedule.indexOf("cancel") < schedule.indexOf("answer") ? "late" : "superseded");
  assert.equal(r.p.requests.get("A")!.state, first === "answer" ? "answered" : "cancelled");
  assertions(r);
});

for (const confirmAt of ["before-B", "after-B", "never"] as const) test(`interleaving sync exposure ${confirmAt}`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!; r.request("one");
  const receipt = r.sync(w);
  const confirm = () => r.add({ type: "confirm_sync", actor: "$system", runId: w.id, receiptId: receipt.id, digest: receipt.digest, evidence: "verified transcript" });
  if (confirmAt === "before-B") confirm();
  r.request("two");
  if (confirmAt === "after-B") confirm();
  r.restart(); r.output(w, { kind: "yield" });
  assert.deepEqual(unread(r.p, "W").map((i) => i.requestIds), confirmAt === "never" ? [["one"], ["two"]] : [["two"]]); assertions(r);
});

for (const replyFirst of [true, false]) test(`interleaving live answer ${replyFirst ? "before" : "after"} terminal`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "request", id: "Q", actor: "W", to: "$user", parentId: "A", body: "Question", live: { runId: w.id, providerRequestId: "runtime:Q" } });
  const reply = () => r.add({ type: "runtime_reply", id: "reply", actor: "$user", requestId: "Q", commandId: "response", body: "Retained answer" });
  if (replyFirst) reply();
  r.output(w, { kind: "yield" });
  if (!replyFirst) reply();
  r.restart(); assert.equal(r.p.controls.get("reply")!.phase, replyFirst ? "prepared" : "uncertain");
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "obsolete", evidence: "proven closed/unapplied" });
  r.idle("W"); assertions(r);
});

for (const resultFirst of [true, false]) test(`interleaving transfer ${resultFirst ? "after" : "before"} result`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!; r.request("R", "V", "W", "A"); r.output(w, { kind: "yield" });
  const v = r.reserve("V")!;
  let resultId = "";
  const result = () => { resultId = r.finish(v, "R").events[0]!.id; };
  if (resultFirst) result();
  r.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: resultFirst ? [] : ["R"], body: "Checkpoint", evidence: "proven idle" });
  if (!resultFirst) result();
  r.restart();
  const original = r.log.find((e) => e.id === resultId)!;
  assert.equal(deliveryDisposition(r.p, original, "W"), resultFirst ? "transferred" : "context");
  assert.equal(unread(r.p, "W").length, 0);
  const next = r.reserve("W2")!; r.finish(next, "A"); r.idle("W2"); assertions(r);
});

for (const doneFirst of [true, false]) test(`interleaving activity resolution ${doneFirst ? "before" : "after"} terminal answer`, () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "child", runId: w.id, requestIds: ["A"], status: "pending" });
  const done = () => r.add({ type: "activity_status", actor: "$system", activityId: "child", status: "done", evidence: "native activity finished" });
  if (doneFirst) done();
  assert.deepEqual(outcomes(r.finish(w, "A")), [doneFirst ? "answered" : "pending_activity"]);
  if (!doneFirst) {
    done(); r.output(w, { kind: "answer", requestIds: ["A"] }, false);
  }
  assert.equal(r.p.requests.get("A")!.state, "answered"); assert.equal(unread(r.p, "O").length, 1); assertions(r);
});

test("additional: uncertain control blocks reseat despite a terminal provider run", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.add({ type: "request", id: "Q", actor: "W", to: "$user", parentId: "A", body: "Q", live: { runId: w.id, providerRequestId: "runtime:Q" } });
  r.add({ type: "runtime_reply", id: "reply", actor: "$user", requestId: "Q", commandId: "reply-command", body: "Answer" });
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "uncertain", evidence: "lost receipt" }); r.output(w, { kind: "yield" });
  const transfer: Command = { type: "transfer", id: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: ["A"], awaited: [], body: "Checkpoint", evidence: "latest run ended" };
  assert.throws(() => r.add(transfer), /unresolved runtime control/);
  r.add({ type: "control_phase", actor: "$system", controlId: "reply", phase: "accepted", evidence: "durable late receipt" });
  assert.throws(() => r.add(transfer), /provider uncertainty/);
  const effect = [...r.p.providerHolds.values()].find((h) => h.code === "control_effect:reply")!;
  r.add({ type: "provider_hold", actor: "$system", hold: { ...effect, held: false, detail: "FAKE original runtime effect completion proof" } });
  r.add(transfer); assertions(r);
});

test("additional: mixed fresh/notice batch reports only fresh scope and never untouched context", () => {
  const r = new Room(); r.request("A", "W", "X"); const w = r.reserve("W")!; r.request("review", "V", "W", "A"); r.output(w, { kind: "yield" });
  r.output(r.reserve("V")!, { kind: "error", requestIds: ["review"] });
  r.request("B"); const next = r.reserve("W")!;
  assert.deepEqual(next.envelope.inputs.map((i) => i.intent), ["error", "request"]);
  const d = r.output(next, { kind: "error", requestIds: [] });
  const notice = d.events.find((e) => e.data.kind === "notice")!;
  if (notice.data.kind === "notice") { assert.deepEqual(notice.data.requestIds, ["B"]); assert.deepEqual(notice.data.recipients, ["O"]); }
  assert.equal(unread(r.p, "X").length, 0); assert.equal(unread(r.p, "V").length, 0); assertions(r);
});

test("additional: early error and later failed final produce one automatic failure signal", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.output(w, { kind: "error", requestIds: ["A"] }, false);
  r.output(w, { kind: "error", requestIds: ["A"] }, true);
  assert.equal(unread(r.p, "O").length, 1); assertions(r);
});

test("additional: child failure scope excludes unrelated co-batched B", () => {
  const r = new Room(); r.request("A"); r.request("B", "W", "X"); const w = r.reserve("W")!;
  r.add({ type: "activity_start", actor: "W", activityId: "child", runId: w.id, requestIds: ["A"], status: "pending" });
  r.output(w, { kind: "yield" });
  const d = r.add({ type: "output", actor: "$system", author: "W", sourceKey: "child-error", association: { kind: "activity", id: "child" }, activityCompletion: "failed", disposition: { kind: "error", requestIds: ["A"] }, body: "Child failed" });
  const notice = d.events.find((e) => e.data.kind === "notice")!;
  if (notice.data.kind === "notice") { assert.deepEqual(notice.data.requestIds, ["A"]); assert.deepEqual(notice.data.recipients, ["O"]); }
  assert.equal(unread(r.p, "X").length, 0); assertions(r);
});

test("additional: retired identity receives a bounded undeliverable fact and cannot be reused", () => {
  const r = new Room();
  r.add({ type: "transfer", actor: "O", oldSeatId: "W", newSeatId: "W2", threadId: "thread:W2", owned: [], awaited: [], body: "Checkpoint", evidence: "idle" });
  r.request("late-address", "W", "X");
  const event = r.log.find((e) => e.id === "late-address")!;
  assert.equal(deliveryDisposition(r.p, event, "W"), "undeliverable");
  assert.equal(unread(r.p, "W").length, 0);
  assert.deepEqual(unread(r.p, "O").map((i) => i.intent), ["attention"]);
  assert.throws(() => r.add({ type: "seat", actor: "$user", seatId: "W", threadId: "other" }), /fresh immutable/);
  r.output(r.reserve("O")!, { kind: "error", requestIds: [] }); r.idle("O"); assertions(r);
});

test("additional: one emission imported before terminal cannot strand the reservation or acquire a second claim", () => {
  const r = new Room(); r.request("A"); const w = r.reserve("W")!;
  r.output(w, { kind: "answer", requestIds: ["A"] }, false, { sourceKey: "same-emission" });
  r.request("B"); const receipt = r.sync(w);
  r.output(w, { kind: "answer", requestIds: ["A"] }, true, { sourceKey: "same-emission", receipts: [receipt] });
  assert.equal(r.p.seats.get("W")!.activeRunId, null);
  assert.equal(r.log.filter((e) => e.data.kind === "output" && e.data.sourceKey === "same-emission").length, 1);
  assert.equal(unread(r.p, "O").length, 1); r.idle("W"); assertions(r);
});

test("additional: cancel of definitely rejected dispatch closes only the known reservation and consumes no input", () => {
  const r = new Room(); r.request("A");
  r.add({ type: "reserve", actor: "$system", seatId: "W", runId: "rejected", dispatchCommandId: "dispatch:rejected", dispatchMessageId: "message:rejected", maxBytes: 10000 });
  r.add({ type: "phase", actor: "$system", runId: "rejected", phase: "rejected", evidence: "definite non-acceptance" });
  r.add({ type: "cancel", actor: "$user", requestId: "A" });
  assert.equal(r.p.seats.get("W")!.activeRunId, null); assert.equal(r.p.seats.get("W")!.cursor, 0);
  assert.equal(r.p.requests.get("A")!.state, "cancelled"); assertions(r);
});
