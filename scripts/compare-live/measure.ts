/**
 * Measures the comparison's jobs, both sides the same way, from T3's records of each job (copied into the job's
 * evidence folder at its close by run.ts): T3's thread details for runs and messages, T3's state-database rows for the
 * thread → session map, and the raw Claude transcripts for tokens (through ThreadCosts, src/usage/threadCosts.ts).
 * Never from either Backroom's tables.
 *
 * The job window runs from the user's post to the close (3 minutes of quiet after the report). Seating, before the
 * post, is measured apart. Per seat and per job: turns (T3 runs requested in the window), the Consigliere's wakes
 * (his runs minus the one the post started), tokens by kind with calls and list-price cost, peak context, the bytes
 * of every message T3 received per turn; until and after the report. Wall-clock to the report and to the checker's
 * first pass; correctness, premature reports, early member answers; other activity on T3 during the window.
 *
 *   node scripts/compare-live/measure.ts --campaign r0 [--verify]     report.json and report.md in the campaign folder
 *   node scripts/compare-live/measure.ts --campaign r0 --register-gate  writes scripts/compare-live/gate.json from R0
 *   node scripts/compare-live/measure.ts --campaign z1 --verdict        the Z1 verdict against gate.json
 *
 * --verify recounts independently and exits non-zero on any difference: tokens with rawsum.mjs (its own reader of the
 * same transcripts and state rows), turns with the sqlite3 CLI on the same state rows.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { ThreadCosts, type ThreadCost } from "../../src/usage/threadCosts.ts";
import { campaignDir, jobThreads, listJobs, type JobRecord, type Snapshot } from "./campaign.ts";
import { GATE_RULES, METRICS, chooseNK, spread, verdict, type Gate, type GateRun, type Metric } from "./gate.ts";
import { RATES, STATE_DB } from "./t3.ts";
import { FIXTURE_TEMPLATE } from "./checkers.ts";
import { TASK_IDS, hasJobDoneLine, type TaskId } from "./tasks.ts";

/** A thread as T3 recorded it, reduced to what is measured. */
export interface ThreadRecord {
  threadId: string;
  alias: string | null;
  role: string;
  source: "t3-http" | "fake-instance";
  runs: Array<{ id: string; requestedAt: string; startedAt: string | null; completedAt: string | null; status: string }>;
  messages: Array<{ id: string; role: string; runId: string | null; createdAt: string; text: string }>;
  subagents: Array<{ id: string; runId: string | null; status: string; startedAt: string | null; childThreadId: string | null }>;
  partial: boolean;
}

export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** All four kinds. */
  total: number;
  calls: number;
  costUsd: number;
}

export interface SeatMeasure {
  alias: string | null;
  role: string;
  threadId: string;
  seatingTurns: number;
  turns: number;
  turnsUntilReport: number;
  turnsAfterReport: number;
  /** Null on a dry run: a fake thread has no transcripts. */
  tokens: Tokens | null;
  tokensUntilReport: Tokens | null;
  tokensAfterReport: Tokens | null;
  seating: Tokens | null;
  /** The largest single call of the thread (its own calls, seating included). */
  peakContext: number | null;
  /** The bytes of the messages T3 received for each run in the window, in order. */
  briefingBytes: number[];
  subagentsStarted: number;
}

export interface JobMeasure {
  campaign: string;
  side: string;
  task: TaskId;
  run: number;
  jobId: string;
  dry: boolean;
  close: JobRecord["close"];
  t3: JobRecord["t3"];
  times: { postedAt: string; reportAt: string | null; boardReportAt: string | null; closeAt: string };
  metrics: Record<Metric, number | null>;
  wakesAfterReport: number;
  wallToFirstPassMs: number | null;
  correct: boolean;
  correctDetail: Record<string, boolean | string | null>;
  premature: boolean;
  earlyAnswers: Array<{ alias: string; at: string; failing: string[] }>;
  subagentRan: boolean;
  overlap: { sampled: string[]; stateDb: string[] | null };
  spend: { jobUsd: number; seatingUsd: number; totalUsd: number };
  tokensUntilReport: Tokens | null;
  tokensAfterReport: Tokens | null;
  briefing: { turns: number; bytes: number; crossCheck: { compared: number; equal: number } | null };
  seats: SeatMeasure[];
}

