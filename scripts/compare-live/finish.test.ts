/**
 * run.ts --finish: which jobs it takes up, and the proof that a job's sources did not change between its close and
 * evidence copied later (late-evidence.json); verdict.md lists such jobs.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { JobRecord } from "./campaign.ts";
import type { JobMeasure } from "./measure.ts";
import { finishRefusal, lateEvidenceProof } from "./run.ts";
import { lateEvidenceSection } from "./verdict-report.ts";

const SCRATCH = join(import.meta.dirname, `.scratch-finish-${process.pid}`);
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CLOSE = "2026-01-01T01:00:00.000Z";
const before = new Date("2026-01-01T00:30:00Z");

function setup(name: string): { dir: string; record: JobRecord } {
  const dir = join(SCRATCH, name, "job");
  const folder = join(SCRATCH, name, "tally");
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
  writeFileSync(join(folder, "src", "catalog.ts"), "fixed\n");
  writeFileSync(join(folder, ".slow-check.log"), "log\n");
  writeFileSync(join(folder, "node_modules", "x", "index.js"), "ignored\n");
  for (const file of ["src/catalog.ts", ".slow-check.log"]) utimesSync(join(folder, file), before, before);
  const final = join(dir, "snapshots", "07-final");
  cpSync(folder, final, { recursive: true, preserveTimestamps: true, filter: (source) => !source.includes("node_modules") });
  mkdirSync(join(dir, "t3"), { recursive: true });
  writeFileSync(join(dir, "t3", "threads.json"), JSON.stringify([{ threadId: "t", runs: [{ id: "r", requestedAt: "2026-01-01T00:20:00Z", startedAt: null, completedAt: "2026-01-01T00:26:00Z", status: "completed" }] }]));
  mkdirSync(join(dir, "transcripts", "-tally"), { recursive: true });
  writeFileSync(join(dir, "transcripts", "-tally", "s.jsonl"), `${JSON.stringify({ timestamp: "2026-01-01T00:26:00.000Z" })}\n${JSON.stringify({ timestamp: "2026-01-01T00:25:00.000Z" })}\n`);
  const record = { dry: false, status: "aborted", close: "no report", folder, times: { closeAt: CLOSE }, snapshots: [{ kind: "final", dir: final }] } as unknown as JobRecord;
  return { dir, record };
}

describe("run.ts --finish", () => {
  test("only a paid job aborted after its close, with its final copy and no evidence yet", () => {
    const { dir, record } = setup("refusal");
    assert.equal(finishRefusal(record, dir), null);
    assert.match(finishRefusal({ ...record, status: "closed" }, dir) ?? "", /not aborted/);
    assert.match(finishRefusal({ ...record, close: null }, dir) ?? "", /before its window closed/);
    assert.match(finishRefusal({ ...record, snapshots: [] }, dir) ?? "", /no final copy/);
    assert.match(finishRefusal({ ...record, dry: true }, dir) ?? "", /dry/);
    writeFileSync(join(dir, "instance-room.json"), "{}");
    assert.match(finishRefusal(record, dir) ?? "", /evidence is there already/);
  });

  test("the proof: folder equal to the final copy with no file newer than the close, no T3 run and no transcript entry after it", () => {
    const { dir, record } = setup("unchanged");
    const proof = lateEvidenceProof(dir, record);
    assert.equal(proof.unchanged, true, proof.summary);
    assert.deepEqual(proof.folder, { files: 2, differ: [], newestFileTime: "2026-01-01T00:30:00.000Z" });
    assert.deepEqual(proof.runs, { count: 1, requestedAfterClose: 0, lastRequestedAt: "2026-01-01T00:20:00Z", lastCompletedAt: "2026-01-01T00:26:00Z" });
    assert.deepEqual(proof.transcripts, { files: 1, newestEntry: "2026-01-01T00:26:00.000Z", entriesAfterClose: 0 });
  });

  test("any change after the close shows: a file edited, a run requested, a transcript entry", () => {
    const edited = setup("edited");
    writeFileSync(join(edited.record.folder, "src", "catalog.ts"), "changed\n");
    const a = lateEvidenceProof(edited.dir, edited.record);
    assert.equal(a.unchanged, false);
    assert.deepEqual(a.folder.differ, ["src/catalog.ts"]);
    const run = setup("run");
    writeFileSync(join(run.dir, "t3", "threads.json"), JSON.stringify([{ threadId: "t", runs: [{ id: "r2", requestedAt: "2026-01-01T01:05:00Z", startedAt: null, completedAt: null, status: "running" }] }]));
    assert.equal(lateEvidenceProof(run.dir, run.record).runs.requestedAfterClose, 1);
    assert.equal(lateEvidenceProof(run.dir, run.record).unchanged, false);
    const entry = setup("entry");
    writeFileSync(join(entry.dir, "transcripts", "-tally", "s.jsonl"), `${JSON.stringify({ timestamp: "2026-01-01T01:00:01.000Z" })}\n`);
    assert.equal(lateEvidenceProof(entry.dir, entry.record).transcripts.entriesAfterClose, 1);
    assert.equal(lateEvidenceProof(entry.dir, entry.record).unchanged, false);
  });

  test("verdict.md lists the jobs whose evidence was completed later, with the proof", () => {
    const job = { side: "new", task: "T3", run: 1, jobId: "1494f5" } as unknown as JobRecord;
    const late = { closeAt: CLOSE, completedAt: "2026-01-01T02:00:00Z", decision: "board #677", unchanged: true, summary: "nothing changed after the close: …" };
    const lines = lateEvidenceSection([{ job, measure: {} as JobMeasure, room: null, late }]).join("\n");
    assert.match(lines, /\*\*new T3#1 1494f5\*\*: closed 2026-01-01T01:00:00.000Z, evidence completed 2026-01-01T02:00:00Z \(board #677\)\. Nothing changed after the close/);
    assert.match(lateEvidenceSection([{ job, measure: {} as JobMeasure, room: null, late: null }]).join("\n"), /None: every job's evidence was copied at its close/);
  });
});
