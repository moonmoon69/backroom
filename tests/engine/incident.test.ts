import assert from "node:assert/strict";
import { test } from "node:test";
import { unread } from "../../src/engine/index.ts";
import { assertions, Room } from "./helpers.ts";

/** Counterfactual event semantics of #149/#166, not a replay of the old database. */
for (const confirmed of [true, false]) test(`five-wake incident: ${confirmed ? "confirmed final prefix gives zero turns" : "unconfirmed prefix keeps one genuine unread final"}`, () => {
  const r = new Room();
  r.request("p36", "W", "O"); r.request("p43", "X", "O");
  const w = r.reserve("W")!; const x = r.reserve("X")!;
  r.add({ type: "post", id: "p67", actor: "W", intent: "progress", requestIds: ["p36"], body: "Review PASS pending" });
  r.request("p66", "V", "W", "p36"); const v = r.reserve("V")!;
  r.add({ type: "correct", id: "p83", actor: "W", requestId: "p66", body: "Substantive review corrections" });
  r.add({ type: "post", id: "p94", actor: "V", intent: "progress", requestIds: ["p66"], body: "Corrections and PASS pending" });
  r.output(v, { kind: "yield" });
  r.add({ type: "correct", id: "p99", actor: "O", requestId: "p43", body: "Cleanup steer, same original request" });
  const cleanup = r.sync(x);
  r.confirm(x, cleanup);
  r.output(x, { kind: "answer", requestIds: ["p43"] }, false, { id: "p100", sourceKey: "early-C" });
  r.output(x, { kind: "answer", requestIds: ["p43"] }, true, { id: "p103", sourceKey: "shared-native-C" });
  assert.equal(r.output(x, { kind: "answer", requestIds: ["p43"] }, true, { sourceKey: "shared-native-C" }).outcome, "duplicate");
  // Earlier frozen orchestrator input contains context p67/p94 and the unique completion C.
  const earlier = r.reserve("O")!;
  assert.deepEqual(earlier.envelope.inputs.map((i) => i.requestIds), [["p43"]]);
  r.output(earlier, { kind: "yield" });
  r.request("report-request", "O", "$user"); const report = r.reserve("O")!;
  const reviewCorrection = r.reserve("V")!;
  r.output(reviewCorrection, { kind: "answer", requestIds: ["p66"] }, true, { id: "p117", sourceKey: "PASS-A" });
  const pass = r.sync(w);
  r.confirm(w, pass);
  r.output(w, { kind: "answer", requestIds: ["p36"] }, true, { id: "p121", sourceKey: "final-A" });
  const finalA = r.p.sourceKeys.get("final-A")!;
  const receipt = r.sync(report);
  // Citations in p130 are deliberately insufficient evidence of a complete prefix: only a confirmed receipt counts.
  if (confirmed) r.confirm(report, receipt);
  r.output(report, { kind: "answer", requestIds: ["report-request"] }, true,
    { id: "p130", sourceKey: "user-report", body: "Accepted p117/p121 and all gates" });
  const formerJobs = ["wake39", "wake51", "wake87", "wake101", "assignment109"];
  assert.equal(r.log.some((e) => formerJobs.includes(e.id)), false);
  assert.equal(r.log.filter((e) => e.data.kind === "output" && e.data.sourceKey === "shared-native-C").length, 1);
  const pending = unread(r.p, "O");
  assert.deepEqual(pending.map((i) => i.eventId), confirmed ? [] : [finalA]);
  const count = r.p.runs.size;
  if (!confirmed) {
    const next = r.reserve("O")!;
    assert.deepEqual(next.envelope.inputs.map((i) => i.eventId), [finalA]);
    r.output(next, { kind: "silent" });
  }
  r.idle("O", "W", "V", "X");
  assert.equal(r.p.runs.size - count, confirmed ? 0 : 1);
  // A genuinely new result is still delivered after the previously quiet boundary.
  r.request("new-real", "X", "O"); r.finish(r.reserve("X")!, "new-real");
  assert.deepEqual(r.reserve("O")!.envelope.inputs.map((i) => i.requestIds), [["new-real"]]);
  assertions(r);
});
