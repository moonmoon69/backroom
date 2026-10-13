/**
 * The page's one stream of what changed on the service (GET /api/events, src/app/changes.ts), and the rule that keeps
 * a slow answer from undoing a newer one. Plain code with no React, so tests drive it with a fake EventSource.
 *
 * The page reads everything again whenever the stream opens (the first time and at each reconnect: iOS drops the
 * connection while the PWA is in the background) and whenever it comes back into view; on each event it reads again
 * what the event names. While the stream is open the page's timers only back it up, slowly.
 */

/** T3 as the service last found it (src/app/changes.ts, T3Reach). */
export interface T3Reach {
  up: boolean;
  error: string | null;
  at: string;
}

export interface PageStreamHandlers {
  /** Read everything again: the stream (re)opened, or the page came back into view. */
  all(): void;
  /** Some room changed: the room list. */
  rooms(): void;
  /** This room's snapshot changed. */
  room(roomId: string): void;
  /** T3's projects or threads changed. */
  shell(): void;
  /** T3 stopped answering, or answers again. */
  status(reach: T3Reach): void;
  /** The stream is open (true) or not (false): the timers run slowly, or at their own pace. */
  open(open: boolean): void;
}

/** What the page needs of an EventSource (readyState 2 is CLOSED: the browser gave up and will not retry). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface PageStreamDeps {
  connect(url: string): EventSourceLike;
  /** Whether the page is out of sight, and a listener for each change of that. */
  hidden(): boolean;
  onVisibility(listener: () => void): () => void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const EVENTS_URL = "/api/events";
/** Events of one kind within this long are read once (at its end), and a steady stream of them still reads this often. */
export const COALESCE_MS = 150;
/** After the browser gives up on the stream (an HTTP error, not a dropped connection), it is opened again this much later. */
export const REOPEN_MS = 5000;

export class PageStream {
  private source: EventSourceLike | null = null;
  private reopenTimer: unknown = null;
  private readonly pending = new Map<string, unknown>();
  private stopVisibility: (() => void) | null = null;
  private stopped = true;
  private isOpen = false;
  private readonly handlers: PageStreamHandlers;
  private readonly deps: PageStreamDeps;

  constructor(handlers: PageStreamHandlers, deps: PageStreamDeps) {
    this.handlers = handlers;
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopVisibility = this.deps.onVisibility(() => this.visibility());
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.source?.close();
    this.source = null;
    if (this.reopenTimer !== null) this.deps.clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    for (const timer of this.pending.values()) this.deps.clearTimeout(timer);
    this.pending.clear();
    this.setOpen(false);
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.reopenTimer !== null) this.deps.clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.source?.close();
    const source = this.deps.connect(EVENTS_URL);
    this.source = source;
    source.onopen = () => {
      if (source !== this.source) return;
      this.setOpen(true);
      // Whatever changed while it was not open was not told: read it all.
      this.handlers.all();
    };
    source.onerror = () => {
      if (source !== this.source) return;
      this.setOpen(false);
      // A dropped connection is retried by the browser; a refused one (an HTTP error) is not, so it is opened again
      // here, at once when the page next comes into view.
      if (source.readyState === 2 && !this.deps.hidden()) this.reopenTimer = this.deps.setTimeout(() => this.connect(), REOPEN_MS);
    };
    const data = (event: { data: string }): Record<string, unknown> => {
      try {
        return (JSON.parse(event.data) ?? {}) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    source.addEventListener("rooms", () => this.coalesce("rooms", () => this.handlers.rooms()));
    source.addEventListener("room", (event) => {
      const roomId = data(event).roomId;
      if (typeof roomId === "string") this.coalesce(`room:${roomId}`, () => this.handlers.room(roomId));
    });
    source.addEventListener("shell", () => this.coalesce("shell", () => this.handlers.shell()));
    source.addEventListener("status", (event) => {
      const reach = data(event);
      if (typeof reach.up === "boolean") this.handlers.status({ up: reach.up, error: typeof reach.error === "string" ? reach.error : null, at: typeof reach.at === "string" ? reach.at : "" });
    });
  }

  private visibility(): void {
    if (this.stopped || this.deps.hidden()) return;
    // Back in view: the stream may have died with the page in the background (iOS) and the timers did not run.
    if (!this.source || this.source.readyState === 2) this.connect();
    this.handlers.all();
  }

  /** At most one read per kind every COALESCE_MS: the first event arms it, the rest ride along. */
  private coalesce(key: string, read: () => void): void {
    if (this.pending.has(key)) return;
    this.pending.set(
      key,
      this.deps.setTimeout(() => {
        this.pending.delete(key);
        read();
      }, COALESCE_MS),
    );
  }

  private setOpen(open: boolean): void {
    if (this.isOpen === open) return;
    this.isOpen = open;
    this.handlers.open(open);
  }
}

/**
 * Answers applied in the order they were asked for: each read takes a ticket when it starts, and its answer (success
 * or failure) is applied only if no later read's answer has been applied already. A read T3 held up for 30 s cannot put
 * back what a newer read replaced (the T3 banner after a success).
 */
export class Latest {
  private issued = 0;
  private applied = 0;

  /** A ticket for a read starting now. */
  start(): number {
    this.issued += 1;
    return this.issued;
  }

  /** Whether the answer of the read with this ticket may be applied; if so, older ones no longer may. */
  take(ticket: number): boolean {
    if (ticket <= this.applied) return false;
    this.applied = ticket;
    return true;
  }

  /** Something newer than every read in flight was applied (a pushed status): none of them may be applied now. */
  supersede(): void {
    this.applied = this.issued;
  }
}

/** The snapshot to show: the one read, only if it is the selected room's (never a late answer for the room left). */
export function shownSnapshot<T extends { room: { id: string } }>(read: T | null, selectedRoomId: string | null): T | null {
  return read && read.room.id === selectedRoomId ? read : null;
}

/** The selection after a room's read answered 404: closed if that room is still the one open, else left as it is. */
export function afterRoomGone<S extends { kind: string; id: string }>(selection: S | null, roomId: string): S | null {
  return selection?.kind === "room" && selection.id === roomId ? null : selection;
}
