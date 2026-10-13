/**
 * What open pages are told, pushed over GET /api/events (src/server/http.ts) so they read again at once instead of on a
 * timer: a room changed (`rooms` for the room list, `room` with its id for its snapshot), T3's projects or threads
 * changed (`shell`), a watched thread's detail changed (`thread` with its id), and T3 stopped or started answering
 * (`status`).
 *
 * The rest of the service calls roomChanged, shellChanged and statusChanged. Rooms come from the change hub
 * (bootstrap.ts wires hub.subscribeAll here) and from the journal's heads, read every second while a page listens, for
 * an append nobody announced (a write straight to the store; the room stream, src/server/engineView.ts, does the same).
 * T3's side, with the HTTP adapter, is T3's own stream of its shell (the adapter's feed, src/adapter/shellFeed.ts): a
 * change it applies is `shell`, at once after a quiet spell and then at most once every 2 s while T3 keeps streaming
 * (every item of a running turn moves a thread, and each `shell` has the pages read the overview again), and its state
 * is T3's reach, at once: connected is up, connecting or down is not, with the feed's error. Without a feed (the fake
 * T3, whose outages and edits are seen only by reading it) it is a check every 2 s while a page listens:
 * adapter.listProjects() and listThreads(), fingerprinted, `shell` when the fingerprint moves, `status` when a read
 * fails after a success or succeeds after a failure.
 *
 * `thread` is the adapter's onThreadChange, passed on as it comes: a thread is watched while a room seats it or a page
 * read its detail in the last minute (src/adapter/threadFeed.ts), and the adapter tells its change once a read made
 * then sees it (with the HTTP adapter at most once per 2 s per thread, after the read its stream caused).
 */
import type { T3Adapter, T3ShellFeedStatus } from "../adapter/types.ts";

/** T3 as the service last found it: up (answering) or down with the error; unknown until the first read. */
export interface T3Reach {
  up: boolean;
  error: string | null;
  at: string;
}

/** `closed`: the service is shutting down, and each stream ends. */
export type PageEvent = { type: "rooms" } | { type: "room"; roomId: string } | { type: "shell" } | { type: "thread"; threadId: string } | { type: "status"; status: T3Reach } | { type: "closed" };

export interface PageChangesOptions {
  /** How often T3's projects and threads are checked while a page listens (ms). */
  shellMs?: number;
  /** How often the journal's heads are compared while a page listens (ms). */
  headsMs?: number;
  /** How often GET /api/events writes a heartbeat comment, so a proxy or a phone keeps the stream open (ms). */
  heartbeatMs?: number;
  /** Every room's journal head (EngineHost.heads); without it only announced changes go out. */
  heads?: () => Map<string, number>;
  /** T3's shell as it streams it (the HTTP adapter's feed): `shell` and `status` come from it, and there is no check. */
  feed?: Pick<T3Adapter, "feed" | "onShellChange" | "onFeedChange">;
  log?: (message: string, detail?: unknown) => void;
}

export class PageChanges {
  private readonly listeners = new Set<(event: PageEvent) => void>();
  /** The service's own readers of what changed (a cache to drop), told before any page; they do not start the watches. */
  private readonly observers = new Set<(event: PageEvent) => void>();
  private readonly shellMs: number;
  private readonly headsMs: number;
  readonly heartbeatMs: number;
  private shellTimer: ReturnType<typeof setTimeout> | null = null;
  private headsTimer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private fingerprint: string | null = null;
  private reach: T3Reach | null = null;
  private knownHeads: Map<string, number> | null = null;
  private closed = false;
  /** Bumped at each start and pause, so a check that ends after a pause does not start a second loop. */
  private generation = 0;
  /** The feed's: its subscriptions; the spell after a `shell` it caused, and whether a change came during it. */
  private readonly unfollow: Array<() => void> = [];
  private streamedTimer: ReturnType<typeof setTimeout> | null = null;
  private streamedDuring = false;

  private readonly adapter: Pick<T3Adapter, "listProjects" | "listThreads">;
  private readonly options: PageChangesOptions;

  constructor(adapter: Pick<T3Adapter, "listProjects" | "listThreads"> & Partial<Pick<T3Adapter, "onThreadChange">>, options: PageChangesOptions = {}) {
    this.adapter = adapter;
    this.options = options;
    this.shellMs = options.shellMs ?? 2000;
    this.headsMs = options.headsMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 20000;
    // A watched thread's change, as the adapter tells it (it is the throttle): pages showing the thread read it again.
    if (adapter.onThreadChange) this.unfollow.push(adapter.onThreadChange((threadId) => this.threadChanged(threadId)));
    const feed = options.feed;
    if (feed) {
      // Followed whether or not a page listens: the service's observers (the read API's memo) are told as well.
      this.unfollow.push(feed.onShellChange(() => this.streamed()), feed.onFeedChange((status) => this.follow(status)));
      this.follow(feed.feed());
    }
  }

