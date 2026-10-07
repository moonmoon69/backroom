/** What the host reads from a member's T3 thread: whose run it is, its final message, and whether the thread is free. */
import type { T3Message, T3Run, T3ThreadDetail, T3ThreadShell } from "../adapter/types.ts";
import { isRunActive, runReplies } from "../adapter/types.ts";

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
  return run.status === "interrupted" || run.status === "cancelled" ? "the run was stopped in T3" : (detail.shell.lastError ?? "T3 reported an error");
}

/** The thread can take a new run: no active run and no approval or question waiting (R3). */
export function threadFree(shell: T3ThreadShell): boolean {
  return !isRunActive(shell.status) && shell.activeRunId === null && shell.pendingRequest === null;
}

export function isTerminal(run: T3Run): boolean {
  return !isRunActive(run.status);
}
