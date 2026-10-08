/**
 * The read API on the engine journal (stage 4/5 plan, item L4c): what the GET routes serve with ROOMS_ENGINE=1, for the
 * web UI (L5) and the rehearsal script. Pure types: the web may import them with `import type`.
 *
 * Every list and count here is read from the journal's fold when the request is made, and kept nowhere else: the same
 * journal gives the same view after a restart or a rebuild. The only state outside the journal is the user's own marks
 * (what was seen, which notices were dismissed), in rooms.sqlite's kv, keyed by journal sequence.
 *
 * Routes (registered over the old ones when the flag is on; with it off nothing changes):
 *   GET  /api/rooms                              EngineRoomListItem[]
 *   GET  /api/rooms/:roomId                      EngineRoomSnapshot      (?posts=N: the newest N posts, 500 by default)
 *   GET  /api/rooms/:roomId/board                EngineBoardPage         (?before=<seq>&limit=N: older posts, newest last)
 *   GET  /api/rooms/:roomId/board/:number        EnginePost              (one post in full; 404 when no post has it)
 *   GET  /api/rooms/:roomId/events               EnginePost[]            (?from=<seq>&to=<seq>, inclusive)
 *   GET  /api/rooms/:roomId/runs/:runId          EngineRunDetail
 *   GET  /api/rooms/:roomId/costs                EngineRoomCosts
 *   GET  /api/rooms/:roomId/stream               SSE: "hello" and "room.changed", data EngineStreamData; "ping"
 *   GET  /api/overview                           EngineOverview
 *   POST /api/seen                               { key: "room:<id>", seq } -> { key, seq }   (thread keys as before)
 *   POST /api/rooms/:roomId/notices/dismiss      { ids?: string[], through?: number } -> EngineNoticeMarks
 *   GET  /api/rooms/:roomId/desk, …/participants/:participantId/live: as before, with `runningRun.startedByRoom` read
 *        from the journal (a run is the room's when T3 started it from a host dispatch message).
 */
import type { RoomStateView } from "../app/roomState.ts";
import type { RoomBrowserStatus } from "../browser/roomBrowsers.ts";
import type { Browser, ModelSelection, NativeRequest, Participant, ParticipantStatus, Room, SessionBinding } from "./types.ts";

/** Who wrote or is owed something on the journal: a seat ID (a member's binding ID), "$user" or "$system" (Backroom). */
export type EnginePrincipal = string;

/**
 * When something happened. The journal has no clock, so every time comes from T3, by one rule applied the same way on
 * every read:
 * - a message typed in T3 or sent by another agent, imported as a note (command `t3msg:…`): the T3 message's createdAt;
 * - a T3 turn imported as a note, or a continuation's output (command `t3run:…`): the T3 run's completedAt;
 * - a host run's final, its run end and the failure notice they carry, and the background work registered at its end:
 *   the host run's T3 run's completedAt;
 * - a host run's acceptance and start: the T3 run's requestedAt and startedAt (they are not posts; they bound the rest);
 * - anything else (the user's and members' posts, explicit answers, idle settles, cancels): no exact time.
 *
 * `at` is that exact time, or null. `after` is a lower bound every event has once anything before it has a time: the
 * latest exact time of any earlier event (an event is appended after everything before it, and every anchor is a
 * time before its event was appended). A T3 run's ID is read from its host run's acceptance (`t3run:<id>` in the
 * evidence until L6 makes it Run.providerRunId). T3 times not yet read (T3 unreachable) are null, never guessed.
 */
export interface EngineTime {
  at: string | null;
  after: string | null;
}

/** A request named by a post: its ID and the board number of the post that made it. */
export interface EngineRef {
  requestId: string;
  /** Null when the journal has no request with this ID. */
  number: number | null;
}

/** A T3 thing a post came from or names. */
export interface EngineT3Ref {
  threadId: string;
  runId: string | null;
  messageId: string | null;
}

