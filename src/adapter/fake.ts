/**
 * In-memory T3 stand-in for tests and demo mode. Mimics the observed T3 lifecycle:
 * turn-start -> session running with activeTurnId -> assistant message (streaming false)
 * -> session ready with activeTurnId null -> latestTurn.state completed/error/interrupted.
 */
import { randomUUID } from "node:crypto";
import type { ModelSelection } from "../domain/types.ts";
import type {
  ThreadLifecycleAction,
  CatalogEntry,
  CreateProjectInput,
  CreateThreadInput,
  StartTurnInput,
  T3Activity,
  T3Adapter,
  T3Checkpoint,
  T3Environment,
  T3Message,
  T3Project,
  T3ProviderInfo,
  T3ThreadDetail,
  T3ThreadShell,
} from "./types.ts";
import { T3CommandRejected } from "./types.ts";

interface FakeThread {
  shell: T3ThreadShell;
  messages: T3Message[];
  activities: T3Activity[];
  checkpoints: T3Checkpoint[];
  proposedPlans: T3ThreadDetail["proposedPlans"];
  /** messageId -> turnId once the provider "started" the turn. */
  turnByMessage: Map<string, string>;
}

export interface FakeTurnCompletion {
  text: string;
  /** Messages the agent wrote earlier in the turn, before its final one. */
  progress?: string[];
  /** Like T3, attach the checkpoint to the progress message the file changes belong to (index into progress). */
  checkpointOnProgress?: number;
  outcome?: "completed" | "error" | "interrupted";
  files?: Array<{ path: string; kind: string; additions: number; deletions: number }>;
}

export interface FakeAdapterOptions {
  /** Automatically complete turns after this many milliseconds. Null means manual completion. */
  autoCompleteMs?: number | null;
  autoReply?: (input: StartTurnInput) => FakeTurnCompletion;
  /**
   * What a turn start does while a turn runs. "steer" (Cursor, Grok): joins the running turn. "new-turn" (Claude, as
   * observed live): gets its own turn, requested now and started when the running one ends.
   */
  midTurn?: "steer" | "new-turn";
}

export class FakeT3Adapter implements T3Adapter {
  readonly kind = "fake" as const;
  readonly threads = new Map<string, FakeThread>();
  readonly projects: T3Project[] = [
    { id: "project_demo", title: "demo", workspaceRoot: "/tmp/demo", defaultModelSelection: null },
  ];
  readonly commands: Array<{ type: string; commandId: string; threadId: string; payload: unknown }> = [];
  /** Test control: when set, listThreads returns this stale copy (T3's list read lagging behind the detail read). */
  staleShellList: T3ThreadShell[] | null = null;
  /** Turn starts that arrived while a turn was running and were steered into it. Queue-mode tests expect zero. */
  steeredMessages = 0;
  /** "new-turn" mode: turns requested mid-turn, started in order as the running one ends. */
  private readonly queuedTurns = new Map<string, Array<{ turnId: string; requestedAt: string }>>();
  private readonly seenCommands = new Set<string>();
  /** Simulated outage: every call throws until cleared. */
  outage: Error | null = null;
  /** When set, dispatched commands are dropped after being recorded (ack lost) to test reconciliation. */
  dropAcks = false;
  /** When set, T3 records the user message but the provider fails to start the turn with this error. */
  startFailure: string | null = null;
  private readonly options: Required<FakeAdapterOptions>;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = {
      midTurn: options.midTurn ?? "steer",
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

  async describe(): Promise<T3Environment> {
    this.guard();
    return { environmentId: "env_fake", label: "fake", serverVersion: "0.0.0-fake", baseUrl: "fake://" };
  }

  async listProjects(): Promise<T3Project[]> {
    this.guard();
    return [...this.projects];
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

  async listThreads(projectId?: string): Promise<T3ThreadShell[]> {
    this.guard();
    if (this.staleShellList) return this.staleShellList.filter((t) => !projectId || t.projectId === projectId);
    // Like T3's shell snapshot: archived threads are not listed.
    return [...this.threads.values()].map((t) => t.shell).filter((t) => t.archivedAt === null && (!projectId || t.projectId === projectId));
  }

  async listArchivedThreads(): Promise<T3ThreadShell[]> {
    this.guard();
    return [...this.threads.values()].map((t) => t.shell).filter((t) => t.archivedAt !== null);
  }

  async getThreadShell(threadId: string): Promise<T3ThreadShell | null> {
    this.guard();
    const shell = this.threads.get(threadId)?.shell;
    return shell && shell.archivedAt === null ? shell : null;
  }

  async getThreadDetail(threadId: string): Promise<T3ThreadDetail | null> {
    this.guard();
    const thread = this.threads.get(threadId);
    // T3 reads threads by id only while they are not archived.
    if (!thread || thread.shell.archivedAt !== null) return null;
    return {
      shell: structuredClone(thread.shell),
      messages: structuredClone(thread.messages),
      activities: structuredClone(thread.activities),
      checkpoints: structuredClone(thread.checkpoints),
      proposedPlans: structuredClone(thread.proposedPlans),
    };
  }

  private record(type: string, commandId: string, threadId: string, payload: unknown): boolean {
    this.guard();
    this.commands.push({ type, commandId, threadId, payload });
    if (this.seenCommands.has(commandId)) return false; // idempotent replay
    this.seenCommands.add(commandId);
    return true;
  }

  async defaultModelSelection(): Promise<ModelSelection | null> {
    this.guard();
    return { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "medium" }] };
  }

