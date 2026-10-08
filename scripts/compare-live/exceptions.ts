/**
 * Decided exceptions to the accuracy check (campaign c1, the Consigliere's decision on board #845). A campaign folder may
 * hold `decided-exceptions.json`: differences the accuracy check found that were decided on, each for one listed job,
 * with the exact transcript lines it rests on, its classification and the decision by post number.
 *
 * Reporting only. The accuracy check is untouched: it still finds and reports every difference (report.md, report.json,
 * stderr and the exit code). `--verdict` proceeds when every difference is a listed one and verdict.md prints them under
 * their own heading; any other difference refuses the verdict as before, and `--register-gate` takes no exception.
 * Nothing here feeds the measurement, the gate or the checkers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leakPattern, type JobRecord } from "./campaign.ts";

export const EXCEPTIONS_FILE = "decided-exceptions.json";

/** A difference as measure.ts's accuracy check reports it. */
export interface CheckDifference {
  job: string;
  what: string;
  measured: unknown;
  recounted: unknown;
}

export interface DecidedException {
  /** The job folder's name, as the difference names it: `<side>-<task>-<run>-<jobId>`. */
  job: string;
  /** The difference's text, exactly. */
  what: string;
  /** The file the difference names (its `measured`), relative to the job folder. */
  transcript: string;
  /** The lines of that file the decision rests on: 1-based line number and an exact excerpt of that line. */
  lines: Array<{ line: number; text: string }>;
  classification: string;
  /** The decision, by post number. */
  decision: string;
}

export interface Decided {
  excepted: Array<{ difference: CheckDifference; exception: DecidedException }>;
  /** Differences no exception covers: the verdict is refused while there is one. */
  open: CheckDifference[];
  /** A listed exception that is malformed, names a job the campaign does not have, quotes a line the file does not
   * hold, or covers no difference: the verdict is refused while there is one. */
  problems: string[];
}

/** The campaign's decided exceptions; none when the file is absent. */
export function loadDecidedExceptions(campaignDir: string): DecidedException[] {
  const path = join(campaignDir, EXCEPTIONS_FILE);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { exceptions?: unknown };
  if (!Array.isArray(parsed.exceptions)) throw new Error(`${path}: no "exceptions" list`);
  return parsed.exceptions as DecidedException[];
}

/**
 * Which differences the listed exceptions cover. A difference is covered only by an exception for the same job, with
 * the same text, naming the same file; each exception must cover a difference and quote lines its file holds.
 */
export function applyDecidedExceptions(differences: CheckDifference[], exceptions: DecidedException[], dirOf: (job: string) => string | undefined): Decided {
  const problems: string[] = [];
  const valid = exceptions.filter((e, index) => {
    const label = `exception ${index + 1} (${typeof e?.job === "string" ? e.job : "no job"})`;
    const missing = (["job", "what", "transcript", "classification", "decision"] as const).filter((k) => typeof e?.[k] !== "string" || e[k].trim() === "");
    if (missing.length > 0) return problems.push(`${label}: no ${missing.join(", ")}`), false;
    if (!Array.isArray(e.lines) || e.lines.length === 0) return problems.push(`${label}: no transcript lines`), false;
    const dir = dirOf(e.job);
    if (dir === undefined) return problems.push(`${label}: the campaign has no closed job ${e.job}`), false;
    const file = join(dir, e.transcript);
    if (!existsSync(file)) return problems.push(`${label}: no file ${e.transcript} in the job folder`), false;
    const fileLines = readFileSync(file, "utf8").split("\n");
    const wrong = e.lines.filter((l) => !Number.isInteger(l?.line) || typeof l?.text !== "string" || l.text === "" || !(fileLines[l.line - 1] ?? "").includes(l.text));
    if (wrong.length > 0) return problems.push(`${label}: line${wrong.length === 1 ? "" : "s"} ${wrong.map((l) => l?.line).join(", ")} of ${e.transcript} do not hold the quoted text`), false;
    // The guard reports a file once, at its first match: every line of the file it matches must be a listed one, so a
    // later mention in the same file cannot pass under the decision.
    const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
    const leak = leakPattern(job.jobId);
    const listed = new Set(e.lines.map((l) => l.line));
    const unlisted = fileLines.flatMap((text, i) => (leak.test(text) && !listed.has(i + 1) ? [i + 1] : []));
    if (unlisted.length > 0) return problems.push(`${label}: ${e.transcript} has unlisted line${unlisted.length === 1 ? "" : "s"} the leak guard matches: ${unlisted.join(", ")}`), false;
    return true;
  });
  const covers = (e: DecidedException, d: CheckDifference) => d.job === e.job && d.what === e.what && d.measured === join(dirOf(e.job) as string, e.transcript);
  const excepted: Decided["excepted"] = [];
  const open: CheckDifference[] = [];
  for (const difference of differences) {
    const exception = valid.find((e) => covers(e, difference));
    if (exception) excepted.push({ difference, exception });
    else open.push(difference);
  }
  for (const e of valid) if (!excepted.some((x) => x.exception === e)) problems.push(`exception for ${e.job} (${e.what}) covers no difference the accuracy check found`);
  return { excepted, open, problems };
}

