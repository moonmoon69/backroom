/**
 * What verdict.md carries beside the gate (plan stage45, Z1 "Check" and "Behaviour checks on the new side"): the rules
 * each side delivered with their diff, the briefing bytes per delivered turn, the behaviour checks on the new side, and
 * every run's numbers (report.md, embedded). Reporting only: it reads the job records, their evidence and the measures
 * measure.ts made, and nothing here feeds the gate, the measurement, the quiet rule or the checkers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EnginePost } from "../../src/domain/engineView.ts";
import type { JobRecord, Snapshot } from "./campaign.ts";
import type { JobMeasure } from "./measure.ts";
import { TASK_IDS } from "./tasks.ts";
import { TranscriptTokens } from "./tokens.ts";

/** A job's instance-room.json, reduced to what is read here (old side: bindings and runs.briefing; new side: the read API). */
export interface RoomRecord {
  engine?: boolean;
  seats?: Array<{ seatId: string; participantId: string | null; alias: string | null }>;
  bindings?: Array<{ id: string; participantId: string }>;
  runs?: Array<{ id: string; seatId?: string; bindingId?: string; briefing?: string | null; createdAt?: string; reservedSeq?: number; through?: number; inputs?: number[]; requestIds?: string[]; startedAt?: string | null; endedAt?: string | null }>;
  posts?: EnginePost[];
}

export interface VerdictJob {
  job: JobRecord;
  measure: JobMeasure;
  room: RoomRecord | null;
  /** The background work each member (by role: W1, V, W2) started in T3 in the job window, from its transcripts (backgroundWorkOf); null when not read. */
  background?: Record<string, BackgroundTask[]> | null;
}

/** A closed job's record, measure and instance-room.json, and each member's background work from its transcripts. */
export function loadVerdictJob(dir: string, measure: JobMeasure): VerdictJob {
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
  const path = join(dir, "instance-room.json");
  const window = job.times.postedAt && job.times.closeAt ? ([Date.parse(job.times.postedAt), Date.parse(job.times.closeAt)] as const) : null;
  return {
    job,
    measure,
    room: existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RoomRecord) : null,
    background: window && !job.dry ? Object.fromEntries(job.seats.filter((s) => s.role !== "C").map((s) => [s.role, backgroundWorkOf(dir, s.threadId, window[0], window[1])])) : null,
  };
}

/** A piece of background work a member started in T3: when, and when T3's harness reported it ended (null: never). */
export interface BackgroundTask {
  id: string;
  what: string;
  startedAt: number;
  endedAt: number | null;
  status: string | null;
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const describeTask = (t: BackgroundTask) => `${t.what} ${clock(t.startedAt)}–${t.endedAt === null ? "no end recorded" : `${clock(t.endedAt)} ${t.status}`}`;

function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? jsonlUnder(join(dir, name)) : name.endsWith(".jsonl") ? [join(dir, name)] : []));
}

/**
 * The background work a thread started in T3 between `from` and `to`, from T3's side of the evidence: its Claude
 * sessions (the job's copy of T3's state rows) and their transcripts with their subagents' (the job's copies). A Bash
 * call with run_in_background, a Monitor, or a subagent (Agent or Task) with run_in_background; once per tool call. Its
 * end is the first task-notification that names the tool call with a final status (completed, failed, killed, …).
 */
