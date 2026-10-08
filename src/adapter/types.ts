/**
 * The T3 integration boundary, in the terms of T3 Code's Orchestrator V2 (orchestration protocol 2): a thread's work
 * is a sequence of runs, each started by one user message and carrying its items (messages, tool calls, requests,
 * checkpoints); the thread's status is its active run's. One adapter exposes project/provider discovery, thread
 * creation and launch, message dispatch (start, queue, steer), observation, request responses and interruption.
 * All T3 identities are opaque strings.
 */
import type { InteractionMode, ModelSelection, RuntimeMode } from "../domain/types.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;

export interface T3Environment {
  environmentId: string;
  label: string;
  serverVersion: string;
  /** T3's orchestration protocol; Backroom speaks version 2 and refuses others. */
  orchestrationProtocolVersion: number | null;
  baseUrl: string;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  /** Where T3 Code starts new threads of this project by default: the project folder or a new worktree. */
  defaultThreadEnvMode?: "local" | "worktree" | null;
}

/** A branch as T3 lists it (vcs.listRefs), with the worktree that has it checked out, if any. */
export interface T3Ref {
  name: string;
  isRemote: boolean;
  current: boolean;
  isDefault: boolean;
  worktreePath: string | null;
}

/** A per-model option T3 exposes (effort, context window, fast mode…), as declared in its model manifest. */
export interface ModelOptionDescriptor {
  id: string;
  label: string;
  type: "select" | "boolean";
  /** Present for select descriptors; boolean descriptors have no option list. */
  options?: Array<{ id: string; label: string; isDefault?: boolean; description?: string }>;
  defaultValue?: unknown;
}

export interface CatalogEntry {
  instanceId: string;
  model: string;
  label: string;
  /** Provider display name as T3 shows it (Claude, Codex, Cursor…). */
  providerName?: string;
  /** Where the entry came from: server config, local manifest, or observed threads. */
  source: "server" | "manifest" | "observed";
  /** Options T3 accepts for this model; absent when unknown. */
  optionDescriptors?: ModelOptionDescriptor[];
  isDefault?: boolean;
  isLegacy?: boolean;
  aliases?: string[];
  /** T3's badge for the model ("new"), shown beside its name in the picker. */
  badge?: string;
  /** The provider's harness kind (claudeAgent, codex, cursor, …): picks the provider icon. */
  driver?: string;
}

export interface T3ProviderInfo {
  instanceId: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  version: string | null;
  authStatus: string | null;
  authLabel: string | null;
  message: string | null;
  usageWindows: Array<{ id: string; label: string; usedPercent: number | null; resetsAt: string | null }>;
  usageCheckedAt: string | null;
  /** Whether T3 receives context-window readings from this provider (Claude and Codex do; Cursor and Antigravity do not). */
  reportsContextWindow: boolean;
  /** Explicit auto-compaction window in tokens when configured in T3; null means the harness default ("auto"). */
  autoCompactWindow: number | null;
  /** The harness's slash commands and skills, as T3's "/" menu lists them (e.g. compact). */
  slashCommands?: Array<{ name: string; description: string | null; hint: string | null }>;
}

/** A client's state as T3's background policy weighs it; in view means visible and focused or recently used. */
export interface ClientActivity {
  visible: boolean;
  focused: boolean;
  recentlyInteracted: boolean;
  /** How long T3 keeps the lease without another report (it caps this at two minutes). */
  ttlMs: number;
}

/** Where T3 is with one harness update (T3's updateState): queued behind another, running, or how it ended. */
export interface T3HarnessUpdateState {
  status: "idle" | "queued" | "running" | "succeeded" | "failed" | "unchanged";
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  /** The updater's output (T3 keeps up to 10,000 characters). */
  output: string | null;
}

/** One harness's version as T3 checks it: installed, the newest published, and whether T3 can run its updater. */
export interface T3HarnessVersion {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  version: string | null;
  latestVersion: string | null;
  status: "current" | "behind_latest" | "unknown";
  /**
   * T3 would offer its one-click update: the harness is behind, T3 knows the command to update it, and T3 has not
   * flagged the newest version as broken or unsupported. The same rule as T3 Code's update prompt.
   */
  updatable: boolean;
  /** Why a harness that is behind cannot be updated from here, or T3's advisory. */
  note: string | null;
  checkedAt: string | null;
  update: T3HarnessUpdateState | null;
}

