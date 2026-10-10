/**
 * The read API on the rooms' journal (stage 4/5 plan, item L4c): the room routes, the board, the overview and the room's
 * spend. The shapes are in src/domain/engineView.ts.
 *
 * Everything is read from the journal's fold on each request, through the host's projection, and kept nowhere else, so
 * a restart or a rebuild gives the same view. The journal has no clock: times come from T3 by one rule (EngineTime),
 * read once per T3 run or message and remembered (they never change once T3 has them). The user's marks (seen, notices
 * dismissed) are journal sequences in rooms.sqlite's kv, next to the threads' seen marks (src/app/seen.ts).
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { T3Adapter, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { backgroundOf, isRunActive, runForMessage } from "../adapter/types.ts";
import type { AppStack } from "../app/bootstrap.ts";
import { isPost } from "../app/boardEngine.ts";
import { messageAttachmentIds, messageOf } from "../app/engineMessages.ts";
import { roomStateView } from "../app/roomState.ts";
import { isAfter, seenMarks } from "../app/seen.ts";
import { liveFeed, runningRun } from "../app/threadView.ts";
import { browsersForRoom, effectiveBrowser } from "../browser/catalog.ts";
import { ROOM_NOTE } from "../briefing/envelope.ts";
import type { Repos } from "../db/repos.ts";
import type {
  EngineActivityView, EngineBlockedView, EngineBoardPage, EngineClaim, EngineMemberStatus, EngineNews, EngineNoticeMarks,
  EngineOverview, EngineOverviewMember, EngineOverviewRoom, EnginePost, EnginePostKind, EngineRef, EngineRequestView,
  EngineRoomCosts, EngineRoomCounts, EngineRoomListItem, EngineRoomSnapshot, EngineRunDetail, EngineRunView,
  EngineSeatView, EngineStreamData, EngineT3Ref, EngineTime,
} from "../domain/engineView.ts";
import { RoomError } from "../domain/errors.ts";
import type { Participant, Room } from "../domain/types.ts";
import { deliveredInputs, inputTree, unread } from "../engine/index.ts";
import type { Activity, Projection, RoomEvent, Run } from "../engine/index.ts";
import { KEEP_ALIVE_REPLY, backroomRequest, finalTargets } from "../runtime/index.ts";
import { withoutStatusLine } from "../runtime/status.ts";
import { frozenDispatch } from "../runtime/work.ts";
import type { ThreadCosts } from "../usage/threadCosts.ts";

// ---------------- times from T3 ----------------

/** A T3 time an event is anchored to: a message's createdAt, or one of a run's times. */
export type Anchor =
  | { threadId: string; message: string }
  | { threadId: string; run: string; field: "requestedAt" | "startedAt" | "completedAt" };

interface RunTimes { requestedAt: string | null; startedAt: string | null; completedAt: string | null }

/**
 * T3's times for the anchors the journal names, read from each thread in full when an anchor is not known yet, and
 * remembered: a message's or a finished run's times never change. An anchor a read left unknown (T3 down, a queued
 * run's start) is read for again at most once per `rereadMs`; a new one at once.
 */
export class T3Times {
  private readonly threads = new Map<string, { runs: Map<string, RunTimes>; messages: Map<string, string>; partial: boolean }>();
  /** When a read last left an anchor (with its field) unknown. */
  private readonly tried = new Map<string, number>();
  /**
   * Runs and messages a successful read of their thread did not have (rolled back, deleted): not asked for again. A
   * read T3 cut short (a window of the latest messages) lists every run but not every message, so it is evidence of a
   * run's absence only.
   */
  private readonly absent = new Set<string>();
  private readonly reading = new Map<string, Promise<boolean>>();
  private readonly adapter: Pick<T3Adapter, "getThreadDetail">;
  private readonly now: () => number;
  private readonly rereadMs: number;

  constructor(adapter: Pick<T3Adapter, "getThreadDetail">, options: { now?: () => number; rereadMs?: number } = {}) {
    this.adapter = adapter;
    this.now = options.now ?? Date.now;
    this.rereadMs = options.rereadMs ?? 2000;
  }

  time(a: Anchor): string | null {
    const thread = this.threads.get(a.threadId);
    if (!thread) return null;
    return "message" in a ? (thread.messages.get(a.message) ?? null) : (thread.runs.get(a.run)?.[a.field] ?? null);
  }

  /**
   * Read the threads of anchors not known yet (a known run whose time is still null, such as a queued run's start, is
   * read again). False when T3 did not answer for one of them.
   */
  async fill(anchors: Iterable<Anchor>): Promise<boolean> {
    const due = new Map<string, Anchor[]>();
    for (const a of anchors) {
      if (this.time(a) !== null || this.absent.has(keyOf(a))) continue;
      const last = this.tried.get(fieldKey(a));
      if (last !== undefined && this.now() - last < this.rereadMs) continue;
      due.set(a.threadId, [...(due.get(a.threadId) ?? []), a]);
    }
    const results = await Promise.all([...due].map(async ([threadId, wanted]) => {
      const read = await this.read(threadId);
      const thread = this.threads.get(threadId);
      for (const a of wanted) {
        if (this.time(a) !== null) continue;
        this.tried.set(fieldKey(a), this.now());
        if (read && thread && ("message" in a ? !thread.partial && !thread.messages.has(a.message) : !thread.runs.has(a.run))) this.absent.add(keyOf(a));
      }
      return read;
    }));
    return results.every(Boolean);
  }

  private read(threadId: string): Promise<boolean> {
    const pending = this.reading.get(threadId);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const detail = await this.adapter.getThreadDetail(threadId);
        const known = this.threads.get(threadId) ?? { runs: new Map<string, RunTimes>(), messages: new Map<string, string>(), partial: false };
        for (const run of detail?.runs ?? []) known.runs.set(run.id, { requestedAt: run.requestedAt, startedAt: run.startedAt, completedAt: run.completedAt });
        for (const message of detail?.messages ?? []) known.messages.set(message.id, message.createdAt);
        known.partial = detail?.partial === true;
        this.threads.set(threadId, known);
        return true;
      } catch {
        return false;
      } finally {
        this.reading.delete(threadId);
      }
    })();
    this.reading.set(threadId, promise);
    return promise;
  }
}

function keyOf(a: Anchor): string {
  return JSON.stringify("message" in a ? [a.threadId, "message", a.message] : [a.threadId, "run", a.run]);
}
function fieldKey(a: Anchor): string {
  return JSON.stringify("message" in a ? [a.threadId, "message", a.message] : [a.threadId, "run", a.run, a.field]);
}

