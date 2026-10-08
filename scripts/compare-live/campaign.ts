/**
 * Where the comparison keeps things, the crew both sides seat, the job record the runner writes and measure.ts reads,
 * and the spend cap.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelSelection, RuntimeMode } from "../../src/domain/types.ts";
import type { CheckResult } from "./checkers.ts";
import type { TaskId } from "./tasks.ts";

/** Fixture, job folders and instance data: outside the repo, survives a reboot. */
export const COMPARE_ROOT = resolve(process.env.COMPARE_ROOT ?? join(homedir(), "Projects", "backroom-compare"));
/** Reports and evidence. */
export const EVIDENCE_ROOT = resolve(process.env.COMPARE_EVIDENCE ?? join(homedir(), "Projects", "backroom-handoff", "compare-live"));
export const FIXTURE_REPO = join(COMPARE_ROOT, "fixture");
export const FIXTURE_TAG = "fixture-v1";
export const WORKTREES = resolve(process.env.COMPARE_WORKTREES ?? join(homedir(), "Projects", "backroom-wt"));

export type Side = "old" | "new";

/** The instances: each runs from its own worktree with its own data/ (a link into COMPARE_ROOT), never :4400. */
export const INSTANCES: Record<Side, { url: string; worktree: string }> = {
  old: { url: "http://127.0.0.1:4481", worktree: join(WORKTREES, "compare-old") },
  new: { url: "http://127.0.0.1:4482", worktree: join(WORKTREES, "compare-new") },
};

/** The crew, the same on both sides: this room's models with their options, full access, in the project folder. */
export const CREW: { consigliere: { name: string; modelSelection: ModelSelection }; member: { name: string; modelSelection: ModelSelection }; runtimeMode: RuntimeMode } = {
  consigliere: {
    name: "Fable",
    modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }] },
  },
  member: {
    name: "Opus",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: false }, { id: "contextWindow", value: "1m" }],
    },
  },
  runtimeMode: "full-access",
};

/** The quiet the job window closes on, the cap after the report, and the cap without one. */
export const QUIET_MS = 180_000;
export const AFTER_REPORT_CAP_MS = 30 * 60_000;
export const NO_REPORT_CAP_MS = 60 * 60_000;

export interface Seat {
  role: "C" | "W1" | "V" | "W2";
  alias: string;
  participantId: string;
  threadId: string;
}

export interface Snapshot {
  kind: "answer" | "report" | "final";
  /** Who answered (answers), the Consigliere (report), or "" (final). */
  alias: string;
  postId: string | null;
  /** The post's time on the board (the instance's clock: the same machine). */
  at: string;
  observedAt: string;
  dir: string;
  check: CheckResult;
  /** Answers: the parts of the checker that are this member's, and whether they all passed. */
  ownParts?: string[];
  ownPass?: boolean;
}

export interface JobRecord {
  campaign: string;
  side: Side;
  task: TaskId;
  run: number;
  jobId: string;
  status: "running" | "closed" | "aborted";
  /** How the window closed: quiet for 3 minutes after the report, the 30-minute cap after it, or no report in 60. */
  close: "quiet" | "did not quiesce" | "no report" | null;
  dry: boolean;
  instance: { url: string; worktree: string; commit: string | null };
  folder: string;
  fixture: { tag: string; commit: string };
  prompt: string;
  projectId: string | null;
  roomId: string | null;
  crew: typeof CREW;
  seats: Seat[];
  /** Other T3 threads of the job: started by its seats (T3 subagent or delegated threads), found at close. */
  childThreads: string[];
  t3: { start: Record<string, unknown> | null; end: Record<string, unknown> | null };
  times: {
    createdAt: string;
    seatingStart: string | null;
    seatingEnd: string | null;
    postedAt: string | null;
    reportAt: string | null;
    /** T3's time of the report message (read when the board shows it); the board's reportAt lags it. */
    t3ReportAt?: string | null;
    reportObservedAt: string | null;
    quietSince: string | null;
    closeAt: string | null;
  };
  report: { postId: string; text: string } | null;
  snapshots: Snapshot[];
  /** T3 threads outside the job seen running while the window was open (sampled from T3's shell). */
  overlap: { samples: number; threads: string[] };
  spend: { campaignBefore: number; cap: number };
  /** Copies keep the files' modification times (from round 2 of R0's review on), so --verify can see later edits. */
  copiesKeepTimes?: boolean;
  notes: string[];
}

export const campaignDir = (campaign: string) => join(EVIDENCE_ROOT, campaign);
export const jobsDir = (campaign: string) => join(campaignDir(campaign), "jobs");

export function listJobs(campaign: string): Array<{ dir: string; job: JobRecord }> {
  const dir = jobsDir(campaign);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((name) => existsSync(join(dir, name, "job.json")))
    .map((name) => ({ dir: join(dir, name), job: JSON.parse(readFileSync(join(dir, name, "job.json"), "utf8")) as JobRecord }));
}

/** Every T3 thread a job's spend is counted on: its seats and the threads they started. */
export const jobThreads = (job: JobRecord): string[] => [...job.seats.map((s) => s.threadId), ...job.childThreads];

/**
 * The hard cap: before a job starts, the campaign's measured spend so far (every job, seating included, whatever its
 * outcome) is added up, and no job starts once it has reached the cap.
 */
export function capCheck(spentByJob: number[], cap: number): { spent: number; allowed: boolean } {
  const spent = spentByJob.reduce((sum, value) => sum + value, 0);
  return { spent, allowed: spent < cap };
}
