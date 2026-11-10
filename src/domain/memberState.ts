/**
 * What a room member is doing, from its T3 thread: one ordered table, read by the page's member label, by the members
 * command and by the engine host's notices to the Consigliere. T3 streams thread rows, not states; its client ranks them
 * into its sidebar pills, and this is the same ranking with the room's additions (a secret, a held queue, a plan ready),
 * in T3's names where it has them. Shared by the server and the page: no imports beyond the domain.
 */
import { pauseLabel, resetTime } from "./usageLimit.ts";

/** A thread's status in T3 (T3ThreadStatus), "unknown" before it was read. */
export type ThreadStatus = "idle" | "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back" | "unknown";

/** Work running on the thread beside or after its run, as the desk lists it (src/app/threadView.ts backgroundTasks). */
export interface MemberJob {
  taskId: string;
  title: string;
  /** "agent" for a subagent, else work T3 lists in the background. */
  kind: string;
  /** T3's kind of it: subagent, command, monitor, background_task. */
  type: string | null;
  /** A pull-request watch's line ("Watching pull request #70: 1 check pending…"). */
  detail: string | null;
  startedAt: string;
}

/** A turn its provider's usage limit stopped, and whether T3 continues it at the reset ("on"), will not ("off"), or is not set yet. */
export interface MemberPause {
  provider: string;
  resetAt: string | null;
  message: string | null;
  resume: "on" | "off" | null;
}

/**
 * The thread's queued messages, as T3 holds them: how many, and what holds them when nothing starts them. "limit": a
 * usage limit on the provider holds them until the limited turn continues (T3 refuses queue.resume until then). "held":
 * T3 held the queue (after a provider failure, a Stop, a disabled provider or a missing worktree) until someone resumes
 * it; `reason` only when T3's runs say it.
 */
export interface QueueState {
  count: number;
  hold: null | { by: "limit"; reason: string } | { by: "held"; reason: string | null };
}

/** What the table reads: T3's thread row and what it waits on, and what the room adds (its own run). */
export interface MemberFacts {
  status: ThreadStatus;
  /** T3 answered but no longer has the thread (deleted in T3). */
  missing: boolean;
  approval: boolean;
  secret: boolean;
  input: boolean;
  paused: MemberPause | null;
  queue: QueueState | null;
  /** A room run is on the thread. */
  ownRun: boolean;
  /** T3 runs a turn the room did not start: it woke itself, another member sent it, or someone typed in T3. */
  external: boolean;
  /** Work T3 lists after the run settled: subagents or commands ("working"), only monitors ("monitoring"). */
  background: "working" | "monitoring" | null;
  jobs: readonly MemberJob[];
  /** A plan proposed in plan mode, not acted on yet. */
  planReady: boolean;
}

export type MemberStateName =
  | "deleted" | "approval" | "secret" | "input" | "limited" | "held" | "working"
  | "failed" | "interrupted" | "rolled-back" | "background" | "monitoring" | "plan" | "ready" | "unknown";

export interface MemberState {
  state: MemberStateName;
  label: string;
  /**
   * Colour of the label, and of the card's border while it needs a look: working, approval, input, error, missing, idle,
   * stopped, paused (a usage limit: neither working nor needing you), unknown.
   */
  tone: string;
  /** The card moves while work runs: "working" (a turn, subagents), "monitoring" (only watch loops: slower, fainter). */
  motion: "working" | "monitoring" | null;
  /** What runs, or what holds it, in a line: "2 subagents · 1 command". */
  detail: string | null;
}

/** T3's watch of a pull request, among what runs on the thread. */
const isWatch = (job: { taskId: string }): boolean => job.taskId.startsWith("pull-request-watch:");

const ACTIVE = new Set<ThreadStatus>(["preparing", "starting", "running", "waiting"]);

/** T3 holds the member's queue and runs nothing: what it was sent waits in that queue, room messages included. */
export const queueHeld = (status: ThreadStatus, queue: QueueState | null | undefined): boolean => queue?.hold?.by === "held" && !ACTIVE.has(status);