const ms = (time: string) => Date.parse(time);
const inWindow = (time: string, from: number, to: number) => ms(time) >= from && ms(time) <= to;

const tokensOf = (cost: ThreadCost): Tokens => ({
  input: cost.total.inputTokens,
  cacheRead: cost.total.cachedInputTokens,
  cacheWrite: cost.total.cacheWriteTokens,
  output: cost.total.outputTokens,
  total: cost.total.inputTokens + cost.total.cachedInputTokens + cost.total.cacheWriteTokens + cost.total.outputTokens,
  calls: cost.total.calls,
  costUsd: cost.total.costUsd,
});

const sum = (list: Array<Tokens | null>): Tokens | null => {
  if (list.some((t) => t === null)) return null;
  return (list as Tokens[]).reduce(
    (a, b) => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, total: a.total + b.total, calls: a.calls + b.calls, costUsd: a.costUsd + b.costUsd }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0, costUsd: 0 },
  );
};

/** The sources a job is measured from: its evidence copies. */
export function jobSources(dir: string) {
  return {
    stateDb: join(dir, "t3", "state-subset.sqlite"),
    transcripts: join(dir, "transcripts"),
    threads: join(dir, "t3", "threads.json"),
  };
}

const costsFor = (dir: string) => {
  const sources = jobSources(dir);
  return new ThreadCosts({ t3StateDb: sources.stateDb, ratesPath: RATES, claudeProjectsDir: sources.transcripts, codexSessionsDir: join(dir, "no-codex") });
};

