/**
 * The briefing for one engine run, rendered from the run's frozen Envelope (src/engine/README.md; plan item L2).
 *
 * The standing sections are assemble.ts's, unchanged: all of them on a seat's first delivery and again after its thread
 * lost them (a compaction, a rollback), otherwise the line that says how to print them and any that changed. Then the
 * work: the posts addressed to the seat (answers, progress it follows, notices), the posts it should know of on its own
 * requests (plan §5), and its assignment: its open requests with their corrections, and the requests, corrections,
 * cancels, retries and handovers this envelope brings, with the content a retry or handover carries over.
 *
 * Every input of the envelope is rendered, inherited ones included; none is ever dropped. Past the character budget
 * (60,000 by default, plan §7) the lowest-priority posts are condensed to a preview, and if that is still too long to a
 * line with their size, each with its `rooms-board read <n>` pointer. The envelope keeps them whole.
 */
import type { T3TurnItem } from "../adapter/types.ts";
import { inputTree } from "../engine/delivery.ts";
import { fold } from "../engine/fold.ts";
import type { Envelope, Input, Principal, RequestContext, RoomEvent as JournalEvent } from "../engine/types.ts";
import { briefingHeader, changedStanding, condensedPreview, heldStanding, standingFingerprint, type StandingInput, type StandingKey } from "./assemble.ts";

/** How the board names journal events and principals for one room. */
export interface EnvelopeDirectory {
  /** The board's number of a journal event: what `rooms-board read <n>` takes. Null when unknown (the seq is used). */
  number(eventId: string): number | null;
  /** The board's number of the post that made a request; null when unknown. */
  requestNumber(requestId: string): number | null;
  /** Who wrote a journal event, as the briefing names them: "@alias", "the user" or "Backroom". Null when unknown. */
  author(eventId: string): string | null;
  /** A principal by the same names (whom an answer goes to). */
  name(principal: Principal): string;
  /** Names of the images that came with an event. T3 delivers the images; the host sends those in `images`. */
  attachments(eventId: string): readonly string[];
  /** A handover's split, as the transfer event says: the requests it made the new seat's, and those whose answers now come to it. */
  handover?(eventId: string): { owned: readonly string[]; awaited: readonly string[] } | null;
  /** A progress post's milestone (`follow-up` since H5), so the briefing names it. */
  milestone?(eventId: string): string | null;
}

/** A principal as briefings name it, given a seat's alias. */
function principalName(principal: Principal, alias: (seatId: string) => string | null): string {
  if (principal === "$user") return "the user";
  if (principal === "$system") return "Backroom";
  return `@${alias(principal) ?? principal}`;
}

/** The directory read from the journal itself. Numbers default to the event's seq; pass `number` when the board numbers posts otherwise. */
export function journalDirectory(
  events: readonly JournalEvent[],
  names: { alias(seatId: string): string | null; number?(event: JournalEvent): number; attachments?(eventId: string): readonly string[] },
): EnvelopeDirectory {
  const byId = new Map(events.map((event) => [event.id, event]));
  const requests = new Map<string, JournalEvent>();
  for (const event of events) if (event.data.kind === "request") requests.set(event.data.request.id, event);
  const numberOf = (event: JournalEvent | undefined) => (event ? (names.number?.(event) ?? event.seq) : null);
  const name = (principal: Principal) => principalName(principal, names.alias);
  return {
    number: (eventId) => numberOf(byId.get(eventId)),
    requestNumber: (requestId) => numberOf(requests.get(requestId)),
    author: (eventId) => {
      const data = byId.get(eventId)?.data;
      return data && "author" in data ? name(data.author) : null;
    },
    name,
    attachments: (eventId) => names.attachments?.(eventId) ?? [],
    handover: (eventId) => {
      const data = byId.get(eventId)?.data;
      return data?.kind === "transfer" ? { owned: data.owned, awaited: data.awaited } : null;
    },
    milestone: (eventId) => {
      const data = byId.get(eventId)?.data;
      return data?.kind === "progress" ? data.milestone : data?.kind === "output" && data.disposition.kind === "progress" ? (data.disposition.milestone ?? null) : null;
    },
  };
}

