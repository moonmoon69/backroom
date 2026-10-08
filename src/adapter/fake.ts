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
  T3Subagent,
  T3ThreadDetail,
  T3ThreadShell,
  T3TurnItem,
  T3UserInputQuestion,
  T3Versions,
} from "./types.ts";
import { ORCHESTRATION_PROTOCOL_VERSION, T3CommandRejected, isRunActive, openRequests } from "./types.ts";

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
}

export interface FakeRunCompletion {
  text: string;
  /** Messages the agent wrote earlier in the run, before its final one. */
  progress?: string[];
  outcome?: "completed" | "error" | "interrupted";
  files?: Array<{ path: string; kind: string; additions: number; deletions: number }>;
}

export interface FakeAdapterOptions {
  /** Automatically complete runs after this many milliseconds. Null means manual completion. */
  autoCompleteMs?: number | null;
  autoReply?: (input: { threadId: string; text: string }) => FakeRunCompletion;
  /** How long a harness or server update takes, in milliseconds (0: at once). */
  updateMs?: number;
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
  /** When set, dispatched commands are dropped after being recorded (ack lost) to test reconciliation. */
  dropAcks = false;
  /** When set, T3 records the user message and its run, but the provider fails to start: the run fails with this error. */
  startFailure: string | null = null;
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
  private readonly options: Required<FakeAdapterOptions>;