/** The final message of each run: the last assistant message T3 recorded for it. */
function finals(record: ThreadRecord): Array<{ runId: string; at: string; text: string }> {
  const last = new Map<string, { runId: string; at: string; text: string }>();
  for (const message of record.messages) {
    if (message.role !== "assistant" || !message.runId || message.text.trim() === "") continue;
    const seen = last.get(message.runId);
    if (!seen || message.createdAt >= seen.at) last.set(message.runId, { runId: message.runId, at: message.createdAt, text: message.text });
  }
  return [...last.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** A premature report: the Consigliere's JOB-DONE report landed while the task's checker failed on the copy taken then. */
export const isPremature = (snapshots: Snapshot[]): boolean => snapshots.some((s) => s.kind === "report" && !s.check.pass);

/**
 * Member answers made while that member's own part of the checker failed on the copy taken then (reviewers: none).
 * T1's part is judged on the answer's text, so once a member has given the facts, its later answers are not early.
 */
export const earlyAnswersOf = (snapshots: Snapshot[], task: TaskId | null = null): JobMeasure["earlyAnswers"] => {
  const gaveFacts = new Set<string>();
  const out: JobMeasure["earlyAnswers"] = [];
  for (const s of [...snapshots].sort((a, b) => a.at.localeCompare(b.at))) {
    if (s.kind !== "answer" || !s.ownParts || s.ownParts.length === 0) continue;
    if (s.ownPass === true && task === "T1") gaveFacts.add(s.alias);
    if (s.ownPass !== false || gaveFacts.has(s.alias)) continue;
    const parts = s.ownParts;
    out.push({ alias: s.alias, at: s.at, failing: parts.filter((p) => s.check.parts[p]?.pass !== true) });
  }
  return out;
};

/**
 * Measure one closed job from its evidence folder. `liveStateDb` is T3's own database, read only for the other
 * threads that ran during the window (null skips it).
 */
export function measureJob(dir: string, options: { liveStateDb?: string | null } = {}): JobMeasure {
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
  const records = JSON.parse(readFileSync(jobSources(dir).threads, "utf8")) as ThreadRecord[];
  if (!job.times.postedAt || !job.times.closeAt) throw new Error(`${dir}: the job has no window`);
  const posted = ms(job.times.postedAt);
  const close = ms(job.times.closeAt);
  const consigliere = job.seats.find((s) => s.role === "C");
  const consigliereRecord = records.find((r) => r.threadId === consigliere?.threadId);

  // The report as T3 recorded it: the first final message of a Consigliere run in the window with a JOB-DONE line.
  // A dry run's fake cannot write one; its report is the one the runner named on the board.
  const t3Report = job.dry ? null : (finals(consigliereRecord as ThreadRecord).find((f) => ms(f.at) >= posted && hasJobDoneLine(f.text)) ?? null);
  const reportAt = job.dry ? job.times.reportAt : (t3Report?.at ?? null);
  const report = reportAt ? ms(reportAt) : null;

  const costs = job.dry ? null : costsFor(dir);
  const seats: SeatMeasure[] = records.map((record) => {
    const runs = record.runs.filter((r) => inWindow(r.requestedAt, posted, close));
    const briefingBytes = runs.map((run) =>
      record.messages.filter((m) => m.role === "user" && m.runId === run.id).reduce((total, m) => total + Buffer.byteLength(m.text, "utf8"), 0),
    );
    const between = (from: number, to: number) => (costs ? tokensOf(costs.costBetween([record.threadId], from, to)) : null);
    return {
      alias: record.alias,
      role: record.role,
      threadId: record.threadId,
      seatingTurns: record.runs.filter((r) => ms(r.requestedAt) < posted).length,
      turns: runs.length,
      turnsUntilReport: report === null ? runs.length : runs.filter((r) => ms(r.requestedAt) <= report).length,
      turnsAfterReport: report === null ? 0 : runs.filter((r) => ms(r.requestedAt) > report).length,
      tokens: between(posted, close),
      tokensUntilReport: between(posted, report ?? close),
      tokensAfterReport: report === null ? between(close + 1, close) : between(report + 1, close),
      seating: between(0, posted - 1),
      peakContext: costs ? costs.context([record.threadId], null).peak : null,
      briefingBytes,
      subagentsStarted: record.subagents.filter((s) => s.startedAt !== null && inWindow(s.startedAt, posted, close)).length,
    };
  });

  const seatOnly = seats.filter((s) => s.role !== "child");
  const consigliereSeat = seats.find((s) => s.role === "C");
  const wakes = Math.max(0, (consigliereSeat?.turns ?? 0) - 1);
  const consigliereRuns = consigliereRecord?.runs.filter((r) => inWindow(r.requestedAt, posted, close)) ?? [];
  const tokens = sum(seats.map((s) => s.tokens));

  // Correctness: the final copy's check (T2 also needs V's review before the report), and the report's own check.
  const final = job.snapshots.find((s) => s.kind === "final");
  const v = job.seats.find((s) => s.role === "V");
  const vRecord = records.find((r) => r.threadId === v?.threadId);
  const vAnswers = vRecord ? finals(vRecord).filter((f) => ms(f.at) >= posted) : [];
  const reviewBeforeReport = report !== null && vAnswers.some((f) => ms(f.at) < report);
  const w1 = records.find((r) => r.threadId === job.seats.find((s) => s.role === "W1")?.threadId);
  const firstReview = vAnswers[0] ? ms(vAnswers[0].at) : null;
  const correctionAfterReview = firstReview !== null && report !== null && (w1?.runs ?? []).some((r) => ms(r.requestedAt) > firstReview && r.completedAt !== null && ms(r.completedAt) < report);
  const correctDetail: JobMeasure["correctDetail"] = {
    report: reportAt !== null,
    finalCheck: final?.check.pass ?? false,
    ...(job.task === "T2" ? { reviewBeforeReport, correctionAfterReview } : {}),
    // Information: a slow-check made faster by editing it would not have been background work.
    ...(job.task === "T3" && final ? { slowCheckScriptChanged: changedFromTemplate(final.dir, "scripts/slow-check.mjs") } : {}),
    boardReportAt: job.times.reportAt,
  };
  const correct = reportAt !== null && (final?.check.pass ?? false) && (job.task !== "T2" || reviewBeforeReport);
  const premature = isPremature(job.snapshots);
  const earlyAnswers = earlyAnswersOf(job.snapshots, job.task);
  const firstPass = job.snapshots.filter((s) => s.kind !== "final" && s.check.pass).sort((a, b) => a.at.localeCompare(b.at))[0];

  const metrics: Record<Metric, number | null> = {
    wakes,
    tokens: tokens?.total ?? null,
    turns: seatOnly.reduce((total, s) => total + s.turns, 0),
    wallToReportMs: report === null ? null : report - posted,
  };
  const seatingUsd = seats.reduce((total, s) => total + (s.seating?.costUsd ?? 0), 0);
  const jobUsd = tokens?.costUsd ?? 0;
  const lifetime = costs ? tokensOf(costs.cost(jobThreads(job))).costUsd : 0;

  return {
    campaign: job.campaign,
    side: job.side,
    task: job.task,
    run: job.run,
    jobId: job.jobId,
    dry: job.dry,
    close: job.close,
    t3: job.t3,
    times: { postedAt: job.times.postedAt, reportAt, boardReportAt: job.times.reportAt, closeAt: job.times.closeAt },
    metrics,
    wakesAfterReport: report === null ? 0 : consigliereRuns.filter((r) => ms(r.requestedAt) > report).length,
    wallToFirstPassMs: firstPass ? ms(firstPass.at) - posted : null,
    correct,
    correctDetail,
    premature,
    earlyAnswers,
    subagentRan: seats.some((s) => s.subagentsStarted > 0) || job.childThreads.length > 0,
    overlap: { sampled: job.overlap.threads, stateDb: job.dry ? null : overlapFromStateDb(job, options.liveStateDb === undefined ? STATE_DB : options.liveStateDb) },
    // Lifetime equals seating + window when nothing ran after the close; the larger is what was spent.
    spend: { jobUsd, seatingUsd, totalUsd: Math.max(lifetime, jobUsd + seatingUsd) },
    tokensUntilReport: sum(seats.map((s) => s.tokensUntilReport)),
    tokensAfterReport: sum(seats.map((s) => s.tokensAfterReport)),
    briefing: { turns: seats.reduce((n, s) => n + s.briefingBytes.length, 0), bytes: seats.reduce((n, s) => n + s.briefingBytes.reduce((a, b) => a + b, 0), 0), crossCheck: briefingCrossCheck(dir, records) },
    seats,
  };
}

/** Whether a file of a job copy differs from the fixture's template (null when the copy has no such file). */
function changedFromTemplate(copy: string, file: string): boolean | null {
  const path = join(copy, file);
  if (!copy || !existsSync(path)) return null;
  return readFileSync(path, "utf8") !== readFileSync(join(FIXTURE_TEMPLATE, file), "utf8");
}

/** Other T3 threads with a run during the window, from T3's state database (the live one: its run rows stay). */
function overlapFromStateDb(job: JobRecord, stateDb: string | null): string[] | null {
  if (!stateDb || !existsSync(stateDb) || !job.times.postedAt || !job.times.closeAt) return null;
  const db = new DatabaseSync(stateDb, { readOnly: true });
  try {
    const mine = jobThreads(job);
    const rows = db
      .prepare(
        `SELECT DISTINCT r.thread_id AS id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
         WHERE r.requested_at <= ? AND COALESCE(r.completed_at, '9999') >= ? AND t.project_id != ? AND r.thread_id NOT IN (${mine.map(() => "?").join(", ")})`,
      )
      .all(job.times.closeAt, job.times.postedAt, job.projectId ?? "", ...mine) as Array<{ id: string }>;
    return rows.map((r) => r.id).sort();
  } finally {
    db.close();
  }
}

/** The instance's record of what it sent (old side: runs.briefing) against the message T3 received, byte for byte. */
function briefingCrossCheck(dir: string, records: ThreadRecord[]): { compared: number; equal: number } | null {
  const path = join(dir, "instance-room.json");
  if (!existsSync(path)) return null;
  const room = JSON.parse(readFileSync(path, "utf8")) as { runs?: Array<{ messageId?: string; briefing?: string }> };
  const messages = new Map(records.flatMap((r) => r.messages.filter((m) => m.role === "user").map((m) => [m.id, m.text] as const)));
  let compared = 0;
  let equal = 0;
  for (const run of room.runs ?? []) {
    const received = run.messageId ? messages.get(run.messageId) : undefined;
    if (received === undefined || typeof run.briefing !== "string" || run.briefing === "") continue;
    compared += 1;
    if (Buffer.byteLength(received) === Buffer.byteLength(run.briefing)) equal += 1;
  }
  return { compared, equal };
}

// ---------------- the accuracy check ----------------

interface Difference {
  job: string;
  what: string;
  measured: unknown;
  recounted: unknown;
}

/** rawsum.mjs for tokens and the sqlite3 CLI for turns, on the same evidence; every difference is listed. */
export function verifyJob(dir: string, measured: JobMeasure): Difference[] {
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
  const sources = jobSources(dir);
  const out: Difference[] = [];
  const name = `${job.side}-${job.task}-${job.run}-${job.jobId}`;
  const posted = job.times.postedAt as string;
  const close = job.times.closeAt as string;
  if (job.dry) {
    // A fake T3 has no state database or transcripts: the turn count is checked against the instance's own runs.
    const room = JSON.parse(readFileSync(join(dir, "instance-room.json"), "utf8")) as { runs: Array<{ threadId: string; t3RunId: string | null; createdAt: string }> };
    for (const seat of measured.seats) {
      const recount = new Set(room.runs.filter((r) => r.threadId === seat.threadId && r.t3RunId && r.createdAt >= posted && r.createdAt <= close).map((r) => r.t3RunId)).size;
      if (recount !== seat.turns) out.push({ job: name, what: `turns @${seat.alias}`, measured: seat.turns, recounted: recount });
    }
    return out;
  }
  // A message id counted once must not hide a second, different usage under the same id.
  for (const conflict of duplicateUsageConflicts(sources.transcripts)) out.push({ job: name, what: `message ${conflict.id} repeated with different usage in ${conflict.file}`, measured: conflict.first, recounted: conflict.other });
  const rawsum = join(import.meta.dirname, "rawsum.mjs");
  for (const seat of measured.seats) {
    const turns = Number(
      execFileSync("sqlite3", ["-readonly", sources.stateDb, `SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id = '${seat.threadId}' AND requested_at >= '${posted}' AND requested_at <= '${close}'`], { encoding: "utf8" }).trim(),
    );
    if (turns !== seat.turns) out.push({ job: name, what: `turns @${seat.alias ?? seat.threadId}`, measured: seat.turns, recounted: turns });
    const windows: Array<[string, Tokens | null, string[]]> = [
      ["job window", seat.tokens, [posted, close]],
      ["seating", seat.seating, ["", new Date(Date.parse(posted) - 1).toISOString()]],
    ];
    for (const [label, tokens, [from, to]] of windows) {
      const raw = JSON.parse(execFileSync(process.execPath, [rawsum, sources.stateDb, sources.transcripts, seat.threadId, from || "1970-01-01T00:00:00.000Z", to as string], { encoding: "utf8" })) as Record<string, number>;
      const mine = tokens ? { input: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, output: tokens.output } : null;
      const theirs = { input: raw.input, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite, output: raw.output };
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) out.push({ job: name, what: `tokens @${seat.alias ?? seat.threadId} (${label})`, measured: mine, recounted: theirs });
    }
  }
  return out;
}

/** Message ids that appear more than once in the job's transcripts with different usage figures. */
export function duplicateUsageConflicts(transcripts: string): Array<{ id: string; file: string; first: unknown; other: unknown }> {
  const seen = new Map<string, string>();
  const out: Array<{ id: string; file: string; first: unknown; other: unknown }> = [];
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".jsonl") ? [join(dir, e.name)] : [])) : [];
  for (const file of walk(transcripts)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let row: { message?: { id?: unknown; usage?: unknown } };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (typeof row.message?.id !== "string" || !row.message.usage) continue;
      const usage = JSON.stringify(row.message.usage);
      const first = seen.get(row.message.id);
      if (first === undefined) seen.set(row.message.id, usage);
      else if (first !== usage) out.push({ id: row.message.id, file, first: JSON.parse(first), other: row.message.usage });
    }
  }
  return out;
}

