/**
 * The read API on the engine journal (stage 4/5 plan, item L4c): what the GET routes serve, for the web UI (L5) and the
 * rehearsal script. Pure types: the web may import them with `import type`.
 *
 * Every list and count here is read from the journal's fold when the request is made, and kept nowhere else: the same
 * journal gives the same view after a restart or a rebuild. The only state outside the journal is the user's own marks
 * (what was seen, which notices were dismissed), in rooms.sqlite's kv, keyed by journal sequence.
 *
 * Routes (src/server/engineView.ts):
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
 * time before its event was appended). A T3 run's ID is its host run's `providerRunId`, recorded when T3 took it.
 * T3 times not yet read (T3 unreachable) are null, never guessed.
 */
export interface EngineTime {
  at: string | null;
  after: string | null;
}

/** A request named by a post: its ID, the board number of the post that made it, and its owner. */
export interface EngineRef {
  requestId: string;
  /** Null when the journal has no request with this ID. */
  number: number | null;
  /** The request's owner (a seat, or the user), from the whole journal so a page without the request post still knows it; null when the journal has no request with this ID. */
  owner: EnginePrincipal | null;
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
  /** Wakes nobody: messages and turns from T3 (plan §3), keep-alive replies and Backroom's own notes; journals from before N1 also hold the user's and members' notes. */
  | "note"
  /** A follow-up (H5): a member's turn that answered nothing, or background work that ended; it wakes the orchestrator. */
  | "progress"
  /** What a member said: a run's final (journals from before H5 also hold explicit answers and background settles). */
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
  /**
   * It stands for one turn of its author: a run's final, or the note or continuation output of a T3 turn the room did
   * not start. One post per T3 run, never two: explicit answers and idle settles are not turns. Spend
   * (EngineRoomCosts.replies) is keyed by these posts, and news counts them.
   */
  turn: boolean;
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
    /**
     * The user message it came from (L4a): the requests of one message share `id` (show them as one message), `index`
     * is the assignment's place in it, and `attachmentIds` are the message's images (GET /api/attachments/:id). Null for a
     * member's request. Whether it went into a running turn is the run that delivered it (`runs[].inputs`).
     */
    message: { id: string; index: number; attachmentIds: string[] } | null;
  };
  output?: {
    /** answer: it names requests (see `claims` for what each came to); yield: an update that answers nothing; progress: a follow-up on a request; error: a failed run. */
    disposition: "answer" | "yield" | "progress" | "error";
    claims: EngineClaim[];
    /** final: a host run's last message; before H5 also answer (`rooms-board answer`), continuation and idle (background settles). */
    source: "final" | "answer" | "continuation" | "idle" | "other";
    runId: string | null;
    activityId: string | null;
    t3: EngineT3Ref | null;
    /** Said after the member had already answered the request it is under (plan §5: "after answer"). */
    afterAnswer: boolean;
  };
  note?: {
    /** post: the user or a member; t3-message: typed in T3 or sent by another agent; t3-turn: a turn on the member's thread the room did not start; deferred-cancel: a cancel that applies when the owner's turn ends; keep-alive: a seat's reply to a keep-alive (H6). */
    source: "post" | "t3-message" | "t3-turn" | "deferred-cancel" | "keep-alive";
    /** The user's note to the whole room, which a journal from before N1 may hold: every member's next briefing carries it. */
    room: boolean;
    t3: EngineT3Ref | null;
    /** Under a request its author had already answered (a self-started turn after the answer, plan §5). */
    afterAnswer: boolean;
  };
  /** `follow-up`: a member's turn that answered nothing, or background work that ended quietly (H5); `t3`: the T3 turn it came from. */
  progress?: { milestone: string | null; working: boolean; t3: EngineT3Ref | null };
  notice?: EngineNoticeState;
  cancel?: { applied: boolean };
  retry?: { runId: string };
  transfer?: { oldSeatId: string; newSeatId: string; owned: string[]; awaited: string[] };
  blocked?: EngineBlockedView;
}

export interface EngineNoticeState {
  /** keep-alive (H6): Backroom woke an idle seat while work it waits on is in flight; it needs nobody. */
  intent: "error" | "attention" | "keep-alive";
  /** The failed run, when the notice is about one. */
  runId: string | null;
  /**
   * The run the user can retry from here: failed, not retried, its seat not retired, one of its requests still open, and
   * it was not woken by a cancel alone.
   */
  retryRunId: string | null;
  retried: boolean;
  dismissed: boolean;
  /**
   * About Backroom's requests alone (a briefing, a reseat's checkpoint or call-off; journals from before B1 hold them in
   * the user's name) and reaching the Consigliere: his, not the user's, whatever its recipients say. It keeps its Retry
   * and is not in the user's chat.
   */
  backroom: boolean;
  /**
   * It waits on the user: addressed to the user (or to nobody), after the room's notice mark, not dismissed, not
   * retried, and its requests (if it names any) not all closed. In a room with a Consigliere a worker's failure goes to
   * him, not the user, so only his own needs you; a failure on Backroom's requests (`backroom`) is his too. A run woken
   * by a cancel alone that failed needs nobody: its notice, to nobody, stays on the board. One woken by a notice (he was
   * told of a member's failure) needs you: his thread failing stalls the room.
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
  /** The user message it came from (see EnginePost.request.message); null for a member's request. */
  messageId: string | null;
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
  /** Held by the member (`work:`). Since H5 the host registers no activities; only journals from before it hold them. */
  memberHeld: boolean;
  /** "working since …": when it was registered, by the EngineTime rule (exact for `bg:`, a lower bound for `work:`). */
  since: EngineTime;
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
  status: "active" | "retired";
  orchestrator: boolean;
  /** Ever the Consigliere's, from the whole journal: it held the role at some point, or a reseat moved its work to a seat that did. */
  consigliere: boolean;
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
 * A member's status, in the ParticipantStatus shape, from the journal and T3: T3's thread status,
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

/**
 * News: the room's finishes since you last looked (keyed by journal sequence): one per turn (EnginePost.turn), by a
 * member; in a room with a Consigliere, his only (the workers answer him).
 */
export interface EngineNews {
  /** The seq you have seen the room up to. */
  seenSeq: number;
  unseen: number;
  latest: (EngineTime & { seq: number; number: number; seatId: string; alias: string | null; kind: "reply" | "failed"; preview: string }) | null;
}

/** The user's notice marks for a room: every notice at or below `through` is handled, and so are `ids`. */
export interface EngineNoticeMarks {
  through: number;
  ids: string[];
}

export interface EngineRoomSnapshot {
  /** Always true: the journal's shape (a checkout from before the engine served another; scripts/compare-live tells them apart by it). */
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
  /** Every browser the room may use, in the list's order, each with its process (the default among them): the header's Browser button counts their tabs. Empty when the service cannot run browsers. */
  browsers: Array<{ browser: Browser; status: RoomBrowserStatus }>;
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
  lastReply: (EngineTime & { text: string }) | null;
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
 * The room's spend, re-keyed to the journal: a reply's spend is everything its thread used
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