/** T3's own version, how it can update itself, and its harnesses' versions. */
export interface T3Versions {
  serverVersion: string | null;
  /**
   * How T3 updates itself (its serverSelfUpdate capability): "boot-service" (its service launcher installs and
   * restarts), "desktop-managed" (the desktop app on that machine), or null (it has to be updated by hand).
   */
  selfUpdate: string | null;
  /** A desktop-managed T3 whose app takes the update over RPC. */
  desktopAppUpdate: boolean;
  /** T3 can keep running turns going across its restart. */
  threadContinuation: boolean;
  harnesses: T3HarnessVersion[];
}

// ---------------- threads, runs and what they carry ----------------

/** A run's status, as T3 keeps it: queued and preparing before the provider starts, waiting while a request is open. */
export type T3RunStatus = "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";
/** A thread's status: idle before its first run, otherwise the status of its latest (or active) run. */
export type T3ThreadStatus = "idle" | T3RunStatus;

export const ACTIVE_RUN_STATUSES: ReadonlySet<T3RunStatus> = new Set<T3RunStatus>(["preparing", "queued", "starting", "running", "waiting"]);
export const isRunActive = (status: T3RunStatus | "idle"): boolean => status !== "idle" && ACTIVE_RUN_STATUSES.has(status);

export interface T3PullRequest {
  repository: string;
  number: number;
  url: string;
  source: string | null;
  /** Provider snapshot as T3 reports it (state, title, checks); shape is T3's and passed through. */
  snapshot: unknown;
}

/** Background work T3 reports as still running on the thread after (or beside) its run: subagents, commands, monitors. */
export interface T3BackgroundTask {
  taskId: string;
  kind: "subagent" | "command" | "monitor" | "background_task";
  description: string | null;
  childThreadId: string | null;
}

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  /** Idle, or the status of the run that owns the thread's activity (the active one, else the latest). */
  status: T3ThreadStatus;
  /** The run in progress (preparing, queued, starting, running or waiting), if any. */
  activeRunId: string | null;
  latestRunId: string | null;
  latestRunRequestedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  /** The last failure T3 recorded for the thread (a provider error, a limit), until the next run. */
  lastError: string | null;
  /** The approval or question T3 is waiting on, when there is one. */
  pendingRequest: { id: string; kind: T3RuntimeRequestKind; createdAt: string } | null;
  /** Provider work still running after the run settled: the agent wakes itself when it finishes. */
  pendingBackgroundTasks: T3BackgroundTask[];
  hasActionableProposedPlan: boolean;
  pullRequests: T3PullRequest[];
  linkedPullRequest: { repository: string; number: number; url: string } | null;
  /** A subagent's or fork's parent, when the thread is one; its root otherwise itself. */
  lineage: { parentThreadId: string | null; relationshipToParent: "fork" | "subagent" | null; rootThreadId: string };
  /** "v1_import" for conversations copied from T3's V1 database: messages only, no runs. */
  historyOrigin: "native" | "v1_import" | null;
  latestUserMessageAt: string | null;
  settledAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One user message and everything the provider did for it. */
export interface T3Run {
  id: string;
  threadId: string;
  ordinal: number;
  /** The user message that requested the run (messages carry their run id too). */
  userMessageId: string;
  status: T3RunStatus;
  queuePosition: number | null;
  /** A queue held after a restart waits for the user to resume it. */
  queueHeld: boolean;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  checkpointId: string | null;
  providerInstanceId: string;
  modelSelection: ModelSelection;
}

export interface T3MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  type: "image" | "file" | "unknown";
}

export interface T3Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** The run the message belongs to: the one it started (user), or the one that produced it (assistant). */
  runId: string | null;
  nodeId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: "user" | "agent" | "system";
  creationSource: string;
  /** The thread whose agent sent the message with T3's tools (t3_thread_send); null for a person's or T3's own. */
  senderThreadId: string | null;
  /** Attachments on a user message (files named by id under T3's userdata/attachments). */
  attachments: T3MessageAttachment[];
}

export type T3RuntimeRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission" | "dynamic_tool_call" | "user_input" | "auth_refresh";

export interface T3UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string; value?: string }>;
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  required?: boolean;
}

/** A choice a provider offers on an approval, with its caution when it gives one. */
export interface T3ApprovalOption {
  decision: ApprovalDecision;
  label: string;
  warning?: string;
}

