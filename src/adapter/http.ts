/**
 * HTTP and WebSocket adapter for a T3 Code server speaking orchestration protocol 2 (Orchestrator V2; contracts:
 * packages/contracts/src/orchestrationV2.ts, rpc.ts, environmentHttp.ts).
 *
 * Reads:     orchestration.subscribeShell, subscribeArchivedShell   projects, thread shells, archived thread shells, as
 *              (WebSocket RPC streams, src/adapter/shellFeed.ts)   T3 streams them, once the feed is started
 *            GET /api/orchestration/shell                   the same while the feed is not live (archived thread
 *            orchestration.getArchivedShellSnapshot         shells over the RPC: T3's HTTP shell lists none)
 *            orchestration.subscribeThread (on the feed's   a watched thread's changes, each read once with the GET
 *              socket, src/adapter/threadFeed.ts)            below and shared until its next change
 *            GET /api/orchestration/threads/:id[/bounded]   a thread's projection: runs, messages, items, requests
 *            GET /.well-known/t3/environment                the server and its protocol version
 * Commands:  orchestration.dispatchCommand (WebSocket RPC)  message.dispatch, run.interrupt, runtime-request.respond, thread.*
 *            orchestration.launchThread                     a thread with its workspace, optionally started
 *            projects.mutate, assets.persistChatAttachments, vcs.*, filesystem.browse, server.*
 *
 * Every request names the protocol (x-t3-orchestration-protocol header, orchestrationProtocol on the socket). A server
 * on another protocol is reported as T3ProtocolMismatch; only server.* calls are still made to it, so it can be
 * updated from here. A run is found by the id of the user message that started it: T3 records it on the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSelection } from "../domain/types.ts";
import { ShellFeed, type FeedConnection, type ShellSnapshot } from "./shellFeed.ts";
import { ThreadFeed, type ThreadSnapshot } from "./threadFeed.ts";
import type {
  ThreadControl,
  T3PullRequestChecks,
  T3PullRequestWatch,
  ApprovalDecision,
  ThreadLifecycleAction,
  UsageBucket,
  UsageSummary,
  CatalogEntry,
  ClientActivity,
  CreateProjectInput,
  FolderListing,
  LaunchThreadInput,
  ModelOptionDescriptor,
  SecretAnswer,
  SecretRefusal,
  SendMessageInput,
  T3Adapter,
  T3ApprovalOption,
  T3BackgroundTask,
  T3Checkpoint,
  T3CheckpointFile,
  T3Environment,
  T3HarnessUpdateState,
  T3Message,
  T3MessageAttachment,
  T3Plan,
  T3Project,
  T3ProviderInfo,
  T3ProviderThread,
  T3ProviderTurn,
  T3Ref,
  T3Run,
  T3RunStatus,
  T3RuntimeRequest,
  T3RuntimeRequestKind,
  T3ShellChange,
  T3ShellFeedStatus,
  T3Subagent,
  T3ThreadDetail,
  T3ThreadShell,
  T3ThreadStatus,
  T3TokenUsage,
  T3TurnItem,
  T3UserInputQuestion,
  T3Versions,
  TurnImage,
} from "./types.ts";
import { CONTINUE_TEXT, STOP_EVERYTHING_REASON, ORCHESTRATION_PROTOCOL_VERSION, SECRET_REFUSALS, T3CommandRejected, T3OutcomeUnknown, T3ProtocolMismatch, T3ScopeMissing, T3SecretRefused, T3Unavailable, isRunActive, openRequests, pullRequestWatchTaskId, recoveryFor, secretRequests, usageLimitOf } from "./types.ts";
import { missingScopeMessage } from "./auth.ts";

export interface HttpAdapterOptions {
  baseUrl: string;
  accessToken: string | null;
  /** Local T3 userdata directory used as a catalog fallback when the server is local. */
  userDataDir?: string;
  fetchImpl?: typeof fetch;
  /** The WebSocket to open RPC connections with (the runtime's own by default). */
  webSocketImpl?: new (url: string) => WebSocketLike;
  /** Reuse the shell snapshot for this many milliseconds between calls (one poll per scheduler tick). */
  shellCacheMs?: number;
  /** How long a read waits for T3 to answer (a dispatch waits twice as long). Default 30s. */
  requestTimeoutMs?: number;
  /** How often a launched thread's worktree is looked for while T3 makes it. Default 500ms. */
  worktreePollMs?: number;
  /** How long the shared command socket stays open after its last call has been answered. Default 30s. */
  commandLinkIdleMs?: number;
  /** T3 refused the credential (HTTP 401/403); called with the token the request carried. */
  onCredentialRejected?: (token: string | null) => void;
  /** The shell feed's timings (src/adapter/shellFeed.ts): its ping interval and reconnect backoff. */
  feed?: { pingMs?: number; retryMs?: number; retryMaxMs?: number };
  /** The thread feed's timings (src/adapter/threadFeed.ts): its read throttle, leases, and retries of a refused stream. */
  threads?: { throttleMs?: number; leaseMs?: number; lingerMs?: number; retryMs?: number; retryMaxMs?: number };
  log?: (message: string, detail?: unknown) => void;
}

/**
 * After a command, how long shell reads wait at most for the feed to show T3's sequence for it (the HTTP snapshot
 * serves them meanwhile). T3 streams a change within some 50 ms; one whose last event no shell shows never reaches it.
 */
const FEED_CATCH_UP_MS = 1_000;

/** Minimal typing of the parts of server.getConfig the room reads. */
interface ServerConfigLike {
  environment?: {
    serverVersion?: string;
    capabilities?: { serverSelfUpdate?: string; desktopAppUpdate?: boolean; serverUpdateThreadContinuation?: boolean };
  };
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
    versionAdvisory?: {
      status?: string;
      currentVersion?: string | null;
      latestVersion?: string | null;
      updateCommand?: string | null;
      canUpdate?: boolean;
      checkedAt?: string | null;
      message?: string | null;
    };
    compatibilityAdvisory?: { latestVersionStatus?: string; message?: string | null };
    updateState?: T3HarnessUpdateState;
    models?: Array<{
      slug: string;
      name?: string;
      aliases?: string[];
      isDefault?: boolean;
      isLegacy?: boolean;
      isCustom?: boolean;
      badge?: string;
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

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

type RpcExit = { _tag: string; value?: unknown; cause?: unknown };

/** What T3 says went wrong, from an RPC failure's cause (a list of failures, each with T3's error and its message). */
/** The permission an HTTP 403 from T3 names (its EnvironmentScopeRequiredError), else null. */
function requiredScopeOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { requiredPermission?: unknown; requiredScope?: unknown };
    const scope = body.requiredPermission ?? body.requiredScope;
    return typeof scope === "string" && scope.length > 0 ? scope : null;
  } catch {
    return null;
  }
}

/** The permission T3 says the token lacks when it refuses a call for it (its EnvironmentAuthorizationError), else null. */
function missingPermission(cause: unknown): string | null {
  for (const failure of Array.isArray(cause) ? cause : [cause]) {
    const error = (failure as { error?: { _tag?: unknown; requiredPermission?: unknown; requiredScope?: unknown } } | null)?.error;
    if (error?._tag !== "EnvironmentAuthorizationError") continue;
    // requiredScope is the permission's legacy parent (orchestration:read for filesystem:read), kept for older clients.
    const scope = error.requiredPermission ?? error.requiredScope;
    if (typeof scope === "string" && scope.length > 0) return scope;
  }
  return null;
}

/** Why T3 refused a secret answer: its SecretRequestError crosses the wire as its tag and reason, with no message. */
function secretRefusal(cause: unknown): SecretRefusal | null {
  for (const failure of Array.isArray(cause) ? cause : [cause]) {
    const error = (failure as { error?: { _tag?: unknown; reason?: unknown } } | null)?.error;
    if (error?._tag === "SecretRequestError" && typeof error.reason === "string" && Object.hasOwn(SECRET_REFUSALS, error.reason)) return error.reason as SecretRefusal;
  }
  return null;
}

/**
 * A failed secrets.answerRequest as an error that carries nothing of the call: the frame held the secret, and T3's own
 * failure (its cause, a decoding error) could echo it. Only T3's reason, a missing permission or an error's tag is kept.
 */
function secretFailure(error: unknown): Error {
  if (error instanceof T3ScopeMissing) return new T3ScopeMissing(error.scope, null);
  if (error instanceof T3CommandRejected) {
    const cause = (error.body as { cause?: unknown } | null)?.cause;
    const reason = secretRefusal(cause);
    if (reason) return new T3SecretRefused(reason);
    const tag = (Array.isArray(cause) ? cause : [cause]).map((failure) => (failure as { error?: { _tag?: unknown } } | null)?.error?._tag).find((t): t is string => typeof t === "string" && /^\w{1,60}$/.test(t));
    return new T3CommandRejected(`T3 refused the secret${tag ? ` (${tag})` : ""}; nothing was saved.`, 502, null);
  }
  if (error instanceof T3OutcomeUnknown || !(error instanceof T3Unavailable)) return new T3OutcomeUnknown("T3 did not confirm the secret; it may have been saved. Look at the request before you answer it again.");
  return new T3Unavailable("T3 is not answering; the secret was not sent.");
}

