/** What a room member is doing, from its T3 thread: the Members panel's label, the motion of its card, what runs. */
import { isRunActive, type Desk, type ParticipantStatus } from "./types.ts";

/** What a member is doing, in T3 Code's terms (its thread status pills), with what the room can add. */
export interface MemberActivity {
  label: string;
  /** Colour of the label, and of the card's border while it needs a look: working, approval, input, error, missing, idle, stopped, unknown. */
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

/**
 * What still runs on the thread, each job as T3 lists it with its kind and minutes ("Run the tests (command, 2m) · …"),
 * or that the agent will continue when it finishes when T3 lists none.
 */
export function jobsLine(desk: Desk | null | undefined, now: number): string {
  const jobs = desk?.backgroundTasks ?? [];
  if (jobs.length === 0) return "will continue when it finishes";
  return jobs.map((job) => `${job.title} (${job.kind === "agent" ? "subagent" : job.type === "monitor" ? "monitor" : "command"}, ${Math.max(1, Math.round((now - Date.parse(job.startedAt)) / 60000))}m)`).join(" · ");
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
 * The member's activity, most pressing first, as T3 Code ranks its thread pills: waiting on you (an approval, then a
 * question), working (a room turn, a turn of its own that the room did not start, connecting), work left running after the turn (subagents,
 * then only monitors: monitoring), a plan ready to act on, then how its last run ended. `desk` adds what runs.
 */
export function describeStatus(status: ParticipantStatus | undefined, desk?: Desk | null): MemberActivity {
  const idle = (label: string, tone: string): MemberActivity => ({ label, tone, motion: null, detail: null });
  // Not read yet (a member seated a moment ago, before T3's thread list was read for it): ready for work.
  if (!status) return idle("ready", "idle");
  // A deleted T3 thread outranks everything: the member cannot receive work until it is removed.
  if (status.threadMissing) return idle("thread deleted in T3", "missing");
  if (status.pendingApprovals) return idle("needs approval", "approval");
  if (status.pendingUserInput) return idle("waiting for your answer", "input");
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
  if (liveness === "monitoring") return { label: "monitoring", tone: "working", motion: "monitoring", detail: jobs.detail };
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
