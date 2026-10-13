/**
 * T3's shell as T3 streams it, kept live so the adapter's shell reads (projects, threads, archived threads) need no
 * HTTP snapshot while the stream holds.
 *
 * Over its WebSocket RPC T3 streams the active shell (orchestration.subscribeShell) and the archived one
 * (orchestration.subscribeArchivedShell). Each opens with a snapshot and then sends one change per project or thread
 * (the newest of each 50 ms), numbered with T3's event sequence, the numbering of the snapshots too:
 *
 *   active:   snapshot {snapshot: {schemaVersion, snapshotSequence, projects, threads, archivedThreads: []}}
 *             snapshot {snapshot: {projects, threads: []}, resolvedRepositoryIdentityRoots}   (projects' repository
 *               identity resolved since: patched in, nothing else replaced)
 *             project.updated {sequence, project}       project.removed {sequence, projectId}
 *             thread.updated {sequence, location: "active", thread}   thread.removed {sequence, location, threadId}
 *             synchronized                                (only when asked for; not asked for here)
 *   archived: snapshot {snapshot: {snapshotSequence, projects, threads}}   (the archived threads)
 *             thread.updated {sequence, thread}      thread.removed {sequence, threadId}
 *
 * Archived threads are only on the second stream: T3 builds the active snapshot, its HTTP one included, with no
 * archived threads, and sends thread.removed on the active stream when a thread is archived. Archiving or unarchiving
 * a thread is a removal on one stream and an update on the other, at the same sequence, in either order: so each
 * thread is held once, with where it is and the sequence of what set it. An update takes it from either stream unless
 * what is held is newer; a removal takes it out only from where the removing stream has it. A thread is never in both
 * lists, and a late change never overwrites a newer one.
 *
 * Reads get the lists in the order T3's HTTP snapshot has them (its SQL): threads by updatedAt, then id; projects by
 * createdAt, then id.
 *
 * One limit, T3's: its stream drops a thread update that differs from the last one it sent only in updatedAt while
 * that send is under 5 s old, and sends nothing to catch up afterwards (skipUnchangedThreadShells in its
 * ShellStream.ts; such updates come with every item of a running turn). So a thread's updatedAt here can be up to 5 s
 * older than T3's, and stays so until the thread's next change T3 streams or a reconnect; a change to anything else in
 * a thread's shell always comes. Backroom shows updatedAt only as the minute-rounded age of a thread with no finished
 * run, and keeps T3's order (by updatedAt) for the loose threads of one kind on the overview, where two threads updated
 * within the same few seconds can trade places; the engine host does not read it.
 */
import type { T3ShellChange, T3ShellFeedStatus } from "./types.ts";
import { T3Unavailable } from "./types.ts";

type Row = Record<string, unknown>;

/** T3's shell snapshot, as GET /api/orchestration/shell answers it. */
export interface ShellSnapshot {
  schemaVersion?: number;
  snapshotSequence: number;
  projects: Row[];
  threads: Row[];
  archivedThreads?: Row[];
}

type Location = "active" | "archive";

const compare = (a: unknown, b: unknown): number => {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  return x < y ? -1 : x > y ? 1 : 0;
};
const threadOrder = (a: Row, b: Row): number => compare(a.updatedAt, b.updatedAt) || compare(a.id, b.id);
const projectOrder = (a: Row, b: Row): number => compare(a.createdAt, b.createdAt) || compare(a.id, b.id);
const duration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/**
 * The shell built from one connection's two streams. `apply` takes one streamed value and says what it changed: the
 * threads, none (projects only), all (a snapshot), or nothing (undefined).
 */
