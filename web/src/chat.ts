import { backroomNote, backroomNotice } from "./replyTo.ts";
import type { EnginePost, EngineRef, RoomSnapshot } from "./types.ts";

/**
 * The Consigliere's seats: every binding of the member who is the Consigliere now, and every seat the journal says was
 * ever his (`consigliere`: it held the role, or a reseat moved its work to one that did). A reseat seats a fresh member,
 * so his earlier replies are on seats of a member that has left; they stay his. The seats carry it from the whole
 * journal, so it holds on every page of posts: the posts are not read (the parameter stays for the callers).
 */
export function consigliereSeats(snapshot: Pick<RoomSnapshot, "room" | "bindings" | "seats">, _posts?: readonly EnginePost[]): { seats: Set<string>; threads: Set<string> } {
  const seats = new Set(snapshot.bindings.filter((b) => b.participantId === snapshot.room.consigliereId).map((b) => b.id));
  for (const seat of snapshot.seats) if (seat.orchestrator || seat.consigliere) seats.add(seat.seatId);
  const threads = new Set([
    ...snapshot.seats.filter((s) => seats.has(s.seatId)).map((s) => s.threadId),
    ...snapshot.bindings.filter((b) => seats.has(b.id)).map((b) => b.threadId),
  ]);
  return { seats, threads };
}

/**
 * The user's conversation with the room's Consigliere, as a view of the board: what the user posted to him (every
 * message in his room is his), everything he says that is not addressed to a member, and the notices that need the
 * user, his own failed turns among them (with Retry and Dismiss, as in the status bar). His posts go by addressing, not
 * by kind (D1): one that wakes a member, answers a request that returns to a member, or is about a member's request is on
 * the board (his requests, corrections, cancels and retries to members, his answers to members, a late one or a cancel
 * of a closed request that wakes nobody too); the rest is in the chat (his answers to the user and to Backroom's
 * requests, his updates, follow-ups and notes, his replies to keep-alives, his retries of his own turns), so a kind of
 * post added later lands in the chat instead of vanishing from it. What the members say to each other, Backroom's
 * requests to them (and their failures, which are his), and what the user typed in T3 on another member's thread (or
 * sent there as a T3 command) are on the board. Whose request a post is about is the owner on its ref, from the whole
 * journal, so a post sorts the same on the first page as after the request's own post has loaded.
 */
export function consigliereChat(posts: readonly EnginePost[], his: { seats: ReadonlySet<string>; threads: ReadonlySet<string> }): EnginePost[] {
  const hisRequest = (ref: EngineRef) => ref.owner !== null && his.seats.has(ref.owner);
  // A member: a seat that is not one of his.
  const member = (principal: string | null) => principal !== null && principal !== "$user" && principal !== "$system" && !his.seats.has(principal);
  return posts.filter((post) => {
    if (post.author === "$user") {
      // His requests (not Backroom's in the user's name), notes to the room or typed on his thread, and the user's corrections,
      // cancels and retries of his work.
      if (post.kind === "request") return his.seats.has(post.request!.owner) && !backroomNotice(post);
      // Backroom's notes in the user's name (a reseat called off) only when they concern his requests.
      if (post.kind === "note" && backroomNote(post)) return post.about.some(hisRequest);
      if (post.kind === "note") return !post.note?.t3 || his.threads.has(post.note.t3.threadId);
      return post.about.some(hisRequest);
    }
    if (his.seats.has(post.author)) {
      // His own failed turn on your message: the same notice as the status bar's, with its Retry and Dismiss.
      if (post.kind === "notice") return post.notice?.needsYou === true || post.to.includes("$user");
      // Addressed to a member: it wakes one, answers a request that returns to one (a late answer wakes nobody), or is about
      // a member's request (a cancel of a closed one wakes nobody either).
      return !post.to.some(member) && !post.output?.claims.some((claim) => member(claim.returnTo)) && !post.about.some((ref) => member(ref.owner));
    }
    // A member's failure that needs the user or is addressed to the user, unless it is about Backroom's requests alone
    // and reached the Consigliere (a briefing in the user's name from before B1): that one is his.
    if (post.kind === "notice") return post.notice?.needsYou === true || (post.to.includes("$user") && post.notice?.backroom !== true);
    return false;
  });
}
