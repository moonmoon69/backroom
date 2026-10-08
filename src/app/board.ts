/**
 * What the board command (bin/rooms-board, src/app/boardEngine.ts) shares with the routes that serve it: its error, the
 * page size of a long post, and how a retire reply words what became of the member's T3 thread.
 */

/** A post longer than this is printed in pages. */
export const BOARD_PAGE_CHARS = 20_000;

export class BoardError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BoardError";
    this.status = status;
  }
}

/** What participant.retire did with the member's T3 thread. */
export interface RetiredThread {
  action: string;
  result: "done" | "kept" | "failed";
  detail?: string;
}

const PAST: Record<string, string> = { settle: "settled", archive: "archived", delete: "deleted" };

/** What became of a retired member's T3 thread, in a sentence for the retire reply. */
export function threadOutcome(thread: RetiredThread | undefined): string {
  if (!thread) return "It had no T3 thread.";
  if (thread.result === "done") return `Its T3 thread was ${PAST[thread.action] ?? thread.action}, as the user's retire setting says.`;
  if (thread.result === "failed") return `Its T3 thread stays as it was: T3 could not ${thread.action} it (${thread.detail ?? "failed"}).`;
  if (thread.action === "keep") return "Its thread stays in T3.";
  return `Its thread stays in T3 (${thread.detail ?? "kept"}), although the retire setting says ${thread.action}.`;
}
