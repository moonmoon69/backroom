import type { EngineClaim, EnginePost, EngineRequestView, EngineRunView } from "./types.ts";

/**
 * What a member's reply did to the requests it named, said truthfully, for the tag over it. The engine decides each
 * request's outcome (EngineClaim) and the read API gives each request's board number; nothing here works either out:
 * - answered: "answers #12 from you" (the request it closed, and who asked it);
 * - already answered: "#12 was answered already";
 * - late: "late for #12: it was cancelled" (or handed to a fresh seat): nobody is woken by it;
 * - superseded: "#12 stays open: input it had not seen came in": its next turn answers it;
 * - pending activity: "#12 stays open: a review or background work is still running".
 * A reply that named no request ("yield": since H5 the Consigliere's replies after his first) is an "update": it
 * answers nothing and wakes nobody; a follow-up on a request is "update on #12"; a failed run's notice is "failed on #12".
 */
export interface ReplyContext {
  /** The post that made a request, when the page holds it. */
  requestPost: (requestId: string) => EnginePost | undefined;
  /** A principal as the page names it: "you" for the user, "Backroom", or "@alias". */
  nameOf: (principal: string) => string;
}

/** Backroom's own requests (L4b), by what their IDs say they are (the handover, `takeover:`, is the Consigliere's). */
const BACKROOM_REQUESTS: Array<[prefix: string, words: string]> = [
  ["seat-briefing:", "seat briefing"],
  ["moved:", "new Consigliere notice"],
  ["reseat:", "reseat checkpoint"],
  ["takeover:", "reseat handover"],
  ["reseat-off:", "reseat called off"],
];

/**
 * A request Backroom made, not something the user wrote: its own (`$system`): the standing facts a member of a room
 * with a Consigliere is given when seated, the notice that the Consigliere changed, a reseat's checkpoint and call-off
 * (journals from before B1 hold these in the user's name). Every request the user writes comes from a message
 * (`request.message`); one of the user's without it is Backroom's, whatever its ID.
 */
export function backroomNotice(post: Pick<EnginePost, "author" | "request">): string | null {
  if ((post.author !== "$user" && post.author !== "$system") || !post.request) return null;
  const known = BACKROOM_REQUESTS.find(([prefix]) => post.request!.id.startsWith(prefix));
  if (known) return known[1];
  return post.author === "$system" || post.request.message === null ? "Backroom's request" : null;
}

/**
 * Backroom's own request to a member, as the service counts it (src/runtime/bindings.ts): one it asked (`$system`), or
 * one from before B1 in the user's name (a seat briefing, the line naming a new Consigliere, a reseat's checkpoint or
 * call-off). It is nobody's work: removing the member cancels it.
 */
export function backroomRequest(q: Pick<EngineRequestView, "id" | "returnTo">): boolean {
  return q.returnTo === "$system" || (q.returnTo === "$user" && ["seat-briefing:", "moved:", "reseat:", "reseat-off:"].some((prefix) => q.id.startsWith(prefix)));
}

/** A note Backroom wrote in the user's name (a reseat called off): the user's own notes come from T3, or are notes to the room from before N1. */
export function backroomNote(post: Pick<EnginePost, "author" | "kind" | "note">): boolean {
  return post.author === "$user" && post.kind === "note" && post.note?.source === "post" && !post.note.room;
}

/**
 * Whether a run that was already running took this request into its turn (a steer T3 accepted mid-turn): a run
 * delivered it, and that run was reserved before it was posted. A steer to an idle member starts a turn of its own, and
 * one T3 ran after the running turn (Claude) is adopted by a run reserved after it: neither went into a running turn.
 */
export function intoRunningTurn(post: Pick<EnginePost, "seq">, runs: ReadonlyArray<Pick<EngineRunView, "inputs" | "reservedSeq">>): boolean {
  return runs.some((run) => run.reservedSeq < post.seq && run.inputs.includes(post.seq));
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
      // Why, when the page holds the request: cancelled, or handed to a fresh seat by a reseat. Otherwise no reason.
      const state = context.requestPost(claim.requestId)?.request?.state;
      return [{ text: "late for " }, ref(claim.number), ...(state === undefined ? [] : [{ text: state === "cancelled" ? ": it was cancelled" : ": it was handed to a fresh seat" }])];
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
      return [{ text: "update" }];
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
