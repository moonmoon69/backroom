/**
 * The lean engine host (stage 4/5 plan, item L1; H5: members only answer). It runs the engine core against T3: for each
 * seat it reserves a run when the seat has unread addressed input and its thread is free, renders the frozen envelope,
 * sends it with the run's stable command and message IDs, follows the T3 run, and imports what the thread did. Its
 * rules, one sentence each:
 * - A final answers the open requests its run was given.
 * - A final that a correction overtook (it came in after the turn could take it) answers nothing, and the next turn answers.
 * - A turn that ends without a reply is an error notice to its requesters, who can retry it.
 * - A reseat's checkpoint run answers the checkpoint only.
 * - A member's posts carry its T3 status at the top: a turn running, and the background tasks and subagents T3 lists.
 * - A turn that answers nothing (one the member started itself, one typed in T3, one another agent's message started)
 *   is a follow-up post on the member's request, and wakes the orchestrator.
 * - When background work a member's latest post named has ended with no further turn, one follow-up says so after
 *   `quietMs` of quiet.
 * - Only the orchestrator, the user and Backroom (a seat's briefing, a reseat's checkpoint or call-off) post requests.
 * - A cancel applies at once: it stops the member's turn when that turn has nothing else to work on, and otherwise goes
 *   into the running turn like any message.
 *   What a stopped turn said is on the board and wakes nobody.
 * - A run T3 never takes fails visibly, with one notice, after its bounds.
 * - An idle seat with work in flight (a member it asked still working, background work or a subagent of its own) that
 *   nothing has woken for its keep-alive interval gets a keep-alive post: one line, then the status lines of that work.
 * - Keep-alives are on for the orchestrator and off for members, unless the room's setting says otherwise.
 * - A member's thread held in a state no reply of its own ends (an approval, a secret or a question for the user, a usage
 *   limit, a queue T3 holds, the thread settled, archived or deleted in T3) is one notice to the orchestrator on each open
 *   request of the member's, once per request per hold (the state and what holds it: the request T3 waits on, the
 *   limited run); a hold that persists or clears posts nothing, and a new one posts again.
 * - A run that brings only keep-alives ends as a note that wakes nobody, whatever it said.
 * - A request, correction or retry from the user or the orchestrator goes into its member's running turn: it is offered
 *   when T3 runs the turn, confirmed once T3 shows the member working after it in that turn, sent again with its own IDs
 *   until `unrecordedMs`, then left to the next turn. Nothing goes into a keep-alive's turn, a turn on Backroom's own
 *   request, or a turn a cancel or Stop is ending. A message T3 ran as a turn of its own is followed as that seat's run
 *   when nothing else came in since; otherwise its reply is a follow-up and an ordinary run carries what it carried.
 *   (Backroom's bookkeeping of T3's steer, the harness's own mid-turn message: an internal detail, not the user's.)
 *
 * The journal in the engine store is the only record and the only thing that wakes anyone. The host keeps no work
 * state of its own: everything it needs after a restart is read back from the journal and from T3, by ID. What it
 * holds in memory (send attempts, quiet clocks, keep-alive rechecks) only bounds retries, timers and reads. When a seat
 * was last woken is T3's: the end of the latest turn on its thread, read from the thread itself.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3Run, T3ShellChange, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { T3CommandRejected, T3OutcomeUnknown, T3Unavailable, isContinuation, isPullRequestWatch, isRunActive, latestExecutedRun, openRequests, runForMessage, type T3PullRequestChecks } from "../adapter/types.ts";
import type { ModelSelection } from "../domain/types.ts";
import { blockedNoticed, checksCause, deliveredInputs, inputTree, unread } from "../engine/index.ts";
import type { Command, CommitReceipt, Disposition, EngineStore, Projection, Run } from "../engine/index.ts";
import { KEEP_ALIVE_LINE } from "../briefing/envelope.ts";
import { attachImages, brief, seatStanding, type BriefingSource } from "./render.ts";
import { adoptableSteers, goesIntoTurn, holdsBack, settledOffer, steerMessageIds, steerOffers, steerReceiptId, takenInRun, takesMessages, type SteerOffer } from "./steer.ts";
import { continuedRun, stoppedEverything, finalMessage, isTerminal, runEnd, runError, runLimit, runOrigin, threadFree, type RunLimit } from "./t3.ts";
import { isPausedNotice, providerLabel, resetTime } from "../domain/usageLimit.ts";
import { memberState } from "../domain/memberState.ts";
import { memberFacts, pauseOf, subagentRequests, type SubagentRequest } from "../app/threadView.ts";
import { finishedWithFailures, watchedLink } from "../app/pullRequestWatch.ts";
import { FOLLOW_UP, latestStatusPost, memberStatus, statusLine, type MemberStatus } from "./status.ts";
import { DEFERRED_CANCEL, TARGETING, committed, deferredCancels, finalTargets, followedRequests, frozenDispatch, keepAliveRun, openOwned, runRecords, stoppingCancel, type Dispatch } from "./work.ts";

const SYSTEM = "$system";
/** The owner of the host's watches on its seats' threads (adapter.holdThreads). */
const WATCHER = "engine";
const MiB = 1024 * 1024;
/** With `stuckMs`: the fewest failed attempts in a row before a run's step counts as stuck, so a gap alone never does. */
const STUCK_ATTEMPTS = 3;
/** The last lines of a message sent into a running turn: what the member does with it, and what its arrival may have cut off. */
const STEER_NOTE = "This came into your running turn: take it into account in the work you are doing now. A tool call of yours may have been cut off when it arrived: check what it left running or unfinished. Your final reply for this turn answers it too, so say there what you did about it.";

/** Committed steps, for the crash method in tests/runtime: a hook that throws here stops the host as a crash would. */
export type HostStep = "reserved" | "sending" | "sent" | "accepted" | "running" | "steered" | "steer-sent" | "steer-confirmed" | "output" | "ended" | "imported" | "keep-alive";

/** H6: how long a seat with work in flight may go without a wake before it gets a keep-alive: under the prompt cache's hour. */
export const KEEP_ALIVE_MS = 55 * 60_000;
/** H6: an overdue seat whose threads were read and given no keep-alive is looked at again after this long: a bound on reads only. */
const KEEP_ALIVE_RECHECK_MS = 60_000;

/**
 * H6: a room's keep-alive setting for one seat: the interval (0 turns keep-alives off), and whether the room turned them
 * on or off for the seat; null leaves the default, on for the orchestrator and off for members.
 */
export interface KeepAliveSetting { intervalMs: number; on: boolean | null }

export interface EngineHostOptions {
  store: EngineStore;
  adapter: T3Adapter;
  /** The rooms whose journals the host serves. */
  rooms: () => readonly string[];
  /** The app's side of a briefing: room, member, images (see render.ts). */
  briefing: BriefingSource;
  /** The briefing's character budget (ROOMS_BRIEFING_BUDGET): 60,000 by default. */
  budgetChars?: number;
  /** The model a seat's run names, as T3 Code's composer does; none leaves the thread's own. */
  modelFor?: (roomId: string, seatId: string) => ModelSelection | null;
  notify?: (roomId: string) => void;
  log?: (message: string, detail?: unknown) => void;
  /** Reservation budget (§7): 4 MiB. */
  maxBytes?: number;
  /** How long a member's thread stays quiet, after background work its latest post named has ended, before one follow-up says so: 30 s. */
  quietMs?: number;
  /** How long a sent message may stay unrecorded by T3 before its run fails visibly. */
  unrecordedMs?: number;
  /** How many times T3 may refuse a message before its run fails visibly (a passing refusal is retried). */
  refusals?: number;
  /** How long a run not yet matched to a T3 run may keep failing its step (sends and reads included) before it fails visibly: 2 minutes. */
  stuckMs?: number;
  /** H6: the room's keep-alive setting for a seat (src/app/keepAlive.ts); without it, KEEP_ALIVE_MS and the default. */
  keepAlive?: (roomId: string, seatId: string) => KeepAliveSetting;
  now?: () => number;
  /** The time zone a usage-limit notice gives its reset time in, and names: the service's own by default. */
  timeZone?: string;
  onStep?: (step: HostStep, at: { roomId: string; seatId: string; runId?: string }) => void;
  /**
   * Called each tick for every seat with its thread, after the host's own work on it: the app mirrors what stays off the
   * journal (approvals and questions on the native-requests path, plan §6). `detail` reads the thread at most once, and
   * `subagents` what its subagents' threads wait on (subagentRequests), once.
   */
  watch?: (at: { roomId: string; seatId: string; threadId: string }, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>, subagents: () => Promise<SubagentRequest[] | null>) => void | Promise<void>;
  /** T3's checks read for a thread's watched pull requests, by watch task id (src/app/pullRequestWatch.ts checksReader). */
  watchedChecks?: (shell: T3ThreadShell) => Promise<Map<string, T3PullRequestChecks | null>>;
}

/**
 * A send T3 did not take (H4). Its message is the log line while the run goes on ("sent again with the same IDs");
 * `reason` is what a notice may say if the run's bound ends it: only what is known about the message.
 */
class SendNotTaken extends Error {
  readonly reason: string;
  constructor(logLine: string, reason: string, cause: unknown) {
    super(logLine, { cause });
    this.name = "SendNotTaken";
    this.reason = reason;
  }
}

/** A member command the host refuses, with the explanation the member sees. */
export class HostRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRefusal";
  }
}

type Loader = (full?: boolean) => Promise<T3ThreadDetail | null>;
interface Ending { outcome: "completed" | "stopped" | "failed"; text: string; error: string; status: MemberStatus | null; evidence: string; /** The usage limit a failed run stopped on. */ limit?: RunLimit | null }

