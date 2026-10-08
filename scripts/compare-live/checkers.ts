/**
 * The comparison's checkers: whether a task was done, judged on a copy of the job folder and/or the report text.
 *
 * Code from a copy never runs in this process. Each hidden test in checkers/ runs in a child
 * `node --no-warnings --test <file>` with FIXTURE_DIR set to the copy and the copy as cwd, and a part passes iff that
 * child exits 0 within 60 s. A hidden test that needs files outside the copy writes them to SCRATCH_DIR, a
 * .scratch-<pid>-* folder here that the checker removes afterwards, even when the child had to be killed. T3's catalog
 * rules run the same way (checkers/catalog-rules.ts); T3's log and the report checks only read text.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type TaskId = "T1" | "T2" | "T3" | "T4";
export interface PartResult {
  pass: boolean;
  detail: string;
}
export interface CheckInput {
  /** A copy of the job folder (null for text-only checks). */
  folder: string | null;
  /** The report or answer text being judged (T1 facts, T4 reportCoversBoth); null if not applicable. */
  text: string | null;
  /** ISO time: T3's log is read only up to here. */
  cutoff?: string;
}
export interface CheckResult {
  pass: boolean;
  parts: Record<string, PartResult>;
}

/** scripts/compare-live/fixture: the template every job folder is cloned from. */
export const FIXTURE_TEMPLATE = join(import.meta.dirname, "fixture");
/** scripts/compare-live/reference: per task, files that replace template files to make a correct solution. */
export const REFERENCE_DIR = join(import.meta.dirname, "reference");
const CHECKERS_DIR = join(import.meta.dirname, "checkers");
const CHILD_TIMEOUT_MS = 60_000;

/**
 * Which parts belong to which member role, for "early member answers": T1 {any: ["facts"]}, T2 {W1: ["monthEnd",
 * "leapYear"]}, T3 {W1: ["catalog","slowCheckLog"]}, T4 {W1: ["slugify"], W2: ["json"]}.
 */
export const MEMBER_PARTS: Record<TaskId, Record<string, string[]>> = {
  T1: { any: ["facts"] },
  T2: { W1: ["monthEnd", "leapYear"] },
  T3: { W1: ["catalog", "slowCheckLog"] },
  T4: { W1: ["slugify"], W2: ["json"] },
};

/**
 * What a correct T1 answer names: every module src/cli.ts imports, and the line of the unused one. Each pattern must
 * match somewhere in the text. The "facts" part also needs one line that says legacy is unused (LEGACY_UNUSED).
 */
export const T1_FACTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "node:fs", pattern: /node:fs|\bfs\b/i },
  { name: "args", pattern: /\bargs(\.ts)?\b/i },
  { name: "text", pattern: /\btext(\.ts)?\b/i },
  { name: "format", pattern: /\bformat(\.ts)?\b/i },
  { name: "dates", pattern: /\bdates(\.ts)?\b/i },
  { name: "legacy", pattern: /\blegacy(\.ts)?\b/i },
  { name: "types", pattern: /\btypes(\.ts)?\b/i },
  { name: "cli.ts:6", pattern: /cli\.ts:6(?!\d)/ },
];

/** One line of a T1 answer must say both of these: that legacy (./legacy.ts, legacyBanner) is unused. */
const LEGACY_UNUSED = {
  legacy: /legacy/i,
  unused: /unused|not used|never used|isn't used|is not used|unreferenced|dead|never called|not called|isn't called|never referenced|not referenced/i,
};

