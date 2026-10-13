/**
 * T3's threads as T3 streams their changes: a watched thread's detail is read from T3 once per change, and that read is
 * shared by every caller until the next one, instead of each caller (the engine's tick, every open page) reading it.
 *
 * On the shell feed's socket (src/adapter/shellFeed.ts), once that is live: one orchestration.subscribeThread per
 * watched thread, each its own request on the one connection, every chunk acknowledged, interrupted when the thread is
 * no longer watched. T3 numbers a thread's events with its event sequence, the numbering of its thread reads too (their
 * snapshotSequence is the thread's latest event) and of its shell streams:
 *
 *   {kind: "event", sequence, event}         one per change of the thread (T3 coalesces a running turn's deltas)
 *   {kind: "synchronized"}                   once what the subscription replays is sent (requestCompletionMarker)
 *   {kind: "snapshot", snapshotSequence, …}  in place of the replay when the gap is too long for one (over 128 events
 *                                            or 1 MiB); asked for bounded and compact, and used for its sequence only
 *
 * T3's reducer is not ported: an event only says that the thread moved, and to which sequence. A subscription starts
 * after the sequence of the thread's latest read (afterSequence), so T3 replays the events since that read (mostly
 * none) rather than sending its snapshot, megabytes for a long thread even bounded: a thread with no read yet is read
 * once before it is subscribed to.
 *
 * Watched: every thread a room seats (the engine host holds them), and every thread whose detail a page read in the last
 * 60 s (each such read renews its lease; the overview's describing reads lease nothing). A thread nothing holds or
 * leases any more keeps its stream 30 s longer, then it is interrupted: a page that still shows it reads it again
 * within that (its fallback timer runs a minute from its last answer), so it is neither dropped nor subscribed again.
 *
 * A watched thread's detail while its stream is live (synchronized, on the feed's current socket):
 * - Each kind (bounded, the recent window; full, the whole history) is cached with the sequence its read reflects:
 *   T3's snapshotSequence, or the latest the stream had shown when the read was sent if that is later (T3 streams only
 *   what it has stored, and a read sees what is stored). A cached read only gives way to a newer one.
 * - The stream showing a sequence past the cached bounded read has it read again: at once after a quiet spell, then at
 *   most once per 2 s per thread while the thread keeps moving, and once more after the last change. An event the
 *   cached read already covers, or one shown again, reads nothing; one that comes during a read is read after it.
 * - Every caller gets the cached detail: during a burst, up to the throttle behind the stream. A full detail is never
 *   older than the bounded one (a caller that saw the bounded detail and asks for the full gets one at least as new):
 *   it is read again once a bounded read has moved past it.
 * - A command on the thread (one of this adapter's) has the next read of each kind made afresh, at once.
 * - Each newer bounded read is told (onChange) once it is cached: the engine host wakes, open pages read again.
 * Read from T3 as before (shared with a read of the same kind in flight, and cached for later): a thread nobody watches,
 * one whose stream is not live yet (so after a reconnect the cache is trusted again only once T3 has replayed what it
 * missed), one T3 refuses to stream (logged; asked again later; its pages keep their old cadence), every thread while
 * the feed is down, and any thread after a read of it failed, until one succeeds.
 */
import type { FeedConnection } from "./shellFeed.ts";

/** A thread read as T3's HTTP routes answer it (GET /api/orchestration/threads/:id and …/bounded). */
export interface ThreadSnapshot {
  snapshotSequence?: number;
  projection: Record<string, unknown>;
  hasMoreHistory?: boolean;
}

export const THREAD_STREAM = "orchestration.subscribeThread";
/** How long a page's read of a thread keeps it watched. */
export const THREAD_LEASE_MS = 60_000;
/** How long a thread nothing watches keeps its stream before it is interrupted. */
export const THREAD_LINGER_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;