export type EnginePostKind =
  /** Asks its owner for an answer: the user's message to a member, a member's `rooms-board post`. */
  | "request"
  /** The requester changes an open request. */
  | "correction"
  /** The requester withdraws a request. */
  | "cancel"
  /** Wakes nobody: the user's /note, a member's `rooms-board note`, messages and turns from T3 (plan §3). */
  | "note"
  /** Wakes nobody unless followed: `rooms-board working` and other progress posts. */
  | "progress"
  /** What a member said: a run's final, an explicit `rooms-board answer`, background work's result (plan §1, §2). */
  | "output"
  /** Something went wrong: a failed run (error), an undeliverable post or a late answer (attention). */
  | "notice"
  /** A failed run sent again. */
  | "retry"
  /** A reseat: the old seat's open work handed to the new seat. */
  | "transfer"
  /** A delivery the engine could not make (plan §7): Backroom's notice of it. */
  | "blocked";

/** How an answer attempt came out, per request (the engine decides it; see src/engine/README.md). */
export interface EngineClaim extends EngineRef {
  outcome: "answered" | "already_answered" | "late" | "superseded" | "pending_activity";
  returnTo: EnginePrincipal;
}

/**
 * A post on the board: one journal event that says something, the same events `rooms-board index` lists (L3's isPost):
 * requests, corrections, cancels, notes, progress, notices, retries, transfers, blocked deliveries, and outputs that are
 * not silent. Bookkeeping (run phases, reservations, syncs, activities) is not a post.
 */
export interface EnginePost extends EngineTime {
  /** Its place in the journal: order, news and seen are keyed by it. */
  seq: number;
  /** The board's #n, as briefings, `rooms-board read` and the page cite it. Today it equals `seq`. */
  number: number;
  /** The journal event's ID. Spend per reply (EngineRoomCosts.replies) is keyed by it. */
  id: string;
  kind: EnginePostKind;
  author: EnginePrincipal;
  /** Whom it wakes: the journal's recipients. Empty for notes, own posts and progress nobody follows. */
  to: EnginePrincipal[];
  body: string;
  /** The requests it is about; a request post names itself. */
  about: EngineRef[];
  request?: {
    id: string;
    parentId: string | null;
    rootId: string;
    /** The seat that owes the answer. */
    owner: EnginePrincipal;
    /** The return address: whom the answer goes to. */
    returnTo: EnginePrincipal;
    /** Its state now (the open/answered marker). */
    state: "open" | "answered" | "cancelled";
    /** The post that answered it. */
    answer: { seq: number; number: number } | null;
    corrections: number;
  };
  output?: {
    /** answer: it names requests (see `claims` for what each came to); yield: it answers nothing; progress: an update under held work; error: a failed run. */
    disposition: "answer" | "yield" | "progress" | "error";
    claims: EngineClaim[];
    /** final: a host run's last message; answer: `rooms-board answer`; continuation: a turn the member started itself; idle: background work ended without a further turn. */
    source: "final" | "answer" | "continuation" | "idle" | "other";
    runId: string | null;
    activityId: string | null;
    t3: EngineT3Ref | null;
    /** Said after the member had already answered the request it is under (plan §5: "after answer"). */
    afterAnswer: boolean;
  };
  note?: {
    /** post: the user or a member; t3-message: typed in T3 or sent by another agent; t3-turn: a turn on the member's thread the room did not start; deferred-cancel: a cancel that applies when the owner's turn ends. */
    source: "post" | "t3-message" | "t3-turn" | "deferred-cancel";
    t3: EngineT3Ref | null;
    /** Under a request its author had already answered (a self-started turn after the answer, plan §5). */
    afterAnswer: boolean;
  };
  progress?: { milestone: string | null; working: boolean };
  notice?: EngineNoticeState;
  cancel?: { applied: boolean };
  retry?: { runId: string };
  transfer?: { oldSeatId: string; newSeatId: string; owned: string[]; awaited: string[] };
  blocked?: EngineBlockedView;
}

export interface EngineNoticeState {
  intent: "error" | "attention";
  /** The failed run, when the notice is about one. */
  runId: string | null;
  /** The run the user can retry from here: failed, not retried, its seat not retired. */
  retryRunId: string | null;
  retried: boolean;
  dismissed: boolean;
  /**
   * It waits on the user: addressed to the user (or to nobody), after the room's notice mark, not dismissed, not
   * retried, and its requests (if it names any) not all closed. In a room with a Consigliere a worker's failure goes to
   * him, not the user, so only his own needs you.
   */
  needsYou: boolean;
}

