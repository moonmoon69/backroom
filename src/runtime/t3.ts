/** What the host reads from a member's T3 thread: whose run it is, its final message, and whether the thread is free. */
import type { T3Message, T3Run, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { CONTINUE_TEXT, STOP_EVERYTHING_REASON, isPullRequestWatch, isRunActive, latestExecutedRun, runReplies } from "../adapter/types.ts";

/**
 * Who started a T3 run on a seat's thread:
 * - "host": the host's own dispatch (its message ID is a run's dispatch message ID);
 * - "user": someone typed it in T3 Code;
 * - "agent": another thread's agent sent it with T3's thread tools (the message names its sender thread);
 * - "self": the member's own continuation, started by a T3 notice (background work finished).
 * Only "self" can settle the seat's background work (§2); "user" and "agent" runs are notes (§3).
 */
export type RunOrigin = "host" | "user" | "agent" | "self";

export function runOrigin(detail: Pick<T3ThreadDetail, "messages">, run: T3Run, hostMessageIds: ReadonlySet<string>): RunOrigin {
  if (hostMessageIds.has(run.userMessageId)) return "host";
  const prompt = detail.messages.find((m) => m.id === run.userMessageId);
  if (!prompt) return "self";
  if (prompt.senderThreadId !== null) return "agent";
  if (prompt.role === "user" && prompt.createdBy === "user") return "user";
  return "self";
}

/** The run's final answer: its last finished assistant message. Null while the last one is still streaming. */
export function finalMessage(detail: Pick<T3ThreadDetail, "messages">, runId: string): { message: T3Message | null; streaming: boolean } {
  const all = detail.messages.filter((m) => m.runId === runId && m.role === "assistant");
  const last = all[all.length - 1];
  if (last?.streaming) return { message: null, streaming: true };
  const replies = runReplies(detail, runId);
  return { message: replies[replies.length - 1] ?? null, streaming: false };
}

export type RunEnd = "completed" | "interrupted" | "failed";

export function runEnd(run: T3Run): RunEnd {
  return run.status === "completed" ? "completed" : run.status === "interrupted" || run.status === "cancelled" ? "interrupted" : "failed";
}

export function runError(detail: T3ThreadDetail, run: T3Run): string {
  if (run.status === "rolled_back") return "the run was rolled back in T3";
  const last = detail.turnItems.filter((item) => item.runId === run.id && item.type === "error").pop();
  if (last?.type === "error") return last.message;
  const stop = detail.turnItems.filter((item) => item.runId === run.id && item.type === "run_interrupt_request").pop();
  if (stop?.type === "run_interrupt_request" && stop.message === STOP_EVERYTHING_REASON) return "the user stopped everything on the thread from Backroom: this turn, and the background work and subagents it left";
  return run.status === "interrupted" || run.status === "cancelled" ? "the run was stopped in T3" : (detail.shell.lastError ?? "T3 reported an error");
}

/** The usage limit a run stopped on: its provider, when the limit resets, and the provider's words. */
export interface RunLimit {
  provider: string;
  resetAt: string | null;
  message: string | null;
}

/** The usage limit that failed the run (its last error is of T3's class "usage_limit"), or null. */
export function runLimit(detail: Pick<T3ThreadDetail, "turnItems">, run: T3Run): RunLimit | null {
  if (run.status !== "failed") return null;
  const last = detail.turnItems.filter((item) => item.runId === run.id && item.type === "error").pop();
  return last?.type === "error" && last.failureClass === "usage_limit" ? { provider: run.providerInstanceId, resetAt: last.resetAt, message: last.message } : null;
}

/**
 * The run a continuation continues: T3's "Continue where you left off." after a turn its usage limit paused (at the
 * reset, or from Resume) continues the latest run before it that the limit stopped. Null for any other run.
 */
export function continuedRun(detail: Pick<T3ThreadDetail, "messages" | "runs" | "turnItems">, run: T3Run): T3Run | null {
  if (detail.messages.find((m) => m.id === run.userMessageId)?.text !== CONTINUE_TEXT) return null;
  const before = detail.runs.filter((r) => r.ordinal < run.ordinal && r.status !== "queued").sort((a, b) => b.ordinal - a.ordinal)[0];
  return before && runLimit(detail, before) ? before : null;
}

/** Backroom's Stop everything reached the thread's latest run (T3 writes its reason on the run it interrupts). */
export function stoppedEverything(detail: Pick<T3ThreadDetail, "runs" | "turnItems">): boolean {
  const latest = latestExecutedRun(detail.runs);
  return latest !== null && detail.turnItems.some((item) => item.runId === latest.id && item.type === "run_interrupt_request" && item.message === STOP_EVERYTHING_REASON);
}

/** The thread can take a new run: no active run and no approval or question waiting (R3). */
export function threadFree(shell: T3ThreadShell): boolean {
  return !isRunActive(shell.status) && shell.activeRunId === null && shell.pendingRequest === null;
}

/**
 * The agent on the thread has work in flight: a run, or background work of its own (subagents, commands, monitors).
 * T3's watch of a pull request is not its work: it lasts for the pull request's life and holds nothing.
 */
export function threadHasWork(shell: T3ThreadShell): boolean {
  return shell.activeRunId !== null || shell.pendingBackgroundTasks.some((task) => !isPullRequestWatch(task));
}

export function isTerminal(run: T3Run): boolean {
  return !isRunActive(run.status);
}