  async setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void> {
    if (!this.record("thread.meta.update", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    thread.shell.modelSelection = input.modelSelection;
    thread.shell.updatedAt = new Date().toISOString();
  }

  async createThread(input: CreateThreadInput): Promise<void> {
    if (!this.record("thread.create", input.commandId, input.threadId, input)) return;
    if (this.threads.has(input.threadId)) throw new T3CommandRejected("thread already exists", 409, null);
    const now = new Date().toISOString();
    this.threads.set(input.threadId, {
      shell: {
        id: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        session: null,
        latestTurn: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        pullRequests: [],
        linkedPullRequest: null,
        planProgress: null,
        backgroundLiveness: null,
        latestUserMessageAt: null,
        settledAt: null,
        archivedAt: null,
        deletedAt: null,
        updatedAt: now,
      },
      messages: [],
      activities: [],
      checkpoints: [],
      proposedPlans: [],
      turnByMessage: new Map(),
    });
    if (this.dropAcks) throw new Error("simulated lost acknowledgement");
  }

  async startTurn(input: StartTurnInput): Promise<void> {
    if (!this.record("thread.turn.start", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected(`thread ${input.threadId} does not exist`, 404, null);
    if (thread.shell.session?.status === "running" && thread.shell.session.activeTurnId) {
      const at = new Date().toISOString();
      thread.messages.push({ id: input.messageId, role: "user", text: input.text, turnId: null, streaming: false, createdAt: at });
      thread.shell.latestUserMessageAt = at;
      if ((this.options.midTurn ?? "steer") === "steer") {
        // Like T3's Cursor/Grok adapters: steered into the running turn (same turn id).
        this.steeredMessages += 1;
        thread.turnByMessage.set(input.messageId, thread.shell.session.activeTurnId);
      } else {
        // Like Claude as observed: its own turn, requested now (requestedAt = message createdAt), started when the
        // running turn ends. Only latestTurn is visible in T3, so it replaces the running turn there right away.
        const queuedTurnId = randomUUID();
        this.queuedTurns.set(input.threadId, [...(this.queuedTurns.get(input.threadId) ?? []), { turnId: queuedTurnId, requestedAt: at }]);
        thread.turnByMessage.set(input.messageId, queuedTurnId);
        thread.shell.latestTurn = { turnId: queuedTurnId, state: "running", requestedAt: at, completedAt: null, assistantMessageId: null };
      }
      return;
    }
    const turnId = randomUUID();
    const now = new Date().toISOString();
    if (this.startFailure) {
      thread.messages.push({ id: input.messageId, role: "user", text: input.text, turnId: null, streaming: false, createdAt: now });
      thread.shell.session = { status: "error", activeTurnId: null, lastError: this.startFailure };
      thread.activities.push({ id: randomUUID(), tone: "error", kind: "provider.turn.start.failed", summary: this.startFailure, payload: {}, turnId: null, createdAt: now });
      return;
    }
    // Like T3, the user message never carries the turn id; only the session and provider messages do.
    thread.messages.push({ id: input.messageId, role: "user", text: input.text, turnId: null, streaming: false, createdAt: now });
    thread.turnByMessage.set(input.messageId, turnId);
    thread.shell.latestUserMessageAt = now;
    // Simulated tool activity and a context-window reading so the desk panels have data in demo mode.
    const used = 12000 + thread.messages.length * 3500;
    thread.activities.push(
      { id: randomUUID(), tone: "tool", kind: "tool.started", summary: "Reading files", payload: { itemType: "file_read", status: "inProgress", title: "Read", detail: "src/index.ts" }, turnId, createdAt: now },
      { id: randomUUID(), tone: "tool", kind: "tool.completed", summary: "Read src/index.ts", payload: { itemType: "file_read", status: "completed", title: "Read", detail: "src/index.ts" }, turnId, createdAt: now },
      { id: randomUUID(), tone: "info", kind: "context-window.updated", summary: "Context window updated", payload: { usedTokens: used, lastUsedTokens: used, totalProcessedTokens: used * 2, inputTokens: used - 400, outputTokens: 400, maxTokens: 200000 }, turnId, createdAt: now },
    );
    thread.shell.session = { status: "running", activeTurnId: turnId, lastError: null };
    thread.shell.latestTurn = { turnId, state: "running", requestedAt: now, completedAt: null, assistantMessageId: null };
    thread.shell.updatedAt = now;
    if (this.dropAcks) throw new Error("simulated lost acknowledgement");
    if (this.options.autoCompleteMs !== null) {
      const delay = this.options.autoCompleteMs;
      setTimeout(() => {
        if (thread.shell.session?.activeTurnId === turnId) this.completeTurn(input.threadId, this.options.autoReply(input));
      }, delay);
    }
  }

  /** Test control: finish the active turn on a thread. */
  completeTurn(threadId: string, completion: FakeTurnCompletion): void {
    const thread = this.threads.get(threadId);
    if (!thread || !thread.shell.session?.activeTurnId) throw new Error("no active turn to complete");
    const turnId = thread.shell.session.activeTurnId;
    const outcome = completion.outcome ?? "completed";
    const now = new Date().toISOString();
    const progressIds: string[] = [];
    for (const note of completion.progress ?? []) {
      const id = `assistant:${randomUUID()}`;
      progressIds.push(id);
      thread.messages.push({ id, role: "assistant", text: note, turnId, streaming: false, createdAt: now });
    }
    const finalMessageId = `assistant:${randomUUID()}`;
    const assistantMessageId = completion.checkpointOnProgress !== undefined ? (progressIds[completion.checkpointOnProgress] ?? finalMessageId) : finalMessageId;
    thread.messages.push({ id: finalMessageId, role: "assistant", text: completion.text, turnId, streaming: false, createdAt: now });
    thread.shell.session = { status: outcome === "error" ? "error" : "ready", activeTurnId: null, lastError: outcome === "error" ? completion.text : null };
    thread.shell.latestTurn = { turnId, state: outcome, requestedAt: thread.shell.latestTurn?.turnId === turnId ? thread.shell.latestTurn.requestedAt : null, completedAt: now, assistantMessageId };
    thread.checkpoints.push({ turnId, status: outcome === "error" ? "error" : "ready", files: completion.files ?? [], assistantMessageId, completedAt: now });
    thread.activities.push({ id: randomUUID(), tone: "info", kind: "checkpoint.captured", summary: `Checkpoint ${thread.checkpoints.length}`, payload: { turnCount: thread.checkpoints.length, status: outcome === "error" ? "error" : "ready" }, turnId, createdAt: now });
    thread.shell.hasPendingApprovals = false;
    thread.shell.hasPendingUserInput = false;
    thread.shell.updatedAt = now;
    const next = this.queuedTurns.get(threadId)?.shift();
    if (next) {
      thread.shell.session = { status: "running", activeTurnId: next.turnId, lastError: null };
      thread.shell.latestTurn = { turnId: next.turnId, state: "running", requestedAt: next.requestedAt, completedAt: null, assistantMessageId: null };
    }
  }

  /** Test control: a message the user types in T3 into the running turn (Claude delivers it inside that turn). */
  sendUserMessage(threadId: string, text: string, attachments: T3Message["attachments"] = []): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    if (!thread.shell.session?.activeTurnId) throw new Error("no active turn");
    const id = `user:${randomUUID()}`;
    const at = new Date().toISOString();
    thread.messages.push({ id, role: "user", text, turnId: null, streaming: false, createdAt: at, attachments });
    thread.shell.latestUserMessageAt = at;
    thread.shell.updatedAt = at;
    return id;
  }

  /** Test control: a turn the agent starts itself, with no user message (e.g. a background task finished). */
  startSelfTurn(threadId: string): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const turnId = randomUUID();
    const now = new Date().toISOString();
    thread.shell.session = { status: "running", activeTurnId: turnId, lastError: null };
    thread.shell.latestTurn = { turnId, state: "running", requestedAt: now, completedAt: null, assistantMessageId: null };
    return turnId;
  }

  /** Test control: simulate a turn started directly in T3 (not by the room). */
  startExternalTurn(threadId: string, text = "external prompt"): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    const turnId = randomUUID();
    const now = new Date().toISOString();
    thread.messages.push({ id: `user:${randomUUID()}`, role: "user", text, turnId, streaming: false, createdAt: now });
    thread.shell.session = { status: "running", activeTurnId: turnId, lastError: null };
    thread.shell.latestTurn = { turnId, state: "running", requestedAt: now, completedAt: null, assistantMessageId: null };
    return turnId;
  }

  /** Test control: raise a native approval request on the active turn. */
  raiseApproval(threadId: string, requestId = randomUUID()): string {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("unknown thread");
    thread.shell.hasPendingApprovals = true;
    thread.activities.push({
      id: randomUUID(),
      tone: "approval",
      kind: "approval.requested",
      summary: "Approval requested",
      payload: { requestId, requestType: "command", detail: "run tests" },
      turnId: thread.shell.session?.activeTurnId ?? null,
      createdAt: new Date().toISOString(),
    });
    return requestId;
  }

  async interruptTurn(input: { commandId: string; threadId: string; turnId: string | null }): Promise<void> {
    if (!this.record("thread.turn.interrupt", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    if (thread.shell.session?.activeTurnId && (!input.turnId || input.turnId === thread.shell.session.activeTurnId)) {
      this.completeTurn(input.threadId, { text: "(interrupted)", outcome: "interrupted" });
    }
  }

  async respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: string }): Promise<void> {
    if (!this.record("thread.approval.respond", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    thread.shell.hasPendingApprovals = false;
    thread.activities.push({
      id: randomUUID(),
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      payload: { requestId: input.requestId, decision: input.decision },
      turnId: thread.shell.session?.activeTurnId ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void> {
    if (!this.record("thread.user-input.respond", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    thread.shell.hasPendingUserInput = false;
  }

  async setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: T3ThreadShell["runtimeMode"] }): Promise<void> {
    if (!this.record("thread.runtime-mode.set", input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    thread.shell.runtimeMode = input.runtimeMode;
  }

  async setThreadLifecycle(input: { commandId: string; threadId: string; action: ThreadLifecycleAction }): Promise<void> {
    if (!this.record(`thread.${input.action}`, input.commandId, input.threadId, input)) return;
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new T3CommandRejected("unknown thread", 404, null);
    const at = new Date().toISOString();
    if (input.action === "delete") this.threads.delete(input.threadId);
    else if (input.action === "archive") thread.shell.archivedAt = at;
    else if (input.action === "unarchive") thread.shell.archivedAt = null;
    else if (input.action === "settle") thread.shell.settledAt = at;
    else thread.shell.settledAt = null;
  }
}