/** An open request, with its owner and return address. */
export interface EngineRequestView {
  id: string;
  /** The board number of the post that made it. */
  number: number;
  seq: number;
  parentId: string | null;
  rootId: string;
  owner: EnginePrincipal;
  returnTo: EnginePrincipal;
  state: "open" | "answered" | "cancelled";
  /** The first 400 characters of its body (the post has it whole). */
  preview: string;
  corrections: number;
  /** Open requests made under it (reviews it asked for): while one is open, an answer to it comes out pending_activity. */
  openChildren: string[];
  /** Pending background work holding it open (plan §2). */
  activityIds: string[];
  /** Its owner's live run, when that run works on it. */
  runId: string | null;
}

export type EngineRunPhase = "prepared" | "sending" | "accepted" | "running" | "uncertain" | "rejected" | "terminal";

/** A host run: one wake of a seat. */
export interface EngineRunView {
  id: string;
  seatId: string;
  threadId: string;
  phase: EngineRunPhase;
  /** The T3 run, from the run's acceptance; null before T3 recorded it or when it never did. */
  t3RunId: string | null;
  /** Where its reservation is in the journal. */
  reservedSeq: number;
  /** The journal sequence its delivery reached. */
  through: number;
  /** The posts it delivered (their seqs). */
  inputs: number[];
  /** What it works on: §1's targets plus what it marked working (live runs); the requests its final named (ended runs). */
  requestIds: string[];
  failure: string | null;
  /** Its final, once imported. */
  output: { seq: number; number: number } | null;
  /** T3's times: when the run started (requestedAt until it starts) and when it ended. */
  startedAt: string | null;
  endedAt: string | null;
}

/** A run with the bytes T3 received: the frozen briefing (resends send the same) and the images it attached. */
export interface EngineRunDetail extends EngineRunView {
  briefing: string | null;
  images: Array<{ eventId: string; names: string[] }>;
}

/** Background work holding requests open (plan §2): `bg:` T3 listed work at turn end; `work:` the member said `working`. */
export interface EngineActivityView {
  id: string;
  kind: "bg" | "work" | "other";
  seatId: string;
  runId: string;
  requestIds: string[];
  status: "pending" | "uncertain" | "done" | "failed";
  /** Held by the member: it ends only with `rooms-board answer` (or a cancel), never on its own. */
  memberHeld: boolean;
  /** "working since …": the time of its registration (EngineTime rule: exact for `bg:`, a lower bound for `work:`). */
  since: string | null;
}

/** A delivery the engine could not make: one input with its open requests over the byte budget (plan §7). */
export interface EngineBlockedView {
  seatId: string;
  eventId: string;
  number: number | null;
  requiredBytes: number;
}

/** A seat: a member's binding on the journal. */
export interface EngineSeatView {
  /** The binding's ID. */
  seatId: string;
  participantId: string | null;
  alias: string | null;
  threadId: string;
  status: "active" | "stopping" | "retired";
  orchestrator: boolean;
  /** The journal sequence its deliveries reached. */
  cursor: number;
  activeRunId: string | null;
  /** Addressed input waiting for its next run (the waiting backlog). */
  unread: number;
  blocked: EngineBlockedView | null;
  /** Its pending background work ("working since …"). */
  activities: EngineActivityView[];
  /** Open requests it owns, and open requests it asked and waits on. */
  owns: number;
  awaits: number;
}

/**
 * A member's status, in the shape the old UI reads (ParticipantStatus), now from the journal and T3: T3's thread status,
 * background liveness and missing thread from T3's thread list; approvals and questions from native_requests (kept off
 * the journal, plan §6); `activeRunId` is the seat's host run; `externalActivity` is a T3 run the room did not start.
 */
export interface EngineMemberStatus extends ParticipantStatus {
  seatId: string | null;
  /** The seat has pending background work. */
  working: boolean;
  /** The seat's unread backlog. */
  unread: number;
}

/**
 * Counts, each equal to the same count taken from fold(journal) directly (the L4c gate). `needsYou`, `busy` and
 * `waiting` are what the sidebar and the work bar show.
 */
