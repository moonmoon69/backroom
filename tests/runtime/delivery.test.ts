/**
 * Sending and failing: a passing T3 error never starves a seat and a lasting one fails visibly (the reviewer's hunt 2);
 * a turn with no message is never an empty answer (hunt 3); one failure notice to the asker and the orchestrator with
 * no self-wake; followers (§4); an image reaching T3 with the message.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SendMessageInput, TurnImage } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

function phasesOf(r: Room, seat: string): string[] {
  return r.p.events.flatMap((e) => (e.data.kind === "run.phase" && r.p.runs.get(e.data.runId)?.seatId === seat ? [e.data.phase] : []));
}

test("hunt 2: a passing T3 refusal is sent again with the same IDs; the member is not starved and runs once", async () => {
  room = await Room.create();
  room.fake.refuseSends = 2;
  const a = ask(room, "C", "W", "Fix dates.ts.");
  await room.tick();
  assert.equal(room.running("W"), false);
  await room.tick();
  assert.equal(room.running("W"), false);
  await room.tick();
  assert.equal(room.running("W"), true, "the third try goes through");
  assert.equal(room.fake.attempts.length, 3);
  assert.equal(new Set(room.fake.attempts.map((x) => `${x.commandId}/${x.messageId}`)).size, 1, "every try used the run's frozen IDs");
  assert.equal(room.wakes("W"), 1);
  assert.ok(!phasesOf(room, "W").includes("rejected"), "never recorded as rejected");
  assert.deepEqual(room.notices(), []);
  room.complete("W", "Fixed.");
  await room.tick();
  assert.equal(room.state(a), "answered");
});

test("hunt 2: a lasting refusal fails the run visibly: one notice to the asker and the orchestrator; a retry delivers it", async () => {
  room = await Room.create();
  room.fake.refuseSends = 3;
  const a = room.user("W", "Fix dates.ts.");
  await room.tick(3);
  const run = [...room.p.runs.values()].find((r) => r.seatId === "W")!;
  assert.equal(room.p.runs.get(run.id)!.phase, "terminal");
  assert.match(room.p.runs.get(run.id)!.failure ?? "", /T3 refused the message for @W/);
  const notices = room.notices();
  assert.equal(notices.length, 1);
  assert.deepEqual([...notices[0]!.recipients].sort(), ["$user", "C"]);
  assert.equal(room.state(a), "open");
  assert.ok(!phasesOf(room, "W").includes("rejected"));
  await room.tick();
  assert.equal(room.wakes("C"), 1, "the orchestrator is told once");
  room.complete("C", "W's message was refused; retrying.");
  room.host.retry(room.room, { actor: "C", id: "retry-1", runId: run.id, body: "Try again." });
  await room.tick();
  assert.equal(room.running("W"), true, "the retry carries the original content");
  assert.match(room.prompt("W"), /Fix dates\.ts/);
  room.complete("W", "Fixed.");
  await room.tick();
  assert.equal(room.state(a), "answered");
});

test("hunt 2: an outage keeps the run sending and it goes out when T3 is back", async () => {
  room = await Room.create();
  room.fake.unavailableSends = 5;
  ask(room, "C", "W", "Fix dates.ts.");
  await room.tick(5);
  assert.equal(room.running("W"), false);
  assert.deepEqual(room.notices(), []);
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.equal(room.wakes("W"), 1);
});

test("hunt 3: a turn that ends with no message is never an empty answer; its requester gets one error notice", async () => {
  room = await Room.create();
  const a = ask(room, "V", "W", "Fix dates.ts.");
  await room.tick();
  room.fake.completeRun(room.threadOf("W"), { text: "" });
  await room.tick();
  assert.equal(room.state(a), "open");
  assert.ok(room.outputs().every((o) => o.claims.length === 0), "no claim, so no answer wakes anyone");
  const notices = room.notices();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.body, /@W's turn ended without a reply/);
  assert.deepEqual([...notices[0]!.recipients].sort(), ["C", "V"]);
  const run = [...room.p.runs.values()].find((r) => r.seatId === "W")!;
  assert.notEqual(room.p.runs.get(run.id)!.failure, null, "it can be retried");
});

test("hunt 3: a notice-only turn with no message is silent and wakes nobody", async () => {
  room = await Room.create();
  ask(room, "C", "W", "Ask V to review.");
  await room.tick();
  room.post("W", "V", "Review please.");
  room.complete("W", "Asked V.");
  await room.tick();
  room.complete("V", "crashed", { outcome: "error" });
  await room.tick();
  assert.equal(room.running("W"), true, "W is woken by the error notice");
  const cWakes = room.wakes("C");
  room.fake.completeRun(room.threadOf("W"), { text: "" });
  await room.tick(2);
  const last = room.outputs().filter((o) => o.author === "W").pop()!;
  assert.deepEqual(last.disposition, { kind: "silent" });
  assert.equal(room.notices().length, 1, "no second notice");
  assert.equal(room.wakes("C"), cWakes);
});

test("a failed run: one error notice to the asker and the orchestrator, none to itself; an orchestrator failing does not wake itself", async () => {
  room = await Room.create();
  ask(room, "V", "W", "Fix dates.ts.");
  await room.tick();
  room.complete("W", "provider error: overloaded", { outcome: "error" });
  await room.tick();
  const first = room.notices();
  assert.equal(first.length, 1);
  assert.deepEqual([...first[0]!.recipients].sort(), ["C", "V"]);
  assert.match(first[0]!.body, /overloaded/);
  await room.tick(2);
  assert.equal(room.wakes("W"), 1, "no self-wake");
  room.complete("C", "Noted.");
  room.complete("V", "Noted.");
  await room.tick();
  room.user("C", "Plan the release.");
  await room.tick();
  const cWakes = room.wakes("C");
  room.complete("C", "provider error", { outcome: "error" });
  await room.tick(3);
  const second = room.notices()[1]!;
  assert.deepEqual(second.recipients, ["$user"], "the orchestrator's own failure goes to the asker, not to itself");
  assert.equal(room.wakes("C"), cWakes);
});

test("a run stopped in T3 by someone is a failure with its notice", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Fix dates.ts.");
  await room.tick();
  room.complete("W", "(interrupted)", { outcome: "interrupted" });
  await room.tick();
  assert.equal(room.state(a), "open");
  assert.equal(room.notices().length, 1);
  assert.match(room.notices()[0]!.body, /stopped in T3/);
});

test("§4: a follower is woken by working posts, together in one run; a non-follower is not", async () => {
  room = await Room.create({ seats: ["C", "W", "V", "X"] });
  const a = ask(room, "C", "W", "Watch CI.");
  ask(room, "X", "W", "Unrelated: what time is it?");
  room.host.follow(room.room, { actor: "C", id: "follow-1", requestId: a, enabled: true });
  await room.tick();
  room.working("W", "CI started.", [a]);
  room.working("W", "CI half way.", [a]);
  room.complete("W", "Watching CI; it is 10:00.");
  await room.tick();
  assert.equal(room.wakes("C"), 1, "the follower is woken once for both working posts");
  assert.match(room.prompt("C"), /CI started[\s\S]*CI half way/);
  room.complete("C", "ok");
  await room.tick();
  assert.equal(room.wakes("X"), 1, "X is woken by its own answer only");
  room.host.follow(room.room, { actor: "C", id: "follow-2", requestId: a, enabled: false });
  room.answer("W", "CI is green.", [a]);
  await room.tick();
  assert.equal(room.wakes("C"), 2, "the answer wakes the requester");
  assert.equal(room.wakes("V"), 0, "a non-follower is never woken");
});

test("an image attachment reaches T3 with the message", async () => {
  const png: TurnImage = { name: "screen.png", mimeType: "image/png", sizeBytes: 772, dataUrl: `data:image/png;base64,${Buffer.alloc(772, 7).toString("base64")}` };
  room = await Room.create({ images: (body) => (body.includes("[image]") ? [png] : []) });
  ask(room, "C", "W", "What is wrong on this screen? [image]");
  await room.tick();
  assert.equal(room.running("W"), true);
  assert.deepEqual(room.fake.sent[0]!.images, [png]);
  const message = room.fake.thread(room.threadOf("W")).messages.find((m) => m.role === "user")!;
  assert.deepEqual(message.attachments.map((x) => [x.name, x.mimeType, x.sizeBytes]), [["screen.png", "image/png", 772]]);
});

test("the text T3 receives is frozen with the run before it is sent, and a resend sends the same bytes", async () => {
  room = await Room.create();
  room.fake.dropAcks = true;
  ask(room, "C", "W", "Fix dates.ts.");
  await room.tick();
  room.fake.dropAcks = false;
  const run = [...room.p.runs.values()].find((r) => r.seatId === "W")!;
  const sending = room.p.events.find((e) => e.data.kind === "run.phase" && e.data.runId === run.id && e.data.phase === "sending")!;
  const frozen = JSON.parse((sending.data as { evidence: string }).evidence) as { text: string };
  await room.tick();
  assert.equal(room.wakes("W"), 1, "the lost acknowledgement did not make a second run");
  assert.equal(room.prompt("W"), frozen.text);
});

test("a message T3 records only after its run failed as never recorded: its late reply is a note, and wakes nobody", async () => {
  room = await Room.create({ host: { unrecordedMs: 1_000 } });
  room.user("W", "First.");
  await room.tick();
  room.complete("W", "First done.");
  await room.tick();
  // T3 takes the next message and records nothing, for longer than the bound.
  const original = room.fake.sendMessage.bind(room.fake);
  const swallowed: SendMessageInput[] = [];
  room.fake.sendMessage = async (input) => void swallowed.push(input);
  const b = room.user("W", "Second.");
  await room.tick();
  room.clock += 2_000;
  await room.tick();
  assert.match(room.notices()[0]?.body ?? "", /never recorded it/);
  const wRuns = [...room.p.runs.values()].filter((r) => r.seatId === "W");
  assert.equal(wRuns.length, 2);
  assert.ok(wRuns.every((r) => r.phase === "terminal"));
  // Then T3 records it after all, and runs it.
  room.fake.sendMessage = original;
  await original(swallowed[0]!);
  room.complete("W", "Second done, late.");
  await room.tick(2);
  const late = room.p.events.filter((e) => e.data.kind === "note").map((e) => (e.data as { body: string }).body);
  assert.deepEqual(late, ["(T3 ran a message after Backroom had recorded it as failed) Second done, late."]);
  assert.equal(room.state(b), "open", "a note answers nothing; the failure notice already offered a retry");
});