  constructor(options: FakeAdapterOptions = {}) {
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
    ];
  }

  async listProviders(): Promise<T3ProviderInfo[]> {
    this.guard();
    return [
      { instanceId: "claudeAgent", displayName: "Claude", enabled: true, installed: true, status: "ready", version: "2.1.281", authStatus: "authenticated", authLabel: "Claude Max Subscription", message: null, usageWindows: [{ id: "primary", label: "Weekly", usedPercent: 42, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() }], usageCheckedAt: new Date().toISOString(), reportsContextWindow: true, autoCompactWindow: null, slashCommands: [{ name: "compact", description: "Summarize the conversation and reduce context usage", hint: "<optional custom summarization instructions>" }, { name: "review", description: "Review the current changes", hint: null }] },
      { instanceId: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", version: "0.155.1", authStatus: "authenticated", authLabel: "ChatGPT Pro", message: null, usageWindows: [{ id: "primary", label: "Weekly", usedPercent: 87, resetsAt: new Date(Date.now() + 2 * 86400000).toISOString() }], usageCheckedAt: new Date().toISOString(), reportsContextWindow: true, autoCompactWindow: null, slashCommands: [{ name: "compact", description: "Summarize the conversation to free context", hint: null }, { name: "review", description: "Review uncommitted changes", hint: null }] },
    ];
  }

  // ---------------- threads ----------------

  async listThreads(projectId?: string): Promise<T3ThreadShell[]> {
    this.guard();
    // Like T3's shell snapshot: archived threads are listed apart.
    return [...this.threads.values()].map((t) => structuredClone(t.shell)).filter((t) => t.archivedAt === null && (!projectId || t.projectId === projectId));
  }

  async listArchivedThreads(): Promise<T3ThreadShell[]> {
    this.guard();
    return [...this.threads.values()].map((t) => structuredClone(t.shell)).filter((t) => t.archivedAt !== null);
  }

  async getThreadShell(threadId: string): Promise<T3ThreadShell | null> {
    this.guard();
    const shell = this.threads.get(threadId)?.shell;
    return shell && shell.archivedAt === null ? structuredClone(shell) : null;
  }

  async getThreadDetail(threadId: string): Promise<T3ThreadDetail | null> {
    this.guard();
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    return structuredClone({
      snapshotSequence: this.commands.length,
      shell: thread.shell,
      runs: thread.runs,
      messages: thread.messages,
      turnItems: thread.turnItems,
      runtimeRequests: thread.runtimeRequests,
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
    return at;
  }

  private activeRun(thread: FakeThread): T3Run | null {
    return thread.runs.find((run) => run.status !== "queued" && isRunActive(run.status)) ?? null;
  }

  private item(thread: FakeThread, runId: string | null, at: string): { id: string; runId: string | null; nodeId: string | null; providerTurnId: string | null; ordinal: number; status: "completed"; title: null; startedAt: string; completedAt: string; updatedAt: string } {
    return { id: `turn-item:${randomUUID()}`, runId, nodeId: runId ? `node:${runId}:root` : null, providerTurnId: null, ordinal: thread.turnItems.length + 1, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at };
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
   * A message arrives on a thread, as T3 handles it: steered into the active run when asked and that run is running;
   * otherwise it gets a run of its own, started now or queued behind the active one. Returns whether it was steered.
   */
  private dispatchMessage(
    thread: FakeThread,
    message: { id: string; text: string; attachments: T3MessageAttachment[]; createdBy: T3Message["createdBy"]; creationSource: string; senderThreadId?: string },
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
    if (mode.type === "steer" && active && active.id === mode.runId && active.status === "running") {
      record(active.id, "steer");
      return true;
    }
    const ordinal = thread.runs.length + 1;
    const run: T3Run = {
      id: `run:thread:${thread.shell.id}:ordinal:${ordinal}`,
      threadId: thread.shell.id,
      ordinal,
      userMessageId: message.id,
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
    record(run.id, active ? "queued_turn" : "turn_start");
    if (!active) this.startRun(thread, run);
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
      thread.turnItems.push({ ...this.item(thread, run.id, at), type: "error", message: this.startFailure, failureClass: "provider_error", retrying: false });
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
    if (this.options.autoCompleteMs !== null) {
      setTimeout(() => {
        if (this.activeRun(thread)?.id === run.id && !this.held.has(thread.shell.id)) this.completeRun(thread.shell.id, this.options.autoReply({ threadId: thread.shell.id, text: this.runPrompts.get(run.id) ?? "" }));
      }, this.options.autoCompleteMs);
    }
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
    if (outcome === "error") thread.turnItems.push({ ...this.item(thread, run.id, this.stamp(thread)), type: "error", message: completion.text, failureClass: "provider_error", retrying: false });
    say(completion.text);
    const at = this.stamp(thread);
    const checkpointId = `checkpoint:${run.id}`;
    const files = completion.files ?? [];
    thread.checkpoints.push({ id: checkpointId, runId: run.id, status: outcome === "error" ? "error" : "ready", files, capturedAt: at });
    thread.turnItems.push({ ...this.item(thread, run.id, at), type: "checkpoint", checkpointId, files });
    run.status = outcome === "error" ? "failed" : outcome;
    run.completedAt = at;
    run.checkpointId = checkpointId;
    for (const turn of thread.providerTurns) if (turn.status === "running") Object.assign(turn, { status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "interrupted", completedAt: at });
    // A request the run ended with is no longer waiting.
    for (const request of thread.runtimeRequests) if (request.status === "pending" && request.runId === run.id && request.responseMode !== "message") Object.assign(request, { status: "cancelled", resolvedAt: at });
    Object.assign(thread.shell, { status: run.status, activeRunId: null, latestRunCompletedAt: at, lastError: outcome === "error" ? completion.text : null, pendingRequest: this.shellRequest(thread) });
    const next = thread.runs.find((queued) => queued.status === "queued");
    if (next) this.startRun(thread, next);
  }

  /** What the shell says is waiting, as the adapter reads T3's: a pending request, while a run is in progress. */
  private shellRequest(thread: FakeThread): T3ThreadShell["pendingRequest"] {
    const pending = openRequests(thread)[0];
    return pending ? { id: pending.id, kind: pending.kind, createdAt: pending.createdAt } : null;
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

  private raise(threadId: string, request: Pick<T3RuntimeRequest, "id" | "kind" | "type" | "responseMode" | "prompt" | "questions">): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const at = this.stamp(thread);
    const runId = this.activeRun(thread)?.id ?? null;
    thread.runtimeRequests.push({ ...request, status: "pending", runId, nodeId: `node:${request.id}`, createdAt: at, resolvedAt: null, options: null, decision: null, answers: null });
    if (request.type === "approval") thread.turnItems.push({ ...this.item(thread, runId, at), type: "approval_request", requestId: request.id, requestKind: request.kind, prompt: request.prompt, appName: null, options: null });
    else thread.turnItems.push({ ...this.item(thread, runId, at), type: "user_input_request", requestId: request.id, questions: request.questions, responseMode: request.responseMode === "message" ? "message" : null });
    thread.shell.pendingRequest = this.shellRequest(thread);
    return request.id;
  }

  /** Test control: raise a native approval request on the active run. */
  raiseApproval(threadId: string, requestId: string = randomUUID()): string {
    return this.raise(threadId, { id: requestId, kind: "command", type: "approval", responseMode: "live", prompt: "run tests", questions: [] });
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
