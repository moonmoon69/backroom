/**
 * The checkers fail on the untouched fixture, pass on the reference solutions, and tell T2's two defects apart; the
 * fixture's own tests fail in exactly one place. Copies live in scripts/compare-live/.scratch-<pid>/.
 *
 *   node --no-warnings --test scripts/compare-live/checkers.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkTask, FIXTURE_TEMPLATE, judgeSlowCheckLogIn, MEMBER_PARTS, REFERENCE_DIR, T1_FACTS, type CheckResult, type TaskId } from "./checkers.ts";

const SCRATCH = join(import.meta.dirname, `.scratch-${process.pid}`);
before(() => mkdirSync(SCRATCH, { recursive: true }));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let copies = 0;

/** A fresh copy of the template; with a task, that task's reference files over it (report.md stays out, slow-check.log becomes .slow-check.log). */
function makeCopy(task?: TaskId): string {
  copies += 1;
  const dir = join(SCRATCH, `copy-${copies}${task ? `-${task}` : ""}`);
  cpSync(FIXTURE_TEMPLATE, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.slow-check\.log)$/.test(source) });
  if (task) overlayReference(task, dir);
  return dir;
}

function overlayReference(task: TaskId, dir: string): void {
  const source = join(REFERENCE_DIR, task);
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(source, join(entry.parentPath, entry.name));
    if (path === "report.md") continue;
    const target = join(dir, path === "slow-check.log" ? ".slow-check.log" : path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, path), target);
  }
}

const referenceReport = (task: TaskId) => readFileSync(join(REFERENCE_DIR, task, "report.md"), "utf8");

