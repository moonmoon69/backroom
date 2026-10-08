/**
 * The lean engine host (stage 4/5 plan, item L1). It runs the accepted engine core against T3: for each seat it
 * reserves a run when the seat has unread addressed input and its thread is free, renders the frozen envelope, sends
 * it with the run's stable command and message IDs, follows the T3 run, and imports its final with the "Lean
 * semantics" selection (§1). It registers and settles background work (§2), imports turns and messages that did not
 * come from the board as non-waking notes (§3), and neutralises the core's cancel interrupt (§6).
 *
 * The journal in the engine store is the only record and the only thing that wakes anyone. The host keeps no work
 * state of its own: everything it needs after a restart is read back from the journal and from T3, by ID. What it
 * holds in memory (send attempts, idle clocks) only bounds retries and timers.
 *
 * The host never computes blocking: it chooses which requests a final names, and the engine decides each outcome.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3Run, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable, runForMessage } from "../adapter/types.ts";
import { backgroundTasks } from "../app/threadView.ts";
import type { ModelSelection } from "../domain/types.ts";
import { inputTree, unread } from "../engine/index.ts";
import type { Activity, ClaimOutcome, Command, CommitReceipt, Disposition, EngineStore, Projection, Run } from "../engine/index.ts";
import { attachImages, brief, seatStanding, type BriefingSource } from "./render.ts";
import { adoptableSteers, steerMessageIds, steerOffers, steerReceiptId, wantsSteer, type SteerOffer } from "./steer.ts";
import { finalMessage, isTerminal, runEnd, runError, runOrigin, threadFree } from "./t3.ts";
import {
  DEFERRED_CANCEL, RELEASED, activityStartedSeq, committed, deferredCancels, finalTargets, frozenDispatch, isPending,
  lastAnswered, latestAnswer, memberHeld, newestCarrier, openOwned, pendingActivities, releasedFor, runRecords, stoppingCancel, type Dispatch,
} from "./work.ts";

const SYSTEM = "$system";
const MiB = 1024 * 1024;
/** The last line of a steered message: what the member does with what came into its turn. */
const STEER_NOTE = "This came into your running turn: take it into account in the work you are doing now, and cover it in your final reply for this turn.";

/** Committed steps, for the crash method in tests/runtime: a hook that throws here stops the host as a crash would. */
export type HostStep = "reserved" | "sending" | "sent" | "accepted" | "running" | "steered" | "activity" | "output" | "ended" | "imported" | "released" | "settled";

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
  /** §2 (iii): how long a thread stays idle with no background work before a `bg:` activity settles. */
  idleSettleMs?: number;
  /** How long a sent message may stay unrecorded by T3 before its run fails visibly. */
  unrecordedMs?: number;
  /** How many times T3 may refuse a message before its run fails visibly (a passing refusal is retried). */
  refusals?: number;
  now?: () => number;
  onStep?: (step: HostStep, at: { roomId: string; seatId: string; runId?: string }) => void;
  /**
   * Called each tick for every seat with its thread, after the host's own work on it: the app mirrors what stays off the
   * journal (approvals and questions on the native-requests path, plan §6). `detail` reads the thread at most once.
   */
  watch?: (at: { roomId: string; seatId: string; threadId: string }, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>) => void | Promise<void>;
}

/** A member command the host refuses, with the explanation the member sees. */
export class HostRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRefusal";
  }
}

type Loader = (full?: boolean) => Promise<T3ThreadDetail | null>;
interface Ending { outcome: "completed" | "stopped" | "failed"; text: string; error: string; background: string[]; evidence: string }

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function claimsOf(receipt: CommitReceipt): ClaimOutcome[] {
  return receipt.events.flatMap((e) => (e.data.kind === "output" ? e.data.claims : []));
}
function shellKey(shell: T3ThreadShell): string {
  return JSON.stringify([shell.latestRunId, shell.status, shell.latestUserMessageAt, shell.latestRunCompletedAt, shell.pendingBackgroundTasks.length]);
}

export class EngineHost {
  private readonly store: EngineStore;
  private readonly adapter: T3Adapter;
  private readonly rooms: () => readonly string[];
  private readonly source: BriefingSource;
  private readonly budgetChars: number;
  private readonly options: EngineHostOptions;
  private readonly maxBytes: number;
  private readonly idleSettleMs: number;
  private readonly unrecordedMs: number;
  private readonly refusalLimit: number;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private halted = false;
  private appends = 0;
  /** Per run: when its message was first sent, and how often T3 refused it. Bounds only; nothing is decided from them. */
  private readonly firstSent = new Map<string, number>();
  private readonly refused = new Map<string, number>();
  /** Host runs whose cancel's interrupt T3 has taken (or refused); T3 keeps one receipt per command ID, so a restart may send it once more. */
  private readonly interrupted = new Set<string>();
  /** Per `bg:` activity: since when its thread has been idle with nothing in the background (§2 iii). */
  private readonly idleSince = new Map<string, number>();
  /** Per seat: the thread state whose turns and messages are all imported (§3), so an unchanged thread is not reread. */
  private readonly seen = new Map<string, string>();
  /**
   * Per steer offer: when its message was first sent (or may have been: an unknown acknowledgement), the offers this
   * process tried to send at all, their rendering (resent as is), and the offers given up. Bounds only.
   */
  private readonly steerSent = new Map<string, number>();
  private readonly steerAttempted = new Set<string>();
  private readonly steerTexts = new Map<string, { text: string; images: Dispatch["images"] }>();
  private readonly steerGaveUp = new Set<string>();

