/**
 * HTTP adapter for a T3 Code server (contracts: packages/contracts/src/environmentHttp.ts).
 *
 * Dispatch:     POST /api/orchestration/dispatch  (ClientOrchestrationCommand -> { sequence })
 * Observation:  GET  /api/orchestration/shell     (lightweight projects + thread shells)
 *               GET  /api/orchestration/threads/:threadId[?turnLimit=N]
 * Discovery:    GET  /.well-known/t3/environment
 *
 * Observation is bounded polling of persisted read models, as the PRD allows. Turn correlation uses the
 * client-supplied messageId (user message -> turnId) and latestTurn/checkpoints on the thread.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSelection } from "../domain/types.ts";
import type {
  ThreadLifecycleAction,
  UsageBucket,
  UsageSummary,
  CatalogEntry,
  CreateProjectInput,
  CreateThreadInput,
  ModelOptionDescriptor,
  StartTurnInput,
  T3Adapter,
  T3Environment,
  T3Project,
  T3ProviderInfo,
  T3Ref,
  T3SessionStatus,
  T3ThreadDetail,
  T3ThreadShell,
} from "./types.ts";
import { T3CommandRejected, T3Unavailable } from "./types.ts";

export interface HttpAdapterOptions {
  baseUrl: string;
  accessToken: string | null;
  /** Local T3 userdata directory used as a catalog fallback when the server is local. */
  userDataDir?: string;
  fetchImpl?: typeof fetch;
  /** Reuse the shell snapshot for this many milliseconds between calls (one poll per scheduler tick). */
  shellCacheMs?: number;
}

interface ShellSnapshot {
  snapshotSequence: number;
  projects: Array<Record<string, unknown>>;
  threads: Array<Record<string, unknown>>;
}

/** Minimal typing of the parts of server.getConfig the room reads. */
interface ServerConfigLike {
  providers?: Array<{
    instanceId: string;
    driver?: string;
    displayName?: string;
    enabled?: boolean;
    installed?: boolean;
    status?: string;
    version?: string | null;
    message?: string;
    reportsContextWindow?: boolean;
    slashCommands?: Array<{ name: string; description?: string; input?: { hint?: string } }>;
    auth?: { status?: string; type?: string; label?: string };
    usageLimits?: { checkedAt?: string; windows?: Array<{ id: string; kind?: string; label?: string; usedPercent?: number; resetsAt?: string }> };
    models?: Array<{
      slug: string;
      name?: string;
      aliases?: string[];
      isDefault?: boolean;
      isLegacy?: boolean;
      isCustom?: boolean;
      optionDescriptors?: ModelOptionDescriptor[];
      capabilities?: { optionDescriptors?: ModelOptionDescriptor[] };
    }>;
  }>;
  settings?: {
    defaultModelSelection?: ModelSelection | null;
    providerInstances?: Record<string, { autoCompactWindow?: string | number }>;
  };
}