/** A post not addressed to the reader that it should know of (plan §5): a note or progress on a request it asked or owns. */
export interface ContextPost {
  eventId: string;
  seq: number;
  kind: "note" | "progress";
  body: string;
  requestIds: string[];
}

/** The milestone that marks the user's room note (`/note`): shared context for every seat, about no request (L4a). */
export const ROOM_NOTE = "room";

/**
 * Notes and non-waking progress in (envelope.base, envelope.contextThrough], written by others, on requests the seat
 * asked or owns as of the watermark: a member's turn after its answer, "still working" posts nobody follows. They wake
 * nobody; this is how they reach the requester's next briefing. The user's room notes reach every seat this way.
 */
export function relatedContext(events: readonly JournalEvent[], envelope: Envelope, seatId: string): ContextPost[] {
  const upTo = events.filter((event) => event.seq <= envelope.contextThrough);
  const requests = fold(upTo).requests;
  const inputs = new Set(inputTree(envelope.inputs).map((input) => input.eventId));
  const related = (ids: readonly string[]) => ids.some((id) => {
    const request = requests.get(id);
    return request !== undefined && (request.returnTo === seatId || request.owner === seatId);
  });
  const out: ContextPost[] = [];
  for (const event of upTo) {
    if (event.seq <= envelope.base || inputs.has(event.id)) continue;
    const d = event.data;
    if ((d.kind === "note" || d.kind === "progress") && d.author !== seatId && !d.recipients.includes(seatId) && (related(d.requestIds) || d.kind === "note" && d.milestone === ROOM_NOTE)) {
      out.push({ eventId: event.id, seq: event.seq, kind: d.kind, body: d.body, requestIds: [...d.requestIds] });
    } else if (d.kind === "output" && d.author !== seatId && !d.recipients.includes(seatId) && d.disposition.kind === "progress" && related(d.disposition.requestIds)) {
      out.push({ eventId: event.id, seq: event.seq, kind: "progress", body: d.body, requestIds: [...d.disposition.requestIds] });
    }
  }
  return out;
}

/** What a seat's thread was last given of the standing sections. Keep one per seat; none means "send them all". */
export interface SeatStanding {
  /** The run whose briefing last carried all of them. */
  runId: string;
  /** When that briefing was made: a compaction after it may have taken them. */
  at: string;
  sections: Partial<Record<StandingKey, string | null>>;
}

export interface EnvelopeBriefingInput extends StandingInput {
  envelope: Envelope;
  directory: EnvelopeDirectory;
  /** Posts the seat should know of without being addressed (relatedContext); none when absent. */
  context?: readonly ContextPost[];
  /** The seat's standing record; null on its first delivery and after its thread lost the standing sections. */
  had: SeatStanding | null;
  /** The run this briefing goes out with, and when it is made (ISO): kept in the record when it carries them all. */
  runId: string;
  at: string;
  budgetChars: number;
  /** The request that seats a member: its body is the seat facts already, so the standing part leaves them out. */
  seatBriefing?: boolean;
  /** The seat is the room's orchestrator: with no request open, its reply is an update to the user (H5). */
  orchestrator?: boolean;
}

export type RenderForm = "full" | "condensed" | "pointer";

export interface EnvelopeBriefing {
  text: string;
  /** "all" on the seat's first delivery and after it lost them; otherwise the sections that changed (usually none). */
  standing: "all" | StandingKey[];
  /** The seat's standing record after this delivery: store it once the run is reserved. */
  held: SeatStanding;
  /** How each rendered post went out, by journal event ID: inputs, inherited inputs, open requests, corrections, context. */
  forms: Record<string, RenderForm>;
  /** Envelope inputs, inherited ones included, not rendered in full. */
  condensedEventIds: string[];
  condensed: boolean;
  /**
   * The images this message carries, by the post they came with, in the order the text names them: the host attaches
   * exactly these. Every input's images (inherited ones included), and an earlier open request's or correction's when it
   * goes in full to a fresh or compacted thread. Other posts' images are named "not attached here".
   */
  images: Array<{ eventId: string; names: string[] }>;
}

/** `/compact …` sent verbatim to a seat: its thread may lose the standing sections, so forget its record. */
export function isCompactCommand(text: string): boolean {
  return /^\/compact\b/i.test(text.trim());
}

