/**
 * #76: the core's `blocked`. Backroom ($system) tells the orchestrator that a member's thread is held in a state no reply
 * of the member's own ends: an attention notice from the member, on its open requests, once per request per state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { unread } from "../../src/engine/index.ts";
import { assertions, Room } from "./helpers.ts";

test("blocked: one attention notice to the orchestrator on the member's open requests, once per request per state", () => {
  const r = new Room();
  r.request("A");
  r.request("B");
  const body = "@W waits on an approval: git push. Only the user can answer it, from the page; @W's reply comes after.";
  const d = r.add({ type: "blocked", actor: "$system", id: "blocked:W:approval:A", seatId: "W", state: "approval", requestIds: ["A"], body });
  assert.deepEqual(d.events.map((e) => e.data), [{ kind: "notice", intent: "attention", body, requestIds: ["A"], author: "W", recipients: ["O"], causeId: "blocked:W:approval" }]);
  assert.deepEqual(unread(r.p, "O").filter((i) => i.intent === "attention").map((i) => i.requestIds), [["A"]], "it wakes the orchestrator");
  assert.equal(r.add({ type: "blocked", actor: "$system", id: "blocked:again", seatId: "W", state: "approval", requestIds: ["A"], body }).outcome, "duplicate", "the same state on the same request, whatever the command's id");
  const both = r.add({ type: "blocked", actor: "$system", id: "blocked:W:approval:A,B", seatId: "W", state: "approval", requestIds: ["A", "B"], body });
  assert.deepEqual(both.events.map((e) => e.data.kind === "notice" && e.data.requestIds), [["B"]], "only the request not told yet");
  assert.equal(r.add({ type: "blocked", actor: "$system", id: "blocked:W:limited:A", seatId: "W", state: "limited", requestIds: ["A"], body: "@W is paused." }).outcome, "appended", "another state is another notice");
  assertions(r);
});

test("blocked is Backroom's, from an active member that is not the orchestrator, on that member's open requests", () => {
  const r = new Room();
  r.request("A");
  r.request("C", "V");
  const blocked = (over: object) => r.add({ type: "blocked", actor: "$system", seatId: "W", state: "approval", requestIds: ["A"], body: "held", ...over });
  assert.throws(() => blocked({ actor: "O" }), /adapter\/store principal required/);
  assert.throws(() => blocked({ seatId: "O" }), /from an active member to the Consigliere/);
  assert.throws(() => blocked({ body: "" }), /needs a state and a body/);
  assert.throws(() => blocked({ requestIds: ["C"] }), /sits on the member's open requests/);
  r.add({ type: "cancel", actor: "O", requestId: "A" });
  assert.throws(() => blocked({}), /sits on the member's open requests/, "a cancelled request takes the notice with it");
});