export interface EngineRoomCounts {
  posts: number;
  requests: number;
  openRequests: number;
  runs: number;
  /** Runs not yet ended (any phase but terminal). */
  unresolvedRuns: number;
  notices: number;
  blocked: number;
  pendingActivities: number;
  /** Unread addressed input, over all seats. */
  unread: number;
  /** Notices that need you plus open approvals and questions of seated members. */
  needsYou: number;
  /** Seats with an active run. */
  busy: number;
  /** Seats with unread input and no run. */
  waiting: number;
  /** Seats with pending background work. */
  working: number;
}

/** News: the room's finishes since you last looked (keyed by journal sequence). */
export interface EngineNews {
  /** The seq you have seen the room up to. */
  seenSeq: number;
  unseen: number;
  latest: { seq: number; number: number; at: string | null; seatId: string; alias: string | null; kind: "reply" | "failed"; preview: string } | null;
}

/** The user's notice marks for a room: every notice at or below `through` is handled, and so are `ids`. */
export interface EngineNoticeMarks {
  through: number;
  ids: string[];
}

export interface EngineRoomSnapshot {
  /** Tells this shape from the old RoomSnapshot. */
  engine: true;
  room: Room;
  participants: Participant[];
  bindings: SessionBinding[];
  /** The journal's head: the seq of its last event. */
  head: number;
  seats: EngineSeatView[];
  /** The newest posts, oldest first. */
  posts: EnginePost[];
  /** Older posts exist before the first in `posts` (GET …/board?before=<seq>). */
  earlier: boolean;
  /** Every open request. */
  requests: EngineRequestView[];
  runs: EngineRunView[];
  /** Notices that need you, oldest first, whether or not they are in `posts`. */
  needsYou: EnginePost[];
  blocked: EngineBlockedView[];
  nativeRequests: NativeRequest[];
  participantStatus: Record<string, EngineMemberStatus>;
  counts: EngineRoomCounts;
  news: EngineNews;
  notices: EngineNoticeMarks;
  browser: { browser: Browser; status: RoomBrowserStatus } | null;
  state: RoomStateView | null;
  /** Whether T3 answered for this read: when not, member status is "unknown" and unread T3 times are null. */
  t3: { reachable: boolean };
}

export interface EngineBoardPage {
  head: number;
  posts: EnginePost[];
  earlier: boolean;
}

export interface EngineRoomListItem extends Room {
  participantCount: number;
  head: number;
  counts: Pick<EngineRoomCounts, "needsYou" | "busy" | "waiting" | "working">;
  news: EngineNews;
}

export interface EngineOverviewMember {
  id: string;
  alias: string;
  modelSelection: ModelSelection;
  presetId: string | null;
  consigliere: boolean;
  status: EngineMemberStatus;
  /** The live line of a member mid-turn, read from T3. */
  live: string | null;
  /** The request its live run works on. */
  doing: string | null;
  lastReply: { at: string | null; text: string } | null;
}

export interface EngineOverviewRoom {
  id: string;
  projectId: string;
  title: string;
  consigliereId: string | null;
  needs: number;
  members: EngineOverviewMember[];
  state: { line: string; by: string; at: string } | null;
  updatedAt: string;
}

/** Threads outside rooms are listed as before (they are not on any journal). */
export interface EngineOverview {
  rooms: EngineOverviewRoom[];
  threads: unknown[];
  readAt: string;
}

/** SSE data of "hello" and "room.changed": the room and its journal head when the event was sent. */
export interface EngineStreamData {
  roomId: string;
  head: number;
  at: number;
}

/**
 * The room's spend, in the old route's shape, re-keyed to the journal: a reply's spend is everything its thread used
 * since the thread's previous reply, and replies are the outputs and turn notes that carry a T3 run (one per T3 run:
 * a host run's final, a T3 turn's note, a continuation's output), keyed by journal event ID. Explicit answers and idle
 * settles carry no T3 run and get none. A thread whose reply times T3 could not give is not split (`unsplit`).
 */
export interface EngineRoomCosts<Cost = unknown, Meter = unknown> {
  readAt: string;
  pricesFetchedAt: string | null;
  room: Cost;
  withoutEstimate: string[];
  participants: Record<string, Cost>;
  /** Per reply, by journal event ID. */
  replies: Record<string, Cost>;
  /** Per seated participant: what its thread used since its last reply. */
  openTurns: Record<string, Cost>;
  contexts: Record<string, Meter>;
  /** Threads left whole because a reply's T3 time is not known. */
  unsplit: string[];
}