/** The command an event came from: the journal's command key is [actor, command ID]. */
function commandOf(event: RoomEvent): { actor: string; id: string } {
  const [actor, id] = JSON.parse(event.commandKey) as [string, string];
  return { actor, id };
}

/** The T3 run each host run was matched to: its `providerRunId`, recorded when T3 took it. */
export function t3RunIds(p: Projection): Map<string, string> {
  const out = new Map<string, string>();
  for (const run of p.runs.values()) if (run.providerRunId) out.set(run.id, run.providerRunId);
  return out;
}

/** `t3run:<thread>:<run>` (a turn's note, a continuation's output) and its `:<activity>` siblings: the thread, the run, and whether it is the run's own key. */
function t3RunKey(id: string, threads: readonly string[]): { threadId: string; runId: string; own: boolean } | null {
  for (const threadId of threads) {
    const prefix = `t3run:${threadId}:`;
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    // A settle of several background activities keys the earlier outputs `<run key>:bg:<host run>` (host.ts).
    const cut = rest.lastIndexOf(":bg:");
    return cut > 0 ? { threadId, runId: rest.slice(0, cut), own: false } : { threadId, runId: rest, own: true };
  }
  return null;
}

/** The EngineTime rule (src/domain/engineView.ts): each event's T3 anchor, by the command it came from. */
export function anchorsOf(p: Projection): Map<number, Anchor> {
  const threads = [...new Set([...p.seats.values()].map((s) => s.threadId))].sort((a, b) => b.length - a.length);
  const t3 = t3RunIds(p);
  const hostRun = (runId: string, field: "requestedAt" | "startedAt" | "completedAt"): Anchor | null => {
    const run = p.runs.get(runId);
    const threadId = run ? p.seats.get(run.seatId)?.threadId : undefined;
    const id = t3.get(runId);
    return run && threadId && id ? { threadId, run: id, field } : null;
  };
  const out = new Map<number, Anchor>();
  for (const event of p.events) {
    const { actor, id } = commandOf(event);
    let anchor: Anchor | null = null;
    if (id.startsWith("t3msg:")) {
      const threadId = threads.find((t) => id.startsWith(`t3msg:${t}:`));
      if (threadId) anchor = { threadId, message: id.slice(`t3msg:${threadId}:`.length) };
    } else if (id.startsWith("t3run:")) {
      const key = t3RunKey(id, threads);
      if (key) anchor = { threadId: key.threadId, run: key.runId, field: "completedAt" };
    } else if (actor === "$system") {
      const host = /^(?:output|end|activity:bg):(.+)$/.exec(id);
      const phase = /^phase:(.+):(accepted|running)$/.exec(id);
      if (host) anchor = hostRun(host[1]!, "completedAt");
      else if (phase) anchor = hostRun(phase[1]!, phase[2] === "accepted" ? "requestedAt" : "startedAt");
    }
    if (anchor) out.set(event.seq, anchor);
  }
  return out;
}

/** Each event's time by the rule: exact from its anchor, and the latest exact time before it as a lower bound. */
export function timesOf(p: Projection, anchors: ReadonlyMap<number, Anchor>, time: (a: Anchor) => string | null): EngineTime[] {
  const out: EngineTime[] = [];
  let latest: string | null = null;
  for (const event of p.events) {
    const anchor = anchors.get(event.seq);
    const at = anchor ? time(anchor) : null;
    out.push({ at, after: latest });
    if (at !== null && (latest === null || isAfter(at, latest))) latest = at;
  }
  return out;
}

// ---------------- the journal as the board ----------------

/** The board's #n of an event. The journal seq, as L2's briefings cite it (journalDirectory's default). */
export const boardNumber = (seq: number): number => seq;

/** What an event says on the board, or null for bookkeeping: exactly the posts `rooms-board index` lists (L3's isPost). */
export function postKind(event: RoomEvent): EnginePostKind | null {
  if (!isPost(event)) return null;
  const d = event.data;
  switch (d.kind) {
    case "request": case "correction": case "cancel": case "note": case "progress": case "notice": case "retry": case "transfer":
      return d.kind;
    case "delivery.blocked":
      return "blocked";
    case "output":
      return "output";
    default:
      return null;
  }
}

/**
 * The posts that stand for a turn (EnginePost.turn), each with its thread and T3 run: a run's final (its T3 run, or
 * none when T3 never recorded it), and the follow-up or note a T3 turn the room did not start was imported as (its own
 * `t3run:` key). One post per T3 run: the first wins.
 */
