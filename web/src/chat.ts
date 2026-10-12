import { backroomNote, backroomNotice } from "./replyTo.ts";
import type { EnginePost, RoomSnapshot } from "./types.ts";

/**
 * The Consigliere's seats: every binding of the member who is the Consigliere now, every seat the journal names
 * orchestrator, and every seat whose work moved to one of his by a reseat (a transfer post: old seat → new seat). A
 * reseat seats a fresh member, so his earlier replies are on seats of a member that has left; they stay his.
 */
export function consigliereSeats(snapshot: Pick<RoomSnapshot, "room" | "bindings" | "seats">, posts: readonly EnginePost[]): { seats: Set<string>; threads: Set<string> } {
  const seats = new Set(snapshot.bindings.filter((b) => b.participantId === snapshot.room.consigliereId).map((b) => b.id));
  for (const seat of snapshot.seats) if (seat.orchestrator) seats.add(seat.seatId);
  let grew = seats.size > 0;
  while (grew) {
    grew = false;
    for (const post of posts) {
      if (post.transfer && seats.has(post.transfer.newSeatId) && !seats.has(post.transfer.oldSeatId)) {
        seats.add(post.transfer.oldSeatId);
        grew = true;
      }
    }
  }
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
 * by kind (D1): one that wakes a member, or answers a request that returns to a member, is on the board (his requests,
 * corrections, cancels and retries to members, his answers to members, a late one that wakes nobody too); the rest is in
 * the chat (his answers to the user and to Backroom's requests, his updates, follow-ups and notes, his replies to
 * keep-alives), so a kind of post added later lands in the chat instead of vanishing from it. What the members say to
 * each other, Backroom's requests to them (and their failures, which are his), and what the user typed in T3 on another
 * member's thread (or sent there as a T3 command) are on the board.
 */
export function consigliereChat(posts: readonly EnginePost[], his: { seats: ReadonlySet<string>; threads: ReadonlySet<string> }): EnginePost[] {
  const hisRequests = new Set(posts.flatMap((post) => (post.request && his.seats.has(post.request.owner) ? [post.request.id] : [])));
  return posts.filter((post) => {
    if (post.author === "$user") {
      // His requests (not Backroom's in the user's name), notes to the room or typed on his thread, and the user's corrections,
      // cancels and retries of his work.
      if (post.kind === "request") return his.seats.has(post.request!.owner) && !backroomNotice(post);
      // Backroom's notes in the user's name (a reseat called off) only when they concern his requests.
      if (post.kind === "note" && backroomNote(post)) return post.about.some((ref) => hisRequests.has(ref.requestId));
      if (post.kind === "note") return !post.note?.t3 || his.threads.has(post.note.t3.threadId);
      return post.about.some((ref) => hisRequests.has(ref.requestId));
    }
    if (his.seats.has(post.author)) {
      // His own failed turn on your message: the same notice as the status bar's, with its Retry and Dismiss.
      if (post.kind === "notice") return post.notice?.needsYou === true || post.to.includes("$user");
      // Addressed to a member: it wakes one, or answers a request that returns to one (a late answer wakes nobody).
      const member = (principal: string) => principal !== "$user" && principal !== "$system" && !his.seats.has(principal);
      return !post.to.some(member) && !post.output?.claims.some((claim) => member(claim.returnTo));
    }
    // A member's failure that needs the user or is addressed to the user, unless it is about Backroom's requests alone
    // and reached the Consigliere (a briefing in the user's name from before B1): that one is his.
    if (post.kind === "notice") return post.notice?.needsYou === true || (post.to.includes("$user") && post.notice?.backroom !== true);
    return false;
  });
}