  constructor(options: EngineHostOptions) {
    this.options = options;
    this.store = options.store;
    this.adapter = options.adapter;
    this.rooms = options.rooms;
    this.source = options.briefing;
    this.budgetChars = options.budgetChars ?? 60_000;
    this.maxBytes = options.maxBytes ?? 4 * MiB;
    this.idleSettleMs = options.idleSettleMs ?? 30_000;
    this.unrecordedMs = options.unrecordedMs ?? 5 * 60_000;
    this.refusalLimit = options.refusals ?? 3;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  start(intervalMs = 1500): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    });
    return this.ticking;
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
    let shells: Map<string, T3ThreadShell>;
    try {
      shells = new Map((await this.adapter.listThreads()).map((s) => [s.id, s]));
    } catch (error) {
      this.log("t3 unavailable", message(error));
      return;
    }
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
   * One room, in three passes over its seats, so what one seat's import writes is dispatched in the same tick: follow
   * live runs and import what happened on each thread; settle idle background work; then reserve and send.
   */
  private async stepRoom(roomId: string, shells: Map<string, T3ThreadShell>): Promise<void> {
    this.sweepActivities(roomId);
    const seats = [...this.project(roomId).seats.values()].filter((s) => s.status !== "retired");
    const states = new Map<string, { shell: T3ThreadShell | null; load: Loader; current: () => T3ThreadShell | null; imported: boolean }>();
    for (const seat of seats) {
      const cache: { detail?: T3ThreadDetail | null } = {};
      const load: Loader = async (full = false) => {
        if (cache.detail === undefined || full) {
          cache.detail = await this.adapter.getThreadDetail(seat.threadId, full ? {} : { bounded: true });
          if (cache.detail?.partial && !full) cache.detail = await this.adapter.getThreadDetail(seat.threadId);
        }
        return cache.detail;
      };
      const shell = shells.get(seat.threadId) ?? null;
      states.set(seat.id, { shell, load, current: () => cache.detail?.shell ?? shell, imported: false });
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
        if (live) this.fail(roomId, live, `T3 thread ${this.project(roomId).seats.get(seatId)!.threadId} of @${seatId} no longer exists`);
        return;
      }
      if (live) await this.advance(roomId, seatId, live, state.load);
      state.imported = await this.importThread(roomId, seatId, state.shell, state.load);
      const seat = this.project(roomId).seats.get(seatId)!;
      await this.options.watch?.({ roomId, seatId, threadId: seat.threadId }, state.current() ?? state.shell, () => state.load());
    });
    await each(async (seatId, state) => {
      const shell = state.current();
      if (shell) await this.settleIdle(roomId, seatId, shell, state.load, state.imported);
    });
    await each(async (seatId, state) => {
      const shell = state.current();
      if (shell) await this.dispatch(roomId, seatId, shell, state.imported, state.load);
    });
  }

  // ---------------- a host run: reserve, send, follow, import ----------------

  /** R3: reserve only when the thread is free and every turn the host did not start has been imported (§2 first). */
  private async dispatch(roomId: string, seatId: string, shell: T3ThreadShell, imported: boolean, load: Loader): Promise<void> {
    const p = this.project(roomId);
    const seat = p.seats.get(seatId)!;
    if (seat.activeRunId || seat.status !== "active" || !imported || unread(p, seatId).length === 0) return;
    if (await this.adopt(roomId, seatId, load)) return;
    if (!threadFree(shell)) return;
    const id = randomUUID();
    const receipt = this.exec(roomId, { type: "reserve", actor: SYSTEM, id: `reserve:${id}`, seatId, runId: id, dispatchCommandId: randomUUID(), dispatchMessageId: randomUUID(), maxBytes: this.maxBytes });
    if (receipt.outcome !== "appended") return;
    this.step("reserved", roomId, seatId, id);
    await this.advance(roomId, seatId, id, load);
  }

  private async advance(roomId: string, seatId: string, runId: string, load: Loader): Promise<void> {
    let run = this.project(roomId).runs.get(runId)!;
    const threadId = this.project(roomId).seats.get(seatId)!.threadId;
    if (run.phase === "prepared") {
      // Sending is recorded before the message leaves, with the exact briefing, the standing record the thread will hold
      // and the background work already listed (§2). The whole thread is read: compactions and rollbacks lose standing.
      const detail = await load(true);
      const p = this.project(roomId);
      const briefed = await brief(this.source, this.budgetChars, { roomId, seatId, runId, envelope: run.envelope, projection: p, had: seatStanding(p, seatId, detail) });
      const frozen: Dispatch = { dispatch: run.dispatchCommandId, bgBefore: detail ? backgroundTasks(detail).map((t) => t.taskId) : [], text: briefed.text, images: briefed.images, held: briefed.held };
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
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:accepted`, runId, phase: "accepted", evidence: `t3run:${t3Run.id} ordinal:${t3Run.ordinal}`, providerRunId: t3Run.id });
      this.step("accepted", roomId, seatId, runId);
      run = this.project(roomId).runs.get(runId)!;
    }
    if (run.phase !== "accepted" && run.phase !== "running" && run.phase !== "uncertain") return;
    const detail = await load();
    if (!detail) return;
    const t3Run = runForMessage(detail, run.dispatchMessageId);
    if (!t3Run) {
      const reason = run.phase === "uncertain" ? this.uncertainReason(roomId, runId) : `T3 no longer has the run of @${seatId} (the thread was rolled back, or T3 lost it)`;
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
    const before = new Set(frozenDispatch(this.project(roomId), runId)?.bgBefore ?? []);
    this.finish(roomId, runId, {
      outcome: end === "completed" ? "completed" : end === "interrupted" && this.interruptedByCancel(roomId, runId) ? "stopped" : "failed",
      text: final.message?.text.trim() ?? "",
      error: runError(full, t3Run),
      background: backgroundTasks(full).map((t) => t.taskId).filter((id) => !before.has(id)),
      evidence: `t3run:${t3Run.id} ${t3Run.status}`,
    });
  }

  /**
   * Send, or resend identically: the run's frozen IDs, never new ones (T3 keeps a receipt per command ID). Returns
   * whether T3 took the message. An outage or a lost acknowledgement keeps the run sending; T3 refusing it is retried
   * a few times, then the run fails visibly with its notice, so a passing error never starves the seat silently.
   */
  private async send(roomId: string, seatId: string, run: Run, threadId: string): Promise<boolean> {
    const first = this.firstSent.get(run.id);
    if (first !== undefined && this.now() - first > this.unrecordedMs) {
      this.fail(roomId, run.id, `T3 took the message for @${seatId} but never recorded it`);
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
        this.log("t3 unavailable; the message is sent again with the same IDs", message(error));
        return false;
      }
      if (error instanceof T3CommandRejected) {
        const count = (this.refused.get(run.id) ?? 0) + 1;
        this.refused.set(run.id, count);
        this.log("t3 refused the message", { runId: run.id, count, error: error.message });
        if (count >= this.refusalLimit) this.fail(roomId, run.id, `T3 refused the message for @${seatId}: ${error.message}`);
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

  /** A run that has no T3 run to follow (refused, never recorded, thread gone) ends as a failure with its notice. */
  private fail(roomId: string, runId: string, reason: string): void {
    const run = this.project(roomId).runs.get(runId)!;
    if (run.phase === "prepared" || run.phase === "sending") {
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:uncertain`, runId, phase: "uncertain", evidence: reason });
    }
    this.finish(roomId, runId, { outcome: "failed", text: "", error: reason, background: [], evidence: reason });
  }

  /**
   * Import a run's end. Synchronous from choosing what the final answers to recording it, so no member command or
   * cancel can land in between: deferred cancels apply first, then §1 selects, then the output and the run's end.
   */
  private finish(roomId: string, runId: string, end: Ending): void {
    const seatId = this.project(roomId).runs.get(runId)!.seatId;
    this.applyDeferredCancels(roomId, seatId, true);
    let p = this.project(roomId);
    const run = p.runs.get(runId)!;
    const sourceKey = `final:${runId}`;
    if (!p.sourceKeys.has(sourceKey)) {
      const targets = finalTargets(p, run);
      let disposition: Disposition;
      let body: string;
      if (end.outcome === "failed" || end.outcome === "stopped" && targets.length > 0) {
        disposition = { kind: "error", requestIds: targets };
        body = end.text ? `${end.error}\n\n${end.text}` : end.error;
      } else if (end.text) {
        disposition = targets.length > 0 && end.outcome === "completed" ? { kind: "answer", requestIds: targets } : { kind: "yield" };
        body = end.text;
        if (disposition.kind === "answer" && end.background.length > 0 && !p.activities.has(`bg:${runId}`)) {
          // §2: T3 still lists background work at turn end, so the requests stay open until it ends.
          this.exec(roomId, { type: "activity_start", actor: SYSTEM, id: `activity:bg:${runId}`, activityId: `bg:${runId}`, runId, requestIds: targets, status: "pending" });
          this.step("activity", roomId, seatId, runId);
        }
      } else if (targets.length > 0) {
        // A turn that ended without a reply is never an empty answer: its requesters get one error notice and can retry.
        disposition = { kind: "error", requestIds: targets };
        body = `@${seatId}'s turn ended without a reply.`;
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
    this.interrupted.delete(runId);
    this.sweepActivities(roomId);
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
    this.sweepActivities(roomId);
  }

  /** §2: an activity whose requests are all cancelled fails (transfer refuses pending activities); all closed, it is done. */
  private sweepActivities(roomId: string): void {
    const p = this.project(roomId);
    for (const a of p.activities.values()) {
      if (a.status !== "pending" && a.status !== "uncertain") continue;
      const states = a.requestIds.map((id) => p.requests.get(id)?.state);
      if (states.some((s) => s === "open")) continue;
      const cancelled = states.every((s) => s === "cancelled");
      this.exec(roomId, { type: "activity_status", actor: SYSTEM, id: `activity-closed:${a.id}`, activityId: a.id, status: cancelled ? "failed" : "done", evidence: cancelled ? "lean: every request of the activity was cancelled" : "lean: every request of the activity is closed" });
    }
  }

  // ---------------- §2 and §3: turns the host did not start ----------------

  /**
   * Import what happened on the thread outside host runs, each once by its T3 ID: messages typed in T3 or sent by other
   * agents (notes), turns typed in T3 or started by another agent (their replies are notes by the seat), and the
   * member's own continuations (§2: settle, progress, or a note). Only T3 runs after the seat's first host run count;
   * earlier ones are the thread's history. Returns whether everything is imported, which R3 waits for.
   */
  private async importThread(roomId: string, seatId: string, shell: T3ThreadShell, load: Loader): Promise<boolean> {
    let p = this.project(roomId);
    const seat = p.seats.get(seatId)!;
    const key = shellKey(shell);
    if (this.seen.get(seatId) === key && !seat.activeRunId) return true;
    const detail = await load();
    if (!detail) return false;
    const hostRuns = [...p.runs.values()].filter((r) => r.seatId === seatId);
    // Steered messages are the board's too: what they carried is on it already.
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
      // A T3 notice starts the member's own continuation; that run is imported below.
      if (m.createdBy !== "user" && m.senderThreadId === null) continue;
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
    const runs = detail.runs.filter((r) => r.ordinal > baseline && !matched.has(r.userMessageId) && isTerminal(r)).sort((a, b) => a.ordinal - b.ordinal);
    for (const t3Run of runs) {
      p = this.project(roomId);
      const id = `t3run:${seat.threadId}:${t3Run.id}`;
      if (imported.has(id)) continue;
      const final = finalMessage(detail, t3Run.id);
      if (final.streaming) {
        done = false;
        break;
      }
      const end = runEnd(t3Run);
      const text = final.message?.text.trim() ?? "";
      const shown = end === "completed" ? text : `${text ? `${text}\n\n` : ""}(${end === "interrupted" ? "stopped" : "failed"} in T3: ${runError(detail, t3Run)})`;
      try {
        const origin = runOrigin(detail, t3Run, hostMessages);
        if (origin === "self") this.continuation(roomId, seatId, id, shown, end === "completed" && text.length > 0, detail, t3Run.ordinal);
        else if (origin === "host") {
          const failed = hostRuns.find((r) => r.dispatchMessageId === t3Run.userMessageId);
          if (failed) this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: `(T3 ran a message after Backroom had recorded it as failed) ${shown}`, requestIds: finalTargets(p, failed) });
          // A steer T3 ran as a turn of its own: the reserve pass adopts it, or, once that window has closed, its reply is a note.
          else if (adoptable.has(t3Run.userMessageId)) continue;
          else this.steerNote(roomId, seatId, id, t3Run.userMessageId, shown);
        }
        else if (shown) this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: shown });
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
   * §2 (i): the member's own continuation ended. With no pending activity it is a self-started turn: a non-waking note.
   * Otherwise its final settles the seat's `bg:` activities that are not member-held, but only when it has a reply and
   * T3 lists no background work any more; each requester is woken once. In every other case the final is non-waking
   * progress under the latest pending activity ("after"), and nothing settles.
   */
  private continuation(roomId: string, seatId: string, id: string, text: string, replied: boolean, detail: T3ThreadDetail, ordinal: number): void {
    const p = this.project(roomId);
    const pending = pendingActivities(p, seatId);
    // Activities this import released before a crash (H1): their outputs are written whatever T3 lists now.
    const resumed = releasedFor(p, seatId, (key) => key === id || key.startsWith(`${id}:`)).map((r) => r.activity);
    const ready = replied && backgroundTasks(detail).length === 0 ? pending.filter((a) => a.id.startsWith("bg:") && !memberHeld(p, a)) : [];
    const settle = [...new Map([...ready, ...resumed].map((a) => [a.id, a])).values()].sort((a, b) => a.id.localeCompare(b.id));
    if (settle.length > 0) {
      // The run's own key goes on the last output, so the import counts as done only once every activity is settled;
      // after a crash between them, the ones still pending or released are settled on the next look.
      settle.forEach((a, index) => {
        // Judged by what T3 ran before this continuation: a host run it queued behind it was not seen in it.
        this.settleActivity(roomId, seatId, a, index === settle.length - 1 ? id : `${id}:${a.id}`, text, ordinal);
        this.step("settled", roomId, seatId, a.runId);
      });
      return;
    }
    if (pending.length === 0) {
      // A self-started turn: a note under the seat's latest answer, so its requester's next briefing has it (§5).
      if (text) this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: text, requestIds: lastAnswered(p, seatId) });
      return;
    }
    if (!text) return;
    const latest = [...pending].sort((a, b) => activityStartedSeq(p, b.id) - activityStartedSeq(p, a.id))[0]!;
    this.exec(roomId, { type: "output", actor: SYSTEM, id, author: seatId, sourceKey: id, association: { kind: "activity", id: latest.id }, body: text, disposition: { kind: "progress", requestIds: openOwned(p, latest.requestIds, seatId) } });
  }

  /** §2 (iii): a `bg:` activity nobody holds settles once the thread has been idle with nothing in the background. */
  private async settleIdle(roomId: string, seatId: string, shell: T3ThreadShell, load: Loader, imported: boolean): Promise<void> {
    const before = this.project(roomId);
    // Activities an idle settle released before a crash (H1): their outputs are written now.
    for (const { activity, sourceKey } of releasedFor(before, seatId, (key) => key.startsWith("idle:"))) {
      this.settleActivity(roomId, seatId, activity, sourceKey, this.idleBody(this.project(roomId), seatId, activity));
      this.step("settled", roomId, seatId, activity.runId);
    }
    const candidates = pendingActivities(before, seatId).filter((a) => a.id.startsWith("bg:") && !memberHeld(before, a));
    if (candidates.length === 0) return;
    const detail = imported && !before.seats.get(seatId)!.activeRunId && threadFree(shell) ? await load() : null;
    const quiet = detail !== null && backgroundTasks(detail).length === 0;
    for (const candidate of candidates) {
      // Read the journal again after the await: a cancel, an answer or a `working` mark may have landed meanwhile.
      const p = this.project(roomId);
      const a = p.activities.get(candidate.id)!;
      if (!quiet || !isPending(a) || memberHeld(p, a) || p.seats.get(seatId)!.activeRunId) {
        this.idleSince.delete(a.id);
        continue;
      }
      const since = this.idleSince.get(a.id) ?? this.now();
      this.idleSince.set(a.id, since);
      if (this.now() - since < this.idleSettleMs) continue;
      this.settleActivity(roomId, seatId, a, `idle:${a.id}`, this.idleBody(p, seatId, a));
      this.idleSince.delete(a.id);
      this.step("settled", roomId, seatId, a.runId);
    }
  }

  /**
   * An idle settle's text: the seat's newest answer attempt on the requests, not only the final of the run that started
   * the work: a later run may have answered after a review (K1) while the work was still listed.
   */
  private idleBody(p: Projection, seatId: string, a: Activity): string {
    return `(background work ended without a further turn)\n\n${latestAnswer(p, seatId, a.requestIds)}`;
  }

  /**
   * Settle an activity (§2 i and iii) and answer the requests it holds that are still open, judged by what the member has
   * seen (H1). The engine judges an output by its association's watermark; tied to the activity, that is the watermark of
   * the run that registered it. When a later run carried the requests (it delivered a correction, a review's answer),
   * that one would count as unseen and the answer would come out superseded, with nothing left to deliver it again. So
   * then the activity is released by its own status first (the engine counts a pending activity as open work), and the
   * output is tied to that later run. The release names the output's key: after a crash between the two, the caller
   * finds it with `releasedFor` and writes the output. When no carrier's watermark is later than the activity's, the
   * activity's own output settles it, as before. Watermarks are compared, not runs: a confirmed steer raises a run's
   * watermark after its activity was registered.
   */
  private settleActivity(roomId: string, seatId: string, a: Activity, sourceKey: string, body: string, beforeOrdinal?: number): void {
    const p = this.project(roomId);
    const open = openOwned(p, a.requestIds, seatId);
    const disposition: Disposition = open.length ? { kind: "answer", requestIds: open } : { kind: "yield" };
    const carrier = open.length ? newestCarrier(p, seatId, open, beforeOrdinal === undefined ? {} : { beforeOrdinal }) : null;
    if (isPending(a) && (!carrier || carrier.through <= a.through)) {
      this.exec(roomId, { type: "output", actor: SYSTEM, id: sourceKey, author: seatId, sourceKey, association: { kind: "activity", id: a.id }, activityCompletion: "done", body, disposition });
      return;
    }
    if (isPending(a)) this.release(roomId, seatId, a, sourceKey);
    this.exec(roomId, { type: "output", actor: SYSTEM, id: sourceKey, author: seatId, sourceKey, association: { kind: "run", id: (carrier ?? p.runs.get(a.runId)!).id }, body, disposition });
  }

  /** H1: an activity ends on its own, before an output tied to a later run answers what it held (see settleActivity). */
  private release(roomId: string, seatId: string, a: Activity, sourceKey: string): void {
    this.exec(roomId, { type: "activity_status", actor: SYSTEM, id: `release:${a.id}`, activityId: a.id, status: "done", evidence: `${RELEASED}${sourceKey}` });
    this.step("released", roomId, seatId, a.runId);
  }

  // ---------------- /steer (L4a; src/runtime/steer.ts) ----------------

  /**
   * Steered requests go into the seat's live run while T3 runs it: one offer at a time, a sync receipt over every unread
   * input since the run's watermark, sent with `steer_active` into the T3 run and confirmed once T3 shows the message
   * attached to it; the run's final then answers them too (§1). Never while the run waits on an approval or a question.
   */
  private async steerInto(roomId: string, seatId: string, runId: string, t3Run: T3Run, load: Loader): Promise<void> {
    const detail = await load();
    if (!detail) return;
    this.confirmSteers(roomId, runId, t3Run.id, detail);
    const p = this.project(roomId);
    const threadId = p.seats.get(seatId)!.threadId;
    const inFlight = steerOffers(p, seatId).find((s) => s.runId === runId && !s.receipt.confirmed && !this.steerGaveUp.has(s.receipt.id));
    if (inFlight) {
      // T3 has not recorded it yet: sent again with the same IDs. Or T3 ran it as a turn of its own: adopted once this run ends.
      if (detail.messages.some((m) => m.id === inFlight.messageId) || t3Run.status !== "running") return;
      if (!(await this.sendSteer(roomId, inFlight, t3Run.id, threadId, load))) return;
      const after = await load(true);
      if (after) this.confirmSteers(roomId, runId, t3Run.id, after);
      return;
    }
    const run = p.runs.get(runId)!;
    if (t3Run.status !== "running" || detail.shell.pendingRequest !== null || p.seats.get(seatId)!.status !== "active") return;
    const offered = new Set(run.receipts.flatMap((r) => inputTree(r.envelope.inputs).map((i) => i.eventId)));
    if (!unread(p, seatId, run.through).some((i) => i.intent === "request" && i.requestIds.some(wantsSteer) && !offered.has(i.eventId))) return;
    const receiptId = steerReceiptId(randomUUID(), randomUUID());
    if (this.exec(roomId, { type: "sync", actor: SYSTEM, id: `sync:${receiptId}`, runId, receiptId, maxBytes: this.maxBytes }).outcome !== "appended") return;
    this.step("steered", roomId, seatId, runId);
    const offer = steerOffers(this.project(roomId), seatId).find((s) => s.receipt.id === receiptId)!;
    if (!(await this.sendSteer(roomId, offer, t3Run.id, threadId, load))) return;
    const after = await load(true);
    if (after) this.confirmSteers(roomId, runId, t3Run.id, after);
  }

  /** Send a steer offer's message, or resend it identically. Returns whether T3 took it. */
  private async sendSteer(roomId: string, offer: SteerOffer, t3RunId: string, threadId: string, load: Loader): Promise<boolean> {
    const first = this.steerSent.get(offer.receipt.id);
    if (first !== undefined && this.now() - first > this.unrecordedMs) {
      this.steerGaveUp.add(offer.receipt.id);
      this.log("T3 never recorded a steered message; what it carried waits for the next turn", { receiptId: offer.receipt.id });
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
      if (error instanceof T3Unavailable) return false;
      if (error instanceof T3CommandRejected) {
        this.steerGaveUp.add(offer.receipt.id);
        this.log("T3 refused a steered message; what it carried waits for the next turn", { receiptId: offer.receipt.id, error: error.message });
        return false;
      }
      this.steerSent.set(offer.receipt.id, first ?? this.now());
      this.log("steer acknowledgement unknown; reconciling by message ID", message(error));
      return false;
    }
    this.steerSent.set(offer.receipt.id, first ?? this.now());
    return true;
  }

  /** T3 shows a steered message in the run it was steered into: the offer is confirmed with that evidence. */
  private confirmSteers(roomId: string, runId: string, t3RunId: string, detail: T3ThreadDetail): void {
    const p = this.project(roomId);
    const run = p.runs.get(runId)!;
    if (run.phase === "terminal") return;
    for (const offer of steerOffers(p, run.seatId)) {
      if (offer.runId !== runId || offer.receipt.confirmed) continue;
      const m = detail.messages.find((x) => x.id === offer.messageId);
      if (!m || m.runId !== t3RunId) continue;
      const item = detail.turnItems.find((x) => x.type === "user_message" && x.messageId === m.id);
      const intent = item?.type === "user_message" ? item.inputIntent : "attached";
      this.exec(roomId, { type: "confirm_sync", actor: SYSTEM, id: `confirm:${offer.receipt.id}`, runId, receiptId: offer.receipt.id, digest: offer.receipt.digest, evidence: `t3msg:${m.id} t3run:${t3RunId} ${intent}` });
      this.steerSent.delete(offer.receipt.id);
      this.steerTexts.delete(offer.receipt.id);
    }
  }

  /**
   * A steer that reached T3 after the run it was meant for had ended: T3 ran it as a turn of its own. That run is
   * adopted as the host run for what the steer carried, reserved with the steer's own command and message IDs, so the
   * host follows it like a run it sent. When more input has arrived since the offer, that turn cannot answer it: its
   * reply becomes a note under what the steer carried, and everything goes in an ordinary run after it. A steer T3 has
   * not recorded yet, though it was or may have been sent, is sent again with its own IDs (T3 keeps one receipt per
   * command ID, and runs it as a turn of its own now that its run has ended), and the seat waits for it up to
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
        const shown = end === "completed" ? text : `${text ? `${text}\n\n` : ""}(${end === "interrupted" ? "stopped" : "failed"} in T3: ${runError(detail, t3Run)})`;
        this.steerNote(roomId, seatId, `t3run:${p.seats.get(seatId)!.threadId}:${t3Run.id}`, steer.messageId, shown);
        return false;
      }
      const id = randomUUID();
      const receipt = this.exec(roomId, { type: "reserve", actor: SYSTEM, id: `reserve:${id}`, seatId, runId: id, dispatchCommandId: steer.commandId, dispatchMessageId: steer.messageId, maxBytes: this.maxBytes });
      if (receipt.outcome !== "appended") return true;
      this.step("reserved", roomId, seatId, id);
      // What T3 was sent is the steered message itself, already in its run: that is what this run froze. The turn is
      // under way, so no background list from before it exists: whatever T3 lists when it ends holds its requests (§2).
      const frozen: Dispatch = { dispatch: steer.commandId, bgBefore: [], text: m.text, images: [], held: seatStanding(this.project(roomId), seatId, detail) };
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${id}:sending`, runId: id, phase: "sending", evidence: JSON.stringify(frozen) });
      this.step("sending", roomId, seatId, id);
      await this.advance(roomId, seatId, id, load);
      return true;
    }
    return false;
  }

  /** The reply of a turn T3 ran for a steer that could not be adopted: a note under the requests the steer carried. */
  private steerNote(roomId: string, seatId: string, id: string, messageId: string, shown: string): void {
    const p = this.project(roomId);
    if (committed(p, seatId, id) || p.events.some((e) => e.id === id) || !shown) return;
    const offer = steerOffers(p, seatId).find((s) => s.messageId === messageId);
    const carried = offer ? openOwned(p, inputTree(offer.receipt.envelope.inputs).flatMap((i) => i.requestIds), seatId) : [];
    this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: `(T3 ran a steered message as a turn of its own) ${shown}`, ...(carried.length ? { requestIds: unique(carried) } : {}) });
  }

  // ---------------- the API members and the user act through (L3, L4a, L4b call these) ----------------

  /** The seat's run that T3 is working on now, and the requests its final would answer. */
  currentWork(roomId: string, seatId: string): { runId: string; requestIds: string[] } | null {
    const p = this.project(roomId);
    const run = this.liveRun(p, seatId);
    return run ? { runId: run.id, requestIds: this.turnRequests(p, run) } : null;
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

  /** A request, as given: the user's message path and a member's post with its parent already chosen. */
  request(roomId: string, input: { actor: string; id: string; to: string; body: string; parentId?: string }): CommitReceipt {
    return this.member(roomId, { type: "request", actor: input.actor, id: input.id, to: input.to, body: input.body, ...(input.parentId ? { parentId: input.parentId } : {}) });
  }

  /**
   * `rooms-board post "@x …"`: a request. Made during a turn it is a child of the request that turn works on, which
   * keeps that request open while the review it asks for is open; with several, the member names one (`--for #n`).
   */
  post(roomId: string, input: { actor: string; id: string; to: string; body: string; forRequest?: string }): CommitReceipt {
    const p = this.project(roomId);
    let parentId = input.forRequest;
    if (!parentId && input.actor !== "$user" && !committed(p, input.actor, input.id)) {
      const run = this.liveRun(p, input.actor);
      const work = run ? this.turnRequests(p, run) : unique(pendingActivities(p, input.actor).flatMap((a) => openOwned(p, a.requestIds, input.actor)));
      if (work.length === 1) parentId = work[0];
      else if (work.length > 1 && run) throw new HostRefusal(`This turn works on ${work.map((id) => `#${id}`).join(", ")}: say which one this post is for, rooms-board post --for #n "@${input.to} …".`);
    }
    return this.request(roomId, { actor: input.actor, id: input.id, to: input.to, body: input.body, ...(parentId ? { parentId } : {}) });
  }

  /**
   * `rooms-board note`. A note about a request names it (`requestIds`), or it reaches nobody's briefing (L2); the user's
   * room note (`/note`) is marked with the `room` milestone instead, and reaches every seat's next briefing.
   */
  note(roomId: string, input: { actor: string; id: string; body: string; requestIds?: string[]; milestone?: string }): CommitReceipt {
    return this.member(roomId, { type: "post", actor: input.actor, id: input.id, intent: "note", body: input.body, ...(input.requestIds ? { requestIds: input.requestIds } : {}), ...(input.milestone ? { milestone: input.milestone } : {}) });
  }

  /** `rooms-board follow #n [--off]` (§4): the follower is woken by each `working` post on the request. */
  follow(roomId: string, input: { actor: string; id: string; requestId: string; enabled: boolean }): CommitReceipt {
    return this.member(roomId, { type: "subscribe", actor: input.actor, id: input.id, requestId: input.requestId, milestones: ["working"], enabled: input.enabled });
  }

  correct(roomId: string, input: { actor: string; id: string; requestId: string; body: string }): CommitReceipt {
    return this.member(roomId, { type: "correct", actor: input.actor, id: input.id, requestId: input.requestId, body: input.body });
  }

  retry(roomId: string, input: { actor: string; id: string; runId: string; body: string }): CommitReceipt {
    return this.member(roomId, { type: "retry", actor: input.actor, id: input.id, runId: input.runId, body: input.body });
  }

  /**
   * `rooms-board working [#n …] "…"` (§2). In a host run, for requests that run works on: a `work:` activity holds them
   * until the member answers. In a continuation, for requests a pending activity covers: the mark makes it member-held.
   * Anywhere else it is refused. The activity is registered before the mark, so a crash between them still holds.
   */
  working(roomId: string, input: { actor: string; id: string; body: string; requestIds?: string[] }): { requestIds: string[]; message: string } {
    const p = this.project(roomId);
    const seatId = input.actor;
    const run = this.liveRun(p, seatId);
    const pending = pendingActivities(p, seatId);
    const covered = new Set(pending.flatMap((a) => openOwned(p, a.requestIds, seatId)));
    const turn = run ? this.turnRequests(p, run) : [];
    const ids = input.requestIds ? unique(input.requestIds) : run ? turn : this.onlyCandidate(p, [...covered], "working");
    if (!committed(p, seatId, input.id)) {
      if (ids.length === 0) throw new HostRefusal("No open request of yours is in this turn or held by your background work. To send a later result, use rooms-board post @<requester>.");
      for (const id of ids) {
        const q = p.requests.get(id);
        if (!q || q.owner !== seatId || q.state !== "open" || (!turn.includes(id) && !covered.has(id))) {
          throw new HostRefusal(`#${id} is not an open request of yours in this turn${q ? `; to send a later result, use rooms-board post @${q.returnTo}` : ""}.`);
        }
      }
      const fresh = run ? ids.filter((id) => turn.includes(id) && !pending.some((a) => a.runId === run.id && a.id.startsWith("work:") && a.requestIds.includes(id))) : [];
      if (run && fresh.length > 0) {
        const taken = [...p.activities.keys()].filter((k) => k === `work:${run.id}` || k.startsWith(`work:${run.id}:`)).length;
        this.member(roomId, { type: "activity_start", actor: seatId, id: `${input.id}:work`, activityId: taken ? `work:${run.id}:${taken + 1}` : `work:${run.id}`, runId: run.id, requestIds: fresh, status: "pending" });
      }
    }
    this.member(roomId, { type: "post", actor: seatId, id: input.id, intent: "progress", body: input.body, requestIds: ids, milestone: "working" });
    const names = ids.map((id) => `#${id}`).join(" ");
    return { requestIds: ids, message: `${names} stays open until you run rooms-board answer ${names} "…"; your final replies will not close it.` };
  }

  /**
   * `rooms-board answer [#n …] "…"` (§2 ii). It settles the activity covering the requests and answers them; with no
   * activity it is associated with the run carrying them (the live one, or the latest that did). The engine decides
   * each outcome, and the caller must read it: an answer can come out pending_activity, superseded or late.
   *
   * H1: the answer is judged by the newest run that carried the requests and that T3 started, since that is what the
   * member has seen (with none, the newest T3 has taken). When that run's watermark is later than a covering activity's
   * (a later run delivered the review's answer or a correction, or a steer brought it into this one), the activities are
   * released first and one output tied to that run answers them all; an output tied to an activity would be judged by
   * its older watermark and come out superseded by what the member just read. A blocked answer still releases the
   * hold, as it always did: the member's next reply answers the request (L3 says so).
   */
  answer(roomId: string, input: { actor: string; id: string; body: string; requestIds?: string[] }): { claims: ClaimOutcome[] } {
    const p = this.project(roomId);
    const seatId = input.actor;
    if (committed(p, seatId, input.id)) {
      // A replay of an answer already made: report the outcomes it had.
      const mine = (key: string) => {
        const [actor, id] = JSON.parse(key) as [string, string];
        return actor === seatId && (id === input.id || id.startsWith(`${input.id}:`));
      };
      return { claims: p.events.filter((e) => mine(e.commandKey)).flatMap((e) => (e.data.kind === "output" ? e.data.claims : [])) };
    }
    const sourceKey = (key: string) => `answer:${seatId}:${key}`;
    const run = this.liveRun(p, seatId);
    // Activities this answer released before a crash, its output not written yet: they still cover what it names.
    const released = releasedFor(p, seatId, (key) => key === sourceKey(input.id)).map((r) => r.activity);
    const pending = [...pendingActivities(p, seatId), ...released];
    const ids = input.requestIds ? unique(input.requestIds) : run ? this.turnRequests(p, run) : this.onlyCandidate(p, unique(pending.flatMap((a) => openOwned(p, a.requestIds, seatId))), "answer");
    if (ids.length === 0) throw new HostRefusal('Nothing to answer here: name the request, rooms-board answer #n "…".');
    for (const id of ids) {
      const q = p.requests.get(id);
      if (!q || q.owner !== seatId) throw new HostRefusal(`#${id} is not a request of yours.`);
      if (q.state !== "open") throw new HostRefusal(`#${id} is already ${q.state}.`);
    }
    const activities = pending.filter((a) => a.requestIds.some((id) => ids.includes(id)));
    for (const a of activities) {
      const others = openOwned(p, a.requestIds, seatId).filter((id) => !ids.includes(id));
      if (others.length) throw new HostRefusal(`${ids.map((id) => `#${id}`).join(" ")} share background work with ${others.map((id) => `#${id}`).join(" ")}: answer them together, rooms-board answer ${[...ids, ...others].map((id) => `#${id}`).join(" ")} "…".`);
    }
    const carrierOf = (of: readonly string[]) => newestCarrier(p, seatId, of) ?? newestCarrier(p, seatId, of, { accepted: true });
    const carrier = carrierOf(ids);
    if (!carrier) {
      const lost = ids.filter((id) => !carrierOf([id]));
      throw new HostRefusal(`${(lost.length ? lost : ids).map((id) => `#${id}`).join(" ")} did not reach you in one turn: answer each separately.`);
    }
    if (activities.some((a) => a.through < carrier.through || !isPending(a))) {
      for (const a of activities) if (isPending(a)) this.release(roomId, seatId, a, sourceKey(input.id));
      return { claims: claimsOf(this.member(roomId, { type: "output", actor: seatId, id: input.id, author: seatId, sourceKey: sourceKey(input.id), association: { kind: "run", id: carrier.id }, body: input.body, disposition: { kind: "answer", requestIds: ids } })) };
    }
    // No carrier's watermark is later than a covering activity's: each one's own output settles it, as before H1.
    const rest = ids.filter((id) => !activities.some((a) => a.requestIds.includes(id)));
    const claims: ClaimOutcome[] = [];
    let index = 0;
    const next = () => (index++ === 0 ? input.id : `${input.id}:${index}`);
    for (const a of activities) {
      const key = next();
      claims.push(...claimsOf(this.member(roomId, { type: "output", actor: seatId, id: key, author: seatId, sourceKey: sourceKey(key), association: { kind: "activity", id: a.id }, activityCompletion: "done", body: input.body, disposition: { kind: "answer", requestIds: openOwned(p, a.requestIds, seatId) } })));
    }
    if (rest.length) {
      const key = next();
      claims.push(...claimsOf(this.member(roomId, { type: "output", actor: seatId, id: key, author: seatId, sourceKey: sourceKey(key), association: { kind: "run", id: carrier.id }, body: input.body, disposition: { kind: "answer", requestIds: rest } })));
    }
    return { claims };
  }

  /**
   * Withdraw a request (§6). Its owner not in a turn: the cancel applies now. In a turn whose only request is this one:
   * it applies now and the turn is interrupted. In a turn that also works on other requests: it is recorded as a
   * visible note and applies when that turn ends, so the seat is never left stopping (its posts refused) while it
   * works on the rest.
   */
  async cancel(roomId: string, input: { actor: string; id: string; requestId: string }): Promise<{ applied: boolean; deferred: boolean }> {
    const p = this.project(roomId);
    const q = p.requests.get(input.requestId);
    if (!q) throw new HostRefusal(`#${input.requestId} is not a request in this room.`);
    if (input.actor !== "$user" && input.actor !== q.returnTo && input.actor !== p.orchestrator) throw new HostRefusal(`Only whoever asked #${q.id} can cancel it.`);
    const noteId = `${DEFERRED_CANCEL}${JSON.stringify([q.id, input.id])}`;
    if (committed(p, input.actor, noteId) && !committed(p, input.actor, input.id)) return { applied: false, deferred: true };
    const owner = p.seats.get(q.owner);
    const run = owner?.activeRunId ? p.runs.get(owner.activeRunId)! : null;
    if (run && run.phase !== "rejected" && q.state === "open" && !committed(p, input.actor, input.id)) {
      const turn = this.turnRequests(p, run);
      if (!(turn.length === 1 && turn[0] === q.id)) {
        this.member(roomId, { type: "post", actor: input.actor, id: noteId, intent: "note", body: `Cancel of #${q.id} requested; it applies when @${q.owner}'s current turn ends.` });
        return { applied: false, deferred: true };
      }
    }
    const receipt = this.member(roomId, { type: "cancel", actor: input.actor, id: input.id, requestId: q.id });
    const applied = receipt.events.some((e) => e.data.kind === "cancel" && e.data.applied);
    this.sweepActivities(roomId);
    if (run && owner) {
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
    return { applied, deferred: false };
  }

  /**
   * The room's Stop for a seat (L4a): T3 interrupts the run active on its thread. A host run then ends as a failure with
   * its notice (§6), which the user can retry; a turn the host did not start becomes a note when it ends (§3).
   */
  async stopSeat(roomId: string, seatId: string): Promise<void> {
    const seat = this.project(roomId).seats.get(seatId);
    if (!seat || seat.status === "retired") throw new HostRefusal(`@${seatId} is not seated in this room.`);
    const shell = await this.adapter.getThreadShell(seat.threadId);
    if (!shell?.activeRunId) throw new HostRefusal(`@${seatId} is not running anything in T3 now.`);
    await this.adapter.interruptRun({ commandId: randomUUID(), threadId: seat.threadId, runId: shell.activeRunId });
    this.hint();
  }

  // ---------------- helpers ----------------

  /**
   * Outside a host run the member's turn can be about any of its jobs, and the host cannot tell which: with no #n, a
   * command acts only when one request is a candidate, and otherwise names them so the member says which (as post --for).
   */
  private onlyCandidate(p: Projection, candidates: string[], command: "answer" | "working"): string[] {
    if (candidates.length <= 1) return candidates;
    const named = candidates.map((id) => {
      const q = p.requests.get(id)!;
      const head = q.body.replace(/\s+/g, " ").trim();
      return `#${id} (from ${q.returnTo === "$user" ? "the user" : `@${q.returnTo}`}: "${head.length > 60 ? `${head.slice(0, 60)}…` : head}")`;
    });
    throw new HostRefusal(`Several of your requests are still open with work going on: ${named.join(", ")}. Say which this is about: rooms-board ${command} #n "…".`);
  }

  /** The requests a live run works on now: §1's targets plus those it marked working (posts during the turn go under them). */
  private turnRequests(p: Projection, run: Run): string[] {
    const held = [...p.activities.values()].filter((a) => a.runId === run.id && a.id.startsWith("work:")).flatMap((a) => openOwned(p, a.requestIds, run.seatId));
    return unique([...finalTargets(p, run), ...held]);
  }

  private liveRun(p: Projection, seatId: string): Run | null {
    const id = p.seats.get(seatId)?.activeRunId;
    const run = id ? p.runs.get(id) : undefined;
    return run && (run.phase === "accepted" || run.phase === "running" || run.phase === "uncertain") ? run : null;
  }

  private project(roomId: string): Projection {
    return this.store.project(roomId);
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

  /** Projection reads for callers (the read API, tests). */
  view(roomId: string): Projection {
    return this.project(roomId);
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