/** The refusal a member meets when it tries to post. */
export const MEMBERS_DO_NOT_POST = "Only the Consigliere and the user post on the board. Put what you have to say in your final reply: it is your answer, and the Consigliere decides what happens next.";
const QUIET = "quiet:";
/** H6: a keep-alive's ID names the seat and the T3 turn it follows; the note its run ends with names the run. */
const KEEP_ALIVE = "keep-alive:";
export const KEEP_ALIVE_REPLY = "keep-alive-reply:";

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
/** A name in a notice: one line, at most 200 characters. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
/** A request's words in a notice: one line, at most 200 characters, ended with a full stop unless it has its own. */
function clip(text: string): string {
  const short = oneLine(text);
  return /[.?!…]$/.test(short) ? short : `${short}.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function shellKey(shell: T3ThreadShell): string {
  return JSON.stringify([shell.latestRunId, shell.status, shell.latestUserMessageAt, shell.latestRunCompletedAt, shell.pendingBackgroundTasks.length]);
}
/** A thread's shell as far as a tick reads it: all of it but `updatedAt`, which T3 moves with every item of a run. */
function wakeKey(shell: T3ThreadShell | null | undefined): string {
  return shell ? JSON.stringify({ ...shell, updatedAt: undefined }) : "";
}

export class EngineHost {
  private readonly store: EngineStore;
  private readonly adapter: T3Adapter;
  private readonly rooms: () => readonly string[];
  private readonly source: BriefingSource;
  private readonly budgetChars: number;
  private readonly options: EngineHostOptions;
  private readonly maxBytes: number;
  private readonly quietMs: number;
  private readonly unrecordedMs: number;
  private readonly refusalLimit: number;
  private readonly stuckMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  /** A seat's thread changed in T3 while a tick was running: another one runs when it ends. */
  private again = false;
  /** A wake's tick is due (on the next turn of the event loop). */
  private woken = false;
  private unwatchShell: (() => void) | null = null;
  private unwatchThreads: (() => void) | null = null;
  /** Per seat's thread: its shell as the latest tick listed it (wakeKey), to tell a change T3 streams that a tick would act on. */
  private listed = new Map<string, string>();
  /** The seats' threads as the latest tick found them: the threads the host keeps watched, whose changes wake it. */
  private seated = new Set<string>();
  private halted = false;
  private appends = 0;
  /** Per run: when its message was first sent, and how often T3 refused it. Bounds only; nothing is decided from them. */
  private readonly firstSent = new Map<string, number>();
  private readonly refused = new Map<string, number>();
  /** Per run not yet matched to a T3 run: since when, and how often in a row, its step has thrown (H4). A bound only. */
  private readonly stuck = new Map<string, { since: number; attempts: number }>();
  /** Host runs whose cancel's interrupt T3 has taken (or refused); T3 keeps one receipt per command ID, so a restart may send it once more. */
  private readonly interrupted = new Set<string>();
  /** Per seat: since when its thread has been quiet after background work its latest post named ended, and that post's follow-up ID. */
  private readonly quietSince = new Map<string, { id: string; at: number }>();
  /** Per seat: the thread state whose turns and messages are all imported (§3), so an unchanged thread is not reread. */
  private readonly seen = new Map<string, string>();
  /** Per seat: the turn whose keep-alive check read the threads and posted nothing, and when, so they are read again only after KEEP_ALIVE_RECHECK_MS. */
  private readonly idleSince = new Map<string, { id: string; at: number }>();
  /**
   * Per steer offer: when its message was first sent (or may have been: an unknown acknowledgement), the offers this
   * process tried to send at all, their rendering (resent as is), and the offers given up. Bounds only.
   */
  private readonly steerSent = new Map<string, number>();
  private readonly steerAttempted = new Set<string>();
  private readonly steerTexts = new Map<string, { text: string; images: Dispatch["images"] }>();
  private readonly steerGaveUp = new Set<string>();
  /**
   * Host runs the room's Stop was sent for (stopSeat): nothing more goes into them while T3 ends them. Stop is not on the
   * journal, so a restart forgets it; T3 then refuses a message into the stopped run, or the message shares its notice.
   */
  private readonly stopping = new Set<string>();

  constructor(options: EngineHostOptions) {
    this.options = options;
    this.store = options.store;
    this.adapter = options.adapter;
    this.rooms = options.rooms;
    this.source = options.briefing;
    this.budgetChars = options.budgetChars ?? 60_000;
    this.maxBytes = options.maxBytes ?? 4 * MiB;
    this.quietMs = options.quietMs ?? 30_000;
    this.unrecordedMs = options.unrecordedMs ?? 5 * 60_000;
    this.refusalLimit = options.refusals ?? 3;
    this.stuckMs = options.stuckMs ?? 2 * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /**
   * Tick every `intervalMs`, and at once when T3 reports a change to a seat's thread: to its shell (shellChanged), or to
   * its detail (the adapter tells a watched thread's change once a read sees it; the host watches its seats' threads).
   * The interval is the fallback.
   */
  start(intervalMs = 1500): void {
    this.unlisten();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    this.unwatchShell = this.adapter.onShellChange((change) => void this.shellChanged(change));
    this.unwatchThreads = this.adapter.onThreadChange((threadId) => {
      if (this.seated.has(threadId)) this.wake();
    });
  }

  stop(): void {
    this.unlisten();
    // Its seats' threads stay watched a little longer (a host started again soon keeps their streams), then go.
    this.adapter.holdThreads(WATCHER, []);
  }

  private unlisten(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unwatchShell?.();
    this.unwatchShell = null;
    this.unwatchThreads?.();
    this.unwatchThreads = null;
  }

  /** Stop for good, before the store is closed: no tick runs after this. */
  close(): void {
    this.halted = true;
    this.stop();
  }

  /** An append hint: something was written; a started host looks again at once instead of at the next tick. */
  hint(): void {
    if (this.timer && !this.halted) setImmediate(() => {
      if (this.timer && !this.halted) void this.tick();
    });
  }

  tick(): Promise<void> {
    if (this.halted) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
      if (this.again) {
        this.again = false;
        this.wake();
      }
    });
    return this.ticking;
  }

  /**
   * Look again at once; while a tick runs (it may have listed the threads before the change), right after it. Wakes
   * before the woken tick has started are one (a change T3 tells for the shell and for the thread alike).
   */
  private wake(): void {
    if (!this.timer || this.halted) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    if (this.woken) return;
    this.woken = true;
    setImmediate(() => {
      this.woken = false;
      if (this.timer && !this.halted) void this.tick();
    });
  }

  /**
   * T3 reports a change to its shell: wake when a seat's thread is not as the latest tick listed it. T3 reports every
   * item of every running thread (each moves its `updatedAt`), and a tick reads its seats' running threads in full, so
   * the rest is left to the interval.
   */
  private async shellChanged(change: T3ShellChange): Promise<void> {
    if (!this.timer || this.halted) return;
    const ids = (change.threadIds ?? [...this.listed.keys()]).filter((id) => this.listed.has(id));
    if (ids.length === 0) return;
    try {
      const listed = change.threadIds === null ? new Map((await this.adapter.listThreads()).map((shell) => [shell.id, shell])) : null;
      for (const id of ids) {
        const shell = listed ? listed.get(id) : await this.adapter.getThreadShell(id);
        if (wakeKey(shell) === this.listed.get(id)) continue;
        this.wake();
        return;
      }
    } catch {
      // T3 cannot be read now: the next tick finds out.
    }
  }

  // ---------------- the loop ----------------

  private async runTick(): Promise<void> {
    try {
      await this.tickRooms();
    } catch (error) {
      if (!this.halted) this.log("tick failed", message(error));
    }
  }

  private async tickRooms(): Promise<void> {
    if (this.halted) return;
    // The seats' threads are watched (T3 streams their changes): a tick then reads one only once it has changed.
    const seated = new Set<string>();
    for (const roomId of this.rooms()) {
      for (const seat of this.project(roomId).seats.values()) if (seat.status !== "retired") seated.add(seat.threadId);
    }
    this.seated = seated;
    this.adapter.holdThreads(WATCHER, [...seated]);
    let shells: Map<string, T3ThreadShell>;
    try {
      shells = new Map((await this.adapter.listThreads()).map((s) => [s.id, s]));
    } catch (error) {
      this.log("t3 unavailable", message(error));
      // An outage: no seat is stepped, and every run's bound starts again once T3 is back (H4).
      this.stuck.clear();
      return;
    }
    const listed = new Map<string, string>();
    for (const roomId of this.rooms()) {
      for (const seat of this.project(roomId).seats.values()) if (seat.status !== "retired") listed.set(seat.threadId, wakeKey(shells.get(seat.threadId)));
    }
    this.listed = listed;
    for (const roomId of this.rooms()) {
      if (this.halted) return;
      const before = this.appends;
      try {
        await this.stepRoom(roomId, shells);
      } catch (error) {
        if (this.halted) return;
        this.log("room step failed", { roomId, error: message(error) });
      }
      if (this.appends !== before) this.options.notify?.(roomId);
    }
  }

  /**
   * One room, in passes over its seats, so what one seat's import writes is dispatched in the same tick: follow live
   * runs and import what happened on each thread; post the follow-ups of background work that ended quietly and the
   * keep-alives; reserve and send; then tell the orchestrator what holds a member's request.
   */
  private async stepRoom(roomId: string, shells: Map<string, T3ThreadShell>): Promise<void> {
    const seats = [...this.project(roomId).seats.values()].filter((s) => s.status !== "retired");
    const states = new Map<string, { shell: T3ThreadShell | null; load: Loader; subagents: () => Promise<SubagentRequest[] | null>; current: () => T3ThreadShell | null; imported: boolean }>();
    // A subagent thread is read while it waits on something, leased so its stream serves the reads after the first.
    const readSubagent = (threadId: string) => {
      this.adapter.leaseThread(threadId);
      return this.adapter.getThreadDetail(threadId, { bounded: true });
    };
    for (const seat of seats) {
      const cache: { detail?: T3ThreadDetail | null; subagents?: Promise<SubagentRequest[] | null> } = {};
      const subagents = () => (cache.subagents ??= subagentRequests(shells.values(), seat.threadId, readSubagent));
      const load: Loader = async (full = false) => {
        if (cache.detail === undefined || full) {
          cache.detail = await this.adapter.getThreadDetail(seat.threadId, full ? {} : { bounded: true });
          if (cache.detail?.partial && !full) cache.detail = await this.adapter.getThreadDetail(seat.threadId);
        }
        return cache.detail;
      };
      const shell = shells.get(seat.threadId) ?? null;
      states.set(seat.id, { shell, load, subagents, current: () => cache.detail?.shell ?? shell, imported: false });
    }
    const each = async (pass: (seatId: string, state: NonNullable<ReturnType<typeof states.get>>) => Promise<void>) => {
      for (const seat of seats) {
        if (this.halted) return;
        try {
          await pass(seat.id, states.get(seat.id)!);
        } catch (error) {
          if (this.halted) throw error;
          this.log("seat step failed", { roomId, seatId: seat.id, error: message(error) });
        }
      }
    };
    await each(async (seatId, state) => {
      this.applyDeferredCancels(roomId, seatId, false);
      const live = this.project(roomId).seats.get(seatId)!.activeRunId;
      if (!state.shell) {
        // T3 does not list the thread (deleted or archived there): a run on it can never end, so it fails visibly.
        if (live) this.fail(roomId, live, `T3 thread ${this.project(roomId).seats.get(seatId)!.threadId} of ${this.named(roomId, seatId)} no longer exists`);
        return;
      }
      if (live) await this.advance(roomId, seatId, live, state.load);
      state.imported = await this.importThread(roomId, seatId, state.shell, state.load);
      const seat = this.project(roomId).seats.get(seatId)!;
      await this.options.watch?.({ roomId, seatId, threadId: seat.threadId }, state.current() ?? state.shell, () => state.load(), state.subagents);
    });
    await each(async (seatId, state) => {
      const shell = state.current();
      if (shell) await this.quiet(roomId, seatId, shell, state.load, state.imported);
    });
    await each(async (seatId, state) => {
      const shell = state.current();
      if (shell) await this.keepAlive(roomId, seatId, shell, state.imported, state.load, (id) => states.get(id));
    });
    await each(async (seatId, state) => {
      const shell = state.current();
      if (shell) await this.dispatch(roomId, seatId, shell, state.imported, state.load);
    });
    // Last, on the thread as this tick read it: what holds a member's request that no reply of its own ends, and a
    // watched pull request whose checks have all finished with one failed.
    await each(async (seatId, state) => this.blocked(roomId, seatId, state.load, state.subagents));
    await each(async (seatId, state) => this.checksFinished(roomId, seatId, state.current()));
  }

  // ---------------- a host run: reserve, send, follow, import ----------------

  /** R3: reserve only when the thread is free and every turn the host did not start has been imported (§2 first). */
  private async dispatch(roomId: string, seatId: string, shell: T3ThreadShell, imported: boolean, load: Loader): Promise<void> {
    const p = this.project(roomId);
    const seat = p.seats.get(seatId)!;
    const pending = unread(p, seatId);
    if (seat.activeRunId || seat.status !== "active" || !imported || pending.length === 0) return;
    let thread = shell;
    if (pending.every((i) => i.intent === "keep-alive")) {
      // H6: keep-alives alone go out only while the turn they follow is still the thread's latest (nothing woke the seat
      // since) and the thread is free, both as the thread itself says: the listed shell may be some seconds old. A
      // listed shell that is past that turn already rules it out, with no read: a stale keep-alive waits for real input.
      if (!pending.some((i) => i.eventId === this.keepAliveId(seatId, shell))) return;
      const detail = await load();
      if (!detail || !pending.some((i) => i.eventId === this.keepAliveId(seatId, detail.shell))) return;
      thread = detail.shell;
    }
    if (await this.adopt(roomId, seatId, load)) return;
    if (!threadFree(thread)) return;
    const id = randomUUID();
    const receipt = this.exec(roomId, { type: "reserve", actor: SYSTEM, id: `reserve:${id}`, seatId, runId: id, dispatchCommandId: randomUUID(), dispatchMessageId: randomUUID(), maxBytes: this.maxBytes });
    if (receipt.outcome !== "appended") return;
    this.step("reserved", roomId, seatId, id);
    await this.advance(roomId, seatId, id, load);
  }

  /**
   * Move a run on, bounded (H4): a run T3 has not been matched to (prepared, sending) whose step throws on every attempt,
   * for `stuckMs` and at least STUCK_ATTEMPTS times in a row, fails visibly with the error, so it never sits there with
   * only a log line. A send or a read T3 could not take counts too (send throws it): seats are only stepped once T3
   * has listed its threads in the tick, so that is not an outage. A real outage, where T3 lists nothing, steps no seat
   * and counts nothing: the run waits and is sent when T3 is back. Once a run is matched to a T3 run, that run ends on
   * its own, and failing ours would leave the member's reply unimported, so the bound stops there.
   */
  private async advance(roomId: string, seatId: string, runId: string, load: Loader): Promise<void> {
    try {
      await this.advanceRun(roomId, seatId, runId, load);
      this.stuck.delete(runId);
    } catch (error) {
      const run = this.project(roomId).runs.get(runId);
      if (this.halted || !run || run.phase === "terminal" || run.providerRunId) throw error;
      const streak = this.stuck.get(runId) ?? { since: this.now(), attempts: 0 };
      streak.attempts += 1;
      this.stuck.set(runId, streak);
      if (streak.attempts < STUCK_ATTEMPTS || this.now() - streak.since < this.stuckMs) throw error;
      this.log("run failed: its step kept failing before T3 had it", { roomId, seatId, runId, attempts: streak.attempts, error: message(error) });
      const reason = error instanceof SendNotTaken ? error.reason : message(error);
      this.fail(roomId, runId, `Backroom stopped trying to start ${this.named(roomId, seatId)}'s turn after the same step failed ${streak.attempts} times in ${Math.round((this.now() - streak.since) / 1000)} s: ${reason}`);
    }
  }

  private async advanceRun(roomId: string, seatId: string, runId: string, load: Loader): Promise<void> {
    let run = this.project(roomId).runs.get(runId)!;
    const threadId = this.project(roomId).seats.get(seatId)!.threadId;
    if (run.phase === "prepared") {
      // Sending is recorded before the message leaves, with the exact briefing and the standing record the thread will
      // hold. The whole thread is read: compactions and rollbacks lose standing.
      const detail = await load(true);
      const p = this.project(roomId);
      const briefed = await brief(this.source, this.budgetChars, { roomId, seatId, runId, envelope: run.envelope, projection: p, had: seatStanding(p, seatId, detail) });
      const frozen: Dispatch = { dispatch: run.dispatchCommandId, text: briefed.text, images: briefed.images, held: briefed.held };
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:sending`, runId, phase: "sending", evidence: JSON.stringify(frozen) });
      this.step("sending", roomId, seatId, runId);
      run = this.project(roomId).runs.get(runId)!;
    }
    if (run.phase === "sending") {
      let detail = await load(true);
      let t3Run = detail ? runForMessage(detail, run.dispatchMessageId) : null;
      if (!t3Run) {
        if (!(await this.send(roomId, seatId, run, threadId))) return;
        this.step("sent", roomId, seatId, runId);
        detail = await load(true);
        t3Run = detail ? runForMessage(detail, run.dispatchMessageId) : null;
        if (!t3Run) return; // Recorded later or lost: the next tick looks for the message by its ID, and resends it.
      }
      // The journal binds a T3 run ID to one run only. T3 numbers a thread's runs, so it gives an ID again when it counts
      // them from 1 again: binding it would be refused on every tick. The run fails at once, with its notice and Retry.
      if ([...this.project(roomId).runs.values()].some((other) => other.id !== runId && other.providerRunId === t3Run.id)) {
        this.fail(roomId, runId, `T3 gave ${this.named(roomId, seatId)}'s turn the run ID ${t3Run.id}, which an earlier run already holds (T3 counted the thread's runs from 1 again, as after a restart or a rollback), so Backroom cannot follow the turn; T3 may still run it`);
        return;
      }
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:accepted`, runId, phase: "accepted", evidence: `t3run:${t3Run.id} ordinal:${t3Run.ordinal}`, providerRunId: t3Run.id });
      this.step("accepted", roomId, seatId, runId);
      run = this.project(roomId).runs.get(runId)!;
    }
    if (run.phase !== "accepted" && run.phase !== "running" && run.phase !== "uncertain") return;
    const detail = await load();
    if (!detail) return;
    const t3Run = runForMessage(detail, run.dispatchMessageId);
    if (!t3Run) {
      const reason = run.phase === "uncertain" ? this.uncertainReason(roomId, runId) : `T3 no longer has the run of ${this.named(roomId, seatId)} (the thread was rolled back, or T3 lost it)`;
      this.fail(roomId, runId, reason);
      return;
    }
    if (!isTerminal(t3Run)) {
      if (run.phase === "accepted" && (t3Run.status === "running" || t3Run.status === "waiting")) {
        this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:running`, runId, phase: "running", evidence: `t3run:${t3Run.id}`, providerRunId: t3Run.id });
        this.step("running", roomId, seatId, runId);
      }
      await this.sendInterrupts(roomId, runId, threadId, t3Run);
      await this.steerInto(roomId, seatId, runId, t3Run, load);
      return;
    }
    const full = await load(true);
    if (!full) return;
    const final = finalMessage(full, t3Run.id);
    if (final.streaming) return; // T3 is still writing the last message: import it whole on the next tick.
    await this.sendInterrupts(roomId, runId, threadId, t3Run);
    this.confirmSteers(roomId, runId, t3Run.id, full);
    const end = runEnd(t3Run);
    this.finish(roomId, runId, {
      outcome: end === "completed" ? "completed" : end === "interrupted" && this.interruptedByCancel(roomId, runId) ? "stopped" : "failed",
      text: final.message?.text.trim() ?? "",
      error: runError(full, t3Run),
      status: memberStatus(full, t3Run.id),
      evidence: `t3run:${t3Run.id} ${t3Run.status}`,
      limit: runLimit(full, t3Run),
    });
  }

  /**
   * Send, or resend identically: the run's frozen IDs, never new ones (T3 keeps a receipt per command ID). Returns
   * whether T3 took the message. T3 out of reach or a lost acknowledgement keeps the run sending, the first counted
   * toward the run's bound (advance); T3 refusing it is retried a few times, then the run fails visibly with its
   * notice, so a passing error never starves the seat silently.
   */
  private async send(roomId: string, seatId: string, run: Run, threadId: string): Promise<boolean> {
    const first = this.firstSent.get(run.id);
    if (first !== undefined && this.now() - first > this.unrecordedMs) {
      this.fail(roomId, run.id, `T3 took the message for ${this.named(roomId, seatId)} but never recorded it`);
      return false;
    }
    // What was frozen at `sending`, never a fresh rendering: the same text and exactly the same images.
    const frozen = frozenDispatch(this.project(roomId), run.id)!;
    const images = attachImages(this.source, roomId, frozen.images);
    const model = this.options.modelFor?.(roomId, seatId) ?? null;
    try {
      await this.adapter.sendMessage({
        commandId: run.dispatchCommandId,
        threadId,
        messageId: run.dispatchMessageId,
        text: frozen.text,
        ...(images.length ? { images } : {}),
        ...(model ? { modelSelection: model } : {}),
        mode: { type: "start" },
      });
    } catch (error) {
      if (error instanceof T3Unavailable) {
        // T3 listed its threads in this tick, so this is not an outage: the step failed, and counts toward the bound.
        // Sent but never answered (T3OutcomeUnknown), T3 may have taken it and may run the turn; otherwise it never left.
        const who = this.named(roomId, seatId);
        if (error instanceof T3OutcomeUnknown) {
          throw new SendNotTaken(`T3 never confirmed it took the message for ${who} (${message(error)}); it is sent again with the same IDs`, `T3 never confirmed it took the message (${message(error)}), and may still run the turn`, error);
        }
        throw new SendNotTaken(`the message for ${who} could not be sent to T3 (${message(error)}); it is sent again with the same IDs`, `the message could not be sent to T3 (${message(error)})`, error);
      }
      if (error instanceof T3CommandRejected) {
        const count = (this.refused.get(run.id) ?? 0) + 1;
        this.refused.set(run.id, count);
        this.log("t3 refused the message", { runId: run.id, count, error: error.message });
        if (count >= this.refusalLimit) this.fail(roomId, run.id, `T3 refused the message for ${this.named(roomId, seatId)}: ${error.message}`);
        return false;
      }
      this.firstSent.set(run.id, first ?? this.now());
      this.log("dispatch acknowledgement unknown; reconciling by message ID", message(error));
      return false;
    }
    this.firstSent.set(run.id, first ?? this.now());
    return true;
  }

  private uncertainReason(roomId: string, runId: string): string {
    const p = this.project(roomId);
    const event = p.events.find((e) => e.data.kind === "run.phase" && e.data.runId === runId && e.data.phase === "uncertain");
    return event?.data.kind === "run.phase" ? event.data.evidence : "T3 has no run for this message";
  }

  /** A member as its failure notices name it: @alias, the seat ID when the room has no alias for it. */
  private named(roomId: string, seatId: string): string {
    return `@${this.source.alias?.(roomId, seatId) ?? seatId}`;
  }

  /** A run that has no T3 run to follow (refused, never recorded, thread gone) ends as a failure with its notice. */
  private fail(roomId: string, runId: string, reason: string): void {
    const run = this.project(roomId).runs.get(runId)!;
    if (run.phase === "prepared" || run.phase === "sending") {
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:uncertain`, runId, phase: "uncertain", evidence: reason });
    }
    this.finish(roomId, runId, { outcome: "failed", text: "", error: reason, status: null, evidence: reason });
  }

  /**
   * Import a run's end. Synchronous from choosing what the final answers to recording it, so no member command or
   * cancel can land in between: deferred cancels apply first, then §1 selects, then the output and the run's end. A
   * final with nothing left to answer is a follow-up on the requests the run was given.
   */
  private finish(roomId: string, runId: string, end: Ending): void {
    const seatId = this.project(roomId).runs.get(runId)!.seatId;
    this.applyDeferredCancels(roomId, seatId, true);
    let p = this.project(roomId);
    const run = p.runs.get(runId)!;
    const sourceKey = `final:${runId}`;
    if (!p.sourceKeys.has(sourceKey)) {
      const targets = finalTargets(p, run);
      const head = this.statusHead(roomId, seatId, end.status);
      let disposition: Disposition;
      let body: string;
      if (keepAliveRun(p, run)) {
        // H6: a keep-alive asks nothing, so what its turn said, a failure included, is a note that wakes nobody.
        const said = end.text || (end.outcome === "completed" ? "" : end.error);
        if (said) this.exec(roomId, { type: "post", actor: seatId, id: `${KEEP_ALIVE_REPLY}${runId}`, intent: "note", body: said });
        disposition = { kind: "silent" };
        body = "";
      } else if (end.outcome === "failed" || end.outcome === "stopped" && targets.length > 0) {
        disposition = { kind: "error", requestIds: targets };
        const error = end.limit ? this.pausedNotice(roomId, seatId, end.limit) : `${end.error}${this.againAfterRetry(p, run, targets)}`;
        body = head + (end.text ? `${error}\n\n${end.text}` : error);
      } else if (end.text && targets.length > 0 && end.outcome === "completed") {
        disposition = { kind: "answer", requestIds: targets };
        body = head + end.text;
      } else if (end.text && end.outcome === "stopped") {
        // A cancel stopped the turn: its words so far are on the board, and nobody is woken by them.
        disposition = { kind: "yield" };
        body = head + end.text;
      } else if (end.text) {
        // The run was given a cancel, a notice, or a request that closed meanwhile.
        const given = this.given(p, run);
        disposition = given.length > 0 ? { kind: "progress", requestIds: given, milestone: FOLLOW_UP } : { kind: "yield" };
        body = head + end.text;
        this.subscribeOrchestrator(roomId, seatId, given);
      } else if (targets.length > 0) {
        // A turn that ended without a reply is never an empty answer: its requesters get one error notice and can retry.
        disposition = { kind: "error", requestIds: targets };
        body = `${head}${this.named(roomId, seatId)}'s turn ended without a reply.`;
      } else {
        disposition = { kind: "silent" };
        body = "";
      }
      this.exec(roomId, { type: "output", actor: SYSTEM, id: `output:${runId}`, author: seatId, sourceKey, association: { kind: "run", id: runId }, body, disposition });
      this.step("output", roomId, seatId, runId);
      p = this.project(roomId);
    }
    const output = p.events.find((e) => e.id === p.sourceKeys.get(sourceKey))!.data;
    const failure = output.kind === "output" && output.disposition.kind === "error" ? output.body : null;
    if (p.runs.get(runId)!.phase !== "terminal") {
      this.exec(roomId, { type: "observe_end", actor: SYSTEM, id: `end:${runId}`, runId, sourceKey, failure, evidence: end.evidence });
      this.step("ended", roomId, seatId, runId);
    }
    this.firstSent.delete(runId);
    this.refused.delete(runId);
    this.stuck.delete(runId);
    this.interrupted.delete(runId);
    this.stopping.delete(runId);
  }

  /**
   * When a failing run was a retry of one that failed on the same request: which failure on it this is, so the
   * orchestrator reports a failure that repeats instead of retrying it again.
   */
  private againAfterRetry(p: Projection, run: Run, targets: readonly string[]): string {
    if (!inputTree(deliveredInputs(p, run.id)).some((i) => i.intent === "retry")) return "";
    const before = p.events.filter((e) => e.data.kind === "notice" && e.data.intent === "error" && e.data.requestIds.some((id) => targets.includes(id))).length;
    if (before === 0) return "";
    const nth = ["second", "third", "fourth", "fifth"][before - 1] ?? `${before + 1}th`;
    return `\n\nThis is the ${nth} failure on this request, after a retry.`;
  }

  /**
   * A turn its provider's usage limit stopped: paused, not failed, until the reset (in the service's time zone, named),
   * when T3 continues it (src/app/limitRecovery.ts arms it). Its reply then comes as a follow-up.
   */
  private pausedNotice(roomId: string, seatId: string, limit: RunLimit): string {
    const timeZone = this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const time = resetTime(limit.resetAt, this.now(), timeZone);
    const said = limit.message ? ` ${providerLabel(limit.provider)} said: "${limit.message}"` : "";
    if (time === null) return `${this.named(roomId, seatId)}'s turn is paused on ${providerLabel(limit.provider)}'s usage limit, which gave no reset time.${said} T3 cannot continue it by itself: Resume on the member continues it.`;
    return `${this.named(roomId, seatId)}'s turn is paused on ${providerLabel(limit.provider)}'s usage limit until ${time} (${timeZone}), not failed.${said} T3 continues the turn by itself at the reset, and its reply comes as a follow-up.`;
  }

  /** What a turn the host did not start said, and how it ended when it did not complete: stopped, failed, or paused on a limit. */
  private shownEnd(roomId: string, seatId: string, detail: T3ThreadDetail, t3Run: T3Run, text: string): string {
    const end = runEnd(t3Run);
    if (end === "completed") return text;
    const limit = runLimit(detail, t3Run);
    return `${text ? `${text}\n\n` : ""}(${limit ? this.pausedNotice(roomId, seatId, limit) : `${end === "interrupted" ? "stopped" : "failed"} in T3: ${runError(detail, t3Run)}`})`;
  }

  /** A member's status line and a blank line, for the top of its post; nothing for the orchestrator's, or with no T3 run. */
  private statusHead(roomId: string, seatId: string, status: MemberStatus | null): string {
    return status && seatId !== this.project(roomId).orchestrator ? `${statusLine(this.source.alias?.(roomId, seatId) ?? seatId, status)}\n\n` : "";
  }

  /** The requests of the seat's that a run was given, whatever their state now. */
  private given(p: Projection, run: Run): string[] {
    return unique(inputTree(deliveredInputs(p, run.id)).flatMap((i) => i.requestIds)).filter((id) => p.requests.get(id)?.owner === run.seatId);
  }

  // ---------------- §6 cancel ----------------

  /** The interrupt of a cancel that stops this run (§6) goes out once T3 has the run and while T3 still runs it. */
  private async sendInterrupts(roomId: string, runId: string, threadId: string, t3Run: T3Run): Promise<void> {
    const p = this.project(roomId);
    const cancelId = stoppingCancel(p, p.runs.get(runId)!);
    if (!cancelId || isTerminal(t3Run) || this.interrupted.has(runId)) return;
    try {
      await this.adapter.interruptRun({ commandId: `interrupt:${cancelId}`, threadId, runId: t3Run.id });
    } catch (error) {
      if (!(error instanceof T3CommandRejected)) {
        this.log("interrupt not sent; trying again", message(error));
        return;
      }
    }
    this.interrupted.add(runId);
  }

  private interruptedByCancel(roomId: string, runId: string): boolean {
    const p = this.project(roomId);
    return stoppingCancel(p, p.runs.get(runId)!) !== null;
  }

  /**
   * Cancels recorded while their request's owner was in a turn working on other requests too. They apply when that turn
   * ends (`atTurnEnd`), or at once when the owner has no live run. Nothing is interrupted.
   */
  private applyDeferredCancels(roomId: string, seatId: string, atTurnEnd: boolean): void {
    const p = this.project(roomId);
    if (!atTurnEnd && p.seats.get(seatId)?.activeRunId) return;
    for (const d of deferredCancels(p)) {
      if (p.requests.get(d.requestId)?.owner !== seatId || committed(p, d.actor, d.cancelId)) continue;
      try {
        this.exec(roomId, { type: "cancel", actor: d.actor, id: d.cancelId, requestId: d.requestId });
      } catch (error) {
        this.log("deferred cancel not applied", { requestId: d.requestId, error: message(error) });
      }
    }
  }

  // ---------------- §2 and §3: turns the host did not start ----------------

  /**
   * Import what happened on the thread outside host runs, each once by its T3 ID: messages typed in T3 or sent by other
   * agents are notes, and the reply of every such turn (typed in T3, started by another agent's message, or started by
   * the member itself) is a follow-up. Only T3 runs after the seat's first host run count; earlier ones are the
   * thread's history. Returns whether everything is imported, which R3 waits for.
   */
  private async importThread(roomId: string, seatId: string, shell: T3ThreadShell, load: Loader): Promise<boolean> {
    let p = this.project(roomId);
    const seat = p.seats.get(seatId)!;
    const key = shellKey(shell);
    if (this.seen.get(seatId) === key && !seat.activeRunId) return true;
    const detail = await load();
    if (!detail) return false;
    const hostRuns = [...p.runs.values()].filter((r) => r.seatId === seatId);
    // Messages sent into a running turn are the board's too: what they carried is on it already.
    const hostMessages = new Set([...hostRuns.map((r) => r.dispatchMessageId), ...steerMessageIds(p, seatId)]);
    const adoptable = new Set(adoptableSteers(p, seatId).map((s) => s.messageId));
    const baseline = this.baseline(p, seatId);
    if (baseline === null) {
      this.seen.set(seatId, key);
      return true;
    }
    const ordinals = new Map(detail.runs.map((r) => [r.id, r.ordinal]));
    // Imports are deduplicated by their journal event ID, whoever authored them: the author can change with seat states.
    const imported = new Set(p.events.map((e) => e.id));
    let done = true;
    for (const m of detail.messages) {
      if (m.role !== "user" || hostMessages.has(m.id) || m.runId === null || (ordinals.get(m.runId) ?? -1) < baseline) continue;
      // A T3 notice starts the member's own continuation; that run is imported below. So does T3's continuation of a
      // turn its usage limit paused, sent by T3 at the reset or by Backroom's Resume: nobody typed it.
      if (m.createdBy !== "user" && m.senderThreadId === null) continue;
      if (isContinuation(m)) continue;
      if (!m.text.trim() && m.attachments.length === 0) continue;
      const id = `t3msg:${seat.threadId}:${m.id}`;
      if (imported.has(id)) continue;
      const pictures = m.attachments.length ? `\n[${m.attachments.length} attachment(s) in T3]` : "";
      let author = "$user";
      let body = `${m.text.trim()}${pictures}`;
      if (m.senderThreadId !== null) {
        // By the sender's seat when it can post; a retired or stopping sender's message is posted by the recipient.
        const sender = [...p.seats.values()].find((s) => s.threadId === m.senderThreadId);
        author = sender?.status === "active" ? sender.id : seatId;
        body = !sender ? `From a thread outside the room (${m.senderThreadId}), sent in T3: ${body}`
          : author === sender.id ? `To @${seatId} (sent in T3): ${body}` : `From @${sender.id} (sent in T3): ${body}`;
      }
      try {
        this.exec(roomId, { type: "post", actor: author, id, intent: "note", body });
      } catch (error) {
        this.log("message import waits", { id, error: message(error) });
        done = false;
      }
    }
    // A host message T3 recorded only after its run had failed ("never recorded") runs unmatched: its reply is a note.
    const records = runRecords(p);
    const matched = new Set(hostRuns.filter((r) => r.phase !== "terminal" || records.get(r.id)?.t3).map((r) => r.dispatchMessageId));
    // Cursor and Antigravity take a message into a running turn by restarting the turn with it: the host run's T3 run
    // then names that message as its own. Known by the T3 run ID the host run was matched to, together with a message
    // offered to that host run, so a run ID T3 gives again after counting from 1 (H4) is never taken for it.
    const restarted = new Set(steerOffers(p, seatId).flatMap((s) => {
      const t3 = records.get(s.runId)?.t3;
      return t3 ? [`${t3.id} ${s.messageId}`] : [];
    }));
    // A run on one of the seat's host messages is never the thread's history, whatever its number: after T3 counts the
    // thread's runs from 1 again (H4), a failed run's message runs under a number at or below the baseline.
    const runs = detail.runs.filter((r) => (r.ordinal > baseline || hostMessages.has(r.userMessageId)) && !matched.has(r.userMessageId) && !restarted.has(`${r.id} ${r.userMessageId}`) && isTerminal(r)).sort((a, b) => a.ordinal - b.ordinal);
    for (const t3Run of runs) {
      p = this.project(roomId);
      const id = `t3run:${seat.threadId}:${t3Run.id}`;
      if (imported.has(id) || imported.has(`${KEEP_ALIVE_REPLY}${id}`)) continue;
      const final = finalMessage(detail, t3Run.id);
      if (final.streaming) {
        done = false;
        break;
      }
      const end = runEnd(t3Run);
      const text = final.message?.text.trim() ?? "";
      const shown = this.shownEnd(roomId, seatId, detail, t3Run, text);
      try {
        const status = memberStatus(detail, t3Run.id);
        if (runOrigin(detail, t3Run, hostMessages) === "host") {
          const failed = hostRuns.find((r) => r.dispatchMessageId === t3Run.userMessageId);
          // H6: a keep-alive's reply is a note that wakes nobody, also when T3 ran it after its run had failed.
          if (failed && keepAliveRun(p, failed)) this.exec(roomId, { type: "post", actor: seatId, id: `${KEEP_ALIVE_REPLY}${id}`, intent: "note", body: `(T3 ran a keep-alive after Backroom had recorded it as failed) ${shown}` });
          else if (failed) this.followUp(roomId, seatId, id, `(T3 ran a message after Backroom had recorded it as failed) ${shown}`, status, this.given(p, failed));
          // A message for a running turn that T3 ran as a turn of its own: the reserve pass adopts it, or, once that window has closed, its reply is a follow-up.
          else if (adoptable.has(t3Run.userMessageId)) continue;
          else this.steerNote(roomId, seatId, id, t3Run.userMessageId, shown, status);
        } else {
          // T3's continuation of a turn its usage limit paused follows up on what that turn was given.
          const continued = continuedRun(detail, t3Run);
          const paused = continued ? hostRuns.find((r) => records.get(r.id)?.t3?.id === continued.id) : undefined;
          this.followUp(roomId, seatId, id, shown, status, paused ? this.given(p, paused) : undefined);
        }
      } catch (error) {
        this.log("turn import waits", { id, error: message(error) });
        done = false;
        break;
      }
      this.step("imported", roomId, seatId);
    }
    if (done) this.seen.set(seatId, key);
    return done;
  }

  /** The T3 ordinal of the seat's first host run, from its `accepted` evidence; null before it has one. */
  private baseline(p: Projection, seatId: string): number | null {
    const ordinals = [...runRecords(p).values()].flatMap((r) => (r.seatId === seatId && r.t3 ? [r.t3.ordinal] : []));
    return ordinals.length ? Math.min(...ordinals) : null;
  }

  /**
   * A seat's turn that answers nothing is a follow-up post on the requests it follows up on (the ones named, else those
   * its latest answer closed), and wakes the orchestrator; a member's carries its status. With no request to put it on,
   * it is a note.
   */
  private followUp(roomId: string, seatId: string, id: string, text: string, status: MemberStatus | null, requestIds?: readonly string[]): void {
    const p = this.project(roomId);
    if (!text || p.events.some((e) => e.id === id)) return;
    const ids = unique(requestIds?.length ? requestIds : followedRequests(p, seatId));
    const body = `${this.statusHead(roomId, seatId, status)}${text}`;
    if (ids.length === 0) {
      this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body });
      return;
    }
    this.subscribeOrchestrator(roomId, seatId, ids);
    this.exec(roomId, { type: "post", actor: seatId, id, intent: "progress", body, requestIds: ids, milestone: FOLLOW_UP });
  }

  /** The orchestrator follows the requests a member's follow-up goes on, so that the follow-up wakes it. */
  private subscribeOrchestrator(roomId: string, seatId: string, ids: readonly string[]): void {
    const p = this.project(roomId);
    const o = p.orchestrator;
    if (!o || o === seatId || p.seats.get(o)?.status !== "active") return;
    for (const id of ids) {
      if (p.subscriptions.some((x) => x.seatId === o && x.requestId === id && x.milestones.includes(FOLLOW_UP))) continue;
      this.exec(roomId, { type: "subscribe", actor: o, id: `${FOLLOW_UP}:${id}`, requestId: id, milestones: [FOLLOW_UP], enabled: true });
    }
  }

  /**
   * Background work a member's latest post named that T3 no longer lists, with no turn since: once the thread has been
   * quiet for `quietMs`, one follow-up says it ended, or the orchestrator would never learn of it.
   */
  private async quiet(roomId: string, seatId: string, shell: T3ThreadShell, load: Loader, imported: boolean): Promise<void> {
    const p = this.project(roomId);
    const latest = seatId === p.orchestrator ? null : latestStatusPost(p, seatId);
    if (!latest || latest.running.length === 0 || !imported || p.seats.get(seatId)!.activeRunId || !threadFree(shell)) {
      this.quietSince.delete(seatId);
      return;
    }
    const detail = await load();
    if (!detail) return;
    const now = memberStatus(detail, null);
    const ended = latest.running.filter((label) => !now.running.includes(label));
    const id = `${QUIET}${latest.eventId}`;
    if (ended.length === 0 || now.turnRunning) {
      this.quietSince.delete(seatId);
      return;
    }
    const since = this.quietSince.get(seatId);
    if (since?.id !== id) {
      this.quietSince.set(seatId, { id, at: this.now() });
      return;
    }
    if (this.now() - since.at < this.quietMs) return;
    const why = stoppedEverything(detail) ? ": the user stopped everything from Backroom" : " without a further turn";
    this.followUp(roomId, seatId, id, `(${ended.join(", ")} ended${why}.)`, now, latest.requestIds);
    this.quietSince.delete(seatId);
    this.step("imported", roomId, seatId);
  }

  // ---------------- a member held by T3 or the user ----------------

  /**
   * A member that owns open requests and whose thread is held where no reply of its own will end it: the orchestrator is
   * told once per request per state (the engine keeps that), as T3 tells the user once per run per state. Working, a
   * tool running, a task list changing or a check moving is never posted, and neither is a state clearing: the member's
   * next reply is that news.
   */
  private async blocked(roomId: string, seatId: string, load: Loader, subagents: () => Promise<SubagentRequest[] | null>): Promise<void> {
    const p = this.project(roomId);
    if (!p.orchestrator || p.orchestrator === seatId || p.seats.get(seatId)!.status !== "active") return;
    if (![...p.requests.values()].some((q) => q.owner === seatId && q.state === "open")) return;
    const detail = await load();
    const theirs = (await subagents()) ?? [];
    const now = this.project(roomId);
    const seat = now.seats.get(seatId)!;
    if (now.orchestrator === null || now.orchestrator === seatId || seat.status !== "active") return;
    const hold = this.holdOf(roomId, seatId, detail, seat.activeRunId ? now.runs.get(seat.activeRunId) : undefined, theirs);
    if (!hold) return;
    const told = blockedNoticed(now, seatId, hold.state, hold.hold);
    // The turn the limit stopped already says so in its own notice (pausedNotice), on the requests it was given: a host
    // run's error notice, or the follow-up of a turn the room did not start, both of that limited run.
    const records = runRecords(now);
    const ofLimitedRun = (e: (typeof now.events)[number]) =>
      e.data.kind === "notice" ? records.get(e.data.causeId)?.t3?.id === hold.hold : e.id === `t3run:${seat.threadId}:${hold.hold}`;
    const said = (id: string) => hold.state === "limited" && now.events.some((e) => (e.data.kind === "notice" || e.data.kind === "progress") && e.data.requestIds.includes(id) && isPausedNotice(e.data.body) && ofLimitedRun(e));
    const ids = [...now.requests.values()].filter((q) => q.owner === seatId && q.state === "open" && !told.has(q.id) && !said(q.id)).map((q) => q.id);
    if (ids.length === 0) return;
    this.exec(roomId, { type: "blocked", actor: SYSTEM, id: `blocked:${seatId}:${hold.state}:${hold.hold}:${ids.join(",")}`, seatId, state: hold.state, hold: hold.hold, requestIds: ids, body: hold.body });
  }

  /**
   * What holds the member's thread that no reply of its own ends: its state, the hold's own identity (the request T3
   * waits on, the limited run, the held run, when the thread was settled or archived), and the notice's words. A new
   * hold in the same state is told again; the same one never. Null when nothing holds it.
   */
  private holdOf(roomId: string, seatId: string, detail: T3ThreadDetail | null, live: Run | undefined, subagents: readonly SubagentRequest[]): { state: string; hold: string; body: string } | null {
    const who = this.named(roomId, seatId);
    const threadId = this.project(roomId).seats.get(seatId)!.threadId;
    const gone = (how: string) => `${who}'s T3 thread was ${how} in T3 while seated: no reply will come from it. Reseat or retire ${who}, or report it.`;
    if (!detail || detail.shell.deletedAt !== null) return { state: "deleted", hold: threadId, body: gone("deleted") };
    if (detail.shell.archivedAt !== null) return { state: "archived", hold: detail.shell.archivedAt, body: gone("archived") };
    const state = memberState(memberFacts(detail, live !== undefined, this.now(), subagents), this.now());
    // What T3 waits on of the kind the state names, the member's own first: a question asked before an approval does not
    // word the approval. A subagent's is named with the subagent.
    const asked = (type: "approval" | "secret" | "user-input") => {
      const own = openRequests(detail).find((request) => request.type === type);
      const theirs = own ? undefined : subagents.find((s) => s.request.type === type);
      return { request: own ?? theirs?.request, by: theirs ? `${who}'s subagent "${oneLine(theirs.title)}"` : who };
    };
    const answer = `Only the user can answer it, from the page; ${who}'s reply comes after.`;
    switch (state.state) {
      case "approval": {
        const { request, by } = asked("approval");
        const what = request?.prompt ?? request?.appName;
        return { state: "approval", hold: request?.id ?? threadId, body: `${by} waits on an approval${what ? `: ${clip(what)}` : "."} ${answer}` };
      }
      case "secret": {
        const { request, by } = asked("secret");
        return { state: "secret", hold: request?.id ?? threadId, body: `${by} asks for a secret${request?.secret ? `: ${clip(request.secret.label)}` : "."} ${answer}` };
      }
      case "input": {
        const { request, by } = asked("user-input");
        const question = request?.questions.map((q) => q.question).join(" / ");
        return { state: "input", hold: request?.id ?? threadId, body: `${by} waits on an answer to a question${question ? `: ${clip(question)}` : "."} ${answer}` };
      }
      case "limited": {
        // The turn the limit stopped, when it is this run's, ends with its own notice (pausedNotice).
        const limited = detail.shell.usageLimit!;
        const t3 = live ? runRecords(this.project(roomId)).get(live.id)?.t3 : undefined;
        if (live && (!t3 || t3.id === limited.runId)) return null;
        return { state: "limited", hold: limited.runId, body: this.pausedHold(roomId, seatId, pauseOf(limited)) };
      }
      case "held":
        return { state: "held", hold: latestExecutedRun(detail.runs)?.id ?? threadId, body: `T3 holds ${who}'s queue${state.detail ? ` (${state.detail})` : ""}: nothing sent to ${who} runs until the user presses Resume queue on the member.` };
    }
    if (detail.shell.settledAt !== null) return { state: "settled", hold: detail.shell.settledAt, body: `${who}'s T3 thread was settled in T3 (marked done there) while seated, with this request open. Ask the user whether that was meant; reseat or retire ${who} if it was.` };
    return null;
  }

  // ---------------- a watched pull request's finished run ----------------

  /** Watched pull requests (by room, seat, watch task and head) this host has seen a check pending on, since it started. */
  private readonly checksPending = new Set<string>();

  /**
   * T3's watch of a pull request wakes its thread when the checks' rolled-up state or the mergeability changes, not
   * when a run finishes: one failed check makes the state failing while the others still run, and the run's end then
   * changes nothing T3 compares. GitHub refuses a rerun until the run completes, so the Consigliere is told once when a
   * watched pull request, on any seat's thread (his own too), goes from a check pending to none with one failed. Once per
   * pull request and head: a new push is a new run; a run that passes is T3's to wake on.
   */
  private async checksFinished(roomId: string, seatId: string, shell: T3ThreadShell | null): Promise<void> {
    const read = this.options.watchedChecks;
    const p = this.project(roomId);
    if (!read || !shell || !p.orchestrator || p.seats.get(seatId)!.status !== "active" || !shell.pendingBackgroundTasks.some(isPullRequestWatch)) return;
    for (const [taskId, checks] of await read(shell)) {
      const link = watchedLink(shell.pullRequests, taskId);
      // No checks read, or none listed (none started yet, or T3 lost them for a moment), says nothing of the run.
      if (!link?.watch || !checks || checks.checks.length === 0) continue;
      const key = `${taskId}@${link.watch.headSha ?? link.watch.startedAt}`;
      // What a seat's watch has shown is that seat's, in its room: two rooms (or two seats of one) watching the same pull
      // request each see it pending; the board's key keeps one notice per room.
      const seen = JSON.stringify([roomId, seatId, key]);
      const failed = finishedWithFailures(checks);
      if (failed === null) {
        this.checksPending.add(seen);
        continue;
      }
      if (!this.checksPending.delete(seen) || failed.length === 0) continue;
      if (this.project(roomId).events.some((e) => e.data.kind === "notice" && e.data.causeId === checksCause(key))) continue;
      const names = failed.slice(0, 5).join(", ") + (failed.length > 5 ? `, and ${failed.length - 5} more` : "");
      const body = `Pull request #${link.number} (${link.repository}), watched on ${this.named(roomId, seatId)}'s thread: its checks have finished, ${failed.length} failed (${oneLine(names)}). A rerun of the failed checks is possible now; T3's watch does not wake on a run finishing.`;
      this.exec(roomId, { type: "checks_finished", actor: SYSTEM, id: `checks:${key}`, seatId, key, body });
    }
  }

  /** A usage-limit pause that holds what the member was sent: until when, in the service's named time zone, and whether T3 continues it. */
  private pausedHold(roomId: string, seatId: string, pause: ReturnType<typeof pauseOf>): string {
    const timeZone = this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const time = resetTime(pause.resetAt, this.now(), timeZone);
    const who = this.named(roomId, seatId);
    const then = time === null ? "which gave no reset time: T3 cannot continue it by itself"
      : `until ${time} (${timeZone}): ${pause.resume === "on" ? "T3 continues it at the reset" : pause.resume === "off" ? "T3 will not continue it" : "T3 is not yet set to continue it"}`;
    return `${who} is paused on ${providerLabel(pause.provider)}'s usage limit, ${then}. What it was sent waits behind it; Resume now on the member continues it sooner.`;
  }

  // ---------------- H6: keep-alives ----------------

  /** A seat's keep-alive: the interval, whether keep-alives are on for it, and whether that is the room's choice or the default. */
  keepAliveFor(roomId: string, seatId: string): { intervalMs: number; on: boolean; chosen: boolean } {
    const setting = this.options.keepAlive?.(roomId, seatId) ?? { intervalMs: KEEP_ALIVE_MS, on: null };
    return { intervalMs: setting.intervalMs, on: setting.intervalMs > 0 && (setting.on ?? seatId === this.project(roomId).orchestrator), chosen: setting.on !== null };
  }

  /**
   * The ID of the keep-alive that follows the thread's latest turn: one per turn, whatever restarts in between. It names
   * the turn's end too, so a T3 run ID given again (T3 counting a thread's runs from 1 again, H4) is a new turn.
   */
  private keepAliveId(seatId: string, shell: T3ThreadShell): string | null {
    return shell.latestRunId && shell.latestRunCompletedAt ? `${KEEP_ALIVE}${seatId}:${shell.latestRunId}:${shell.latestRunCompletedAt}` : null;
  }

  /**
   * A seat that is idle, with nothing to read but keep-alives, whose latest turn ended its keep-alive interval ago, and
   * whose work is in flight, gets a keep-alive: the prompt cache lasts an hour, and a cold reread of a large thread
   * costs many times a warm one. The listed shell only rules seats out; the seat's own thread decides, as it is now.
   * The ID names that turn, so it is posted once: a restart finds it, and only another interval after the next turn
   * (the keep-alive's own included) makes another. A seat whose threads were read and given no keep-alive is looked at
   * again a minute on, or once the list shows another turn.
   */
  private async keepAlive(roomId: string, seatId: string, listed: T3ThreadShell, imported: boolean, load: Loader, stateOf: (seatId: string) => { load: Loader } | undefined): Promise<void> {
    const { intervalMs, on } = this.keepAliveFor(roomId, seatId);
    if (!on) return;
    const p = this.project(roomId);
    const seat = p.seats.get(seatId)!;
    const due = (shell: T3ThreadShell) => {
      const id = this.keepAliveId(seatId, shell);
      const ended = Date.parse(shell.latestRunCompletedAt ?? "");
      return id && threadFree(shell) && this.now() - ended >= intervalMs && !committed(p, SYSTEM, id) ? id : null;
    };
    if (seat.status !== "active" || seat.activeRunId || !imported || !due(listed)) return;
    if (unread(p, seatId).some((i) => i.intent !== "keep-alive")) return;
    const checked = this.idleSince.get(seatId);
    if (checked?.id === this.keepAliveId(seatId, listed) && this.now() - checked.at < KEEP_ALIVE_RECHECK_MS) return;
    // Whenever the threads were read and nothing was posted, the next look waits a minute (or for a turn the list shows):
    // T3's list and the thread can disagree for a while (a request the thread keeps pending after its run, a held run).
    const idle = (): void => {
      this.idleSince.set(seatId, { id: this.keepAliveId(seatId, listed) ?? "", at: this.now() });
    };
    const detail = await load();
    const id = detail && !detail.runs.some((r) => !isTerminal(r)) ? due(detail.shell) : null;
    if (!detail || !id) return idle();
    const lines = await this.inFlight(roomId, seatId, detail, stateOf);
    if (lines.length === 0) return idle();
    this.idleSince.delete(seatId);
    this.exec(roomId, { type: "keep_alive", actor: SYSTEM, id, seatId, body: [KEEP_ALIVE_LINE, ...lines].join("\n") });
    this.step("keep-alive", roomId, seatId);
  }

  /**
   * The status lines of a seat's work in flight; none when nothing is. Each comes from the thread's detail, the source
   * of the status line itself: a member that works for the seat (its live run or its unread input is on a request the
   * seat asked, or, with no live run, its latest status post is on one) counts while its thread shows a turn or work
   * running (background tasks, subagents); then the seat's own background tasks and subagents.
   */
  private async inFlight(roomId: string, seatId: string, own: T3ThreadDetail, stateOf: (seatId: string) => { load: Loader } | undefined): Promise<string[]> {
    const p = this.project(roomId);
    const asked = (ids: readonly string[]) => ids.some((id) => p.requests.get(id)?.returnTo === seatId);
    const named = (id: string) => this.source.alias?.(roomId, id) ?? id;
    const lines: string[] = [];
    for (const member of p.seats.values()) {
      if (member.id === seatId || member.status !== "active") continue;
      const run = member.activeRunId ? p.runs.get(member.activeRunId) : undefined;
      const working = (run !== undefined && asked(finalTargets(p, run))) || unread(p, member.id).some((i) => TARGETING.has(i.intent) && asked(i.requestIds));
      if (!working && !(run === undefined && asked(latestStatusPost(p, member.id)?.requestIds ?? []))) continue;
      const detail = await stateOf(member.id)?.load();
      const status = detail ? memberStatus(detail, null) : null;
      if (status?.inFlight) lines.push(statusLine(named(member.id), status));
    }
    const status = memberStatus(own, null);
    if (status.inFlight) lines.push(statusLine(named(seatId), status));
    return lines;
  }

  // ---------------- messages into a running turn (L4a, M1; src/runtime/steer.ts) ----------------

  /**
   * Requests, corrections and retries from the user or the orchestrator go into the seat's live run while T3 runs it:
   * one offer at a time, a sync receipt over every unread input since the run's watermark, sent with `steer_active` into
   * the T3 run and confirmed once T3 shows the member working after it in that run; the run's final then answers them
   * too (§1). Never while the run waits on an approval or a question, into a run that takes no messages (a keep-alive's,
   * one on Backroom's own request), or into one a cancel or the room's Stop is ending.
   */
  private async steerInto(roomId: string, seatId: string, runId: string, t3Run: T3Run, load: Loader): Promise<void> {
    const detail = await load();
    if (!detail) return;
    this.confirmSteers(roomId, runId, t3Run.id, detail);
    const p = this.project(roomId);
    const run = p.runs.get(runId)!;
    const threadId = p.seats.get(seatId)!.threadId;
    // Nothing more goes into a turn that is being stopped: what is unread waits for the seat's next turn.
    if (this.ending(p, run)) return;
    const inFlight = steerOffers(p, seatId).find((s) => s.runId === runId && !s.receipt.confirmed && !this.steerGaveUp.has(s.receipt.id) && !settledOffer(p, s));
    if (inFlight) {
      // T3 has it (taken, or soon): wait. Or T3 ran it as a turn of its own: adopted once this run ends.
      if (detail.messages.some((m) => m.id === inFlight.messageId) || t3Run.status !== "running") return;
      // Not in T3 yet, and everything it asks was cancelled since: it is not sent again.
      if (this.withdrawn(p, inFlight)) {
        this.steerGaveUp.add(inFlight.receipt.id);
        this.log("a message for the running turn was cancelled before T3 had it; it is not sent again", { receiptId: inFlight.receipt.id });
        return;
      }
      if (!(await this.sendSteer(roomId, inFlight, t3Run.id, threadId, load))) return;
      const after = await load(true);
      if (after) this.confirmSteers(roomId, runId, t3Run.id, after);
      return;
    }
    if (t3Run.status !== "running" || detail.shell.pendingRequest !== null || p.seats.get(seatId)!.status !== "active" || !takesMessages(p, run)) return;
    const offered = new Set(run.receipts.flatMap((r) => inputTree(r.envelope.inputs).map((i) => i.eventId)));
    const waiting = unread(p, seatId, run.through);
    if (!waiting.some((i) => goesIntoTurn(p, i) && !offered.has(i.eventId)) || holdsBack(p, seatId, waiting)) return;
    const receiptId = steerReceiptId(randomUUID(), randomUUID());
    if (this.exec(roomId, { type: "sync", actor: SYSTEM, id: `sync:${receiptId}`, runId, receiptId, maxBytes: this.maxBytes }).outcome !== "appended") return;
    this.step("steered", roomId, seatId, runId);
    const offer = steerOffers(this.project(roomId), seatId).find((s) => s.receipt.id === receiptId)!;
    if (!(await this.sendSteer(roomId, offer, t3Run.id, threadId, load))) return;
    const after = await load(true);
    if (after) this.confirmSteers(roomId, runId, t3Run.id, after);
  }

  /** A run a cancel or the room's Stop is ending: it takes nothing more, and nothing T3 shows in it is confirmed. */
  private ending(p: Projection, run: Run): boolean {
    return stoppingCancel(p, run) !== null || this.stopping.has(run.id);
  }

  /** An offer whose every request was cancelled since (applied, or held to the turn's end): what it asks is withdrawn. */
  private withdrawn(p: Projection, offer: SteerOffer): boolean {
    const asked = inputTree(offer.receipt.envelope.inputs).filter((i) => TARGETING.has(i.intent)).flatMap((i) => i.requestIds);
    const held = new Set(deferredCancels(p).map((d) => d.requestId));
    return asked.length > 0 && asked.every((id) => p.requests.get(id)?.state === "cancelled" || held.has(id));
  }

  /** Send an offer's message into the T3 run, or resend it identically. Returns whether T3 took it. */
  private async sendSteer(roomId: string, offer: SteerOffer, t3RunId: string, threadId: string, load: Loader): Promise<boolean> {
    const first = this.steerSent.get(offer.receipt.id);
    if (first !== undefined && this.now() - first > this.unrecordedMs) {
      this.steerGaveUp.add(offer.receipt.id);
      this.log("T3 never recorded a message sent into the running turn; what it carried waits for the next turn", { receiptId: offer.receipt.id });
      return false;
    }
    let rendered = this.steerTexts.get(offer.receipt.id);
    if (!rendered) {
      // The work part only: the thread holds the standing part already (L2 sends what changed, or all after a compaction).
      const detail = await load(true);
      const p = this.project(roomId);
      const briefed = await brief(this.source, this.budgetChars, { roomId, seatId: offer.seatId, runId: offer.runId, envelope: offer.receipt.envelope, projection: p, had: seatStanding(p, offer.seatId, detail) });
      rendered = { text: `${briefed.text}\n\n${STEER_NOTE}`, images: briefed.images };
      this.steerTexts.set(offer.receipt.id, rendered);
    }
    const images = attachImages(this.source, roomId, rendered.images);
    this.steerAttempted.add(offer.receipt.id);
    try {
      await this.adapter.sendMessage({ commandId: offer.commandId, threadId, messageId: offer.messageId, text: rendered.text, ...(images.length ? { images } : {}), mode: { type: "steer", runId: t3RunId } });
    } catch (error) {
      // Sent but never answered: T3 may have it. Counted toward `unrecordedMs` like any unknown acknowledgement.
      if (error instanceof T3Unavailable && !(error instanceof T3OutcomeUnknown)) return false;
      if (error instanceof T3CommandRejected) {
        this.steerGaveUp.add(offer.receipt.id);
        this.log("T3 refused a message into the running turn; what it carried waits for the next turn", { receiptId: offer.receipt.id, error: error.message });
        return false;
      }
      this.steerSent.set(offer.receipt.id, first ?? this.now());
      this.log("acknowledgement of a message into the running turn unknown; reconciling by message ID", message(error));
      return false;
    }
    this.steerSent.set(offer.receipt.id, first ?? this.now());
    this.step("steer-sent", roomId, offer.seatId, offer.runId);
    return true;
  }

  /**
   * T3 shows an offered message in the run it was sent into, with the member working after it: the offer is confirmed
   * with that evidence. One T3 shows after the run's last work was never taken, and is not; nor is anything in a run that
   * is being stopped (what it carried then starts the seat's next turn).
   */
  private confirmSteers(roomId: string, runId: string, t3RunId: string, detail: T3ThreadDetail): void {
    const p = this.project(roomId);
    const run = p.runs.get(runId)!;
    if (run.phase === "terminal" || this.ending(p, run)) return;
    for (const offer of steerOffers(p, run.seatId)) {
      if (offer.runId !== runId || offer.receipt.confirmed) continue;
      const item = takenInRun(detail, offer.messageId, t3RunId);
      if (!item) continue;
      this.exec(roomId, { type: "confirm_sync", actor: SYSTEM, id: `confirm:${offer.receipt.id}`, runId, receiptId: offer.receipt.id, digest: offer.receipt.digest, evidence: `t3msg:${offer.messageId} t3run:${t3RunId} ${item.inputIntent}` });
      this.steerSent.delete(offer.receipt.id);
      this.steerTexts.delete(offer.receipt.id);
      this.step("steer-confirmed", roomId, run.seatId, runId);
    }
  }

  /**
   * A message for a running turn that reached T3 after that run had ended: T3 ran it as a turn of its own. That run is
   * adopted as the host run for what the message carried, reserved with the message's own command and message IDs, so
   * the host follows it like a run it sent. When more input has arrived since the offer, that turn cannot answer it: its
   * reply becomes a follow-up on what the message carried, and everything goes in an ordinary run after it. A message
   * T3 has not recorded yet, though it was or may have been sent, is sent again with its own IDs (T3 keeps one receipt
   * per command ID, and runs it as a turn of its own now that its run has ended), and the seat waits for it up to
   * `unrecordedMs`; only then, or when T3 refused it, does an ordinary run carry what it carried. True while it waits.
   */
  private async adopt(roomId: string, seatId: string, load: Loader): Promise<boolean> {
    const candidates = adoptableSteers(this.project(roomId), seatId);
    if (candidates.length === 0) return false;
    const detail = await load(true);
    if (!detail) return true;
    for (const steer of candidates) {
      const m = detail.messages.find((x) => x.id === steer.messageId);
      if (!m) {
        const id = steer.receipt.id;
        // Refused, or every try in this process failed to reach T3: it never left, and an ordinary run carries it.
        if (!steer.carrierT3RunId || this.steerGaveUp.has(id) || (this.steerAttempted.has(id) && !this.steerSent.has(id))) continue;
        // Everything it asks was cancelled since: it is not sent again.
        if (this.withdrawn(this.project(roomId), steer)) {
          this.steerGaveUp.add(id);
          continue;
        }
        // T3 counted the thread's runs from 1 again (H4) and gave the carrier's ID to another run: nothing is sent into it.
        // The carrier's own messages are its dispatch and those offered to it (Cursor and Antigravity restart a turn with one).
        const own = new Set([this.project(roomId).runs.get(steer.runId)!.dispatchMessageId, ...steerOffers(this.project(roomId), seatId).filter((s) => s.runId === steer.runId).map((s) => s.messageId)]);
        const carrier = detail.runs.find((r) => r.id === steer.carrierT3RunId);
        if (carrier && !own.has(carrier.userMessageId)) {
          this.steerGaveUp.add(id);
          continue;
        }
        if (!this.steerSent.has(id)) this.steerSent.set(id, this.now()); // after a restart: perhaps sent; the wait starts now
        await this.sendSteer(roomId, steer, steer.carrierT3RunId, this.project(roomId).seats.get(seatId)!.threadId, load);
        if (this.steerGaveUp.has(id)) continue;
        return true;
      }
      const t3Run = m.runId ? detail.runs.find((r) => r.id === m.runId) : undefined;
      if (!t3Run || t3Run.id === steer.carrierT3RunId) continue;
      const p = this.project(roomId);
      const offered = new Set(inputTree(steer.receipt.envelope.inputs).map((i) => i.eventId));
      if (unread(p, seatId).some((i) => !offered.has(i.eventId))) {
        if (!isTerminal(t3Run)) return true;
        const final = finalMessage(detail, t3Run.id);
        if (final.streaming) return true;
        const end = runEnd(t3Run);
        const text = final.message?.text.trim() ?? "";
        const shown = this.shownEnd(roomId, seatId, detail, t3Run, text);
        this.steerNote(roomId, seatId, `t3run:${p.seats.get(seatId)!.threadId}:${t3Run.id}`, steer.messageId, shown, memberStatus(detail, t3Run.id));
        return false;
      }
      const id = randomUUID();
      const receipt = this.exec(roomId, { type: "reserve", actor: SYSTEM, id: `reserve:${id}`, seatId, runId: id, dispatchCommandId: steer.commandId, dispatchMessageId: steer.messageId, maxBytes: this.maxBytes });
      if (receipt.outcome !== "appended") return true;
      this.step("reserved", roomId, seatId, id);
      // What T3 was sent is the offered message itself, already in its run: that is what this run froze.
      const frozen: Dispatch = { dispatch: steer.commandId, text: m.text, images: [], held: seatStanding(this.project(roomId), seatId, detail) };
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${id}:sending`, runId: id, phase: "sending", evidence: JSON.stringify(frozen) });
      this.step("sending", roomId, seatId, id);
      await this.advance(roomId, seatId, id, load);
      return true;
    }
    return false;
  }

  /** The reply of a turn T3 ran for an offered message that could not be adopted: a follow-up on the requests it carried. */
  private steerNote(roomId: string, seatId: string, id: string, messageId: string, shown: string, status: MemberStatus): void {
    const p = this.project(roomId);
    const offer = steerOffers(p, seatId).find((s) => s.messageId === messageId);
    const carried = offer ? openOwned(p, inputTree(offer.receipt.envelope.inputs).flatMap((i) => i.requestIds), seatId) : [];
    this.followUp(roomId, seatId, id, `(T3 ran a message sent into the running turn as a turn of its own) ${shown}`, status, carried);
  }

  // ---------------- the API members and the user act through (L3, L4a, L4b call these) ----------------

  /** The seat's run that T3 is working on now, and the requests its final would answer. */
  currentWork(roomId: string, seatId: string): { runId: string; requestIds: string[] } | null {
    const p = this.project(roomId);
    const run = this.liveRun(p, seatId);
    return run ? { runId: run.id, requestIds: finalTargets(p, run) } : null;
  }

  seat(roomId: string, input: { actor: string; id: string; seatId: string; threadId: string; orchestrator?: boolean }): CommitReceipt {
    return this.member(roomId, { type: "seat", actor: input.actor, id: input.id, seatId: input.seatId, threadId: input.threadId, ...(input.orchestrator ? { orchestrator: true } : {}) });
  }

  /** L4b: a seat leaves with nothing to hand over. The core refuses it as it refuses a transfer, and with open owned work. */
  retire(roomId: string, input: { actor: string; id: string; seatId: string; evidence: string }): CommitReceipt {
    return this.member(roomId, { type: "retire", actor: input.actor, id: input.id, seatId: input.seatId, evidence: input.evidence });
  }

  /** L4b: the user moves or clears the orchestrator. */
  designate(roomId: string, input: { id: string; seatId: string | null }): CommitReceipt {
    return this.member(roomId, { type: "designate", actor: "$user", id: input.id, seatId: input.seatId });
  }

  /**
   * L4b's reseat: the old seat's open requests, return routes and unread input move to a fresh seat in one event. The
   * exact lists the core requires are read here, in the same synchronous step; a replay sends the committed ones again.
   */
  transfer(roomId: string, input: { actor: string; id: string; oldSeatId: string; newSeatId: string; threadId: string; body: string; evidence: string }): CommitReceipt {
    const p = this.project(roomId);
    const done = p.events.find((e) => e.id === input.id && e.data.kind === "transfer")?.data;
    const owned = done?.kind === "transfer" ? done.owned : [...p.requests.values()].filter((r) => r.owner === input.oldSeatId && r.state === "open").map((r) => r.id);
    const awaited = done?.kind === "transfer" ? done.awaited : [...p.requests.values()].filter((r) => r.returnTo === input.oldSeatId && r.state === "open").map((r) => r.id);
    return this.member(roomId, { type: "transfer", actor: input.actor, id: input.id, oldSeatId: input.oldSeatId, newSeatId: input.newSeatId, threadId: input.threadId, owned, awaited, body: input.body, evidence: input.evidence });
  }

  /** A request: the user's message path, the orchestrator's `rooms-board post`, and Backroom's own (src/app/engineSeats.ts). Members do not post (H5). */
  request(roomId: string, input: { actor: string; id: string; to: string; body: string }): CommitReceipt {
    if (input.actor !== "$user" && input.actor !== SYSTEM && input.actor !== this.project(roomId).orchestrator) throw new HostRefusal(MEMBERS_DO_NOT_POST);
    return this.member(roomId, { type: "request", actor: input.actor, id: input.id, to: input.to, body: input.body });
  }

  /** `rooms-board post "@x …"`: a request, under nothing. */
  post(roomId: string, input: { actor: string; id: string; to: string; body: string }): CommitReceipt {
    return this.request(roomId, input);
  }

  /**
   * A note that wakes nobody: a T3 command the user sent as typed, a reseat called off. A note about a request names it
   * (`requestIds`), or it reaches nobody's briefing (L2); one with the `room` milestone (the user's room note, which
   * journals from before N1 hold) reaches every seat's next briefing.
   */
  note(roomId: string, input: { actor: string; id: string; body: string; requestIds?: string[]; milestone?: string }): CommitReceipt {
    return this.member(roomId, { type: "post", actor: input.actor, id: input.id, intent: "note", body: input.body, ...(input.requestIds ? { requestIds: input.requestIds } : {}), ...(input.milestone ? { milestone: input.milestone } : {}) });
  }

  correct(roomId: string, input: { actor: string; id: string; requestId: string; body: string }): CommitReceipt {
    return this.member(roomId, { type: "correct", actor: input.actor, id: input.id, requestId: input.requestId, body: input.body });
  }

  retry(roomId: string, input: { actor: string; id: string; runId: string; body: string }): CommitReceipt {
    return this.member(roomId, { type: "retry", actor: input.actor, id: input.id, runId: input.runId, body: input.body });
  }

  /**
   * Withdraw a request (§6). The cancel applies at once. When it leaves the owner's turn nothing to work on, the turn is
   * interrupted (`stopped`); when the turn works on other requests too, the cancel goes into it like any message (M1):
   * the member is told mid-turn, and the turn's reply answers the rest. (Journals from before M1 hold cancels held to
   * the turn's end, as notes: a replay of one still says so.)
   */
  async cancel(roomId: string, input: { actor: string; id: string; requestId: string }): Promise<{ applied: boolean; deferred: boolean; stopped: boolean }> {
    const p = this.project(roomId);
    const q = p.requests.get(input.requestId);
    if (!q) throw new HostRefusal(`#${input.requestId} is not a request in this room.`);
    if (input.actor !== "$user" && input.actor !== q.returnTo && input.actor !== p.orchestrator) throw new HostRefusal(`Only whoever asked #${q.id} can cancel it.`);
    const noteId = `${DEFERRED_CANCEL}${JSON.stringify([q.id, input.id])}`;
    if (committed(p, input.actor, noteId) && !committed(p, input.actor, input.id)) return { applied: false, deferred: true, stopped: false };
    const owner = p.seats.get(q.owner);
    const run = owner?.activeRunId ? p.runs.get(owner.activeRunId)! : null;
    const receipt = this.member(roomId, { type: "cancel", actor: input.actor, id: input.id, requestId: q.id });
    const applied = receipt.events.some((e) => e.data.kind === "cancel" && e.data.applied);
    const live = run ? this.project(roomId).runs.get(run.id)! : null;
    const stopped = live !== null && live.phase !== "terminal" && live.phase !== "rejected" && stoppingCancel(this.project(roomId), live) !== null;
    if (run && owner && stopped) {
      // The cancel is recorded; sending the interrupt is best effort here, and the tick sends it otherwise.
      try {
        const detail = await this.adapter.getThreadDetail(owner.threadId);
        const t3Run = detail ? runForMessage(detail, run.dispatchMessageId) : null;
        if (t3Run) await this.sendInterrupts(roomId, run.id, owner.threadId, t3Run);
      } catch (error) {
        this.log("interrupt after a cancel waits for the tick", message(error));
      }
    }
    this.hint();
    return { applied, deferred: false, stopped };
  }

  /**
   * Withdraw an open request whose owner has no run, in the same step as what follows it (a retire): nothing is in a turn
   * to stop, so the cancel applies at once.
   */
  withdraw(roomId: string, input: { actor: string; id: string; requestId: string }): CommitReceipt {
    const p = this.project(roomId);
    const q = p.requests.get(input.requestId);
    if (!q || q.state !== "open") throw new HostRefusal(`#${input.requestId} is not an open request in this room.`);
    if (p.seats.get(q.owner)?.activeRunId) throw new HostRefusal(`@${q.owner} is in a turn: cancel #${q.id} instead.`);
    return this.member(roomId, { type: "cancel", actor: input.actor, id: input.id, requestId: q.id });
  }

  /**
   * The room's Stop for a seat (L4a): T3 interrupts the run active on its thread. A host run then ends as a failure with
   * its notice (§6), which the user can retry; a turn the host did not start becomes a follow-up when it ends.
   */
  /**
   * The user turned off T3's resume of a turn a usage limit paused (Don't resume): one follow-up, on the requests that
   * turn was given, tells the orchestrator it stays paused. `t3RunId` is the limited run: the follow-up is once per run.
   */
  async resumeOff(roomId: string, seatId: string, t3RunId: string): Promise<void> {
    // A member's post carries its T3 status at the top, as every post of its does.
    const threadId = this.project(roomId).seats.get(seatId)?.threadId;
    const detail = threadId ? await this.adapter.getThreadDetail(threadId, { bounded: true }) : null;
    const p = this.project(roomId);
    const records = runRecords(p);
    const paused = [...p.runs.values()].find((r) => r.seatId === seatId && records.get(r.id)?.t3?.id === t3RunId);
    const name = this.named(roomId, seatId);
    this.followUp(roomId, seatId, `resume-off:${t3RunId}`, `(The user turned off T3's resume of ${name}'s paused turn: T3 will not continue it at the reset. It stays paused until someone presses Resume now on ${name}.)`, detail ? memberStatus(detail, null) : null, paused ? this.given(p, paused) : undefined);
    this.options.notify?.(roomId);
    this.hint();
  }

  async stopSeat(roomId: string, seatId: string, everything = false): Promise<void> {
    const seat = this.project(roomId).seats.get(seatId);
    if (!seat || seat.status === "retired") throw new HostRefusal(`@${seatId} is not seated in this room.`);
    const shell = await this.adapter.getThreadShell(seat.threadId);
    // Stop everything stops what is left too: background work, monitors, subagents, a held queue, a limit's recovery.
    const left = shell !== null && (shell.pendingBackgroundTasks.length > 0 || shell.usageLimit?.recovery?.autoResume === true || isRunActive(shell.status));
    if (!shell || (!shell.activeRunId && !(everything && left))) throw new HostRefusal(`@${seatId} is not running anything in T3 now.`);
    // Nothing more goes into the host run being stopped: a message sent now starts the seat's next turn. A Stop T3 did
    // not take stops nothing, and the run takes messages again.
    const live = this.liveRun(this.project(roomId), seatId);
    const marked = shell.activeRunId && live?.providerRunId === shell.activeRunId ? live.id : null;
    if (marked) this.stopping.add(marked);
    try {
      if (everything) await this.adapter.controlThread({ commandId: randomUUID(), threadId: seat.threadId, control: { type: "thread.stop" } });
      else await this.adapter.interruptRun({ commandId: randomUUID(), threadId: seat.threadId, runId: shell.activeRunId });
    } catch (error) {
      if (marked) this.stopping.delete(marked);
      throw error;
    }
    this.hint();
  }

  // ---------------- helpers ----------------

  private liveRun(p: Projection, seatId: string): Run | null {
    const id = p.seats.get(seatId)?.activeRunId;
    const run = id ? p.runs.get(id) : undefined;
    return run && (run.phase === "accepted" || run.phase === "running" || run.phase === "uncertain") ? run : null;
  }

  /**
   * The room as committed now: the store's shared snapshot, which copies nothing and changes only by being replaced, so
   * every read after a write (the host's, a member's command that landed while the tick waited on T3) sees it.
   */
  private project(roomId: string): Projection {
    return this.store.snapshot(roomId);
  }

  private exec(roomId: string, command: Command): CommitReceipt {
    const receipt = this.store.execute(roomId, command);
    if (!receipt.replayed && receipt.events.length > 0) this.appends += 1;
    return receipt;
  }

  /** A member's or the user's command: committed, then the room is told and the host looks again. */
  private member(roomId: string, command: Command): CommitReceipt {
    const receipt = this.exec(roomId, command);
    if (!receipt.replayed && receipt.events.length > 0) {
      this.options.notify?.(roomId);
      this.hint();
    }
    return receipt;
  }

  private step(step: HostStep, roomId: string, seatId: string, runId?: string): void {
    try {
      this.options.onStep?.(step, { roomId, seatId, ...(runId ? { runId } : {}) });
    } catch (error) {
      this.halted = true;
      this.stop();
      throw error;
    }
  }

  /** Projection reads for callers (the read API, tests): the store's snapshot, which never changes and refuses every write. */
  view(roomId: string): Projection {
    return this.project(roomId);
  }

  /** Every room's journal head, from the store without projecting (src/app/changes.ts compares them). */
  heads(): Map<string, number> {
    return this.store.heads();
  }

  /** Room IDs the host serves; the read side lists the same. */
  served(): readonly string[] {
    return this.rooms();
  }

  /** Re-export for callers that only need the seat's unread count (UI badges, the rehearsal script). */
  unread(roomId: string, seatId: string): number {
    return unread(this.project(roomId), seatId).length;
  }
}
