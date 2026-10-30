/**
 * Review #117 of #76 (Sol's reproductions, review 110): a blocked notice is keyed on the hold itself, as T3 keys its
 * attention on the run and the state: a second approval on the same open request, or a second limited run it waits
 * behind, is told again; the same one, through ticks and a restart, is not. An approval's notice words the approval,
 * whatever T3 asked before it. Flapping work, a cancel and a retire post nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Room } from "./helpers.ts";

const held = (r: Room) => r.notices().filter(n => n.intent === "attention" && n.causeId.startsWith("blocked:"));

test("review 110: a second approval in a later retry notifies on the same open request", async () => {
  const r = await Room.create();
  try {
    const a = r.post("C", "W", "Fix A.");
    await r.tick();
    const threadId = r.threadOf("W");
    r.fake.raiseApproval(threadId, "first", { prompt: "npm test" });
    await r.tick(3);
    r.restart();
    await r.tick(3);
    assert.equal(held(r).length, 1);
    await r.fake.respondApproval({commandId: "accept-first", threadId, requestId: "first", decision: "accept"});
    await r.tick(3);
    assert.equal(held(r).length, 1);
    r.complete("W", "provider at capacity", {outcome: "error"});
    await r.tick(2);
    const run = [...r.p.runs.values()].find(run => run.seatId === "W")!;
    r.host.retry(r.room, {actor: "C", id: r.id("retry"), runId: run.id, body: "Retry A."});
    await r.tick(2);
    r.fake.raiseApproval(threadId, "second", {prompt: "git push"});
    await r.tick(3);
    assert.equal(r.state(a), "open");
    assert.equal(held(r).length, 2, "a new hold must notify again");
    assert.match(held(r)[1]!.body, /git push/);
  } finally { r.close(); }
});

test("review 110: the approval notice names the approval even when a question was raised first", async () => {
  const r = await Room.create();
  try {
    r.post("C", "W", "Fix A.");
    await r.tick();
    const threadId = r.threadOf("W");
    r.fake.raiseQuestion(threadId, {requestId: "question-first", responseMode: "message"});
    r.fake.raiseApproval(threadId, "approval-second", {prompt: "git push origin member-state"});
    await r.tick(3);
    assert.equal(held(r).length, 1);
    assert.match(held(r)[0]!.body, /waits on an approval: git push origin member-state/);
  } finally { r.close(); }
});

test("review 110: a new usage-limited run notifies a request still waiting behind it", async () => {
  const r = await Room.create();
  try {
    r.post("C", "W", "Fix A.");
    await r.tick();
    const threadId = r.threadOf("W");
    const resetAt = new Date(Date.now()+3600000).toISOString();
    r.complete("W", "usage limit", {outcome:"limit",resetAt});
    await r.tick(3);
    const b = r.post("C", "W", "Fix B too.");
    await r.tick(3);
    assert.equal(held(r).filter(n=>n.requestIds.includes(b)).length, 1);
    const first = r.fake.runsOf(threadId).find(run=>run.status==="failed")!;
    await r.fake.controlThread({commandId:"continue-first-limit",threadId,control:{type:"run.continue",runId:first.id}});
    await r.tick(3);
    r.complete("W", "another usage limit", {outcome:"limit",resetAt:new Date(Date.now()+7200000).toISOString()});
    await r.tick(4);
    r.restart();
    await r.tick(3);
    assert.equal(r.state(b),"open");
    assert.equal(held(r).filter(n=>n.requestIds.includes(b)).length, 2, "a new limited run is a new hold on B, told once through a restart");
    const a = [...r.p.requests.values()].find((q) => q.body.includes("Fix A."))!.id;
    assert.equal(held(r).filter(n=>n.requestIds.includes(a)).length, 0, "A has each limited run's own pause, on its follow-up: no notice repeats it");
  } finally {r.close();}
});

test("review 110: non-blocking work and ready flapping across 240 ticks posts no blocked notices", async () => {
  const r = await Room.create();
  try {
    const a = r.post("C", "W", "Fix A.");
    await r.tick(3);
    r.complete("W", "provider at capacity", {outcome: "error"});
    await r.tick(2);
    const threadId = r.threadOf("W");
    for (let i=0; i<20; i++) {
      r.fake.startSelfRun(threadId);
      r.fake.background(threadId, [{taskId: `command-${i}`, kind: "command", description: "npm test", childThreadId: null}]);
      r.fake.linkPullRequest(threadId, {repository: "review/fixture", number: 110, watched: true, checksState: i%2 ? "passing" : "pending"});
      await r.tick(6);
      r.complete("W", "Still checking.");
      r.fake.background(threadId, []);
      r.fake.linkPullRequest(threadId, {repository: "review/fixture", number: 110, watched: false, checksState: i%2 ? "failing" : "passing"});
      await r.tick(6);
      assert.equal(r.state(a), "open");
    }
    assert.equal(held(r).length, 0);
  } finally { r.close(); }
});

test("review 110: cancellation and retiring prevent later notices", async () => {
  const r = await Room.create();
  try {
    const a = r.post("C", "W", "Fix A.");
    await r.tick();
    const threadId = r.threadOf("W");
    r.fake.raiseApproval(threadId, "first");
    await r.tick(3);
    assert.equal(held(r).length, 1);
    r.cancel("C",a);
    await r.tick(5);
    assert.equal(r.state(a), "cancelled");
    if(r.running("W")) {r.complete("W", "Cancelled."); await r.tick(3);}
    r.fake.startSelfRun(threadId);
    r.fake.raiseQuestion(threadId);
    await r.tick(6);
    assert.equal(held(r).length, 1);
    r.complete("W", "Noted.");
    await r.tick(3);
    r.host.retire(r.room, {actor:"C",id:r.id("retire"),seatId:"W",evidence:"request cancelled and thread idle"});
    r.fake.startSelfRun(threadId);
    r.fake.raiseApproval(threadId, "retired-hold");
    await r.tick(5);
    assert.equal(held(r).length, 1);
  } finally { r.close(); }
});