/** Why --verdict is refused, or null: a difference no exception covers, or a listed exception that does not hold. */
export function verdictRefusal(differences: CheckDifference[], decided: Decided): string | null {
  if (decided.open.length === 0 && decided.problems.length === 0) return null;
  // Without a decided exception in play, the refusal is measure.ts's own, word for word.
  if (decided.excepted.length === 0 && decided.problems.length === 0) return `the accuracy check found ${differences.length} differences: no gate is registered and no verdict given`;
  const outside = decided.excepted.length > 0 ? ` outside the ${decided.excepted.length} decided exception${decided.excepted.length === 1 ? "" : "s"}` : "";
  const problems = decided.problems.length > 0 ? `; ${decided.problems.join("; ")}` : "";
  return `the accuracy check found ${decided.open.length} difference${decided.open.length === 1 ? "" : "s"}${outside}${problems}: no verdict given (${differences.length} found in all)`;
}

/** verdict.md's own section for the decided exceptions; empty when there are none. */
export function decidedExceptionsSection(decided: Decided, total: number): string[] {
  if (decided.excepted.length === 0) return [];
  const lines = [
    "## Decided exceptions to the accuracy check",
    "",
    `The accuracy check found ${total} difference${total === 1 ? "" : "s"}, listed under "Accuracy differences" in the report below. ${decided.excepted.length === total ? (total === 1 ? "It is" : "All are") : `${decided.excepted.length} are`} decided exception${decided.excepted.length === 1 ? "" : "s"} (\`${EXCEPTIONS_FILE}\` in the campaign folder): the job${decided.excepted.length === 1 ? " is" : "s are"} measured and gated like every other, and the difference stays reported.`,
    "",
    "`measure.ts --verdict` exits 1 while any difference is reported, a decided one included, whatever the verdict: the verdict is this file's heading line.",
  ];
  for (const { difference, exception } of decided.excepted) {
    lines.push(
      "",
      `### ${exception.job}: ${exception.what}`,
      "",
      `- **File:** \`${exception.transcript}\` (in the job folder).`,
      `- **Classification:** ${exception.classification}`,
      `- **Decision:** ${exception.decision}`,
      `- **The lines it rests on:**`,
      "",
    );
    for (const l of exception.lines) lines.push(`  - line ${l.line}:`, "", "    ```", ...l.text.split("\n").map((t) => `    ${t}`), "    ```", "");
    lines.push(`- **As the check reports it:** ${difference.job} ${difference.what}: measured ${JSON.stringify(difference.measured)}, recounted ${JSON.stringify(difference.recounted)}`);
  }
  return lines;
}