/**
 * The seat's thread may no longer have the standing sections: a compaction completed after they were given (T3 records
 * each, Claude Code's automatic ones and /compact alike), or, when `carrierT3RunId` is passed, the thread was rolled back
 * past the run that carried them (null: that run never reached T3). The host then forgets the seat's record.
 */
export function standingLost(had: SeatStanding, thread: { turnItems: readonly T3TurnItem[]; runs?: readonly { id: string }[] }, carrierT3RunId?: string | null): boolean {
  if (thread.turnItems.some((item) => item.type === "compaction" && item.status === "completed" && (item.completedAt ?? item.updatedAt) > had.at)) return true;
  if (carrierT3RunId === undefined || !thread.runs) return false;
  return carrierT3RunId === null || !thread.runs.some((run) => run.id === carrierT3RunId);
}

/** The intents that ask the seat for something: they go in its assignment. The rest are statements. */
const ASSIGNMENT_INTENTS = new Set<Input["intent"]>(["request", "correction", "cancel", "retry", "transfer"]);

/** Budget priority, highest first: what this envelope asks of the seat, then what it tells it, then older content. */
const TIER = { assignment: 0, post: 1, inherited: 2, open: 3, context: 4 } as const;

/** How many open requests the assignment's first line names; each one is below in any case. */
const OPEN_LISTED = 20;

/** One post as it can go out: in full, condensed to a preview, or as a pointer line; each with the same tag. */
interface Unit {
  id: string;
  /** Its board number: newer posts have higher ones. */
  n: number;
  tier: number;
  input: boolean;
  preferred: RenderForm;
  text: Record<RenderForm, string>;
  chosen: RenderForm;
  images: readonly string[];
  /** Whether its images go with this message: always (an input), only when it goes in full, or never (already sent, or not to this seat). */
  attach: Attach;
}

type Attach = "always" | "if-full" | "never";

type Slot = string | Unit;

