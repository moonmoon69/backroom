/**
 * Backroom in place of T3's window and its "Resume after usage limits" setting (the user's #160). A thread whose run
 * stopped on its provider's usage limit is armed in T3 to continue at the reset (thread.metadata.update limitRecovery,
 * autoResume on), and T3's own recovery worker continues it then, whatever T3's autoResumeLimitedThreads says: that
 * setting only decides whether T3 arms threads by itself, and it is off here. Backroom sends no continuation of its own
 * and keeps no timer: it arms what T3's shell shows limited, when T3's shell changes. A recovery that is off (a Stop,
 * or the user in T3) stays off.
 *
 * T3's arming command overwrites what is recorded, so an arming decided on an older read could undo a Stop that landed
 * meanwhile. A Stop leaves its mark on the run it reached (T3's interrupt request), and that mark is what decides: a run
 * a stop reached is never armed, and an arming that turns out to have landed after one is turned off again.
 */
import type { T3Adapter, T3ThreadShell, ThreadControl } from "../adapter/types.ts";
import { T3CommandRejected, limitArmId, stopReached } from "../adapter/types.ts";
import { disarmId } from "./threadControl.ts";

/**
 * The arming of a limited thread nobody armed, as T3's limitRecoveryCommand would arm it, or null: nothing for a thread
 * archived, settled, deleted or waiting on a request, a reset T3 cannot use (none, unreadable, or not after the run
 * ended), or a recovery already recorded for this run and reset (on, or turned off).
 */
export function limitStep(shell: T3ThreadShell): { commandId: string; control: Extract<ThreadControl, { type: "limit.arm" }> } | null {
  const limit = shell.usageLimit;
  if (!limit?.resetAt || limit.recovery || shell.archivedAt !== null || shell.settledAt !== null || shell.deletedAt !== null || shell.pendingRequest !== null) return null;
  const resetMs = Date.parse(limit.resetAt);
  if (!Number.isFinite(resetMs) || (shell.latestRunCompletedAt !== null && resetMs <= Date.parse(shell.latestRunCompletedAt))) return null;
  return { commandId: limitArmId(shell.id, limit.runId, limit.resetAt), control: { type: "limit.arm", runId: limit.runId, resetAt: limit.resetAt } };
}

export class LimitRecovery {
  private readonly adapter: T3Adapter;
  private readonly log: (message: string, detail?: unknown) => void;
  /** Armings T3 refused: not sent again (T3's word is final for that run and reset), and logged once. */
  private readonly refused = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(adapter: T3Adapter, options: { log?: (message: string, detail?: unknown) => void } = {}) {
    this.adapter = adapter;
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
      return; // T3 out of reach: its next change, or the next start, looks again.
    }
    for (const shell of shells) {
      const step = limitStep(shell);
      if (!step || this.refused.has(step.commandId)) continue;
      try {
        // Against the run as it is now: a stop that reached it decides, whatever the list said.
        const before = await this.adapter.getThreadDetail(shell.id, { bounded: true });
        if (!before || stopReached(before, step.control.runId) || before.shell.usageLimit?.recovery) continue;
        await this.adapter.controlThread({ commandId: step.commandId, threadId: shell.id, control: step.control });
        const after = await this.adapter.getThreadDetail(shell.id, { bounded: true });
        const limit = after?.shell.usageLimit;
        if (after && limit?.runId === step.control.runId && limit.recovery?.autoResume && stopReached(after, step.control.runId)) {
          // A stop landed before the arming did, and the arming overwrote what it turned off: off again.
          await this.adapter.controlThread({ commandId: disarmId(shell.id, limit), threadId: shell.id, control: { type: "limit.disarm", runId: step.control.runId, resetAt: step.control.resetAt } });
          this.log("usage limit: a stop reached the thread before its arming landed; T3's resume turned off again", { threadId: shell.id });
          continue;
        }
        this.log("usage limit: T3 continues the thread at the reset", { threadId: shell.id, resetAt: step.control.resetAt });
      } catch (error) {
        if (error instanceof T3CommandRejected) {
          this.refused.add(step.commandId);
          this.log("usage limit: T3 refused to arm its recovery", { threadId: shell.id, error: error.message });
        }
        // Otherwise T3 did not answer: the same arming, with the same ID, goes again on the next pass.
      }
    }
  }
}
