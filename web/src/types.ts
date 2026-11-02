/**
 * Client-side copies of the server data shapes (src/domain/types.ts, src/domain/commands.ts,
 * src/parser/explicit.ts, src/adapter/types.ts). Kept in sync by hand; do not import from ../src.
 */

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: unknown }>;
}

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

export interface Room {
  id: string;
  projectId: string;
  environmentId: string | null;
  title: string;
  nextSequence: number;
  /** The room's agents get a browser (started on demand) described in their briefings. */
  browserEnabled: boolean;
  /** The room's default browser; null means "general". */
  defaultBrowserId: string | null;
  /** Browsers the room's agents may use; null means all of them. */
  allowedBrowserIds: string[] | null;
  /** The room's Consigliere, when it has one: the member the user talks to, who hands the work to the others. */
  consigliereId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/rooms: a room with what is going on in it, read from its journal (EngineRoomListItem). */
export interface RoomListItem extends Room {
  participantCount: number;
  /** The journal's head: the seq of its last event. */
  head: number;
  counts: Pick<EngineRoomCounts, "needsYou" | "busy" | "waiting" | "working">;
  /** What finished since the room was last seen on any device, keyed by journal sequence. */
  news: RoomNews;
}

/** News: the room's finishes since you last looked (EngineNews). In a room with a Consigliere, only his. */
export interface RoomNews {
  /** The seq you have seen the room up to. */
  seenSeq: number;
  unseen: number;
  latest: (EngineTime & { seq: number; number: number; seatId: string; alias: string | null; kind: "reply" | "failed"; preview: string }) | null;
}

export interface Participant {
  id: string;
  roomId: string;
  alias: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  bindingGeneration: number;
  /** Set when the participant was removed from the room; kept for attribution of past events. */
  retiredAt: string | null;
  /** The crew member it was seated as: it wears that preset's look in the pixel skin. Absent from an older service. */
  presetId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Participants still seated in the room (retired ones stay in the snapshot for attribution only). */
export const isActiveParticipant = (participant: Pick<Participant, "retiredAt">): boolean => !participant.retiredAt;

export interface SessionBinding {
  id: string;
  participantId: string;
  generation: number;
  threadId: string;
  deliveredCursor: number;
  bootstrapDeliveredAt: string | null;
  createdAt: string;
  retiredAt: string | null;
}

// ---- The room's journal, as the read API serves it (src/domain/engineView.ts; tests/web-engine-types.test.ts keeps
// these copies equal to it) ----

/** Who wrote or is owed something on the journal: a seat ID (a member's binding ID), "$user" or "$system" (Backroom). */
export type EnginePrincipal = string;

/**
 * When something happened. The journal has no clock: `at` is exact only for what T3 timed (its messages and turns, a
 * run's final), else null; `after` is a lower bound (the latest exact time of anything earlier), null when nothing
 * earlier has one. Neither is ever guessed.
 */
export interface EngineTime {
  at: string | null;
  after: string | null;
}

/** A request named by a post: its ID, the board number of the post that made it (null when unknown), and its owner. */
export interface EngineRef {
  requestId: string;
  number: number | null;
  /** The request's owner (a seat, or the user), from the whole journal so a page without the request post still knows it; null when the journal has no request with this ID. */
  owner: EnginePrincipal | null;
}

export interface EngineT3Ref {
  threadId: string;
  runId: string | null;
  messageId: string | null;
}

export type EnginePostKind = "request" | "correction" | "cancel" | "note" | "progress" | "output" | "notice" | "retry" | "transfer" | "blocked";

/** How an answer attempt came out for one request: the engine decides it. */
export interface EngineClaim extends EngineRef {
  outcome: "answered" | "already_answered" | "late" | "superseded" | "pending_activity";
  returnTo: EnginePrincipal;
}

/** A post on the board: one journal event that says something (`rooms-board index` lists the same ones). */
export interface EnginePost extends EngineTime {
  seq: number;
  /** The board's #n. Read it; never compute it from `seq`. */
  number: number;
  /** The journal event's ID: spend per reply (RoomCosts.replies) is keyed by it. */
  id: string;
  kind: EnginePostKind;
  author: EnginePrincipal;
  /** Whom it wakes. */
  to: EnginePrincipal[];
  body: string;
  /** The requests it is about; a request post names itself. */
  about: EngineRef[];
  /** The one post that stands for a turn (a run's final, a T3 turn's note or continuation): spend and news count these. */
  turn: boolean;
  request?: {
    id: string;
    parentId: string | null;
    rootId: string;
    owner: EnginePrincipal;
    returnTo: EnginePrincipal;
    /** The open/answered marker. */
    state: "open" | "answered" | "cancelled";
    answer: { seq: number; number: number } | null;
    corrections: number;
    /** The user message it came from: its requests share `id` (one message), with its images. Null for a member's request. */
    message: { id: string; index: number; attachmentIds: string[] } | null;
  };
  output?: {
    /** answer: names requests (claims say what each came to); yield: an update that answers nothing; progress: a follow-up on a request; error: a failed run. */
    disposition: "answer" | "yield" | "progress" | "error";
    claims: EngineClaim[];
    /** final: a run's last message; before H5 also answer (`rooms-board answer`), continuation and idle (background settles). */
    source: "final" | "answer" | "continuation" | "idle" | "other";
    runId: string | null;
    activityId: string | null;
    t3: EngineT3Ref | null;
    afterAnswer: boolean;
  };
  note?: {
    /** post: the user or a member; t3-message: typed in T3 or sent by another agent; t3-turn: a turn the room did not start; deferred-cancel: a cancel that applies when the owner's turn ends; keep-alive: a seat's reply to a keep-alive. */
    source: "post" | "t3-message" | "t3-turn" | "deferred-cancel" | "keep-alive";
    /** The user's note to the whole room, which a journal from before N1 may hold. */
    room: boolean;
    t3: EngineT3Ref | null;
    /** Under a request its author had already answered (a self-started turn after the answer). */
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
  /** keep-alive: Backroom woke an idle seat while work it waits on is in flight; it needs nobody. */
  intent: "error" | "attention" | "keep-alive";
  runId: string | null;
  /** The run the user can retry from here (failed, not retried, its seat not retired, one of its requests still open, not woken by a cancel alone). */
  retryRunId: string | null;
  retried: boolean;
  dismissed: boolean;
  /** About Backroom's requests alone (a briefing, a reseat's) and reaching the Consigliere: his, not the user's; not in the chat. */
  backroom: boolean;
  /** It waits on the user: addressed to the user, not dismissed or retried, its requests not all closed; never a failed run woken by a cancel alone. */
  needsYou: boolean;
}

/** An open request, with its owner and return address. */
export interface EngineRequestView {
  id: string;
  number: number;
  seq: number;
  parentId: string | null;
  rootId: string;
  owner: EnginePrincipal;
  returnTo: EnginePrincipal;
  state: "open" | "answered" | "cancelled";
  preview: string;
  corrections: number;
  /** Open requests made under it (reviews it asked for). */
  openChildren: string[];
  /** Pending background work holding it open. */
  activityIds: string[];
  /** Its owner's live run, when that run works on it. */
  runId: string | null;
  /** The user message it came from; null for a member's request. */
  messageId: string | null;
}

export type EngineRunPhase = "prepared" | "sending" | "accepted" | "running" | "uncertain" | "rejected" | "terminal";

/** A host run: one wake of a seat. */
export interface EngineRunView {
  id: string;
  seatId: string;
  threadId: string;
  phase: EngineRunPhase;
  t3RunId: string | null;
  reservedSeq: number;
  through: number;
  inputs: number[];
  requestIds: string[];
  failure: string | null;
  output: { seq: number; number: number } | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** GET /api/rooms/:roomId/runs/:runId: a run with the exact briefing T3 received. */
export interface EngineRunDetail extends EngineRunView {
  briefing: string | null;
  images: Array<{ eventId: string; names: string[] }>;
}

/** Background work holding requests open: `bg:` T3 listed work at turn end; `work:` the member said `working`. */
export interface EngineActivityView {
  id: string;
  kind: "bg" | "work" | "other";
  seatId: string;
  runId: string;
  requestIds: string[];
  status: "pending" | "uncertain" | "done" | "failed";
  /** Held by the member (`work:`). Since H5 the host registers no activities; only journals from before it hold them. */
  memberHeld: boolean;
  /** "working since …": exact (`at`) for `bg:`, a lower bound (`after`) for `work:`. */
  since: EngineTime;
}

/** A delivery the engine could not make: one input with its open requests over the byte budget. */
export interface EngineBlockedView {
  seatId: string;
  eventId: string;
  number: number | null;
  requiredBytes: number;
}

/** A seat: a member's binding on the journal. */
export interface EngineSeatView {
  seatId: string;
  participantId: string | null;
  alias: string | null;
  threadId: string;
  status: "active" | "retired";
  orchestrator: boolean;
  /** Ever the Consigliere's, from the whole journal: it held the role at some point, or a reseat moved its work to a seat that did. */
  consigliere: boolean;
  cursor: number;
  activeRunId: string | null;
  /** Addressed input waiting for its next run. */
  unread: number;
  blocked: EngineBlockedView | null;
  activities: EngineActivityView[];
  owns: number;
  awaits: number;
}

/** A member's status (ParticipantStatus), from the journal and T3, with the seat's background work and backlog. */
export interface EngineMemberStatus extends ParticipantStatus {
  seatId: string | null;
  working: boolean;
  unread: number;
}

export interface EngineRoomCounts {
  posts: number;
  requests: number;
  openRequests: number;
  runs: number;
  unresolvedRuns: number;
  notices: number;
  blocked: number;
  pendingActivities: number;
  unread: number;
  /** Notices that need you plus open approvals and questions. */
  needsYou: number;
  /** Seats with an active run. */
  busy: number;
  /** Seats with unread input and no run. */
  waiting: number;
  /** Seats with pending background work. */
  working: number;
}

/** The user's notice marks: every notice at or below `through` is handled, and so are `ids`. */
export interface EngineNoticeMarks {
  through: number;
  ids: string[];
}

export interface EngineBoardPage {
  head: number;
  posts: EnginePost[];
  earlier: boolean;
}

/** GET /api/overview: a thread outside rooms, shown as a room of one. */
export interface OverviewThread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  status: T3ThreadStatus;
  pendingRequest: { id: string; kind: string; createdAt: string } | null;
  backgroundLiveness: "working" | "monitoring" | null;
  /** Its latest run stopped on its provider's usage limit. Absent from an older service. */
  usageLimit?: T3UsageLimit | null;
  latestRunCompletedAt: string | null;
  updatedAt: string;
  /** The agent's latest line while it works, else what it last said. */
  line: string | null;
  /** Its last run finished (or failed) after it was last looked at, on any device. */
  news: { at: string; state: "completed" | "error" } | null;
}

/** GET /api/overview: per project, how many threads outside rooms are settled and archived (EngineShelfCount); archived null when T3 would not list them. */
export interface EngineShelfCount {
  projectId: string;
  settled: number;
  archived: number | null;
}

/** GET /api/t3/threads?shelf=1: a settled or archived thread outside rooms, as the overview's shelf lists it (EngineShelfThread). */
export interface EngineShelfThread {
  id: string;
  projectId: string;
  title: string;
  model: string;
  settledAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

/** GET /api/overview (EngineOverview). */
export interface Overview {
  rooms: OverviewRoom[];
  threads: OverviewThread[];
  shelf: EngineShelfCount[];
  readAt: string;
}

/** GET /api/overview: every room with its members and what each is doing, for Look → Overview (EngineOverviewRoom). */
export interface OverviewRoom {
  id: string;
  projectId: string;
  title: string;
  consigliereId: string | null;
  /** Things waiting on you in the room: notices that need you, approvals and questions. */
  needs: number;
  members: Array<{
    id: string;
    alias: string;
    modelSelection: ModelSelection;
    /** The crew member it was seated as, for its look. */
    presetId: string | null;
    consigliere: boolean;
    status: EngineMemberStatus;
    /** The last line of a turn in progress: a progress note, or the tools running. */
    live: string | null;
    /** The request its live run works on. */
    doing: string | null;
    /** What it last said, with T3's time (exact `at`, or the lower bound `after`). */
    lastReply: (EngineTime & { text: string }) | null;
  }>;
  /** The room state's first line, the tile's blurb; null without a state. */
  state: { line: string; by: string; at: string } | null;
  updatedAt: string;
}

/** An image the user attached in the room (POST /api/rooms/:roomId/attachments). */
export interface Attachment {
  id: string;
  roomId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/** What T3 accepts on a turn; the server enforces the same limits (415/413). */
export const ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export interface NativeRequest {
  participantId: string;
  threadId: string;
  requestId: string;
  kind: "approval" | "user-input" | "secret";
  payload: unknown;
  createdAt: string;
}

/** A secret T3 asks you for, as a secret request's payload carries it (`secret`). */
export interface SecretAsk {
  label: string;
  reason: string;
  placeholder: string | null;
  delivery: "file" | null;
}

/** Saved (T3 stores it, never shown to the agent) or declined. */
export type SecretAnswer = { type: "save"; secret: string } | { type: "decline" };

/**
 * A thread's status in T3 (Orchestrator V2): idle before its first run, otherwise its active run's status, or how
 * its latest run ended.
 */
export type T3ThreadStatus = "idle" | "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

/** A run in progress: T3 prepares it, queues it, starts it, runs it, or waits on a request for it. */
export const isRunActive = (status: T3ThreadStatus | "unknown" | null | undefined): boolean =>
  status === "preparing" || status === "queued" || status === "starting" || status === "running" || status === "waiting";

/** What a thread waits on you for: an approval, a question, or nothing. */
export const pendingKind = (thread: { pendingRequest: { kind: string } | null }): "approval" | "question" | null =>
  thread.pendingRequest ? (thread.pendingRequest.kind === "user_input" ? "question" : "approval") : null;

export interface ParticipantStatus {
  status: T3ThreadStatus | "unknown";
  externalActivity: boolean;
  pendingApprovals: boolean;
  pendingUserInput: boolean;
  /** The member asks you for a secret (T3's request_secret tool). Absent from a service older than the page. */
  pendingSecret?: boolean;
  activeRunId: string | null;
  /** True when T3 answered but the bound thread no longer exists (deleted in T3 Code). */
  threadMissing: boolean;
  /** Work T3 lists as still running after the run settled: subagents or commands ("working"), only monitors ("monitoring"). */
  background?: "working" | "monitoring" | null;
  /** Its latest turn stopped on its provider's usage limit, and nothing runs since. Absent from an older service. */
  paused?: UsageLimitPause | null;
}

/** What the page asks of a thread's runs (member.control, thread.control): resume the paused turn, or the held queue. */
export type PageControl = { type: "resume" } | { type: "resume.cancel" } | { type: "queue.resume" } | { type: "stop.all" } | { type: "subagent.stop"; runId: string; subagentId: string };

/** A turn its provider's usage limit stopped (T3's usage-limit pause), as the room shows it. */
export interface UsageLimitPause {
  runId: string;
  /** The provider's T3 instance (claudeAgent, codex…). */
  provider: string;
  /** ISO time; null when the provider named none. */
  resetAt: string | null;
  /** The provider's own sentence. */
  message: string | null;
  /** What T3 does at the reset: "on" continues the turn, "off" will not (turned off), null nothing recorded yet. */
  resume: "on" | "off" | null;
}

/** A thread's usage-limit pause as T3 records it (the adapter's T3UsageLimit). */
export interface T3UsageLimit {
  runId: string;
  provider: string;
  resetAt: string | null;
  message: string | null;
  recovery: { autoResume: boolean; snooze: boolean; requestId: string | null } | null;
}

/**
 * A thread's queued messages: how many, and what holds them when nothing starts them ("limit": the usage limit, until
 * the limited turn continues; "held": T3 held the queue until it is resumed, with T3's reason when its runs say it).
 */
export interface QueueState {
  count: number;
  hold: null | { by: "limit"; reason: string } | { by: "held"; reason: string | null };
}

/** Work still running on a thread beside or after its run, as T3 lists it: a subagent ("agent"), or a command or monitor ("background"; `type` says which). */
export interface BackgroundTask {
  taskId: string;
  /** A subagent's run, which a stop of it names; null for work T3 lists without one. Absent from an older service. */
  runId?: string | null;
  title: string;
  kind: string;
  type: string | null;
  detail: string | null;
  lastTool: string | null;
  startedAt: string;
  updatedAt: string;
}

/** GET /api/rooms/:roomId: the room read from its journal (EngineRoomSnapshot). */
export interface RoomSnapshot {
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
  news: RoomNews;
  notices: EngineNoticeMarks;
  /** The room's effective browser and its process; null when it has none or the service cannot run browsers. */
  browser: { browser: Browser; status: RoomBrowserStatus } | null;
  /** Every browser the room may use, in the list's order, each with its process (the default among them); empty when the service cannot run browsers. */
  browsers: Array<{ browser: Browser; status: RoomBrowserStatus }>;
  /** The room state: null until one is written. */
  state: RoomState | null;
  /** Whether T3 answered for this read: when not, member status is "unknown" and untimed posts stay untimed. */
  t3: { reachable: boolean };
}

/** The room state (rooms-board state): the Consigliere's summary of where the room stands, replaced whole at each write. */
export interface RoomState {
  /** Markdown, at most 8,000 characters. */
  text: string;
  /** The alias of the member who wrote it, as it was then. */
  by: string;
  at: string;
  /** Its first line without markdown marks, at most 300 characters: the closed panel's and the Overview tile's. */
  line: string;
}

/** A shared Chrome on Backroom's machine, named by purpose. */
export interface Browser {
  id: string;
  name: string;
  /** What it is for and which logins it holds, written for agents. */
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/browsers: a browser with its process state and the rooms using it as their default. */
export interface BrowserListItem extends Browser {
  status: RoomBrowserStatus;
  usedBy: Array<{ roomId: string; title: string }>;
  /** Only on GET /api/browsers/:id. */
  profileBytes?: number | null;
}

export type BrowserMode = "vnc" | "window" | "headless";

export interface RoomBrowserStatus {
  browserId: string;
  state: "stopped" | "starting" | "running" | "error";
  mode: BrowserMode | null;
  cdpUrl: string | null;
  cdpPort: number | null;
  watchPort: number | null;
  watchPath: string | null;
  /** Host for watch links; null means the host this page was opened on. */
  watchHost: string | null;
  tabs: Array<{ id: string; title: string; url: string }>;
  startedAt: string | null;
  lastActivityAt: string | null;
  error: string | null;
}

// ---- T3 adapter shapes ----

export interface T3Environment {
  environmentId: string;
  label: string;
  serverVersion: string;
  baseUrl: string;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  /** What its new rooms start with (GET /api/t3/projects); null without a setting (browsers off, as before). */
  browsers?: ProjectBrowsersView | null;
}

/** A project's setting for its new rooms' browsers, as a room's reads: the default is the one they would use. */
export interface ProjectBrowsersView {
  enabled: boolean;
  defaultBrowserId: string | null;
  /** Null: every browser. */
  allowedBrowserIds: string[] | null;
}

/** What creating a room wrote in its project's folder (room.created's agentsFile; src/app/agentsFile.ts). */
export interface AgentsFileWritten {
  projectId: string;
  folder: string;
  /** AGENTS.md and CLAUDE.md, or CLAUDE.md alone. */
  written: string[];
  /** Kept out of git in the repository's .git/info/exclude. */
  excluded: boolean;
  /** The post-checkout hook that copies them into new worktrees; null outside git. */
  hook: "installed" | "ours" | "own-hook" | "hooks-path" | "not-main" | "no-exclude" | "failed" | null;
}

/** One project folder where Backroom wrote AGENTS.md, against the saved template rendered for it (GET /api/agents-files). */
export interface AgentsFileEntry {
  projectId: string;
  folder: string;
  /** blocked: the folder is not on this machine, or AGENTS.md is no longer a plain file of its own; Apply is refused. */
  state: "same" | "differs" | "removed" | "blocked";
  reason?: string;
  /** The project's title while T3 has it. */
  title: string | null;
  writtenAt: string;
  appliedAt: string | null;
}

/** A project's AGENTS.md against the saved template rendered for it, with the digests agentsFile.apply takes back. */
export interface AgentsFileDiff {
  projectId: string;
  folder: string;
  state: "same" | "differs";
  /** Unified diff from the project's file to the template; empty when the same. */
  diff: string;
  fileDigest: string;
  templateDigest: string;
}

/** Why pstack's last clone or update did not do what it was for (src/app/poteto.ts). */
export interface PackError {
  reason: string;
  at: string;
  during: "clone" | "update";
}

/** What of poteto-mode a seat is told to follow while it is on (src/app/poteto.ts). */
export type PotetoScope = "principles" | "full";

/** Settings → Agents file, Skills, as the settings route reports it and poteto.update answers (src/app/poteto.ts). */
export interface PotetoState {
  enabled: boolean;
  /** What of the mode seats are told to follow while it is on; kept while it is off. */
  scope: PotetoScope;
  /** The commit or tag it is pinned at; null: it follows origin's main. */
  pin: string | null;
  folder: string;
  source: string;
  /** The clone validates: the agents file's line and the Skills section point at it. */
  ready: boolean;
  /** A clone or an update is running or waiting. */
  busy: boolean;
  version: string | null;
  commit: string | null;
  checkedAt: string | null;
  lastChange: string | null;
  /** "pinned at <pin>, latest is <short>" while pinned. */
  pinned: string | null;
  error: PackError | null;
}

/** Per-model option from T3's manifest (effort, contextWindow, fastMode, thinking, …). */
export interface ModelOptionDescriptor {
  id: string;
  label: string;
  type: "select" | "boolean";
  options?: Array<{ id: string; label: string; isDefault?: boolean; description?: string }>;
  defaultValue?: unknown;
}

export interface CatalogEntry {
  instanceId: string;
  model: string;
  /** T3's display name, e.g. "Grok 4.7". */
  label: string;
  /** Provider display name, e.g. "Claude", "Codex", "Cursor", "Antigravity". */
  providerName?: string;
  /** Where the entry came from: server config, local manifest, or observed threads. */
  source: "server" | "manifest" | "observed";
  /** Absent for models without options. */
  optionDescriptors?: ModelOptionDescriptor[];
  isDefault?: boolean | null;
  isLegacy?: boolean | null;
  aliases?: string[];
  /** T3's badge for the model ("new"). */
  badge?: string;
  /** The provider's harness kind (claudeAgent, codex, cursor, …): picks the provider icon. */
  driver?: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** What a thread used, from the harness's own transcripts, and its list-price value (GET /api/rooms/:id/costs). */
export interface TokenTotals {
  /** Input sent uncached. */
  inputTokens: number;
  /** Input read from the provider's cache. */
  cachedInputTokens: number;
  /** Input written to the cache. */
  cacheWriteTokens: number;
  outputTokens: number;
  calls: number;
  /** List-price value of the priced calls. */
  costUsd: number;
}

export interface ModelCost extends TokenTotals {
  model: string;
  /** False when the price table has no rate for the model: tokens are counted, cost is not. */
  priced: boolean;
  own: TokenTotals;
  subagents: TokenTotals;
}

export interface ThreadCost {
  available: boolean;
  reason: "unsupported_provider" | "no_session" | "no_transcript" | "unreadable" | null;
  provider: string | null;
  total: TokenTotals;
  own: TokenTotals;
  subagents: TokenTotals;
  /** Largest cost first. */
  models: ModelCost[];
  /** False when some model had no rate, so the cost is a lower bound. */
  priced: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

/** GET /api/t3/threads/:threadId/costs: a thread's spend as a room shows a member's. */
export interface ThreadCosts {
  readAt: string;
  pricesFetchedAt: string | null;
  total: ThreadCost;
  /** Per reply item of the thread view (by its id): what the thread used since its previous reply. */
  replies: Record<string, ThreadCost>;
  /** What the thread has used since its last reply: the turn in progress; null when nothing. */
  openTurn: ThreadCost | null;
}

/** GET /api/rooms/:roomId/costs (EngineRoomCosts): spend per member, per reply and per turn in progress. */
export interface RoomCosts {
  readAt: string;
  pricesFetchedAt: string | null;
  room: ThreadCost;
  /** Participants with no estimate; the room's figure leaves them out. */
  withoutEstimate: string[];
  participants: Record<string, ThreadCost>;
  /**
   * Per reply, by journal event ID: what its thread used since the thread's previous reply. Only the post that carries a
   * T3 run has one (a run's final, a T3 turn's note, a continuation): explicit answers and idle settles carry none.
   */
  replies: Record<string, ThreadCost>;
  /** Per seated participant: what its thread has used since its last reply, the turn in progress. */
  openTurns: Record<string, ThreadCost>;
  /** Per seated participant: its context meter. */
  contexts: Record<string, ContextMeter>;
  /** Threads left whole because a reply's T3 time is not known: their replies carry no figure. */
  unsplit: string[];
}

/** A member's context meter, from its Claude transcript (src/domain/contextMeter.ts). Information only. */
export interface ContextMeter {
  available: boolean;
  reason: "not_claude" | "no_session" | "no_transcript" | "unreadable" | null;
  /** What the last call sent the model; null before the first call. */
  tokens: number | null;
  peak: number | null;
  compactions: number;
  lastCompactionAt: string | null;
  window: number | null;
  windowSource: "manifest" | "table" | null;
  nearCompaction: boolean;
  at: string | null;
}

/** GET /api/t3/providers: one entry per harness provider known to T3. */
/** One harness's version as T3 checks it, with T3's progress on an update (GET /api/t3/updates). */
export interface HarnessUpdate {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  version: string | null;
  latestVersion: string | null;
  status: "current" | "behind_latest" | "unknown";
  /** T3 can run its updater: behind, with an update command, and the newest version not flagged. */
  updatable: boolean;
  note: string | null;
  checkedAt: string | null;
  update: { status: "idle" | "queued" | "running" | "succeeded" | "failed" | "unchanged"; startedAt: string | null; finishedAt: string | null; message: string | null; output: string | null } | null;
  /** Asked for; T3 has not finished it yet. */
  pending: boolean;
  /** T3 refused the request itself. */
  error: string | null;
}

/** What can be updated: T3 itself and its harnesses. Nothing updates unless the user starts it. */
export interface UpdatesView {
  reachable: boolean;
  error: string | null;
  server: {
    version: string | null;
    channel: string | null;
    latest: string | null;
    newer: boolean;
    canUpdate: boolean;
    manual: string | null;
    keepsTurns: boolean;
    releaseCheckedAt: string | null;
    releaseError: string | null;
    job: { targetVersion: string; state: "installing" | "restarting" | "done" | "failed"; startedAt: string; finishedAt: string | null; error: string | null } | null;
  };
  harnesses: HarnessUpdate[];
  /** Updates that can be started from the popup: the count on the overview header's button. */
  available: number;
}

/** GET /api/file-preview: a file a reply names, as text, as media to fetch, or just its size. */
export type FilePreviewResponse =
  | { ok: true; path: string; size: number; kind: "text"; content: string; truncated: boolean }
  | { ok: true; path: string; size: number; kind: "image" | "video" | "audio"; url: string }
  | { ok: true; path: string; size: number; kind: "binary" };

export interface ProviderInfo {
  instanceId: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  version: string | null;
  authStatus: string;
  authLabel: string | null;
  message: string | null;
  usageWindows: UsageWindow[];
  usageCheckedAt: string | null;
  /** The harness's slash commands and skills, as T3's "/" menu lists them. */
  slashCommands?: Array<{ name: string; description: string | null; hint: string | null }>;
}

/**
 * A participant's settings under a name (GET /api/presets): seated in a room on a new thread, or used to start a
 * thread. The name is the alias it takes in a room, numbered when the room already has it.
 */
export interface Preset {
  id: string;
  name: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  /** Where its threads work: the project folder, or a new worktree from the project's default branch. */
  workspaceMode: "local" | "worktree";
  /** Its pixel look, every part named (src/domain/look.ts). Absent from an older service: the look's defaults then. */
  look?: Record<string, string>;
  /** What it is good at, one line read by the Consigliere when he seats; empty when none, absent from an older service. */
  goodAt?: string;
  /** What to avoid giving it, one line; empty when none, absent from an older service. */
  avoid?: string;
  createdAt: string;
  updatedAt: string;
}

/** The longest of a crew member's two lines the service takes (PRESET_DESCRIPTION_MAX in src/domain/commands.ts). */
export const PRESET_DESCRIPTION_MAX = 300;

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  status: T3ThreadStatus;
  /** The run in progress, if any. */
  activeRunId: string | null;
  latestRunId: string | null;
  latestRunCompletedAt: string | null;
  lastError: string | null;
  /** Its latest run stopped on its provider's usage limit, and nothing runs since. Absent from an older service. */
  usageLimit?: T3UsageLimit | null;
  /** The approval or question T3 is waiting on ("user_input" is a question; any other kind an approval). */
  pendingRequest: { id: string; kind: string; createdAt: string } | null;
  pendingBackgroundTasks: Array<{ taskId: string; kind: "subagent" | "command" | "monitor" | "background_task"; description: string | null; childThreadId: string | null }>;
  backgroundLiveness?: "working" | "monitoring" | null;
  /** A subagent's or fork's parent, when the thread is one. */
  lineage?: { parentThreadId: string | null; relationshipToParent: "fork" | "subagent" | null; rootThreadId: string };
  latestUserMessageAt?: string | null;
  settledAt?: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  boundToRoom: boolean;
}

/** One entry of a direct thread's conversation (GET /api/threads/:threadId). */
export type ThreadItem =
  | { kind: "user"; id: string; text: string; attachmentIds: string[]; at: string }
  | {
      kind: "reply";
      id: string;
      runId: string;
      text: string;
      progress: Array<{ text: string; at: string }>;
      at: string;
      state: "error" | "interrupted" | null;
      files: { count: number; additions: number; deletions: number } | null;
    };

/** An approval, question or secret a thread is waiting on. */
export interface ThreadRequest {
  requestId: string;
  kind: "approval" | "user-input" | "secret";
  payload: unknown;
  createdAt: string;
}

/** A T3 thread used on its own, outside any room: read from T3 on every call. */
export interface ThreadView {
  thread: T3ThreadShell;
  project: T3Project | null;
  items: ThreadItem[];
  requests: ThreadRequest[];
  /** The run in progress, streamed as T3 shows it. */
  running: { runId: string; feed: LiveFeedItem[] } | null;
  /** Its queued messages, and what holds them. Absent from an older service. */
  queue?: QueueState | null;
  /** What runs beside or after its turn: subagents, commands, monitors. Absent from an older service. */
  backgroundTasks?: BackgroundTask[];
  contextWindow: ContextWindowReading | null;
  /** What its usage card shows besides context and spend, from what T3 reports about the thread. */
  usage: {
    lastCompaction: Compaction | null;
    subagents: SubagentUsage[];
    changedFiles: { count: number; additions: number; deletions: number };
    contextReporting: boolean | null;
  };
  /** Older turns exist in T3 beyond the window read here. */
  partial: boolean;
  /** Its changes come as `thread` events on the page's stream (T3 streams them): the page's timer only backs them up. */
  pushed?: boolean;
  /** Browsers for its agent, chosen as a room chooses them; off until chosen. The default is the one in use. Absent from an older service. */
  browsers?: { enabled: boolean; defaultBrowserId: string | null; allowedBrowserIds: string[] | null };
}

/** An image sent inline with a direct thread message. */
export interface InlineImage {
  name: string;
  dataUrl: string;
}

export interface T3Activity {
  id: string;
  tone: "info" | "tool" | "approval" | "error";
  kind: string;
  summary: string;
  payload: unknown;
  runId: string | null;
  createdAt: string;
}

export interface PullRequestRef {
  repository: string;
  number: number;
  url: string;
  source?: string;
  snapshot?: unknown;
}

export interface DeskCheckpointFile {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

export interface DeskCheckpoint {
  runId: string;
  status: "ready" | "missing" | "error" | "stale";
  completedAt: string | null;
  files: DeskCheckpointFile[];
  additions: number;
  deletions: number;
}

export interface ChangedFile {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
  turns: number;
  /** When a turn last changed it. */
  lastAt: string | null;
}

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflict";

export interface GitWorkingFile {
  path: string;
  origPath: string | null;
  status: GitFileStatus;
  staged: "all" | "part" | "none";
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitFile {
  path: string;
  origPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  committedAt: string;
  isMerge: boolean;
  /** On the upstream branch; null when the branch has none. */
  pushed: boolean | null;
  additions: number;
  deletions: number;
  fileCount: number;
  files: GitCommitFile[];
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

/** One of the room's working folders in brief (GET /api/rooms/:roomId/git). */
export interface GitFolder {
  path: string;
  exists: boolean;
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  error: string | null;
  participantIds: string[];
  isProjectRoot: boolean;
}

export interface GitView extends Omit<GitFolder, "participantIds" | "isProjectRoot"> {
  prefix: string;
  repoName: string | null;
  isLinkedWorktree: boolean;
  head: { sha: string; shortSha: string; subject: string; committedAt: string } | null;
  files: GitWorkingFile[];
  commits: GitCommit[];
  moreCommits: boolean;
  worktrees: GitWorktree[];
}

/** A room folder against the repository's main branch. */
export interface GitBaseCompare {
  path: string;
  base: string | null;
  ahead: number;
  behind: number;
}

/** A file two or more room folders changed since their branches parted: a likely merge conflict. */
export interface GitOverlap {
  path: string;
  folders: string[];
}

export interface GitResponse {
  folders: GitFolder[];
  view: GitView | null;
  /** With the full view only (not the header's brief read). */
  compares?: GitBaseCompare[];
  overlaps?: GitOverlap[];
  /** The home folder of the machine Backroom runs on, to show paths as ~/… */
  home: string;
  fetchedAt: string;
}

export interface GitDiff {
  diff: string;
  truncated: boolean;
}

export interface ProposedPlan {
  id: string;
  runId: string | null;
  implementedAt: string | null;
  createdAt: string;
  markdown: string;
}

export interface ContextWindowReading {
  usedTokens: number;
  maxTokens: number;
  percent: number;
  inputTokens?: number;
  outputTokens?: number;
  totalProcessedTokens?: number;
  at: string;
}

export interface Compaction {
  beforeTokens: number;
  afterTokens: number;
  at: string;
}

/**
 * Everything T3 shows for a thread, as served by GET /api/rooms/:roomId/desk (per participant)
 * and GET /api/rooms/:roomId/participants/:participantId/live (one participant).
 */
export interface Desk {
  participantId: string;
  threadId: string | null;
  projectId: string | null;
  bindingGeneration: number;
  title: string | null;
  /** The thread's status in T3; null when the participant has no thread. */
  status: T3ThreadStatus | null;
  activeRunId: string | null;
  latestRun: { runId: string; status: T3ThreadStatus; completedAt: string | null } | null;
  lastError: string | null;
  usageLimit?: T3UsageLimit | null;
  /** Its queued messages, and what holds them. Absent from an older service. */
  queue?: QueueState | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  pullRequests: PullRequestRef[];
  linkedPullRequest: { repository: string; number: number; url: string } | null;
  planProgress: { step: string; completedSteps: number; totalSteps: number } | null;
  backgroundLiveness: "working" | "monitoring" | null;
  backgroundTasks?: BackgroundTask[];
  /** Subagents and background jobs in the desk's activity window, with T3's reported usage. */
  subagents?: SubagentUsage[];
  latestUserMessageAt: string | null;
  settledAt: string | null;
  contextWindow: ContextWindowReading | null;
  /** True when T3 receives context readings from this provider; false when it never will; null when unknown. */
  contextReporting?: boolean | null;
  /** Explicit auto-compaction window (tokens) configured in T3 for the provider; null = harness default. */
  autoCompactWindow?: number | null;
  /** Most recent compaction seen on this thread. */
  lastCompaction?: Compaction | null;
  compactions: Compaction[];
  checkpoints: DeskCheckpoint[];
  changedFiles: ChangedFile[];
  proposedPlan: ProposedPlan | null;
  toolSummary: { started: number; completed: number; errors: number; lastTool: string | null };
  /** All assistant messages of the active/latest run joined. Prefer liveFeed for display. */
  streamingText: string;
  /** The active/latest run as T3 shows it: each assistant message separately, tool calls between them collapsed. */
  liveFeed: LiveFeedItem[];
  /**
   * The run in progress on the thread, or null. `startedByRoom` is false when someone typed into the thread
   * directly in T3 (or the agent woke itself); `prompt` is that message (null for room runs and self-started ones).
   */
  runningRun?: { runId: string; startedByRoom: boolean; prompt: string | null; promptImages?: string[] } | null;
  activities: T3Activity[];
  partial: boolean;
  /** Its changes come as `thread` events on the page's stream (T3 streams them). */
  pushed?: boolean;
}

export type LiveFeedItem =
  | { kind: "message"; id: string; text: string; streaming: boolean; at: string }
  | { kind: "tools"; count: number; errors: number; labels: string[]; running: string[]; at: string }
  | { kind: "notice"; id: string; text: string; active: boolean; at: string };

/** The live route returns the same shape as one desk entry. */
export type LiveView = Desk;

export interface DeskResponse {
  participants: Record<string, Desk>;
  errors: Record<string, string>;
  fetchedAt: string;
  /** Every member's thread pushes its changes as `thread` events: the desk's timer only backs them up. */
  pushed?: boolean;
}

export interface StatusResponse {
  adapter: "fake" | "http";
  /** Entry script of the UI build the server now serves; differs from the loaded one after a rebuild. */
  uiBuild?: string | null;
  t3: {
    baseUrl: string | null;
    paired: boolean;
    pairedAt: string | null;
    tokenExpiresAt: string | null;
    /** How Backroom keeps its T3 credential (src/app/t3Credential.ts); null with the fake adapter or T3_ACCESS_TOKEN. */
    credential?: {
      renewal: "automatic" | "manual";
      expiresAt: string | null;
      renewedAt: string | null;
      error: string | null;
      /** The sentence ahead of expiry when nothing is going to renew it. */
      warning: string | null;
    } | null;
    /**
     * Whether T3's shell reaches the service as T3 streams it ("connected"), or by HTTP snapshots while the stream is
     * connecting or down (src/adapter/shellFeed.ts); `since` is when it entered that state, `error` what took it down.
     */
    feed?: { state: "connected" | "connecting" | "down"; since: string; error: string | null };
    /** The threads watched (seated, or shown in the last minute), their streams live, and those T3 refuses; null on the fake T3. */
    threads?: { watched: number; live: number; refused: number } | null;
    environment: T3Environment | null;
    auth: { authenticated: boolean; policy: string; bootstrapMethods: string[] } | null;
    error: string | null;
    /** When the error happened; it stays until the room's next good round of checks. */
    errorAt?: string | null;
  };
}

// ---- Parser draft (src/parser/explicit.ts) ----

export interface Unresolved {
  /** "wait": the assignment waits on other work, which is refused (D2), or is written with a retired directive. */
  field: "recipients" | "wait" | "instruction";
  message: string;
  /** "incomplete": still being written (guidance, never an error). "error": cannot be sent as written. */
  severity: "incomplete" | "error";
  participantCandidates?: Array<{ participantId: string; alias: string; busy: boolean }>;
}

/** An @mention in the source text and how it was read. Offsets index into sourceText. */
export interface MentionSpan {
  start: number;
  end: number;
  alias: string;
  participantId: string | null;
  role: "address" | "reference";
  /** Assignment the mention belongs to; null inside the preamble. */
  assignment: number | null;
}

export interface DependencyRef {
  /** Index of an earlier assignment in the same message. */
  index: number;
  because: "then" | "mention" | "after" | "condition";
}

/** One assignment of a message: the same instruction for each recipient, one request per recipient. */
export interface DraftAssignment {
  recipients: string[];
  instruction: string;
  /** Earlier assignments in this message that this one's text waits for: a wait that is refused (D2), unless /now. */
  after: DependencyRef[];
  /** The timing directive written for this assignment, if any: /now takes away an implied wait; /hold, /after and /steer are refused. */
  timing: "now" | "hold" | "after" | "steer" | null;
  slashCommand: string | null;
  /** Offsets into sourceText: the assignment's span, and where a directive can be inserted (after its addressing). */
  start: number;
  end: number;
  insertAt: number;
  unresolved: Unresolved[];
  consumed: string[];
}

export interface Draft {
  kind: "task" | "empty" | "participant.add" | "participant.remove";
  /** Kind "task": the assignments in message order. */
  assignments: DraftAssignment[];
  /** Kind "task": text before the first address; everyone receives the whole message as context. */
  preamble: string;
  mentions: MentionSpan[];
  sourceText: string;
  /** Everything unresolved, message-level and per assignment. */
  unresolved: Unresolved[];
  /** Non-blocking observations about the text (never disable submission). */
  hints: string[];
  consumed: string[];
  /** For kind "participant.add": the alias to seat on a new thread with T3's default model. */
  add?: { alias: string };
  /** For kind "participant.remove": the resolved participant. */
  participant?: { participantId: string; alias: string };
}

// ---- Commands (mirror of src/domain/commands.ts, input shape) ----

/**
 * Where a new thread works: the project folder (T3's "current checkout"), a new worktree made now from a base branch
 * (on `branch`, else a name the room picks), or an existing worktree.
 */
export type WorkspaceChoice = { mode: "local" } | { mode: "worktree"; baseBranch: string; branch?: string } | { mode: "existing"; worktreePath: string };

/** Folders on the T3 machine for a path as it is typed (GET /api/t3/folders): T3's own folder picker's listing. */
export interface FolderListing {
  /** The folder whose subfolders are listed; null when T3 could not read it (then `unreadable` says so). */
  parentPath: string | null;
  entries: Array<{ name: string; fullPath: string }>;
  unreadable: string | null;
}

/** A project's branches as T3 lists them, each with the worktree it is checked out in (GET /api/t3/projects/:id/refs). */
export interface ProjectRefs {
  workspaceRoot: string;
  /** T3 Code's default for the project's new threads. */
  defaultMode: "local" | "worktree" | null;
  isRepo: boolean;
  refs: Array<{ name: string; isRemote: boolean; current: boolean; isDefault: boolean; worktreePath: string | null }>;
}

export type ThreadBindingInput = { mode: "create"; workspace?: WorkspaceChoice } | { mode: "attach"; threadId: string };

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export type ThreadLifecycleChoice = "keep" | "settle" | "archive" | "delete";

export type RoomCommand =
  | { type: "room.create"; projectId: string; title: string; consigliere?: boolean }
  /** Drop a question you will not answer. */
  | { type: "native.userInput.dismiss"; participantId: string; requestId: string }
  /** Make a seated member the room's Consigliere, move the mark, or clear it (null). */
  | { type: "room.consigliere.set"; roomId: string; participantId: string | null }
  /** The Consigliere's rules in your own words; null goes back to Backroom's wording. */
  | { type: "consigliere.rules.set"; rules: string | null }
  /** The saved crew member who is the Consigliere of new rooms, or none. */
  | { type: "consigliere.preset.set"; presetId: string | null }
  /** What happens to a member's T3 thread when the Consigliere retires it or a reseat retires the old seat. */
  | { type: "consigliere.retireThread.set"; thread: ThreadLifecycleChoice }
  /** Start a conversation with the Consigliere in a project; the same requestId sent again carries on the same attempt. */
  | { type: "consigliere.start"; projectId: string; text: string; requestId: string }
  | { type: "room.update"; roomId: string; title: string }
  /** browserId omitted keeps the room's default; null falls back to "general". */
  | { type: "room.browser"; roomId: string; enabled: boolean; browserId?: string | null; allowed?: string[] | null }
  | { type: "thread.browser"; threadId: string; enabled: boolean; browserId?: string | null; allowed?: string[] | null }
  | { type: "project.browser"; projectId: string; enabled: boolean | null; browserId?: string | null; allowed?: string[] | null }
  | { type: "browser.create"; name: string; description?: string }
  | { type: "browser.update"; browserId: string; name?: string; description?: string }
  | { type: "browser.delete"; browserId: string }
  | { type: "room.reorder"; roomIds: string[] }
  | { type: "project.reorder"; projectIds: string[] }
  /** Settings → Agents file: whether Backroom writes the default agents file in a project's folder (on by default). */
  | { type: "agentsFile.enabled.set"; enabled: boolean }
  /** Settings → Agents file: the template new rooms write ({checks} filled per project); null goes back to Backroom's. */
  | { type: "agentsFile.text.set"; text: string | null }
  /** Apply the saved template to one project's AGENTS.md, bound to the diff the user looked at. */
  | { type: "agentsFile.apply"; projectId?: string | undefined; folder?: string | undefined; fileDigest: string; templateDigest: string }
  /** Settings → Agents file, Skills: whether pstack's poteto-mode is pointed at by the agents file and the briefing (on by default). */
  | { type: "poteto.enabled.set"; enabled: boolean }
  /** Settings → Agents file, Skills: what of the mode they tell a seat to follow, its principles (the default) or the whole mode. */
  | { type: "poteto.scope.set"; scope: PotetoScope }
  /** Update now: pstack's clone fetched and moved, or made when it is missing. */
  | { type: "poteto.update" }
  /** Pin this version (a commit or a tag), or with null follow origin's main again. */
  | { type: "poteto.pin.set"; pin: string | null }
  | { type: "room.delete"; roomId: string; threads: Record<string, ThreadLifecycleChoice> }
  | {
      type: "participant.create";
      roomId: string;
      alias: string;
      /** Required when creating a thread; omitted when attaching (the server inherits the thread's model from T3). */
      modelSelection?: ModelSelection;
      runtimeMode?: RuntimeMode;
      interactionMode?: InteractionMode;
      thread: ThreadBindingInput;
    }
  | { type: "participant.update"; participantId: string; alias?: string }
  /** Changes the bound T3 thread's model/options; the provider (instanceId) cannot change (409 "cannot switch provider"). */
  | { type: "participant.model.set"; participantId: string; modelSelection: ModelSelection }
  | { type: "participant.runtimeMode.set"; participantId: string; runtimeMode: RuntimeMode }
  | { type: "participant.retire"; participantId: string; thread?: ThreadLifecycleChoice }
  | { type: "preset.create"; name: string; modelSelection: ModelSelection; runtimeMode?: RuntimeMode; workspaceMode?: "local" | "worktree"; look?: Record<string, string>; goodAt?: string; avoid?: string }
  | { type: "preset.update"; presetId: string; name?: string; modelSelection?: ModelSelection; runtimeMode?: RuntimeMode; workspaceMode?: "local" | "worktree"; look?: Record<string, string>; goodAt?: string; avoid?: string }
  | { type: "preset.delete"; presetId: string }
  /** Seat a preset on a new thread; without an alias it takes the preset's name, numbered when taken. */
  | { type: "participant.fromPreset"; roomId: string; presetId: string; alias?: string }
  /**
   * A message: one request per recipient per assignment (src/app/engineMessages.ts). Nothing waits on other work (D2);
   * `preamble` is the text before the first address, context for every recipient; the same `clientMessageId` sent again
   * records nothing twice.
   */
  | {
      type: "message.create";
      roomId: string;
      sourceText: string | null;
      preamble?: string;
      clientMessageId?: string;
      attachmentIds: string[];
      assignments: Array<{ recipients: string[]; instruction: string; slashCommand?: boolean }>;
    }
  /** The user's controls on the journal, by journal IDs: withdraw or amend a request of yours, retry a failed run, stop a member's turn. */
  | { type: "request.cancel"; roomId: string; requestId: string }
  | { type: "request.correct"; roomId: string; requestId: string; text: string }
  | { type: "run.retry"; roomId: string; runId: string; text?: string }
  | { type: "run.stop"; roomId: string; participantId: string; everything?: boolean }
  | { type: "native.approval.respond"; participantId: string; requestId: string; decision: ApprovalDecision }
  | { type: "native.userInput.respond"; participantId: string; requestId: string; answers: Record<string, unknown> }
  | { type: "native.secret.respond"; participantId: string; requestId: string; answer: SecretAnswer }
  | { type: "member.control"; roomId: string; participantId: string; control: PageControl }
  /** Add a T3 project for a folder on the T3 machine; the title defaults to the folder name. */
  | { type: "project.create"; workspaceRoot: string; title?: string; createIfMissing?: boolean }
  /** Direct threads (outside any room): the text goes to T3 as typed. */
  | { type: "thread.start"; projectId: string; threadId?: string; text: string; images?: InlineImage[]; modelSelection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; workspace?: WorkspaceChoice }
  | { type: "thread.send"; threadId: string; text: string; images?: InlineImage[] }
  | { type: "thread.interrupt"; threadId: string }
  | { type: "thread.approval.respond"; threadId: string; requestId: string; decision: ApprovalDecision }
  | { type: "thread.userInput.respond"; threadId: string; requestId: string; answers: Record<string, unknown> }
  | { type: "thread.secret.respond"; threadId: string; requestId: string; answer: SecretAnswer }
  | { type: "thread.control"; threadId: string; control: PageControl }
  | { type: "thread.model.set"; threadId: string; modelSelection: ModelSelection }
  | { type: "thread.runtimeMode.set"; threadId: string; runtimeMode: RuntimeMode }
  | { type: "thread.lifecycle"; threadId: string; action: "settle" | "unsettle" | "archive" | "unarchive" | "delete" };

export type CommandResult =
  /** agentsFile: Backroom wrote the default agents file in the project's folder just now (the page says so). */
  | { type: "room.created"; roomId: string; agentsFile?: AgentsFileWritten }
  | { type: "settings.updated" }
  | { type: "agentsFile.applied"; file: AgentsFileEntry }
  | { type: "poteto.updated"; poteto: PotetoState }
  | { type: "consigliere.started"; roomId: string; participantId: string }
  | { type: "room.updated"; roomId: string }
  | { type: "rooms.reordered" }
  | { type: "projects.reordered" }
  | {
      type: "room.deleted";
      roomId: string;
      /** timeout: sent, but T3 had not answered within the service's limit; it may still go through. */
      threads: Array<{ participantId: string; alias: string; threadId: string; action: string; result: "done" | "kept" | "failed" | "timeout"; detail?: string }>;
    }
  | { type: "participant.created"; participantId: string; threadId: string; alias?: string }
  | {
      type: "participant.updated";
      participantId: string;
      /** Present after participant.retire: what happened to its T3 thread. */
      thread?: { threadId: string; action: ThreadLifecycleChoice; result: "done" | "kept" | "failed" | "timeout"; detail?: string };
    }
  | { type: "requests.created"; messageId: string; requestIds: string[]; noteIds: string[] }
  | { type: "request.updated"; requestId: string; applied: boolean }
  | { type: "run.retried"; runId: string; eventId: string }
  | { type: "run.stopped"; participantId: string }
  | { type: "native.responded"; requestId: string }
  /** A control went to T3 ("sent"), or found the turn already continued ("already"). */
  | { type: "member.controlled"; participantId: string; outcome: "sent" | "already" }
  | { type: "thread.controlled"; threadId: string; outcome: "sent" | "already" }
  | { type: "project.created"; projectId: string }
  | { type: "browser.created"; browserId: string }
  | { type: "thread.started"; threadId: string }
  | { type: "thread.updated"; threadId: string }
  /** Newer result kinds the UI does not need to distinguish. */
  | { type: string; participantId?: string; presetId?: string; alias?: string };

export interface ApiErrorBody {
  error: string;
  message: string;
  issues?: Array<{ path: string; message: string }>;
}

export interface SubagentUsage {
  taskId: string;
  title: string;
  model: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

/** T3's usage summary for today: per provider and model across all threads (not per thread). */
export interface UsageToday {
  available: boolean;
  day?: string;
  readAt: string | null;
  buckets: Array<{
    provider: string;
    model: string;
    totals: { uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number };
    costUsd: number;
    costSource: string;
    sessions: number;
  }>;
  pricing: { status: string; source: string; fetchedAt: string | null } | null;
}