  /** A page listens; the watches run while one does. Returns the unsubscribe. */
  subscribe(listener: (event: PageEvent) => void): () => void {
    if (this.closed) {
      listener({ type: "closed" });
      return () => undefined;
    }
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.pause();
    };
  }

  /**
   * A part of the service that keeps something a change makes stale (the read API's memo of T3's threads): told of each
   * change before the pages are, so the read a page makes on it is fresh. Observing starts no watch. Returns the stop.
   */
  observe(observer: (event: PageEvent) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** How many pages listen (tests). */
  get listening(): number {
    return this.listeners.size;
  }

  /** T3 as last found: null before the first read. */
  status(): T3Reach | null {
    return this.reach;
  }

  roomChanged(roomId: string): void {
    // An announced append is not told again when the heads are next compared.
    if (this.knownHeads && this.options.heads) {
      try {
        const head = this.options.heads().get(roomId);
        if (head !== undefined) this.knownHeads.set(roomId, head);
      } catch {
        // compared on the next round
      }
    }
    this.emit({ type: "rooms" });
    this.emit({ type: "room", roomId });
  }

  shellChanged(): void {
    this.emit({ type: "shell" });
  }

  threadChanged(threadId: string): void {
    if (!this.closed) this.emit({ type: "thread", threadId });
  }

  /** T3 answers again (`up`) or stopped answering, with the error. Only a change goes out. */
  statusChanged(up: boolean, error: string | null = null): void {
    if (this.reach && this.reach.up === up && (up || this.reach.error === error)) return;
    // The first reading that T3 answers is no news: pages assume it does until told otherwise.
    const first = this.reach === null;
    this.reach = { up, error: up ? null : error, at: new Date().toISOString() };
    if (first && up) return;
    this.emit({ type: "status", status: this.reach });
  }

  /** Read T3's projects and threads now; `shell` if they changed since the last read, `status` if reaching T3 changed. */
  check(): Promise<void> {
    // With the feed, nothing to read: it tells both as they happen.
    if (this.options.feed) return Promise.resolve();
    // One read at a time: a check asked for while one runs shares it.
    this.checking ??= this.read().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** Compare the journal's heads with the last ones seen: a room whose head moved changed. */
  checkHeads(): void {
    if (!this.options.heads) return;
    let heads: Map<string, number>;
    try {
      heads = this.options.heads();
    } catch {
      return;
    }
    const known = this.knownHeads;
    this.knownHeads = heads;
    if (!known) return;
    for (const [roomId, head] of heads) if (known.get(roomId) !== head) this.roomChanged(roomId);
  }

  /** Stop for good (the service shuts down). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pause();
    for (const stop of this.unfollow.splice(0)) stop();
    if (this.streamedTimer) clearTimeout(this.streamedTimer);
    this.streamedTimer = null;
    this.emit({ type: "closed" });
    this.listeners.clear();
    this.observers.clear();
  }

  /** The feed's state is T3's reach: connected is up, connecting or down is not. */
  private follow(status: T3ShellFeedStatus): void {
    if (this.closed) return;
    if (status.state === "connected") this.statusChanged(true);
    else this.statusChanged(false, status.error ?? (status.state === "connecting" ? "Backroom is connecting to T3" : "T3 is not answering"));
  }

  /**
   * A change the feed applied: `shell` at once after a quiet spell, then one at the end of each spell of shellMs in
   * which more came, so a T3 streaming without pause has the pages read again no more often than the check did.
   */
  private streamed(): void {
    if (this.closed) return;
    if (this.streamedTimer) {
      this.streamedDuring = true;
      return;
    }
    this.shellChanged();
    const spell = () => {
      this.streamedTimer = setTimeout(() => {
        this.streamedTimer = null;
        if (!this.streamedDuring) return;
        this.streamedDuring = false;
        this.shellChanged();
        spell();
      }, this.shellMs);
      this.streamedTimer.unref?.();
    };
    spell();
  }

  private async read(): Promise<void> {
    try {
      const [projects, threads] = await Promise.all([this.adapter.listProjects(), this.adapter.listThreads()]);
      const fingerprint = JSON.stringify([projects, threads]);
      const changed = this.fingerprint !== null && this.fingerprint !== fingerprint;
      this.fingerprint = fingerprint;
      this.statusChanged(true);
      if (changed) this.shellChanged();
    } catch (error) {
      this.statusChanged(false, error instanceof Error ? error.message : String(error));
    }
  }

  private start(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.knownHeads = null;
    this.checkHeads();
    if (this.options.heads) this.headsTimer = setInterval(() => this.checkHeads(), this.headsMs);
    // The feed tells T3's side as it happens: no check.
    if (this.options.feed) return;
    // The next check is timed from the end of the last one: a read T3 holds up never piles up behind itself.
    const next = () => {
      this.shellTimer = setTimeout(() => {
        this.shellTimer = null;
        void this.check().then(() => {
          if (generation === this.generation) next();
        });
      }, this.shellMs);
    };
    // The first read sets the fingerprint (and the status a page connecting is told).
    void this.check();
    next();
  }

  private pause(): void {
    this.generation += 1;
    // No page to tell: the heads are not followed (a page that comes is told everything at its open).
    this.knownHeads = null;
    if (this.shellTimer) clearTimeout(this.shellTimer);
    if (this.headsTimer) clearInterval(this.headsTimer);
    this.shellTimer = null;
    this.headsTimer = null;
  }

  private emit(event: PageEvent): void {
    for (const listener of [...this.observers, ...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.options.log?.("page event listener failed", (error as Error).message);
      }
    }
  }
}
