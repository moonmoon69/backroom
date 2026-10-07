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
import { unread } from "../engine/index.ts";
import type { ClaimOutcome, Command, CommitReceipt, Disposition, EngineStore, Projection, Run } from "../engine/index.ts";
import { attachImages, brief, seatStanding, type BriefingSource } from "./render.ts";
import { finalMessage, isTerminal, runEnd, runError, runOrigin, threadFree } from "./t3.ts";
import {
  DEFERRED_CANCEL, activityStartedSeq, allowedIds, committed, deferredCancels, finalTargets, frozenDispatch,
  lastAnswered, lastFinal, memberHeld, openOwned, pendingActivities, reservedSeq, runRecords, type Dispatch,
} from "./work.ts";

const SYSTEM = "$system";
const MiB = 1024 * 1024;

/** Committed steps, for the crash method in tests/runtime: a hook that throws here stops the host as a crash would. */
export type HostStep = "reserved" | "sending" | "sent" | "accepted" | "running" | "activity" | "output" | "ended" | "imported" | "settled";

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
  /** Per `bg:` activity: since when its thread has been idle with nothing in the background (§2 iii). */
  private readonly idleSince = new Map<string, number>();
  /** Per seat: the thread state whose turns and messages are all imported (§3), so an unchanged thread is not reread. */
  private readonly seen = new Map<string, string>();

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
    if (seat.activeRunId || seat.status !== "active" || !imported || !threadFree(shell) || unread(p, seatId).length === 0) return;
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
      this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:accepted`, runId, phase: "accepted", evidence: `t3run:${t3Run.id} ordinal:${t3Run.ordinal}` });
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
        this.exec(roomId, { type: "phase", actor: SYSTEM, id: `phase:${runId}:running`, runId, phase: "running", evidence: `t3run:${t3Run.id}` });
        this.step("running", roomId, seatId, runId);
      }
      await this.sendInterrupts(roomId, runId, threadId, t3Run);
      return;
    }
    const full = await load(true);
    if (!full) return;
    const final = finalMessage(full, t3Run.id);
    if (final.streaming) return; // T3 is still writing the last message: import it whole on the next tick.
    await this.sendInterrupts(roomId, runId, threadId, t3Run);
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
    this.sweepActivities(roomId);
  }

  // ---------------- §6 cancel ----------------

  /** Interrupts the core prepared for a cancel go out once T3 has the run; the control is then marked obsolete. */
  private async sendInterrupts(roomId: string, runId: string, threadId: string, t3Run: T3Run): Promise<void> {
    const controls = [...this.project(roomId).controls.values()].filter((c) => c.runId === runId && c.kind === "interrupt" && c.phase === "prepared");
    for (const c of controls) {
      if (isTerminal(t3Run)) {
        this.exec(roomId, { type: "control_phase", actor: SYSTEM, id: `obsolete:${c.id}:ended`, controlId: c.id, phase: "obsolete", evidence: "lean: the run had already ended; no interrupt sent" });
        continue;
      }
      try {
        await this.adapter.interruptRun({ commandId: c.commandId, threadId, runId: t3Run.id });
      } catch (error) {
        if (!(error instanceof T3CommandRejected)) {
          this.log("interrupt not sent; trying again", message(error));
          continue;
        }
      }
      this.exec(roomId, { type: "control_phase", actor: SYSTEM, id: `obsolete:${c.id}:sent`, controlId: c.id, phase: "obsolete", evidence: "lean: interrupt sent directly" });
    }
  }

  private interruptedByCancel(roomId: string, runId: string): boolean {
    const p = this.project(roomId);
    const ids = new Set([...p.controls.values()].filter((c) => c.runId === runId && c.kind === "interrupt").map((c) => c.id));
    return p.events.some((e) => e.data.kind === "control.phase" && ids.has(e.data.controlId) && e.data.evidence === "lean: interrupt sent directly");
  }

  /**
   * Cancels recorded while their request's owner was in a turn working on other requests too. They apply when that turn
   * ends (`atTurnEnd`), or at once when the owner has no live run. The core's interrupt control for such a cancel is
   * marked obsolete in the same breath: nothing is interrupted, and the seat is never left stopping.
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
        continue;
      }
      const control = this.project(roomId).controls.get(`${d.cancelId}/interrupt`);
      if (control?.phase === "prepared") {
        this.exec(roomId, { type: "control_phase", actor: SYSTEM, id: `obsolete:${control.id}:deferred`, controlId: control.id, phase: "obsolete", evidence: "lean: cancel applied as the turn ended; no interrupt" });
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
    const hostMessages = new Set(hostRuns.map((r) => r.dispatchMessageId));
    const baseline = this.baseline(p, seatId);
    if (baseline === null) {
      this.seen.set(seatId, key);
      return true;
    }
    const ordinals = new Map(detail.runs.map((r) => [r.id, r.ordinal]));
    let done = true;
    for (const m of detail.messages) {
      if (m.role !== "user" || hostMessages.has(m.id) || m.runId === null || (ordinals.get(m.runId) ?? -1) < baseline) continue;
      // A T3 notice starts the member's own continuation; that run is imported below.
      if (m.createdBy !== "user" && m.senderThreadId === null) continue;
      if (!m.text.trim() && m.attachments.length === 0) continue;
      const id = `t3msg:${seat.threadId}:${m.id}`;
      const pictures = m.attachments.length ? `\n[${m.attachments.length} attachment(s) in T3]` : "";
      let author = "$user";
      let body = `${m.text.trim()}${pictures}`;
      if (m.senderThreadId !== null) {
        const sender = [...p.seats.values()].find((s) => s.threadId === m.senderThreadId && s.status === "active");
        author = sender?.id ?? seatId;
        body = sender ? `To @${seatId} (sent in T3): ${body}` : `From a thread outside the room (${m.senderThreadId}), sent in T3: ${body}`;
      }
      if (committed(p, author, id)) continue;
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
      if (committed(p, seatId, id) || committed(p, SYSTEM, id)) continue;
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
        if (origin === "self") this.continuation(roomId, seatId, id, shown, end === "completed" && text.length > 0, detail);
        else if (origin === "host") {
          const failed = hostRuns.find((r) => r.dispatchMessageId === t3Run.userMessageId)!;
          this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: `(T3 ran a message after Backroom had recorded it as failed) ${shown}`, requestIds: finalTargets(p, failed) });
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
  private continuation(roomId: string, seatId: string, id: string, text: string, replied: boolean, detail: T3ThreadDetail): void {
    const p = this.project(roomId);
    const pending = pendingActivities(p, seatId);
    if (pending.length === 0) {
      // A self-started turn: a note under the seat's latest answer, so its requester's next briefing has it (§5).
      if (text) this.exec(roomId, { type: "post", actor: seatId, id, intent: "note", body: text, requestIds: lastAnswered(p, seatId) });
      return;
    }
    const settle = pending.filter((a) => a.id.startsWith("bg:") && !memberHeld(p, a)).sort((a, b) => a.id.localeCompare(b.id));
    if (replied && backgroundTasks(detail).length === 0 && settle.length > 0) {
      settle.forEach((a, index) => {
        const key = index === 0 ? id : `${id}:${a.id}`;
        const open = openOwned(p, a.requestIds, seatId);
        this.exec(roomId, { type: "output", actor: SYSTEM, id: key, author: seatId, sourceKey: key, association: { kind: "activity", id: a.id }, activityCompletion: "done", body: text, disposition: open.length ? { kind: "answer", requestIds: open } : { kind: "yield" } });
        this.step("settled", roomId, seatId, a.runId);
      });
      return;
    }
    if (!text) return;
    const latest = [...pending].sort((a, b) => activityStartedSeq(p, b.id) - activityStartedSeq(p, a.id))[0]!;
    this.exec(roomId, { type: "output", actor: SYSTEM, id, author: seatId, sourceKey: id, association: { kind: "activity", id: latest.id }, body: text, disposition: { kind: "progress", requestIds: openOwned(p, latest.requestIds, seatId) } });
  }

  /** §2 (iii): a `bg:` activity nobody holds settles once the thread has been idle with nothing in the background. */
  private async settleIdle(roomId: string, seatId: string, shell: T3ThreadShell, load: Loader, imported: boolean): Promise<void> {
    const p = this.project(roomId);
    const candidates = pendingActivities(p, seatId).filter((a) => a.id.startsWith("bg:") && !memberHeld(p, a));
    if (candidates.length === 0) return;
    const detail = imported && !p.seats.get(seatId)!.activeRunId && threadFree(shell) ? await load() : null;
    const quiet = detail !== null && backgroundTasks(detail).length === 0;
    for (const a of candidates) {
      if (!quiet) {
        this.idleSince.delete(a.id);
        continue;
      }
      const since = this.idleSince.get(a.id) ?? this.now();
      this.idleSince.set(a.id, since);
      if (this.now() - since < this.idleSettleMs) continue;
      const open = openOwned(p, a.requestIds, seatId);
      const body = `(background work ended without a further turn)\n\n${lastFinal(p, a.runId)}`;
      this.exec(roomId, { type: "output", actor: SYSTEM, id: `idle:${a.id}`, author: seatId, sourceKey: `idle:${a.id}`, association: { kind: "activity", id: a.id }, activityCompletion: "done", body, disposition: open.length ? { kind: "answer", requestIds: open } : { kind: "yield" } });
      this.idleSince.delete(a.id);
      this.step("settled", roomId, seatId, a.runId);
    }
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

  /** `rooms-board note`. A note about a request names it (`requestIds`), or it reaches nobody's briefing (L2). */
  note(roomId: string, input: { actor: string; id: string; body: string; requestIds?: string[] }): CommitReceipt {
    return this.member(roomId, { type: "post", actor: input.actor, id: input.id, intent: "note", body: input.body, ...(input.requestIds ? { requestIds: input.requestIds } : {}) });
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
    const ids = input.requestIds ? unique(input.requestIds) : run ? turn : [...covered];
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
    const run = this.liveRun(p, seatId);
    const pending = pendingActivities(p, seatId);
    const ids = input.requestIds ? unique(input.requestIds) : run ? this.turnRequests(p, run) : unique(pending.flatMap((a) => openOwned(p, a.requestIds, seatId)));
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
    const rest = ids.filter((id) => !activities.some((a) => a.requestIds.includes(id)));
    let carrier: Run | undefined;
    if (rest.length) {
      carrier = run && rest.every((id) => allowedIds(p, run).has(id)) ? run
        : [...p.runs.values()].filter((r) => r.seatId === seatId && r.phase !== "prepared" && r.phase !== "sending" && r.phase !== "rejected" && rest.every((id) => allowedIds(p, r).has(id)))
          .sort((a, b) => reservedSeq(p, b.id) - reservedSeq(p, a.id))[0];
      if (!carrier) throw new HostRefusal(`${rest.map((id) => `#${id}`).join(" ")} did not reach you in one turn: answer each separately.`);
    }
    const claims: ClaimOutcome[] = [];
    let index = 0;
    const next = () => (index++ === 0 ? input.id : `${input.id}:${index}`);
    for (const a of activities) {
      const key = next();
      claims.push(...claimsOf(this.member(roomId, { type: "output", actor: seatId, id: key, author: seatId, sourceKey: `answer:${seatId}:${key}`, association: { kind: "activity", id: a.id }, activityCompletion: "done", body: input.body, disposition: { kind: "answer", requestIds: openOwned(p, a.requestIds, seatId) } })));
    }
    if (carrier) {
      const key = next();
      claims.push(...claimsOf(this.member(roomId, { type: "output", actor: seatId, id: key, author: seatId, sourceKey: `answer:${seatId}:${key}`, association: { kind: "run", id: carrier.id }, body: input.body, disposition: { kind: "answer", requestIds: rest } })));
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
      const detail = await this.adapter.getThreadDetail(owner.threadId).catch(() => null);
      const t3Run = detail ? runForMessage(detail, run.dispatchMessageId) : null;
      if (t3Run) await this.sendInterrupts(roomId, run.id, owner.threadId, t3Run);
    }
    this.hint();
    return { applied, deferred: false };
  }

  // ---------------- helpers ----------------

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