/** What still runs on the thread, counted by T3's kinds: subagents, monitors, commands (and work it cannot name). */
function counted(jobs: readonly MemberJob[]): string | null {
  const agents = jobs.filter((job) => job.kind === "agent").length;
  const monitors = jobs.filter((job) => job.kind !== "agent" && job.type === "monitor").length;
  const count = (n: number, word: string) => (n > 0 ? `${n} ${word}${n === 1 ? "" : "s"}` : null);
  const parts = [count(agents, "subagent"), count(monitors, "monitor"), count(jobs.length - agents - monitors, "command")].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * What still runs on the thread, each job as T3 lists it with its kind and minutes ("Run the tests (command, 2m) · …"),
 * or that the agent will continue when it finishes when T3 lists none.
 */
export function jobsLine(jobs: readonly MemberJob[] | undefined, now: number): string {
  if (!jobs || jobs.length === 0) return "will continue when it finishes";
  // T3's watch of a pull request says what it waits for in its own line ("Watching pull request #70: 1 check pending…").
  return jobs.map((job) => (isWatch(job) && job.detail ? job.detail : `${job.title} (${job.kind === "agent" ? "subagent" : job.type === "monitor" ? "monitor" : "command"}, ${Math.max(1, Math.round((now - Date.parse(job.startedAt)) / 60000))}m)`)).join(" · ");
}

/**
 * The line under a paused member's label: the provider's own sentence, and whether T3 continues the turn at the reset.
 * In the reader's time zone, or `timeZone`.
 */
export function pauseDetail(pause: MemberPause, now: number, timeZone?: string): string {
  const time = resetTime(pause.resetAt, now, timeZone);
  const passed = time !== null && Date.parse(pause.resetAt!) <= now;
  const then =
    time === null ? "T3 has no reset time to continue it at"
    : pause.resume === "off" ? "T3 will not continue it"
    : pause.resume === "on" ? (passed ? "T3 continues it now that the limit reset" : `T3 continues it at ${time}`)
    : "T3 is not yet set to continue it";
  return pause.message ? `${pause.message} · ${then}` : then;
}

/** What holds a queue, in a line: the paused turn ("limit"), or T3 ("held") with its reason when known. Null when nothing does. */
export function queueLine(queue: QueueState | null | undefined): string | null {
  if (!queue?.hold) return null;
  const messages = `${queue.count} queued message${queue.count === 1 ? "" : "s"}`;
  return queue.hold.by === "limit" ? `${messages}: ${queue.hold.reason}` : `${messages} held by T3${queue.hold.reason ? `, ${queue.hold.reason}` : ""}`;
}

type Shown = Omit<MemberState, "state">;
const still = (label: string, tone: string, detail: string | null = null): Shown => ({ label, tone, motion: null, detail });
const working = (label: string) => (f: MemberFacts): Shown => ({ label, tone: "working", motion: "working", detail: counted(f.jobs) });
/** How the last run ended, and what it left running: an ended run outranks its leftovers, as T3's Failed pill does. */
const ended = (label: string, tone: string) => (f: MemberFacts, now: number): Shown => ({
  label,
  tone,
  motion: f.background,
  detail: f.background === null ? null : f.jobs.length > 0 ? `still running: ${jobsLine(f.jobs, now)}` : "background work still running",
});

/**
 * The member's state, most pressing first; the first row that holds is the state. Waiting on the user (an approval, a
 * secret, a question), then on T3 (a usage limit, a held queue): a room message sent meanwhile waits behind those, so
 * they outrank working. Then working, how the last run ended, work left running after the turn, a plan to act on.
 */
const TABLE: ReadonlyArray<{ state: MemberStateName; when: (f: MemberFacts) => boolean; show: (f: MemberFacts, now: number) => Shown }> = [
  // The member cannot receive work until the thread is removed from the room.
  { state: "deleted", when: (f) => f.missing, show: () => still("thread deleted in T3", "missing") },
  { state: "approval", when: (f) => f.approval, show: () => still("needs approval", "approval") },
  { state: "secret", when: (f) => f.secret, show: () => still("asking for a secret", "input") },
  { state: "input", when: (f) => f.input, show: () => still("waiting for your answer", "input") },
  { state: "limited", when: (f) => f.paused !== null, show: (f, now) => ({ label: pauseLabel(f.paused!, now), tone: "paused", motion: null, detail: pauseDetail(f.paused!, now) }) },
  { state: "held", when: (f) => queueHeld(f.status, f.queue), show: (f) => still("queue held", "stopped", queueLine(f.queue)) },
  { state: "working", when: (f) => f.ownRun, show: working("working") },
  { state: "working", when: (f) => f.external, show: working("working on its own") },
  { state: "working", when: (f) => f.status === "running" || f.status === "waiting", show: working("working") },
  { state: "working", when: (f) => f.status === "preparing" || f.status === "queued" || f.status === "starting", show: working("starting") },
  { state: "failed", when: (f) => f.status === "failed", show: ended("error", "error") },
  { state: "interrupted", when: (f) => f.status === "interrupted" || f.status === "cancelled", show: ended("interrupted", "stopped") },
  { state: "rolled-back", when: (f) => f.status === "rolled_back", show: ended("rolled back", "stopped") },
  { state: "background", when: (f) => f.background === "working", show: (f) => working(f.jobs.some((job) => job.kind === "agent") ? "subagents running" : "background work")(f) },
  {
    state: "monitoring",
    when: (f) => f.background === "monitoring",
    // Watching pull requests: what each waits for, from T3, so a hung check shows without opening GitHub.
    show: (f) => {
      const watches = f.jobs.filter((job) => isWatch(job) && job.detail).map((job) => job.detail!);
      return { label: "monitoring", tone: "working", motion: "monitoring", detail: watches.length > 0 ? watches.join(" · ") : counted(f.jobs) };
    },
  },
  { state: "plan", when: (f) => f.planReady, show: () => still("plan ready", "input") },
  // A run that completed, or a thread with none yet (or not read yet), is ready for the next.
  { state: "ready", when: (f) => f.status === "idle" || f.status === "completed" || f.status === "unknown", show: () => still("ready", "idle") },
  { state: "unknown", when: () => true, show: () => still("unknown", "unknown") },
];

/** The states in the table's order, most pressing first: the order docs/room.md's Members list gives them. */
export const RANKING: readonly MemberStateName[] = [...new Set(TABLE.map((row) => row.state))];

/** The member's state from its facts. `now` places a reset time before or after it, and times what runs. */
export function memberState(facts: MemberFacts, now = Date.now()): MemberState {
  const row = TABLE.find((r) => r.when(facts))!;
  return { state: row.state, ...row.show(facts, now) };
}