export function turnPosts(p: Projection): Map<string, { threadId: string; t3RunId: string | null }> {
  const threads = [...new Set([...p.seats.values()].map((s) => s.threadId))].sort((a, b) => b.length - a.length);
  const t3 = t3RunIds(p);
  const out = new Map<string, { threadId: string; t3RunId: string | null }>();
  const seen = new Set<string>();
  for (const event of p.events) {
    if (!postKind(event)) continue;
    const d = event.data;
    let turn: { threadId: string; t3RunId: string | null } | null = null;
    if (d.kind === "output" && d.sourceKey.startsWith("final:") && d.association.kind === "run") {
      const run = p.runs.get(d.association.id);
      const threadId = run ? p.seats.get(run.seatId)?.threadId : undefined;
      if (threadId) turn = { threadId, t3RunId: t3.get(d.association.id) ?? null };
    } else if (d.kind === "output" || d.kind === "note" || d.kind === "progress") {
      const key = t3RunKey(commandOf(event).id, threads);
      if (key?.own) turn = { threadId: key.threadId, t3RunId: key.runId };
    }
    if (!turn) continue;
    if (turn.t3RunId !== null) {
      const key = JSON.stringify([turn.threadId, turn.t3RunId]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.set(event.id, turn);
  }
  return out;
}

export interface SeatMeta { participantId: string; alias: string }

export interface ViewInput {
  p: Projection;
  meta?: ReadonlyMap<string, SeatMeta>;
  /** Each event's time (timesOf), by seq; none gives null times. */
  times?: readonly EngineTime[];
  /** T3's times as read (T3Times.time): a run's own start and end. */
  t3?: (a: Anchor) => string | null;
  marks?: EngineNoticeMarks;
  /** The attachment IDs of a user message's images (L4a's record); none by default. */
  attachments?: (messageId: string) => string[];
}

/** The whole journal as the read API shows it. Pure: the same projection gives the same view. */
export interface JournalView {
  head: number;
  posts: EnginePost[];
  requests: EngineRequestView[];
  runs: EngineRunView[];
  seats: EngineSeatView[];
  blocked: EngineBlockedView[];
  activities: EngineActivityView[];
  needsYou: EnginePost[];
  counts: Omit<EngineRoomCounts, "needsYou">;
}

const LIVE: ReadonlySet<string> = new Set(["accepted", "running", "uncertain"]);
const isPending = (a: Activity) => a.status === "pending" || a.status === "uncertain";

export function journalView(input: ViewInput): JournalView {
  const { p } = input;
  const meta = input.meta ?? new Map<string, SeatMeta>();
  const marks = input.marks ?? { through: 0, ids: [] };
  const timeOf = (seq: number): EngineTime => input.times?.[seq - 1] ?? { at: null, after: null };
  const seqOf = new Map(p.events.map((e) => [e.id, e.seq]));
  const ref = (requestId: string): EngineRef => {
    const seq = seqOf.get(requestId);
    return { requestId, number: seq === undefined ? null : boardNumber(seq) };
  };
  const at = (eventId: string | null): { seq: number; number: number } | null => {
    const seq = eventId === null ? undefined : seqOf.get(eventId);
    return seq === undefined ? null : { seq, number: boardNumber(seq) };
  };
  const threads = [...new Set([...p.seats.values()].map((s) => s.threadId))].sort((a, b) => b.length - a.length);
  const t3 = t3RunIds(p);
  const retried = new Set(p.events.flatMap((e) => (e.data.kind === "retry" ? [e.data.runId] : [])));
  const activityStart = new Map(p.events.flatMap((e) => (e.data.kind === "activity.started" ? [[e.data.activity.id, e.seq] as const] : [])));
  const dismissed = new Set(marks.ids);
  const turns = turnPosts(p);
  const messageRef = (requestId: string) => {
    const ref3 = messageOf(requestId);
    return ref3 ? { id: ref3.messageId, index: ref3.index, attachmentIds: input.attachments?.(ref3.messageId) ?? [] } : null;
  };

  const eventById = (eventId: string | null | undefined): RoomEvent | undefined => {
    const seq = eventId ? seqOf.get(eventId) : undefined;
    return seq === undefined ? undefined : p.events[seq - 1];
  };
  /** Answered before `seq` by `author`: what "after answer" means for a later note or output (plan §5). */
  const answeredBefore = (requestId: string, seq: number, author: string): boolean => {
    const q = p.requests.get(requestId);
    const answer = eventById(q?.answerId);
    return q?.state === "answered" && answer !== undefined && answer.seq < seq && answer.data.kind === "output" && answer.data.author === author;
  };

  const posts: EnginePost[] = [];
  for (const event of p.events) {
    const kind = postKind(event);
    if (!kind) continue;
    const d = event.data;
    const base = {
      seq: event.seq,
      number: boardNumber(event.seq),
      id: event.id,
      kind,
      author: "author" in d ? d.author : "$system",
      to: "recipients" in d ? [...d.recipients] : [],
      body: "",
      about: [] as EngineRef[],
      turn: turns.has(event.id),
      ...timeOf(event.seq),
    };
    const post: EnginePost = base;
    switch (d.kind) {
      case "request": {
        const q = p.requests.get(d.request.id);
        post.body = d.request.body;
        post.about = [ref(d.request.id)];
        post.request = {
          id: d.request.id, parentId: d.request.parentId, rootId: d.request.rootId,
          owner: q?.owner ?? d.request.owner, returnTo: q?.returnTo ?? d.request.returnTo,
          state: q?.state ?? "open", answer: at(q?.answerId ?? null), corrections: q?.corrections.length ?? 0,
          message: messageRef(d.request.id),
        };
        break;
      }
      case "correction":
        post.body = d.body;
        post.about = [ref(d.requestId)];
        break;
      case "cancel":
        post.body = d.applied ? "Request cancelled" : "Cancel requested";
        post.about = [ref(d.requestId)];
        post.cancel = { applied: d.applied };
        break;
      case "note": {
        post.body = d.body;
        post.about = d.requestIds.map(ref);
        const { id } = commandOf(event);
        const turn = id.startsWith("t3run:") ? t3RunKey(id, threads) : null;
        const message = id.startsWith("t3msg:") ? threads.find((t) => id.startsWith(`t3msg:${t}:`)) : undefined;
        post.note = {
          source: turn ? "t3-turn" : message ? "t3-message" : id.startsWith("cancel-deferred:") ? "deferred-cancel" : id.startsWith(KEEP_ALIVE_REPLY) ? "keep-alive" : "post",
          room: d.milestone === ROOM_NOTE,
          t3: turn ? { threadId: turn.threadId, runId: turn.runId, messageId: null } : message ? { threadId: message, runId: null, messageId: id.slice(`t3msg:${message}:`.length) } : null,
          afterAnswer: d.author.startsWith("$") ? false : d.requestIds.some((r) => answeredBefore(r, event.seq, d.author)),
        };
        break;
      }
      case "progress": {
        post.body = d.body;
        post.about = d.requestIds.map(ref);
        const { id } = commandOf(event);
        const turn = id.startsWith("t3run:") ? t3RunKey(id, threads) : null;
        post.progress = { milestone: d.milestone, working: d.milestone === "working", t3: turn ? { threadId: turn.threadId, runId: turn.runId, messageId: null } : null };
        break;
      }
      case "output": {
        post.body = d.body;
        const named = "requestIds" in d.disposition ? d.disposition.requestIds : [];
        post.about = named.map(ref);
        const activity = d.association.kind === "activity" ? p.activities.get(d.association.id) : undefined;
        const runId = d.association.kind === "run" ? d.association.id : (activity?.runId ?? null);
        const source = d.sourceKey.startsWith("final:") ? "final" : d.sourceKey.startsWith("answer:") ? "answer" : d.sourceKey.startsWith("t3run:") ? "continuation" : d.sourceKey.startsWith("idle:") ? "idle" : "other";
        const turn = source === "continuation" ? t3RunKey(d.sourceKey, threads) : null;
        const hostT3 = source === "final" && runId ? t3.get(runId) : undefined;
        const seatThread = p.seats.get(d.author)?.threadId;
        const ref3: EngineT3Ref | null = turn ? { threadId: turn.threadId, runId: turn.runId, messageId: null } : hostT3 && seatThread ? { threadId: seatThread, runId: hostT3, messageId: null } : null;
        post.output = {
          disposition: d.disposition.kind === "silent" ? "yield" : d.disposition.kind,
          claims: d.claims.map((c): EngineClaim => ({ ...ref(c.requestId), outcome: c.outcome, returnTo: c.returnTo })),
          source, runId, activityId: activity?.id ?? null, t3: ref3,
          afterAnswer: d.disposition.kind !== "answer" && named.some((r) => answeredBefore(r, event.seq, d.author)),
        };
        break;
      }
      case "notice": {
        post.body = d.body;
        post.about = d.requestIds.map(ref);
        const run = p.runs.get(d.causeId) ?? null;
        // A run woken only by a cancel (a member whose thread keeps failing, given the cancel of the request it failed)
        // that failed: the engine's "Recovery failure", addressed to nobody. There is nothing to send again and nobody
        // waits on it: the failure that matters is the one on the request, so it stays on the board and off every list.
        // A run woken by a notice is not one of these: the Consigliere told of a member's failure whose own thread fails
        // stalls the room, so that failure is the user's, with its Retry.
        const delivered = run ? inputTree(deliveredInputs(p, run.id)) : [];
        const recovery = d.intent === "error" && delivered.length > 0 && delivered.every((i) => i.intent === "cancel");
        const wasRetried = run !== null && retried.has(run.id);
        // Every request the failed run was on is closed (answered or cancelled since): sending it again would do work
        // nobody asks for any more, so it is neither retried from here nor waiting on you.
        const settled = d.requestIds.length > 0 && d.requestIds.every((r) => p.requests.get(r)?.state !== "open");
        const retryable = run !== null && !recovery && !wasRetried && !settled && run.phase === "terminal" && run.failure !== null && p.seats.get(run.seatId)?.status !== "retired";
        // About Backroom's requests alone (a briefing, a reseat's checkpoint or call-off; journals from before B1 hold
        // them in the user's name) and reaching the Consigliere: it is his, whatever its recipients say. It keeps Retry.
        const backroom = d.requestIds.length > 0 && d.requestIds.every((id) => {
          const q = p.requests.get(id);
          return q !== undefined && backroomRequest(q);
        }) && d.recipients.some((r) => !r.startsWith("$"));
        const toUser = !backroom && (d.recipients.includes("$user") || d.recipients.length === 0);
        const isDismissed = event.seq <= marks.through || dismissed.has(event.id);
        post.notice = {
          intent: d.intent, runId: run?.id ?? null, retryRunId: retryable ? run.id : null, retried: wasRetried, dismissed: isDismissed, backroom,
          needsYou: toUser && !recovery && !isDismissed && !wasRetried && !settled,
        };
        break;
      }
      case "retry":
        post.body = d.body;
        post.about = d.requestIds.map(ref);
        post.retry = { runId: d.runId };
        break;
      case "transfer":
        post.body = d.body;
        post.about = [...d.owned, ...d.awaited].map(ref);
        post.transfer = { oldSeatId: d.oldSeatId, newSeatId: d.newSeatId, owned: [...d.owned], awaited: [...d.awaited] };
        break;
      case "delivery.blocked": {
        const seq = seqOf.get(d.eventId);
        post.body = `#${seq === undefined ? "?" : boardNumber(seq)} needs ${d.requiredBytes} bytes to reach ${meta.get(d.seatId)?.alias ?? d.seatId}: over the delivery budget.`;
        post.blocked = { seatId: d.seatId, eventId: d.eventId, number: seq === undefined ? null : boardNumber(seq), requiredBytes: d.requiredBytes };
        break;
      }
    }
    posts.push(post);
  }

  const pending = [...p.activities.values()].filter(isPending);
  const activityView = (a: Activity): EngineActivityView => {
    const seq = activityStart.get(a.id);
    return {
      id: a.id, kind: a.id.startsWith("bg:") ? "bg" : a.id.startsWith("work:") ? "work" : "other", seatId: a.seatId, runId: a.runId,
      requestIds: [...a.requestIds], status: a.status, memberHeld: a.id.startsWith("work:"), since: seq === undefined ? { at: null, after: null } : timeOf(seq),
    };
  };
  const activities = pending.map(activityView);

  /** What a run works on: §1's targets and what it marked working while live; what its final named once ended. */
  const workOf = (run: Run): string[] => {
    if (run.phase === "terminal") {
      const output = eventById(p.sourceKeys.get(`final:${run.id}`))?.data;
      return output?.kind === "output" && "requestIds" in output.disposition ? [...output.disposition.requestIds] : [];
    }
    const held = pending.filter((a) => a.runId === run.id && a.id.startsWith("work:")).flatMap((a) => a.requestIds.filter((r) => p.requests.get(r)?.state === "open"));
    return [...new Set([...finalTargets(p, run), ...held])];
  };

  const runs: EngineRunView[] = [];
  const reserved = new Map(p.events.flatMap((e) => (e.data.kind === "run.prepared" ? [[e.data.run.id, e.seq] as const] : [])));
  for (const run of p.runs.values()) {
    const seat = p.seats.get(run.seatId);
    const t3RunId = t3.get(run.id) ?? null;
    const t3Time = (field: "requestedAt" | "startedAt" | "completedAt") => (t3RunId && seat && input.t3 ? input.t3({ threadId: seat.threadId, run: t3RunId, field }) : null);
    runs.push({
      id: run.id, seatId: run.seatId, threadId: seat?.threadId ?? "", phase: run.phase, t3RunId, reservedSeq: reserved.get(run.id) ?? 0,
      through: run.through, inputs: deliveredInputs(p, run.id).map((i) => i.seq), requestIds: workOf(run), failure: run.failure,
      output: at(p.sourceKeys.get(`final:${run.id}`) ?? null), startedAt: t3Time("startedAt") ?? t3Time("requestedAt"), endedAt: t3Time("completedAt"),
    });
  }
  runs.sort((a, b) => a.reservedSeq - b.reservedSeq);

  const blockedEvents = new Map<string, { eventId: string; requiredBytes: number }>();
  for (const event of p.events) if (event.data.kind === "delivery.blocked") blockedEvents.set(event.data.seatId, { eventId: event.data.eventId, requiredBytes: event.data.requiredBytes });
  const blocked: EngineBlockedView[] = [];
  for (const [seatId, eventId] of p.blocked) {
    const seq = seqOf.get(eventId);
    blocked.push({ seatId, eventId, number: seq === undefined ? null : boardNumber(seq), requiredBytes: blockedEvents.get(seatId)?.eventId === eventId ? blockedEvents.get(seatId)!.requiredBytes : 0 });
  }

  const children = new Map<string, string[]>();
  for (const q of p.requests.values()) if (q.parentId && q.state === "open") children.set(q.parentId, [...(children.get(q.parentId) ?? []), q.id]);
  const requests: EngineRequestView[] = [];
  for (const q of p.requests.values()) {
    if (q.state !== "open") continue;
    const seq = seqOf.get(q.id) ?? 0;
    const owner = p.seats.get(q.owner);
    const live = owner?.activeRunId ? p.runs.get(owner.activeRunId) : undefined;
    requests.push({
      id: q.id, number: boardNumber(seq), seq, parentId: q.parentId, rootId: q.rootId, owner: q.owner, returnTo: q.returnTo, state: q.state,
      preview: q.body.slice(0, 400), corrections: q.corrections.length,
      openChildren: children.get(q.id) ?? [],
      activityIds: pending.filter((a) => a.requestIds.includes(q.id)).map((a) => a.id),
      runId: live && LIVE.has(live.phase) && workOf(live).includes(q.id) ? live.id : null,
      messageId: messageOf(q.id)?.messageId ?? null,
    });
  }
  requests.sort((a, b) => a.seq - b.seq);

  const seats: EngineSeatView[] = [];
  let unreadTotal = 0;
  for (const seat of p.seats.values()) {
    const count = seat.status === "retired" ? 0 : unread(p, seat.id).length;
    unreadTotal += count;
    seats.push({
      seatId: seat.id, participantId: meta.get(seat.id)?.participantId ?? null, alias: meta.get(seat.id)?.alias ?? null, threadId: seat.threadId,
      status: seat.status, orchestrator: p.orchestrator === seat.id, cursor: seat.cursor, activeRunId: seat.activeRunId, unread: count,
      blocked: blocked.find((b) => b.seatId === seat.id) ?? null, activities: activities.filter((a) => a.seatId === seat.id),
      owns: requests.filter((q) => q.owner === seat.id).length, awaits: requests.filter((q) => q.returnTo === seat.id).length,
    });
  }

  const live = seats.filter((s) => s.status !== "retired");
  return {
    head: p.events.length,
    posts,
    requests,
    runs,
    seats,
    blocked,
    activities,
    needsYou: posts.filter((post) => post.notice?.needsYou),
    counts: {
      posts: posts.length,
      requests: p.requests.size,
      openRequests: requests.length,
      runs: p.runs.size,
      unresolvedRuns: [...p.runs.values()].filter((r) => r.phase !== "terminal").length,
      notices: posts.filter((post) => post.kind === "notice").length,
      blocked: p.blocked.size,
      pendingActivities: pending.length,
      unread: unreadTotal,
      busy: live.filter((s) => s.activeRunId !== null).length,
      waiting: live.filter((s) => s.activeRunId === null && s.unread > 0).length,
      working: live.filter((s) => s.activities.length > 0).length,
    },
  };
}

/**
 * News: the room's finishes after the seen mark, one per turn (EnginePost.turn): an explicit answer and the same turn's
 * final are one finish, and an idle settle repeats one. In a room with a
 * Consigliere only his (the workers answer him).
 */
export function newsOf(view: JournalView, seenSeq: number, onlySeats: ReadonlySet<string> | null): EngineNews {
  const finishes = view.posts.filter((post) => post.turn && post.seq > seenSeq && !post.author.startsWith("$") && (!onlySeats || onlySeats.has(post.author)));
  const newest = finishes[finishes.length - 1];
  const seat = newest ? view.seats.find((s) => s.seatId === newest.author) : undefined;
  return {
    seenSeq,
    unseen: finishes.length,
    latest: newest
      ? { seq: newest.seq, number: newest.number, at: newest.at, after: newest.after, seatId: newest.author, alias: seat?.alias ?? null, kind: newest.output?.disposition === "error" ? "failed" : "reply", preview: newest.body.slice(0, 400) }
      : null,
  };
}

// ---------------- spend ----------------

/**
 * The replies that carry spend: the turn posts (turnPosts) that have a T3 run, one per T3 run, never per output.
 * Explicit answers and idle settles carry none. Only posts count: a reply with nothing to show leaves its spend to the
 * next one. `at` is the T3 run's completedAt.
 */
export function replyCarriers(p: Projection, time: (a: Anchor) => string | null): Map<string, Array<{ eventId: string; t3RunId: string; at: string | null }>> {
  const out = new Map<string, Array<{ eventId: string; t3RunId: string; at: string | null }>>();
  for (const [eventId, turn] of turnPosts(p)) {
    if (turn.t3RunId === null) continue;
    const at = time({ threadId: turn.threadId, run: turn.t3RunId, field: "completedAt" });
    out.set(turn.threadId, [...(out.get(turn.threadId) ?? []), { eventId, t3RunId: turn.t3RunId, at }]);
  }
  return out;
}

type Cost = ReturnType<ThreadCosts["cost"]>;

/**
 * The room's spend (GET /api/rooms/:roomId/costs), on the journal's replies: a reply's spend
 * is what its thread used after the thread's previous reply up to its own T3 run's end; the open turn is what the
 * thread used since its last reply. A thread with a reply whose T3 time is unknown is left whole, never split by guess.
 */
export function roomCosts(input: {
  costs: ThreadCosts;
  repos: Repos;
  roomId: string;
  p: Projection;
  time: (a: Anchor) => string | null;
  now?: number;
}): EngineRoomCosts<Cost, ReturnType<ThreadCosts["context"]>> {
  const { costs, repos, roomId, p } = input;
  const participants = repos.listParticipants(roomId);
  const bindings = repos.listBindings(participants.map((x) => x.id));
  const threadsOf = (participantId: string) => [...new Set(bindings.filter((b) => b.participantId === participantId).map((b) => b.threadId))];
  const byParticipant: Record<string, Cost> = {};
  for (const participant of participants) byParticipant[participant.id] = costs.cost(threadsOf(participant.id));

  const byReply: Record<string, Cost> = {};
  const openTurns: Record<string, Cost> = {};
  const unsplit: string[] = [];
  const now = input.now ?? Date.now();
  const last = new Map<string, number>();
  for (const [threadId, list] of replyCarriers(p, input.time)) {
    if (list.some((reply) => reply.at === null || !Number.isFinite(Date.parse(reply.at)))) {
      unsplit.push(threadId);
      continue;
    }
    const replies = list.map((reply) => ({ eventId: reply.eventId, at: Date.parse(reply.at!) })).sort((a, b) => a.at - b.at);
    replies.forEach((reply, index) => {
      const part = costs.costBetween([threadId], index === 0 ? 0 : replies[index - 1]!.at + 1, reply.at);
      if (part.available && part.total.calls > 0) byReply[reply.eventId] = part;
    });
    last.set(threadId, replies.reduce((max, reply) => Math.max(max, reply.at), 0));
  }
  for (const participant of participants) {
    if (participant.retiredAt) continue;
    const threadId = repos.currentBinding(participant.id)?.threadId;
    if (!threadId || unsplit.includes(threadId)) continue;
    const part = costs.costBetween([threadId], (last.get(threadId) ?? 0) + 1, now);
    if (part.available && part.total.calls > 0) openTurns[participant.id] = part;
  }
  const contexts: Record<string, ReturnType<ThreadCosts["context"]>> = {};
  for (const participant of participants) {
    if (participant.retiredAt) continue;
    const threadId = repos.currentBinding(participant.id)?.threadId;
    if (threadId) contexts[participant.id] = costs.context([threadId], participant.modelSelection);
  }
  return {
    readAt: new Date(now).toISOString(),
    pricesFetchedAt: costs.pricesFetchedAt(),
    room: costs.cost([...new Set(bindings.map((b) => b.threadId))]),
    withoutEstimate: participants.filter((x) => !byParticipant[x.id]?.available).map((x) => x.id),
    participants: byParticipant,
    replies: byReply,
    openTurns,
    contexts,
    unsplit,
  };
}

// ---------------- the user's marks (rooms.sqlite kv) ----------------

const SEEN = (roomId: string) => `engine.seen.room:${roomId}`;
const NOTICES = (roomId: string) => `engine.notices.room:${roomId}`;

/** The seq the user has seen the room up to; 0 before the first look (Z5's import sets it to the imported head). */
export function seenSeq(repos: Repos, roomId: string): number {
  const value = Number(repos.getKv(SEEN(roomId)) ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A mark only moves forward (another device may have seen more). */
export function markSeenSeq(repos: Repos, roomId: string, seq: number): number {
  const current = seenSeq(repos, roomId);
  if (seq <= current) return current;
  repos.setKv(SEEN(roomId), String(seq));
  return seq;
}

export function noticeMarks(repos: Repos, roomId: string): EngineNoticeMarks {
  try {
    const value = JSON.parse(repos.getKv(NOTICES(roomId)) ?? "null") as EngineNoticeMarks | null;
    if (value && Number.isSafeInteger(value.through) && Array.isArray(value.ids)) return { through: value.through, ids: value.ids.filter((id) => typeof id === "string") };
  } catch {
    // An unreadable mark is no mark.
  }
  return { through: 0, ids: [] };
}

/** Dismiss notices (by ID, or all up to a seq). The kept IDs are only those still needing you: the mark stays small. */
export function dismissNotices(repos: Repos, roomId: string, p: Projection, input: { ids?: string[]; through?: number }): EngineNoticeMarks {
  const marks = noticeMarks(repos, roomId);
  const through = Math.max(marks.through, input.through !== undefined && Number.isSafeInteger(input.through) ? Math.min(input.through, p.events.length) : 0);
  const known = new Set(p.events.filter((e) => e.data.kind === "notice").map((e) => e.id));
  const asked = new Set([...marks.ids, ...(input.ids ?? []).filter((id) => known.has(id))]);
  const view = journalView({ p, marks: { through, ids: [] } });
  const ids = view.needsYou.filter((post) => asked.has(post.id)).map((post) => post.id);
  const next = { through, ids };
  repos.setKv(NOTICES(roomId), JSON.stringify(next));
  return next;
}

// ---------------- member status, from the journal and T3 ----------------

export function memberStatus(input: {
  participant: Participant;
  repos: Repos;
  view: JournalView;
  shells: ReadonlyMap<string, T3ThreadShell> | null;
  native: ReadonlyArray<{ participantId: string; kind: string }>;
}): EngineMemberStatus {
  const { participant, view, shells } = input;
  const binding = input.repos.currentBinding(participant.id);
  const seat = binding ? view.seats.find((s) => s.seatId === binding.id) : undefined;
  const shell = binding && shells ? shells.get(binding.threadId) : undefined;
  const missing = shells !== null && binding !== null && (!shell || shell.deletedAt !== null);
  const run = seat?.activeRunId ? view.runs.find((r) => r.id === seat.activeRunId) : undefined;
  // T3 is running a run the room did not start. A run still being sent may be the room's; and a T3 run any host run of
  // the seat was matched to is the room's whether it is live or has just ended (T3's thread list, read at most once a
  // second, can still show it active right after the host imported its end).
  const hostT3 = new Set(view.runs.filter((r) => r.seatId === seat?.seatId && r.t3RunId !== null).map((r) => r.t3RunId!));
  const ours = (run !== undefined && (run.phase === "prepared" || run.phase === "sending")) || (shell?.activeRunId != null && hostT3.has(shell.activeRunId));
  const active = shell ? isRunActive(shell.status) || shell.activeRunId !== null : false;
  const native = input.native.filter((n) => n.participantId === participant.id);
  return {
    status: shell && !missing ? shell.status : "unknown",
    threadMissing: missing,
    externalActivity: active && !ours,
    pendingApprovals: native.some((n) => n.kind === "approval"),
    pendingUserInput: native.some((n) => n.kind === "user-input"),
    activeRunId: seat?.activeRunId ?? null,
    background: shell ? backgroundOf(shell) : null,
    seatId: seat?.seatId ?? null,
    working: (seat?.activities.length ?? 0) > 0,
    unread: seat?.unread ?? 0,
  };
}

// ---------------- the routes ----------------

export interface EngineViewOptions {
  /** How often an open stream looks at the journal's head for appends nobody announced (ms). */
  pollMs?: number;
  /** How long T3's thread list is reused between reads (ms). */
  shellsMs?: number;
}

/** The engine's reader as the routes need it: the host's projection and the rooms it serves. */
type Reader = Pick<AppStack["engine"], "view">;

/**
 * Whether the run T3 is running on a member's thread is the room's (the desk's `runningRun.startedByRoom`): its T3 run
 * is a host run's, or a host run still being sent matches it by its dispatch message (T3 took it and the host has not
 * recorded that yet). Otherwise it is a turn typed in T3, or one the member started itself.
 */
export function startedByHost(p: Projection, seatId: string, t3RunId: string, detail: T3ThreadDetail | null): boolean {
  const hostRuns = [...p.runs.values()].filter((r) => r.seatId === seatId);
  const t3 = t3RunIds(p);
  if (hostRuns.some((r) => t3.get(r.id) === t3RunId)) return true;
  return detail !== null && hostRuns.some((r) => (r.phase === "prepared" || r.phase === "sending") && runForMessage(detail, r.dispatchMessageId)?.id === t3RunId);
}

/**
 * Register the read API (call before the app's other routes). POST /api/seen takes a room's mark by journal sequence and
 * passes a thread's mark on to the next handler (src/server/http.ts).
 */
export function mountEngineView(app: Hono, stack: AppStack, costs: ThreadCosts, options: EngineViewOptions = {}): void {
  const engine: Reader = stack.engine;
  const { repos, adapter } = stack;
  const times = new T3Times(adapter);
  const pollMs = options.pollMs ?? 1000;
  const shellsMs = options.shellsMs ?? 1000;
  let shellsMemo: { at: number; value: Promise<Map<string, T3ThreadShell> | null> } | null = null;
  const shells = (): Promise<Map<string, T3ThreadShell> | null> => {
    if (shellsMemo && Date.now() - shellsMemo.at < shellsMs) return shellsMemo.value;
    const value = adapter.listThreads().then((list) => new Map(list.map((s) => [s.id, s])), () => null);
    shellsMemo = { at: Date.now(), value };
    return value;
  };

  const requireRoom = (roomId: string): Room => {
    const room = repos.getRoom(roomId);
    if (!room) throw new RoomError("not_found", "room not found", 404);
    return room;
  };
  const metaOf = (roomId: string): Map<string, SeatMeta> => {
    const participants = repos.listParticipants(roomId);
    const byId = new Map(participants.map((x) => [x.id, x]));
    return new Map(repos.listBindings(participants.map((x) => x.id)).map((b) => [b.id, { participantId: b.participantId, alias: byId.get(b.participantId)?.alias ?? b.participantId }]));
  };
  /** The room's view with T3 times filled in (T3 is read only for anchors it has not given yet). */
  const read = async (roomId: string): Promise<{ p: Projection; view: JournalView; reachable: boolean }> => {
    const p = engine.view(roomId);
    const anchors = anchorsOf(p);
    const reachable = await times.fill(anchors.values());
    const time = (a: Anchor) => times.time(a);
    const view = journalView({ p, meta: metaOf(roomId), times: timesOf(p, anchors, time), t3: time, marks: noticeMarks(repos, roomId), attachments: (messageId) => messageAttachmentIds(repos, roomId, messageId) });
    return { p, view, reachable };
  };
  const consigliereSeats = (room: Room): Set<string> | null => {
    if (!room.consigliereId) return null;
    return new Set(repos.listBindings([room.consigliereId]).map((b) => b.id));
  };
  const counted = (room: Room, view: JournalView): Pick<EngineRoomCounts, "needsYou" | "busy" | "waiting" | "working"> => {
    const seated = repos.listActiveParticipants(room.id).map((x) => x.id);
    return { needsYou: view.needsYou.length + repos.listOpenNativeRequests(seated).length, busy: view.counts.busy, waiting: view.counts.waiting, working: view.counts.working };
  };

  // ---- rooms ----
  app.get("/api/rooms", async (c) => {
    const out: EngineRoomListItem[] = [];
    for (const room of repos.listRooms()) {
      const { view } = await read(room.id);
      out.push({ ...room, participantCount: repos.listActiveParticipants(room.id).length, head: view.head, counts: counted(room, view), news: newsOf(view, seenSeq(repos, room.id), consigliereSeats(room)) });
    }
    return c.json(out);
  });

  app.post("/api/seen", async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; seq?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key : "";
    const room = /^room:([A-Za-z0-9_-]{1,80})$/.exec(key);
    // Threads outside rooms are not on a journal: their marks stay times, as before.
    if (!room || body?.seq === undefined) return next();
    const seq = typeof body.seq === "number" && Number.isSafeInteger(body.seq) && body.seq >= 0 ? body.seq : NaN;
    if (Number.isNaN(seq)) throw new RoomError("invalid_seen", "seq must be a journal sequence (a whole number)");
    requireRoom(room[1]!);
    return c.json({ key, seq: markSeenSeq(repos, room[1]!, Math.min(seq, engine.view(room[1]!).events.length)) });
  });

  app.get("/api/rooms/:roomId", async (c) => {
    const roomId = c.req.param("roomId");
    const room = requireRoom(roomId);
    const limit = Math.max(1, Math.min(Number(c.req.query("posts") ?? 500) || 500, 5000));
    const [{ view, reachable }, list] = await Promise.all([read(roomId), shells()]);
    const participants = repos.listParticipants(roomId);
    const native = repos.listOpenNativeRequests(participants.map((x) => x.id));
    const participantStatus: Record<string, EngineMemberStatus> = {};
    for (const participant of participants) participantStatus[participant.id] = memberStatus({ participant, repos, view, shells: list, native });
    const browser = stack.browsers ? effectiveBrowser(repos, room) : null;
    const snapshot: EngineRoomSnapshot = {
      engine: true,
      room,
      participants,
      bindings: repos.listBindings(participants.map((x) => x.id)),
      head: view.head,
      seats: view.seats,
      posts: view.posts.slice(-limit),
      earlier: view.posts.length > limit,
      requests: view.requests,
      runs: view.runs,
      needsYou: view.needsYou,
      blocked: view.blocked,
      nativeRequests: native,
      participantStatus,
      counts: { ...view.counts, needsYou: counted(room, view).needsYou },
      news: newsOf(view, seenSeq(repos, roomId), consigliereSeats(room)),
      notices: noticeMarks(repos, roomId),
      browser: browser && stack.browsers ? { browser, status: stack.browsers.status(browser.id) } : null,
      browsers: stack.browsers ? browsersForRoom(repos, room).map((each) => ({ browser: each, status: stack.browsers!.status(each.id) })) : [],
      state: roomStateView(repos, roomId),
      t3: { reachable: reachable && list !== null },
    };
    return c.json(snapshot);
  });

  // ---- the board ----
  app.get("/api/rooms/:roomId/board", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const { view } = await read(roomId);
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000));
    const older = view.posts.filter((post) => post.seq < before);
    const page: EngineBoardPage = { head: view.head, posts: older.slice(-limit), earlier: older.length > limit };
    return c.json(page);
  });

  app.get("/api/rooms/:roomId/board/:number", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const number = Number(c.req.param("number").replace(/^#/, ""));
    const { view } = await read(roomId);
    const post = view.posts.find((x) => x.number === number);
    if (!post) throw new RoomError("not_found", `no post #${c.req.param("number")} in this room`, 404);
    return c.json(post);
  });

  app.get("/api/rooms/:roomId/events", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const from = Number(c.req.query("from") ?? 1);
    const to = Number(c.req.query("to") ?? Number.MAX_SAFE_INTEGER);
    const { view } = await read(roomId);
    return c.json(view.posts.filter((post) => post.seq >= from && post.seq <= to));
  });

  app.get("/api/rooms/:roomId/runs/:runId", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const { p, view } = await read(roomId);
    const run = view.runs.find((r) => r.id === c.req.param("runId"));
    if (!run) throw new RoomError("not_found", "run not found", 404);
    const frozen = frozenDispatch(p, run.id);
    const detail: EngineRunDetail = { ...run, briefing: frozen?.text ?? null, images: frozen?.images ?? [] };
    return c.json(detail);
  });

  app.post("/api/rooms/:roomId/notices/dismiss", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown; through?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : undefined;
    const through = typeof body?.through === "number" ? body.through : undefined;
    if (!ids && through === undefined) throw new RoomError("invalid_dismiss", "name the notices (ids) or a journal sequence (through)");
    const marks = dismissNotices(repos, roomId, engine.view(roomId), { ...(ids ? { ids } : {}), ...(through !== undefined ? { through } : {}) });
    stack.hub.notify(roomId);
    return c.json(marks);
  });

  // ---- spend ----
  app.get("/api/rooms/:roomId/costs", async (c) => {
    const roomId = c.req.param("roomId");
    requireRoom(roomId);
    const p = engine.view(roomId);
    await times.fill(replyAnchors(p));
    return c.json(roomCosts({ costs, repos, roomId, p, time: (a) => times.time(a) }));
  });

  // ---- the overview ----
  app.get("/api/overview", async (c) => {
    const list = await shells();
    const rooms: EngineOverviewRoom[] = await Promise.all(
      repos.listRooms().map(async (room) => {
        const { view } = await read(room.id);
        const participants = repos.listActiveParticipants(room.id);
        const native = repos.listOpenNativeRequests(participants.map((x) => x.id));
        const members = await Promise.all(
          participants.map(async (participant): Promise<EngineOverviewMember> => {
            const status = memberStatus({ participant, repos, view, shells: list, native });
            const binding = repos.currentBinding(participant.id);
            const seatIds = new Set(repos.listBindings([participant.id]).map((b) => b.id));
            let live: string | null = null;
            if (binding && (status.activeRunId !== null || status.externalActivity || (status.status !== "unknown" && isRunActive(status.status)))) {
              live = await liveLine(adapter, binding.threadId);
            }
            const run = status.activeRunId ? view.runs.find((r) => r.id === status.activeRunId) : undefined;
            const doing = run?.requestIds.map((id) => view.posts.find((post) => post.request?.id === id)?.body).find((body) => body !== undefined) ?? null;
            const reply = [...view.posts].reverse().find((post) => seatIds.has(post.author) && post.body.trim().length > 0 && (post.output !== undefined || post.note?.source === "t3-turn"));
            return {
              id: participant.id, alias: participant.alias, modelSelection: participant.modelSelection, presetId: participant.presetId,
              consigliere: room.consigliereId === participant.id, status, live, doing,
              lastReply: reply ? { at: reply.at, after: reply.after, text: withoutStatusLine(reply.body).slice(0, 400) } : null,
            };
          }),
        );
        const state = roomStateView(repos, room.id);
        return { id: room.id, projectId: room.projectId, title: room.title, consigliereId: room.consigliereId, needs: counted(room, view).needsYou, members, state: state ? { line: state.line, by: state.by, at: state.at } : null, updatedAt: room.updatedAt };
      }),
    );
    const overview: EngineOverview = { rooms, threads: await looseThreads(stack, list), readAt: new Date().toISOString() };
    return c.json(overview);
  });

  // ---- live updates: every append, whoever wrote it ----
  app.get("/api/rooms/:roomId/stream", (c) => {
    const roomId = c.req.param("roomId");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const head = () => {
        try {
          return engine.view(roomId).events.length;
        } catch {
          return -1;
        }
      };
      let sent = head();
      const send = (event: "hello" | "room.changed", value: number) => {
        const data: EngineStreamData = { roomId, head: value, at: Date.now() };
        return stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      // Any change the app announces (the journal, the roster, approvals, the room state) goes out at once.
      const unsubscribe = stack.hub.subscribe(roomId, () => {
        if (closed) return;
        sent = head();
        void send("room.changed", sent);
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await send("hello", sent);
      // Appends nobody announced (a write straight to the store): the head moved since the last event sent.
      let quiet = 0;
      while (!closed) {
        await stream.sleep(pollMs);
        if (closed) break;
        const now = head();
        if (now !== sent && now >= 0) {
          sent = now;
          await send("room.changed", now);
        }
        quiet += pollMs;
        if (quiet >= 15000) {
          quiet = 0;
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
      }
    });
  });
}

/** The anchors the spend split needs: the T3 runs of the replies. */
function replyAnchors(p: Projection): Anchor[] {
  const out: Anchor[] = [];
  replyCarriers(p, (a) => {
    out.push(a);
    return null;
  });
  return out;
}

/** A member's live line mid-turn, read from T3: its latest message, the tools running, or a notice. */
async function liveLine(adapter: T3Adapter, threadId: string): Promise<string | null> {
  try {
    const detail = await adapter.getThreadDetail(threadId, { bounded: true });
    const running = detail ? runningRun(detail) : null;
    const last = detail && running ? liveFeed(detail, running.id).at(-1) : undefined;
    if (last?.kind === "message") return last.text;
    if (last?.kind === "tools") return last.running.length > 0 ? `running ${last.running.join(", ")}` : `ran ${last.count} tool${last.count === 1 ? "" : "s"}`;
    if (last?.kind === "notice") return last.text;
  } catch {
    // The live line is a decoration.
  }
  return null;
}

/** Threads outside rooms (they are on no journal): live line or last words, and news. */
async function looseThreads(stack: AppStack, list: Map<string, T3ThreadShell> | null): Promise<unknown[]> {
  const bound = new Set(stack.repos.listActiveBindings().map((b) => b.threadId));
  const loose = [...(list?.values() ?? [])].filter((t) => !bound.has(t.id) && !t.archivedAt && !t.settledAt && !t.deletedAt && t.lineage.relationshipToParent !== "subagent").slice(0, 40);
  const seen = seenMarks(stack.repos);
  return Promise.all(
    loose.map(async (thread) => {
      let line: string | null = null;
      try {
        const detail = await stack.adapter.getThreadDetail(thread.id, { bounded: true });
        const running = detail ? runningRun(detail) : null;
        if (detail && running) line = await liveLine(stack.adapter, thread.id);
        else if (detail) {
          const said = [...detail.messages].reverse().find((m) => m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
          line = said ? said.text.slice(0, 400) : null;
        }
      } catch {
        line = null;
      }
      const finishedAt = thread.latestRunCompletedAt;
      const news = finishedAt && (thread.status === "completed" || thread.status === "failed") && isAfter(finishedAt, seen.of(`thread:${thread.id}`))
        ? { at: finishedAt, state: thread.status === "failed" ? ("error" as const) : ("completed" as const) }
        : null;
      return { id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, status: thread.status, pendingRequest: thread.pendingRequest, backgroundLiveness: backgroundOf(thread), latestRunCompletedAt: thread.latestRunCompletedAt, updatedAt: thread.updatedAt, line, news };
    }),
  );
}
