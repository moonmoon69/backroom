/**
 * Backroom in place of T3's window and its "Resume after usage limits" setting (the user's #160). A thread whose run
 * stopped on its provider's usage limit is armed in T3 to continue at the reset (thread.metadata.update limitRecovery,
 * autoResume on), and T3's own recovery worker continues it then, whatever T3's autoResumeLimitedThreads says: that
 * setting only decides whether T3 arms threads by itself, and it is off here. Backroom sends no continuation of its own
 * and keeps no timer.
 *
 * T3's thread.metadata.update overwrites the recovery record whatever it held, so no order of reads and writes keeps an
 * arming from undoing a Stop or a Don't resume that landed meanwhile. The arming is a reconciliation instead: each time
 * Backroom reads a limited thread it compares T3's record with what the user wants (limitIntent.ts: "stopped", "off",
 * or nothing) and the mark a stop leaves on the run, and sends what brings the record there. A lost answer, a restart or
 * an arming in flight when the user turns the resume off all settle at the next read. It never arms within two minutes
 * of the reset, so T3's worker, due at the reset, never meets an arming before its repair; past the reset, Resume now is
 * the user's.
 */
import type { T3Adapter, T3ThreadDetail, T3ThreadShell, ThreadControl } from "../adapter/types.ts";
import { T3CommandRejected, limitArmId, stopReached } from "../adapter/types.ts";
import { memoryLimitIntents, type LimitIntent, type LimitIntents } from "./limitIntent.ts";
import { disarmId } from "./threadControl.ts";

/** No arming this close to the reset, or after it: T3's worker may be due before a repair could land. */
export const ARM_MARGIN_MS = 2 * 60_000;

type Reconcile = { commandId: string; control: Extract<ThreadControl, { type: "limit.arm" | "limit.disarm" }> };

/**
 * What brings T3's recovery record for a limited thread to what the user wants, or null:
 * - a record on, with an intent of "stopped" or "off", or a stop's mark on the run: turn it off (its ID names the record
 *   it turns off, so a resend is a replay and a later record gets a command of its own);
 * - no record, no intent, no stop's mark, and the reset more than two minutes away (and after the run ended): arm it;
 * - anything else (a record off, an intent with no record, a thread archived, settled, deleted or waiting on a request):
 *   nothing.
 */
export function limitAction(shell: T3ThreadShell, detail: Pick<T3ThreadDetail, "turnItems"> | null, intent: LimitIntent | null, now: number): Reconcile | null {
  const limit = shell.usageLimit;
  if (!limit?.resetAt || shell.archivedAt !== null || shell.settledAt !== null || shell.deletedAt !== null || shell.pendingRequest !== null) return null;
  const stopped = detail !== null && stopReached(detail, limit.runId);
  if (limit.recovery?.autoResume) {
    return intent !== null || stopped ? { commandId: disarmId(shell.id, limit), control: { type: "limit.disarm", runId: limit.runId, resetAt: limit.resetAt } } : null;
  }
  if (limit.recovery || intent !== null || stopped || detail === null) return null;
  const resetMs = Date.parse(limit.resetAt);
  if (!Number.isFinite(resetMs) || resetMs - now <= ARM_MARGIN_MS || (shell.latestRunCompletedAt !== null && resetMs <= Date.parse(shell.latestRunCompletedAt))) return null;
  return { commandId: limitArmId(shell.id, limit.runId, limit.resetAt), control: { type: "limit.arm", runId: limit.runId, resetAt: limit.resetAt } };
}

export class LimitRecovery {
  private readonly adapter: T3Adapter;
  private readonly intents: LimitIntents;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;
  /** Commands T3 refused: not sent again (T3's word is final for that record), and logged once. */
  private readonly refused = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(adapter: T3Adapter, options: { intents?: LimitIntents; now?: () => number; log?: (message: string, detail?: unknown) => void } = {}) {
    this.adapter = adapter;
    this.intents = options.intents ?? memoryLimitIntents();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Look at T3's threads now and on every change of its shell. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.adapter.onShellChange(() => void this.sweep());
    void this.sweep();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** One pass over T3's threads; a pass asked for while one runs follows it. */
  sweep(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sweep();
      }
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    let shells: T3ThreadShell[];
    try {
      shells = await this.adapter.listThreads();
    } catch {
      return; // T3 out of reach: its next change looks again.
    }
    for (const listed of shells) {
      if (!listed.usageLimit?.resetAt) continue;
      // Read and settle until nothing is left to send: what Backroom just sent is read back like anything else.
      for (let round = 0; round < 3; round += 1) {
        let action: Reconcile | null = null;
        try {
          const detail = await this.adapter.getThreadDetail(listed.id, { bounded: true });
          if (!detail) break;
          const limit = detail.shell.usageLimit;
          const intent = limit?.resetAt ? this.intents.get(listed.id, limit.runId, limit.resetAt) : null;
          action = limitAction(detail.shell, detail, intent, this.now());
          if (!action || this.refused.has(action.commandId)) break;
          await this.adapter.controlThread({ commandId: action.commandId, threadId: listed.id, control: action.control });
          this.log(action.control.type === "limit.arm" ? "usage limit: T3 continues the thread at the reset" : "usage limit: T3's resume turned off, as the user wants", { threadId: listed.id, resetAt: action.control.resetAt });
        } catch (error) {
          if (error instanceof T3CommandRejected && action) {
            this.refused.add(action.commandId);
            this.log("usage limit: T3 refused", { threadId: listed.id, command: action.control.type, error: error.message });
          }
          // T3 did not answer: the next read decides again, with the same IDs.
          break;
        }
      }
    }
  }
}