/** The task's checker: T1 = facts on text; T2 = monthEnd + leapYear on folder; T3 = catalog + slowCheckLog on folder; T4 = slugify + json on folder, plus reportCoversBoth when text is not null. */
export async function checkTask(task: TaskId, input: CheckInput): Promise<CheckResult> {
  const { folder, text, cutoff } = input;
  let parts: Record<string, PartResult>;
  switch (task) {
    case "T1":
      parts = { facts: judgeFacts(text) };
      break;
    case "T2": {
      const [monthEnd, leapYear] = await Promise.all([runHiddenTest(folder, "dates-month-end"), runHiddenTest(folder, "dates-leap-year")]);
      parts = { monthEnd, leapYear };
      break;
    }
    case "T3": {
      const catalog = await runCatalogRules(folder);
      parts = { catalog, slowCheckLog: judgeSlowCheckLogIn(folder, cutoff) };
      break;
    }
    case "T4": {
      const [slugify, json] = await Promise.all([runHiddenTest(folder, "slugify"), runHiddenTest(folder, "json")]);
      parts = { slugify, json };
      if (text !== null) parts.reportCoversBoth = judgeReportCoversBoth(text);
      break;
    }
  }
  return { pass: Object.values(parts).every((part) => part.pass), parts };
}

// ---- text checks ----------------------------------------------------------------------------------------------

/**
 * Lenient on purpose: a false negative fails a correct report (and counts as premature, which G1 gates) for whichever
 * side phrased it that way; a false positive only misses a rare wrong report. Bare module names count.
 */
function judgeFacts(text: string | null): PartResult {
  if (text === null || text.trim() === "") return { pass: false, detail: "no answer text" };
  const missing = T1_FACTS.filter((fact) => !fact.pattern.test(text)).map((fact) => fact.name);
  const saysUnused = text.split(/\r?\n/).some((line) => LEGACY_UNUSED.legacy.test(line) && LEGACY_UNUSED.unused.test(line));
  if (!saysUnused) missing.push("a line saying legacy is unused");
  if (missing.length > 0) return { pass: false, detail: `missing: ${missing.join(", ")}` };
  return { pass: true, detail: `all ${T1_FACTS.length} facts and the legacy-unused line are present` };
}

function judgeReportCoversBoth(text: string): PartResult {
  const missing: string[] = [];
  if (!/slugify/i.test(text)) missing.push("slugify");
  if (!/--json|json flag|json output/i.test(text)) missing.push("--json");
  if (missing.length > 0) return { pass: false, detail: `report does not mention ${missing.join(" or ")}` };
  return { pass: true, detail: "report mentions slugify and --json" };
}

// ---- T3's .slow-check.log ---------------------------------------------------------------------------------------

interface LogEvent {
  time: number;
  kind: "start" | "finish";
  pid: string;
  outcome: "pass" | "fail" | null;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The log's well-formed lines, in file order; anything else is ignored. */
function parseSlowCheckLog(text: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const start = /^(\S+) start (\d+)$/.exec(line.trim());
    const finish = /^(\S+) finish (pass|fail) (\d+)(?: \d+ problems?)?$/.exec(line.trim());
    const stamp = start?.[1] ?? finish?.[1];
    if (stamp === undefined || !ISO_TIME.test(stamp)) continue;
    const time = Date.parse(stamp);
    if (Number.isNaN(time)) continue;
    if (start) events.push({ time, kind: "start", pid: start[2] ?? "", outcome: null });
    else if (finish) events.push({ time, kind: "finish", pid: finish[3] ?? "", outcome: finish[2] === "pass" ? "pass" : "fail" });
  }
  return events;
}

/**
 * Lines after the cutoff are ignored. Passes iff there is a finish line, the last start has a later finish with
 * the same pid, and the last finish is a pass.
 */
