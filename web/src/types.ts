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
  nextTaskNumber: number;
  /** Tasks in this room get a browser (started on demand) described in their briefings. */
  browserEnabled: boolean;
  /** The room's default browser; null means "general". */
  defaultBrowserId: string | null;
  /** Browsers the room's agents may use; null means all of them. */
  allowedBrowserIds: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomListItem extends Room {
  participantCount: number;
  working: number;
  waiting: number;
  /** Live thread state from the scheduler's last poll: mid-turn, background work running, only monitoring, needs you. */
  activity?: { turn: number; background: number; monitoring: number; needsInput: number };
}

export interface Participant {
  id: string;
  roomId: string;
  alias: string;
  /** Role held in this room (a named set of rules), or null. */
  roleId: string | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  bindingGeneration: number;
  /** Set when the participant was removed from the room; kept for attribution of past events. */
  retiredAt: string | null;
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

export type RoomEventKind = "user.message" | "note" | "assistant.reply" | "t3.turn" | "t3.message" | "task.status" | "system";

export type Speaker =
  | { type: "user" }
  | { type: "participant"; participantId: string; bindingId: string }
  | { type: "system" };

export interface ArtifactRef {
  path?: string;
  kind?: string;
  additions?: number;
  deletions?: number;
  branch?: string;
  commit?: string;
  note?: string;
}

/** The artifact that says where a reply's work is: folder (path), branch, commit, uncommitted count (note). */
export const isWorkspaceArtifact = (artifact: ArtifactRef): boolean => artifact.kind === "workspace";

export interface RoomEvent {
  id: string;
  roomId: string;
  sequence: number;
  kind: RoomEventKind;
  speaker: Speaker;
  text: string;
  taskId: string | null;
  runId: string | null;
  artifacts: ArtifactRef[];
  /** Images the user attached to this message (user.message events). */
  attachmentIds: string[];
  /** assistant.reply: the participant's earlier messages in the same turn (progress notes between tool calls). */
  progress: Array<{ text: string; at: string }>;
  /** t3.turn: the prompt typed directly in T3 that started the turn. */
  prompt: string | null;
  sourceRef: { threadId: string; messageId: string; turnId: string | null } | null;
  createdAt: string;
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

export type ScheduleMode = "now" | "after_all" | "manual";

export interface PrerequisiteRef {
  taskId: string;
  revision: number;
}

export type Schedule =
  | { mode: "now" }
  | { mode: "manual" }
  | { mode: "after_all"; prerequisites: PrerequisiteRef[] };

export type TaskState =
  | "queued"
  | "held"
  | "blocked"
  | "dispatching"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export const PENDING_STATES: ReadonlySet<TaskState> = new Set(["queued", "held", "blocked"]);
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(["dispatching", "running", "needs_input"]);
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

export interface Task {
  id: string;
  roomId: string;
  number: number;
  revision: number;
  sourceEventId: string;
  participantId: string;
  instruction: string;
  sourceText: string | null;
  attachmentIds: string[];
  /** "steer": sent into the recipient's running turn instead of waiting for it to end. */
  delivery: "queue" | "steer";
  /** A T3 slash command sent verbatim ("/compact …"). */
  slashCommand: boolean;
  scheduleMode: ScheduleMode;
  prerequisites: PrerequisiteRef[];
  state: TaskState;
  stateReason: string | null;
  currentRunId: string | null;
  userOutcome: "blocked" | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | "pending"
  | "dispatched"
  | "accepted"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted";

export interface Run {
  id: string;
  taskId: string;
  taskRevision: number;
  attempt: number;
  bindingId: string;
  threadId: string;
  commandId: string;
  messageId: string;
  turnId: string | null;
  status: RunStatus;
  /** Sent into a turn that was already running (steering); shares that turn's reply. */
  steered: boolean;
  briefing: string;
  includedFromSequence: number;
  includedToSequence: number;
  interruptRequestedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resultEventId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeRequest {
  participantId: string;
  threadId: string;
  requestId: string;
  kind: "approval" | "user-input";
  payload: unknown;
  createdAt: string;
}

export interface ParticipantStatus {
  session: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" | "unknown";
  externalActivity: boolean;
  pendingApprovals: boolean;
  pendingUserInput: boolean;
  activeRunId: string | null;
  /** True when T3 answered but the bound thread no longer exists (deleted in T3 Code). */
  threadMissing: boolean;
  /** T3's backgroundLiveness: subagents or background jobs running ("working"), only watch loops ("monitoring"). */
  background?: "working" | "monitoring" | null;
}

/** A background job still running on a thread (T3 task.* activities): a subagent or a shell job. */
export interface BackgroundTask {
  taskId: string;
  title: string;
  kind: string;
  type: string | null;
  detail: string | null;
  lastTool: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface RoomSnapshot {
  room: Room;
  participants: Participant[];
  roles: Role[];
  bindings: SessionBinding[];
  tasks: Task[];
  runs: Run[];
  events: RoomEvent[];
  nativeRequests: NativeRequest[];
  participantStatus: Record<string, ParticipantStatus>;
  /** The room's effective browser and its process; null when it has none or the service cannot run browsers. */
  browser: { browser: Browser; status: RoomBrowserStatus } | null;
}

/** A shared Chrome on the room service's machine, named by purpose. */
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
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** GET /api/t3/providers: one entry per harness provider known to T3. */
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

/** A named set of rules assigned to participants in a room (GET /api/roles). */
export interface Role {
  id: string;
  name: string;
  rules: string;
  createdAt: string;
  updatedAt: string;
}

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
  latestTurn: { turnId: string; state: string; completedAt: string | null; assistantMessageId: string | null } | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  backgroundLiveness?: "working" | "monitoring" | null;
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
      turnId: string;
      text: string;
      progress: Array<{ text: string; at: string }>;
      at: string;
      state: "error" | "interrupted" | null;
      files: { count: number; additions: number; deletions: number } | null;
    };

/** An approval or question a thread is waiting on. */
export interface ThreadRequest {
  requestId: string;
  kind: "approval" | "user-input";
  payload: unknown;
  createdAt: string;
}

/** A T3 thread used on its own, outside any room: read from T3 on every call. */
export interface ThreadView {
  thread: T3ThreadShell;
  project: T3Project | null;
  items: ThreadItem[];
  requests: ThreadRequest[];
  /** The turn running now, streamed as T3 shows it. */
  running: { turnId: string; feed: LiveFeedItem[] } | null;
  contextWindow: ContextWindowReading | null;
  /** Older turns exist in T3 beyond the window read here. */
  partial: boolean;
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
  turnId: string | null;
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
  turnId: string;
  status: "ready" | "missing" | "error";
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
  /** The home folder of the machine the room service runs on, to show paths as ~/… */
  home: string;
  fetchedAt: string;
}

export interface GitDiff {
  diff: string;
  truncated: boolean;
}

export interface ProposedPlan {
  id: string;
  turnId: string | null;
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
  session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
  latestTurn: { turnId: string; state: string; completedAt: string | null; assistantMessageId: string | null } | null;
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
  /** All assistant messages of the active/latest turn joined. Prefer liveFeed for display. */
  streamingText: string;
  /** The active/latest turn as T3 shows it: each assistant message separately, tool calls between them collapsed. */
  liveFeed: LiveFeedItem[];
  /**
   * The turn running on the thread right now, or null. `startedByRoom` is false when someone typed into the
   * thread directly in T3; `prompt` is that message (null for room-started turns).
   */
  runningTurn?: { turnId: string; startedByRoom: boolean; prompt: string | null; promptImages?: string[] } | null;
  activities: T3Activity[];
  partial: boolean;
}

export type LiveFeedItem =
  | { kind: "message"; id: string; text: string; streaming: boolean; at: string }
  | { kind: "tools"; count: number; errors: number; labels: string[]; at: string };

/** The live route returns the same shape as one desk entry. */
export type LiveView = Desk;

export interface DeskResponse {
  participants: Record<string, Desk>;
  errors: Record<string, string>;
  fetchedAt: string;
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
    environment: T3Environment | null;
    auth: { authenticated: boolean; policy: string; bootstrapMethods: string[] } | null;
    error: string | null;
  };
}

// ---- Parser draft (src/parser/explicit.ts) ----

export interface Unresolved {
  field: "recipients" | "prerequisites" | "schedule" | "instruction";
  message: string;
  /** "incomplete": still being written (guidance, never an error). "error": cannot be sent as written. */
  severity: "incomplete" | "error";
  candidates?: Array<{ taskId: string; revision: number; label: string }>;
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

/** One assignment of a message: the same instruction for each recipient, one task per recipient. */
export interface DraftAssignment {
  recipients: string[];
  instruction: string;
  /** Timing against work outside this message; null when unresolved. */
  schedule: Schedule | null;
  /** Earlier assignments in this message whose tasks this one waits for. */
  after: DependencyRef[];
  /** The timing directive written for this assignment, if any. */
  timing: "now" | "hold" | "after" | null;
  delivery: "queue" | "steer";
  slashCommand: string | null;
  /** Offsets into sourceText: the assignment's span, and where a directive can be inserted (after its addressing). */
  start: number;
  end: number;
  insertAt: number;
  unresolved: Unresolved[];
  consumed: string[];
}

export interface Draft {
  kind: "task" | "note" | "empty" | "participant.add" | "participant.remove" | "participant.role";
  /** Note text (kind "note"). */
  instruction: string;
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
  /** For kind "participant.add": the alias to seat on a new thread with T3's default model, plus an optional role. */
  add?: { alias: string; roleId?: string; roleName?: string };
  /** For kinds "participant.remove" / "participant.role": the resolved participant. */
  participant?: { participantId: string; alias: string };
  /** For kind "participant.role": the role to give; roleId "" with name "none" clears it. */
  role?: { roleId: string; name: string };
}

// ---- Commands (mirror of src/domain/commands.ts, input shape) ----

/**
 * Where a new thread works: the project folder (T3's "current checkout"), a new worktree made now from a base branch
 * (on `branch`, else a name the room picks), or an existing worktree.
 */
export type WorkspaceChoice = { mode: "local" } | { mode: "worktree"; baseBranch: string; branch?: string } | { mode: "existing"; worktreePath: string };

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
  | { type: "room.create"; projectId: string; title: string }
  | { type: "room.update"; roomId: string; title: string }
  /** browserId omitted keeps the room's default; null falls back to "general". */
  | { type: "room.browser"; roomId: string; enabled: boolean; browserId?: string | null; allowed?: string[] | null }
  | { type: "browser.create"; name: string; description?: string }
  | { type: "browser.update"; browserId: string; name?: string; description?: string }
  | { type: "browser.delete"; browserId: string }
  | { type: "room.reorder"; roomIds: string[] }
  | { type: "room.delete"; roomId: string; threads: Record<string, ThreadLifecycleChoice> }
  | {
      type: "participant.create";
      roomId: string;
      alias: string;
      roleId?: string | null;
      /** Required when creating a thread; omitted when attaching (the server inherits the thread's model from T3). */
      modelSelection?: ModelSelection;
      runtimeMode?: RuntimeMode;
      interactionMode?: InteractionMode;
      thread: ThreadBindingInput;
    }
  | { type: "participant.update"; participantId: string; alias?: string; roleId?: string | null }
  /** Changes the bound T3 thread's model/options; the provider (instanceId) cannot change (409 "cannot switch provider"). */
  | { type: "participant.model.set"; participantId: string; modelSelection: ModelSelection }
  | { type: "participant.rebind"; participantId: string; thread: ThreadBindingInput; outstandingTasks: "carry" | "block" }
  | { type: "participant.runtimeMode.set"; participantId: string; runtimeMode: RuntimeMode }
  | { type: "participant.retire"; participantId: string; pendingTasks: "cancel" | "keep"; thread?: ThreadLifecycleChoice }
  | { type: "role.create"; name: string; rules: string }
  | { type: "role.update"; roleId: string; name?: string; rules?: string }
  | { type: "role.delete"; roleId: string }
  | {
      type: "task.create";
      roomId: string;
      recipients: string[];
      instruction: string;
      sourceText?: string | null;
      attachmentIds?: string[];
      schedule: Schedule;
    }
  /** A message split into assignments; `after` holds indices of earlier assignments to wait for. */
  | {
      type: "message.create";
      roomId: string;
      sourceText: string | null;
      attachmentIds: string[];
      assignments: Array<{ recipients: string[]; instruction: string; schedule: Schedule; after: number[] }>;
    }
  | { type: "room.note.create"; roomId: string; text: string }
  | {
      type: "task.update";
      taskId: string;
      revision: number;
      instruction?: string;
      participantId?: string;
      schedule?: Schedule;
      carryDependents?: boolean;
    }
  | { type: "task.release"; taskId: string; revision: number }
  | { type: "task.cancel"; taskId: string; revision: number }
  | { type: "task.interrupt"; taskId: string; runId: string }
  | { type: "task.retry"; taskId: string; revision: number; reattachDependents: boolean }
  | { type: "task.markBlocked"; taskId: string; revision: number; reason: string }
  | { type: "task.unblock"; taskId: string; revision: number }
  | { type: "native.approval.respond"; participantId: string; requestId: string; decision: ApprovalDecision }
  | { type: "native.userInput.respond"; participantId: string; requestId: string; answers: Record<string, unknown> }
  /** Add a T3 project for a folder on the T3 machine; the title defaults to the folder name. */
  | { type: "project.create"; workspaceRoot: string; title?: string; createIfMissing?: boolean }
  /** Direct threads (outside any room): the text goes to T3 as typed. */
  | { type: "thread.start"; projectId: string; threadId?: string; text: string; images?: InlineImage[]; modelSelection?: ModelSelection; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; workspace?: WorkspaceChoice }
  | { type: "thread.send"; threadId: string; text: string; images?: InlineImage[] }
  | { type: "thread.interrupt"; threadId: string }
  | { type: "thread.approval.respond"; threadId: string; requestId: string; decision: ApprovalDecision }
  | { type: "thread.userInput.respond"; threadId: string; requestId: string; answers: Record<string, unknown> }
  | { type: "thread.model.set"; threadId: string; modelSelection: ModelSelection }
  | { type: "thread.runtimeMode.set"; threadId: string; runtimeMode: RuntimeMode }
  | { type: "thread.lifecycle"; threadId: string; action: "settle" | "unsettle" | "archive" | "unarchive" | "delete" };

export type CommandResult =
  | { type: "room.created"; roomId: string }
  | { type: "room.updated"; roomId: string }
  | { type: "rooms.reordered" }
  | {
      type: "room.deleted";
      roomId: string;
      threads: Array<{ participantId: string; alias: string; threadId: string; action: string; result: "done" | "kept" | "failed"; detail?: string }>;
    }
  | { type: "participant.created"; participantId: string; threadId: string }
  | {
      type: "participant.updated";
      participantId: string;
      /** Present after participant.retire: what happened to its T3 thread. */
      thread?: { threadId: string; action: ThreadLifecycleChoice; result: "done" | "kept" | "failed"; detail?: string };
    }
  | { type: "tasks.created"; taskIds: string[]; eventId: string }
  | { type: "note.created"; eventId: string }
  | { type: "task.updated"; taskId: string; revision: number }
  | { type: "task.interrupt.requested"; taskId: string; runId: string }
  | { type: "native.responded"; requestId: string }
  | { type: "project.created"; projectId: string }
  | { type: "browser.created"; browserId: string }
  | { type: "thread.started"; threadId: string }
  | { type: "thread.updated"; threadId: string }
  /** Newer result kinds the UI does not need to distinguish. */
  | { type: string; participantId?: string; roleId?: string };

export interface ApiErrorBody {
  error: string;
  message: string;
  issues?: Array<{ path: string; message: string }>;
}

export const taskLabel = (task: Pick<Task, "number">): string => `task${task.number}`;

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
