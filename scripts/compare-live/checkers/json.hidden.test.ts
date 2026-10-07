/**
 * Hidden check for T4, W2's part: the CLI in the copy at FIXTURE_DIR takes `--json` anywhere on the command line.
 * The sample file lives in SCRATCH_DIR (or a .scratch-<pid> folder of its own), never in the copy. Its counts
 * follow the README's rules: lines end at "\n" (a last line without one counts), words are runs of non-whitespace,
 * chars is the string length.
 *
 * month-end's value depends on T2's defect, which T4's tree still has, so only its shape is checked.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = process.env.FIXTURE_DIR;
if (!dir) throw new Error("FIXTURE_DIR is not set");
const fixtureDir = dir;

const SAMPLE = "The quick brown fox\njumps over\n\n  the lazy\tdog.  \nfin";
const SAMPLE_STATS = { lines: 5, words: 10, chars: 53 };

const scratch = process.env.SCRATCH_DIR ?? join(import.meta.dirname, "..", `.scratch-${process.pid}`);
const sample = join(scratch, "sample.txt");

before(() => {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(sample, SAMPLE);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs `node src/cli.ts ...args` in the copy; fails the test unless it exits 0. */
function tally(...args: string[]): string {
  const result = spawnSync(process.execPath, ["--no-warnings", "src/cli.ts", ...args], { cwd: fixtureDir, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `tally ${args.join(" ")} exited ${result.status ?? result.signal}: ${result.stderr}`);
  return result.stdout;
}

/** The single line of JSON a command printed, parsed. */
function jsonLine(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected one line of JSON, got:\n${stdout}`);
  return JSON.parse(lines[0] ?? "");
}

test("stats <file> --json prints the counts as one line of JSON", () => {
  assert.deepEqual(jsonLine(tally("stats", sample, "--json")), SAMPLE_STATS);
});

test("--json stats <file> works with the flag first", () => {
  assert.deepEqual(jsonLine(tally("--json", "stats", sample)), SAMPLE_STATS);
});

test("month-end <date> --json prints the date and its month end", () => {
  const value = jsonLine(tally("month-end", "2026-04-10", "--json"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["date", "monthEnd"]);
  assert.equal(record.date, "2026-04-10");
  assert.match(String(record.monthEnd), /^\d{4}-\d{2}-\d{2}$/);
});

test("without --json the output is unchanged", () => {
  assert.equal(tally("stats", sample), `lines: ${SAMPLE_STATS.lines}\nwords: ${SAMPLE_STATS.words}\nchars: ${SAMPLE_STATS.chars}\n`);
  assert.match(tally("month-end", "2026-04-10"), /^\d{4}-\d{2}-\d{2}\n$/);
});