export interface ThreadWatchesOptions {
  /** A thread became watched. */
  onWatch: (threadId: string) => void;
  /** A thread is no longer watched. */
  onUnwatch: (threadId: string) => void;
  leaseMs?: number;
  lingerMs?: number;
  now?: () => number;
}

/**
 * Which threads are watched: those an owner holds (the engine host holds its seats' threads, the whole set at each
 * tick), and those a page's read leased (for leaseMs from the read). One nothing holds or leases any more stays
 * watched lingerMs longer, and is unwatched then unless held or leased again meanwhile.
 */
export class ThreadWatches {
  private readonly options: ThreadWatchesOptions;
  private readonly leaseMs: number;
  private readonly lingerMs: number;
  private readonly now: () => number;
  /** Per owner, the threads it holds. */
  private readonly held = new Map<string, Set<string>>();
  private readonly watched = new Map<string, { owners: Set<string>; leaseUntil: number; timer: Timer | null }>();

  constructor(options: ThreadWatchesOptions) {
    this.options = options;
    this.leaseMs = options.leaseMs ?? THREAD_LEASE_MS;
    this.lingerMs = options.lingerMs ?? THREAD_LINGER_MS;
    this.now = options.now ?? Date.now;
  }

  /** The threads `owner` holds from now on, in place of those it held before. */
  hold(owner: string, threadIds: Iterable<string>): void {
    const next = new Set(threadIds);
    const before = this.held.get(owner) ?? new Set<string>();
    if (next.size > 0) this.held.set(owner, next);
    else this.held.delete(owner);
    for (const id of next) {
      if (before.has(id)) continue;
      const watch = this.watch(id);
      watch.owners.add(owner);
      this.settle(id, watch);
    }
    for (const id of before) {
      if (next.has(id)) continue;
      const watch = this.watched.get(id);
      if (!watch) continue;
      watch.owners.delete(owner);
      this.settle(id, watch);
    }
  }

  /** A page read the thread: watched for leaseMs from now. */
  lease(threadId: string): void {
    const watch = this.watch(threadId);
    watch.leaseUntil = Math.max(watch.leaseUntil, this.now() + this.leaseMs);
    this.settle(threadId, watch);
  }

  has(threadId: string): boolean {
    return this.watched.has(threadId);
  }

  get size(): number {
    return this.watched.size;
  }

  /** Forget every watch, telling nobody (the adapter is closing). */
  close(): void {
    for (const watch of this.watched.values()) if (watch.timer) clearTimeout(watch.timer);
    this.watched.clear();
    this.held.clear();
  }

  private watch(threadId: string): { owners: Set<string>; leaseUntil: number; timer: Timer | null } {
    let watch = this.watched.get(threadId);
    if (!watch) {
      watch = { owners: new Set(), leaseUntil: 0, timer: null };
      this.watched.set(threadId, watch);
      this.options.onWatch(threadId);
    }
    return watch;
  }

  /** The end of a thread's watch: none while an owner holds it, else lingerMs after its lease ends (or after now). */
  private settle(threadId: string, watch: { owners: Set<string>; leaseUntil: number; timer: Timer | null }): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    if (watch.owners.size > 0) return;
    const end = Math.max(watch.leaseUntil, this.now()) + this.lingerMs;
    // Every hold and lease arms it again: when it fires, the watch has ended.
    watch.timer = setTimeout(() => {
      watch.timer = null;
      if (this.watched.get(threadId) !== watch || watch.owners.size > 0) return;
      this.watched.delete(threadId);
      this.options.onUnwatch(threadId);
    }, end - this.now());
    watch.timer.unref?.();
  }
}

/** What the feed needs of a read: the sequence T3 read it at. */
type Read = { snapshotSequence?: number };

