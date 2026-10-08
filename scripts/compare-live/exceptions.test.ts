/**
 * Decided exceptions to the accuracy check (exceptions.ts; campaign c1, decision board #845): which differences a listed
 * exception covers, what refuses the verdict, and verdict.md's own section. On constructed job folders.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { EXCEPTIONS_FILE, applyDecidedExceptions, decidedExceptionsSection, loadDecidedExceptions, verdictRefusal, type CheckDifference, type DecidedException } from "./exceptions.ts";

const SCRATCH = join(import.meta.dirname, `.scratch-exceptions-${process.pid}`);
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const JOB = "old-T3-2-c3013f";
const FILE = "transcripts/-tally/4c806eab.jsonl";
const LINE_51 = "node --no-warnings=ExperimentalWarning scripts/compare-live/run.ts --campaign c1 --side old --jobs T3:2";
const dir = join(SCRATCH, "jobs", JOB);
mkdirSync(join(dir, "transcripts", "-tally"), { recursive: true });
writeFileSync(join(dir, FILE), [...Array.from({ length: 50 }, (_, i) => `{"line":${i + 1}}`), `{"tool_result":"... ${LINE_51} ..."}`, `{"line":52}`].join("\n"));
const dirOf = (job: string) => (job === JOB ? dir : undefined);

const leak: CheckDifference = { job: JOB, what: "a transcript mentions scripts/compare-live", measured: join(dir, FILE), recounted: null };
const exception = (extra: Partial<DecidedException> = {}): DecidedException => ({
  job: JOB,
  what: "a transcript mentions scripts/compare-live",
  transcript: FILE,
  lines: [{ line: 51, text: LINE_51 }],
  classification: "exposure, not access",
  decision: "#845 (task625), the Consigliere",
  ...extra,
});

describe("decided exceptions", () => {
  test("a listed difference is covered; the verdict goes ahead and the difference is still the check's", () => {
    const differences = [leak];
    const decided = applyDecidedExceptions(differences, [exception()], dirOf);
    assert.deepEqual(decided.open, []);
    assert.deepEqual(decided.problems, []);
    assert.equal(decided.excepted.length, 1);
    assert.equal(verdictRefusal(differences, decided), null);
    assert.deepEqual(differences, [leak], "the accuracy check's list is not changed");
  });

  test("any other difference stays open and refuses the verdict: another job, another text, another file", () => {
    const others: CheckDifference[] = [
      { ...leak, job: "new-T3-2-3b9d64" },
      { ...leak, what: "a transcript mentions backroom-handoff" },
      { ...leak, measured: join(dir, "transcripts/-tally/other.jsonl") },
      { job: JOB, what: "tokens", measured: 10, recounted: 11 },
    ];
    const decided = applyDecidedExceptions([leak, ...others], [exception()], dirOf);
    assert.deepEqual(decided.open, others);
    assert.match(verdictRefusal([leak, ...others], decided) ?? "", /^the accuracy check found 4 differences outside the 1 decided exception: no verdict given \(5 found in all\)$/);
  });

  test("with no exceptions file nothing is covered, and the refusal is measure.ts's own", () => {
    assert.deepEqual(loadDecidedExceptions(join(SCRATCH, "none")), []);
    const decided = applyDecidedExceptions([leak], [], dirOf);
    assert.deepEqual(decided.open, [leak]);
    assert.equal(verdictRefusal([leak], decided), "the accuracy check found 1 differences: no gate is registered and no verdict given", "measure.ts's own refusal, word for word");
  });

  test("an exception that does not hold refuses the verdict: a quoted line the file does not hold, an unknown job, no decision, covering nothing", () => {
    for (const [bad, expected] of [
      [exception({ lines: [{ line: 50, text: LINE_51 }] }), /line 50 of transcripts\/-tally\/4c806eab.jsonl do not hold the quoted text/],
      [exception({ lines: [{ line: 99, text: LINE_51 }] }), /line 99 of/],
      [exception({ job: "old-T3-3-aaaaaa" }), /the campaign has no closed job old-T3-3-aaaaaa/],
      [exception({ decision: " " }), /no decision/],
      [exception({ lines: [] }), /no transcript lines/],
      [exception({ transcript: "transcripts/-tally/missing.jsonl" }), /no file transcripts\/-tally\/missing.jsonl/],
    ] as const) {
      const decided = applyDecidedExceptions([leak], [bad], dirOf);
      assert.deepEqual(decided.excepted, [], JSON.stringify(bad));
      assert.match(verdictRefusal([leak], decided) ?? "", expected);
    }
    const stale = applyDecidedExceptions([], [exception()], dirOf);
    assert.match(verdictRefusal([], stale) ?? "", /covers no difference the accuracy check found/);
  });

  test("the campaign's file is read as listed", () => {
    const campaign = join(SCRATCH, "campaign");
    mkdirSync(campaign, { recursive: true });
    writeFileSync(join(campaign, EXCEPTIONS_FILE), JSON.stringify({ exceptions: [exception()] }));
    assert.deepEqual(loadDecidedExceptions(campaign), [exception()]);
    writeFileSync(join(campaign, EXCEPTIONS_FILE), JSON.stringify({ exception: [] }));
    assert.throws(() => loadDecidedExceptions(campaign), /no "exceptions" list/);
  });

  test("verdict.md's section: its own heading, the job, the file, the lines, the classification, the decision and the check's own line", () => {
    const decided = applyDecidedExceptions([leak], [exception()], dirOf);
    const text = decidedExceptionsSection(decided, 1).join("\n");
    assert.match(text, /^## Decided exceptions to the accuracy check\n/);
    assert.match(text, /The accuracy check found 1 difference, listed under "Accuracy differences" in the report below\. It is decided exception/);
    assert.match(text, /### old-T3-2-c3013f: a transcript mentions scripts\/compare-live/);
    assert.ok(text.includes(`\`${FILE}\``));
    assert.ok(text.includes(`    ${LINE_51}`));
    assert.match(text, /\*\*Classification:\*\* exposure, not access/);
    assert.match(text, /\*\*Decision:\*\* #845 \(task625\), the Consigliere/);
    assert.ok(text.includes(`old-T3-2-c3013f a transcript mentions scripts/compare-live: measured ${JSON.stringify(join(dir, FILE))}, recounted null`));
    assert.deepEqual(decidedExceptionsSection(applyDecidedExceptions([leak], [], dirOf), 1), [], "no section without an exception");
  });
});
