/**
 * The tag over a member's reply (web/src/replyTo.ts) on the engine's journal: what the reply did to each request it
 * named, in the engine's own outcomes, with the board numbers the read API gives (never worked out from sequences).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { backroomBriefing, backroomNote, backroomNotice, claimPieces, intoRunningTurn, replyPieces, replyText, sourceWords, type ReplyContext } from "../web/src/replyTo.ts";
import type { EngineClaim, EnginePost } from "../web/src/types.ts";
import { journalView } from "../src/server/engineView.ts";
import { Room } from "./runtime/helpers.ts";

/** A request post; the user's come from a message (as on the journal), unless `fromMessage` says otherwise (Backroom's). */
const request = (id: string, number: number, author: string, state: "open" | "answered" | "cancelled" = "open", fromMessage = author === "$user"): EnginePost => ({
  seq: number,
  number,
  id,
  kind: "request",
  author,
  to: ["W"],
  body: "do it",
  about: [{ requestId: id, number }],
  at: null,
  after: null,
  turn: false,
  request: { id, parentId: null, rootId: id, owner: "W", returnTo: author, state, answer: null, corrections: 0, message: fromMessage ? { id: `m-${id}`, index: 0, steer: false, attachmentIds: [] } : null },
});

const context = (posts: EnginePost[]): ReplyContext => ({
  requestPost: (id) => posts.find((post) => post.request?.id === id),
  nameOf: (principal) => (principal === "$user" ? "you" : `@${principal}`),
});

const claim = (requestId: string, number: number, outcome: EngineClaim["outcome"]): EngineClaim => ({ requestId, number, outcome, returnTo: "$user" });

test("each outcome the engine gives a claim gets its own words, with the request's board number", () => {
  const posts = [request("A", 12, "$user"), request("B", 14, "C"), request("X", 20, "$user", "cancelled"), request("T", 21, "C", "answered")];
  const words = (c: EngineClaim) => replyText(claimPieces(c, context(posts)));
  assert.equal(words(claim("A", 12, "answered")), "answers #12 from you");
  assert.equal(words(claim("B", 14, "answered")), "answers #14 from @C");
  assert.equal(words(claim("A", 12, "already_answered")), "#12 was answered already");
  assert.equal(words(claim("X", 20, "late")), "late for #20: it was cancelled");
  assert.equal(words(claim("T", 21, "late")), "late for #21: it was handed to a fresh seat");
  // A late claim on a request the page does not hold: no reason given rather than a guessed one.
  assert.equal(words(claim("Q", 30, "late")), "late for #30");
  assert.equal(words(claim("A", 12, "superseded")), "#12 stays open: input it had not seen came in");
  assert.equal(words(claim("A", 12, "pending_activity")), "#12 stays open: a review or background work is still running");
  // Backroom's briefing to a member, made in the user's name: its acknowledgement does not say "from you".
  const briefing = { ...request("seat-briefing:W:seated", 2, "$user", "open", false), id: "b" };
  assert.equal(replyText(claimPieces(claim("seat-briefing:W:seated", 2, "answered"), context([...posts, briefing]))), "answers #2 (seat briefing)");
  // B1: Backroom's own ($system), as briefings are recorded now: the same words, its answer returning to nobody.
  const own = { ...request("seat-briefing:V:seated", 4, "$system"), id: "c" };
  assert.equal(replyText(claimPieces({ ...claim("seat-briefing:V:seated", 4, "answered"), returnTo: "$system" }, context([...posts, own]))), "answers #4 (seat briefing)");
  // A request the page does not hold (older than the loaded posts): its number is still read from the claim.
  assert.equal(replyText(claimPieces(claim("Z", 3, "answered"), context(posts))), "answers #3");
});

test("a reply that named no request, an update and a failure say so; how it came about is named", () => {
  const output = (disposition: NonNullable<EnginePost["output"]>["disposition"], source: NonNullable<EnginePost["output"]>["source"], claims: EngineClaim[] = []): EnginePost => ({
    seq: 30,
    number: 30,
    id: "o",
    kind: "output",
    author: "W",
    to: [],
    body: "text",
    about: disposition === "yield" ? [] : [{ requestId: "A", number: 12 }],
    at: null,
    after: null,
    turn: source === "final" || source === "continuation",
    output: { disposition, claims, source, runId: null, activityId: null, t3: null, afterAnswer: false },
  });
  const posts = [request("A", 12, "$user")];
  assert.equal(replyText(replyPieces(output("yield", "final"), context(posts))), "update");
  assert.equal(replyText(replyPieces(output("progress", "continuation"), context(posts))), "update on #12");
  assert.equal(replyText(replyPieces(output("error", "final"), context(posts))), "failed on #12");
  assert.equal(replyText(replyPieces(output("answer", "answer", [claim("A", 12, "answered"), claim("A", 12, "late")]), context(posts))), "answers #12 from you · late for #12: it was handed to a fresh seat");
  assert.equal(sourceWords(output("answer", "final")), null);
  assert.equal(sourceWords(output("answer", "answer")), "rooms-board answer");
  assert.equal(sourceWords(output("progress", "continuation")), "continued on its own");
  assert.equal(sourceWords(output("answer", "idle")), "background work ended without a further turn");
});

