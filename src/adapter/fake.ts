/**
 * In-memory T3 stand-in for tests and demo mode. Mimics T3's Orchestrator V2 as observed live (0.0.46-nightly):
 * a message starts a run (or waits in the queue behind the active one, or is steered into it); the run is "running"
 * with its messages, items and requests under its id, then "completed", "failed" or "interrupted" with a checkpoint;
 * the next queued run then starts. The thread's shell names the active run and the latest one.
 */
import { randomUUID } from "node:crypto";
import type { ModelSelection } from "../domain/types.ts";
import type {
  ApprovalDecision,
  ThreadLifecycleAction,
  CatalogEntry,
  ClientActivity,
  CreateProjectInput,
  FolderListing,
  LaunchThreadInput,
  SendMessageInput,
  T3Adapter,
  T3Checkpoint,
  T3BackgroundTask,
  T3Environment,
  T3Message,
  T3MessageAttachment,
  T3Plan,
  T3Project,
  T3ProviderInfo,
  T3ProviderThread,
  T3ProviderTurn,
  T3Ref,
  T3Run,
  T3RuntimeRequest,
  T3ShellChange,
  T3ShellFeedStatus,
  T3Subagent,
  T3ThreadDetail,
  T3ThreadShell,
  T3TurnItem,
  T3UserInputQuestion,
  SecretAnswer,
  T3ApprovalOption,
  T3PullRequest,
  T3PullRequestChecks,
  T3RuntimeRequestKind,
  T3SecretAsk,
  T3Versions,
  ThreadControl,
} from "./types.ts";
import { CONTINUE_TEXT, STOP_EVERYTHING_REASON, ORCHESTRATION_PROTOCOL_VERSION, T3CommandRejected, T3SecretRefused, isRunActive, latestExecutedRun, limitArmId, limitIdentity, openRequests, pullRequestWatchTaskId, secretRequests, usageLimitOf } from "./types.ts";
import { ThreadWatches } from "./threadFeed.ts";

interface FakeThread {
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
  /** T3's limitRecovery on the thread record: which limited run to continue at which reset, and the command that armed it. */
  recovery?: { runId: string; resetAt: string; autoResume: boolean; snooze: boolean; requestId: string } | null;
}

export interface FakeRunCompletion {
  text: string;
  /** Messages the agent wrote earlier in the run, before its final one. */
  progress?: string[];
  outcome?: "completed" | "error" | "interrupted" | "limit";
  /** outcome "limit": when the provider says its limit resets (ISO); none when it names no time. */
  resetAt?: string | null;
  files?: Array<{ path: string; kind: string; additions: number; deletions: number }>;
}

/** What T3 itself keeps across a restart of Backroom: its threads, projects and branches, command receipts, and held threads. */
export interface FakeState {
  threads: FakeThread[];
  projects: T3Project[];
  refs: Array<[string, T3Ref[]]>;
  seenCommands: string[];
  runPrompts: Array<[string, string]>;
  held: string[];
  steeredMessages: number;
}

export interface FakeAdapterOptions {
  /** Automatically complete runs after this many milliseconds. Null means manual completion. */
  autoCompleteMs?: number | null;
  autoReply?: (input: { threadId: string; text: string }) => FakeRunCompletion;
  /** How long a harness or server update takes, in milliseconds (0: at once). */
  updateMs?: number;
  /** The demo project's folder (ROOMS_FAKE_PROJECT_DIR for the service); /tmp/demo by default, which is never created. */
  projectRoot?: string;
}

