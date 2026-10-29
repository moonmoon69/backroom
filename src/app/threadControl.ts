/**
 * The page's controls on a thread's runs, for a room's member and for a thread on its own alike: continue a turn its
 * usage limit paused, and resume a held queue. Each is one T3 command (adapter.controlThread); T3's own guards decide,
 * and what T3 refuses is said in T3's words, never shown as work that started.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3ThreadShell, ThreadControl } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable } from "../adapter/types.ts";
import { RoomError } from "../domain/errors.ts";

/** What the page asks for: resume the paused turn, or the held queue. */
export type PageControl = { type: "resume" } | { type: "queue.resume" };

/** What came of it: T3 took the command, or the turn had already continued (T3's worker, another page, a double click). */
export type ControlOutcome = "sent" | "already";

/**
 * The T3 command for continuing a paused turn now: T3's own Continue (message.dispatch manualContinuationOfRunId), before
 * the reset or after it. Its ID is the run's, so a second click is a replay of the first; T3 refuses it once the turn has
 * continued (its worker at the reset, another page).
 */
export function resumeCommand(shell: T3ThreadShell): { commandId: string; control: ThreadControl } | null {
  const limit = shell.usageLimit;
  if (!limit) return null;
  return { commandId: `limit-continue:${shell.id}:${limit.runId}`, control: { type: "run.continue", runId: limit.runId } };
}

export async function controlThread(adapter: T3Adapter, threadId: string, control: PageControl): Promise<ControlOutcome> {
  const shell = await call(() => adapter.getThreadShell(threadId));
  if (!shell) throw new RoomError("not_found", "thread not found in T3", 404);
  if (control.type === "queue.resume") {
    await call(() => adapter.controlThread({ commandId: randomUUID(), threadId, control: { type: "queue.resume" } }));
    return "sent";
  }
  const command = resumeCommand(shell);
  if (!command) return "already";
  try {
    await call(() => adapter.controlThread({ threadId, ...command }));
  } catch (error) {
    // T3 refuses a continuation of a run that is no longer the limited one: it continued meanwhile.
    const after = error instanceof RoomError && error.code === "t3_rejected" ? await adapter.getThreadShell(threadId).catch(() => null) : null;
    if (after && after.usageLimit?.runId !== shell.usageLimit?.runId) return "already";
    throw error;
  }
  return "sent";
}

/** A T3 call, with an unreachable T3 as 503 and a refused command as 502 in T3's words. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
    if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
    throw error;
  }
}