/** An approval or question T3 raised, with what it asks (from the run's item) and whether it still waits. */
export interface T3RuntimeRequest {
  id: string;
  kind: T3RuntimeRequestKind;
  /** user_input is a question; everything else is an approval. */
  type: "approval" | "user-input";
  status: "pending" | "resolved" | "expired" | "cancelled";
  /** "live" blocks the provider until answered; "message" (Codex's questions) lets the run go on and takes the answer as a message. */
  responseMode: "live" | "message" | "not_resumable";
  runId: string | null;
  nodeId: string;
  createdAt: string;
  resolvedAt: string | null;
  /** An approval's prompt (the command, the file) and the choices the provider offers, when it names them. */
  prompt: string | null;
  options: T3ApprovalOption[] | null;
  /** A question's questions. */
  questions: T3UserInputQuestion[];
  decision: ApprovalDecision | null;
  answers: Record<string, unknown> | null;
}

export type T3TurnItemStatus = "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";

interface T3TurnItemBase {
  id: string;
  runId: string | null;
  nodeId: string | null;
  providerTurnId: string | null;
  ordinal: number;
  status: T3TurnItemStatus;
  title: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/**
 * What a run is made of, in order: T3's turn items. Backroom reads the ones it shows (messages, tools, requests,
 * checkpoints, errors, compactions, subagents); any other type is kept as "other" with its type name.
 */
export type T3TurnItem =
  | (T3TurnItemBase & { type: "user_message"; messageId: string; text: string; attachments: T3MessageAttachment[]; /** How the message entered the run: it started it, waited in the queue, or was steered into it. */ inputIntent: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer" })
  | (T3TurnItemBase & { type: "assistant_message"; messageId: string; text: string; streaming: boolean })
  | (T3TurnItemBase & { type: "reasoning"; text: string; streaming: boolean })
  | (T3TurnItemBase & { type: "proposed_plan"; planId: string; markdown: string; streaming: boolean })
  | (T3TurnItemBase & { type: "todo_list"; planId: string; steps: Array<{ id: string; text: string; status: "pending" | "running" | "completed" }>; explanation: string | null })
  | (T3TurnItemBase & { type: "user_input_request"; requestId: string; questions: T3UserInputQuestion[]; responseMode: "message" | null })
  | (T3TurnItemBase & { type: "approval_request"; requestId: string; requestKind: string; prompt: string | null; appName: string | null; options: T3ApprovalOption[] | null })
  | (T3TurnItemBase & { type: "file_change"; fileName: string; additions: number | null; deletions: number | null })
  | (T3TurnItemBase & { type: "command_execution"; input: string; output: string | null; exitCode: number | null; outputIndicatesFailure: boolean })
  | (T3TurnItemBase & { type: "file_search"; pattern: string | null })
  | (T3TurnItemBase & { type: "web_search"; patterns: string[] })
  | (T3TurnItemBase & { type: "dynamic_tool"; toolName: string | null; input: unknown; output: unknown })
  | (T3TurnItemBase & { type: "checkpoint"; checkpointId: string; files: T3CheckpointFile[] })
  | (T3TurnItemBase & { type: "error"; message: string; failureClass: string | null; retrying: boolean })
  | (T3TurnItemBase & { type: "compaction"; summary: string | null; beforeTokenCount: number | null; afterTokenCount: number | null })
  | (T3TurnItemBase & { type: "subagent"; subagentId: string; origin: "provider_native" | "app_owned"; childThreadId: string | null; prompt: string; progress: string | null; result: string | null })
  | (T3TurnItemBase & { type: "system_notice" | "run_interrupt_request" | "run_interrupt_result"; message: string })
  | (T3TurnItemBase & { type: "other"; itemType: string });

export interface T3CheckpointFile {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

/** The files a run changed, as T3 captured them when it ended. */
export interface T3Checkpoint {
  id: string;
  runId: string | null;
  status: "ready" | "missing" | "error" | "stale";
  files: T3CheckpointFile[];
  capturedAt: string;
}

export interface T3Subagent {
  id: string;
  runId: string | null;
  origin: "provider_native" | "app_owned";
  driver: string;
  providerInstanceId: string;
  childThreadId: string | null;
  title: string | null;
  model: string | null;
  prompt: string;
  status: "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  progress: string | null;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/** The provider's context reading for a turn: how full its window is, and what the turn used. */
export interface T3TokenUsage {
  usedTokens: number;
  maxTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  updatedAt: string;
}

/** One provider turn (a run attempt's work in the harness) with its context reading. */
export interface T3ProviderTurn {
  id: string;
  nodeId: string;
  providerThreadId: string;
  status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  tokenUsage: T3TokenUsage | null;
  /** The turn's totals when the provider reports them (input, output, cache; subagents flagged). */
  turnTokenUsage: { usageStatus: "complete" | "partial" | "unavailable"; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cacheCreationTokens: number | null; reasoningTokens: number | null; hasSubagents: boolean } | null;
}

/** The harness conversation behind the thread (a Claude session, a Codex thread), with its native id. */
export interface T3ProviderThread {
  id: string;
  driver: string;
  providerInstanceId: string;
  status: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
  /** The harness's own id for the conversation (Claude's session id, Codex's thread id), when T3 knows it. */
  nativeId: string | null;
  contextUsage: T3TokenUsage | null;
  pendingBackgroundTasks: T3BackgroundTask[];
  createdAt: string;
  updatedAt: string;
}

export interface T3Plan {
  id: string;
  kind: "proposed_plan" | "todo_list";
  runId: string | null;
  status: "draft" | "active" | "completed" | "superseded";
  markdown: string | null;
  steps: Array<{ id: string; text: string; status: "pending" | "running" | "completed" }>;
}

/**
 * A thread as T3 projects it: the thread, its runs and their items. A bounded read carries the control-plane arrays
 * in full and only a recent window of items and messages (`partial`).
 */
export interface T3ThreadDetail {
  snapshotSequence: number;
  shell: T3ThreadShell;
  runs: T3Run[];
  messages: T3Message[];
  turnItems: T3TurnItem[];
  runtimeRequests: T3RuntimeRequest[];
  checkpoints: T3Checkpoint[];
  subagents: T3Subagent[];
  providerTurns: T3ProviderTurn[];
  providerThreads: T3ProviderThread[];
  plans: T3Plan[];
  /** Older items and messages exist that this read does not carry. */
  partial: boolean;
}

/** T3's UploadChatImageAttachment: PNG/JPEG/GIF/WebP, up to 10 MB each, as a base64 data URL. */
export interface TurnImage {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

/**
 * How a message is dispatched: start a run now (the thread is idle), queue it after the active run, or steer it into
 * the active run (T3 feeds it to the provider's running turn, or restarts the turn with it, by provider).
 */
export type DispatchMode = { type: "start" } | { type: "queue" } | { type: "steer"; runId: string };

export interface SendMessageInput {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  /** Images sent inline with the message; T3 stores them and passes them to the provider. */
  images?: TurnImage[];
  /** Names the model for this run; a live session keeps the model it started with unless the message names one. */
  modelSelection?: ModelSelection;
  titleSeed?: string;
  mode: DispatchMode;
}

/** Where a new thread works: the project folder, a worktree that exists, or a new worktree T3 makes from a base ref. */
export type WorkspaceStrategy = { type: "root"; branch?: string } | { type: "existing_worktree"; worktreePath: string; branch?: string } | { type: "worktree"; baseRef: string; branch?: string };

/**
 * A thread, created and (with `initialMessage`) started in one call (orchestration.launchThread): T3 makes the
 * worktree, runs its setup script, and starts the agent in it.
 */
export interface LaunchThreadInput {
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  /** Let T3 name the thread from its first message. */
  generateTitle?: boolean;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  workspace: WorkspaceStrategy;
  initialMessage?: { messageId: string; text: string; images?: TurnImage[] };
}

/** What T3 lists for a path being typed: the folder it looked in, and the subfolders that match. */
export interface FolderListing {
  parentPath: string;
  entries: Array<{ name: string; fullPath: string }>;
}

export interface CreateProjectInput {
  commandId: string;
  projectId: string;
  title: string;
  /** A folder on the machine running T3. T3 expands ~ and resolves it; the folder must exist unless createIfMissing. */
  workspaceRoot: string;
  /** Let T3 create the folder (and its parents) when it does not exist. */
  createIfMissing: boolean;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

/** Raised when T3 rejects a command (validation/state) rather than a transport failure. */
export class T3CommandRejected extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "T3CommandRejected";
    this.status = status;
    this.body = body;
  }
}

/** Raised when the adapter cannot reach or authenticate with T3. The engine host tries again on a later tick. */
export class T3Unavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "T3Unavailable";
  }
}

/**
 * A call T3 was sent and never answered: it reached its time limit, or the connection went while it waited (one call's
 * time limit drops the shared socket, and with it every call still waiting there). T3 may have applied it, so it is not
 * a failure: the outcome is unknown. Still a T3Unavailable for callers that only resend with the same IDs.
 */
export class T3OutcomeUnknown extends T3Unavailable {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "T3OutcomeUnknown";
  }
}

/** Raised when the T3 server speaks another orchestration protocol (a V1 server): nothing works until it is updated. */
export class T3ProtocolMismatch extends T3Unavailable {
  readonly serverVersion: string;
  readonly protocolVersion: number | null;
  constructor(serverVersion: string, protocolVersion: number | null) {
    super(
      `T3 ${serverVersion} speaks orchestration protocol ${protocolVersion ?? 1}; Backroom needs protocol ${ORCHESTRATION_PROTOCOL_VERSION} (T3 Code Orchestrator V2, 0.0.46 or newer). Update T3.`,
    );
    this.name = "T3ProtocolMismatch";
    this.serverVersion = serverVersion;
    this.protocolVersion = protocolVersion;
  }
}

export interface T3Adapter {
  readonly kind: "fake" | "http";
  describe(): Promise<T3Environment>;
  listProjects(): Promise<T3Project[]>;
  /** Add a project to T3 (projects.mutate project.create). T3 refuses a folder another project already uses. */
  createProject(input: CreateProjectInput): Promise<void>;
  listCatalog(): Promise<CatalogEntry[]>;
  listProviders(): Promise<T3ProviderInfo[]>;
  /** Active threads (not archived, not deleted). */
  listThreads(projectId?: string): Promise<T3ThreadShell[]>;
  /** Archived threads: T3's shell lists them apart. Deleted threads are in neither. */
  listArchivedThreads(): Promise<T3ThreadShell[]>;
  getThreadShell(threadId: string): Promise<T3ThreadShell | null>;
  /**
   * The thread's projection. `bounded` asks for the recent window of items and messages only (the runs, requests and
   * provider state come in full either way); the default reads the whole history.
   */
  getThreadDetail(threadId: string, options?: { bounded?: boolean }): Promise<T3ThreadDetail | null>;
  /** T3's default model for new threads in a project (project override, else the server default). */
  defaultModelSelection(projectId: string): Promise<ModelSelection | null>;
  /** Create a thread, with its workspace made by T3, and start it when a first message is given. */
  launchThread(input: LaunchThreadInput): Promise<T3ThreadShell>;
  /** The repository's branches at `cwd` (vcs.listRefs); isRepo false when the folder is not a git repository. */
  listRefs(cwd: string): Promise<{ isRepo: boolean; refs: T3Ref[] }>;
  /**
   * Folders on the T3 machine for a path being typed (filesystem.browse): `partialPath` ending in "/" lists that
   * folder's subfolders; otherwise the subfolders of its parent whose names start with the last segment. `~` works.
   */
  browseFolders(partialPath: string): Promise<FolderListing>;
  /** Send a user message: start a run, queue it, or steer it into the active run (message.dispatch). */
  sendMessage(input: SendMessageInput): Promise<void>;
  /** Rename a thread in T3 (thread.metadata.update), and stop any title generation T3 has going for it. */
  setThreadTitle(input: { commandId: string; threadId: string; title: string }): Promise<void>;
  /** Change a thread's model/options in T3 (thread.model-selection.set). */
  setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void>;
  /** Interrupt a run (run.interrupt); null interrupts the thread's active run. */
  interruptRun(input: { commandId: string; threadId: string; runId: string | null }): Promise<void>;
  respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: ApprovalDecision }): Promise<void>;
  respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void>;
  /** Drop a question the agent went on without (thread.user-input.dismiss). */
  dismissUserInput(input: { commandId: string; threadId: string; requestId: string }): Promise<void>;
  setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: RuntimeMode }): Promise<void>;
  /**
   * T3's usage summary for one day (server.getUsageSummary): token totals and API-equivalent cost per provider and
   * model across all threads, read from the harness transcripts. Not per thread; not money spent on subscriptions.
   */
  usageSummary?(input: { day: string; timeZone: string }): Promise<UsageSummary>;
  /** Settle (T3's "settled" list), archive (hidden, reversible), or delete (permanent) a thread; or undo a settle or archive. */
  setThreadLifecycle(input: { commandId: string; threadId: string; action: ThreadLifecycleAction }): Promise<void>;
  /** T3's version and its harnesses' (server.getConfig); `fresh` skips the adapter's short cache. */
  versions(fresh?: boolean): Promise<T3Versions>;
  /**
   * Ask T3 to check its harnesses again, versions and plan usage included (server.refreshProviders): all of them, or
   * one `instanceId`. `refreshModels` also rediscovers each harness's models; T3 opens an agent session for that, so
   * it is for an explicit request only.
   */
  refreshProviders(input?: { instanceId?: string; refreshModels?: boolean }): Promise<void>;
  /**
   * Say that someone is using Backroom (server.reportClientActivity), as T3's own window does: T3 checks its providers
   * every few minutes only while a client in view holds such a lease. The lease lasts `ttlMs`, so this is repeated
   * while it holds; null closes the connection it was reported on, and the lease lapses at its end.
   */
  reportActivity(activity: ClientActivity | null): Promise<void>;
  /** Run a harness's updater through T3 (server.updateProvider). Resolves when T3 has finished; its state tells how. */
  updateHarness(input: { instanceId: string; driver: string }): Promise<void>;
  /**
   * Install an exact T3 version and hand over to it (server.updateServer). Resolves at the handover, just before T3
   * restarts; with `continueRunningThreads`, runs that are running carry on in the new process.
   */
  updateServer(input: { targetVersion: string; continueRunningThreads: boolean }): Promise<void>;
}