/** Runs node in `cwd` without the outer test runner's context. */
function node(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertParts(result: CheckResult, expected: Record<string, boolean>): void {
  const actual = Object.fromEntries(Object.entries(result.parts).map(([name, part]) => [name, part.pass]));
  assert.deepEqual(actual, expected, JSON.stringify(result.parts, null, 2));
  assert.equal(result.pass, Object.values(expected).every(Boolean));
}

/** Parts each task's checker produces when given a folder (and, for T1 and T4, a text). */
const PARTS: Record<TaskId, string[]> = {
  T1: ["facts"],
  T2: ["monthEnd", "leapYear"],
  T3: ["catalog", "slowCheckLog"],
  T4: ["slugify", "json", "reportCoversBoth"],
};

test("MEMBER_PARTS only names parts the task's checker produces", () => {
  for (const [task, roles] of Object.entries(MEMBER_PARTS) as Array<[TaskId, Record<string, string[]>]>) {
    for (const parts of Object.values(roles)) for (const part of parts) assert.ok(PARTS[task].includes(part), `${task}: ${part}`);
  }
  assert.deepEqual(MEMBER_PARTS.T1, { any: ["facts"] });
  assert.deepEqual(MEMBER_PARTS.T4, { W1: ["slugify"], W2: ["json"] });
});

describe("T1: the imports of src/cli.ts", () => {
  const WRONG = [
    "src/cli.ts imports node:fs (cli.ts:1), ./args.ts (cli.ts:2), ./text.ts (cli.ts:3), ./format.ts (cli.ts:4),",
    "./dates.ts (cli.ts:5), ./legacy.ts (cli.ts:6) and ./types.ts (cli.ts:7).",
    "Every one of them is used in cli.ts.",
  ].join("\n");

  test("fails on a plausible answer that calls nothing unused, on an empty text and on no text", async () => {
    const wrong = await checkTask("T1", { folder: null, text: WRONG });
    assertParts(wrong, { facts: false });
    assert.match(wrong.parts.facts?.detail ?? "", /legacy is unused/);
    assertParts(await checkTask("T1", { folder: null, text: "" }), { facts: false });
    assertParts(await checkTask("T1", { folder: null, text: null }), { facts: false });
  });

  test("passes on the reference report", async () => {
    assertParts(await checkTask("T1", { folder: null, text: referenceReport("T1") }), { facts: true });
  });

  test("fails on the reference report without cli.ts:6", async () => {
    const text = referenceReport("T1").replaceAll("cli.ts:6", "cli.ts");
    const result = await checkTask("T1", { folder: null, text });
    assertParts(result, { facts: false });
    assert.match(result.parts.facts?.detail ?? "", /cli\.ts:6/);
  });

  test("fails on the reference report without its line saying legacy is unused", async () => {
    const lines = referenceReport("T1").split("\n");
    const text = lines.slice(0, lines.findIndex((line) => line.startsWith("One import is unused"))).join("\n");
    assert.match(text, /legacy\.ts/);
    assertParts(await checkTask("T1", { folder: null, text }), { facts: false });
  });

  test("T1_FACTS names every imported module and the line of the unused one", () => {
    assert.deepEqual(
      T1_FACTS.map((fact) => fact.name),
      ["node:fs", "args", "text", "format", "dates", "legacy", "types", "cli.ts:6"],
    );
    assert.ok(!T1_FACTS.find((fact) => fact.name === "cli.ts:6")?.pattern.test("src/cli.ts:60"));
  });

  test("src/cli.ts starts with exactly the seven imports, legacy on line 6", () => {
    const lines = readFileSync(join(FIXTURE_TEMPLATE, "src/cli.ts"), "utf8").split("\n");
    assert.deepEqual(lines.slice(0, 7), [
      'import { readFileSync } from "node:fs";',
      'import { parseArgs } from "./args.ts";',
      'import { countLines, countWords } from "./text.ts";',
      'import { formatStats } from "./format.ts";',
      'import { endOfMonth } from "./dates.ts";',
      'import { legacyBanner } from "./legacy.ts";',
      'import type { Stats } from "./types.ts";',
    ]);
    assert.equal(lines[5], 'import { legacyBanner } from "./legacy.ts";');
    const body = lines.slice(7).join("\n");
    assert.doesNotMatch(body, /legacyBanner/);
    for (const name of ["readFileSync", "parseArgs", "countLines", "countWords", "formatStats", "endOfMonth", "Stats"]) {
      assert.match(body, new RegExp(`\\b${name}\\b`), `${name} is used`);
    }
  });
});

describe("T2: the month-end fix and its review", () => {
  test("fails on the template", async () => {
    assertParts(await checkTask("T2", { folder: makeCopy(), text: null }), { monthEnd: false, leapYear: false });
  });

  test("passes on the reference", async () => {
    assertParts(await checkTask("T2", { folder: makeCopy("T2"), text: null }), { monthEnd: true, leapYear: true });
  });

  test("with only the off-by-one fixed, monthEnd passes and leapYear fails", async () => {
    const dir = makeCopy();
    const path = join(dir, "src/dates.ts");
    const source = readFileSync(path, "utf8");
    assert.equal(source.split("days[month]").length, 2, "days[month] appears once");
    writeFileSync(path, source.replace("days[month]", "days[month - 1]"));
    const result = await checkTask("T2", { folder: dir, text: null });
    assertParts(result, { monthEnd: true, leapYear: false });
    assert.match(result.parts.leapYear?.detail ?? "", /century rule/);
  });

  test("a missing folder fails without throwing", async () => {
    assertParts(await checkTask("T2", { folder: join(SCRATCH, "nowhere"), text: null }), { monthEnd: false, leapYear: false });
    assertParts(await checkTask("T2", { folder: null, text: null }), { monthEnd: false, leapYear: false });
  });
});

describe("T3: the slow check in the background", () => {
  const LOG = readFileSync(join(REFERENCE_DIR, "T3/slow-check.log"), "utf8");

  test("fails on the template (catalog problems, no log)", async () => {
    const result = await checkTask("T3", { folder: makeCopy(), text: null });
    assertParts(result, { catalog: false, slowCheckLog: false });
    assert.match(result.parts.catalog?.detail ?? "", /repeats sku "lamp-01"/);
    assert.match(result.parts.catalog?.detail ?? "", /invalid price -1299/);
  });

  test("passes on the reference with its log", async () => {
    assertParts(await checkTask("T3", { folder: makeCopy("T3"), text: null }), { catalog: true, slowCheckLog: true });
  });

  test("deleting the products with problems is not a fix", async () => {
    const dir = makeCopy();
    const path = join(dir, "src/catalog.ts");
    const kept = readFileSync(path, "utf8").split("\n").filter((line) => !/"Floor lamp"|"Travel mug"/.test(line));
    writeFileSync(path, kept.join("\n"));
    const result = await checkTask("T3", { folder: dir, text: null });
    assert.equal(result.parts.catalog?.pass, false);
    assert.match(result.parts.catalog?.detail ?? "", /expected 36 products, found 34/);
    assert.match(result.parts.catalog?.detail ?? "", /"Travel mug" is missing/);
  });

  test("the log is read only up to the cutoff", async () => {
    const dir = makeCopy("T3");
    const at = (cutoff: string) => checkTask("T3", { folder: dir, text: null, cutoff }).then((result) => result.parts.slowCheckLog);
    // Before anything, after the failing run, mid-way through the passing run, at and after its finish.
    assert.equal((await at("2026-10-08T08:59:00.000Z"))?.pass, false);
    const afterFailure = await at("2026-10-08T09:05:00.000Z");
    assert.equal(afterFailure?.pass, false);
    assert.match(afterFailure?.detail ?? "", /failed/);
    const midRun = await at("2026-10-08T09:09:00.000Z");
    assert.equal(midRun?.pass, false);
    assert.match(midRun?.detail ?? "", /had not finished/);
    assert.equal((await at("2026-10-08T09:10:30.691Z"))?.pass, true);
    assert.equal((await at("2026-10-08T11:10:30.691+02:00"))?.pass, true);
    assert.equal((await at("2026-10-08T12:00:00.000Z"))?.pass, true);
  });

  test("a run started after the last pass, malformed lines and a missing log", async () => {
    const dir = makeCopy("T3");
    const write = (text: string) => writeFileSync(join(dir, ".slow-check.log"), text);
    const check = () => checkTask("T3", { folder: dir, text: null }).then((result) => result.parts.slowCheckLog?.pass);
    write(`${LOG}2026-10-08T09:12:00.000Z start 41500\n`);
    assert.equal(await check(), false, "a newer run has not finished");
    write(`garbage\n${LOG}not a line\n2026-10-08 09:20 finish fail 41388\n2026-10-08T09:20:00Z finish\n`);
    assert.equal(await check(), true, "malformed lines are ignored");
    write(`${LOG}2026-10-08T09:12:00.000Z start 41500\n2026-10-08T09:15:00.000Z finish fail 41500 1 problems\n`);
    assert.equal(await check(), false, "the last finish failed");
    write("2026-10-08T09:10:30.691Z finish pass 41388\n");
    assert.equal(await check(), false, "a finish without a start");
    rmSync(join(dir, ".slow-check.log"));
    assert.equal(await check(), false, "no log");
  });

  test("slow-check reports both problems by line and logs its runs (with the delay cut to 0 in a copy)", async () => {
    const dir = makeCopy();
    const script = join(dir, "scripts/slow-check.mjs");
    const source = readFileSync(script, "utf8");
    assert.match(source, /^const DELAY_MS = 5000;$/m);
    writeFileSync(script, source.replace(/^const DELAY_MS = 5000;$/m, "const DELAY_MS = 0;"));

    const failing = node(["scripts/slow-check.mjs"], dir);
    assert.equal(failing.code, 1, failing.stderr);
    assert.match(failing.stdout, /^checking 1\/36 pen-01 \.\.\. ok$/m);
    assert.match(failing.stdout, /^checking 18\/36 lamp-01 \.\.\. FAIL$/m);
    const fails = failing.stdout.split("\n").filter((line) => line.startsWith("FAIL "));
    assert.deepEqual(fails, [
      'FAIL src/catalog.ts:31 duplicate sku "lamp-01" (first used at line 19)',
      'FAIL src/catalog.ts:38 "mug-02" has a non-positive price (-1299 cents)',
    ]);
    assert.match(failing.stdout, /^slow-check: 2 problems$/m);

    cpSync(join(REFERENCE_DIR, "T3/src/catalog.ts"), join(dir, "src/catalog.ts"));
    // From another cwd: the log still goes to the project root.
    const passing = node([script], join(dir, "src"));
    assert.equal(passing.code, 0, passing.stdout + passing.stderr);
    assert.match(passing.stdout, /^slow-check: catalog OK \(36 products\)$/m);

    const log = readFileSync(join(dir, ".slow-check.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 4);
    assert.match(log[0] ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z start \d+$/);
    assert.match(log[1] ?? "", /^\S+ finish fail \d+ 2 problems$/);
    assert.match(log[2] ?? "", /^\S+ start \d+$/);
    assert.match(log[3] ?? "", /^\S+ finish pass \d+$/);
    assert.equal(log[2]?.split(" ")[2], log[3]?.split(" ")[3], "start and finish share the pid");

    assertParts(await checkTask("T3", { folder: dir, text: null }), { catalog: true, slowCheckLog: true });
    const beforeSecondRun = log[1]?.split(" ")[0] ?? "";
    assert.equal((await checkTask("T3", { folder: dir, text: null, cutoff: beforeSecondRun })).parts.slowCheckLog?.pass, false);
  });
});

describe("T4: slugify and --json in parallel", () => {
  test("fails on the template, with no report part when the text is null", async () => {
    assertParts(await checkTask("T4", { folder: makeCopy(), text: null }), { slugify: false, json: false });
  });

  test("passes on the reference with its report", async () => {
    const dir = makeCopy("T4");
    assertParts(await checkTask("T4", { folder: dir, text: referenceReport("T4") }), { slugify: true, json: true, reportCoversBoth: true });
    assertParts(await checkTask("T4", { folder: dir, text: null }), { slugify: true, json: true });
  });

  test("the report must mention both features", async () => {
    const dir = makeCopy("T4");
    const result = await checkTask("T4", { folder: dir, text: "Added slugify to src/text.ts." });
    assertParts(result, { slugify: true, json: true, reportCoversBoth: false });
    assertParts(await checkTask("T4", { folder: dir, text: "" }), { slugify: true, json: true, reportCoversBoth: false });
  });

  test("the checker leaves no scratch folder behind and writes nothing into the copy", async () => {
    const dir = makeCopy("T4");
    const before = readdirSync(dir, { recursive: true }).sort();
    await checkTask("T4", { folder: dir, text: null });
    assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
    const leftovers = readdirSync(import.meta.dirname).filter((name) => name.startsWith(`.scratch-${process.pid}-`));
    assert.deepEqual(leftovers, []);
  });

  test("each half is judged on its own", async () => {
    const dir = makeCopy();
    cpSync(join(REFERENCE_DIR, "T4/src/text.ts"), join(dir, "src/text.ts"));
    assertParts(await checkTask("T4", { folder: dir, text: null }), { slugify: true, json: false });
  });

  test("reference/T4/src holds cli.ts's imports only so they resolve; they equal the template's", () => {
    for (const name of readdirSync(join(REFERENCE_DIR, "T4/src"))) {
      if (name === "cli.ts" || name === "text.ts") continue;
      assert.equal(readFileSync(join(REFERENCE_DIR, "T4/src", name), "utf8"), readFileSync(join(FIXTURE_TEMPLATE, "src", name), "utf8"), name);
    }
  });
});

describe("the fixture template", () => {
  const visibleTests = readdirSync(join(FIXTURE_TEMPLATE, "test")).filter((name) => name.endsWith(".test.ts"));

  test("its visible tests fail only on the month-end test, and pass with the T2 reference", () => {
    const failing = node(["--no-warnings", "--test", "--test-reporter=tap", "test/**/*.test.ts"], makeCopy());
    assert.notEqual(failing.code, 0);
    const notOk = failing.stdout.split("\n").filter((line) => /^\s*not ok \d+ - /.test(line));
    assert.deepEqual(notOk.map((line) => line.replace(/^\s*not ok \d+ - /, "")), ["endOfMonth returns the last day of the month"]);
    assert.match(failing.stdout, /^# fail 1$/m);
    assert.match(failing.stdout, /^# pass [1-9]\d*$/m);

    const passing = node(["--no-warnings", "--test", "--test-reporter=tap", "test/**/*.test.ts"], makeCopy("T2"));
    assert.equal(passing.code, 0, passing.stdout);
    assert.match(passing.stdout, /^# fail 0$/m);
  });

  test("no visible test touches February or leap years", () => {
    assert.deepEqual(visibleTests.sort(), ["args.test.ts", "dates.test.ts", "text.test.ts"]);
    for (const name of visibleTests) {
      assert.doesNotMatch(readFileSync(join(FIXTURE_TEMPLATE, "test", name), "utf8"), /-02-|leap|february|\b(1900|2000|2100)\b/i, name);
    }
  });

  test("nothing in it gives the game away", () => {
    for (const entry of readdirSync(FIXTURE_TEMPLATE, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      assert.doesNotMatch(readFileSync(path, "utf8"), /fixture|planted|hidden|checker|comparison|\bagents?\b/i, relative(FIXTURE_TEMPLATE, path));
    }
  });
});

describe("review round 1 (R7, S1)", () => {
  test("R7: overlapping slow-check runs are judged by the last-started run's own finish", async () => {
    const dir = join(SCRATCH, "r7");
    mkdirSync(dir, { recursive: true });
    const write = (lines: string[]) => writeFileSync(join(dir, ".slow-check.log"), `${lines.join("\n")}\n`);
    // start 1, start 2, finish fail 2, finish pass 1: the last-started run (2) failed.
    write(["2026-10-08T10:00:00.000Z start 1", "2026-10-08T10:01:00.000Z start 2", "2026-10-08T10:03:30.000Z finish fail 2 2 problems", "2026-10-08T10:04:00.000Z finish pass 1"]);
    const log = (cutoff?: string) => judgeSlowCheckLogIn(dir, cutoff);
    assert.equal(log().pass, false);
    assert.match(log().detail, /pid 2\) failed/);
    assert.equal(log("2026-10-08T10:03:45.000Z").pass, false);
    // start 1, start 2, finish pass 2 while 1 still runs: not finished.
    write(["2026-10-08T10:00:00.000Z start 1", "2026-10-08T10:01:00.000Z start 2", "2026-10-08T10:04:00.000Z finish pass 2"]);
    assert.equal(log().pass, false);
    assert.match(log().detail, /pid 1\) had not finished/);
    // Both finished, the last-started one passed.
    write(["2026-10-08T10:00:00.000Z start 1", "2026-10-08T10:01:00.000Z start 2", "2026-10-08T10:03:00.000Z finish fail 1 2 problems", "2026-10-08T10:04:00.000Z finish pass 2"]);
    assert.equal(log().pass, true);
    assert.equal(log("2026-10-08T10:03:30.000Z").pass, false);
  });

  test("R8: correct T1 reports in any phrasing pass (the check is lenient on purpose)", async () => {
    const facts = async (text: string) => (await checkTask("T1", { folder: null, text })).parts.facts ?? { pass: false, detail: "no facts part" };
    const right = readFileSync(join(REFERENCE_DIR, "T1", "report.md"), "utf8");
    assert.equal((await facts(right)).pass, true);
    for (const line of [
      "No other import is unused.",
      "None of the other six is unused.",
      "There is no unused import except ./legacy.ts.",
      "./types.ts (src/cli.ts:7) is a type-only import, erased at runtime, but it is not unused: the Row type is used.",
      "./legacy.ts is unused, unlike ./format.ts, which formatRow uses.",
    ]) {
      const result = await facts(`${right}\n${line}`);
      assert.equal(result.pass, true, `${line}: ${result.detail}`);
    }
    const table = ["| module | line | used |", "|---|---|---|", "| node:fs | cli.ts:1 | yes |", "| args | cli.ts:2 | yes |", "| text | cli.ts:3 | yes |", "| format | cli.ts:4 | yes |", "| dates | cli.ts:5 | yes |", "| legacy | cli.ts:6 | unused |", "| types | cli.ts:7 | yes |"].join("\n");
    assert.equal((await facts(table)).pass, true, "bare-name table");
    assert.equal((await facts("src/cli.ts imports node:fs and the args, text, format, dates, legacy and types modules. Only legacy is unused (src/cli.ts:6).")).pass, true, "bare-name prose");
    // Still refused: no line calls legacy unused, or the line number is missing.
    assert.equal((await facts("Imports: node:fs, args, text, format, dates, legacy, types (src/cli.ts:1-7). Everything is used.")).pass, false);
    assert.equal((await facts("Imports: node:fs, args, text, format, dates, types. legacy is unused.")).pass, false);
  });
});