export function renderEnvelopeBriefing(input: EnvelopeBriefingInput): EnvelopeBriefing {
  const { envelope, directory } = input;
  const fingerprint = standingFingerprint(input);
  const standing: "all" | StandingKey[] = input.had ? changedStanding(input.had.sections, fingerprint) : "all";
  const held: SeatStanding = input.had
    ? { ...input.had, sections: heldStanding(input.had.sections, fingerprint) }
    : { runId: input.runId, at: input.at, sections: heldStanding({}, fingerprint) };
  const header = briefingHeader(input, standing, { seat: !input.seatBriefing });

  const number = (eventId: string, seq: number) => directory.number(eventId) ?? seq;
  const author = (eventId: string) => directory.author(eventId) ?? "someone";
  const ref = (requestId: string) => {
    const n = directory.requestNumber(requestId);
    return n === null ? `request ${requestId}` : `#${n}`;
  };
  const refs = (ids: readonly string[]) => ids.map(ref).join(", ");
  const on = (ids: readonly string[]) => (ids.length > 0 ? ` on ${refs(ids)}` : "");
  const open = new Map(envelope.openRequests.map((request) => [request.id, request]));

  const unit = (id: string, seq: number, tag: string, body: string, tier: number, isInput: boolean, preferred: RenderForm = "full", attach: Attach = "always"): Unit => {
    const n = number(id, seq);
    const images = directory.attachments(id);
    const named = (attached: boolean) => (images.length === 0 ? "" : `\nImages with #${n}${attached ? "" : ", not attached here"}: ${images.join(", ")}.`);
    const head = `[#${n} ${tag}]`;
    const read = `\`rooms-board read ${n}\``;
    const text = {
      full: `${head}\n${body}${named(attach !== "never")}`,
      condensed: `${head} ${condensedPreview(body)} (condensed; full text: ${read})${named(attach === "always")}`,
      pointer: `${head} (${body.length.toLocaleString("en-US")} characters; read it with ${read})${named(attach === "always")}`,
    };
    // A post no longer than its preview goes in full: condensing it would only add the pointer.
    const form = preferred === "condensed" && text.full.length <= text.condensed.length ? "full" : preferred;
    return { id, n, tier, input: isInput, preferred: form, chosen: form, text, images, attach };
  };

  const tagOf = (item: Input): string => {
    const by = author(item.eventId);
    switch (item.intent) {
      case "request":
        return `request from ${by}${item.requestIds.every((id) => open.has(id)) ? "" : ", no longer open"}`;
      case "correction":
        return `correction from ${by} to ${refs(item.requestIds)}`;
      case "cancel":
        return `cancel from ${by}: ${refs(item.requestIds)} is withdrawn`;
      case "retry":
        return `retry from ${by} of your failed run${on(item.requestIds)}`;
      case "transfer": {
        // The split is the transfer event's; without it the handover names its requests unsplit.
        const split = directory.handover?.(item.eventId);
        if (!split) return `handover from ${by}${on(item.requestIds)}`;
        const owned = split.owned.map((id) => ref(id) + (open.has(id) ? "" : " (no longer open)")).join(", ");
        const parts = [split.owned.length > 0 ? `${owned} now yours to answer` : null, split.awaited.length > 0 ? `answers to ${refs(split.awaited)} now come to you` : null].filter(Boolean);
        return `handover from ${by}${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`;
      }
      case "result":
        return `answer from ${by} to your request${item.requestIds.length > 1 ? "s" : ""} ${refs(item.requestIds)}`;
      case "progress":
        return `${directory.milestone?.(item.eventId) === "follow-up" ? "follow-up" : "progress"} from ${by}${on(item.requestIds)}`;
      case "error":
      case "attention":
        return `${item.intent} notice from ${by}${on(item.requestIds)}`;
    }
  };

  // Each journal event is rendered once; a later occurrence (inherited twice) points at the first.
  const forms: Record<string, RenderForm> = {};
  const rendered = new Set<string>();
  const units: Unit[] = [];
  const place = (slots: Slot[], item: Input, tier: number, carrier: number | null) => {
    const tag = tagOf(item) + (carrier === null ? "" : `, carried over by #${carrier}`);
    if (rendered.has(item.eventId)) {
      slots.push(`[#${number(item.eventId, item.seq)} ${tag}] (the same post as above)`);
    } else {
      rendered.add(item.eventId);
      const made = unit(item.eventId, item.seq, tag, item.body, tier, true);
      units.push(made);
      slots.push(made);
    }
    const n = number(item.eventId, item.seq);
    for (const inherited of item.inherited) place(slots, inherited, TIER.inherited, n);
  };

  const inputs = [...envelope.inputs].sort((a, b) => a.seq - b.seq);
  const postSlots: Slot[] = [];
  const assignmentSlots: Slot[] = [];
  for (const item of inputs.filter((i) => !ASSIGNMENT_INTENTS.has(i.intent))) place(postSlots, item, TIER.post, null);
  for (const item of inputs.filter((i) => ASSIGNMENT_INTENTS.has(i.intent))) place(assignmentSlots, item, TIER.assignment, null);

  // Open requests, and corrections to them, that no input above carries: the seat had them earlier (or took them over
  // in a handover). In full when the standing part goes in full (its thread may have lost them), else condensed; their
  // images go again only with the full text on such a thread.
  const earlier: RenderForm = input.had ? "condensed" : "full";
  const earlierImages: Attach = input.had ? "never" : "if-full";
  // A corrected request's version is its last correction's seq; the post that made it orders it.
  const placeOf = (request: RequestContext) => directory.requestNumber(request.id) ?? request.corrections[0]?.seq ?? request.version;
  const openList = [...envelope.openRequests].sort((a, b) => placeOf(a) - placeOf(b));
  const openSlots: Slot[] = [];
  for (const request of openList) {
    if (!rendered.has(request.id)) {
      rendered.add(request.id);
      const made = unit(request.id, placeOf(request), `request from ${directory.name(request.returnTo)}, still open`, request.body, TIER.open, false, earlier, earlierImages);
      units.push(made);
      openSlots.push(made);
    }
    for (const correction of request.corrections) {
      if (rendered.has(correction.eventId)) continue;
      rendered.add(correction.eventId);
      const made = unit(correction.eventId, correction.seq, `correction from ${author(correction.eventId)} to ${ref(request.id)}, earlier`, correction.body, TIER.open, false, earlier, earlierImages);
      units.push(made);
      openSlots.push(made);
    }
  }

  const contextSlots: Slot[] = [];
  for (const post of [...(input.context ?? [])].sort((a, b) => a.seq - b.seq)) {
    if (rendered.has(post.eventId)) continue;
    rendered.add(post.eventId);
    const made = unit(post.eventId, post.seq, `${post.kind} from ${author(post.eventId)}${on(post.requestIds)}`, post.body, TIER.context, false, "condensed", "never");
    units.push(made);
    contextSlots.push(made);
  }

  const slots: Slot[] = [...header, ""];
  const topPosts = inputs.filter((i) => !ASSIGNMENT_INTENTS.has(i.intent));
  if (topPosts.length > 0) {
    const first = topPosts[0] as Input;
    const last = topPosts[topPosts.length - 1] as Input;
    const range = first === last ? `#${number(first.eventId, first.seq)}` : `#${number(first.eventId, first.seq)}–#${number(last.eventId, last.seq)}`;
    slots.push(`== Posts for you since your last briefing (${range}) ==`, ...postSlots, "");
  }
  if (contextSlots.length > 0) {
    slots.push("== Also on the board about your requests (not addressed to you) ==", ...contextSlots, "");
  }
  slots.push("== Your assignment ==");
  const listed = openList.slice(0, OPEN_LISTED).map((request) => `${ref(request.id)} (asked by ${directory.name(request.returnTo)})`);
  const more = openList.length > OPEN_LISTED ? `, and ${openList.length - OPEN_LISTED} more below` : "";
  const none = input.orchestrator
    ? "No request is open for you: your reply reaches the user as an update; decide the next step."
    : "You have no open requests: nothing here asks you for an answer.";
  slots.push(openList.length > 0 ? `Your open requests: ${listed.join(", ")}${more}.` : none);
  slots.push(...openSlots, ...assignmentSlots);
  if (openList.length > 0 || assignmentSlots.length > 0) slots.push("This assignment is addressed to you. Perform only the part addressed to you.");

  fit(slots, units, input.budgetChars);
  const text = slots.map((slot) => (typeof slot === "string" ? slot : slot.text[slot.chosen])).join("\n");
  for (const made of units) forms[made.id] = made.chosen;
  const condensedEventIds = units.filter((made) => made.input && made.chosen !== "full").map((made) => made.id);
  const images = slots
    .filter((slot): slot is Unit => typeof slot !== "string" && slot.images.length > 0 && (slot.attach === "always" || (slot.attach === "if-full" && slot.chosen === "full")))
    .map((made) => ({ eventId: made.id, names: [...made.images] }));
  return { text, standing, held, forms, condensedEventIds, condensed: condensedEventIds.length > 0, images };
}

