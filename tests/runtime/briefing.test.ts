/**
 * The host's side of L2's envelope briefing (backroom-handoff/L2/interface.md, "What the host owns"): it attaches exactly
 * the images the briefing returns, keeps each seat's standing record (the standing part once per seat, again after a
 * compaction or when the run that carried it never reached the agent), and journals a member's note after its answer
 * with the answered request's ID, so it reaches the requester's next briefing.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { T3TurnItem, TurnImage } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const shot = (name: string, size: number): TurnImage => ({ name, mimeType: "image/png", sizeBytes: size, dataUrl: `data:image/png;base64,${Buffer.alloc(size, 9).toString("base64")}` });
const STANDING = /Standing facts of this room/;

function ask(r: Room, from: string, to: string, body: string): string {
  const id = r.id(`ask-${from}`);
  r.host.request(r.room, { actor: from, id, to, body });
  return id;
}

function sentTo(r: Room, seat: string) {
  return r.fake.sent.filter((s) => s.threadId === r.threadOf(seat));
}

test("images: exactly the ones the briefing names as attached; an open request's are not resent on a later wake", async () => {
  const a1 = shot("bug.png", 772);
  const a2 = shot("bug.png", 512);
  room = await Room.create({ images: (body) => (body.includes("[two screenshots]") ? [a1, a2] : []) });
  const a = ask(room, "C", "W", "Why does this fail? [two screenshots]");
  await room.tick();
  assert.deepEqual(sentTo(room, "W")[0]!.images, [a1, a2], "both images, even with one name, in order");
  room.host.correct(room.room, { actor: "C", id: "fix-1", requestId: a, body: "Only the second screen matters." });
  room.complete("W", "Looking.");
  await room.tick(2);
  const second = sentTo(room, "W")[1]!;
  assert.match(second.text, /Only the second screen matters/);
  assert.equal(second.images, undefined, "the open request's images are not attached again");
});

test("images: a resend after an outage attaches the same images", async () => {
  const image = shot("screen.png", 772);
  room = await Room.create({ images: (body) => (body.includes("[screen]") ? [image] : []) });
  room.fake.unavailableSends = 1;
  ask(room, "C", "W", "Look at this [screen]");
  await room.tick(2);
  const attempts = room.fake.attempts.filter((x) => x.threadId === room.threadOf("W"));
  assert.equal(attempts.length, 2);
  assert.deepEqual(sentTo(room, "W")[0]!.images, [image]);
});

test("standing: the full standing part goes once per seat, then the header names rooms-board rules", async () => {
  room = await Room.create();
  ask(room, "C", "W", "First.");
  await room.tick();
  assert.match(room.prompt("W"), STANDING);
  room.complete("W", "Done.");
  await room.tick();
  ask(room, "C", "W", "Second.");
  await room.tick();
  assert.doesNotMatch(room.prompt("W"), STANDING);
  assert.match(room.prompt("W"), /Your standing rules, where everyone works and the room's state: `\/repo\/bin\/rooms-board rules --as W\.key`/);
  // The record is the journal's: a restart keeps it.
  room.complete("W", "Done.");
  room.restart();
  await room.tick();
  ask(room, "C", "W", "Third.");
  await room.tick();
  assert.doesNotMatch(room.prompt("W"), STANDING);
});

test("standing: after a compaction the next briefing carries the standing part again", async () => {
  room = await Room.create();
  ask(room, "C", "W", "First.");
  await room.tick();
  room.complete("W", "Done.");
  await room.tick();
  const thread = room.fake.thread(room.threadOf("W"));
  const later = new Date(Date.now() + 60_000).toISOString();
  thread.turnItems.push({ id: "compaction-1", runId: thread.runs[0]!.id, nodeId: null, providerTurnId: null, ordinal: thread.turnItems.length + 1, status: "completed", title: null, startedAt: later, completedAt: later, updatedAt: later, type: "compaction", summary: "summary", beforeTokenCount: 190_000, afterTokenCount: 20_000 } as T3TurnItem);
  ask(room, "C", "W", "Second.");
  await room.tick();
  assert.match(room.prompt("W"), STANDING);
});

test("standing: a run that never reached the agent does not count; the next briefing carries the standing part", async () => {
  room = await Room.create();
  room.fake.refuseSends = 3;
  room.user("W", "First.");
  await room.tick(3);
  assert.equal(room.notices().length, 1, "the first run failed before T3 recorded it");
  ask(room, "C", "W", "Second.");
  await room.tick();
  assert.match(room.prompt("W"), STANDING);
});

test("a member's note after its answer carries the answered request, so it reaches the requester's next briefing", async () => {
  room = await Room.create();
  const a = ask(room, "C", "W", "Run the tests.");
  await room.tick();
  room.complete("W", "Tests pass.");
  await room.tick();
  room.complete("C", "ok");
  await room.tick();
  room.fake.startSelfRun(room.threadOf("W"));
  await room.tick();
  room.complete("W", "After my answer: the slow check passed on CI too.");
  await room.tick();
  const note = room.p.events.find((e) => e.data.kind === "note")!;
  assert.deepEqual((note.data as { requestIds: string[] }).requestIds, [a]);
  assert.equal(room.wakes("C"), 1, "the note wakes nobody");
  room.user("C", "Anything new?");
  await room.tick();
  assert.match(room.prompt("C"), /== Also on the board about your requests \(not addressed to you\) ==\n\[#\d+ note from @W on #\d+\]\nAfter my answer: the slow check passed on CI too\./);
});