function judgeSlowCheckLog(text: string, cutoff: string | undefined): PartResult {
  let events = parseSlowCheckLog(text);
  if (cutoff !== undefined) {
    const limit = Date.parse(cutoff);
    if (Number.isNaN(limit)) return { pass: false, detail: `invalid cutoff "${cutoff}"` };
    events = events.filter((event) => event.time <= limit);
  }
  const upTo = cutoff === undefined ? "" : ` up to ${cutoff}`;
  // Runs can overlap: each start is judged by its own finish (same pid, at or after it), not by the last finish line.
  const ownFinish = (start: LogEvent) => events.find((event) => event.kind === "finish" && event.pid === start.pid && event.time >= start.time);
  const starts = events.filter((event) => event.kind === "start").sort((a, b) => a.time - b.time);
  const lastStart = starts.at(-1);
  if (!lastStart) return { pass: false, detail: `no run started in .slow-check.log${upTo}` };
  const running = starts.find((start) => !ownFinish(start));
  if (running) return { pass: false, detail: `a run (pid ${running.pid}) had not finished${upTo}` };
  const finish = ownFinish(lastStart) as LogEvent;
  if (finish.outcome !== "pass") return { pass: false, detail: `the last run (pid ${lastStart.pid}) failed` };
  return { pass: true, detail: `the last run (pid ${lastStart.pid}) passed` };
}

/** T3's log part on a folder copy, read up to the cutoff. */
export function judgeSlowCheckLogIn(folder: string | null, cutoff: string | undefined): PartResult {
  const missing = folderProblem(folder);
  if (missing !== null || folder === null) return { pass: false, detail: missing ?? "no folder" };
  const path = join(folder, ".slow-check.log");
  if (!existsSync(path)) return { pass: false, detail: "no .slow-check.log in the folder" };
  return judgeSlowCheckLog(readFileSync(path, "utf8"), cutoff);
}

// ---- child processes --------------------------------------------------------------------------------------------

function folderProblem(folder: string | null): string | null {
  if (folder === null) return "no folder to check";
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return `folder not found: ${folder}`;
  return null;
}

interface ChildRun {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs `node ...args` with FIXTURE_DIR = folder and cwd = folder; on timeout kills the child's whole process group. */
function runNode(args: string[], folder: string, extraEnv: Record<string, string> = {}): Promise<ChildRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, FIXTURE_DIR: folder };
  // Set when the checker itself runs under `node --test`; a nested runner must not inherit it.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, CHILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

const clip = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A short account of a `node --test` run: the count that passed, or which tests failed and the first error. */
function describeTestRun(run: ChildRun): string {
  if (run.timedOut) return `timed out after ${CHILD_TIMEOUT_MS / 1000} s`;
  const passed = /^ℹ pass (\d+)$/m.exec(run.output)?.[1];
  if (run.code === 0) return `${passed ?? "all"} tests passed`;
  const failedSection = run.output.split(/^✖ failing tests:$/m)[0] ?? run.output;
  const failing = [...failedSection.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((match) => match[1] ?? "");
  const firstError = /^\s*((?:\w*Error\b|error:).*)$/m.exec(run.output)?.[1]?.trim();
  const parts = [`exit ${run.code ?? "?"}`];
  if (failing.length > 0) parts.push(`failed: ${[...new Set(failing)].join("; ")}`);
  if (firstError) parts.push(firstError);
  return clip(parts.join(" | "));
}

async function runHiddenTest(folder: string | null, name: string): Promise<PartResult> {
  const missing = folderProblem(folder);
  if (missing !== null || folder === null) return { pass: false, detail: missing ?? "no folder" };
  const scratch = mkdtempSync(join(import.meta.dirname, `.scratch-${process.pid}-`));
  try {
    const run = await runNode(["--no-warnings", "--test", join(CHECKERS_DIR, `${name}.hidden.test.ts`)], folder, { SCRATCH_DIR: scratch });
    return { pass: run.code === 0 && !run.timedOut, detail: describeTestRun(run) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function runCatalogRules(folder: string | null): Promise<PartResult> {
  const missing = folderProblem(folder);
  if (missing !== null || folder === null) return { pass: false, detail: missing ?? "no folder" };
  const run = await runNode(["--no-warnings", join(CHECKERS_DIR, "catalog-rules.ts")], folder);
  const detail = run.timedOut ? `timed out after ${CHILD_TIMEOUT_MS / 1000} s` : clip(run.output.trim().split("\n").join("; "));
  return { pass: run.code === 0 && !run.timedOut, detail };
}