/**
 * Fit the posts into the budget. When everything fits as preferred, nothing changes. Otherwise every post starts in its
 * shortest form (the pointer line, or the post itself when that is shorter) and, in priority order (tier, then newest
 * first), goes back to its preferred form if that fits, else to its preview if that fits. Nothing is dropped: past the
 * budget every post still has its pointer line or its full text.
 */
function fit(slots: Slot[], units: Unit[], budget: number): void {
  const length = (slot: Slot) => (typeof slot === "string" ? slot.length : slot.text[slot.chosen].length);
  const total = () => slots.reduce((sum, slot) => sum + length(slot), 0) + Math.max(slots.length - 1, 0);
  if (total() <= budget) return;
  const forms: RenderForm[] = ["full", "condensed", "pointer"];
  for (const made of units) made.chosen = forms.reduce((a, b) => (made.text[b].length < made.text[a].length ? b : a));
  let left = budget - total();
  const order = [...units].sort((a, b) => a.tier - b.tier || b.n - a.n);
  for (const made of order) {
    const candidates: RenderForm[] = made.preferred === "full" ? ["full", "condensed"] : made.preferred === "condensed" ? ["condensed"] : [];
    for (const form of candidates) {
      if (form === made.chosen) break;
      const delta = made.text[form].length - made.text[made.chosen].length;
      if (delta <= left) {
        made.chosen = form;
        left -= delta;
        break;
      }
    }
  }
}
