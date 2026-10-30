/**
 * The page's controls on a thread's runs, for a room's member and for a thread on its own alike: continue a turn its
 * usage limit paused, resume a held queue, stop everything on a thread on its own, and stop one subagent. Each is one
 * T3 command (adapter.controlThread); T3's own guards decide, and what T3 refuses is said in T3's words, never shown as
 * work that started.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3ThreadShell, ThreadControl } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable, limitIdentity } from "../adapter/types.ts";
import { RoomError } from "../domain/errors.ts";
import type { z } from "zod";
import type { PageControlSchema } from "../domain/commands.ts";

/** What the page asks for (domain/commands.ts PageControlSchema). */
export type PageControl = z.infer<typeof PageControlSchema>;

/**
 * What came of it: T3 took the command, or there was nothing left to do (the turn had already continued, or its resume
 * was already off).
 */
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
  if (control.type === "queue.resume" || control.type === "stop.all") {
    await call(() => adapter.controlThread({ commandId: randomUUID(), threadId, control: { type: control.type === "stop.all" ? "thread.stop" : "queue.resume" } }));
    return "sent";
  }
  if (control.type === "resume.cancel") {
    // T3's own record, turned off for this run and reset; one already off, or none to turn off, sends nothing.
    const limit = shell.usageLimit;
    if (!limit?.resetAt || limit.recovery?.autoResume === false) return "already";
    await call(() => adapter.controlThread({ commandId: `limit-disarm:${limitIdentity(threadId, limit.runId, limit.resetAt!)}`, threadId, control: { type: "limit.disarm", runId: limit.runId, resetAt: limit.resetAt! } }));
    return "sent";
  }
  if (control.type === "subagent.stop") {
    // T3 takes a stop of a subagent that has finished and does nothing: say so instead of seeming to stop it.
    const detail = await call(() => adapter.getThreadDetail(threadId, { bounded: true }));
    const subagent = detail?.subagents.find((s) => s.id === control.subagentId && s.runId === control.runId);
    if (!subagent) throw new RoomError("not_found", "That subagent is not on this thread's run.", 404);
    if (subagent.status !== "pending" && subagent.status !== "running" && subagent.status !== "waiting") throw new RoomError("stale", `That subagent has already ${subagent.status === "completed" ? "finished" : subagent.status}.`, 409);
    await call(() => adapter.controlThread({ commandId: randomUUID(), threadId, control: { type: "subagent.stop", runId: control.runId, subagentId: control.subagentId } }));
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