function rpcFailure(cause: unknown): string {
  const failures = Array.isArray(cause) ? cause : [cause];
  for (const failure of failures) {
    const error = (failure as { error?: { message?: unknown; detail?: unknown; _tag?: unknown } } | null)?.error;
    if (typeof error?.message === "string" && error.message.length > 0) return error.message;
    if (typeof error?.detail === "string" && error.detail.length > 0) return error.detail;
    if (typeof error?._tag === "string") return error._tag;
  }
  return JSON.stringify(cause ?? null).slice(0, 300);
}

/**
 * One socket to T3's WebSocket RPC (Effect RPC, JSON frames), for a single request or for several over time. Once it
 * closes or fails, every request still waiting fails and the connection is spent.
 *
 * A request is answered by one Exit frame. A stream (a subscription) is answered by Chunk frames, each carrying a list
 * of values, until its Exit; T3 sends the next chunk only once the last one is acknowledged (Ack), and stops the
 * stream when the client sends Interrupt. A frame may also come as a list of frames. T3 answers a Ping with a Pong.
 */
class RpcConnection implements FeedConnection {
  closed = false;
  /** When T3 last sent anything on this socket (a Pong included). */
  heardAt = Date.now();
  private nextId = 1;
  private readonly waiting = new Map<string, (exit: RpcExit | Error) => void>();
  private readonly streams = new Map<string, (values: unknown[]) => void>();

  /** Requests sent and not yet answered (nor timed out). */
  get pending(): number {
    return this.waiting.size;
  }
  private readonly open: Promise<void>;
  private failOpen: (error: Error) => void = () => {};
  private readonly socket: WebSocketLike;
  private readonly onEnd: (() => void) | undefined;

  constructor(socket: WebSocketLike, onEnd?: () => void) {
    this.socket = socket;
    this.onEnd = onEnd;
    this.open = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      this.failOpen = reject;
    });
    // Awaited by opened(); a failure after that has nobody waiting on this promise.
    this.open.catch(() => {});
    socket.addEventListener("error", () => this.end("websocket error"));
    socket.addEventListener("close", () => this.end("connection closed"));
    socket.addEventListener("message", (event) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.heardAt = Date.now();
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) this.receive(frame as { _tag?: string; requestId?: string; exit?: RpcExit; values?: unknown; defect?: unknown });
    });
  }

  private receive(message: { _tag?: string; requestId?: string; exit?: RpcExit; values?: unknown; defect?: unknown }): void {
    if (this.closed) return;
    if (message._tag === "Defect") {
      // T3 could not read a frame of this socket (it names no request): nothing waiting on it will be answered.
      this.end(`T3 reported a defect on the connection: ${JSON.stringify(message.defect ?? null).slice(0, 200)}`);
      this.socket.close();
      return;
    }
    if (!message.requestId) return;
    if (message._tag === "Chunk") {
      const deliver = this.streams.get(message.requestId);
      if (!deliver || !Array.isArray(message.values)) return;
      deliver(message.values);
      // Still subscribed after the values were applied (a listener may have cancelled): ask for the next chunk.
      if (this.streams.has(message.requestId)) this.send({ _tag: "Ack", requestId: message.requestId });
      return;
    }
    if (message._tag !== "Exit" || !message.exit) return;
    this.streams.delete(message.requestId);
    const settle = this.waiting.get(message.requestId);
    this.waiting.delete(message.requestId);
    settle?.(message.exit);
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.closed) this.socket.send(JSON.stringify(frame));
  }

  ping(): void {
    this.send({ _tag: "Ping" });
  }

  /**
   * Subscribe to a stream: `onValues` gets each chunk's values in order, and each is acknowledged once it returns.
   * `done` settles at the stream's end: resolved when T3 ends it or it is cancelled here, rejected when T3 refuses it or
   * the socket goes. `cancel` asks T3 to stop it (Interrupt); nothing more is delivered after it.
   */
  stream(tag: string, payload: unknown, onValues: (values: unknown[]) => void): { done: Promise<void>; cancel: () => void } {
    if (this.closed) return { done: Promise.reject(new T3Unavailable(`T3 RPC ${tag}: connection closed`)), cancel: () => {} };
    const id = String(this.nextId++);
    let settle: (exit: RpcExit | Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      settle = (exit) => {
        this.streams.delete(id);
        this.waiting.delete(id);
        if (exit instanceof Error) reject(new T3Unavailable(`T3 RPC ${tag}: ${exit.message}`));
        else if (exit._tag === "Success") resolve();
        else {
          const scope = missingPermission(exit.cause);
          reject(scope ? new T3ScopeMissing(scope, exit) : new T3CommandRejected(`T3 refused ${tag}: ${rpcFailure(exit.cause)}`, 500, exit));
        }
      };
    });
    this.streams.set(id, onValues);
    this.waiting.set(id, settle);
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    const cancel = () => {
      if (!this.waiting.has(id)) return;
      settle({ _tag: "Success" });
      this.send({ _tag: "Interrupt", requestId: id });
    };
    return { done, cancel };
  }

  async opened(tag: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new T3Unavailable(`T3 RPC ${tag} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([this.open, timeout]);
    } catch (error) {
      this.close();
      throw error instanceof T3Unavailable ? error : new T3Unavailable(`T3 RPC ${tag}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  request<T>(tag: string, payload: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new T3Unavailable(`T3 RPC ${tag}: connection closed`));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      // Sent from here on: no answer, by the time limit or because the socket went, leaves the outcome unknown.
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new T3OutcomeUnknown(`T3 RPC ${tag} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiting.set(id, (exit) => {
        clearTimeout(timer);
        if (exit instanceof Error) reject(new T3OutcomeUnknown(`T3 RPC ${tag}: ${exit.message} before T3 answered`));
        else if (exit._tag === "Success") resolve(exit.value as T);
        else {
          const scope = missingPermission(exit.cause);
          reject(scope ? new T3ScopeMissing(scope, exit) : new T3CommandRejected(`T3 refused ${tag}: ${rpcFailure(exit.cause)}`, 500, exit));
        }
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  close(): void {
    this.end("connection closed");
    this.socket.close();
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    this.failOpen(error);
    for (const settle of [...this.waiting.values()]) settle(error);
    this.waiting.clear();
    this.streams.clear();
    this.onEnd?.();
  }
}

/** Backroom is a web client of T3: what T3 records as the source of the threads and messages it creates. */
const CREATION_SOURCE = "web";

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function toBackgroundTasks(raw: unknown): T3BackgroundTask[] {
  return ((raw as Array<Record<string, unknown>> | undefined) ?? []).map((task) => ({
    taskId: String(task.taskId ?? ""),
    kind: task.kind === "subagent" || task.kind === "command" || task.kind === "monitor" ? task.kind : "background_task",
    description: text(task.description),
    childThreadId: text(task.childThreadId),
  }));
}

/**
 * T3's watches of the thread's pull requests, as T3 lists them in its shell (derivePendingBackgroundWork): one monitor
 * per linked pull request with a watch, named as T3 names it. The thread record carries them (its links' `watch`),
 * where the provider thread's list, the harness's own work, cannot.
 */
function pullRequestWatchTasks(raw: unknown): T3BackgroundTask[] {
  return ((raw as Array<Record<string, unknown>> | undefined) ?? []).flatMap((link) => {
    if (link.watch === undefined || link.watch === null || link.source === "stack-dismissed") return [];
    const number = Number(link.number ?? 0);
    return [{ taskId: pullRequestWatchTaskId(String(link.host ?? ""), String(link.repository ?? ""), number), kind: "monitor" as const, description: `Watching pull request #${number}`, childThreadId: null }];
  });
}

/** The provider thread's background tasks with T3's pull-request watches beside them, each task once. */
function withPullRequestWatches(tasks: T3BackgroundTask[], pullRequests: unknown): T3BackgroundTask[] {
  const known = new Set(tasks.map((task) => task.taskId));
  return [...tasks, ...pullRequestWatchTasks(pullRequests).filter((task) => !known.has(task.taskId))];
}

/** The run statuses after which T3 lists its pull-request watches: the latest run settled, or waiting on a request. */
const WATCH_LISTED_AFTER: ReadonlySet<T3RunStatus> = new Set<T3RunStatus>(["cancelled", "completed", "failed", "interrupted", "waiting"]);

/**
 * Whether T3's shell lists the thread's pull-request watches now, as T3 decides it (derivePendingBackgroundWork): not
 * while a run is preparing, starting or running, and not until the latest run that is not held in a queue has settled.
 * A queued run, or a rolled-back one, hides them.
 */
function pullRequestWatchesListed(runs: T3Run[]): boolean {
  if (runs.some((run) => run.status === "preparing" || run.status === "starting" || run.status === "running")) return false;
  const latest = runs.filter((run) => !(run.status === "queued" && run.queueHeld)).reduce<T3Run | null>((best, run) => (best === null || run.ordinal > best.ordinal ? run : best), null);
  return latest === null || WATCH_LISTED_AFTER.has(latest.status);
}