export interface ThreadFeedOptions<S extends Read = ThreadSnapshot> {
  /** One read of the thread from T3 (its bounded window or its whole history); null when T3 has no such thread. */
  read: (threadId: string, bounded: boolean) => Promise<S | null>;
  /** A watched thread's cached detail moved on (a newer bounded read is in): told once it is cached. */
  onChange: (threadId: string) => void;
  log?: (message: string, detail?: unknown) => void;
  /** The least time between two reads a thread's events cause. Default 2 s. */
  throttleMs?: number;
  leaseMs?: number;
  lingerMs?: number;
  /** The wait before T3 is asked again for a stream it refused or ended: doubling from retryMs up to retryMaxMs (30 s, 5 min). */
  retryMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

type Kind = "bounded" | "full";

/** A read of a thread: what T3 answered, the sequence it reflects, T3's own sequence for it, and the commands before it. */
interface Entry<S> {
  snapshot: S | null;
  sequence: number;
  read: number | null;
  gen: number;
}

interface Stream {
  connection: FeedConnection;
  cancel: () => void;
  /** T3 has sent what it replays: from here on the stream shows every change. */
  synced: boolean;
}

/** One watched thread. */
class Thread<S> {
  stream: Stream | null = null;
  /** T3 refused (or ended) its stream: how often in a row, why last, and the timer of the next try. */
  refusals = 0;
  refused: string | null = null;
  retry: Timer | null = null;
  /** The highest sequence T3 has shown for it: on its stream, in a read, or as a command's. */
  latest = 0;
  /** Bumped by each command on the thread: a read sent before it is not served after it. */
  gen = 0;
  readonly cache: Record<Kind, Entry<S> | null> = { bounded: null, full: null };
  readonly reading: Record<Kind, { promise: Promise<S | null>; gen: number } | null> = { bounded: null, full: null };
  /** The latest read failed: callers read for themselves until one succeeds. */
  failed = false;
  /** When the latest bounded read was sent, and the timer of the next one its events are owed. */
  lastRead = Number.NEGATIVE_INFINITY;
  timer: Timer | null = null;
}

/** Thread details from T3's thread streams, for the threads watched (see the header). */
export class ThreadFeed<S extends Read = ThreadSnapshot> {
  private readonly options: ThreadFeedOptions<S>;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private connection: FeedConnection | null = null;
  private readonly threads = new Map<string, Thread<S>>();
  private readonly watches: ThreadWatches;

  constructor(options: ThreadFeedOptions<S>) {
    this.options = options;
    this.throttleMs = options.throttleMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.watches = new ThreadWatches({
      onWatch: (id) => this.watched(id),
      onUnwatch: (id) => this.unwatched(id),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.lingerMs === undefined ? {} : { lingerMs: options.lingerMs }),
      now: this.now,
    });
  }

  hold(owner: string, threadIds: Iterable<string>): void {
    this.watches.hold(owner, threadIds);
  }

  lease(threadId: string): void {
    this.watches.lease(threadId);
  }

  /** Whether the thread's changes are told (onChange): watched, the feed live, and T3 not refusing its stream. */
  pushed(threadId: string): boolean {
    const thread = this.threads.get(threadId);
    return Boolean(thread && this.connection && !this.connection.closed && thread.refused === null);
  }

  /** How many threads are watched, how many of their streams are live, and how many T3 refuses. */
  status(): { watched: number; live: number; refused: number } {
    let live = 0;
    let refused = 0;
    for (const thread of this.threads.values()) {
      if (this.live(thread)) live += 1;
      if (thread.refused !== null) refused += 1;
    }
    return { watched: this.threads.size, live, refused };
  }

  /** The feed's socket once it is live, or null once it goes: every watched thread is subscribed to on it. */
  connect(connection: FeedConnection | null): void {
    if (connection === this.connection) return;
    this.connection = connection;
    for (const [id, thread] of this.threads) {
      this.unsubscribe(thread);
      if (thread.retry) clearTimeout(thread.retry);
      thread.retry = null;
      thread.refusals = 0;
      thread.refused = null;
      if (connection) this.subscribe(id, thread);
    }
  }