export class ShellState {
  /** The highest sequence applied, from either stream. */
  sequence = 0;
  /**
   * The sequence the active stream has reached. Every change to the shell is told there, an archived thread's as its
   * removal: the shell has caught up with a command once this has reached the command's sequence.
   */
  get activeSequence(): number {
    return this.reached.active ?? 0;
  }
  /** The sequence the archived stream has reached: the archived list has caught up with a command once it is there. */
  get archiveSequence(): number {
    return this.reached.archive ?? 0;
  }
  private schemaVersion: number | undefined;
  /** Per stream, the sequence its snapshot and changes have reached; null until its snapshot is in. */
  private readonly reached: Record<Location, number | null> = { active: null, archive: null };
  private readonly projects = new Map<string, Row>();
  private readonly threads = new Map<string, { row: Row; location: Location; sequence: number }>();
  private built: ShellSnapshot | null = null;

  /** Both snapshots are in: the shell is whole. */
  get whole(): boolean {
    return this.reached.active !== null && this.reached.archive !== null;
  }

  apply(stream: Location, value: unknown): T3ShellChange | undefined {
    const item = (value ?? {}) as { kind?: unknown; sequence?: unknown; location?: unknown; thread?: Row; threadId?: unknown; project?: Row; projectId?: unknown; snapshot?: ShellSnapshot; resolvedRepositoryIdentityRoots?: unknown };
    if (item.kind === "snapshot" && item.snapshot) return this.snapshot(stream, item.snapshot, item.resolvedRepositoryIdentityRoots !== undefined);
    const reached = this.reached[stream];
    const sequence = typeof item.sequence === "number" ? item.sequence : null;
    // A change before its stream's snapshot, or one the stream has gone past, changes nothing (T3's client skips them too).
    if (reached === null || sequence === null || sequence <= reached) return undefined;
    this.reached[stream] = sequence;
    this.sequence = Math.max(this.sequence, sequence);
    const change = this.change(stream, item, sequence);
    if (change) this.built = null;
    return change;
  }

  private change(stream: Location, item: { kind?: unknown; location?: unknown; thread?: Row; threadId?: unknown; project?: Row; projectId?: unknown }, sequence: number): T3ShellChange | undefined {
    switch (item.kind) {
      case "project.updated":
        if (stream !== "active" || typeof item.project?.id !== "string") return undefined;
        this.projects.set(item.project.id, item.project);
        return { threadIds: [] };
      case "project.removed":
        if (stream !== "active" || typeof item.projectId !== "string" || !this.projects.delete(item.projectId)) return undefined;
        return { threadIds: [] };
      case "thread.updated": {
        const id = item.thread?.id;
        if (typeof id !== "string") return undefined;
        // On the active stream, an update placed anywhere but there takes the thread out of it (as T3's client reads it).
        if (stream === "active" && item.location !== "active") return this.remove(id, "active", sequence);
        const held = this.threads.get(id);
        if (held && held.sequence > sequence) return undefined;
        this.threads.set(id, { row: item.thread!, location: stream, sequence });
        return { threadIds: [id] };
      }
      case "thread.removed":
        return typeof item.threadId === "string" ? this.remove(item.threadId, stream, sequence) : undefined;
      default:
        return undefined;
    }
  }

  private remove(id: string, from: Location, sequence: number): T3ShellChange | undefined {
    const held = this.threads.get(id);
    if (!held || held.location !== from || held.sequence > sequence) return undefined;
    this.threads.delete(id);
    return { threadIds: [id] };
  }

  private snapshot(stream: Location, snapshot: ShellSnapshot, enrichment: boolean): T3ShellChange | undefined {
    const at = typeof snapshot.snapshotSequence === "number" ? snapshot.snapshotSequence : 0;
    if (enrichment) {
      // Projects whose repository identity T3 has resolved since: only that is new in them.
      if (stream !== "active") return undefined;
      let patched = false;
      for (const project of snapshot.projects ?? []) {
        const held = typeof project.id === "string" ? this.projects.get(project.id) : undefined;
        if (!held) continue;
        this.projects.set(project.id as string, { ...held, repositoryIdentity: project.repositoryIdentity ?? null });
        patched = true;
      }
      if (!patched) return undefined;
      this.built = null;
      return { threadIds: [] };
    }
    if (stream === "active") {
      this.schemaVersion = snapshot.schemaVersion;
      this.projects.clear();
      for (const project of snapshot.projects ?? []) if (typeof project.id === "string") this.projects.set(project.id, project);
    }
    const listed = new Set<string>();
    for (const row of (stream === "active" ? snapshot.threads : (snapshot.threads ?? snapshot.archivedThreads)) ?? []) {
      if (typeof row.id !== "string") continue;
      listed.add(row.id);
      const held = this.threads.get(row.id);
      if (held && held.sequence > at) continue;
      this.threads.set(row.id, { row, location: stream, sequence: at });
    }
    for (const [id, held] of this.threads) if (held.location === stream && !listed.has(id) && held.sequence <= at) this.threads.delete(id);
    this.reached[stream] = Math.max(this.reached[stream] ?? 0, at);
    this.sequence = Math.max(this.sequence, at);
    this.built = null;
    return { threadIds: null };
  }

