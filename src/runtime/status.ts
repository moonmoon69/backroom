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
  /**
   * What T3 lists in the background: `background task "…"`, `monitor "…"` or `subagent "…"`. Each label is the task's
   * own name and kind, which do not change while it runs: the quiet follow-up compares them.
   */
  running: string[];
  /**
   * The same tasks in the same order, each with what it says beside its label: a pull-request watch's line ("1 check
   * pending (…) · watched for 8h"). Each its own, by the task's id: two watches can share a label.
   */
  listed: Array<{ taskId: string; label: string; note: string | null }>;
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
  const label = (task: (typeof tasks)[number]) => `${task.type === "subagent" ? "subagent" : task.type === "monitor" ? "monitor" : "background task"} ${JSON.stringify(task.title)}`;
  // A watch's line, without its title (the label names it already) and with no quotes, which a label ends with.
  const listed = tasks.map((task) => ({ taskId: task.taskId, label: label(task), note: isPullRequestWatch(task) && task.detail ? task.detail.replace(/^Watching pull request #\d+: /, "").replace(/"/g, "'") : null }));
  return { turnRunning, running: listed.map((task) => task.label), listed, inFlight: turnRunning || tasks.some((task) => !isPullRequestWatch(task)) };
}

/**
 * The status line. While a turn runs, T3 does not list background tasks (only subagents), so the line says so instead of
 * claiming there are none.
 */
export function statusLine(alias: string, status: MemberStatus): string {
  const parts: string[] = [];
  if (status.turnRunning) parts.push("a turn is running (T3 lists no background tasks while it runs)");
  if (status.listed.length > 0) parts.push(`still running: ${status.listed.map((task) => (task.note ? `${task.label} (${task.note})` : task.label)).join(", ")}`);
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