export type ThreadLifecycleAction = "settle" | "unsettle" | "archive" | "unarchive" | "delete";

export interface UsageBucket {
  day: string;
  provider: string;
  model: string;
  totals: { uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number };
  costUsd: number;
  costSource: string;
  sessions: number;
}

export interface UsageSummary {
  readAt: string;
  buckets: UsageBucket[];
  pricing: { status: string; source: string; fetchedAt: string | null } | null;
}

// ---------------- derived views shared by the engine host, the thread view and the desk ----------------

/**
 * The run a user message belongs to, by the message id the client chose for it: the run it started (T3 names the
 * message on the run), or the run it was steered into (T3 names the run on the message).
 */
export function runForMessage(detail: Pick<T3ThreadDetail, "runs" | "messages">, messageId: string): T3Run | null {
  const started = detail.runs.find((run) => run.userMessageId === messageId);
  if (started) return started;
  const runId = detail.messages.find((message) => message.id === messageId)?.runId ?? null;
  return runId ? (detail.runs.find((run) => run.id === runId) ?? null) : null;
}

/** The user message that started a run, when a person wrote it: null for a run the agent started on its own notice. */
export function runPrompt(detail: Pick<T3ThreadDetail, "messages">, run: T3Run): T3Message | null {
  const message = detail.messages.find((m) => m.id === run.userMessageId) ?? null;
  return message && message.role === "user" && message.createdBy === "user" ? message : null;
}

