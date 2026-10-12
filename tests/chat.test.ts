/**
 * The user's conversation with the Consigliere (web/src/chat.ts): his replies stay in it after he is reseated (a fresh
 * member takes over; a transfer post links the seats), and it keeps to what is between the user and him.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { consigliereChat, consigliereSeats } from "../web/src/chat.ts";
import type { EnginePost, EngineSeatView, RoomSnapshot } from "../web/src/types.ts";
import { journalView } from "../src/server/engineView.ts";
import { Room as EngineRoom } from "./engine/helpers.ts";

let seq = 0;
const post = (fields: Partial<EnginePost> & Pick<EnginePost, "kind" | "author">): EnginePost => {
  seq += 1;
  return { seq, number: seq, id: `e${seq}`, to: [], body: "", about: [], at: null, after: null, turn: false, ...fields };
};
/** A request post, waking its owner; the user's own come from a message, as on the journal (Backroom's in the user's name do not). */
const request = (id: string, author: string, owner: string, extra: Partial<NonNullable<EnginePost["request"]>> = {}) =>
  post({ kind: "request", author, to: [owner], about: [{ requestId: id, number: seq + 1, owner }], request: { id, parentId: null, rootId: id, owner, returnTo: author, state: "answered", answer: null, corrections: 0, message: author === "$user" ? { id: `m-${id}`, index: 0, attachmentIds: [] } : null, ...extra } });
/** An answer to a request of the author's, waking the request's return address (Backroom's answers wake nobody). */
const reply = (author: string, requestId: string, returnTo: string) =>
  post({ kind: "output", author, to: returnTo === "$system" ? [] : [returnTo], turn: true, output: { disposition: "answer", claims: [{ requestId, number: 1, owner: author, outcome: "answered", returnTo }], source: "final", runId: null, activityId: null, t3: null, afterAnswer: false } });
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
  const calledOffAboutWorker = post({ kind: "note", author: "$user", about: [{ requestId: "r1", number: 1, owner: "W" }], note: { source: "post", room: false, t3: null, afterAnswer: false } });
  const roomNote = post({ kind: "note", author: "$user", note: { source: "post", room: true, t3: null, afterAnswer: false } });
  // A keep-alive to him is on the board; his one-line reply to it is in the chat (#17 dropped H6's exception), like a note of his own.
  const keepAlive = post({ kind: "notice", author: "$system", to: ["B"], notice: { intent: "keep-alive", runId: null, retryRunId: null, retried: false, dismissed: false, backroom: false, needsYou: false } });
  const keepAliveReply = post({ kind: "note", author: "B", note: { source: "keep-alive", room: false, t3: null, afterAnswer: false } });
  const hisNote = post({ kind: "note", author: "B", note: { source: "post", room: false, t3: null, afterAnswer: false } });
  const posts = [before, hisOldReply, briefing, toWorker, workerReply, typedOnWorker, typedOnHisOldThread, checkpoint, calledOffAboutWorker, roomNote, handover, after, hisNewReply, keepAlive, keepAliveReply, hisNote];

  const his = consigliereSeats(snapshot, posts);
  assert.deepEqual([...his.seats].sort(), ["A", "B"], "his seat before the reseat is his");
  assert.deepEqual([...his.threads].sort(), ["tA", "tB"]);
  const chat = consigliereChat(posts, his).map((p) => p.id);
  assert.deepEqual(chat, [before.id, hisOldReply.id, typedOnHisOldThread.id, roomNote.id, after.id, hisNewReply.id, keepAliveReply.id, hisNote.id]);

  // Without the handover post (older than the page holds), only the current seats are his.
  const shortHis = consigliereSeats(snapshot, posts.filter((p) => p !== handover));
  assert.deepEqual([...shortHis.seats], ["B"]);
});

