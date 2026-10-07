/**
 * The premature-answer check, the way the runner applies it: a copy of the job folder at each member answer and at
 * the JOB-DONE report, the task's checker on the copy (run.ts's checkInputFor), and measure.ts's reading of the result.
 * A scripted job answers early, then right.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Snapshot } from "./campaign.ts";
import { FIXTURE_TEMPLATE, REFERENCE_DIR, checkTask, type TaskId } from "./checkers.ts";
import { earlyAnswersOf, isPremature } from "./measure.ts";
import { checkInputFor, ownPartsFor } from "./run.ts";

const SCRATCH = join(import.meta.dirname, `.scratch-${process.pid}`);
before(() => mkdirSync(SCRATCH, { recursive: true }));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let copies = 0;
/** A copy of the fixture as a job folder would be at some moment, with these reference files applied. */
function copyAt(task: TaskId, withReference: boolean): string {
  const dir = join(SCRATCH, `copy-${(copies += 1)}`);
  cpSync(FIXTURE_TEMPLATE, dir, { recursive: true });
  if (withReference) cpSync(join(REFERENCE_DIR, task), dir, { recursive: true, filter: (source) => !source.endsWith(".md") && !source.endsWith("slow-check.log") });
  return dir;
}

async function snapshot(task: TaskId, kind: Snapshot["kind"], role: string, dir: string, post: { text: string; at: string }, report: { text: string; at: string } | null): Promise<Snapshot> {
  const entry: Snapshot = { kind, alias: role, postId: null, at: post.at, observedAt: post.at, dir, check: await checkTask(task, checkInputFor(task, kind, dir, post, report?.text ?? null, report?.at ?? null)) };
  if (kind === "answer") {
    entry.ownParts = ownPartsFor(task, role);
    if (entry.ownParts.length > 0) entry.ownPass = entry.ownParts.every((part) => entry.check.parts[part]?.pass === true);
  }
  return entry;
}

describe("T2: W1 answers before fixing the second defect", () => {
  test("the early answer is flagged; a report on the same tree is premature", async () => {
    const early = copyAt("T2", false);
    const answer = await snapshot("T2", "answer", "W1", early, { text: "Fixed the failing test.", at: "2026-10-08T10:05:00.000Z" }, null);
    assert.equal(answer.ownPass, false);
    const report = await snapshot("T2", "report", "C", early, { text: "Fixed.\nJOB-DONE", at: "2026-10-08T10:06:00.000Z" }, null);
    assert.equal(isPremature([answer, report]), true);
    assert.deepEqual(earlyAnswersOf([answer, report]).map((a) => a.alias), ["W1"]);
  });

  test("on the fixed tree neither is flagged; V's answer is never checked", async () => {
    const fixed = copyAt("T2", true);
    const review = await snapshot("T2", "answer", "V", fixed, { text: "PASS", at: "2026-10-08T10:07:00.000Z" }, null);
    assert.deepEqual(review.ownParts, []);
    assert.equal(review.ownPass, undefined);
    assert.deepEqual(ownPartsFor("T1", "V"), []);
    assert.deepEqual(ownPartsFor("T1", "W2"), ["facts"]);
    const answer = await snapshot("T2", "answer", "W1", fixed, { text: "Both fixed.", at: "2026-10-08T10:08:00.000Z" }, null);
    const report = await snapshot("T2", "report", "C", fixed, { text: "Done.\nJOB-DONE", at: "2026-10-08T10:09:00.000Z" }, null);
    assert.equal(isPremature([review, answer, report]), false);
    assert.deepEqual(earlyAnswersOf([review, answer, report]), []);
  });
});

describe("T3: a report while slow-check is still running", () => {
  test("is premature even though the catalog is already fixed", async () => {
    const dir = copyAt("T3", true);
    writeFileSync(join(dir, ".slow-check.log"), "2026-10-08T10:00:00.000Z start 100\n2026-10-08T10:03:00.000Z finish fail 100 2 problems\n2026-10-08T10:04:00.000Z start 200\n2026-10-08T10:07:00.000Z finish pass 200\n");
    const before = await snapshot("T3", "report", "C", dir, { text: "slow-check passes.\nJOB-DONE", at: "2026-10-08T10:05:00.000Z" }, null);
    assert.equal(before.check.parts.catalog?.pass, true);
    assert.equal(before.check.parts.slowCheckLog?.pass, false);
    assert.equal(isPremature([before]), true);
    const afterFinish = await snapshot("T3", "report", "C", dir, { text: "slow-check passes.\nJOB-DONE", at: "2026-10-08T10:07:30.000Z" }, null);
    assert.equal(isPremature([afterFinish]), false);
  });
});

describe("T1 and T4: text checks", () => {
  test("a T1 report without the unused import is premature; a member's T1 answer is judged on its own text", async () => {
    const report = await snapshot("T1", "report", "C", "", { text: "cli.ts imports node:fs, args, text, format, dates, legacy and types; all are used.\nJOB-DONE", at: "2026-10-08T10:05:00.000Z" }, null);
    assert.equal(isPremature([report]), true);
    const answer = await snapshot("T1", "answer", "W1", "", { text: "Imports: node:fs, args, text, format, dates, legacy, types.", at: "2026-10-08T10:04:00.000Z" }, null);
    assert.equal(answer.ownPass, false);
    assert.equal(earlyAnswersOf([answer], "T1").length, 1);
    // A member that has given the facts and later writes again ("nothing left to do") is not answering early.
    const facts = await snapshot("T1", "answer", "W1", "", { text: "Imports: node:fs, args, text, format, dates, legacy, types. legacy is unused: src/cli.ts:6", at: "2026-10-08T10:05:00.000Z" }, null);
    const later = await snapshot("T1", "answer", "W1", "", { text: "Nothing left to do on this job.", at: "2026-10-08T10:07:00.000Z" }, null);
    assert.deepEqual(earlyAnswersOf([facts, later], "T1"), []);
  });

  test("a T4 member's answer is judged on the folder only; the report must also cover both features", async () => {
    const dir = copyAt("T4", true);
    const w2 = await snapshot("T4", "answer", "W2", dir, { text: "added --json", at: "2026-10-08T10:04:00.000Z" }, null);
    assert.deepEqual(w2.ownParts, ["json"]);
    assert.equal(w2.ownPass, true);
    assert.equal(w2.check.parts.reportCoversBoth, undefined);
    const thin = await snapshot("T4", "report", "C", dir, { text: "All done.\nJOB-DONE", at: "2026-10-08T10:06:00.000Z" }, null);
    assert.equal(isPremature([thin]), true);
    const full = await snapshot("T4", "report", "C", dir, { text: "W1 added slugify, W2 added the --json flag; V passed both.\nJOB-DONE", at: "2026-10-08T10:06:00.000Z" }, null);
    assert.equal(isPremature([full]), false);
  });
});
