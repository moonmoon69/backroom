/**
 * A member's T3 status (H5), put at the top of each of its posts that wakes the orchestrator: whether a turn is running on
 * its thread, and the background tasks and subagents T3 still lists, by name. The quiet follow-up reads the names back
 * from the member's latest post, so the line's form is fixed here, written and read in one place.
 */
import type { T3ThreadDetail } from "../adapter/types.ts";
import { isPullRequestWatch, isRunActive } from "../adapter/types.ts";
import { backgroundTasks } from "../app/threadView.ts";
import type { Projection } from "../engine/index.ts";

export interface MemberStatus {
  /** A turn other than the one just ended is running or queued on the thread. */
  turnRunning: boolean;
  /** What T3 lists in the background: `background task "…"`, `monitor "…"` or `subagent "…"`. */
  running: string[];
  /**
   * A turn or work of the member's own is in flight, which the keep-alive waits on. T3's watch of a pull request is
   * listed and named, but waited on by nobody: it lasts for the pull request's life.
   */
  inFlight: boolean;
}

/** The milestone of a follow-up post: a member's turn that answered nothing, or background work that ended quietly. */
export const FOLLOW_UP = "follow-up";

const PREFIX = "[T3 status of @";
const LABEL = /(background task|monitor|subagent) ("(?:[^"\\]|\\.)*")/g;

/** The thread as T3 shows it now, leaving out the turn whose end is being imported. */
export function memberStatus(detail: T3ThreadDetail, endedRunId: string | null): MemberStatus {
  const turnRunning = detail.runs.some((run) => run.id !== endedRunId && isRunActive(run.status));
  const tasks = backgroundTasks(detail);
  const running = tasks.map((task) => `${task.type === "subagent" ? "subagent" : task.type === "monitor" ? "monitor" : "background task"} ${JSON.stringify(task.title)}`);
  return { turnRunning, running, inFlight: turnRunning || tasks.some((task) => !isPullRequestWatch(task)) };
}

/**
 * The status line. While a turn runs, T3 does not list background tasks (only subagents), so the line says so instead of
 * claiming there are none.
 */
export function statusLine(alias: string, status: MemberStatus): string {
  const parts: string[] = [];
  if (status.turnRunning) parts.push("a turn is running (T3 lists no background tasks while it runs)");
  if (status.running.length > 0) parts.push(`still running: ${status.running.join(", ")}`);
  return `${PREFIX}${alias}: ${parts.length ? parts.join("; ") : "idle"}]`;
}

/** A post's text without its status line, for a preview (the overview's last reply). */
export function withoutStatusLine(body: string): string {
  return body.startsWith(PREFIX) ? body.slice(body.indexOf("\n") + 1).replace(/^\n/, "") : body;
}

/** The labels a post's status line names as still running; null when the post has no status line. */
export function runningIn(body: string): string[] | null {
  if (!body.startsWith(PREFIX)) return null;
  const line = body.split("\n", 1)[0]!;
  return [...line.matchAll(LABEL)].map((m) => `${m[1]} ${m[2]}`);
}

/** The seat's newest post with a status line (an answer, a failure or a follow-up the host wrote), and the requests it is on. */
export function latestStatusPost(p: Projection, seatId: string): { eventId: string; running: string[]; requestIds: string[] } | null {
  for (let i = p.events.length - 1; i >= 0; i--) {
    const e = p.events[i]!;
    const d = e.data;
    if (d.kind === "output" && d.author === seatId) {
      const running = runningIn(d.body);
      if (running) return { eventId: e.id, running, requestIds: d.claims.length ? d.claims.map((c) => c.requestId) : "requestIds" in d.disposition ? [...d.disposition.requestIds] : [] };
    }
    if (d.kind === "progress" && d.author === seatId && d.milestone === FOLLOW_UP) {
      const running = runningIn(d.body);
      if (running) return { eventId: e.id, running, requestIds: [...d.requestIds] };
    }
  }
  return null;
}
