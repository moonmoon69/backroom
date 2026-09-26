/**
 * The T3 integration boundary (PRD section 9). One adapter exposes project/provider discovery,
 * thread creation/attachment, turn submission, execution observation, conversation reads,
 * pending-request responses, and interruption. All T3 identities are opaque strings.
 */
import type { InteractionMode, ModelSelection, RuntimeMode } from "../domain/types.ts";

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

export type T3SessionStatus = "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
export type T3TurnState = "running" | "interrupted" | "completed" | "error";

export interface T3PullRequest {
  repository: string;
  number: number;
  url: string;
  source: string | null;
  /** Provider snapshot as T3 reports it (state, title, checks); shape is T3's and passed through. */
  snapshot: unknown;
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
  session: { status: T3SessionStatus; activeTurnId: string | null; lastError: string | null } | null;
  /** requestedAt equals the createdAt of the user message that requested the turn (T3 stamps both from the command). */
  latestTurn: { turnId: string; state: T3TurnState; requestedAt: string | null; completedAt: string | null; assistantMessageId: string | null } | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  pullRequests: T3PullRequest[];
  linkedPullRequest: { repository: string; number: number; url: string } | null;
  planProgress: { step: string; completedSteps: number; totalSteps: number } | null;
  backgroundLiveness: "working" | "monitoring" | null;
  latestUserMessageAt: string | null;
  settledAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
}

export interface T3ProposedPlan {
  id: string;
  turnId: string | null;
  planMarkdown: string;
  implementedAt: string | null;
  createdAt: string;
}

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system" | "reasoning";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  /** Images attached to a user message in T3 (files named by id under T3's userdata/attachments). */
  attachments?: T3MessageAttachment[];
}

export interface T3MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
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

export interface T3Checkpoint {
  turnId: string;
  status: "ready" | "missing" | "error";
  files: Array<{ path: string; kind: string; additions: number; deletions: number }>;
  assistantMessageId: string | null;
  completedAt: string;
}

export interface T3ThreadDetail {
  shell: T3ThreadShell;
  messages: T3Message[];
  activities: T3Activity[];
  checkpoints: T3Checkpoint[];
  proposedPlans: T3ProposedPlan[];
}

/** T3's UploadChatImageAttachment: PNG/JPEG/GIF/WebP, up to 10 MB each, as a base64 data URL. */
export interface TurnImage {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface StartTurnInput {
  commandId: string;
  threadId: string;
  messageId: string;
  text: string;
  /** Images sent inline with the turn; T3 stores them and passes them to the provider. */
  images?: TurnImage[];
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  titleSeed?: string;
}

export interface CreateThreadInput {
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
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

/** Raised when the adapter cannot reach or authenticate with T3. The scheduler retries later. */
export class T3Unavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "T3Unavailable";
  }
}

export interface T3Adapter {
  readonly kind: "fake" | "http";
  describe(): Promise<T3Environment>;
  listProjects(): Promise<T3Project[]>;
  /** Add a project to T3 (project.create). T3 refuses a folder another project already uses. */
  createProject(input: CreateProjectInput): Promise<void>;
  listCatalog(): Promise<CatalogEntry[]>;
  listProviders(): Promise<T3ProviderInfo[]>;
  listThreads(projectId?: string): Promise<T3ThreadShell[]>;
  getThreadShell(threadId: string): Promise<T3ThreadShell | null>;
  getThreadDetail(threadId: string, options?: { turnLimit?: number }): Promise<T3ThreadDetail | null>;
  /** T3's default model for new threads in a project (project override, else the server default). */
  defaultModelSelection(projectId: string): Promise<ModelSelection | null>;
  createThread(input: CreateThreadInput): Promise<void>;
  startTurn(input: StartTurnInput): Promise<void>;
  /** Change a thread's model/options in T3 (thread.meta.update). */
  setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void>;
  interruptTurn(input: { commandId: string; threadId: string; turnId: string | null }): Promise<void>;
  respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: ApprovalDecision }): Promise<void>;
  respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void>;
  setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: RuntimeMode }): Promise<void>;
  /**
   * T3's usage summary for one day (server.getUsageSummary): token totals and API-equivalent cost per provider and
   * model across all threads, read from the harness transcripts. Not per thread; not money spent on subscriptions.
   */
  usageSummary?(input: { day: string; timeZone: string }): Promise<UsageSummary>;
  /** Settle (T3's "settled" list), archive (hidden, reversible), or delete (permanent) a thread; or undo a settle or archive. */
  setThreadLifecycle(input: { commandId: string; threadId: string; action: ThreadLifecycleAction }): Promise<void>;
  /**
   * Archived threads. T3 leaves them out of listThreads and of reads by id; only its archived snapshot lists them.
   * Deleted threads are in neither: T3 serves no record of them.
   */
  listArchivedThreads?(): Promise<T3ThreadShell[]>;
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