test("on a real journal, the tag of a member's final names the request it answered by the read API's number", async (t) => {
  const room = await Room.create();
  t.after(() => room.close());
  // As the user's message path (L4a) writes it: the request ID names the message it came from.
  const asked = "msg:m1:0:W";
  room.host.request(room.room, { actor: "$user", id: asked, to: "W", body: "Fix the date test." });
  await room.until(() => room.running("W"));
  room.complete("W", "Fixed: the parser now reads ISO weeks.");
  await room.until(() => room.state(asked) === "answered");
  const view = journalView({ p: room.p });
  const post = view.posts.find((p) => p.request?.id === asked)!;
  const reply = view.posts.find((p) => p.output?.claims.some((c) => c.requestId === asked && c.outcome === "answered"))!;
  assert.ok(post && reply, "the request and its answer are on the board");
  const text = replyText(replyPieces(reply, context(view.posts)));
  assert.equal(text, `answers #${post.number} from you`);
  assert.equal(post.request?.state, "answered", "the request's marker");
  assert.equal(post.request?.answer?.number, reply.number, "the marker points at the reply");
});

test("what Backroom wrote in the user's name is Backroom's: any request without a user message, and notes that are not the user's", () => {
  assert.equal(backroomNotice(request("msg:m1:0:W", 3, "$user")), null, "a request from the user's message is the user's");
  assert.equal(backroomNotice(request("seat-briefing:W:seated", 4, "$user", "open", false)), "seat briefing");
  assert.equal(backroomNotice(request("moved:W:x", 5, "$user", "open", false)), "new Consigliere notice");
  assert.equal(backroomNotice(request("reseat:abc", 6, "$user", "open", false)), "reseat checkpoint");
  assert.equal(backroomNotice(request("takeover:abc", 7, "$user", "open", false)), "reseat handover");
  assert.equal(backroomNotice(request("reseat-off:abc", 8, "$user", "open", false)), "reseat called off");
  assert.equal(backroomNotice(request("something-new:abc", 9, "$user", "open", false)), "Backroom's request", "no user message: Backroom's, whatever the ID");
  assert.equal(backroomNotice(request("board:abc", 10, "C")), null, "a member's request is the member's");
  // B1: Backroom's own requests ($system), as its briefings are recorded now.
  assert.equal(backroomNotice(request("seat-briefing:W:seated", 11, "$system")), "seat briefing");
  assert.equal(backroomNotice(request("moved:W:y", 12, "$system")), "new Consigliere notice");
  assert.equal(backroomNotice(request("something-new:def", 13, "$system")), "Backroom's request");
  // What removing a member cancels with it (the Remove dialog does not count it as open work): Backroom's briefings.
  assert.equal(backroomBriefing({ id: "seat-briefing:W:seated", returnTo: "$system" }), true);
  assert.equal(backroomBriefing({ id: "seat-briefing:W:seated", returnTo: "$user" }), true, "a journal from before B1");
  assert.equal(backroomBriefing({ id: "moved:W:x", returnTo: "$user" }), true);
  assert.equal(backroomBriefing({ id: "reseat:abc", returnTo: "$user" }), false, "a reseat's checkpoint is not a briefing");
  assert.equal(backroomBriefing({ id: "msg:m1:0:W", returnTo: "$user" }), false, "the user's own request");
  assert.equal(backroomBriefing({ id: "board:abc", returnTo: "C" }), false);

  const note = (source: "post" | "t3-message", room: boolean, author = "$user") =>
    ({ kind: "note" as const, author, note: { source, room, t3: null, afterAnswer: false } });
  assert.equal(backroomNote(note("post", false)), true, "a reseat called off");
  assert.equal(backroomNote(note("post", true)), false, "the user's note to the room, from before N1");
  assert.equal(backroomNote(note("t3-message", false)), false, "typed in T3");
  assert.equal(backroomNote(note("post", false, "W")), false, "a member's note");
});

test("'into the turn' only when a run already running took the request", () => {
  const runs = [{ reservedSeq: 10, inputs: [8, 12] }, { reservedSeq: 20, inputs: [15] }];
  assert.equal(intoRunningTurn({ seq: 12 }, runs), true, "steered into the run reserved at 10");
  assert.equal(intoRunningTurn({ seq: 15 }, runs), false, "a run reserved after it: a turn of its own (an idle member, or a turn T3 ran after)");
  assert.equal(intoRunningTurn({ seq: 8 }, runs), false, "posted before the run: its ordinary input");
  assert.equal(intoRunningTurn({ seq: 30 }, runs), false, "not delivered yet");
});