  /** A command on the thread was answered (with T3's sequence for it, when it gave one): the next reads are fresh. */
  command(threadId: string, sequence?: number): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.gen += 1;
    if (typeof sequence === "number") thread.latest = Math.max(thread.latest, sequence);
  }

  /** The thread's detail, bounded or whole: as the header says, from the cache or from T3. */
  async detail(threadId: string, bounded: boolean): Promise<S | null> {
    const kind: Kind = bounded ? "bounded" : "full";
    const thread = this.threads.get(threadId);
    if (!thread) return await this.options.read(threadId, bounded);
    const entry = thread.cache[kind];
    if (this.live(thread) && !thread.failed && entry && entry.gen === thread.gen && (kind === "bounded" || this.fullCurrent(thread, entry))) return entry.snapshot;
    return await this.read(threadId, thread, kind);
  }

  close(): void {
    this.watches.close();
    for (const thread of this.threads.values()) this.drop(thread);
    this.threads.clear();
    this.connection = null;
  }

  /** A full read may be served while it is not older than the bounded one (of the same commands). */
  private fullCurrent(thread: Thread<S>, entry: Entry<S>): boolean {
    const bounded = thread.cache.bounded;
    return entry.sequence >= thread.latest || !bounded || bounded.gen !== thread.gen || entry.sequence >= bounded.sequence;
  }

  private live(thread: Thread<S>): boolean {
    const stream = thread.stream;
    return stream !== null && stream.synced && stream.connection === this.connection && !stream.connection.closed;
  }

  private watched(id: string): void {
    const thread = new Thread<S>();
    this.threads.set(id, thread);
    this.subscribe(id, thread);
  }

  private unwatched(id: string): void {
    const thread = this.threads.get(id);
    if (!thread) return;
    this.threads.delete(id);
    this.drop(thread);
  }

  private drop(thread: Thread<S>): void {
    this.unsubscribe(thread);
    if (thread.retry) clearTimeout(thread.retry);
    thread.retry = null;
  }

  private unsubscribe(thread: Thread<S>): void {
    const stream = thread.stream;
    thread.stream = null;
    stream?.cancel();
    if (thread.timer) clearTimeout(thread.timer);
    thread.timer = null;
  }

  /** Subscribe on the feed's socket, after the thread's latest read (made first when there is none). */
  private subscribe(id: string, thread: Thread<S>): void {
    const connection = this.connection;
    if (!connection || connection.closed || thread.stream || thread.retry) return;
    const open = () => {
      if (this.connection !== connection || connection.closed || this.threads.get(id) !== thread || thread.stream || thread.retry) return;
      const reads = [thread.cache.bounded?.read, thread.cache.full?.read].filter((read): read is number => typeof read === "number");
      const after = reads.length > 0 ? Math.max(...reads) : null;
      const stream: Stream = { connection, cancel: () => undefined, synced: false };
      thread.stream = stream;
      const subscription = connection.stream(
        THREAD_STREAM,
        { threadId: id, ...(after === null ? {} : { afterSequence: after }), acceptBoundedSnapshot: true, acceptCompactTurnItems: true, requestCompletionMarker: true },
        (values) => this.values(id, thread, stream, values),
      );
      stream.cancel = subscription.cancel;
      subscription.done.then(
        () => this.ended(id, thread, stream, null),
        (error: unknown) => this.ended(id, thread, stream, error),
      );
    };
    if (thread.cache.bounded || thread.cache.full) open();
    else this.read(id, thread, "bounded").then(open, open);
  }

  private values(id: string, thread: Thread<S>, stream: Stream, values: unknown[]): void {
    if (thread.stream !== stream || this.threads.get(id) !== thread) return;
    for (const value of values) {
      const item = (value ?? {}) as { kind?: unknown; sequence?: unknown; snapshotSequence?: unknown };
      if (item.kind === "synchronized" && !stream.synced) {
        stream.synced = true;
        thread.refusals = 0;
        thread.refused = null;
      }
      const sequence = typeof item.sequence === "number" ? item.sequence : typeof item.snapshotSequence === "number" ? item.snapshotSequence : null;
      if (sequence !== null) thread.latest = Math.max(thread.latest, sequence);
    }
    if (stream.synced) this.owed(id, thread);
  }

  /** T3 ended the stream: the socket went (the shell feed reconnects, and connect subscribes again), or T3 refused it. */
  private ended(id: string, thread: Thread<S>, stream: Stream, error: unknown): void {
    if (thread.stream !== stream) return;
    thread.stream = null;
    if (thread.timer) clearTimeout(thread.timer);
    thread.timer = null;
    if (this.connection !== stream.connection || stream.connection.closed || this.threads.get(id) !== thread) return;
    thread.refusals += 1;
    thread.refused = error === null ? "T3 ended the thread's stream" : error instanceof Error ? error.message : String(error);
    const delay = Math.min(this.options.retryMaxMs ?? 300_000, (this.options.retryMs ?? 30_000) * 2 ** (thread.refusals - 1));
    this.options.log?.("t3 thread stream refused: its detail is read from T3 directly", { threadId: id, error: thread.refused, retryInMs: delay });
    thread.retry = setTimeout(() => {
      thread.retry = null;
      if (this.threads.get(id) === thread) this.subscribe(id, thread);
    }, delay);
    thread.retry.unref?.();
  }

  /** A read of the thread, shared with one of the same kind in flight since the latest command; cached once in. */
  private read(id: string, thread: Thread<S>, kind: Kind): Promise<S | null> {
    const inFlight = thread.reading[kind];
    if (inFlight && inFlight.gen === thread.gen) return inFlight.promise;
    const gen = thread.gen;
    const shown = thread.latest;
    if (kind === "bounded") thread.lastRead = this.now();
    const done = () => {
      if (thread.reading[kind]?.promise === promise) thread.reading[kind] = null;
    };
    const promise = this.options.read(id, kind === "bounded").then(
      (snapshot) => {
        done();
        thread.failed = false;
        this.store(id, thread, kind, snapshot, gen, shown);
        return snapshot;
      },
      (error: unknown) => {
        done();
        thread.failed = true;
        throw error;
      },
    );
    thread.reading[kind] = { promise, gen };
    return promise;
  }

  private store(id: string, thread: Thread<S>, kind: Kind, snapshot: S | null, gen: number, shown: number): void {
    if (this.threads.get(id) !== thread) return;
    const read = typeof snapshot?.snapshotSequence === "number" ? snapshot.snapshotSequence : null;
    const sequence = Math.max(read ?? Number.NEGATIVE_INFINITY, shown);
    thread.latest = Math.max(thread.latest, sequence);
    const held = thread.cache[kind];
    if (!held || sequence > held.sequence || (sequence === held.sequence && gen > held.gen)) {
      thread.cache[kind] = { snapshot, sequence, read, gen };
      if (kind === "bounded" && held && sequence > held.sequence && this.live(thread)) this.options.onChange(id);
    }
    if (kind === "bounded" && this.live(thread)) this.owed(id, thread);
  }

  /** The stream has shown a sequence past the cached bounded read: read it, throttled. */
  private owed(id: string, thread: Thread<S>): void {
    const entry = thread.cache.bounded;
    if (entry && entry.sequence >= thread.latest) return;
    // One read at a time per thread: the one in flight, or the one already timed, looks again when it is in.
    if (thread.timer || thread.reading.bounded) return;
    const run = () => {
      thread.timer = null;
      if (this.threads.get(id) !== thread || !this.live(thread)) return;
      const cached = thread.cache.bounded;
      if (cached && cached.sequence >= thread.latest) return;
      this.read(id, thread, "bounded").catch(() => undefined);
    };
    const wait = thread.lastRead + this.throttleMs - this.now();
    if (wait <= 0) return run();
    thread.timer = setTimeout(run, wait);
    thread.timer.unref?.();
  }
}