export class FakeT3Adapter implements T3Adapter {
  readonly kind = "fake" as const;
  readonly threads = new Map<string, FakeThread>();
  readonly projects: T3Project[] = [
    { id: "project_demo", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: null },
  ];
  readonly commands: Array<{ type: string; commandId: string; threadId: string; payload: unknown }> = [];
  /** Messages steered into a running run (by the room or typed in T3). Queue-mode tests expect zero from the room. */
  steeredMessages = 0;
  /** Per thread: the text of the message that started each run, for the automatic reply. */
  private readonly runPrompts = new Map<string, string>();
  private readonly seenCommands = new Set<string>();
  /** Simulated outage: every call throws until cleared. */
  outage: Error | null = null;
  /**
   * A restart half done (#8): T3 answers its descriptor and commands, but its projects and threads (the orchestration
   * shell) are not served: their reads throw until cleared.
   */
  shellOutage: Error | null = null;
  /** When set, dispatched commands are dropped after being recorded (ack lost) to test reconciliation. */
  dropAcks = false;
  /** When set, T3 records the user message and its run, but the provider fails to start: the run fails with this error. */
  startFailure: string | null = null;
  /**
   * A message sent into a running run that lands as the run ends (M1 review item 2): T3 records it in the run, the agent
   * does nothing after it, and when the run completes T3 either moves it to a run of its own ("move", as T3 does when
   * the provider turn ended before it could be delivered) or leaves it there, after the run's last work ("stay").
   */
  lateSteers: "move" | "stay" | null = null;
  private readonly lateSteered = new Map<string, string[]>();
  /** Threads whose runs are not finished automatically (a script holds the run open; completeRun ends it). */
  readonly held = new Set<string>();
  /**
   * What versions() reports; tests and the demo change it. A T3 on the nightly channel with a Claude update it can
   * run and a Codex update it cannot. updateHarness and updateServer move it along the way T3 does.
   */
  readonly versionState: T3Versions = {
    serverVersion: "0.0.46-nightly.20261003.2610",
    selfUpdate: "boot-service",
    desktopAppUpdate: false,
    threadContinuation: true,
    harnesses: [
      { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, version: "2.1.282", latestVersion: "2.1.283", status: "behind_latest", updatable: true, note: null, checkedAt: new Date().toISOString(), update: null },
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, version: "0.157.0", latestVersion: "0.158.0", status: "behind_latest", updatable: false, note: "T3 cannot update this install; update it where it was installed.", checkedAt: new Date().toISOString(), update: null },
    ],
  };
  /** When set, the next harness update fails with this message (T3 answers, with the failure in its state) and a server update is refused. */
  updateFailure: string | null = null;
  /** Server updates asked for, in order. */
  readonly serverUpdates: Array<{ targetVersion: string; continueRunningThreads: boolean }> = [];
  readonly providerRefreshes: Array<{ instanceId?: string; refreshModels?: boolean }> = [];
  readonly activityReports: Array<ClientActivity | null> = [];
  private readonly options: Required<Omit<FakeAdapterOptions, "projectRoot">>;
  private readonly shellListeners = new Set<(change: T3ShellChange) => void>();
  private shellChangeQueued = false;
  /** Who watches which thread, as the HTTP adapter keeps it: only a watched thread's changes are told, as T3 streams only those. */
  readonly watches = new ThreadWatches({ onWatch: () => undefined, onUnwatch: () => undefined });
  private readonly threadListeners = new Set<(threadId: string) => void>();
  private readonly threadChangesQueued = new Set<string>();
  private readonly createdAt = new Date().toISOString();

  constructor(options: FakeAdapterOptions = {}) {
    if (options.projectRoot) this.projects[0]!.workspaceRoot = options.projectRoot;
    this.options = {
      updateMs: options.updateMs ?? 0,
      autoCompleteMs: options.autoCompleteMs === undefined ? 10 : options.autoCompleteMs,
      autoReply:
        options.autoReply ??
        ((input) => {
          const assignment = /== Your assignment \([^)]+\) ==\n([^\n]+)/.exec(input.text)?.[1] ?? input.text.slice(0, 80);
          const slug = assignment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "work";
          const files = [
            { path: `src/${slug}.ts`, kind: "modified", additions: 12 + slug.length, deletions: 3 },
            { path: `tests/${slug}.test.ts`, kind: "added", additions: 20, deletions: 0 },
          ];
          return {
            progress: [`Looking at the code for: ${assignment}`, `Found the relevant files; editing src/${slug}.ts now.`],
            text: `Done: ${assignment}\n\nHandoff: edited ${files.map((f) => f.path).join(" and ")} on the current branch (simulated agent); nothing left unintegrated.`,
            files,
          };
        }),
    };
  }

  private guard(): void {
    if (this.outage) throw this.outage;
  }

  onShellChange(listener: (change: T3ShellChange) => void): () => void {
    this.shellListeners.add(listener);
    return () => {
      this.shellListeners.delete(listener);
    };
  }

  /** The fake has no stream to lose: its shell reads are always as current as T3's own state. */
  feed(): T3ShellFeedStatus {
    return { state: "connected", since: this.createdAt, error: null };
  }

  /** Its feed never changes. */
  onFeedChange(): () => void {
    return () => undefined;
  }

  onThreadChange(listener: (threadId: string) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  holdThreads(owner: string, threadIds: readonly string[]): void {
    this.watches.hold(owner, threadIds);
  }

  leaseThread(threadId: string): void {
    this.watches.lease(threadId);
  }

  /** Every change of a watched thread is told: it has no stream to be refused. */
  threadPushed(threadId: string): boolean {
    return this.watches.has(threadId);
  }

  /**
   * A thread changed: if it is watched, its listeners hear of it once the change in hand is made (after the current
   * call's synchronous work, as the HTTP adapter tells it once a read sees it), once for a burst.
   */
  private threadChanged(threadId: string): void {
    if (!this.watches.has(threadId) || this.threadChangesQueued.has(threadId)) return;
    this.threadChangesQueued.add(threadId);
    queueMicrotask(() => {
      this.threadChangesQueued.delete(threadId);
      for (const listener of [...this.threadListeners]) listener(threadId);
    });
  }

  /**
   * Its state changed: the listeners hear of it once the change in hand is made (after the current call's synchronous
   * work, as T3's stream reports a change once it is applied). A burst of changes is heard of once, naming no thread.
   */
  private changed(): void {
    if (this.shellChangeQueued) return;
    this.shellChangeQueued = true;
    queueMicrotask(() => {
      this.shellChangeQueued = false;
      for (const listener of [...this.shellListeners]) listener({ threadIds: null });
    });
  }

  async versions(): Promise<T3Versions> {
    this.guard();
    return structuredClone(this.versionState);
  }

  async refreshProviders(input: { instanceId?: string; refreshModels?: boolean } = {}): Promise<void> {
    this.guard();
    this.providerRefreshes.push(input);
    for (const harness of this.versionState.harnesses) harness.checkedAt = new Date().toISOString();
  }

  async reportActivity(activity: ClientActivity | null): Promise<void> {
    this.guard();
    this.activityReports.push(activity);
  }

  async updateHarness(input: { instanceId: string; driver: string }): Promise<void> {
    this.guard();
    const harness = this.versionState.harnesses.find((h) => h.instanceId === input.instanceId);
    if (!harness) throw new T3CommandRejected(`T3 RPC server.updateProvider failed: no provider ${input.instanceId}`, 500, null);
    const startedAt = new Date().toISOString();
    harness.update = { status: "running", startedAt, finishedAt: null, message: "Updating provider.", output: null };
    if (this.options.updateMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.updateMs));
    const finishedAt = new Date().toISOString();
    if (this.updateFailure) {
      harness.update = { status: "failed", startedAt, finishedAt, message: this.updateFailure, output: `${this.updateFailure}\nexit code 1` };
      this.updateFailure = null;
      return;
    }
    Object.assign(harness, { version: harness.latestVersion, status: "current", updatable: false, note: null });
    harness.update = { status: "succeeded", startedAt, finishedAt, message: `Updated to ${harness.latestVersion}.`, output: null };
  }

  async updateServer(input: { targetVersion: string; continueRunningThreads: boolean }): Promise<void> {
    this.guard();
    if (this.updateFailure) {
      const reason = this.updateFailure;
      this.updateFailure = null;
      throw new T3CommandRejected(`T3 RPC server.updateServer failed: ${reason}`, 500, null);
    }
    this.serverUpdates.push(input);
    if (this.options.updateMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.updateMs));
    // Handed over: the restarted T3 runs the new version.
    this.versionState.serverVersion = input.targetVersion;
  }

  async describe(): Promise<T3Environment> {
    this.guard();
    return { environmentId: "env_fake", label: "fake", serverVersion: "0.0.0-fake", orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION, baseUrl: "fake://" };
  }

  async listProjects(): Promise<T3Project[]> {
    this.guard();
    if (this.shellOutage) throw this.shellOutage;
    return [...this.projects];
  }

  /** Test control: each project folder's branches; a folder not listed has "main" checked out in it. */
  readonly refs = new Map<string, T3Ref[]>();
  /** Test control: the next thread launched into a new worktree fails with this message. */
  failCreateWorktree: string | null = null;

  async listRefs(cwd: string): Promise<{ isRepo: boolean; refs: T3Ref[] }> {
    this.guard();
    return { isRepo: true, refs: this.refsOf(cwd) };
  }

  private refsOf(cwd: string): T3Ref[] {
    if (!this.refs.has(cwd)) this.refs.set(cwd, [{ name: "main", isRemote: false, current: true, isDefault: true, worktreePath: cwd }]);
    return this.refs.get(cwd)!;
  }

  /** Test control: folders on the fake machine besides the projects' own and their parents. `~` is /home/fake. */
  readonly folders = new Set<string>(["/home/fake/Projects/alpha", "/home/fake/Projects/beta", "/home/fake/Docs"]);

  async browseFolders(partialPath: string): Promise<FolderListing> {
    this.guard();
    const all = new Set<string>();
    const add = (folder: string) => {
      let path = folder.replace(/\/+$/, "");
      while (path) {
        all.add(path);
        path = path.split("/").slice(0, -1).join("/");
      }
      all.add("/");
    };
    for (const folder of this.folders) add(folder);
    for (const project of this.projects) add(project.workspaceRoot);
    const typed = partialPath.replace(/^~(?=\/|$)/, "/home/fake").replace(/\/{2,}/g, "/");
    const listing = typed.endsWith("/");
    const parentPath = listing ? typed.replace(/\/+$/, "") || "/" : typed.split("/").slice(0, -1).join("/") || "/";
    const prefix = listing ? "" : (typed.split("/").pop() ?? "").toLowerCase();
    if (!all.has(parentPath)) throw new T3CommandRejected(`Failed to browse filesystem path '${partialPath}'.`, 500, { failure: "read_directory_failed" });
    const children = [...all].filter((path) => path !== "/" && path.split("/").slice(0, -1).join("/") === (parentPath === "/" ? "" : parentPath));
    return {
      parentPath,
      entries: children
        .map((fullPath) => ({ name: fullPath.split("/").pop() ?? fullPath, fullPath }))
        .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async createProject(input: CreateProjectInput): Promise<void> {
    if (!this.record("project.create", input.commandId, input.projectId, input)) return;
    const root = input.workspaceRoot.replace(/\/+$/, "") || "/";
    if (this.projects.some((project) => project.workspaceRoot === root)) {
      throw new T3CommandRejected(`another project already uses ${root}`, 400, null);
    }
    this.projects.push({ id: input.projectId, title: input.title, workspaceRoot: root, defaultModelSelection: null });
  }

  async listCatalog(): Promise<CatalogEntry[]> {
    this.guard();
    return [
      {
        instanceId: "claudeAgent",
        model: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        source: "server",
        optionDescriptors: [
          { id: "effort", label: "Reasoning", type: "select", options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] },
          { id: "contextWindow", label: "Context Window", type: "select", options: [{ id: "200k", label: "200k" }, { id: "1m", label: "1M", isDefault: true }] },
        ],
      },
      { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Claude Opus 5.5", providerName: "Claude", driver: "claudeAgent", source: "server", badge: "new" },
      { instanceId: "claudeAgent", model: "claude-opus-4-8", label: "Claude Opus 4.8", providerName: "Claude", driver: "claudeAgent", source: "server", isLegacy: true },
      { instanceId: "codex", model: "gpt-6-sol", label: "GPT-6 Sol", source: "server" },
      { instanceId: "antigravity", model: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", providerName: "Antigravity", driver: "antigravity", source: "server" },
      { instanceId: "antigravity", model: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", providerName: "Antigravity", driver: "antigravity", source: "server" },
    ];
  }

  async listProviders(): Promise<T3ProviderInfo[]> {
    this.guard();
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    return [
      { instanceId: "claudeAgent", displayName: "Claude", enabled: true, installed: true, status: "ready", version: "2.1.281", authStatus: "authenticated", authLabel: "Claude Max Subscription", message: null, usageWindows: [{ id: "five_hour", label: "Session", usedPercent: 10, resetsAt: later(3 * 3600000) }, { id: "seven_day", label: "Weekly", usedPercent: 42, resetsAt: later(3 * 86400000) }, { id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 2, resetsAt: later(3 * 86400000) }], usageCheckedAt: new Date().toISOString(), reportsContextWindow: true, autoCompactWindow: null, slashCommands: [{ name: "compact", description: "Summarize the conversation and reduce context usage", hint: "<optional custom summarization instructions>" }, { name: "review", description: "Review the current changes", hint: null }] },
      { instanceId: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", version: "0.155.1", authStatus: "authenticated", authLabel: "ChatGPT Pro", message: null, usageWindows: [{ id: "primary", label: "Weekly", usedPercent: 87, resetsAt: new Date(Date.now() + 2 * 86400000).toISOString() }], usageCheckedAt: new Date().toISOString(), reportsContextWindow: true, autoCompactWindow: null, slashCommands: [{ name: "compact", description: "Summarize the conversation to free context", hint: null }, { name: "review", description: "Review uncommitted changes", hint: null }] },
      // Antigravity's windows as T3 reports them: two families, interleaved.
      { instanceId: "antigravity", displayName: "Antigravity", enabled: true, installed: true, status: "ready", version: "1.0.0", authStatus: "authenticated", authLabel: "Google account", message: null, usageWindows: [{ id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", usedPercent: 0, resetsAt: later(5 * 3600000) }, { id: "gemini-5h", label: "Gemini · 5-hour", usedPercent: 0, resetsAt: later(5 * 3600000) }, { id: "3p-weekly", label: "Claude & GPT (shared) · Weekly", usedPercent: 0, resetsAt: later(7 * 86400000) }, { id: "gemini-weekly", label: "Gemini · Weekly", usedPercent: 3, resetsAt: later(3 * 86400000) }], usageCheckedAt: new Date().toISOString(), reportsContextWindow: false, autoCompactWindow: null, slashCommands: [] },
    ];
  }

  // ---------------- threads ----------------

  async listThreads(projectId?: string): Promise<T3ThreadShell[]> {
    this.guard();
    if (this.shellOutage) throw this.shellOutage;
    // Like T3's shell snapshot: archived threads are listed apart.
    return [...this.threads.values()].map((t) => this.shellOf(t)).filter((t) => t.archivedAt === null && (!projectId || t.projectId === projectId));
  }

  async listArchivedThreads(): Promise<T3ThreadShell[]> {
    this.guard();
    if (this.shellOutage) throw this.shellOutage;
    return [...this.threads.values()].map((t) => this.shellOf(t)).filter((t) => t.archivedAt !== null);
  }

  async getThreadShell(threadId: string): Promise<T3ThreadShell | null> {
    this.guard();
    const thread = this.threads.get(threadId);
    return thread && thread.shell.archivedAt === null ? this.shellOf(thread) : null;
  }

  /** The thread's shell as T3 lists it, with what T3 derives from its runs when it is read: the usage-limit pause. */
  private shellOf(thread: FakeThread): T3ThreadShell {
    const shell = structuredClone(thread.shell);
    shell.usageLimit = this.activeRun(thread) ? null : usageLimitOf(thread, thread.recovery ?? null);
    return shell;
  }

  async getThreadDetail(threadId: string): Promise<T3ThreadDetail | null> {
    this.guard();
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    return structuredClone({
      snapshotSequence: this.commands.length,
      shell: this.shellOf(thread),
      runs: thread.runs,
      messages: thread.messages,
      turnItems: thread.turnItems,
      // As the HTTP adapter reads T3's projection: a secret waits as a turn item, and is read as a request.
      runtimeRequests: [...thread.runtimeRequests, ...secretRequests(thread.turnItems, thread.runs)],
      checkpoints: thread.checkpoints,
      subagents: thread.subagents,
      providerTurns: thread.providerTurns,
      providerThreads: thread.providerThreads,
      plans: thread.plans,
      partial: false,
    });
  }

  private record(type: string, commandId: string, threadId: string, payload: unknown): boolean {
    this.guard();
    this.commands.push({ type, commandId, threadId, payload });
    if (this.seenCommands.has(commandId)) return false; // T3 keeps a receipt per command: a replay changes nothing
    this.seenCommands.add(commandId);
    this.changed();
    this.threadChanged(threadId);
    return true;
  }

  private require(threadId: string): FakeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new T3CommandRejected(`No orchestration projection exists for thread ${threadId}.`, 500, null);
    return thread;
  }

  /** A timestamp later than anything on the thread, so its messages and items keep the order they were made in. */
  private stamp(thread: FakeThread): string {
    const last = Math.max(Date.parse(thread.shell.updatedAt) || 0, Date.parse(thread.shell.latestUserMessageAt ?? "") || 0);
    const at = new Date(Math.max(Date.now(), last + 1)).toISOString();
    thread.shell.updatedAt = at;
    this.changed();
    this.threadChanged(thread.shell.id);
    return at;
  }

  private activeRun(thread: FakeThread): T3Run | null {
    return thread.runs.find((run) => run.status !== "queued" && isRunActive(run.status)) ?? null;
  }

  private item(thread: FakeThread, runId: string | null, at: string): { id: string; runId: string | null; nodeId: string | null; providerTurnId: string | null; ordinal: number; status: "completed"; title: null; startedAt: string; completedAt: string; updatedAt: string } {
    const ordinal = thread.turnItems.reduce((max, x) => Math.max(max, x.ordinal), 0) + 1;
    return { id: `turn-item:${randomUUID()}`, runId, nodeId: runId ? `node:${runId}:root` : null, providerTurnId: null, ordinal, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at };
  }

  async defaultModelSelection(): Promise<ModelSelection | null> {
    this.guard();
    return { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "medium" }] };
  }

  async setThreadTitle(input: { commandId: string; threadId: string; title: string }): Promise<void> {
    if (!this.record("thread.metadata.update", input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    thread.shell.title = input.title;
    thread.shell.updatedAt = new Date().toISOString();
  }

  async setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void> {
    if (!this.record("thread.model-selection.set", input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    thread.shell.modelSelection = input.modelSelection;
    thread.shell.updatedAt = new Date().toISOString();
  }

  async launchThread(input: LaunchThreadInput): Promise<T3ThreadShell> {
    if (!this.record("thread.launch", input.commandId, input.threadId, input)) return structuredClone(this.require(input.threadId).shell);
    if (this.threads.has(input.threadId)) throw new T3CommandRejected("thread already exists", 409, null);
    const root = this.projects.find((project) => project.id === input.projectId)?.workspaceRoot ?? "/tmp/demo";
    let branch: string | null = null;
    let worktreePath: string | null = null;
    if (input.workspace.type === "existing_worktree") {
      branch = input.workspace.branch ?? null;
      worktreePath = input.workspace.worktreePath;
    } else if (input.workspace.type === "worktree") {
      const refs = this.refsOf(root);
      if (this.failCreateWorktree) {
        const message = this.failCreateWorktree;
        this.failCreateWorktree = null;
        throw new T3CommandRejected(message, 500, null);
      }
      const baseRef = input.workspace.baseRef;
      if (!refs.some((ref) => ref.name === baseRef)) throw new T3CommandRejected(`invalid reference: ${baseRef}`, 500, null);
      // T3 names the branch from the first message when none is given.
      const named = input.workspace.branch ?? `t3code/${(input.initialMessage?.text ?? "thread").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "thread"}`;
      if (refs.some((ref) => ref.name === named)) throw new T3CommandRejected(`a branch named '${named}' already exists`, 500, null);
      branch = named;
      worktreePath = `${root}-worktrees/${named.replace(/\//g, "-")}`;
      refs.push({ name: named, isRemote: false, current: false, isDefault: false, worktreePath });
    }
    const now = new Date().toISOString();
    const thread: FakeThread = {
      shell: {
        id: input.threadId,
        projectId: input.projectId,
        title: input.title,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch,
        worktreePath,
        status: "idle",
        activeRunId: null,
        latestRunId: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
        lastError: null,
        usageLimit: null,
        pendingRequest: null,
        pendingBackgroundTasks: [],
        hasActionableProposedPlan: false,
        pullRequests: [],
        linkedPullRequest: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
        historyOrigin: "native",
        latestUserMessageAt: null,
        settledAt: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      runs: [],
      messages: [],
      turnItems: [],
      runtimeRequests: [],
      checkpoints: [],
      subagents: [],
      providerTurns: [],
      providerThreads: [],
      plans: [],
    };
    this.threads.set(input.threadId, thread);
    if (input.initialMessage) {
      this.dispatchMessage(thread, { id: input.initialMessage.messageId, text: input.initialMessage.text, attachments: this.stored(input.initialMessage.images), createdBy: "user", creationSource: "web" }, { type: "start" });
    }
    if (this.dropAcks) throw new Error("simulated lost acknowledgement");
    return structuredClone(thread.shell);
  }

  /** Images as T3 keeps them once uploaded: named by an id of its own. */
  private stored(images: SendMessageInput["images"]): T3MessageAttachment[] {
    return (images ?? []).map((image) => ({ id: randomUUID(), name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes, type: "image" as const }));
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    if (!this.record("message.dispatch", input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    if (input.modelSelection) thread.shell.modelSelection = input.modelSelection;
    const steered = this.dispatchMessage(thread, { id: input.messageId, text: input.text, attachments: this.stored(input.images), createdBy: "user", creationSource: "web" }, input.mode);
    if (steered) this.steeredMessages += 1;
    if (this.dropAcks) throw new Error("simulated lost acknowledgement");
  }

  /**
   * A message arrives on a thread, as T3 0.0.46 handles it. Sent into a run (`steer`): into the run when it is running,
   * the agent carrying on with it (Claude and Codex take it into the turn; Cursor and Antigravity restart the turn with
   * it, so the run names it as its own message); a run of its own when the target run has completed; refused when the
   * target is in any other state or unknown. Otherwise it gets a run of its own, started now or queued behind the active
   * one. Returns whether it went into a running run.
   */
  private dispatchMessage(
    thread: FakeThread,
    message: { id: string; text: string; attachments: T3MessageAttachment[]; createdBy: T3Message["createdBy"]; creationSource: string; senderThreadId?: string; /** A limited run's continuation: it starts though the limit holds the queue. */ continues?: boolean },
    mode: SendMessageInput["mode"],
  ): boolean {
    const at = this.stamp(thread);
    const active = this.activeRun(thread);
    const record = (runId: string, intent: "turn_start" | "queued_turn" | "steer") => {
      thread.messages.push({ id: message.id, threadId: thread.shell.id, role: "user", text: message.text, runId, nodeId: `node:${runId}:root`, streaming: false, createdAt: at, updatedAt: at, createdBy: message.createdBy, creationSource: message.creationSource, senderThreadId: message.senderThreadId ?? null, attachments: message.attachments });
      // T3 lists a notice it writes for the agent as a notification, not as a user message. A message another thread's
      // agent sent is a user message like a person's.
      const typed = message.createdBy === "user" || Boolean(message.senderThreadId);
      if (typed) thread.turnItems.push({ ...this.item(thread, runId, at), type: "user_message", messageId: message.id, text: message.text, attachments: message.attachments, inputIntent: intent });
      else thread.turnItems.push({ ...this.item(thread, runId, at), type: "other", itemType: "notification" });
      if (typed) thread.shell.latestUserMessageAt = at;
    };
    if (mode.type === "steer") {
      const target = thread.runs.find((r) => r.id === mode.runId);
      if (!target) throw new T3CommandRejected(`Target run ${mode.runId} was not found.`, 409, null);
      if (target.status === "running" && active?.id === target.id) {
        record(target.id, "steer");
        if (this.lateSteers) {
          this.lateSteered.set(target.id, [...(this.lateSteered.get(target.id) ?? []), message.id]);
          return true;
        }
        // Cursor and Antigravity: T3 stops the turn and starts it again with this message, in the same run.
        if (["cursor", "antigravity"].includes(thread.shell.providerInstanceId)) target.userMessageId = message.id;
        // The agent carries on with it: what it does next shows it took the message.
        thread.turnItems.push({ ...this.item(thread, target.id, this.stamp(thread)), type: "reasoning", text: "(takes the message into the turn)", streaming: false });
        return true;
      }
      if (target.status !== "completed") throw new T3CommandRejected(`Target run ${target.id} is ${target.status} and cannot be steered.`, 409, null);
    }
    const ordinal = thread.runs.length + 1;
    const run: T3Run = {
      id: `run:thread:${thread.shell.id}:ordinal:${ordinal}`,
      threadId: thread.shell.id,
      ordinal,
      userMessageId: message.id,
      rootNodeId: `node:run:thread:${thread.shell.id}:ordinal:${ordinal}:root`,
      status: "queued",
      queuePosition: thread.runs.filter((r) => r.status === "queued").length + 1,
      queueHeld: false,
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      providerInstanceId: thread.shell.providerInstanceId,
      modelSelection: thread.shell.modelSelection,
    };
    thread.runs.push(run);
    this.runPrompts.set(run.id, message.text);
    const held = !active && (usageLimitOf(thread, null) !== null || thread.runs.some((r) => r.status === "queued" && r.queueHeld)) && !message.continues;
    record(run.id, active || held ? "queued_turn" : "turn_start");
    if (!active && !held) this.startRun(thread, run);
    return false;
  }

  private startRun(thread: FakeThread, run: T3Run): void {
    const at = this.stamp(thread);
    run.queuePosition = null;
    run.startedAt = at;
    Object.assign(thread.shell, { latestRunId: run.id, latestRunRequestedAt: run.requestedAt, latestRunStartedAt: at, latestRunCompletedAt: null });
    if (this.startFailure) {
      // The provider never starts: T3 fails the run with the provider's error.
      run.status = "failed";
      run.completedAt = at;
      thread.turnItems.push({ ...this.item(thread, run.id, at), status: "failed", type: "error", message: this.startFailure, failureClass: "provider_error", retrying: false, resetAt: null });
      Object.assign(thread.shell, { status: "failed", activeRunId: null, latestRunCompletedAt: at, lastError: this.startFailure });
      return;
    }
    run.status = "running";
    Object.assign(thread.shell, { status: "running", activeRunId: run.id, lastError: null });
    // A tool call and a context reading, so the desk panels have data in demo mode.
    const used = 12000 + thread.messages.length * 3500;
    const providerThreadId = `provider-thread:${thread.shell.id}`;
    if (thread.providerThreads.length === 0) {
      thread.providerThreads.push({ id: providerThreadId, driver: thread.shell.providerInstanceId, providerInstanceId: thread.shell.providerInstanceId, status: "active", nativeId: `native-${thread.shell.id}`, contextUsage: null, pendingBackgroundTasks: [], createdAt: at, updatedAt: at });
    }
    thread.turnItems.push({ ...this.item(thread, run.id, at), type: "dynamic_tool", toolName: "Read", input: { file_path: "src/index.ts" }, output: null });
    thread.providerTurns.push({
      id: `provider-turn:${run.id}`,
      nodeId: `node:${run.id}:root`,
      providerThreadId,
      status: "running",
      startedAt: at,
      completedAt: null,
      tokenUsage: { usedTokens: used, maxTokens: 200000, inputTokens: used - 400, cachedInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0, updatedAt: at },
      turnTokenUsage: null,
    });
    this.autoComplete(thread, run);
  }

  private autoComplete(thread: FakeThread, run: T3Run): void {
    if (this.options.autoCompleteMs === null) return;
    setTimeout(() => {
      if (this.activeRun(thread)?.id === run.id && !this.held.has(thread.shell.id)) this.completeRun(thread.shell.id, this.options.autoReply({ threadId: thread.shell.id, text: this.runPrompts.get(run.id) ?? "" }));
    }, this.options.autoCompleteMs);
  }

  /** Test control: runs on the thread are not finished automatically while it is held (completeRun ends them). */
  setHeld(threadId: string, held: boolean): void {
    if (held) this.held.add(threadId);
    else this.held.delete(threadId);
    this.changed();
  }

  /** What a restarted T3 would still have (see fakeState.ts). */
  state(): FakeState {
    return {
      threads: [...this.threads.values()],
      projects: this.projects,
      refs: [...this.refs],
      seenCommands: [...this.seenCommands],
      runPrompts: [...this.runPrompts],
      held: [...this.held],
      steeredMessages: this.steeredMessages,
    };
  }

  /** Picks up a saved state, as T3 does after a restart of Backroom: running runs go on, and unheld ones end as before. */
  restore(state: FakeState): void {
    this.threads.clear();
    for (const thread of state.threads) this.threads.set(thread.shell.id, thread);
    this.projects.splice(0, this.projects.length, ...state.projects);
    this.refs.clear();
    for (const [cwd, refs] of state.refs) this.refs.set(cwd, refs);
    this.seenCommands.clear();
    for (const id of state.seenCommands) this.seenCommands.add(id);
    this.runPrompts.clear();
    for (const [runId, text] of state.runPrompts) this.runPrompts.set(runId, text);
    this.held.clear();
    for (const id of state.held) this.held.add(id);
    this.steeredMessages = state.steeredMessages;
    for (const thread of this.threads.values()) {
      const run = this.activeRun(thread);
      if (run) this.autoComplete(thread, run);
    }
    this.changed();
  }

  /** Test control: finish the active run on a thread. The next queued run then starts. */
  completeRun(threadId: string, completion: FakeRunCompletion): void {
    const thread = this.threads.get(threadId);
    const run = thread ? this.activeRun(thread) : null;
    if (!thread || !run) throw new Error("no active run to complete");
    const outcome = completion.outcome ?? "completed";
    const say = (text: string) => {
      const at = this.stamp(thread);
      const id = `message:${randomUUID()}`;
      thread.messages.push({ id, threadId, role: "assistant", text, runId: run.id, nodeId: `node:${run.id}:${id}`, streaming: false, createdAt: at, updatedAt: at, createdBy: "agent", creationSource: "provider", senderThreadId: null, attachments: [] });
      thread.turnItems.push({ ...this.item(thread, run.id, at), type: "assistant_message", messageId: id, text, streaming: false });
    };
    for (const note of completion.progress ?? []) say(note);
    if (outcome === "error") thread.turnItems.push({ ...this.item(thread, run.id, this.stamp(thread)), status: "failed", type: "error", message: completion.text, failureClass: "provider_error", retrying: false, resetAt: null });
    if (outcome === "limit") {
      // As T3 records a provider's usage limit: the provider's error with its reset, and T3's notice of the pause.
      const resetAt = completion.resetAt ?? null;
      thread.turnItems.push({ ...this.item(thread, run.id, this.stamp(thread)), status: "failed", title: "Usage limit reached", type: "error", message: completion.text, failureClass: "usage_limit", retrying: false, resetAt });
      const left = resetAt ? Math.max(1, Math.round((Date.parse(resetAt) - Date.now()) / 60_000)) : null;
      thread.turnItems.push({ ...this.item(thread, run.id, this.stamp(thread)), type: "system_notice", message: left === null ? "Claude usage limit reached." : `Claude usage limit reached. This turn is paused until the 5-hour limit resets in ${left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`}.` });
    } else say(completion.text);
    // A message that landed as the run ended shows after the run's last assistant message.
    for (const id of this.lateSteered.get(run.id) ?? []) {
      const m = thread.messages.findIndex((x) => x.id === id);
      const i = thread.turnItems.findIndex((x) => x.type === "user_message" && x.messageId === id);
      if (m >= 0) thread.messages.push(...thread.messages.splice(m, 1));
      if (i >= 0) thread.turnItems.push({ ...thread.turnItems.splice(i, 1)[0]!, ordinal: Math.max(...thread.turnItems.map((x) => x.ordinal)) + 1 });
    }
    const at = this.stamp(thread);
    const checkpointId = `checkpoint:${run.id}`;
    const files = completion.files ?? [];
    thread.checkpoints.push({ id: checkpointId, runId: run.id, status: run.status === "failed" ? "error" : "ready", files, capturedAt: at });
    thread.turnItems.push({ ...this.item(thread, run.id, at), type: "checkpoint", checkpointId, files });
    run.status = outcome === "error" || outcome === "limit" ? "failed" : outcome;
    run.completedAt = at;
    run.checkpointId = checkpointId;
    for (const turn of thread.providerTurns) if (turn.status === "running") Object.assign(turn, { status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "interrupted", completedAt: at });
    // A request the run ended with is no longer waiting.
    for (const request of thread.runtimeRequests) if (request.status === "pending" && request.runId === run.id && request.responseMode !== "message") Object.assign(request, { status: "cancelled", resolvedAt: at });
    for (const item of thread.turnItems) if (item.type === "secret_request" && item.secretStatus === "pending" && item.runId === run.id) Object.assign(item, { status: "cancelled", secretStatus: "cancelled", completedAt: at, updatedAt: at });
    Object.assign(thread.shell, { status: run.status, activeRunId: null, latestRunCompletedAt: at, lastError: run.status === "failed" ? completion.text : null, pendingRequest: this.shellRequest(thread) });
    // A message that landed as the run ended: T3 moves it to a run of its own, or leaves it after the run's last work.
    const late = this.lateSteered.get(run.id) ?? [];
    this.lateSteered.delete(run.id);
    if (this.lateSteers === "move") for (const id of late) this.moveToOwnRun(thread, id);
    this.startNextQueued(thread, outcome === "error" ? run : null);
  }

  /**
   * The next queued message starts, as T3 decides it (startNextQueuedRun): not while the queue is held, nor while a usage
   * limit on the thread's provider holds it (until the limited run continues); after a provider failure, T3 holds the
   * queue instead.
   */
  private startNextQueued(thread: FakeThread, failed: T3Run | null): void {
    if (this.activeRun(thread) || thread.runs.some((run) => run.status === "queued" && run.queueHeld)) return;
    const next = thread.runs.find((queued) => queued.status === "queued");
    if (!next || usageLimitOf(thread, null)) return;
    if (failed && failed.providerInstanceId === next.providerInstanceId) {
      for (const run of thread.runs) if (run.status === "queued") run.queueHeld = true;
      this.changed();
      this.threadChanged(thread.shell.id);
      return;
    }
    this.startRun(thread, next);
  }

  /** T3's follow-up for a message the provider turn ended before taking: the same message, in a run of its own (queued). */
  private moveToOwnRun(thread: FakeThread, messageId: string): void {
    const message = thread.messages.find((m) => m.id === messageId);
    const item = thread.turnItems.find((x) => x.type === "user_message" && x.messageId === messageId);
    if (!message) return;
    const ordinal = thread.runs.length + 1;
    const at = this.stamp(thread);
    const run: T3Run = { id: `run:thread:${thread.shell.id}:ordinal:${ordinal}`, threadId: thread.shell.id, ordinal, userMessageId: messageId, rootNodeId: `node:run:thread:${thread.shell.id}:ordinal:${ordinal}:root`, status: "queued", queuePosition: thread.runs.filter((r) => r.status === "queued").length + 1, queueHeld: false, requestedAt: at, startedAt: null, completedAt: null, checkpointId: null, providerInstanceId: thread.shell.providerInstanceId, modelSelection: thread.shell.modelSelection };
    thread.runs.push(run);
    this.runPrompts.set(run.id, message.text);
    message.runId = run.id;
    if (item?.type === "user_message") Object.assign(item, { runId: run.id, inputIntent: "turn_start" });
  }

  /**
   * What the shell says is waiting, as the adapter reads T3's: a pending request, while a run is in progress. T3's shell
   * says a secret is a question (user_input).
   */
  private shellRequest(thread: FakeThread): T3ThreadShell["pendingRequest"] {
    const pending = openRequests({ runs: thread.runs, runtimeRequests: [...thread.runtimeRequests, ...secretRequests(thread.turnItems, thread.runs)] })[0];
    return pending ? { id: pending.id, kind: pending.kind === "secret_request" ? "user_input" : pending.kind, createdAt: pending.createdAt } : null;
  }

  /** Test control: a message the user types in T3 Code into the running run (T3 steers it in). */
  sendUserMessage(threadId: string, text: string, attachments: T3MessageAttachment[] = []): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const active = this.activeRun(thread);
    if (!active) throw new Error("no active run");
    const id = `user:${randomUUID()}`;
    this.dispatchMessage(thread, { id, text, attachments, createdBy: "user", creationSource: "web" }, { type: "steer", runId: active.id });
    return id;
  }

  /**
   * Test control: a message another thread's agent sends with T3's tools (t3_thread_send): it starts a run, waits in
   * the queue, or is steered into the running run.
   */
  sendAgentMessage(threadId: string, senderThreadId: string, text: string, mode: "start" | "steer" = "start"): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const active = this.activeRun(thread);
    const id = `message:mcp:${randomUUID()}`;
    this.dispatchMessage(thread, { id, text, attachments: [], createdBy: "agent", creationSource: "mcp", senderThreadId }, mode === "steer" && active ? { type: "steer", runId: active.id } : { type: "start" });
    return id;
  }

  /**
   * Test control: what T3 lists in the thread's background after its turn: commands the provider left running, by id,
   * or tasks whole (a monitor, T3's watch of a pull request).
   */
  setBackground(threadId: string, tasks: Array<string | T3BackgroundTask>): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    thread.shell.pendingBackgroundTasks = tasks.map((task) => (typeof task === "string" ? { taskId: task, kind: "command" as const, description: `background ${task}`, childThreadId: null } : task));
    this.changed();
    this.threadChanged(threadId);
  }

  /**
   * Test control: a subagent of the thread's running (else latest) run in this state, made or moved there: Claude's own
   * ("provider_native"), or a task T3 delegated to a thread of its own ("app_owned", with `childThreadId`). That thread
   * is listed as T3 lists it, its lineage naming the parent with relationship "subagent", and runs the task's prompt.
   */
  setSubagent(threadId: string, input: { id: string; title?: string; status: T3Subagent["status"]; origin?: T3Subagent["origin"]; driver?: string; childThreadId?: string | null }): void {
    const thread = this.require(threadId);
    const at = this.stamp(thread);
    const existing = thread.subagents.find((s) => s.id === input.id);
    if (existing) Object.assign(existing, { status: input.status, updatedAt: at });
    else {
      const runId = this.activeRun(thread)?.id ?? latestExecutedRun(thread.runs)?.id ?? null;
      thread.subagents.push({ id: input.id, runId, origin: input.origin ?? "provider_native", driver: input.driver ?? "claudeAgent", providerInstanceId: thread.shell.providerInstanceId, childThreadId: input.childThreadId ?? null, title: input.title ?? input.id, model: null, prompt: input.title ?? input.id, status: input.status, progress: null, result: null, startedAt: at, completedAt: null, updatedAt: at });
    }
    if (input.childThreadId && !this.threads.has(input.childThreadId)) this.delegatedThread(thread, input.childThreadId, input.title ?? input.id);
  }

  private delegatedThread(parent: FakeThread, id: string, prompt: string): void {
    const at = new Date().toISOString();
    const child: FakeThread = {
      shell: {
        ...structuredClone(parent.shell),
        id,
        title: prompt,
        status: "idle",
        activeRunId: null,
        latestRunId: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
        lastError: null,
        usageLimit: null,
        pendingRequest: null,
        pendingBackgroundTasks: [],
        hasActionableProposedPlan: false,
        pullRequests: [],
        linkedPullRequest: null,
        lineage: { parentThreadId: parent.shell.id, relationshipToParent: "subagent", rootThreadId: parent.shell.lineage.rootThreadId },
        historyOrigin: null,
        latestUserMessageAt: null,
        settledAt: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      },
      runs: [],
      messages: [],
      turnItems: [],
      runtimeRequests: [],
      checkpoints: [],
      subagents: [],
      providerTurns: [],
      providerThreads: [],
      plans: [],
    };
    this.threads.set(id, child);
    this.dispatchMessage(child, { id: `${id}:prompt`, text: prompt, attachments: [], createdBy: "user", creationSource: "delegate" }, { type: "start" });
  }

  /** What T3's checks read gives, by pull request ("owner/repo#70"); none read as T3 having none. */
  readonly pullRequestChecksRead = new Map<string, T3PullRequestChecks | null>();

  async pullRequestChecks(input: { projectId: string; host: string | null; repository: string; number: number }): Promise<T3PullRequestChecks | null> {
    this.guard();
    return structuredClone(this.pullRequestChecksRead.get(`${input.repository.toLowerCase()}#${input.number}`) ?? null);
  }

  /**
   * Test control: a pull request linked to the thread, as T3 keeps it: its snapshot (state, checksState, syncedAt) and,
   * while `watched`, T3's watch of it, which T3 lists among the thread's background tasks. `checks` is what T3's checks
   * read gives for it (names and statuses), apart from the snapshot, as in T3.
   */
  linkPullRequest(threadId: string, input: { repository: string; number: number; host?: string; state?: string; checksState?: "passing" | "failing" | "pending" | null; syncedAt?: string; watched: boolean; startedAt?: string; headSha?: string; failedChecks?: string[]; checks?: T3PullRequestChecks | null }): void {
    const thread = this.require(threadId);
    const host = input.host ?? "github.com";
    const at = new Date().toISOString();
    const link: T3PullRequest = {
      host,
      repository: input.repository,
      number: input.number,
      url: `https://${host}/${input.repository}/pull/${input.number}`,
      source: "agent",
      snapshot: { state: input.state ?? "open", title: `Pull request #${input.number}`, checksState: input.checksState ?? null, syncedAt: input.syncedAt ?? at },
      watch: input.watched ? { startedAt: input.startedAt ?? at, headSha: input.headSha ?? null, failedChecks: input.failedChecks ?? [], passedChecks: [], passed: false, checksAwaitedSince: null } : null,
    };
    thread.shell.pullRequests = [...thread.shell.pullRequests.filter((l) => !(l.repository === link.repository && l.number === link.number)), link];
    const taskId = pullRequestWatchTaskId(host, input.repository, input.number);
    const others = thread.shell.pendingBackgroundTasks.filter((task) => task.taskId !== taskId);
    thread.shell.pendingBackgroundTasks = input.watched ? [...others, { taskId, kind: "monitor", description: `Watching pull request #${input.number}`, childThreadId: null }] : others;
    if (input.checks !== undefined) this.pullRequestChecksRead.set(`${input.repository.toLowerCase()}#${input.number}`, input.checks);
    this.stamp(thread);
  }

  /** Test control: the agent says something in its running turn, a message of the run's before its final one. */
  say(threadId: string, text: string): string {
    const thread = this.threads.get(threadId);
    const run = thread ? this.activeRun(thread) : null;
    if (!thread || !run) throw new Error("no active run to speak in");
    const at = this.stamp(thread);
    const id = `message:${randomUUID()}`;
    thread.messages.push({ id, threadId, role: "assistant", text, runId: run.id, nodeId: `node:${run.id}:${id}`, streaming: false, createdAt: at, updatedAt: at, createdBy: "agent", creationSource: "provider", senderThreadId: null, attachments: [] });
    thread.turnItems.push({ ...this.item(thread, run.id, at), type: "assistant_message", messageId: id, text, streaming: false });
    return id;
  }

  /** Test control: a run the agent starts itself (a background task finished): T3 writes its notice, not a person. */
  startSelfRun(threadId: string): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    this.dispatchMessage(thread, { id: `message:${randomUUID()}`, text: 'Background command "watch" completed (exit code 0)', attachments: [], createdBy: "agent", creationSource: "provider" }, { type: "start" });
    return (thread.runs[thread.runs.length - 1] as T3Run).id;
  }

  /** Test control: a run started directly in T3 Code (not by the room). */
  startExternalRun(threadId: string, text = "external prompt", attachments: T3MessageAttachment[] = []): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    this.dispatchMessage(thread, { id: `user:${randomUUID()}`, text, attachments, createdBy: "user", creationSource: "web" }, { type: "start" });
    return (thread.runs[thread.runs.length - 1] as T3Run).id;
  }

  private raise(threadId: string, request: Pick<T3RuntimeRequest, "id" | "kind" | "type" | "responseMode" | "prompt" | "questions"> & Partial<Pick<T3RuntimeRequest, "options" | "appName">>): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const at = this.stamp(thread);
    const runId = this.activeRun(thread)?.id ?? null;
    const options = request.options ?? null;
    const appName = request.appName ?? null;
    thread.runtimeRequests.push({ ...request, status: "pending", runId, nodeId: `node:${request.id}`, createdAt: at, resolvedAt: null, options, appName, secret: null, decision: null, answers: null });
    if (request.type === "approval") thread.turnItems.push({ ...this.item(thread, runId, at), type: "approval_request", requestId: request.id, requestKind: request.kind, prompt: request.prompt, appName, options });
    else thread.turnItems.push({ ...this.item(thread, runId, at), type: "user_input_request", requestId: request.id, questions: request.questions, responseMode: request.responseMode === "message" ? "message" : null });
    thread.shell.pendingRequest = this.shellRequest(thread);
    return request.id;
  }

  /**
   * Test control: raise a native approval request on the active run: a command's by default; an MCP server's form request
   * (kind "mcp-elicitation") with the choices T3 offers for it (describeMcpElicitation), its prompt and its app.
   */
  raiseApproval(threadId: string, requestId: string = randomUUID(), ask: { kind?: T3RuntimeRequestKind; prompt?: string; options?: T3ApprovalOption[] | null; appName?: string | null } = {}): string {
    return this.raise(threadId, { id: requestId, kind: ask.kind ?? "command", type: "approval", responseMode: "live", prompt: ask.prompt ?? "run tests", questions: [], options: ask.options ?? null, appName: ask.appName ?? null });
  }

  /**
   * Test control: the agent asks a question. "live" holds the run until it is answered (Claude); "message" lets the
   * run go on without the answer (Codex).
   */
  raiseQuestion(threadId: string, options: { requestId?: string; responseMode?: "live" | "message"; questions?: T3UserInputQuestion[] } = {}): string {
    return this.raise(threadId, {
      id: options.requestId ?? randomUUID(),
      kind: "user_input",
      type: "user-input",
      responseMode: options.responseMode ?? "live",
      prompt: null,
      questions: options.questions ?? [{ id: "Proceed?", header: "Confirm", question: "Proceed?", options: [{ label: "yes", description: "Proceed" }, { label: "no", description: "Do not proceed" }] }],
    });
  }

  /**
   * Test control: the agent asks the user for a secret (T3's request_secret tool) in its running turn: a secret_request
   * turn item, pending until it is saved, declined, or its run ends. Returns the item's id, which answers it.
   */
  raiseSecret(threadId: string, ask: { label: string; reason: string; placeholder?: string | null; delivery?: "file" | null }): string {
    const thread = this.threads.get(threadId);
    const run = thread ? this.activeRun(thread) : null;
    if (!thread || !run) throw new Error("no active run to ask a secret in");
    const at = this.stamp(thread);
    const id = `turn-item:secret-request:${threadId}:${randomUUID()}`;
    const secret: T3SecretAsk = { label: ask.label, reason: ask.reason, placeholder: ask.placeholder ?? null, delivery: ask.delivery ?? null };
    thread.turnItems.push({ ...this.item(thread, run.id, at), id, status: "waiting", title: ask.label, completedAt: null, type: "secret_request", ...secret, secretStatus: "pending" });
    thread.shell.pendingRequest = this.shellRequest(thread);
    return id;
  }

  /** When set, the next secret answer fails with this error instead (a test's injected failure). */
  secretFailure: Error | null = null;
  /** The secret answers T3 took, in order: saved or declined, never the secret. */
  readonly secretAnswers: Array<{ threadId: string; turnItemId: string; answer: "save" | "decline" }> = [];

  async respondSecret(input: { threadId: string; turnItemId: string; answer: SecretAnswer }): Promise<void> {
    this.guard();
    const failure = this.secretFailure;
    this.secretFailure = null;
    if (failure) throw failure;
    // T3 decodes the answer first: it trims the secret and refuses a blank one.
    if (input.answer.type === "save" && input.answer.secret.trim().length === 0) throw new T3CommandRejected("T3 refused the secret; nothing was saved.", 502, null);
    const thread = this.require(input.threadId);
    const item = thread.turnItems.find((x) => x.id === input.turnItemId && x.type === "secret_request");
    if (!item || item.type !== "secret_request") throw new T3SecretRefused("not_found");
    if (item.secretStatus !== "pending") throw new T3SecretRefused("already_answered");
    if (!thread.runs.some((run) => run.id === item.runId && isRunActive(run.status))) throw new T3SecretRefused("agent_stopped");
    const at = this.stamp(thread);
    const saved = input.answer.type === "save";
    Object.assign(item, { status: saved ? "completed" : "cancelled", secretStatus: saved ? "saved" : "declined", completedAt: at, updatedAt: at });
    this.secretAnswers.push({ threadId: input.threadId, turnItemId: input.turnItemId, answer: input.answer.type });
    thread.shell.pendingRequest = this.shellRequest(thread);
  }

  /** When the fake's T3 continues armed limited threads (sweepLimits), as its recovery worker does on its schedule. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** T3's clock, for what it decides by the time: a usage limit's reset. Tests set it. */
  clock: () => number = Date.now;

  /** T3's autoResumeLimitedThreads setting: off on this machine. On, T3 arms every limited thread by itself. */
  autoResumeLimitedThreads = false;

  /** Run T3's usage-limit recovery every `ms` (the service's fake: as T3's scheduler does); null stops it. */
  sweepLimitsEvery(ms: number | null): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = ms === null ? null : setInterval(() => this.sweepLimits(), ms);
    this.sweepTimer?.unref?.();
  }

  /**
   * One pass of T3's UsageLimitRecoveryWorker (getLimitRecoveryCandidates, limitRecoveryCommand): a limited thread whose
   * recovery for this run and reset is armed continues once the reset has passed, whatever autoResumeLimitedThreads
   * says; that setting only arms the ones nobody armed.
   */
  sweepLimits(now = this.clock()): void {
    for (const thread of this.threads.values()) {
      const shell = this.shellOf(thread);
      const limit = shell.usageLimit;
      if (!limit?.resetAt || shell.archivedAt !== null || shell.settledAt !== null || shell.pendingRequest !== null) continue;
      const run = thread.runs.find((r) => r.id === limit.runId)!;
      const resetMs = Date.parse(limit.resetAt);
      if (!Number.isFinite(resetMs) || resetMs <= Date.parse(run.completedAt ?? run.requestedAt)) continue;
      try {
        if (!limit.recovery) {
          if (this.autoResumeLimitedThreads) this.applyControl(thread, limitArmId(shell.id, run.id, limit.resetAt), { type: "limit.arm", runId: run.id, resetAt: limit.resetAt });
        } else if (limit.recovery.autoResume && resetMs <= now) {
          // The command and message ID T3's worker gives its continuation (limitRecoveryCommand).
          const id = `limit-resume:${limitIdentity(shell.id, run.id, limit.resetAt)}:${limit.recovery.requestId ?? "legacy"}`;
          if (this.record("message.dispatch", id, shell.id, { usageLimitContinuationOfRunId: run.id, usageLimitRecoveryRequestId: limit.recovery.requestId, creationSource: "server" })) this.continueLimited(thread, id, { runId: run.id, resetAt: limit.resetAt, requestId: limit.recovery.requestId }, now);
        }
      } catch {
        // T3 logs a dispatch its worker could not make, and tries again on its next pass.
      }
    }
  }

  /** The commands T3 took for controls, in order (`controlThread`, and the worker's own continuations). */
  async controlThread(input: { commandId: string; threadId: string; control: ThreadControl }): Promise<void> {
    const { control } = input;
    const commandId = input.commandId;
    const type = control.type === "limit.arm" || control.type === "limit.disarm" ? "thread.metadata.update" : control.type === "queue.resume" || control.type === "thread.stop" || control.type === "subagent.stop" ? control.type : "message.dispatch";
    if (!this.record(type, commandId, input.threadId, input)) return;
    this.applyControl(this.require(input.threadId), commandId, control);
  }

  /** A control as T3 applies it, with T3's own guards and words for what it refuses. */
  private applyControl(thread: FakeThread, commandId: string, control: ThreadControl): void {
    const limit = usageLimitOf(thread, thread.recovery ?? null);
    const limitedRun = limit ? thread.runs.find((r) => r.id === limit.runId)! : null;
    switch (control.type) {
      case "limit.arm":
      case "limit.disarm": {
        const resetMs = Date.parse(control.resetAt);
        if (!Number.isFinite(resetMs) || thread.shell.archivedAt !== null || thread.shell.settledAt !== null || limitedRun?.id !== control.runId || limit?.resetAt !== control.resetAt || resetMs <= Date.parse(limitedRun.completedAt ?? limitedRun.requestedAt) || openRequests({ runs: thread.runs, runtimeRequests: thread.runtimeRequests }).length > 0) {
          throw new T3CommandRejected("The provider limit changed before recovery could be configured.", 500, null);
        }
        thread.recovery = { runId: control.runId, resetAt: control.resetAt, autoResume: control.type === "limit.arm", snooze: false, requestId: commandId };
        this.stamp(thread);
        return;
      }
      case "run.continue": {
        const source = thread.runs.find((r) => r.id === control.runId);
        if (!source || (source.status !== "interrupted" && limitedRun?.id !== source.id) || latestExecutedRun(thread.runs)?.id !== source.id || thread.shell.archivedAt !== null || thread.runtimeRequests.some((r) => r.status === "pending")) {
          throw new T3CommandRejected("This thread can no longer be resumed from that run.", 500, null);
        }
        this.dispatchMessage(thread, { id: commandId, text: CONTINUE_TEXT, attachments: [], createdBy: "user", creationSource: "web", continues: true }, { type: "start" });
        return;
      }
      case "thread.stop":
        this.stopThread(thread, commandId);
        return;
      case "subagent.stop": {
        const subagent = thread.subagents.find((s) => s.id === control.subagentId);
        const open = (s: T3Subagent) => s.status === "pending" || s.status === "running" || s.status === "waiting";
        if (subagent?.origin === "app_owned" && subagent.childThreadId !== null && subagent.runId === control.runId) {
          if (open(subagent)) this.cancelSubagent(thread, subagent);
          return;
        }
        if (!subagent || subagent.runId !== control.runId || subagent.origin !== "provider_native" || subagent.driver !== "claudeAgent") throw new T3CommandRejected("The requested native subagent cannot be stopped on this run.", 500, null);
        // T3 takes a stop of a subagent that has finished, and does nothing.
        if (open(subagent)) this.cancelSubagent(thread, subagent);
        return;
      }
      case "queue.resume": {
        if (thread.shell.archivedAt !== null) throw new T3CommandRejected(`Thread ${thread.shell.id} is not active.`, 500, null);
        if (limit) throw new T3CommandRejected("Continue the limited thread before resuming its queue.", 500, null);
        for (const run of thread.runs) if (run.status === "queued") run.queueHeld = false;
        this.stamp(thread);
        this.startNextQueued(thread, null);
        return;
      }
    }
  }

  /** A subagent stopped: cancelled, and a delegated task's own thread stops its run. */
  private cancelSubagent(thread: FakeThread, subagent: T3Subagent): void {
    const at = this.stamp(thread);
    Object.assign(subagent, { status: "cancelled", completedAt: at, updatedAt: at });
    thread.shell.pendingBackgroundTasks = thread.shell.pendingBackgroundTasks.filter((task) => task.taskId !== subagent.id);
    const child = subagent.childThreadId ? this.threads.get(subagent.childThreadId) : undefined;
    if (child && this.activeRun(child)) this.completeRun(child.shell.id, { text: "(interrupted)", outcome: "interrupted" });
  }

  /**
   * Stop everything on a thread, as T3 does it (dispatchThreadStop, holdStoppedThread): its queued messages held first, a
   * usage limit's recovery turned off, every subagent and delegated task, background task, monitor and pull-request watch
   * ended, and the running run interrupted with the stop's reason.
   */
  private stopThread(thread: FakeThread, commandId: string): void {
    for (const run of thread.runs) if (run.status === "queued") run.queueHeld = true;
    const limit = usageLimitOf(thread, thread.recovery ?? null);
    if (limit?.resetAt) thread.recovery = { runId: limit.runId, resetAt: limit.resetAt, autoResume: false, snooze: false, requestId: commandId };
    else if (thread.recovery?.autoResume) thread.recovery = { ...thread.recovery, autoResume: false, requestId: commandId };
    for (const subagent of thread.subagents) if (subagent.status === "pending" || subagent.status === "running" || subagent.status === "waiting") this.cancelSubagent(thread, subagent);
    // Its pull-request watches end with the rest of what it lists in the background.
    thread.shell.pendingBackgroundTasks = [];
    thread.shell.pullRequests = thread.shell.pullRequests.map((link) => ({ ...link, watch: null }));
    const at = this.stamp(thread);
    const active = this.activeRun(thread);
    // The run interrupted is the running one, else the latest (what its background work belongs to).
    const target = active ?? latestExecutedRun(thread.runs);
    if (target) thread.turnItems.push({ ...this.item(thread, target.id, at), title: "Interrupt requested", type: "run_interrupt_request", message: STOP_EVERYTHING_REASON });
    if (active) this.completeRun(thread.shell.id, { text: "(interrupted)", outcome: "interrupted" });
  }

  /**
   * T3's continuation at the reset (dispatchMessage with usageLimitContinuationOfRunId): it starts only while the run is
   * still the limited one and its recovery, armed by `requestId`, is on and due; otherwise T3 drops it without a word.
   */
  private continueLimited(thread: FakeThread, messageId: string, control: { runId: string; resetAt: string; requestId: string | null }, now: number): void {
    const limit = usageLimitOf(thread, thread.recovery ?? null);
    const recovery = thread.recovery;
    if (!limit || limit.runId !== control.runId || !recovery?.autoResume || recovery.requestId !== control.requestId || recovery.runId !== limit.runId || recovery.resetAt !== limit.resetAt || Date.parse(recovery.resetAt) > now || thread.shell.archivedAt !== null || thread.shell.settledAt !== null || thread.runtimeRequests.some((r) => r.status === "pending")) return;
    this.dispatchMessage(thread, { id: messageId, text: CONTINUE_TEXT, attachments: [], createdBy: "user", creationSource: "server", continues: true }, { type: "start" });
  }

  async interruptRun(input: { commandId: string; threadId: string; runId: string | null }): Promise<void> {
    if (!this.record("run.interrupt", input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    const active = this.activeRun(thread);
    if (active && (!input.runId || input.runId === active.id)) this.completeRun(input.threadId, { text: "(interrupted)", outcome: "interrupted" });
  }

  private settle(input: { commandId: string; threadId: string; requestId: string }, type: string, change: Partial<T3RuntimeRequest>): void {
    if (!this.record(type, input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    const request = thread.runtimeRequests.find((r) => r.id === input.requestId && r.status === "pending");
    if (!request) throw new T3CommandRejected(`Runtime request ${input.requestId} is not pending.`, 500, null);
    Object.assign(request, change, { resolvedAt: this.stamp(thread) });
    thread.shell.pendingRequest = this.shellRequest(thread);
  }

  async respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: ApprovalDecision }): Promise<void> {
    this.settle(input, "runtime-request.respond", { status: "resolved", decision: input.decision });
  }

  async respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void> {
    this.settle(input, "runtime-request.respond", { status: "resolved", answers: input.answers });
  }

  async dismissUserInput(input: { commandId: string; threadId: string; requestId: string }): Promise<void> {
    this.settle(input, "thread.user-input.dismiss", { status: "cancelled" });
  }

  async setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: T3ThreadShell["runtimeMode"] }): Promise<void> {
    if (!this.record("thread.runtime-mode.set", input.commandId, input.threadId, input)) return;
    this.require(input.threadId).shell.runtimeMode = input.runtimeMode;
  }

  async setThreadLifecycle(input: { commandId: string; threadId: string; action: ThreadLifecycleAction }): Promise<void> {
    if (!this.record(`thread.${input.action}`, input.commandId, input.threadId, input)) return;
    const thread = this.require(input.threadId);
    const at = new Date().toISOString();
    if (input.action === "delete") this.threads.delete(input.threadId);
    else if (input.action === "archive") thread.shell.archivedAt = at;
    else if (input.action === "unarchive") thread.shell.archivedAt = null;
    else if (input.action === "settle") thread.shell.settledAt = at;
    else thread.shell.settledAt = null;
  }
}
