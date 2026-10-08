/**
 * The tag over a member's reply (web/src/replyTo.ts) on the engine's journal: what the reply did to each request it
 * named, in the engine's own outcomes, with the board numbers the read API gives (never worked out from sequences).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimPieces, replyPieces, replyText, sourceWords, type ReplyContext } from "../web/src/replyTo.ts";
import type { EngineClaim, EnginePost } from "../web/src/types.ts";
import { journalView } from "../src/server/engineView.ts";
import { Room } from "./runtime/helpers.ts";

const request = (id: string, number: number, author: string, state: "open" | "answered" | "cancelled" = "open"): EnginePost => ({
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
  request: { id, parentId: null, rootId: id, owner: "W", returnTo: author, state, answer: null, corrections: 0, message: null },
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
  const briefing = { ...request("seat-briefing:W:seated", 2, "$user"), id: "b" };
  assert.equal(replyText(claimPieces(claim("seat-briefing:W:seated", 2, "answered"), context([...posts, briefing]))), "answers #2 (seat briefing)");
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
  assert.equal(replyText(replyPieces(output("yield", "final"), context(posts))), "answers nothing");
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
  const asked = room.user("W", "Fix the date test.");
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