export function backgroundWorkOf(dir: string, threadId: string, from: number, to: number): BackgroundTask[] {
  const projectsDir = join(dir, "transcripts");
  const stateDb = join(dir, "t3", "state-subset.sqlite");
  if (!existsSync(stateDb)) return [];
  const sessions = new TranscriptTokens({ stateDb, projectsDir, ratesPath: join(dir, "no-rates") }).sessions(threadId);
  const projects = existsSync(projectsDir) ? readdirSync(projectsDir).sort() : [];
  const tasks = new Map<string, BackgroundTask>();
  const ends = new Map<string, { at: number; status: string }>();
  for (const session of sessions) {
    for (const project of projects) {
      const own = join(projectsDir, project, `${session}.jsonl`);
      for (const file of [...(existsSync(own) ? [own] : []), ...jsonlUnder(join(projectsDir, project, session))]) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const isUse = line.includes('"tool_use"');
          const isEnd = line.includes("<task-notification>");
          if (!isUse && !isEnd) continue;
          let row: { timestamp?: unknown; message?: { content?: unknown } };
          try {
            row = JSON.parse(line) as typeof row;
          } catch {
            continue;
          }
          const at = Date.parse(String(row.timestamp));
          if (Number.isNaN(at)) continue;
          if (isEnd) {
            for (const match of line.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([a-z_]+)<\/status>/g)) {
              const [id, status] = [match[1] as string, match[2] as string];
              if (status === "running" || status === "pending") continue;
              const seen = ends.get(id);
              if (!seen || at < seen.at) ends.set(id, { at, status });
            }
          }
          if (!isUse || at < from || at > to || !Array.isArray(row.message?.content)) continue;
          for (const block of row.message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: Record<string, unknown> }>) {
            if (block.type !== "tool_use" || typeof block.id !== "string" || tasks.has(block.id)) continue;
            const background = block.input?.run_in_background === true;
            const what =
              block.name === "Bash" && background ? `background Bash "${String(block.input?.command ?? "").slice(0, 60)}"`
              : block.name === "Monitor" ? "Monitor"
              : (block.name === "Agent" || block.name === "Task") && background ? `background subagent "${String(block.input?.description ?? "").slice(0, 60)}"`
              : null;
            if (what) tasks.set(block.id, { id: block.id, what, startedAt: at, endedAt: null, status: null });
          }
        }
      }
    }
  }
  return [...tasks.values()]
    .map((t) => ({ ...t, endedAt: ends.get(t.id)?.at ?? null, status: ends.get(t.id)?.status ?? null }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const range = (values: number[], digits = 0): string => {
  if (values.length === 0) return "–";
  const f = (v: number) => v.toFixed(digits);
  return `${f(median(values) as number)} (${f(Math.min(...values))}–${f(Math.max(...values))})`;
};

// ---------------- the rules each side delivered ----------------

/** A briefing's standing part: everything before its first section of room content (only "Where everyone works" is kept). */
export function standingPart(briefing: string): string {
  const out: string[] = [];
  for (const line of briefing.split("\n")) {
    if (line.startsWith("== ") && line !== "== Where everyone works ==") break;
    out.push(line);
  }
  return out.join("\n").trimEnd();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Job-specific text out: the job's id as <job>, a board key's room suffix as <room>, a list of the job's aliases as @<crew>. */
export function normalizeRules(text: string, job: Pick<JobRecord, "jobId" | "seats">): string {
  let out = text.split(job.jobId).join("<job>");
  out = out.replace(/(--as [A-Za-z0-9_-]+)\.[0-9a-f]{8}\b/g, "$1.<room>");
  const aliases = job.seats.map((s) => s.alias).filter((a) => a !== "").map(escape).join("|");
  if (aliases) out = out.replace(new RegExp(`@(?:${aliases})\\b(?:, @(?:${aliases})\\b)*`, "g"), "@<crew>");
  return out;
}

/** The role (C, W1, V, W2) of the seat an instance run woke. */
function roleOfRun(job: JobRecord, room: RoomRecord, run: NonNullable<RoomRecord["runs"]>[number]): string | null {
  const participantId = room.engine
    ? (room.seats ?? []).find((s) => s.seatId === run.seatId)?.participantId
    : (room.bindings ?? []).find((b) => b.id === run.bindingId)?.participantId;
  return job.seats.find((s) => s.participantId === participantId)?.role ?? null;
}

/** The briefings an instance sent one role, in the order it sent them. */
function briefingsOf(job: JobRecord, room: RoomRecord, role: string): string[] {
  const runs = (room.runs ?? []).filter((run) => typeof run.briefing === "string" && run.briefing !== "" && roleOfRun(job, room, run) === role);
  runs.sort((a, b) => (room.engine ? (a.reservedSeq ?? 0) - (b.reservedSeq ?? 0) : (a.createdAt ?? "").localeCompare(b.createdAt ?? "")));
  return runs.map((run) => run.briefing as string);
}

/**
 * The rules a job's instance delivered, as it recorded sending them (the briefing cross-check holds them byte-equal to
 * what T3 received): the Consigliere's first briefing that carries his rules, its standing part; W1's first briefing,
 * the seat briefing, whole. Normalised (normalizeRules).
 */
export function rulesOf(job: JobRecord, room: RoomRecord): { consigliere: string | null; member: string | null } {
  const consigliere = briefingsOf(job, room, "C").find((b) => b.includes("Rules for the Consigliere:")) ?? null;
  const member = briefingsOf(job, room, "W1")[0] ?? null;
  return {
    consigliere: consigliere === null ? null : normalizeRules(standingPart(consigliere), job),
    member: member === null ? null : normalizeRules(member.trimEnd(), job),
  };
}

/** A line diff (longest common subsequence), changed lines with `context` lines around them, the rest elided. */
export function lineDiff(a: string, b: string, labels: [string, string], context = 2): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      ops.push({ op: " ", line: x[i] as string });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ op: "-", line: x[i++] as string });
    else ops.push({ op: "+", line: y[j++] as string });
  }
  while (i < x.length) ops.push({ op: "-", line: x[i++] as string });
  while (j < y.length) ops.push({ op: "+", line: y[j++] as string });
  if (ops.every((o) => o.op === " ")) return "";
  const keep = ops.map((_, k) => ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o.op !== " "));
  const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  let skipped = 0;
  const elide = () => {
    if (skipped > 0) out.push(`@@ ${skipped} unchanged line${skipped === 1 ? "" : "s"} @@`);
    skipped = 0;
  };
  for (const [k, o] of ops.entries()) {
    if (!keep[k]) {
      skipped += 1;
      continue;
    }
    elide();
    out.push(`${o.op}${o.line}`);
  }
  elide();
  return out.join("\n");
}