test("B1: Backroom's briefing of a member, its failure (the Consigliere's notice, from before B1 too) and a recovery failure are not in the user's chat", () => {
  const snapshot = {
    room: { consigliereId: "PC" },
    bindings: [
      { id: "C", participantId: "PC", generation: 1, threadId: "tC", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
      { id: "G", participantId: "PG", generation: 1, threadId: "tG", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
    ],
    seats: [seat("C", "tC", { orchestrator: true }), seat("G", "tG")],
  } as unknown as Pick<RoomSnapshot, "room" | "bindings" | "seats">;
  const notice = (to: string[], needsYou: boolean, backroom = false, dismissed = false) =>
    post({ kind: "notice", author: "G", to, notice: { intent: "error", runId: "r", retryRunId: "r", retried: false, dismissed, backroom, needsYou } });
  const briefing = request("seat-briefing:G:seated", "$system", "G", { state: "open" });
  const failed = notice(["C"], false, true);
  const recovery = notice([], false);
  const asked = request("u1", "$user", "C", { state: "open" });
  // A briefing in the user's name (a journal from before B1) failed: it reached him too, so that notice is his (the
  // read API's `backroom`), not in the chat though it names the user.
  const before = notice(["$user", "C"], false, true);
  // A member's failure on a request of the user's (a room that had no Consigliere when it was asked), dismissed: still
  // addressed to the user, so still in the chat.
  const users = notice(["$user"], false, false, true);
  const posts = [briefing, failed, recovery, asked, before, users];
  assert.deepEqual(consigliereChat(posts, consigliereSeats(snapshot, posts)).map((p) => p.id), [asked.id, users.id]);
});

test("B1: the Consigliere's own failed turn on your message is in the chat (the status bar's notice); his replies to Backroom's requests too; his failure that needs nobody is not", () => {
  const snapshot = {
    room: { consigliereId: "PC" },
    bindings: [{ id: "C", participantId: "PC", generation: 1, threadId: "tC", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null }],
    seats: [seat("C", "tC", { orchestrator: true })],
  } as unknown as Pick<RoomSnapshot, "room" | "bindings" | "seats">;
  const notice = (to: string[], needsYou: boolean, dismissed = false) =>
    post({ kind: "notice", author: "C", to, notice: { intent: "error", runId: "r", retryRunId: "r", retried: false, dismissed, backroom: false, needsYou } });
  const asked = request("u1", "$user", "C", { state: "open" });
  const failed = notice(["$user"], true);
  const dismissed = notice(["$user"], false, true);
  const recovery = notice([], false);
  const checkpoint = request("reseat:cp", "$system", "C", { state: "answered" });
  const hisCheckpoint = reply("C", "reseat:cp", "$system");
  const posts = [asked, failed, dismissed, recovery, checkpoint, hisCheckpoint];
  assert.deepEqual(consigliereChat(posts, consigliereSeats(snapshot, posts)).map((p) => p.id), [asked.id, failed.id, dismissed.id, hisCheckpoint.id]);
});


/** D1: a room whose Consigliere is C (seat C on tC), with a worker W; the posts are his, with your request he answers and W's request to him. */
const d1 = () => {
  const snapshot = {
    room: { consigliereId: "PC" },
    bindings: [
      { id: "C", participantId: "PC", generation: 1, threadId: "tC", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
      { id: "W", participantId: "PW", generation: 1, threadId: "tW", deliveredCursor: 0, bootstrapDeliveredAt: null, createdAt: "", retiredAt: null },
    ],
    seats: [seat("C", "tC", { orchestrator: true }), seat("W", "tW")],
  } as unknown as Pick<RoomSnapshot, "room" | "bindings" | "seats">;
  const asked = request("u1", "$user", "C", { state: "answered" });
  const workerAsks = request("w1", "W", "C");
  const answer = reply("C", "u1", "$user");
  const chat = (...his: EnginePost[]) => {
    const posts = [asked, workerAsks, answer, ...his];
    return consigliereChat(posts, consigliereSeats(snapshot, posts)).map((p) => p.id);
  };
  return { asked, answer, chat };
};
/** A claim on a request of his (C's). */
const claim = (requestId: string, returnTo: string, outcome: "answered" | "late" = "answered") => ({ requestId, number: 1, owner: "C", outcome, returnTo });
const output = (to: string[], disposition: "answer" | "yield", claims: ReturnType<typeof claim>[]) =>
  post({ kind: "output", author: "C", to, turn: true, output: { disposition, claims, source: "final", runId: null, activityId: null, t3: null, afterAnswer: false } });

test("D1: the Consigliere's follow-up on your request is in the chat, like his updates and turns of his own: they are addressed to no member", () => {
  const { asked, answer, chat } = d1();
  // A turn his harness started itself (H5), imported as a follow-up on the request his last answer closed: to nobody.
  const followUp = post({ kind: "progress", author: "C", about: [{ requestId: "u1", number: asked.number, owner: "C" }], progress: { milestone: "follow-up", working: false, t3: { threadId: "tC", runId: "t3r", messageId: null } } });
  const update = output([], "yield", []);
  const t3Turn = post({ kind: "note", author: "C", note: { source: "t3-turn", room: false, t3: { threadId: "tC", runId: "t3s", messageId: null }, afterAnswer: false } });
  // His retry of his own failed turn, on your request: it wakes his own seat and is about his own request, not a member's.
  const ownRetry = post({ kind: "retry", author: "C", to: ["C"], about: [{ requestId: "u1", number: asked.number, owner: "C" }], retry: { runId: "rc" } });
  assert.deepEqual(chat(followUp, update, t3Turn, ownRetry), [asked.id, answer.id, followUp.id, update.id, t3Turn.id, ownRetry.id]);
});

test("D1: the Consigliere's reply to a keep-alive is in the chat (#17 dropped H6's exception)", () => {
  const { asked, answer, chat } = d1();
  const keepAlive = post({ kind: "notice", author: "$system", to: ["C"], notice: { intent: "keep-alive", runId: null, retryRunId: null, retried: false, dismissed: false, backroom: false, needsYou: false } });
  const keepAliveReply = post({ kind: "note", author: "C", note: { source: "keep-alive", room: false, t3: null, afterAnswer: false } });
  assert.deepEqual(chat(keepAlive, keepAliveReply), [asked.id, answer.id, keepAliveReply.id]);
});

test("D1: what the Consigliere addresses to a member stays on the board: his request, his correction, a late answer that wakes nobody, posts about a member's request that wake nobody, and a post to you and a member at once", () => {
  const { asked, answer, chat } = d1();
  const toWorker = request("r1", "C", "W");
  const correction = post({ kind: "correction", author: "C", to: ["W"], about: [{ requestId: "r1", number: toWorker.number, owner: "W" }] });
  // His answer to the worker's request after it was closed: its claim returns to a seat, and it wakes nobody.
  const lateToWorker = output([], "answer", [claim("w1", "W", "late")]);
  // Addressed to you and to a member at once, in its recipients or only in its claims: a member's, so on the board.
  const bothWoken = output(["$user", "W"], "answer", [claim("u1", "$user"), claim("w1", "W")]);
  const bothClaimed = output(["$user"], "answer", [claim("u1", "$user"), claim("w1", "W", "late")]);
  const noteToBoth = post({ kind: "note", author: "C", to: ["$user", "W"], note: { source: "t3-message", room: false, t3: { threadId: "tC", runId: null, messageId: "m9" }, afterAnswer: false } });
  // About the worker's request, waking nobody: his cancel of it once it had closed, and a cancel held to its turn's end
  // (a journal from before M1). A word to the member's work, not to you.
  const closed = request("r2", "C", "W");
  const lateCancel = post({ kind: "cancel", author: "C", body: "Cancel requested", about: [{ requestId: "r2", number: closed.number, owner: "W" }], cancel: { applied: false } });
  const deferredCancel = post({ kind: "note", author: "C", about: [{ requestId: "r1", number: toWorker.number, owner: "W" }], note: { source: "deferred-cancel", room: false, t3: null, afterAnswer: false } });
  assert.deepEqual(chat(toWorker, correction, lateToWorker, bothWoken, bothClaimed, noteToBoth, closed, lateCancel, deferredCancel), [asked.id, answer.id]);
});

/** Review regression: the snapshot returns only the newest 500 posts; older request posts load on demand. */
test("D1 review: request-owner filtering is stable across the initial 500-post page", () => {
  const room = new EngineRoom();
  const his = { seats: new Set(["O"]), threads: new Set(["thread:O"]) };
  room.request("old-worker", "W", "O");
  room.finish(room.reserve("W")!, "old-worker");
  room.request("old-own", "O", "$user");
  room.finish(room.reserve("O")!, "old-own");
  for (let i = 0; i < 500; i++) room.add({ type: "post", actor: "$user", intent: "note", body: `Pagination gap ${i}` });
  room.add({ type: "cancel", actor: "O", requestId: "old-worker" });
  room.add({ type: "cancel", actor: "O", requestId: "old-own" });
  const full = journalView({ p: room.p }).posts;
  const initial = full.slice(-500);
  const memberCancel = full.find((p) => p.kind === "cancel" && p.about[0]?.requestId === "old-worker")!;
  const ownCancel = full.find((p) => p.kind === "cancel" && p.about[0]?.requestId === "old-own")!;
  assert.deepEqual(memberCancel.to, [], "a cancel of a closed request wakes nobody");
  assert.equal(initial.some((p) => p.request?.id === "old-worker" || p.request?.id === "old-own"), false, "both request posts are outside the initial page");
  const loadedChat = consigliereChat(full, his);
  const initialChat = consigliereChat(initial, his);
  assert.equal(loadedChat.some((p) => p.id === ownCancel.id), true, "his own control post belongs in chat");
  assert.equal(initialChat.some((p) => p.id === ownCancel.id), true, "his own control post remains in chat without its request post");
  assert.equal(loadedChat.some((p) => p.id === memberCancel.id), false, "a member's control post belongs only on the board");
  assert.equal(initialChat.some((p) => p.id === memberCancel.id), false, "a member's control post stays off chat without its request post");
});

test("D1: your correction of an old request of his is in the chat on the first page too, of a member's on the board: the ref carries the request's owner", () => {
  const room = new EngineRoom();
  const his = { seats: new Set(["O"]), threads: new Set(["thread:O"]) };
  room.request("yours", "O", "$user");
  room.request("theirs", "W", "$user");
  for (let i = 0; i < 500; i++) room.add({ type: "post", actor: "$user", intent: "note", body: `Pagination gap ${i}` });
  room.add({ type: "correct", actor: "$user", requestId: "yours", body: "Also the notes." });
  room.add({ type: "correct", actor: "$user", requestId: "theirs", body: "Also the tests." });
  const full = journalView({ p: room.p }).posts;
  const initial = full.slice(-500);
  assert.equal(initial.some((p) => p.request), false, "both request posts are outside the first page");
  const corrections = full.filter((p) => p.kind === "correction");
  assert.deepEqual(corrections.map((p) => p.about[0]?.owner), ["O", "W"], "each correction's ref names its request's owner");
  for (const page of [full, initial]) {
    const chat = consigliereChat(page, his).map((p) => p.id);
    assert.deepEqual(corrections.map((p) => chat.includes(p.id)), [true, false], "yours to him in the chat, yours to a member's work on the board");
  }
});

test("D1 review: a post about his former seat's closed request stays in chat when the reseat is outside the loaded page", () => {
  const room = new EngineRoom();
  room.request("old-own", "O", "$user");
  room.finish(room.reserve("O")!, "old-own");
  room.add({ type: "transfer", actor: "$user", oldSeatId: "O", newSeatId: "O2", threadId: "thread:O2", owned: [], awaited: [], body: "Reseat", evidence: "review" });
  for (let i = 0; i < 500; i++) room.add({ type: "post", actor: "$user", intent: "note", body: `Pagination gap ${i}` });
  room.add({ type: "cancel", actor: "O2", requestId: "old-own" });
  const full = journalView({ p: room.p }).posts;
  const initial = full.slice(-500);
  const snapshot = {
    room: { consigliereId: "P2" },
    bindings: [
      { id: "O", participantId: "P1", threadId: "thread:O" },
      { id: "O2", participantId: "P2", threadId: "thread:O2" },
    ],
    seats: journalView({ p: room.p }).seats,
  } as unknown as Pick<RoomSnapshot, "room" | "bindings" | "seats">;
  const cancel = full.at(-1)!;
  assert.equal(cancel.about[0]?.owner, "O", "a closed request keeps its owner across the reseat");
  assert.equal(initial.some((p) => p.transfer), false, "the transfer is outside the first page");
  assert.equal(consigliereChat(full, consigliereSeats(snapshot, full)).some((p) => p.id === cancel.id), true, "his former seat is his when the transfer is loaded");
  assert.equal(consigliereChat(initial, consigliereSeats(snapshot, initial)).some((p) => p.id === cancel.id), true, "his former seat must also be his before the transfer loads");
});