// ---------------- the report ----------------

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export const gateRun = (m: JobMeasure): GateRun => ({ task: m.task, side: m.side as GateRun["side"], correct: m.correct, premature: m.premature, metrics: m.metrics });

const fmt = (metric: Metric | string, value: number | null): string => {
  if (value === null) return "–";
  if (metric === "wallToReportMs" || metric === "wallToFirstPassMs") return `${(value / 60000).toFixed(1)} min`;
  if (metric === "tokens") return `${(value / 1000).toFixed(0)}k`;
  return String(value);
};

function reportMarkdown(campaign: string, measures: JobMeasure[], jobs: JobRecord[], differences: Difference[] | null): string {
  const lines: string[] = [];
  lines.push(`# Comparison campaign ${campaign}`, "", `Measured ${new Date().toISOString()} by scripts/compare-live/measure.ts from the evidence in ${campaignDir(campaign)}/jobs.`, "");
  if (differences) lines.push(`Accuracy check (\`--verify\`: rawsum.mjs for tokens, sqlite3 for turns): ${differences.length === 0 ? "**passed**, no difference" : `**${differences.length} differences**`}.`, "");
  lines.push("## Every run", "");
  lines.push("| job | side | task | run | close | correct | premature | wakes (after report) | turns | tokens | wall to report | wall to first pass | spend (job + seating) | T3 | overlap (sampled / state db) | subagent |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of measures) {
    const t3 = (m.t3.start as { serverVersion?: string } | null)?.serverVersion ?? "?";
    const t3End = (m.t3.end as { serverVersion?: string } | null)?.serverVersion ?? "?";
    lines.push(
      `| ${m.jobId} | ${m.side} | ${m.task} | ${m.run} | ${m.close} | ${m.correct ? "yes" : "**no**"} | ${m.premature ? "**yes**" : "no"} | ${m.metrics.wakes} (${m.wakesAfterReport}) | ${m.metrics.turns} | ${fmt("tokens", m.metrics.tokens)} | ${fmt("wallToReportMs", m.metrics.wallToReportMs)} | ${fmt("wallToFirstPassMs", m.wallToFirstPassMs)} | $${m.spend.jobUsd.toFixed(2)} + $${m.spend.seatingUsd.toFixed(2)} | ${t3 === t3End ? t3 : `${t3} → ${t3End}`} | ${m.overlap.sampled.length} / ${m.overlap.stateDb?.length ?? "–"} | ${m.subagentRan ? "yes" : "no"} |`,
    );
  }
  lines.push("", "## Medians and ranges per task and side", "");
  lines.push("| task | side | runs | correct | premature | wakes | turns | tokens | wall to report | spend per job |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const task of TASK_IDS) {
    for (const side of ["old", "new"]) {
      const group = measures.filter((m) => m.task === task && m.side === side);
      if (group.length === 0) continue;
      const cell = (metric: Metric) => {
        const values = group.map((m) => m.metrics[metric]).filter((v): v is number => v !== null);
        return values.length === 0 ? "–" : `${fmt(metric, median(values))} (${fmt(metric, Math.min(...values))}–${fmt(metric, Math.max(...values))})`;
      };
      const spend = group.map((m) => m.spend.totalUsd);
      lines.push(
        `| ${task} | ${side} | ${group.length} | ${group.filter((m) => m.correct).length} | ${group.filter((m) => m.premature).length} | ${cell("wakes")} | ${cell("turns")} | ${cell("tokens")} | ${cell("wallToReportMs")} | $${(median(spend) ?? 0).toFixed(2)} ($${Math.min(...spend).toFixed(2)}–$${Math.max(...spend).toFixed(2)}) |`,
      );
    }
  }
  for (const side of ["old", "new"] as const) {
    const group = measures.filter((m) => m.side === side && !m.dry);
    if (group.length === 0) continue;
    const bySpread = spread(group.map(gateRun));
    lines.push("", `## Run-to-run spread, ${side} side (max / min per task and metric)`, "", "| task | wakes | turns | tokens | wall to report |", "|---|---|---|---|---|");
    for (const [task, row] of Object.entries(bySpread)) lines.push(`| ${task} | ${row.wakes.toFixed(2)} | ${row.turns.toFixed(2)} | ${row.tokens.toFixed(2)} | ${row.wallToReportMs.toFixed(2)} |`);
    const nk = chooseNK(bySpread);
    lines.push("", `Tasks with a spread above 1.5× on tokens or wall-clock: ${nk.wideTasks.length === 0 ? "none" : nk.wideTasks.join(", ")}. The plan's rule gives **N = ${nk.N}, K = ${nk.K}** for Z1.`);
    const spend = group.map((m) => m.spend.totalUsd);
    lines.push("", `Spend, ${side} side: $${spend.reduce((a, b) => a + b, 0).toFixed(2)} over ${group.length} jobs; per job median $${(median(spend) ?? 0).toFixed(2)}, range $${Math.min(...spend).toFixed(2)}–$${Math.max(...spend).toFixed(2)} (list price, seating included).`);
  }
  lines.push("", "## Until and after the report", "", "| job | wakes after | turns until / after | tokens until / after | briefings: turns, bytes | briefing cross-check (equal / compared) | early member answers |", "|---|---|---|---|---|---|---|");
  for (const m of measures) {
    const turnsUntil = m.seats.reduce((n, s) => n + s.turnsUntilReport, 0);
    const turnsAfter = m.seats.reduce((n, s) => n + s.turnsAfterReport, 0);
    lines.push(
      `| ${m.jobId} | ${m.wakesAfterReport} | ${turnsUntil} / ${turnsAfter} | ${fmt("tokens", m.tokensUntilReport?.total ?? null)} / ${fmt("tokens", m.tokensAfterReport?.total ?? null)} | ${m.briefing.turns}, ${m.briefing.bytes} | ${m.briefing.crossCheck ? `${m.briefing.crossCheck.equal} / ${m.briefing.crossCheck.compared}` : "–"} | ${m.earlyAnswers.length === 0 ? "none" : m.earlyAnswers.map((a) => `@${a.alias} ${a.at.slice(11, 19)} (${a.failing.join(", ")})`).join("; ")} |`,
    );
  }
  lines.push("", "## Per seat", "", "| job | seat | seating turns | turns (until / after) | input | cache read | cache write | output | calls | cost | peak context | briefing bytes per turn |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of measures) {
    for (const s of m.seats) {
      const t = s.tokens;
      lines.push(
        `| ${m.jobId} | ${s.role}${s.alias ? ` @${s.alias}` : ""} | ${s.seatingTurns} | ${s.turns} (${s.turnsUntilReport} / ${s.turnsAfterReport}) | ${t?.input ?? "–"} | ${t?.cacheRead ?? "–"} | ${t?.cacheWrite ?? "–"} | ${t?.output ?? "–"} | ${t?.calls ?? "–"} | ${t ? `$${t.costUsd.toFixed(2)}` : "–"} | ${s.peakContext ?? "–"} | ${s.briefingBytes.join(", ")} |`,
      );
    }
  }
  lines.push("", "## Throwaway T3 projects and rooms", "", "Delete after the campaign, with the user's OK.", "", "| job | side | T3 project | folder | room |", "|---|---|---|---|---|");
  for (const job of jobs) lines.push(`| ${job.jobId} | ${job.side} | ${job.projectId ?? "–"} | ${job.folder} | ${job.roomId ?? "–"} on ${job.instance.url} |`);
  if (differences && differences.length > 0) {
    lines.push("", "## Accuracy differences", "");
    for (const d of differences) lines.push(`- ${d.job} ${d.what}: measured ${JSON.stringify(d.measured)}, recounted ${JSON.stringify(d.recounted)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { campaign: { type: "string" }, verify: { type: "boolean", default: false }, verdict: { type: "boolean", default: false }, "register-gate": { type: "boolean", default: false } } });
  const campaign = values.campaign;
  if (!campaign) throw new Error("usage: measure.ts --campaign <name> [--verify] [--verdict] [--register-gate]");
  const jobs = listJobs(campaign).filter(({ job }) => job.status === "closed");
  const measures = jobs.map(({ dir }) => measureJob(dir));
  for (const [index, { dir }] of jobs.entries()) writeFileSync(join(dir, "measure.json"), `${JSON.stringify(measures[index], null, 2)}\n`);
  const differences = values.verify ? jobs.flatMap(({ dir }, index) => verifyJob(dir, measures[index] as JobMeasure)) : null;
  const out = campaignDir(campaign);
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ measuredAt: new Date().toISOString(), measures, differences }, null, 2)}\n`);
  writeFileSync(join(out, "report.md"), reportMarkdown(campaign, measures, jobs.map((j) => j.job), differences));
  console.log(`${measures.length} jobs measured; ${join(out, "report.md")}`);

  if (values["register-gate"]) {
    const path = join(import.meta.dirname, "gate.json");
    if (existsSync(path)) throw new Error(`${path} is registered already`);
    if (measures.some((m) => m.side === "new")) throw new Error("the gate is registered before any new-side job");
    const old = measures.filter((m) => m.side === "old" && !m.dry);
    const bySpread = spread(old.map(gateRun));
    const { N, K, wideTasks } = chooseNK(bySpread);
    const spend = old.map((m) => m.spend.totalUsd);
    const gate = {
      registeredAt: new Date().toISOString(),
      item: "Z1 (plan stage45-plan.md), registered by R0",
      ...GATE_RULES,
      N,
      K,
      definitions: {
        better: "every new run strictly below every old run on the metric (smaller is better); worse the other way round; ties, 0 against 0 included, are neither",
        wakes: "the Consigliere's T3 runs requested in the job window, minus the one the user's post started; after-report wakes included",
        tokens: "input + cache read + cache write + output over the job window, every job thread, subagents included",
        turns: "T3 runs requested in the job window on the seats' threads",
        wallToReportMs: "from the user's post to the first final message of a Consigliere run with a JOB-DONE line; a job without one has the worst value",
        G1: "on every task, new correct runs >= old correct runs and new premature reports <= old premature reports",
        G2: "on at least one primary metric, better on K or more of the 4 tasks",
        G3: "on no metric, primary or secondary, worse on K or more tasks; and no task with a material regression",
        chance: "exhaustive relabelling within each task; PASS needs chance-pass <= chancePassTarget",
      },
      fromR0: { campaign, jobs: old.length, spread: bySpread, wideTasks, medianJobUsd: median(spend), z1CapUsd: Math.min(250, 1.5 * 4 * 2 * N * (median(spend) ?? 0)) },
    };
    writeFileSync(path, `${JSON.stringify(gate, null, 2)}\n`);
    console.log(`gate.json registered: N = ${N}, K = ${K}`);
  }

  if (values.verdict) {
    const gate = JSON.parse(readFileSync(join(import.meta.dirname, "gate.json"), "utf8")) as Gate;
    const result = verdict(gate, measures.filter((m) => !m.dry).map(gateRun));
    const lines = [`# Z1 verdict: ${result.verdict}`, "", `chance-pass ${(result.chance.chancePass * 100).toFixed(2)}% (target ${gate.chancePassTarget * 100}%), chance-G3-fail ${(result.chance.chanceG3Fail * 100).toFixed(2)}%, over ${result.chance.labellings} labellings; N = ${gate.N}, K = ${gate.K}.`, "", `G1 ${result.evaluation.g1}, G2 ${result.evaluation.g2}, G3 ${result.evaluation.g3}.`, "", "| task | correct old/new | premature old/new | " + METRICS.join(" | ") + " | material |", "|---|---|---|" + METRICS.map(() => "---|").join("") + "---|"];
    for (const [task, row] of Object.entries(result.evaluation.perTask)) lines.push(`| ${task} | ${row.correct.old}/${row.correct.new} | ${row.premature.old}/${row.premature.new} | ${METRICS.map((m) => row.cells[m]).join(" | ")} | ${row.material.join(", ") || "none"} |`);
    writeFileSync(join(out, "verdict.md"), `${lines.join("\n")}\n\nEvery run's numbers are in report.md beside this file.\n`);
    console.log(`verdict: ${result.verdict}`);
    if (result.verdict !== "PASS") process.exitCode = 1;
  }
  if (differences && differences.length > 0) {
    for (const d of differences) console.error(`difference: ${d.job} ${d.what}: measured ${JSON.stringify(d.measured)}, recounted ${JSON.stringify(d.recounted)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