/** T3 stores the Claude auto-compact window as a string: "" or "auto" for the harness default, otherwise a token count. */
function parseAutoCompactWindow(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "auto") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export class HttpT3Adapter implements T3Adapter {
  readonly kind = "http" as const;
  private readonly baseUrl: string;
  private accessToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly userDataDir: string | undefined;
  private readonly shellCacheMs: number;
  private shellCache: { at: number; value: ShellSnapshot } | null = null;
  /** Archived threads come over the WebSocket RPC (one socket per read), so the sidebar's polls share a reading. */
  private archivedCache: { at: number; value: T3ThreadShell[] } | null = null;

  constructor(options: HttpAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userDataDir = options.userDataDir;
    this.shellCacheMs = options.shellCacheMs ?? 750;
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
    this.shellCache = null;
  }

  get hasCredentials(): boolean {
    return this.accessToken !== null;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new T3Unavailable(`cannot reach T3 at ${this.baseUrl}: ${(error as Error).message}`, error);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new T3Unavailable(`T3 rejected the credential (HTTP ${response.status}); re-pair the room service`);
    }
    if (response.status >= 500) {
      throw new T3Unavailable(`T3 returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep raw text
      }
      throw new T3CommandRejected(`T3 rejected ${method} ${path} with HTTP ${response.status}: ${text.slice(0, 400)}`, response.status, parsed);
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new T3Unavailable(`T3 returned a non-JSON response for ${path}`);
    }
  }

  async describe(): Promise<T3Environment> {
    const descriptor = (await this.request("GET", "/.well-known/t3/environment")) as {
      environmentId: string;
      label: string;
      serverVersion: string;
    };
    return { environmentId: descriptor.environmentId, label: descriptor.label, serverVersion: descriptor.serverVersion, baseUrl: this.baseUrl };
  }

  /** Auth descriptor and session state; used by the pairing UI to explain what the server allows. */
  async authSession(): Promise<{ authenticated: boolean; policy: string; bootstrapMethods: string[]; scopes?: string[]; expiresAt?: string }> {
    const state = (await this.request("GET", "/api/auth/session")) as {
      authenticated: boolean;
      auth: { policy: string; bootstrapMethods: string[] };
      scopes?: string[];
      expiresAt?: string;
    };
    return {
      authenticated: state.authenticated,
      policy: state.auth.policy,
      bootstrapMethods: state.auth.bootstrapMethods,
      ...(state.scopes ? { scopes: state.scopes } : {}),
      ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
    };
  }

  // ---------------- WebSocket RPC (Effect RPC, JSON frames) ----------------
  // Used for reads that have no HTTP route (server.getConfig). One short-lived socket per call, ticket-authenticated.

  private async rpc<T>(tag: string, payload: unknown, timeoutMs = 15000): Promise<T> {
    const ticket = (await this.request("POST", "/api/auth/websocket-ticket")) as { ticket: string };
    const url = new URL("/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    const SocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!SocketCtor) throw new T3Unavailable("WebSocket is not available in this runtime");
    return new Promise<T>((resolve, reject) => {
      const socket = new SocketCtor(url.toString());
      const timer = setTimeout(() => {
        socket.close();
        reject(new T3Unavailable(`T3 RPC ${tag} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      });
      socket.addEventListener("message", (event) => {
        let message: { _tag?: string; requestId?: string; exit?: { _tag: string; value?: unknown; cause?: unknown } };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message._tag !== "Exit" || message.requestId !== "1" || !message.exit) return;
        clearTimeout(timer);
        socket.close();
        if (message.exit._tag === "Success") resolve(message.exit.value as T);
        else reject(new T3CommandRejected(`T3 RPC ${tag} failed: ${JSON.stringify(message.exit.cause).slice(0, 300)}`, 500, message.exit));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new T3Unavailable(`T3 RPC ${tag}: websocket error`));
      });
    });
  }

  private configCache: { at: number; value: ServerConfigLike } | null = null;

  /** server.getConfig, cached briefly: the provider catalog with option descriptors, auth state, and usage limits. */
  async getServerConfig(maxAgeMs = 20000): Promise<ServerConfigLike> {
    if (this.configCache && Date.now() - this.configCache.at < maxAgeMs) return this.configCache.value;
    const value = await this.rpc<ServerConfigLike>("server.getConfig", {});
    this.configCache = { at: Date.now(), value };
    return value;
  }

  async listProviders(): Promise<T3ProviderInfo[]> {
    const config = await this.getServerConfig();
    return (config.providers ?? []).map((provider) => ({
      instanceId: provider.instanceId,
      displayName: provider.displayName ?? provider.instanceId,
      enabled: Boolean(provider.enabled),
      installed: Boolean(provider.installed),
      status: provider.status ?? "unknown",
      version: provider.version ?? null,
      authStatus: provider.auth?.status ?? null,
      authLabel: provider.auth?.label ?? provider.auth?.type ?? null,
      message: provider.message ?? null,
      usageWindows: (provider.usageLimits?.windows ?? []).map((window) => ({
        id: window.id,
        label: window.label ?? window.kind ?? window.id,
        usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : null,
        resetsAt: window.resetsAt ?? null,
      })),
      usageCheckedAt: provider.usageLimits?.checkedAt ?? null,
      reportsContextWindow: provider.reportsContextWindow === true,
      autoCompactWindow: parseAutoCompactWindow(config.settings?.providerInstances?.[provider.instanceId]?.autoCompactWindow),
      slashCommands: (provider.slashCommands ?? []).map((command) => ({
        name: command.name,
        description: command.description ?? null,
        hint: command.input?.hint ?? null,
      })),
    }));
  }

  private async shell(force = false): Promise<ShellSnapshot> {
    const now = Date.now();
    if (!force && this.shellCache && now - this.shellCache.at < this.shellCacheMs) return this.shellCache.value;
    const value = (await this.request("GET", "/api/orchestration/shell")) as ShellSnapshot;
    this.shellCache = { at: now, value };
    return value;
  }

  async listProjects(): Promise<T3Project[]> {
    const shell = await this.shell();
    return shell.projects.map((project) => ({
      id: project.id as string,
      title: project.title as string,
      workspaceRoot: project.workspaceRoot as string,
      defaultModelSelection: (project.defaultModelSelection as ModelSelection | null) ?? null,
      defaultThreadEnvMode: project.defaultThreadEnvMode === "worktree" || project.defaultThreadEnvMode === "local" ? project.defaultThreadEnvMode : null,
    }));
  }

  /**
   * The provider catalog as T3's own client sees it: server.getConfig over the WebSocket RPC, with every model's
   * option descriptors, defaults, and legacy flags for every enabled provider. Falls back to the local model manifest
   * and models observed on existing threads when the RPC is unavailable. Entries are labelled with their source.
   */
  async listCatalog(): Promise<CatalogEntry[]> {
    const entries = new Map<string, CatalogEntry>();
    const add = (entry: CatalogEntry) => {
      const key = `${entry.instanceId}::${entry.model}`;
      const existing = entries.get(key);
      if (!existing || entry.source === "server" || (entry.source === "manifest" && existing.source === "observed")) entries.set(key, entry);
    };
    try {
      const config = await this.getServerConfig();
      for (const provider of config.providers ?? []) {
        if (!provider.enabled) continue;
        for (const model of provider.models ?? []) {
          const descriptors = model.optionDescriptors ?? model.capabilities?.optionDescriptors;
          add({
            instanceId: provider.instanceId,
            model: model.slug,
            label: model.name ?? model.slug,
            providerName: provider.displayName ?? provider.instanceId,
            source: "server",
            ...(descriptors && descriptors.length > 0 ? { optionDescriptors: descriptors } : {}),
            ...(model.isDefault ? { isDefault: true } : {}),
            ...(model.isLegacy ? { isLegacy: true } : {}),
            ...(model.aliases && model.aliases.length > 0 ? { aliases: model.aliases } : {}),
          });
        }
      }
      if (entries.size > 0) return [...entries.values()];
    } catch {
      // Fall through to the local sources.
    }
    if (this.userDataDir) {
      try {
        const manifestPath = join(this.userDataDir, "model-manifest.json");
        const settingsPath = join(this.userDataDir, "settings.json");
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            manifest?: {
              currentModels?: Record<string, string[]>;
              providers?: Record<string, { profiles?: Record<string, { capabilities?: { optionDescriptors?: ModelOptionDescriptor[] } }> }>;
            };
          };
          const disabled = new Set<string>();
          if (existsSync(settingsPath)) {
            // providerInstances is the authoritative enable switch; the legacy `providers` map is ignored.
            const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
              providerInstances?: Record<string, { enabled?: boolean; driver?: string }>;
            };
            for (const [name, instance] of Object.entries(settings.providerInstances ?? {})) if (instance.enabled === false) disabled.add(name);
          }
          const profilesByProvider = manifest.manifest?.providers ?? {};
          for (const [instanceId, models] of Object.entries(manifest.manifest?.currentModels ?? {})) {
            if (disabled.has(instanceId)) continue;
            const profiles = profilesByProvider[instanceId]?.profiles ?? {};
            for (const model of models) {
              // Profiles are keyed by family ("fable-5", "opus-5-5", "sonnet-5"); pick the longest key the model id starts with
              // once the vendor prefix is stripped ("claude-fable-5-1" → "fable-5-1").
              const stripped = model.replace(/^claude-/, "");
              const profileKey = Object.keys(profiles)
                .filter((key) => stripped === key || stripped.startsWith(`${key}-`))
                .sort((a, b) => b.length - a.length)[0];
              const descriptors = profileKey ? profiles[profileKey]?.capabilities?.optionDescriptors : undefined;
              add({
                instanceId,
                model,
                label: `${model} (${instanceId})`,
                source: "manifest",
                ...(descriptors && descriptors.length > 0 ? { optionDescriptors: descriptors } : {}),
              });
            }
          }
        }
      } catch {
        // Manifest is a convenience; observed models still work.
      }
    }
    const shell = await this.shell();
    for (const thread of shell.threads) {
      const selection = thread.modelSelection as ModelSelection | undefined;
      if (selection?.instanceId && selection.model) {
        add({ instanceId: selection.instanceId, model: selection.model, label: `${selection.model} (${selection.instanceId})`, source: "observed" });
      }
    }
    return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private toShell(thread: Record<string, unknown>): T3ThreadShell {
    const session = thread.session as { status: T3SessionStatus; activeTurnId: string | null; lastError: string | null } | null;
    const latestTurn = thread.latestTurn as { turnId: string; state: "running" | "interrupted" | "completed" | "error"; requestedAt?: string | null; completedAt: string | null; assistantMessageId: string | null } | null;
    return {
      id: thread.id as string,
      projectId: thread.projectId as string,
      title: thread.title as string,
      modelSelection: thread.modelSelection as ModelSelection,
      runtimeMode: thread.runtimeMode as T3ThreadShell["runtimeMode"],
      interactionMode: (thread.interactionMode as T3ThreadShell["interactionMode"]) ?? "default",
      branch: (thread.branch as string | null) ?? null,
      worktreePath: (thread.worktreePath as string | null) ?? null,
      session: session ? { status: session.status, activeTurnId: session.activeTurnId ?? null, lastError: session.lastError ?? null } : null,
      latestTurn: latestTurn
        ? { turnId: latestTurn.turnId, state: latestTurn.state, requestedAt: latestTurn.requestedAt ?? null, completedAt: latestTurn.completedAt ?? null, assistantMessageId: latestTurn.assistantMessageId ?? null }
        : null,
      hasPendingApprovals: Boolean(thread.hasPendingApprovals),
      hasPendingUserInput: Boolean(thread.hasPendingUserInput),
      hasActionableProposedPlan: Boolean(thread.hasActionableProposedPlan),
      pullRequests: ((thread.pullRequests as Array<Record<string, unknown>> | undefined) ?? []).map((pr) => ({
        repository: String(pr.repository ?? ""),
        number: Number(pr.number ?? 0),
        url: String(pr.url ?? ""),
        source: (pr.source as string | undefined) ?? null,
        snapshot: pr.snapshot ?? null,
      })),
      linkedPullRequest: (thread.linkedPullRequest as { repository: string; number: number; url: string } | null | undefined) ?? null,
      planProgress: (thread.planProgress as { step: string; completedSteps: number; totalSteps: number } | null | undefined) ?? null,
      backgroundLiveness: (thread.backgroundLiveness as "working" | "monitoring" | null | undefined) ?? null,
      latestUserMessageAt: (thread.latestUserMessageAt as string | null | undefined) ?? null,
      settledAt: (thread.settledAt as string | null | undefined) ?? null,
      archivedAt: (thread.archivedAt as string | null) ?? null,
      deletedAt: (thread.deletedAt as string | null) ?? null,
      updatedAt: thread.updatedAt as string,
    };
  }

  async listThreads(projectId?: string): Promise<T3ThreadShell[]> {
    const shell = await this.shell();
    return shell.threads
      .map((thread) => this.toShell(thread))
      .filter((thread) => thread.deletedAt === null && (!projectId || thread.projectId === projectId));
  }

  async getThreadShell(threadId: string): Promise<T3ThreadShell | null> {
    const shell = await this.shell();
    const found = shell.threads.find((thread) => thread.id === threadId);
    return found ? this.toShell(found) : null;
  }

  async getThreadDetail(threadId: string, options: { turnLimit?: number } = {}): Promise<T3ThreadDetail | null> {
    const query = options.turnLimit ? `?turnLimit=${options.turnLimit}` : "";
    let detail: { thread: Record<string, unknown> };
    try {
      detail = (await this.request("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`)) as { thread: Record<string, unknown> };
    } catch (error) {
      if (error instanceof T3CommandRejected && error.status === 404) return null;
      throw error;
    }
    const thread = detail.thread;
    const shell = this.toShell({ ...thread, hasPendingApprovals: false, hasPendingUserInput: false });
    const activities = (thread.activities as Array<Record<string, unknown>>) ?? [];
    const pendingApprovals = new Set<string>();
    const pendingInputs = new Set<string>();
    for (const activity of activities) {
      const payload = activity.payload as { requestId?: string } | undefined;
      const requestId = payload?.requestId;
      if (!requestId) continue;
      if (activity.kind === "approval.requested") pendingApprovals.add(requestId);
      if (activity.kind === "approval.resolved") pendingApprovals.delete(requestId);
      if (activity.kind === "user-input.requested") pendingInputs.add(requestId);
      if (activity.kind === "user-input.resolved") pendingInputs.delete(requestId);
    }
    shell.hasPendingApprovals = pendingApprovals.size > 0;
    shell.hasPendingUserInput = pendingInputs.size > 0;
    return {
      shell,
      messages: ((thread.messages as Array<Record<string, unknown>>) ?? []).map((message) => ({
        id: message.id as string,
        role: message.role as "user" | "assistant" | "system" | "reasoning",
        text: (message.text as string) ?? "",
        turnId: (message.turnId as string | null) ?? null,
        streaming: Boolean(message.streaming),
        createdAt: message.createdAt as string,
        attachments: ((message.attachments as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((a) => a.type === "image" && typeof a.id === "string")
          .map((a) => ({ id: a.id as string, name: (a.name as string) ?? "image", mimeType: (a.mimeType as string) ?? "image/png", sizeBytes: Number(a.sizeBytes ?? 0) })),
      })),
      activities: activities.map((activity) => ({
        id: activity.id as string,
        tone: activity.tone as "info" | "tool" | "approval" | "error",
        kind: activity.kind as string,
        summary: activity.summary as string,
        payload: activity.payload,
        turnId: (activity.turnId as string | null) ?? null,
        createdAt: activity.createdAt as string,
      })),
      checkpoints: ((thread.checkpoints as Array<Record<string, unknown>>) ?? []).map((checkpoint) => ({
        turnId: checkpoint.turnId as string,
        status: checkpoint.status as "ready" | "missing" | "error",
        files: (checkpoint.files as Array<{ path: string; kind: string; additions: number; deletions: number }>) ?? [],
        assistantMessageId: (checkpoint.assistantMessageId as string | null) ?? null,
        completedAt: checkpoint.completedAt as string,
      })),
      proposedPlans: ((thread.proposedPlans as Array<Record<string, unknown>> | undefined) ?? []).map((plan) => ({
        id: plan.id as string,
        turnId: (plan.turnId as string | null) ?? null,
        planMarkdown: (plan.planMarkdown as string) ?? "",
        implementedAt: (plan.implementedAt as string | null) ?? null,
        createdAt: plan.createdAt as string,
      })),
    };
  }

  private async dispatch(command: Record<string, unknown>): Promise<void> {
    await this.request("POST", "/api/orchestration/dispatch", command);
    this.shellCache = null;
    this.archivedCache = null;
  }

  async listArchivedThreads(): Promise<T3ThreadShell[]> {
    if (this.archivedCache && Date.now() - this.archivedCache.at < 20_000) return this.archivedCache.value;
    const snapshot = await this.rpc<ShellSnapshot>("orchestration.getArchivedShellSnapshot", {});
    const value = snapshot.threads.map((thread) => this.toShell(thread)).filter((thread) => thread.deletedAt === null);
    this.archivedCache = { at: Date.now(), value };
    return value;
  }

  async defaultModelSelection(projectId: string): Promise<ModelSelection | null> {
    const project = (await this.listProjects()).find((p) => p.id === projectId);
    if (project?.defaultModelSelection) return project.defaultModelSelection;
    try {
      const config = await this.getServerConfig();
      return config.settings?.defaultModelSelection ?? null;
    } catch {
      return null;
    }
  }

  async setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void> {
    await this.dispatch({
      type: "thread.meta.update",
      commandId: input.commandId,
      threadId: input.threadId,
      modelSelection: input.modelSelection,
    });
  }

  async createProject(input: CreateProjectInput): Promise<void> {
    await this.dispatch({
      type: "project.create",
      commandId: input.commandId,
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: input.createIfMissing,
      createdAt: new Date().toISOString(),
    });
  }

  async createThread(input: CreateThreadInput): Promise<void> {
    await this.dispatch({
      type: "thread.create",
      commandId: input.commandId,
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async listRefs(cwd: string): Promise<{ isRepo: boolean; refs: T3Ref[] }> {
    const value = await this.rpc<{ isRepo: boolean; refs: Array<{ name: string; isRemote?: boolean; current: boolean; isDefault: boolean; worktreePath: string | null }> }>("vcs.listRefs", { cwd, limit: 200 });
    return { isRepo: value.isRepo, refs: value.refs.map((ref) => ({ name: ref.name, isRemote: ref.isRemote === true, current: ref.current, isDefault: ref.isDefault, worktreePath: ref.worktreePath ?? null })) };
  }

  async createWorktree(input: { cwd: string; baseBranch: string; branch: string }): Promise<{ path: string; branch: string }> {
    // Checking out a large repository takes a while; T3 answers when the worktree is ready.
    const value = await this.rpc<{ worktree: { path: string; refName: string } }>(
      "vcs.createWorktree",
      { cwd: input.cwd, refName: input.baseBranch, newRefName: input.branch, baseRefName: input.baseBranch, path: null },
      300_000,
    );
    return { path: value.worktree.path, branch: value.worktree.refName };
  }

  async removeWorktree(input: { cwd: string; path: string }): Promise<void> {
    await this.rpc("vcs.removeWorktree", { cwd: input.cwd, path: input.path, force: true }, 60_000);
  }

  async startTurn(input: StartTurnInput): Promise<void> {
    await this.dispatch({
      type: "thread.turn.start",
      commandId: input.commandId,
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: input.text,
        attachments: (input.images ?? []).map((image) => ({ type: "image", ...image })),
      },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed ? { titleSeed: input.titleSeed } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  async interruptTurn(input: { commandId: string; threadId: string; turnId: string | null }): Promise<void> {
    await this.dispatch({
      type: "thread.turn.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  async respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: string }): Promise<void> {
    await this.dispatch({
      type: "thread.approval.respond",
      commandId: input.commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      createdAt: new Date().toISOString(),
    });
  }

  async respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void> {
    await this.dispatch({
      type: "thread.user-input.respond",
      commandId: input.commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      createdAt: new Date().toISOString(),
    });
  }

  async setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: T3ThreadShell["runtimeMode"] }): Promise<void> {
    await this.dispatch({
      type: "thread.runtime-mode.set",
      commandId: input.commandId,
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt: new Date().toISOString(),
    });
  }

  async setThreadLifecycle(input: { commandId: string; threadId: string; action: ThreadLifecycleAction }): Promise<void> {
    // T3 records who unsettled a thread; from a client it is always the user.
    await this.dispatch({ type: `thread.${input.action}`, commandId: input.commandId, threadId: input.threadId, ...(input.action === "unsettle" ? { reason: "user" } : {}) });
  }

  private usageMemo = new Map<string, { at: number; value: UsageSummary }>();

  /** Cached for a minute: T3 scans transcripts to answer. */
  async usageSummary(input: { day: string; timeZone: string }): Promise<UsageSummary> {
    const key = `${input.day}|${input.timeZone}`;
    const memo = this.usageMemo.get(key);
    if (memo && Date.now() - memo.at < 60_000) return memo.value;
    const raw = await this.rpc<{ readAt: string; buckets: UsageBucket[]; pricing?: UsageSummary["pricing"] }>(
      "server.getUsageSummary",
      { sinceDay: input.day, untilDay: input.day, timeZone: input.timeZone },
      30_000,
    );
    const value: UsageSummary = { readAt: raw.readAt, buckets: raw.buckets ?? [], pricing: raw.pricing ?? null };
    this.usageMemo.set(key, { at: Date.now(), value });
    return value;
  }
}