  /** The shell as T3's HTTP snapshot has it, its archived threads included. Built once per change. */
  read(): ShellSnapshot {
    if (!this.built) {
      const active: Row[] = [];
      const archived: Row[] = [];
      for (const held of this.threads.values()) (held.location === "active" ? active : archived).push(held.row);
      this.built = {
        ...(this.schemaVersion === undefined ? {} : { schemaVersion: this.schemaVersion }),
        snapshotSequence: this.sequence,
        projects: [...this.projects.values()].sort(projectOrder),
        threads: active.sort(threadOrder),
        archivedThreads: archived.sort(threadOrder),
      };
    }
    return this.built;
  }
}

/** What the feed needs of an RPC socket (src/adapter/http.ts RpcConnection). */
export interface FeedConnection {
  readonly closed: boolean;
  /** When T3 last sent anything on it. */
  readonly heardAt: number;
  stream(tag: string, payload: unknown, onValues: (values: unknown[]) => void): { done: Promise<void>; cancel: () => void };
  ping(): void;
  close(): void;
}

export interface ShellFeedOptions {
  /** Open a socket of the feed's own; `onEnd` is called when it closes or fails. */
  connect: (onEnd: () => void) => Promise<FeedConnection>;
  /** A change was applied to the live shell; becoming live counts as one, naming no thread. */
  onChange: (change: T3ShellChange) => void;
  /**
   * A chunk was applied to the live shell, after onChange when it changed anything: a stream's sequence may have moved
   * with no change (a removal of what the other stream already moved, a change T3 tells again).
   */
  onApplied?: () => void;
  /** feed() changed: its state, or the error that keeps it down. */
  onStatus?: (status: T3ShellFeedStatus) => void;
  /** How long T3 may take, once asked, to send both snapshots. Default 30 s. */
  timeoutMs?: number;
  /** How often the open socket is pinged; one silent for three of these counts as gone. Default 5 s. */
  pingMs?: number;
  /** The wait before reconnecting after a failure: doubling from `retryMs` up to `retryMaxMs` (1 s, 15 s). */
  retryMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

/**
 * The live shell over a socket of its own: subscribes to both streams, holds what they send, and reconnects (with
 * backoff, on a fresh ticket) when the socket goes, a subscription fails or ends, or T3 falls silent. The shell is
 * served only while it is whole and the socket holds: `live()` is null otherwise, and the adapter reads over HTTP then.
 */
export class ShellFeed {
  private readonly options: ShellFeedOptions;
  private readonly timeoutMs: number;
  private readonly pingMs: number;
  private readonly now: () => number;
  private running = false;
  /** Bumped by every connection attempt and by stop: a callback of an earlier attempt finds it changed and does nothing. */
  private attempt = 0;
  private failures = 0;
  private state: T3ShellFeedStatus;
  private shell: ShellState | null = null;
  private connection: FeedConnection | null = null;
  private cancels: Array<() => void> = [];
  /** The current attempt's timers not yet run: its deadline for the snapshots, its next ping. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ShellFeedOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pingMs = options.pingMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.state = { state: "down", since: new Date(this.now()).toISOString(), error: "not started" };
  }

  status(): T3ShellFeedStatus {
    return { ...this.state };
  }

  get started(): boolean {
    return this.running;
  }

  /** The live shell, or null while the feed is not connected. */
  live(): ShellState | null {
    return this.state.state === "connected" ? this.shell : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.set("connecting", null);
    this.open();
  }