/** A run's assistant messages in order, finished ones only: the last is its answer, the earlier ones its progress. */
export function runReplies(detail: Pick<T3ThreadDetail, "messages">, runId: string): T3Message[] {
  return detail.messages.filter((m) => m.runId === runId && m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
}

/**
 * The approvals and questions the thread is waiting on, with what they ask. A question asked in "message" mode
 * (Codex) does not hold its run: the agent goes on, and may finish, without the answer. Once that run is over
 * nothing is waiting, so it is left out even if T3 still lists it as pending (it can be dismissed there).
 */
export function openRequests(detail: Pick<T3ThreadDetail, "runtimeRequests" | "runs">): T3RuntimeRequest[] {
  const active = new Set(detail.runs.filter((run) => isRunActive(run.status)).map((run) => run.id));
  return detail.runtimeRequests.filter((request) => request.status === "pending" && (request.responseMode !== "message" || (request.runId !== null && active.has(request.runId))));
}

/** What still runs on the thread after its run settled, as the members panel words it: work, or only monitors. */
export function backgroundOf(shell: Pick<T3ThreadShell, "pendingBackgroundTasks">): "working" | "monitoring" | null {
  if (shell.pendingBackgroundTasks.length === 0) return null;
  return shell.pendingBackgroundTasks.every((task) => task.kind === "monitor") ? "monitoring" : "working";
}
