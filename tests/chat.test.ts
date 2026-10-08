/**
 * The user's conversation with the Consigliere (web/src/chat.ts): his replies stay in it after he is reseated (a fresh
 * member takes over; a transfer post links the seats), and it keeps to what is between the user and him.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { consigliereChat, consigliereSeats } from "../web/src/chat.ts";
import type { EnginePost, EngineSeatView, RoomSnapshot } from "../web/src/types.ts";

let seq = 0;
const post = (fields: Partial<EnginePost> & Pick<EnginePost, "kind" | "author">): EnginePost => {
  seq += 1;
  return { seq, number: seq, id: `e${seq}`, to: [], body: "", about: [], at: null, after: null, turn: false, ...fields };
};
/** A request post; the user's own come from a message, as on the journal (Backroom's in the user's name do not). */
const request = (id: string, author: string, owner: string, extra: Partial<NonNullable<EnginePost["request"]>> = {}) =>
  post({ kind: "request", author, about: [{ requestId: id, number: seq + 1 }], request: { id, parentId: null, rootId: id, owner, returnTo: author, state: "answered", answer: null, corrections: 0, message: author === "$user" ? { id: `m-${id}`, index: 0, steer: false, attachmentIds: [] } : null, ...extra } });
const reply = (author: string, requestId: string, returnTo: string) =>
  post({ kind: "output", author, turn: true, output: { disposition: "answer", claims: [{ requestId, number: 1, outcome: "answered", returnTo }], source: "final", runId: null, activityId: null, t3: null, afterAnswer: false } });
const seat = (seatId: string, threadId: string, extra: Partial<EngineSeatView> = {}): EngineSeatView => ({
  seatId, participantId: null, alias: null, threadId, status: "active", orchestrator: false, cursor: 0, activeRunId: null, unread: 0, blocked: null, activities: [], owns: 0, awaits: 0, ...extra,
});

test("the chat keeps the Consigliere's replies from before he was reseated, and only what is between the user and him", () => {
  // fable (participant P1, seat A on thread tA) is reseated as fable2 (P2, seat B on tB); W is a worker (seat W).
  const snapshot = {
    room: { consigliereId: "P2" },
    bindings: [
      { id: "A", participantId: "P1", generation: 1, threadId: "tA", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: "x" },
      { id: "B", participantId: "P2", generation: 1, threadId: "tB", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
      { id: "W", participantId: "PW", generation: 1, threadId: "tW", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
    ],
    seats: [seat("A", "tA", { status: "retired" }), seat("B", "tB", { orchestrator: true }), seat("W", "tW")],
  } as unknown as Pick<RoomSnapshot, "room" | "bindings" | "seats">;
  const before = request("u1", "$user", "A");
  const hisOldReply = reply("A", "u1", "$user");
  const briefing = request("seat-briefing:W:seated", "$user", "W", { message: null });
  const toWorker = request("r1", "A", "W");
  const workerReply = reply("W", "r1", "A");
  const typedOnWorker = post({ kind: "note", author: "$user", note: { source: "t3-message", room: false, t3: { threadId: "tW", runId: null, messageId: "m1" }, afterAnswer: false } });
  const typedOnHisOldThread = post({ kind: "note", author: "$user", note: { source: "t3-message", room: false, t3: { threadId: "tA", runId: null, messageId: "m2" }, afterAnswer: false } });
  const handover = post({ kind: "transfer", author: "$system", transfer: { oldSeatId: "A", newSeatId: "B", owned: [], awaited: [] } });
  const after = request("u2", "$user", "B");
  const hisNewReply = reply("B", "u2", "$user");
  // The reseat's checkpoint request to him and its call-off note are Backroom's, in the user's name: not the user's words.
  const checkpoint = request("reseat:cp1", "$user", "A", { message: null });
  const calledOffAboutWorker = post({ kind: "note", author: "$user", about: [{ requestId: "r1", number: 1 }], note: { source: "post", room: false, t3: null, afterAnswer: false } });
  const roomNote = post({ kind: "note", author: "$user", note: { source: "post", room: true, t3: null, afterAnswer: false } });
  const posts = [before, hisOldReply, briefing, toWorker, workerReply, typedOnWorker, typedOnHisOldThread, checkpoint, calledOffAboutWorker, roomNote, handover, after, hisNewReply];

  const his = consigliereSeats(snapshot, posts);
  assert.deepEqual([...his.seats].sort(), ["A", "B"], "his seat before the reseat is his");
  assert.deepEqual([...his.threads].sort(), ["tA", "tB"]);
  const chat = consigliereChat(posts, his).map((p) => p.id);
  assert.deepEqual(chat, [before.id, hisOldReply.id, typedOnHisOldThread.id, roomNote.id, after.id, hisNewReply.id]);

  // Without the handover post (older than the page holds), only the current seats are his.
  const shortHis = consigliereSeats(snapshot, posts.filter((p) => p !== handover));
  assert.deepEqual([...shortHis.seats], ["B"]);
});
