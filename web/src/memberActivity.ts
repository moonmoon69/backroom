/** What a room member is doing, from its T3 thread: the Members panel's label, the motion of its card, what runs. */
import type { Desk, ParticipantStatus } from "./types.ts";

/** What a member is doing, in T3 Code's terms (its thread status pills), with what the room can add. */
export interface MemberActivity {
  label: string;
  /** Colour of the label, and of the card's border while it needs a look: working, approval, input, error, missing, idle, stopped, unknown. */
  tone: string;
  /** The card moves while work runs: "working" (a turn, subagents), "monitoring" (only watch loops: slower, fainter). */
  motion: "working" | "monitoring" | null;
  /** What runs besides the turn, when T3 lists it: "2 subagents · 1 shell". */
  detail: string | null;
}

const MONITOR_TYPES = new Set(["monitor", "monitor_mcp"]);

/** T3's open task.* jobs on the thread, counted by kind: subagents (and workflows), monitors, shells. */
function jobsDetail(desk: Desk | null | undefined): { detail: string | null; agents: number } {
  const jobs = desk?.backgroundTasks ?? [];
  const agents = jobs.filter((job) => job.kind === "agent").length;
  const monitors = jobs.filter((job) => job.kind !== "agent" && MONITOR_TYPES.has(job.type ?? "")).length;
  const shells = jobs.length - agents - monitors;
  const count = (n: number, word: string) => (n > 0 ? `${n} ${word}${n === 1 ? "" : "s"}` : null);
  const parts = [count(agents, "subagent"), count(monitors, "monitor"), count(shells, "shell")].filter(Boolean);
  return { detail: parts.length > 0 ? parts.join(" · ") : null, agents };
}

/**
 * The member's activity, most pressing first, as T3 Code ranks its thread pills: waiting on you (an approval, then a
 * question), working (a room turn, a turn typed in T3, connecting), work left running after the turn (subagents,
 * then only watch loops: monitoring), a plan ready to act on, then the session's own state. `desk` adds what runs.
 */
export function describeStatus(status: ParticipantStatus | undefined, desk?: Desk | null): MemberActivity {
  const idle = (label: string, tone: string): MemberActivity => ({ label, tone, motion: null, detail: null });
  if (!status) return idle("unknown", "unknown");
  // A deleted T3 thread outranks everything: the participant cannot receive work until rebound or removed.
  if (status.threadMissing) return idle("thread deleted in T3", "missing");
  if (status.pendingApprovals) return idle("needs approval", "approval");
  if (status.pendingUserInput) return idle("waiting for your answer", "input");
  const jobs = jobsDetail(desk);
  const working = (label: string): MemberActivity => ({ label, tone: "working", motion: "working", detail: jobs.detail });
  if (status.activeRunId) return working("working");
  if (status.externalActivity) return working("working in T3");
  if (status.session === "running") return working("working");
  if (status.session === "starting") return working("starting");
  // Between turns but not done: the agent wakes itself when its background work finishes.
  if (status.background === "working") return working(jobs.agents > 0 ? "subagents running" : "background work");
  if (status.background === "monitoring") return { label: "monitoring", tone: "working", motion: "monitoring", detail: jobs.detail };
  if (desk?.interactionMode === "plan" && desk.proposedPlan && !desk.proposedPlan.implementedAt) return idle("plan ready", "input");
  switch (status.session) {
    case "error":
      return idle("error", "error");
    case "idle":
    case "ready":
      return idle(status.session, "idle");
    case "interrupted":
    case "stopped":
      return idle(status.session, "stopped");
    default:
      return idle("unknown", "unknown");
  }
}