function toWatch(raw: unknown): T3PullRequestWatch | null {
  const watch = raw as Record<string, unknown> | null | undefined;
  if (!watch || typeof watch.startedAt !== "string") return null;
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((n): n is string => typeof n === "string") : []);
  return { startedAt: watch.startedAt, headSha: text(watch.headSha), failedChecks: names(watch.failedChecks), passedChecks: names(watch.passedChecks), passed: watch.passed === true, checksAwaitedSince: text(watch.checksAwaitedSince) };
}

const CHECK_STATUSES = new Set(["pending", "action-required", "success", "failure", "skipped", "neutral", "cancelled"]);

function toAttachments(raw: unknown): T3MessageAttachment[] {
  return ((raw as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((attachment) => typeof attachment.id === "string")
    .map((attachment) => ({
      id: attachment.id as string,
      name: text(attachment.name) ?? "attachment",
      mimeType: text(attachment.mimeType) ?? "application/octet-stream",
      sizeBytes: Number(attachment.sizeBytes ?? 0),
      type: attachment.type === "image" || attachment.type === "file" ? attachment.type : "unknown",
    }));
}

function toCheckpointFiles(raw: unknown): T3CheckpointFile[] {
  return ((raw as Array<Record<string, unknown>> | undefined) ?? []).map((file) => ({
    path: String(file.path ?? ""),
    kind: String(file.kind ?? "modified"),
    additions: Number(file.additions ?? 0),
    deletions: Number(file.deletions ?? 0),
  }));
}

function toTokenUsage(raw: unknown): T3TokenUsage | null {
  const usage = raw as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage.usedTokens !== "number") return null;
  return {
    usedTokens: usage.usedTokens,
    maxTokens: num(usage.maxTokens),
    inputTokens: num(usage.inputTokens),
    cachedInputTokens: num(usage.cachedInputTokens),
    outputTokens: num(usage.outputTokens),
    reasoningOutputTokens: num(usage.reasoningOutputTokens),
    updatedAt: text(usage.updatedAt) ?? "",
  };
}

function toRun(run: Record<string, unknown>): T3Run {
  return {
    id: run.id as string,
    threadId: run.threadId as string,
    ordinal: Number(run.ordinal ?? 0),
    userMessageId: run.userMessageId as string,
    status: run.status as T3Run["status"],
    queuePosition: num(run.queuePosition),
    queueHeld: run.queueHeld === true,
    requestedAt: run.requestedAt as string,
    startedAt: text(run.startedAt),
    completedAt: text(run.completedAt),
    checkpointId: text(run.checkpointId),
    providerInstanceId: String(run.providerInstanceId ?? ""),
    modelSelection: run.modelSelection as ModelSelection,
  };
}

function toMessage(message: Record<string, unknown>): T3Message {
  return {
    id: message.id as string,
    threadId: message.threadId as string,
    role: message.role as T3Message["role"],
    text: (message.text as string) ?? "",
    runId: text(message.runId),
    nodeId: text(message.nodeId),
    streaming: Boolean(message.streaming),
    createdAt: message.createdAt as string,
    updatedAt: text(message.updatedAt) ?? (message.createdAt as string),
    createdBy: (text(message.createdBy) as T3Message["createdBy"] | null) ?? "system",
    creationSource: text(message.creationSource) ?? "server",
    senderThreadId: text(message.senderThreadId),
    attachments: toAttachments(message.attachments),
  };
}

function toProviderThread(thread: Record<string, unknown>): T3ProviderThread {
  return {
    id: thread.id as string,
    driver: String(thread.driver ?? ""),
    providerInstanceId: String(thread.providerInstanceId ?? ""),
    status: thread.status as T3ProviderThread["status"],
    nativeId: text((thread.nativeThreadRef as { nativeId?: unknown } | null | undefined)?.nativeId),
    contextUsage: toTokenUsage(thread.contextUsage),
    pendingBackgroundTasks: toBackgroundTasks(thread.pendingBackgroundTasks),
    createdAt: text(thread.createdAt) ?? "",
    updatedAt: text(thread.updatedAt) ?? "",
  };
}

function toTurnItem(item: Record<string, unknown>): T3TurnItem {
  const base = {
    id: item.id as string,
    runId: text(item.runId),
    nodeId: text(item.nodeId),
    providerTurnId: text(item.providerTurnId),
    ordinal: Number(item.ordinal ?? 0),
    status: item.status as T3TurnItem["status"],
    title: text(item.title),
    startedAt: text(item.startedAt),
    completedAt: text(item.completedAt),
    updatedAt: text(item.updatedAt) ?? "",
  };
  switch (item.type) {
    case "user_message":
      return { ...base, type: "user_message", messageId: item.messageId as string, text: (item.text as string) ?? "", attachments: toAttachments(item.attachments), inputIntent: (text(item.inputIntent) as "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer" | null) ?? "turn_start" };
    case "assistant_message":
      return { ...base, type: "assistant_message", messageId: item.messageId as string, text: (item.text as string) ?? "", streaming: Boolean(item.streaming) };
    case "reasoning":
      return { ...base, type: "reasoning", text: (item.text as string) ?? "", streaming: Boolean(item.streaming) };
    case "proposed_plan":
      return { ...base, type: "proposed_plan", planId: item.planId as string, markdown: (item.markdown as string) ?? "", streaming: Boolean(item.streaming) };
    case "todo_list":
      return { ...base, type: "todo_list", planId: item.planId as string, steps: (item.steps as Array<{ id: string; text: string; status: "pending" | "running" | "completed" }> | undefined) ?? [], explanation: text(item.explanation) };
    case "user_input_request":
      return { ...base, type: "user_input_request", requestId: item.requestId as string, questions: (item.questions as T3UserInputQuestion[] | undefined) ?? [], responseMode: item.responseMode === "message" ? "message" : null };
    case "secret_request":
      return {
        ...base,
        type: "secret_request",
        label: text(item.label) ?? text(item.title) ?? "a secret",
        reason: typeof item.reason === "string" ? item.reason : "",
        placeholder: text(item.placeholder),
        delivery: item.delivery === "file" ? "file" : null,
        // A status this version does not know is not one the user can answer.
        secretStatus: item.secretStatus === "pending" || item.secretStatus === "saved" || item.secretStatus === "declined" ? item.secretStatus : "cancelled",
      };
    case "approval_request":
      return { ...base, type: "approval_request", requestId: item.requestId as string, requestKind: String(item.requestKind ?? "command"), prompt: text(item.prompt), appName: text(item.appName), options: (item.options as T3ApprovalOption[] | undefined) ?? null };
    case "file_change":
      return { ...base, type: "file_change", fileName: String(item.fileName ?? ""), additions: num(item.additions), deletions: num(item.deletions) };
    case "command_execution":
      return { ...base, type: "command_execution", input: (item.input as string) ?? "", output: text(item.output), exitCode: num(item.exitCode), outputIndicatesFailure: item.outputIndicatesFailure === true };
    case "file_search":
      return { ...base, type: "file_search", pattern: text(item.pattern) };
    case "web_search":
      return { ...base, type: "web_search", patterns: (item.patterns as string[] | undefined) ?? [] };
    case "dynamic_tool":
      return { ...base, type: "dynamic_tool", toolName: text(item.toolName), input: item.input, output: item.output };
    case "checkpoint":
      return { ...base, type: "checkpoint", checkpointId: item.checkpointId as string, files: toCheckpointFiles(item.files) };
    case "error": {
      const failure = (item.failure ?? {}) as { message?: unknown; class?: unknown; resetAt?: unknown };
      return { ...base, type: "error", message: text(failure.message) ?? "provider error", failureClass: text(failure.class), retrying: item.retry !== undefined && item.retry !== null, resetAt: text(failure.resetAt) };
    }
    case "compaction":
      return { ...base, type: "compaction", summary: text(item.summary), beforeTokenCount: num(item.beforeTokenCount), afterTokenCount: num(item.afterTokenCount) };
    case "subagent":
      return { ...base, type: "subagent", subagentId: item.subagentId as string, origin: item.origin === "app_owned" ? "app_owned" : "provider_native", childThreadId: text(item.childThreadId), prompt: (item.prompt as string) ?? "", progress: text(item.progress), result: text(item.result) };
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return { ...base, type: item.type, message: (item.message as string) ?? "" };
    default:
      return { ...base, type: "other", itemType: String(item.type ?? "unknown") };
  }
}

export class HttpT3Adapter implements T3Adapter {
  readonly kind = "http" as const;
  private readonly baseUrl: string;
  private accessToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: (new (url: string) => WebSocketLike) | undefined;
  private readonly userDataDir: string | undefined;
  private readonly onCredentialRejected: ((token: string | null) => void) | undefined;
  private readonly shellCacheMs: number;
  private readonly requestTimeoutMs: number;
  private readonly worktreePollMs: number;
  private readonly commandLinkIdleMs: number;
  private shellCache: { at: number; value: ShellSnapshot } | null = null;
  /** One shell read at a time: callers that arrive while it is in flight share it, and a slow read is reused for twice its duration. */
  private shellInflight: Promise<ShellSnapshot> | null = null;
  private shellLastMs = 0;
  /** Bumped when a command makes the shell stale: a read that started before it is neither shared nor cached afterwards. */
  private shellGeneration = 0;
  /** The last protocol check: a server on protocol 2 is trusted for a minute, a mismatch is checked again within seconds. */
  private protocolCheck: { at: number; error: T3ProtocolMismatch | null } | null = null;
  /** T3's shell as it streams it, once started (startFeed): the shell reads' source while it is live. */
  private readonly shellFeed: ShellFeed;
  private readonly shellListeners = new Set<(change: T3ShellChange) => void>();
  private readonly feedListeners = new Set<(status: T3ShellFeedStatus) => void>();
  /** The watched threads' details as T3 streams their changes, on the shell feed's socket. */
  private readonly threadFeed: ThreadFeed;
  /** Per thread, its shell as of its latest detail read (all but its time) and the sequence that set it: the floor. */
  private readonly detailFloors = new Map<string, { key: string; sequence: number }>();
  private readonly threadListeners = new Set<(threadId: string) => void>();
  /**
   * After a command: the sequence T3 gave it (Infinity when it gave none), and until when the shell reads wait for the
   * feed to reach it, reading over HTTP meanwhile, so a read made after a command sees what it did.
   */
  private feedFloor: { sequence: number; until: number } | null = null;
  /** Ends the floor at its time, so reads waiting on HTTP meanwhile take the feed then. */
  private feedFloorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reads waiting on T3 over HTTP: each takes the feed's shell instead once it is live and caught up. */
  private readonly feedWaiters = new Set<() => void>();
  private archivedCache: { at: number; value: Array<Record<string, unknown>> } | null = null;
  private archivedInflight: Promise<Array<Record<string, unknown>>> | null = null;

  constructor(options: HttpAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketImpl = options.webSocketImpl;
    this.userDataDir = options.userDataDir;
    this.shellCacheMs = options.shellCacheMs ?? 750;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.worktreePollMs = options.worktreePollMs ?? 500;
    this.commandLinkIdleMs = options.commandLinkIdleMs ?? 30_000;
    this.onCredentialRejected = options.onCredentialRejected;
    this.threadFeed = new ThreadFeed({
      read: (threadId, bounded) => this.readThread(threadId, bounded),
      floor: (threadId) => this.detailFloor(threadId),
      onChange: (threadId) => {
        for (const listener of [...this.threadListeners]) listener(threadId);
      },
      ...(options.log ? { log: options.log } : {}),
      ...options.threads,
    });
    this.shellFeed = new ShellFeed({
      connect: (onEnd) => this.connectFeed(onEnd),
      onChange: (change) => {
        // A read made from here on sees the change: nothing read over HTTP before it is reused (reads go over HTTP
        // while the feed has not shown the latest command, and once it is down). Becoming live counts as a change, so
        // what was read over HTTP before that is never reused.
        this.dropShellCache();
        for (const listener of [...this.shellListeners]) listener(change);
      },
      // The streams may have moved on, a change or not: a read waiting on HTTP takes the feed if it has caught up.
      onApplied: () => this.releaseFeedWaiters(),
      onStatus: (status) => {
        for (const listener of [...this.feedListeners]) listener(status);
      },
      // The watched threads' streams ride on the feed's socket, while its shell is live.
      onConnection: (connection) => this.threadFeed.connect(connection),
      timeoutMs: this.requestTimeoutMs,
      ...options.feed,
    });
  }

  /** Use another token from now on; the sockets opened with the old one are closed, and open again with it when next needed. */
  setAccessToken(token: string | null): void {
    this.accessToken = token;
    this.dropShellCache();
    this.protocolCheck = null;
    this.dropCommandLink();
    const activity = this.activityLink;
    this.activityLink = null;
    void activity?.then((connection) => connection.close(), () => undefined);
    this.shellFeed.restart();
  }

  /**
   * Keep T3's shell live from its streams (orchestration.subscribeShell and subscribeArchivedShell) on a socket of its
   * own, open until close(): the shell reads are served from it while it is live, with no HTTP snapshot. It reconnects
   * by itself after a drop; meanwhile, and before its first snapshots, the reads go over HTTP as before.
   */
  startFeed(): void {
    this.shellFeed.start();
  }

  feed(): T3ShellFeedStatus {
    return this.shellFeed.status();
  }

  onShellChange(listener: (change: T3ShellChange) => void): () => void {
    this.shellListeners.add(listener);
    return () => {
      this.shellListeners.delete(listener);
    };
  }

  onFeedChange(listener: (status: T3ShellFeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => {
      this.feedListeners.delete(listener);
    };
  }

  onThreadChange(listener: (threadId: string) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  holdThreads(owner: string, threadIds: readonly string[]): void {
    this.threadFeed.hold(owner, threadIds);
  }

  leaseThread(threadId: string): void {
    this.threadFeed.lease(threadId);
  }

  threadPushed(threadId: string): boolean {
    return this.threadFeed.pushed(threadId);
  }

  /** The thread feed's watches: how many, how many of their streams are live, how many T3 refuses (GET /api/status). */
  threadStreams(): { watched: number; live: number; refused: number } {
    return this.threadFeed.status();
  }

  private async connectFeed(onEnd: () => void): Promise<FeedConnection> {
    await this.ensureProtocol();
    return await this.connect("orchestration.subscribeShell", this.requestTimeoutMs, onEnd);
  }

  /** Whether T3 takes `token` (its session check), without using it for anything else. */
  async accepts(token: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/session`, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) return false;
    return ((await response.json()) as { authenticated?: unknown }).authenticated === true;
  }

  get hasCredentials(): boolean {
    return this.accessToken !== null;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL_VERSION) };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    // A T3 that accepts the connection but never answers (seen while it restarts after an update) would otherwise hold
    // the scheduler's tick for fetch's own 5-minute limit, stopping every room. Past the limit it counts as unreachable
    // and the next tick retries (a dispatch is resent with the same command id).
    const limitMs = method === "GET" ? this.requestTimeoutMs : this.requestTimeoutMs * 2;
    const signal = AbortSignal.timeout(limitMs);
    const unanswered = (error: unknown) =>
      signal.aborted
        ? new T3Unavailable(`T3 at ${this.baseUrl} did not answer ${method} ${path} within ${limitMs >= 1000 ? `${Math.round(limitMs / 1000)}s` : `${limitMs}ms`}`, error)
        : new T3Unavailable(`cannot reach T3 at ${this.baseUrl}: ${(error as Error).message}`, error);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (error) {
      throw unanswered(error);
    }
    // T3 answers 401 for a token it does not take (bad, expired, revoked), 403 for a permission the token lacks
    // (EnvironmentScopeRequiredError): a new token with the same scopes would be refused again, so only a 401 renews.
    if (response.status === 401) {
      this.onCredentialRejected?.(headers.authorization ? headers.authorization.slice("Bearer ".length) : null);
      throw new T3Unavailable(`T3 rejected the credential (HTTP 401); pair Backroom again`);
    }
    if (response.status === 403) {
      const scope = requiredScopeOf(text);
      throw new T3Unavailable(scope ? missingScopeMessage(scope) : `T3 refused ${method} ${path} (HTTP 403): ${text.slice(0, 300)}`);
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
      orchestrationProtocolVersion?: number;
    };
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      // Servers from before protocol negotiation (V1) do not say; they speak protocol 1.
      orchestrationProtocolVersion: typeof descriptor.orchestrationProtocolVersion === "number" ? descriptor.orchestrationProtocolVersion : null,
      baseUrl: this.baseUrl,
    };
  }

  /**
   * Orchestration reads and commands only make sense against protocol 2: a V1 server answers some of the same routes
   * with other shapes. Checked against the server's descriptor, not assumed, since T3 can be updated while this runs.
   */
  private async ensureProtocol(): Promise<void> {
    const check = this.protocolCheck;
    if (check && Date.now() - check.at < (check.error ? 5_000 : 60_000)) {
      if (check.error) throw check.error;
      return;
    }
    const environment = await this.describe();
    const error = environment.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION ? null : new T3ProtocolMismatch(environment.serverVersion, environment.orchestrationProtocolVersion);
    this.protocolCheck = { at: Date.now(), error };
    if (error) throw error;
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
  // Used for reads that have no HTTP route (server.getConfig). One short-lived socket per call, ticket-authenticated;
  // the one exception is the activity connection below, which stays open.

  private async connect(tag: string, timeoutMs: number, onEnd?: () => void): Promise<RpcConnection> {
    const ticket = (await this.request("POST", "/api/auth/websocket-ticket")) as { ticket: string };
    const url = new URL("/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
    const SocketCtor = this.webSocketImpl ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!SocketCtor) throw new T3Unavailable("WebSocket is not available in this runtime");
    const connection = new RpcConnection(new SocketCtor(url.toString()), onEnd);
    await connection.opened(tag, timeoutMs);
    return connection;
  }

  // Commands and short reads share one socket, as T3's own client keeps one: a dispatch is then a single frame. It is
  // closed after a quiet spell (counted from when its last call was answered, never while one is waiting), and dropped
  // when a request on it times out or it fails. A call that may take minutes
  // (a worktree checkout, an update) gets a socket of its own, so its wait never rides on the shared one.
  private commandLink: Promise<RpcConnection> | null = null;
  private commandLinkIdle: ReturnType<typeof setTimeout> | null = null;

  private dropCommandLink(): void {
    const link = this.commandLink;
    this.commandLink = null;
    if (this.commandLinkIdle) clearTimeout(this.commandLinkIdle);
    this.commandLinkIdle = null;
    void link?.then((connection) => connection.close(), () => undefined);
  }

  /** Close the sockets this adapter keeps open (a script calls this before it ends). */
  close(): void {
    this.dropCommandLink();
    this.shellFeed.stop();
    this.threadFeed.close();
    if (this.feedFloorTimer) clearTimeout(this.feedFloorTimer);
    this.feedFloorTimer = null;
    void this.reportActivity(null).catch(() => undefined);
  }

  private async rpc<T>(tag: string, payload: unknown, timeoutMs = 15000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    if (timeoutMs > 60_000) {
      const connection = await this.connect(tag, timeoutMs);
      try {
        return await connection.request<T>(tag, payload, Math.max(1, deadline - Date.now()));
      } finally {
        connection.close();
      }
    }
    let link = this.commandLink;
    if (!link || (await link.catch(() => null))?.closed !== false) {
      link = this.connect(tag, timeoutMs, () => {
        if (this.commandLink === link) this.commandLink = null;
      });
      this.commandLink = link;
      link.catch(() => {
        if (this.commandLink === link) this.commandLink = null;
      });
    }
    const connection = await link;
    if (this.commandLinkIdle) clearTimeout(this.commandLinkIdle);
    this.commandLinkIdle = null;
    try {
      return await connection.request<T>(tag, payload, Math.max(1, deadline - Date.now()));
    } catch (error) {
      // No answer in time, or the socket went: the link is in doubt, and the next call opens a new one.
      if (error instanceof T3Unavailable && this.commandLink === link) this.dropCommandLink();
      throw error;
    } finally {
      if (this.commandLink === link && connection.pending === 0) {
        if (this.commandLinkIdle) clearTimeout(this.commandLinkIdle);
        this.commandLinkIdle = setTimeout(() => this.dropCommandLink(), this.commandLinkIdleMs);
        this.commandLinkIdle.unref?.();
      }
    }
  }

  // T3 checks its providers (plan usage included) every few minutes only while a client in view holds a lease. Leases
  // are reported on a connection of their own, kept open while Backroom is in use, as T3's window keeps its socket.
  private activityLink: Promise<RpcConnection> | null = null;

  async reportActivity(activity: ClientActivity | null): Promise<void> {
    if (!activity) {
      const link = this.activityLink;
      this.activityLink = null;
      (await link?.catch(() => null))?.close();
      return;
    }
    let link = this.activityLink;
    if (!link || (await link.catch(() => null))?.closed !== false) {
      link = this.connect("server.reportClientActivity", 15_000, () => {
        if (this.activityLink === link) this.activityLink = null;
      });
      this.activityLink = link;
      link.catch(() => {
        if (this.activityLink === link) this.activityLink = null;
      });
    }
    const connection = await link;
    await connection.request("server.reportClientActivity", {
      clientId: "backroom",
      clientKind: "web",
      visible: activity.visible,
      focused: activity.focused,
      recentlyInteracted: activity.recentlyInteracted,
      appState: activity.visible ? "active" : "background",
      scopes: [{ type: "provider-status" }],
      ttlMs: activity.ttlMs,
      observedAt: new Date().toISOString(),
    }, 15_000);
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

  async versions(fresh = false): Promise<T3Versions> {
    const config = await this.getServerConfig(fresh ? 0 : undefined);
    const capabilities = config.environment?.capabilities ?? {};
    return {
      serverVersion: config.environment?.serverVersion ?? null,
      selfUpdate: capabilities.serverSelfUpdate ?? null,
      desktopAppUpdate: capabilities.desktopAppUpdate === true,
      threadContinuation: capabilities.serverUpdateThreadContinuation === true,
      harnesses: (config.providers ?? []).map((provider) => {
        const advisory = provider.versionAdvisory;
        const status = advisory?.status === "current" || advisory?.status === "behind_latest" ? advisory.status : "unknown";
        const latestFlagged = provider.compatibilityAdvisory?.latestVersionStatus === "broken" || provider.compatibilityAdvisory?.latestVersionStatus === "unsupported";
        const canRun = advisory?.canUpdate === true && Boolean(advisory.updateCommand);
        const updatable = Boolean(provider.enabled) && status === "behind_latest" && canRun && !latestFlagged;
        const note =
          status !== "behind_latest" || updatable
            ? null
            : latestFlagged
              ? (provider.compatibilityAdvisory?.message ?? "T3 has not cleared the newest version for use yet.")
              : "T3 cannot update this install; update it where it was installed.";
        return {
          instanceId: provider.instanceId,
          driver: provider.driver ?? provider.instanceId,
          displayName: provider.displayName ?? provider.instanceId,
          enabled: Boolean(provider.enabled),
          version: provider.version ?? advisory?.currentVersion ?? null,
          latestVersion: advisory?.latestVersion ?? null,
          status,
          updatable,
          note,
          checkedAt: advisory?.checkedAt ?? null,
          update: provider.updateState ?? null,
        };
      }),
    };
  }

  async refreshProviders(input: { instanceId?: string; refreshModels?: boolean } = {}): Promise<void> {
    try {
      await this.rpc("server.refreshProviders", { ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.refreshModels ? { refreshModels: true } : {}) }, input.refreshModels ? 3 * 60_000 : 60_000);
    } finally {
      this.configCache = null;
    }
  }

  async updateHarness(input: { instanceId: string; driver: string }): Promise<void> {
    // T3 answers when the updater has finished (it queues behind another harness's update).
    try {
      await this.rpc("server.updateProvider", { provider: input.driver, instanceId: input.instanceId }, 15 * 60_000);
    } finally {
      this.configCache = null;
    }
  }

  async updateServer(input: { targetVersion: string; continueRunningThreads: boolean }): Promise<void> {
    // T3 downloads and stages the version, then answers just before its launcher restarts it.
    try {
      await this.rpc("server.updateServer", { targetVersion: input.targetVersion, ...(input.continueRunningThreads ? { continueRunningThreads: true } : {}) }, 15 * 60_000);
    } finally {
      this.configCache = null;
    }
  }

  /** Drop the cached shell and stop sharing the read in flight: the next read over HTTP reads afresh. */
  private dropShellCache(): void {
    this.shellCache = null;
    this.shellInflight = null;
    this.shellGeneration += 1;
    this.archivedCache = null;
    this.archivedInflight = null;
  }

  /**
   * A command changed what T3 serves: the HTTP cache is dropped, and the feed serves the reads again once it shows the
   * command's `sequence` (any, when T3 gave none, after FEED_CATCH_UP_MS at most).
   */
  private invalidateShell(sequence?: number): void {
    this.dropShellCache();
    const now = Date.now();
    // A floor past its time holds nothing any more, whatever it was waiting for.
    const held = this.feedFloor && now < this.feedFloor.until ? this.feedFloor.sequence : 0;
    const target = typeof sequence === "number" ? sequence : Number.POSITIVE_INFINITY;
    const floor = { sequence: Math.max(held, target), until: now + FEED_CATCH_UP_MS };
    this.feedFloor = floor;
    if (this.feedFloorTimer) clearTimeout(this.feedFloorTimer);
    this.feedFloorTimer = setTimeout(() => {
      this.feedFloorTimer = null;
      if (this.feedFloor === floor) this.feedFloor = null;
      this.releaseFeedWaiters();
    }, FEED_CATCH_UP_MS);
    this.feedFloorTimer.unref?.();
  }

  /**
   * The feed's shell, when it is live and has caught up with the latest command; otherwise null. Each list is caught up
   * by its own stream: the projects and threads by the active one, the archived threads by the archived one (archiving
   * a thread is a removal on one and an update on the other, in either order). The command is behind both once both
   * have reached its sequence, or after FEED_CATCH_UP_MS.
   */
  private liveShell(list: "active" | "archive" = "active"): ShellSnapshot | null {
    const live = this.shellFeed.live();
    if (!live) return null;
    const floor = this.feedFloor;
    if (floor) {
      if (Date.now() >= floor.until || (live.activeSequence >= floor.sequence && live.archiveSequence >= floor.sequence)) this.feedFloor = null;
      else if ((list === "active" ? live.activeSequence : live.archiveSequence) < floor.sequence) return null;
    }
    return live.read();
  }

  private releaseFeedWaiters(): void {
    for (const waiter of [...this.feedWaiters]) waiter();
  }

  /**
   * A read over HTTP made while the feed's shell could not serve it, answered by whichever comes first: T3's answer,
   * or the feed once it is live and caught up (a T3 that is restarting can take its time with the HTTP snapshot, and
   * T3 streams a command's change long before a slow snapshot comes). No read waits for the feed.
   */
  private orFromFeed<T>(read: Promise<T>, pick: (live: ShellSnapshot) => T, list: "active" | "archive" = "active"): Promise<T> {
    if (!this.shellFeed.started) return read;
    return new Promise<T>((resolve, reject) => {
      const waiter = () => {
        const live = this.liveShell(list);
        if (!live) return;
        this.feedWaiters.delete(waiter);
        resolve(pick(live));
      };
      this.feedWaiters.add(waiter);
      read.then(
        (value) => {
          this.feedWaiters.delete(waiter);
          resolve(value);
        },
        (error: unknown) => {
          this.feedWaiters.delete(waiter);
          reject(error);
        },
      );
    });
  }

  /** T3's shell: the feed's while it is live and caught up, else over HTTP (see orFromFeed). */
  private async shell(force = false): Promise<ShellSnapshot> {
    const live = this.liveShell();
    if (live) return live;
    return await this.orFromFeed(this.readShell(force), (recovered) => recovered);
  }

  private async readShell(force: boolean): Promise<ShellSnapshot> {
    const now = Date.now();
    const ttl = Math.max(this.shellCacheMs, 2 * this.shellLastMs);
    if (!force && this.shellCache && now - this.shellCache.at < ttl) return this.shellCache.value;
    if (!force && this.shellInflight) return this.shellInflight;
    const generation = this.shellGeneration;
    const read = (async () => {
      await this.ensureProtocol();
      const started = Date.now();
      const value = (await this.request("GET", "/api/orchestration/shell")) as ShellSnapshot;
      this.shellLastMs = Date.now() - started;
      if (this.shellGeneration === generation) this.shellCache = { at: started, value };
      return value;
    })();
    this.shellInflight = read;
    try {
      return await read;
    } finally {
      if (this.shellInflight === read) this.shellInflight = null;
    }
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
            ...(model.badge ? { badge: model.badge } : {}),
            ...(provider.driver ? { driver: provider.driver } : {}),
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

  // ---------------- threads: T3's V2 projections, normalized ----------------

  private toShell(thread: Record<string, unknown>): T3ThreadShell {
    const pending = thread.pendingRuntimeRequest as { id: string; kind: T3RuntimeRequestKind; createdAt: string } | null | undefined;
    const lineage = (thread.lineage ?? {}) as { parentThreadId?: string | null; relationshipToParent?: "fork" | "subagent" | null; rootThreadId?: string };
    const modelSelection = thread.modelSelection as ModelSelection;
    // T3's shell status is its latest run's (a queued message makes it "queued"); the run that owns the activity
    // is named apart, and that is the status Backroom shows.
    const status = ((text(thread.activityRunStatus) ?? text(thread.status)) as T3ThreadStatus | null) ?? "idle";
    return {
      id: thread.id as string,
      projectId: thread.projectId as string,
      title: text(thread.title) ?? "",
      providerInstanceId: text(thread.providerInstanceId) ?? modelSelection.instanceId,
      modelSelection,
      runtimeMode: thread.runtimeMode as T3ThreadShell["runtimeMode"],
      interactionMode: (thread.interactionMode as T3ThreadShell["interactionMode"]) ?? "default",
      branch: text(thread.branch),
      worktreePath: text(thread.worktreePath),
      status,
      activeRunId: text(thread.activeRunId),
      latestRunId: text(thread.latestRunId),
      latestRunRequestedAt: text(thread.latestRunRequestedAt),
      latestRunStartedAt: text(thread.latestRunStartedAt),
      latestRunCompletedAt: text(thread.latestRunCompletedAt),
      lastError: text(thread.lastError),
      // T3 keeps the limited run's outcome as the thread's while messages queued behind it wait, and names no run in the
      // shell: the latest run is the limited one, unless one has started since.
      usageLimit:
        thread.lastErrorClass === "usage_limit" && text(thread.latestRunId) && !text(thread.activeRunId)
          ? { runId: thread.latestRunId as string, provider: text(thread.providerInstanceId) ?? modelSelection.instanceId, resetAt: text(thread.usageLimitResetAt), message: text(thread.lastError), recovery: recoveryFor(thread.limitRecovery, thread.latestRunId as string, text(thread.usageLimitResetAt)) }
          : null,
      // Tool calls and credential refreshes the provider routes through T3 are not the user's to answer. And a
      // request only waits while a run is in progress: T3 keeps listing a question the agent went on without
      // (Codex asks in "message" mode) after its run has ended, when nothing waits on it any more.
      pendingRequest:
        pending && isRunActive(status) && pending.kind !== "dynamic_tool_call" && pending.kind !== "auth_refresh" ? { id: pending.id, kind: pending.kind, createdAt: pending.createdAt } : null,
      pendingBackgroundTasks: toBackgroundTasks(thread.pendingBackgroundTasks),
      hasActionableProposedPlan: Boolean(thread.hasActionableProposedPlan),
      pullRequests: ((thread.pullRequests as Array<Record<string, unknown>> | undefined) ?? []).map((pr) => ({
        host: text(pr.host),
        repository: String(pr.repository ?? ""),
        number: Number(pr.number ?? 0),
        url: String(pr.url ?? ""),
        source: text(pr.source),
        snapshot: pr.snapshot ?? null,
        watch: toWatch(pr.watch),
      })),
      linkedPullRequest: (thread.linkedPullRequest as { repository: string; number: number; url: string } | null | undefined) ?? null,
      lineage: { parentThreadId: lineage.parentThreadId ?? null, relationshipToParent: lineage.relationshipToParent ?? null, rootThreadId: lineage.rootThreadId ?? (thread.id as string) },
      historyOrigin: thread.historyOrigin === "v1_import" || thread.historyOrigin === "native" ? thread.historyOrigin : null,
      latestUserMessageAt: text(thread.latestUserMessageAt),
      settledAt: text(thread.settledAt),
      archivedAt: text(thread.archivedAt),
      deletedAt: text(thread.deletedAt),
      createdAt: text(thread.createdAt) ?? "",
      updatedAt: text(thread.updatedAt) ?? "",
    };
  }

  /**
   * A thread's projection as Backroom reads it. The projection's own thread record has no status: T3 computes that
   * for its shell from the runs, and so does this (the shell read at the start of a tick can be older than the detail
   * read since). `listed` is the thread's shell entry, for what only the shell carries (pull requests, plan flag).
   */
  private toDetail(snapshot: { snapshotSequence?: number; projection: Record<string, unknown>; hasMoreHistory?: boolean }, listed: T3ThreadShell | null): T3ThreadDetail {
    const projection = snapshot.projection;
    const list = (key: string): Array<Record<string, unknown>> => (projection[key] as Array<Record<string, unknown>> | undefined) ?? [];
    const runs = list("runs").map(toRun).sort((a, b) => a.ordinal - b.ordinal);
    const turnItems = list("turnItems").map(toTurnItem).sort((a, b) => a.ordinal - b.ordinal);
    const messages = list("messages").map(toMessage);
    const nodes = new Map(list("nodes").map((node) => [node.id as string, node]));
    const itemByRequest = new Map<string, T3TurnItem>();
    for (const item of turnItems) if (item.type === "approval_request" || item.type === "user_input_request") itemByRequest.set(item.requestId, item);
    const runtimeRequests: T3RuntimeRequest[] = list("runtimeRequests")
      // Tool calls and credential refreshes the provider routes through T3 are not the user's to answer.
      .filter((request) => request.kind !== "dynamic_tool_call" && request.kind !== "auth_refresh")
      .map((request): T3RuntimeRequest => {
        const item = itemByRequest.get(request.id as string);
        const capability = (request.responseCapability as { type?: string } | undefined)?.type;
        return {
          id: request.id as string,
          kind: request.kind as T3RuntimeRequestKind,
          type: request.kind === "user_input" ? "user-input" : "approval",
          status: request.status as T3RuntimeRequest["status"],
          responseMode: capability === "message" || capability === "not_resumable" ? capability : "live",
          runId: item?.runId ?? text(nodes.get(request.nodeId as string)?.runId),
          nodeId: request.nodeId as string,
          createdAt: request.createdAt as string,
          resolvedAt: text(request.resolvedAt),
          prompt: item?.type === "approval_request" ? item.prompt : null,
          options: item?.type === "approval_request" ? item.options : null,
          appName: item?.type === "approval_request" ? item.appName : null,
          questions: item?.type === "user_input_request" ? item.questions : [],
          secret: null,
          decision: (text(request.decision) as ApprovalDecision | null) ?? null,
          answers: (request.answers as Record<string, unknown> | undefined) ?? null,
        };
      })
      // T3 keeps a secret it asks for as a turn item, not a runtime request: it waits all the same.
      .concat(secretRequests(turnItems, runs));
    const providerThreads = list("providerThreads").map(toProviderThread);
    const thread = projection.thread as Record<string, unknown>;
    const active = runs.find((run) => run.status !== "queued" && isRunActive(run.status)) ?? null;
    const started = runs.filter((run) => run.status !== "queued");
    const latest = started[started.length - 1] ?? runs[runs.length - 1] ?? null;
    const pending = openRequests({ runtimeRequests, runs })[0] ?? null;
    const failure = latest && (latest.status === "failed" || latest.status === "interrupted") ? turnItems.filter((item) => item.runId === latest.id && item.type === "error").pop() : undefined;
    const activeProviderThread = providerThreads.find((p) => p.id === thread.activeProviderThreadId) ?? providerThreads[providerThreads.length - 1] ?? null;
    const shell: T3ThreadShell = {
      ...(listed ?? this.toShell({ ...thread, status: "idle" })),
      // The thread record is the fresher source for what both carry.
      title: text(thread.title) ?? listed?.title ?? "",
      modelSelection: thread.modelSelection as ModelSelection,
      runtimeMode: thread.runtimeMode as T3ThreadShell["runtimeMode"],
      interactionMode: (thread.interactionMode as T3ThreadShell["interactionMode"]) ?? "default",
      branch: text(thread.branch),
      worktreePath: text(thread.worktreePath),
      archivedAt: text(thread.archivedAt),
      deletedAt: text(thread.deletedAt),
      settledAt: text(thread.settledAt),
      status: active ? active.status : runs.some((run) => run.status === "queued") ? "queued" : (latest?.status ?? "idle"),
      activeRunId: active?.id ?? null,
      latestRunId: latest?.id ?? null,
      latestRunRequestedAt: latest?.requestedAt ?? null,
      latestRunStartedAt: latest?.startedAt ?? null,
      latestRunCompletedAt: latest?.completedAt ?? null,
      lastError: failure?.type === "error" ? failure.message : latest?.status === "failed" ? (listed?.lastError ?? null) : null,
      usageLimit: usageLimitOf({ runs, turnItems }, thread.limitRecovery),
      pendingRequest: pending ? { id: pending.id, kind: pending.kind, createdAt: pending.createdAt } : null,
      // T3's shell lists its pull-request watches with the harness's tasks; the provider thread lists only the latter.
      pendingBackgroundTasks: active ? [] : withPullRequestWatches(activeProviderThread?.pendingBackgroundTasks ?? listed?.pendingBackgroundTasks ?? [], pullRequestWatchesListed(runs) ? thread.pullRequests : []),
    };
    return {
      snapshotSequence: snapshot.snapshotSequence ?? 0,
      shell,
      runs,
      messages,
      turnItems,
      runtimeRequests,
      checkpoints: list("checkpoints").map((checkpoint) => ({
        id: checkpoint.id as string,
        runId: text(checkpoint.runId),
        status: checkpoint.status as T3Checkpoint["status"],
        files: toCheckpointFiles(checkpoint.files),
        capturedAt: checkpoint.capturedAt as string,
      })),
      subagents: list("subagents").map((subagent) => ({
        id: subagent.id as string,
        runId: text(subagent.runId),
        origin: subagent.origin as T3Subagent["origin"],
        driver: String(subagent.driver ?? ""),
        providerInstanceId: String(subagent.providerInstanceId ?? ""),
        childThreadId: text(subagent.childThreadId),
        title: text(subagent.title),
        model: text(subagent.model),
        prompt: text(subagent.prompt) ?? "",
        status: subagent.status as T3Subagent["status"],
        progress: text(subagent.progress),
        result: text(subagent.result),
        startedAt: text(subagent.startedAt),
        completedAt: text(subagent.completedAt),
        updatedAt: subagent.updatedAt as string,
      })),
      providerTurns: list("providerTurns").map((turn) => {
        const usage = turn.turnTokenUsage as Record<string, unknown> | undefined;
        return {
          id: turn.id as string,
          nodeId: turn.nodeId as string,
          providerThreadId: turn.providerThreadId as string,
          status: turn.status as T3ProviderTurn["status"],
          startedAt: text(turn.startedAt),
          completedAt: text(turn.completedAt),
          tokenUsage: toTokenUsage(turn.tokenUsage),
          turnTokenUsage: usage
            ? {
                usageStatus: (text(usage.usageStatus) as "complete" | "partial" | "unavailable" | null) ?? "unavailable",
                inputTokens: num(usage.inputTokens),
                outputTokens: num(usage.outputTokens),
                cachedInputTokens: num(usage.cachedInputTokens),
                cacheCreationTokens: num(usage.cacheCreationTokens),
                reasoningTokens: num(usage.reasoningTokens),
                hasSubagents: usage.hasSubagents === true,
              }
            : null,
        };
      }),
      providerThreads,
      plans: list("plans").map((plan) => ({
        id: plan.id as string,
        kind: plan.kind as T3Plan["kind"],
        runId: text(plan.runId),
        status: plan.status as T3Plan["status"],
        markdown: text(plan.markdown),
        steps: ((plan.steps as Array<{ id: string; text: string; status: "pending" | "running" | "completed" }> | undefined) ?? []).map((step) => ({ id: step.id, text: step.text, status: step.status })),
      })),
      partial: snapshot.hasMoreHistory === true,
    };
  }

  async listThreads(projectId?: string): Promise<T3ThreadShell[]> {
    const shell = await this.shell();
    return shell.threads
      .map((thread) => this.toShell(thread))
      .filter((thread) => thread.deletedAt === null && thread.archivedAt === null && (!projectId || thread.projectId === projectId));
  }

  async listArchivedThreads(): Promise<T3ThreadShell[]> {
    const live = this.liveShell("archive");
    const archived = live ? (live.archivedThreads ?? []) : await this.orFromFeed(this.readArchived(), (recovered) => recovered.archivedThreads ?? [], "archive");
    return archived.map((thread) => this.toShell(thread)).filter((thread) => thread.deletedAt === null);
  }

  /**
   * The archived thread shells without the feed: T3's HTTP shell lists none (it builds the active shell only), so they
   * are read as T3's own client reads them (orchestration.getArchivedShellSnapshot), shared and cached as the shell is.
   */
  private readArchived(): Promise<Array<Record<string, unknown>>> {
    const cached = this.archivedCache;
    if (cached && Date.now() - cached.at < this.shellCacheMs) return Promise.resolve(cached.value);
    if (this.archivedInflight) return this.archivedInflight;
    const generation = this.shellGeneration;
    const read = (async () => {
      await this.ensureProtocol();
      const started = Date.now();
      const snapshot = await this.rpc<{ threads?: Array<Record<string, unknown>> } | null>("orchestration.getArchivedShellSnapshot", {});
      const value = snapshot?.threads ?? [];
      if (this.shellGeneration === generation) this.archivedCache = { at: started, value };
      return value;
    })();
    this.archivedInflight = read;
    const done = () => {
      if (this.archivedInflight === read) this.archivedInflight = null;
    };
    read.then(done, done);
    return read;
  }

  async getThreadShell(threadId: string): Promise<T3ThreadShell | null> {
    const shell = await this.shell();
    const found = shell.threads.find((thread) => thread.id === threadId);
    return found ? this.toShell(found) : null;
  }

  async getThreadDetail(threadId: string, options: { bounded?: boolean } = {}): Promise<T3ThreadDetail | null> {
    await this.ensureProtocol();
    // A watched thread's from its latest read while its stream shows no change past it; else read now (threadFeed.ts).
    const snapshot = await this.threadFeed.detail(threadId, options.bounded === true);
    if (!snapshot) return null;
    const shell = await this.shell();
    const listed = shell.threads.find((thread) => thread.id === threadId) ?? (shell.archivedThreads ?? []).find((thread) => thread.id === threadId);
    return this.toDetail(snapshot, listed ? this.toShell(listed) : null);
  }

  /**
   * The sequence of the thread's latest change in the feed's shell that a reader of its detail can see there (anything
   * of its shell but its time): its detail is never served older, so a shell and a detail read together agree. 0 while
   * the feed is not live (the detail is read from T3 then).
   */
  private detailFloor(threadId: string): number {
    const held = this.shellFeed.live()?.held(threadId);
    if (!held) return 0;
    const key = JSON.stringify({ ...this.toShell(held.row), updatedAt: undefined });
    const known = this.detailFloors.get(threadId);
    if (known?.key === key) return known.sequence;
    this.detailFloors.set(threadId, { key, sequence: held.sequence });
    return held.sequence;
  }

  /** One read of a thread's projection from T3: its bounded window or its whole history; null when T3 has no such thread. */
  private async readThread(threadId: string, bounded: boolean): Promise<ThreadSnapshot | null> {
    await this.ensureProtocol();
    try {
      return (await this.request("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}${bounded ? "/bounded" : ""}`)) as ThreadSnapshot;
    } catch (error) {
      if (error instanceof T3CommandRejected && error.status === 404) return null;
      throw error;
    }
  }

  // ---------------- commands ----------------

  /** Legacy callers manage their own retries; receipt retention/absence is not established here. */
  private async dispatch(command: Record<string, unknown>): Promise<void> {
    await this.ensureProtocol();
    let sequence: number | undefined;
    try {
      // T3 answers with the sequence of the command's last event, the numbering its shell streams carry.
      const result = await this.rpc<{ sequence?: unknown } | null>("orchestration.dispatchCommand", command, this.requestTimeoutMs * 2);
      if (typeof result?.sequence === "number") sequence = result.sequence;
    } finally {
      this.invalidateShell(sequence);
      // A read of the thread made from now on sees the command: none made before it is served after it.
      if (typeof command.threadId === "string") this.threadFeed.command(command.threadId, sequence);
    }
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

  async setThreadTitle(input: { commandId: string; threadId: string; title: string }): Promise<void> {
    await this.dispatch({ type: "thread.metadata.update", commandId: input.commandId, threadId: input.threadId, title: input.title, regenerateTitle: false });
  }

  async setThreadModel(input: { commandId: string; threadId: string; modelSelection: ModelSelection }): Promise<void> {
    await this.dispatch({ type: "thread.model-selection.set", commandId: input.commandId, threadId: input.threadId, modelSelection: input.modelSelection });
  }

  async createProject(input: CreateProjectInput): Promise<void> {
    await this.ensureProtocol();
    try {
      await this.rpc("projects.mutate", {
        type: "project.create",
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        createWorkspaceRootIfMissing: input.createIfMissing,
      });
    } finally {
      this.invalidateShell();
    }
  }

  /** Images as T3 stores them for a message (assets.persistChatAttachments): uploaded first, then named in the message. */
  private async persistImages(threadId: string, messageId: string, images: TurnImage[] | undefined): Promise<unknown[]> {
    if (!images || images.length === 0) return [];
    const stored = await this.rpc<{ attachments: unknown[] }>(
      "assets.persistChatAttachments",
      { threadId, messageId, attachments: images.map((image) => ({ type: "image", ...image })) },
      this.requestTimeoutMs * 2,
    );
    return stored.attachments;
  }

  async launchThread(input: LaunchThreadInput): Promise<T3ThreadShell> {
    await this.ensureProtocol();
    try {
      const attachments = input.initialMessage ? await this.persistImages(input.threadId, input.initialMessage.messageId, input.initialMessage.images) : [];
      // T3 answers when the thread exists and its workspace is ready; checking out a large repository takes a while.
      const launched = await this.rpc<{ threadId: string; projection: Record<string, unknown> }>(
        "orchestration.launchThread",
        {
          commandId: input.commandId,
          creationSource: CREATION_SOURCE,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          ...(input.generateTitle ? { generateTitle: true } : {}),
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: input.workspace,
          ...(input.initialMessage ? { initialMessage: { messageId: input.initialMessage.messageId, text: input.initialMessage.text, attachments } } : {}),
        },
        300_000,
      );
      // The thread exists: reads from here on see it.
      this.invalidateShell();
      const shell = this.toDetail({ projection: launched.projection }, null).shell;
      // T3 answers once the thread exists and makes a new worktree after that (fetch, checkout, setup script). A
      // thread with a first message waits for it by itself (its run is "preparing"); one without is wanted for
      // its folder, so wait until T3 records it.
      if (input.workspace.type === "worktree" && !input.initialMessage && !shell.worktreePath) return await this.awaitWorktree(input.threadId);
      return shell;
    } finally {
      this.invalidateShell();
    }
  }

  private async awaitWorktree(threadId: string): Promise<T3ThreadShell> {
    const deadline = Date.now() + 300_000;
    let missing = 0;
    for (;;) {
      this.dropShellCache();
      const listed = await this.getThreadShell(threadId);
      if (listed?.worktreePath) return listed;
      // T3 removes a thread whose workspace it could not make.
      missing = listed ? 0 : missing + 1;
      if (missing >= 5) throw new T3CommandRejected("T3 could not make the thread's worktree, and removed the thread", 500, null);
      if (Date.now() > deadline) throw new T3CommandRejected("T3 has not finished making the thread's worktree after 5 minutes", 504, null);
      await new Promise((resolve) => setTimeout(resolve, this.worktreePollMs));
    }
  }

  async listRefs(cwd: string): Promise<{ isRepo: boolean; refs: T3Ref[] }> {
    const value = await this.rpc<{ isRepo: boolean; refs: Array<{ name: string; isRemote?: boolean; current: boolean; isDefault: boolean; worktreePath: string | null }> }>("vcs.listRefs", { cwd, limit: 200 });
    return { isRepo: value.isRepo, refs: value.refs.map((ref) => ({ name: ref.name, isRemote: ref.isRemote === true, current: ref.current, isDefault: ref.isDefault, worktreePath: ref.worktreePath ?? null })) };
  }

  async browseFolders(partialPath: string): Promise<FolderListing> {
    const value = await this.rpc<{ parentPath: string; entries: Array<{ name: string; fullPath: string }> }>("filesystem.browse", { partialPath });
    return { parentPath: value.parentPath, entries: value.entries.map((entry) => ({ name: entry.name, fullPath: entry.fullPath })) };
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.ensureProtocol();
    const attachments = await this.persistImages(input.threadId, input.messageId, input.images);
    await this.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: CREATION_SOURCE,
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      text: input.text,
      attachments,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed ? { titleSeed: input.titleSeed } : {}),
      dispatchMode:
        input.mode.type === "steer"
          ? { type: "steer_active", targetRunId: input.mode.runId }
          : input.mode.type === "queue"
            ? { type: "queue_after_active" }
            : { type: "start_immediately" },
    });
  }

  async pullRequestChecks(input: { projectId: string; host: string | null; repository: string; number: number }): Promise<T3PullRequestChecks | null> {
    await this.ensureProtocol();
    // T3's cached read when it has one: a hover is no reason to ask the host again.
    const result = await this.rpc<{ observedAt?: unknown; checks?: unknown } | null>("pullRequests.checks", { projectId: input.projectId, ...(input.host ? { host: input.host } : {}), repository: input.repository, number: input.number, allowStale: true });
    if (!result || !Array.isArray(result.checks)) return null;
    return {
      observedAt: typeof result.observedAt === "number" && Number.isFinite(result.observedAt) ? new Date(result.observedAt).toISOString() : null,
      checks: (result.checks as Array<Record<string, unknown>>).filter((c) => typeof c.name === "string" && CHECK_STATUSES.has(String(c.status))).map((c) => ({ name: c.name as string, status: c.status as T3PullRequestChecks["checks"][number]["status"], required: c.required === true })),
    };
  }

  async controlThread(input: { commandId: string; threadId: string; control: ThreadControl }): Promise<void> {
    const { commandId, threadId, control } = input;
    switch (control.type) {
      case "limit.arm":
        await this.dispatch({ type: "thread.metadata.update", commandId, threadId, limitRecovery: { runId: control.runId, resetAt: control.resetAt, autoResume: true, snooze: false } });
        return;
      case "run.continue":
        await this.dispatch({ type: "message.dispatch", commandId, messageId: commandId, threadId, manualContinuationOfRunId: control.runId, text: CONTINUE_TEXT, attachments: [], dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: CREATION_SOURCE });
        return;
      case "queue.resume":
        await this.dispatch({ type: "queue.resume", commandId, threadId });
        return;
      case "thread.stop":
        // Delegated tasks under the thread are stopped too (T3's default).
        await this.dispatch({ type: "thread.stop", commandId, threadId, reason: STOP_EVERYTHING_REASON });
        return;
      case "subagent.stop":
        await this.dispatch({ type: "subagent.stop", commandId, threadId, runId: control.runId, subagentId: control.subagentId });
        return;
    }
  }

  async interruptRun(input: { commandId: string; threadId: string; runId: string | null }): Promise<void> {
    const runId = input.runId ?? (await this.getThreadShell(input.threadId))?.activeRunId ?? null;
    if (!runId) return;
    await this.dispatch({ type: "run.interrupt", commandId: input.commandId, threadId: input.threadId, runId });
  }

  async respondApproval(input: { commandId: string; threadId: string; requestId: string; decision: ApprovalDecision }): Promise<void> {
    await this.dispatch({ type: "runtime-request.respond", commandId: input.commandId, threadId: input.threadId, requestId: input.requestId, decision: input.decision });
  }

  async respondUserInput(input: { commandId: string; threadId: string; requestId: string; answers: Record<string, unknown> }): Promise<void> {
    await this.dispatch({ type: "runtime-request.respond", commandId: input.commandId, threadId: input.threadId, requestId: input.requestId, answers: input.answers });
  }

  async respondSecret(input: { threadId: string; turnItemId: string; answer: SecretAnswer }): Promise<void> {
    try {
      await this.rpc("secrets.answerRequest", { threadId: input.threadId, turnItemId: input.turnItemId, answer: input.answer });
    } catch (error) {
      throw secretFailure(error);
    }
  }

  async dismissUserInput(input: { commandId: string; threadId: string; requestId: string }): Promise<void> {
    await this.dispatch({ type: "thread.user-input.dismiss", commandId: input.commandId, threadId: input.threadId, requestId: input.requestId });
  }

  async setRuntimeMode(input: { commandId: string; threadId: string; runtimeMode: T3ThreadShell["runtimeMode"] }): Promise<void> {
    await this.dispatch({ type: "thread.runtime-mode.set", commandId: input.commandId, threadId: input.threadId, runtimeMode: input.runtimeMode });
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
