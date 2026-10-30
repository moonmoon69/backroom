/** What a room member is doing, from its T3 thread: the Members panel's label, the motion of its card, what runs. */
import { isRunActive, type Desk, type ParticipantStatus, type QueueState, type UsageLimitPause } from "./types.ts";
import { pauseLabel, resetTime } from "../../src/domain/usageLimit.ts";

/** What a member is doing, in T3 Code's terms (its thread status pills), with what the room can add. */
export interface MemberActivity {
  label: string;
  /**
   * Colour of the label, and of the card's border while it needs a look: working, approval, input, error, missing, idle,
   * stopped, paused (a usage limit: neither working nor needing you), unknown.
   */
  tone: string;
  /** The card moves while work runs: "working" (a turn, subagents), "monitoring" (only watch loops: slower, fainter). */
  motion: "working" | "monitoring" | null;
  /** What runs besides the run, when T3 lists it: "2 subagents · 1 command". */
  detail: string | null;
}

/** What still runs on the thread, counted by T3's kinds: subagents, monitors, commands (and work it cannot name). */
function jobsDetail(desk: Desk | null | undefined): { detail: string | null; agents: number } {
  const jobs = desk?.backgroundTasks ?? [];
  const agents = jobs.filter((job) => job.kind === "agent").length;
  const monitors = jobs.filter((job) => job.kind !== "agent" && job.type === "monitor").length;
  const commands = jobs.length - agents - monitors;
  const count = (n: number, word: string) => (n > 0 ? `${n} ${word}${n === 1 ? "" : "s"}` : null);
  const parts = [count(agents, "subagent"), count(monitors, "monitor"), count(commands, "command")].filter(Boolean);
  return { detail: parts.length > 0 ? parts.join(" · ") : null, agents };
}

/** T3's watch of a pull request, among what runs on the thread. */
const isWatch = (job: { taskId: string }): boolean => job.taskId.startsWith("pull-request-watch:");

/**
 * What still runs on the thread, each job as T3 lists it with its kind and minutes ("Run the tests (command, 2m) · …"),
 * or that the agent will continue when it finishes when T3 lists none.
 */
export function jobsLine(desk: Desk | null | undefined, now: number): string {
  const jobs = desk?.backgroundTasks ?? [];
  if (jobs.length === 0) return "will continue when it finishes";
  // T3's watch of a pull request says what it waits for in its own line ("Watching pull request #70: 1 check pending…").
  return jobs.map((job) => (isWatch(job) && job.detail ? job.detail : `${job.title} (${job.kind === "agent" ? "subagent" : job.type === "monitor" ? "monitor" : "command"}, ${Math.max(1, Math.round((now - Date.parse(job.startedAt)) / 60000))}m)`)).join(" · ");
}

/**
 * Between turns but not done, as T3 reports it: background work or monitoring left running after the turn, which the
 * agent wakes itself from when it finishes. Null mid-turn, or with nothing left running.
 */
export function betweenTurns(status: ParticipantStatus | undefined, desk?: Desk | null): "working" | "monitoring" | null {
  if (!status || isRunActive(status.status)) return null;
  return desk?.backgroundLiveness ?? status.background ?? null;
}

/**
 * The line under a paused member's label: the provider's own sentence, and whether T3 continues the turn at the reset.
 * In the viewer's time zone.
 */
export function pauseDetail(pause: UsageLimitPause, now: number): string {
  const time = resetTime(pause.resetAt, now);
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

/**
 * The member's activity, most pressing first, as T3 Code ranks its thread pills: waiting on you (an approval, then a
 * secret, then a question), paused on a usage limit, working (a room turn, a turn of its own that the room did not start, connecting), work left running after the turn (subagents,
 * then only monitors: monitoring), a queue T3 holds, a plan ready to act on, then how its last run ended. `desk` adds
 * what runs. `now` places a reset time before or after it.
 */
export function describeStatus(status: ParticipantStatus | undefined, desk?: Desk | null, now = Date.now()): MemberActivity {
  const idle = (label: string, tone: string): MemberActivity => ({ label, tone, motion: null, detail: null });
  // Not read yet (a member seated a moment ago, before T3's thread list was read for it): ready for work.
  if (!status) return idle("ready", "idle");
  // A deleted T3 thread outranks everything: the member cannot receive work until it is removed.
  if (status.threadMissing) return idle("thread deleted in T3", "missing");
  if (status.pendingApprovals) return idle("needs approval", "approval");
  if (status.pendingSecret) return idle("asking for a secret", "input");
  if (status.pendingUserInput) return idle("waiting for your answer", "input");
  // Paused on a usage limit: a room message sent meanwhile waits in T3's queue behind it, so this outranks working.
  if (status.paused) return { label: pauseLabel(status.paused, now), tone: "paused", motion: null, detail: pauseDetail(status.paused, now) };
  const jobs = jobsDetail(desk);
  const working = (label: string): MemberActivity => ({ label, tone: "working", motion: "working", detail: jobs.detail });
  if (status.activeRunId) return working("working");
  // A turn the room did not start: it woke itself, another member sent it, or someone typed in T3 Code.
  if (status.externalActivity) return working("working on its own");
  if (status.status === "running" || status.status === "waiting") return working("working");
  if (status.status === "preparing" || status.status === "queued" || status.status === "starting") return working("starting");
  // Between turns but not done: the agent wakes itself when its background work finishes.
  const liveness = betweenTurns(status, desk);
  if (liveness === "working") return working(jobs.agents > 0 ? "subagents running" : "background work");
  if (liveness === "monitoring") {
    // Watching pull requests: what each waits for, from T3, so a hung check shows without opening GitHub.
    const watches = (desk?.backgroundTasks ?? []).filter((job) => isWatch(job) && job.detail).map((job) => job.detail!);
    return { label: "monitoring", tone: "working", motion: "monitoring", detail: watches.length > 0 ? watches.join(" · ") : jobs.detail };
  }
  if (desk?.queue?.hold?.by === "held") return { label: "queue held", tone: "stopped", motion: null, detail: queueLine(desk.queue) };
  if (desk?.interactionMode === "plan" && desk.proposedPlan && !desk.proposedPlan.implementedAt) return idle("plan ready", "input");
  // Between runs: how the last one ended. A run that completed, or a thread with none yet, is ready for the next.
  switch (status.status) {
    case "failed":
      return idle("error", "error");
    case "interrupted":
    case "cancelled":
      return idle("interrupted", "stopped");
    case "rolled_back":
      return idle("rolled back", "stopped");
    case "idle":
    case "completed":
    case "unknown":
      return idle("ready", "idle");
    default:
      return idle("unknown", "unknown");
  }
}