  /**
   * Open again at once (on another credential): what was live stops being served until the new socket's snapshots are
   * in. It goes straight to connecting, never through stopped.
   */
  restart(): void {
    if (!this.running) return;
    this.halt();
    this.start();
  }

  stop(): void {
    this.halt();
    this.set("down", "stopped");
  }

  private halt(): void {
    this.running = false;
    this.attempt += 1;
    this.teardown();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private set(state: T3ShellFeedStatus["state"], error: string | null): void {
    if (this.state.state === state && this.state.error === error) return;
    if (this.state.state !== state) this.state = { state, since: new Date(this.now()).toISOString(), error };
    else this.state = { ...this.state, error };
    this.options.onStatus?.(this.status());
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private open(): void {
    const attempt = ++this.attempt;
    const fail = (error: unknown) => this.fail(attempt, error);
    this.later(this.timeoutMs, () => {
      if (this.shell === null) fail(new T3Unavailable(`T3 did not send its shell within ${duration(this.timeoutMs)}`));
    });
    // Until the socket is handed over, a failure to open it is told by connect itself (the end comes first, saying
    // less); one that closes before it is handed over fails its subscriptions at once.
    let handed = false;
    this.options.connect(() => {
      if (handed) fail(new T3Unavailable("T3 closed the connection"));
    }).then((connection) => {
      if (attempt !== this.attempt) {
        connection.close();
        return;
      }
      handed = true;
      this.connection = connection;
      const state = new ShellState();
      const deliver = (stream: Location) => (values: unknown[]) => {
        if (attempt !== this.attempt) return;
        let threadIds: Set<string> | null = new Set();
        let changed = false;
        for (const value of values) {
          const change = state.apply(stream, value);
          if (!change) continue;
          changed = true;
          if (change.threadIds === null) threadIds = null;
          else if (threadIds) for (const id of change.threadIds) threadIds.add(id);
        }
        if (this.shell === null && state.whole) {
          this.shell = state;
          this.failures = 0;
          this.set("connected", null);
          this.heartbeat(attempt, connection);
          this.options.onChange({ threadIds: null });
          this.options.onApplied?.();
          return;
        }
        if (this.shell !== state) return;
        if (changed) this.options.onChange({ threadIds: threadIds ? [...threadIds] : null });
        this.options.onApplied?.();
      };
      for (const [tag, stream] of [["orchestration.subscribeShell", "active"], ["orchestration.subscribeArchivedShell", "archive"]] as const) {
        const subscription = connection.stream(tag, {}, deliver(stream));
        this.cancels.push(subscription.cancel);
        subscription.done.then(() => fail(new T3Unavailable(`T3 ended ${tag}`)), fail);
      }
    }, fail);
  }

  /** Ping the open socket; one T3 has sent nothing on for three pings counts as gone. */
  private heartbeat(attempt: number, connection: FeedConnection): void {
    const beat = () => {
      if (attempt !== this.attempt) return;
      if (this.now() - connection.heardAt > 3 * this.pingMs) {
        this.fail(attempt, new T3Unavailable(`T3 has not answered on the shell feed for ${duration(3 * this.pingMs)}`));
        return;
      }
      connection.ping();
      this.later(this.pingMs, beat);
    };
    this.later(this.pingMs, beat);
  }

  private fail(attempt: number, error: unknown): void {
    if (attempt !== this.attempt || !this.running) return;
    this.attempt += 1;
    this.teardown();
    this.set("down", error instanceof Error ? error.message : String(error));
    this.failures += 1;
    const delay = Math.min(this.options.retryMaxMs ?? 15_000, (this.options.retryMs ?? 1_000) * 2 ** (this.failures - 1));
    // stop() clears it: a stopped feed opens nothing.
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
    this.retry.unref?.();
  }

  private teardown(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.connection?.close();
    this.connection = null;
    this.shell = null;
  }
}
