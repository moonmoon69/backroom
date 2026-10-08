import type { EngineClaim, EnginePost } from "./types.ts";

/**
 * What a member's reply did to the requests it named, said truthfully, for the tag over it. The engine decides each
 * request's outcome (EngineClaim) and the read API gives each request's board number; nothing here works either out:
 * - answered: "answers #12 from you" (the request it closed, and who asked it);
 * - already answered: "#12 was answered already";
 * - late: "late for #12: it was cancelled" (or handed to a fresh seat): nobody is woken by it;
 * - superseded: "#12 stays open: input it had not seen came in": its next turn answers it;
 * - pending activity: "#12 stays open: a review or background work is still running".
 * A reply that named no request ("yield": its requests are held open, or it had none) answers nothing and wakes
 * nobody; an update under held work is "update on #12"; a failed run's notice is "failed on #12".
 */
export interface ReplyContext {
  /** The post that made a request, when the page holds it. */
  requestPost: (requestId: string) => EnginePost | undefined;
  /** A principal as the page names it: "you" for the user, "Backroom", or "@alias". */
  nameOf: (principal: string) => string;
}

/**
 * A request Backroom made in the user's name (L4b): the standing facts a member of a room with a Consigliere is given
 * when seated ("seat-briefing:…"), or the notice that the Consigliere changed ("moved:…"). Not something the user wrote.
 */
export function backroomNotice(post: Pick<EnginePost, "author" | "request">): "seat briefing" | "new Consigliere notice" | null {
  if (post.author !== "$user" || !post.request) return null;
  if (post.request.id.startsWith("seat-briefing:")) return "seat briefing";
  if (post.request.id.startsWith("moved:")) return "new Consigliere notice";
  return null;
}

/** One piece of the tag: words, or a board number to reveal. */
export type ReplyPiece = { text: string } | { ref: number };

const ref = (number: number | null): ReplyPiece => (number === null ? { text: "#?" } : { ref: number });

/** Who asked a request, as the tag says it: "from you", "from @Fable", "(seat briefing)"; nothing when the page does not hold it. */
function from(requestId: string, context: ReplyContext): ReplyPiece[] {
  const post = context.requestPost(requestId);
  if (!post) return [];
  const notice = backroomNotice(post);
  return [{ text: notice ? ` (${notice})` : ` from ${context.nameOf(post.author)}` }];
}

/** The words for one claim. */
export function claimPieces(claim: EngineClaim, context: ReplyContext): ReplyPiece[] {
  switch (claim.outcome) {
    case "answered":
      return [{ text: "answers " }, ref(claim.number), ...from(claim.requestId, context)];
    case "already_answered":
      return [ref(claim.number), { text: " was answered already" }];
    case "late": {
      const handed = context.requestPost(claim.requestId)?.request?.state !== "cancelled";
      return [{ text: "late for " }, ref(claim.number), { text: handed ? ": it was handed to a fresh seat" : ": it was cancelled" }];
    }
    case "superseded":
      return [ref(claim.number), { text: " stays open: input it had not seen came in" }];
    case "pending_activity":
      return [ref(claim.number), { text: " stays open: a review or background work is still running" }];
  }
}

/** The whole tag of a post with an output: its claims, or what it was when it named none. */
export function replyPieces(post: EnginePost, context: ReplyContext): ReplyPiece[] {
  const output = post.output;
  if (!output) return [];
  const join = (parts: ReplyPiece[][]): ReplyPiece[] => parts.flatMap((part, index) => [...(index > 0 ? [{ text: " · " }] : []), ...part]);
  switch (output.disposition) {
    case "answer":
      return join(output.claims.map((claim) => claimPieces(claim, context)));
    case "yield":
      return [{ text: "answers nothing" }];
    case "progress":
      return post.about.length > 0 ? [{ text: "update on " }, ...join(post.about.map((r) => [ref(r.number)]))] : [{ text: "update" }];
    case "error":
      return post.about.length > 0 ? [{ text: "failed on " }, ...join(post.about.map((r) => [ref(r.number)]))] : [{ text: "failed" }];
  }
}

/** The tag as plain text (tooltips and tests). */
export function replyText(pieces: readonly ReplyPiece[]): string {
  return pieces.map((piece) => ("text" in piece ? piece.text : `#${piece.ref}`)).join("");
}

/** How a member's output came about, when it was not the plain end of a turn the room asked for. */
export function sourceWords(post: EnginePost): string | null {
  switch (post.output?.source) {
    case "answer":
      return "rooms-board answer";
    case "continuation":
      return "continued on its own";
    case "idle":
      return "background work ended without a further turn";
    default:
      return null;
  }
}