/** Each side's rules over its jobs: the variants (normally one) and the jobs that delivered each. */
function rulesBySide(jobs: VerdictJob[], which: "consigliere" | "member"): Record<"old" | "new", Array<{ text: string; jobs: string[] }>> {
  const out: Record<"old" | "new", Array<{ text: string; jobs: string[] }>> = { old: [], new: [] };
  for (const { job, room } of jobs) {
    if (!room || (job.side !== "old" && job.side !== "new")) continue;
    const text = rulesOf(job, room)[which];
    if (text === null) continue;
    const variant = out[job.side].find((v) => v.text === text);
    if (variant) variant.jobs.push(job.jobId);
    else out[job.side].push({ text, jobs: [job.jobId] });
  }
  for (const side of ["old", "new"] as const) out[side].sort((a, b) => b.jobs.length - a.jobs.length);
  return out;
}

export function rulesSection(jobs: VerdictJob[]): string[] {
  const lines = [
    "## The rules each side delivered, and their diff",
    "",
    "From each job's own record of what its instance sent (old side: `runs.briefing`; new side: each host run's frozen briefing), which the briefing cross-check holds byte-equal to what T3 received: the Consigliere's first briefing that carries his rules, up to its first section of room content (shared messages or the assignment; \"Where everyone works\" is kept), and W1's seat briefing, whole. Job-specific text is normalised: the job's id as `<job>`, the board key's room suffix as `<room>`, a list of the job's aliases as `@<crew>`. The prompts are byte-identical on both sides and are not part of this text.",
    "",
    "| text | side | bytes (normalised) | variants over the side's jobs |",
    "|---|---|---|---|",
  ];
  const diffs: string[] = [];
  for (const [which, label] of [["consigliere", "the Consigliere's rules"], ["member", "a member's seat briefing (W1)"]] as const) {
    const bySide = rulesBySide(jobs, which);
    for (const side of ["old", "new"] as const) {
      const variants = bySide[side];
      lines.push(`| ${label} | ${side} | ${variants[0] ? Buffer.byteLength(variants[0].text, "utf8") : "–"} | ${variants.length === 0 ? "none recorded" : variants.map((v) => `${v.jobs.length} job${v.jobs.length === 1 ? "" : "s"}`).join(", ")} |`);
    }
    const [oldText, newText] = [bySide.old[0]?.text, bySide.new[0]?.text];
    diffs.push("", `### Diff of ${label}, old → new${bySide.old.length > 1 || bySide.new.length > 1 ? " (each side's most frequent variant)" : ""}`, "");
    if (oldText === undefined || newText === undefined) diffs.push("Not recorded on both sides.");
    else {
      const diff = lineDiff(oldText, newText, [`old (${bySide.old[0]?.jobs[0]})`, `new (${bySide.new[0]?.jobs[0]})`]);
      diffs.push(diff === "" ? "Identical." : ["```diff", diff, "```"].join("\n"));
    }
    for (const side of ["old", "new"] as const) {
      for (const variant of bySide[side].slice(1)) {
        diffs.push("", `Another ${side}-side variant (jobs ${variant.jobs.join(", ")}), against the most frequent:`, "", "```diff", lineDiff(bySide[side][0]?.text ?? "", variant.text, [`${side} (${bySide[side][0]?.jobs[0]})`, `${side} (${variant.jobs[0]})`]), "```");
      }
    }
  }
  return [...lines, ...diffs];
}

// ---------------- briefing bytes per delivered turn ----------------

const MEMBER_ROLES = ["W1", "V", "W2"];

/** Per task and side: the bytes of the messages T3 received per turn in the window (measure.ts's briefingBytes), by seat kind. */
export function briefingSection(jobs: VerdictJob[]): string[] {
  const lines = [
    "## Briefing bytes per delivered turn",
    "",
    "The bytes of the user messages T3 received for each run in the job window (measure.ts, `briefingBytes`), per job: all seats, the Consigliere's turns, and the members' turns (W1, V, W2; threads the seats started count under all seats only). Median (range) over the task's jobs on each side. Fewer turns with the same text per turn is a gain from fewer wakes; the same turns with less text per turn is a gain from shorter briefings.",
    "",
    "| task | side | jobs | turns per job | bytes per job | bytes per turn | Consigliere bytes per turn | members' bytes per turn |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const perTurn = (bytes: number[]) => (bytes.length === 0 ? null : bytes.reduce((a, b) => a + b, 0) / bytes.length);
  for (const task of TASK_IDS) {
    for (const side of ["old", "new"] as const) {
      const group = jobs.filter(({ measure }) => measure.task === task && measure.side === side).map(({ measure }) => measure);
      if (group.length === 0) continue;
      const of = (pick: (s: JobMeasure["seats"][number]) => boolean) => group.map((m) => perTurn(m.seats.filter(pick).flatMap((s) => s.briefingBytes))).filter((v): v is number => v !== null);
      lines.push(
        `| ${task} | ${side} | ${group.length} | ${range(group.map((m) => m.briefing.turns))} | ${range(group.map((m) => m.briefing.bytes))} | ${range(of(() => true))} | ${range(of((s) => s.role === "C"))} | ${range(of((s) => MEMBER_ROLES.includes(s.role)))} |`,
      );
    }
  }
  return lines;
}

// ---------------- behaviour checks on the new side ----------------

export type CheckOutcome = "pass" | "FAIL" | "n/a";

export interface BehaviourCheck {
  id: string;
  outcome: CheckOutcome;
  /** Shown beside the outcome in the table. */
  note?: string;
  evidence: string;
}

/** The plan's behaviour checks (Z1), in its order. */
export const BEHAVIOUR_CHECKS: Array<{ id: string; title: string }> = [
  { id: "plainFinal", title: "a plain final answered its request (every request of the job closed, at least one by a run's final)" },
  { id: "backgroundHeld", title: "T3 background work held the request until it ended (any member, any task; on T3 also W1's slow-check log; n/a where no transcript shows background work)" },
  { id: "earlyReview", title: "an early review was not skipped (T2, §1 case 7)" },
  { id: "consigliereHeld", title: "the review exchange held the Consigliere (T2, §1 case 2: a review under a worker's request)" },
  { id: "subagentClean", title: "subagent use left no stuck state (T1; n/a where no subagent ran)" },
  { id: "quiet", title: "the job went quiet within 30 minutes of its report" },
  { id: "noEarlyAnswer", title: "no member answered (closed a request) while its own part of the checker failed" },
  { id: "noUnresolved", title: "no seat ended with an unresolved run or a pending activity" },
];

/**
 * The behaviour checks on one new-side job, from its journal as the read API showed it at the close (instance-room.json),
 * the runner's copies (job.json snapshots) and measure.ts's measure. The job's part of the journal starts at the user's
 * prompt. A failure is a defect for the runtime unless its classification (by hand, from the board and transcript)
 * finds an agent cause.
 */
export function behaviourChecks({ job, measure, room, background }: VerdictJob): BehaviourCheck[] {
  const posts = room?.posts ?? [];
  const runs = room?.runs ?? [];
  const roleOfSeat = new Map((room?.seats ?? []).map((s) => [s.seatId, job.seats.find((j) => j.participantId === s.participantId)?.role ?? "?"] as const));
  const promptIds = new Set(job.message?.requestIds ?? []);
  const promptSeq = Math.min(...posts.filter((p) => p.kind === "request" && promptIds.has(p.id)).map((p) => p.seq));
  const inJob = Number.isFinite(promptSeq) ? posts.filter((p) => p.seq >= promptSeq) : [];
  const bySeq = new Map(posts.map((p) => [p.seq, p] as const));
  const requests = inJob.filter((p) => p.kind === "request" && p.request);
  const requestById = new Map(requests.map((p) => [p.id, p] as const));
  const runById = new Map(runs.map((r) => [r.id, r] as const));
  const role = (seat: string) => (seat.startsWith("$") ? seat : (roleOfSeat.get(seat) ?? "?"));
  const answerPost = (q: EnginePost) => (q.request?.answer ? bySeq.get(q.request.answer.seq) : undefined);
  const describe = (p: EnginePost | undefined) => (p ? `#${p.number}${p.output ? ` (${p.output.source})` : ` (${p.kind})`}` : "none");
  const snapshotOf = (p: EnginePost | undefined): Snapshot | undefined => (p ? job.snapshots.find((s) => s.postId === p.id) : undefined);
  const out: BehaviourCheck[] = [];
  const add = (id: string, outcome: CheckOutcome, evidence: string, note?: string) => out.push({ id, outcome, evidence, ...(note ? { note } : {}) });

  if (!room?.engine || !Number.isFinite(promptSeq)) {
    for (const check of BEHAVIOUR_CHECKS) add(check.id, "FAIL", room?.engine ? "the prompt's request is not on the recorded journal" : "no journal recorded for the job");
    return out;
  }

  // 1. Every request of the job closed; how each was answered.
  const how = new Map<string, number>();
  const open: string[] = [];
  for (const q of requests) {
    const state = q.request?.state;
    if (state === "open") open.push(`#${q.number} @${role(q.request?.owner ?? "")}`);
    const key = state === "answered" ? `answered by ${answerPost(q)?.output?.source ?? answerPost(q)?.kind ?? "?"}` : (state ?? "?");
    how.set(key, (how.get(key) ?? 0) + 1);
  }
  const byFinal = how.get("answered by final") ?? 0;
  add("plainFinal", open.length === 0 && byFinal > 0 ? "pass" : "FAIL", `${requests.length} requests: ${[...how].map(([k, n]) => `${n} ${k}`).join(", ")}${open.length ? `; open at the close: ${open.join(", ")}` : ""}`);

  // 2. Background work (every task; T3 is where it is expected). A member's background work in T3 (its transcripts say
  // so, not the runtime) started between the first run that carried one of its requests and that request's answer
  // (continuations included) must have ended, by T3's own record, before the answer; on T3, W1's requests also only once the slow-check had ended (the copy at its answer: the
  // last run finished; anything else, a missing log included, is not ended). Which hold kept each open, if any.
  const tasksOf = (r: string) => background?.[r] ?? [];
  const members = ["W1", "V", "W2"].filter((r) => tasksOf(r).length > 0);
  if (members.length === 0) add("backgroundHeld", "n/a", `no member started background work in T3 (no background Bash, Monitor or background subagent in the members' transcripts${background ? "" : "; none read"})`);
  else {
    const answerAt = (p: EnginePost | undefined) => (p ? (p.at ? Date.parse(p.at) : snapshotOf(p) ? Date.parse((snapshotOf(p) as Snapshot).at) : p.after ? Date.parse(p.after) : null) : null);
    const judged: Array<{ ok: boolean; unsure: boolean; text: string }> = [];
    const holds: string[] = [];
    let runtimeHeld = false;
    let memberHeld = false;
    for (const r of members) {
      const own = requests.filter((q) => role(q.request?.owner ?? "") === r);
      const mine = (p: EnginePost) => role(p.author) === r;
      const bg = [...new Set(inJob.filter((p) => mine(p) && p.output?.activityId?.startsWith("bg:")).map((p) => `${p.output?.activityId} settled by ${describe(p)}`))];
      const marks = inJob.filter((p) => mine(p) && ((p.kind === "progress" && p.progress?.working) || p.output?.activityId?.startsWith("work:")));
      const pending = inJob.filter((p) => mine(p) && p.output?.claims.some((c) => c.outcome === "pending_activity" && own.some((q) => q.id === c.requestId)));
      runtimeHeld ||= bg.length > 0;
      memberHeld ||= marks.length > 0;
      const held = [bg.length ? `runtime hold ${bg.join(", ")}` : "", marks.length ? `member's working mark ${marks.map((p) => (p.output?.activityId ? `${p.output.activityId} via ${describe(p)}` : describe(p))).join(", ")}` : "", pending.length ? `pending_activity claims ${pending.map(describe).join(", ")}` : ""].filter(Boolean);
      holds.push(`@${r}: ${tasksOf(r).map(describeTask).join(", ")}; holds: ${held.join("; ") || "none"}`);
      for (const q of own) {
        const carriers = runs.filter((run) => role(run.seatId ?? "") === r && run.startedAt && ((run.requestIds ?? []).includes(q.id) || (run.inputs ?? []).includes(q.seq)));
        const answer = answerPost(q);
        const at = answerAt(answer);
        // From the first run that carried it to its answer: background work started there, continuations included.
        const from = Math.min(...carriers.map((run) => Date.parse(run.startedAt as string)));
        const started = tasksOf(r).filter((t) => t.startedAt >= from && t.startedAt <= (at ?? Number.POSITIVE_INFINITY));
        const slowCheck = r === "W1" && job.task === "T3";
        if (started.length === 0 && !slowCheck) continue;
        const unended = started.filter((t) => t.endedAt === null || at === null || at < t.endedAt);
        // Another request of the member open meanwhile: its background work may be that request's, so a failure is for the hand classification.
        const firstSeq = Math.min(...carriers.map((run) => run.reservedSeq ?? Number.POSITIVE_INFINITY));
        const meanwhile = own.filter((o) => o !== q && o.seq < (answer?.seq ?? Number.POSITIVE_INFINITY) && (answerPost(o)?.seq ?? Number.POSITIVE_INFINITY) > firstSeq);
        const log = slowCheck ? snapshotOf(answer)?.check.parts.slowCheckLog : undefined;
        const logEnded = !slowCheck || (log !== undefined && (log.pass || /^the last run \(pid [^)]*\) failed$/.test(log.detail ?? "")));
        const parts = [
          started.length ? `${started.length - unended.length} of ${started.length} background task${started.length === 1 ? "" : "s"} started in its runs had ended` : "",
          slowCheck ? `the slow-check ${logEnded ? "had ended" : "had not ended"} (${log ? log.detail : "no copy of the answer"})` : "",
        ].filter(Boolean);
        const ok = answer !== undefined && unended.length === 0 && logEnded;
        const unsure = !ok && meanwhile.length > 0 && answer !== undefined && logEnded;
        judged.push({ ok, unsure, text: `@${r}'s #${q.number} answered by ${describe(answer)}${at === null ? "" : ` at ${clock(at)}`}: ${answer === undefined ? "never answered" : parts.join("; ")}${unsure ? ` (another request of @${r} open meanwhile: ${meanwhile.map((o) => `#${o.number}`).join(", ")}; to classify by hand)` : ""}` });
      }
    }
    if (judged.length === 0) add("backgroundHeld", "n/a", `background work outside the runs that carried a request: ${holds.join(" | ")}`);
    else {
      const failed = judged.filter((j) => !j.ok);
      const hold = runtimeHeld ? "runtime hold" : memberHeld ? "member's mark only" : "no hold";
      add("backgroundHeld", failed.length === 0 ? "pass" : "FAIL", `${holds.join(" | ")}; ${judged.map((j) => j.text).join("; ")}`, failed.length > 0 && failed.every((j) => j.unsure) ? `${hold}; to classify by hand` : hold);
    }
  }

  // Review requests: owned by V, and the request each one holds (its parent when a worker asked; itself when the Consigliere did).
  const reviews = requests.filter((q) => role(q.request?.owner ?? "") === "V");
  const holder = (r: EnginePost) => {
    const parent = r.request?.parentId ? requestById.get(r.request.parentId) : undefined;
    return parent && role(parent.request?.owner ?? "") !== "C" ? parent : r;
  };

  // 3. T2, §1 case 7: a worker's request is answered only by a run that had V's answer to its review.
  if (job.task !== "T2") add("earlyReview", "n/a", "not T2");
  else {
    const underWorker = reviews.filter((r) => holder(r) !== r);
    if (underWorker.length === 0) add("earlyReview", "n/a", reviews.length === 0 ? "no review request" : "every review was asked by the Consigliere, not under a worker's request");
    else {
      const results = underWorker.map((r) => {
        const parent = holder(r);
        const vAnswer = answerPost(r);
        const answer = answerPost(parent);
        const run = answer?.output?.runId ? runById.get(answer.output.runId) : undefined;
        const superseded = inJob.filter((p) => p.kind === "output" && p.output?.claims.some((c) => c.requestId === parent.id && c.outcome === "superseded"));
        const ok = vAnswer !== undefined && answer !== undefined && answer.seq > vAnswer.seq && (run === undefined || (run.through ?? -1) >= vAnswer.seq);
        return { ok, text: `review #${r.number} answered by ${describe(vAnswer)}; worker's #${parent.number} answered by ${describe(answer)}${run ? ` from a run delivered through ${run.through}` : ""}${superseded.length ? `; superseded by K1 first: ${superseded.map(describe).join(", ")}` : ""}` };
      });
      add("earlyReview", results.every((r) => r.ok) ? "pass" : "FAIL", results.map((r) => r.text).join("; "));
    }
  }

  // 4. T2, §1 case 2: the Consigliere is not woken while a worker's request is held by the review it asked under it.
  const ownReviews = reviews.filter((r) => holder(r) === r).map((r) => `#${r.number}`);
  if (job.task !== "T2") add("consigliereHeld", "n/a", "not T2");
  else if (reviews.every((r) => holder(r) === r)) add("consigliereHeld", "n/a", reviews.length === 0 ? "no review request" : `every review was asked by the Consigliere himself (${ownReviews.join(", ")}), not under a worker's request`);
  else {
    const results = reviews.filter((r) => holder(r) !== r).map((r) => {
      const hold = holder(r);
      const end = answerPost(hold)?.seq ?? Number.POSITIVE_INFINITY;
      const woken = runs.filter((run) => role(run.seatId ?? "") === "C" && (run.reservedSeq ?? -1) > r.seq && (run.reservedSeq ?? -1) < end);
      return { ok: woken.length === 0, text: `review #${r.number} held #${hold.number} until ${Number.isFinite(end) ? `#${end}` : "the close"}: ${woken.length === 0 ? "no Consigliere wake in between" : `woken by ${woken.map((w) => `inputs ${(w.inputs ?? []).map((n) => `#${n}`).join(" ")}`).join("; ")}`}` };
    });
    add("consigliereHeld", results.every((r) => r.ok) ? "pass" : "FAIL", `${results.map((r) => r.text).join("; ")}${ownReviews.length ? `; asked by the Consigliere himself, not judged: ${ownReviews.join(", ")}` : ""}`);
  }

  // 5. T1: a subagent ran, and nothing of the job was left pending at the close.
  const atClose = measure.engineAtClose;
  const clean = atClose !== null && atClose !== undefined && atClose.unresolvedRuns === 0 && atClose.pendingActivities.length === 0 && atClose.openRequests.length === 0 && job.close === "quiet";
  if (job.task !== "T1") add("subagentClean", "n/a", "not T1");
  else if (!measure.subagentRan) add("subagentClean", "n/a", "no subagent ran");
  else add("subagentClean", clean ? "pass" : "FAIL", `${measure.seats.reduce((n, s) => n + s.subagentsStarted, 0)} subagents started, child threads ${job.childThreads.length}; at the close ${atClose ? `${atClose.unresolvedRuns} unresolved runs, ${atClose.pendingActivities.length} pending activities, ${atClose.openRequests.length} open requests` : "no journal"}, closed ${job.close}`);

  // 6.
  add("quiet", job.close === "quiet" ? "pass" : "FAIL", `closed ${job.close}`);

  // 7. Early member posts (measure.ts's earlyAnswers rule) that closed a request.
  const early = measure.earlyAnswers.map((a) => ({ a, snapshot: job.snapshots.find((s) => s.kind === "answer" && s.alias === a.alias && s.at === a.at) }));
  const closing = early.filter(({ snapshot }) => snapshot?.claims?.includes("answered"));
  add(
    "noEarlyAnswer",
    closing.length === 0 ? "pass" : "FAIL",
    early.length === 0 ? "no early member post" : early.map(({ a, snapshot }) => `@${a.alias} ${a.at.slice(11, 19)} ${snapshot?.via ?? "?"} [${(snapshot?.claims ?? []).join(", ") || "no claim"}] failing ${a.failing.join(", ")}`).join("; "),
  );

  // 8.
  add("noUnresolved", atClose && atClose.unresolvedRuns === 0 && atClose.pendingActivities.length === 0 ? "pass" : "FAIL", atClose ? `${atClose.unresolvedRuns} unresolved runs, pending activities: ${atClose.pendingActivities.join(", ") || "none"}; open requests (information): ${atClose.openRequests.map((n) => `#${n}`).join(", ") || "none"}` : "no journal at the close");
  return out;
}

export function behaviourSection(jobs: VerdictJob[], notes: string | null): string[] {
  const newJobs = jobs.filter(({ job }) => job.side === "new").sort((a, b) => a.job.task.localeCompare(b.job.task) || a.job.run - b.job.run);
  const checks = new Map(newJobs.map((j) => [j.job.jobId, behaviourChecks(j)] as const));
  const lines = [
    "## Behaviour checks on the new side",
    "",
    "Each must hold; a failure is a defect for the runtime (L1, fixed before Z4) unless its classification, by hand from the job's board and transcript, finds an agent cause. From each job's journal at the close (`instance-room.json`), the runner's copies (`job.json`) and the measures.",
    "",
    `| check | ${newJobs.map(({ job }) => `${job.task}#${job.run} ${job.jobId}`).join(" | ")} |`,
    `|---|${newJobs.map(() => "---|").join("")}`,
  ];
  const cell = (c: BehaviourCheck | undefined) => (c ? `${c.outcome}${c.note ? ` (${c.note})` : ""}` : "–");
  for (const check of BEHAVIOUR_CHECKS) lines.push(`| ${check.title} | ${newJobs.map(({ job }) => cell(checks.get(job.jobId)?.find((c) => c.id === check.id))).join(" | ")} |`);
  const failures = [...checks.values()].flat().filter((c) => c.outcome === "FAIL").length;
  lines.push("", `${failures === 0 ? "No check failed." : `**${failures} check${failures === 1 ? "" : "s"} failed.**`}`, "", "### Evidence per job", "");
  for (const { job } of newJobs) {
    lines.push(`- **${job.task}#${job.run} ${job.jobId}**`);
    for (const c of checks.get(job.jobId) ?? []) lines.push(`  - ${c.id}: ${cell(c)} — ${c.evidence}`);
  }
  if (notes !== null) lines.push("", "### Classification of the failures (by hand, from the board and transcripts)", "", notes.trim());
  return lines;
}

// ---------------- every run's numbers ----------------

/** report.md under a heading of the verdict: its title dropped, its headings one level down. */
export function embeddedReport(report: string): string[] {
  const body = report.split("\n").filter((line, index) => !(index === 0 && line.startsWith("# ")));
  return ["## Every run's numbers (report.md, as measured with this verdict)", "", ...body.map((line) => (line.startsWith("#") ? `#${line}` : line))];
}

/** The sections verdict.md carries after the gate's table, before its limits; and the measurements after them. */
export function verdictSections(jobs: VerdictJob[], report: string, notes: string | null): { beforeLimits: string[]; afterLimits: string[] } {
  return {
    beforeLimits: [...behaviourSection(jobs, notes), "", ...rulesSection(jobs), "", ...briefingSection(jobs)],
    afterLimits: embeddedReport(report),
  };
}
