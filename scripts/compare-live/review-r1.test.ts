/**
 * The fixes from R0's review, round 1: the cap fails closed and is registered (R4), --verify sees a missing thread (R3),
 * a leak (R6b), a report copy newer than T3's report (R5), orphan or untimed transcripts (S3), and it gates the
 * registration and the verdict (R2); no-report runs in the gate (S5).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { JobRecord, Snapshot } from "./campaign.ts";
import { GATE_RULES, chooseNK, compareCell, spread, type GateRun, type Metric } from "./gate.ts";
import { VERDICT_LIMITS, measureJob, reportCopyChecks, verifyJob } from "./measure.ts";
import { campaignCap, capGate, jobSpend, liveCosts } from "./run.ts";

const SAMPLE = join(import.meta.dirname, "testdata", "job");
const SCRATCH = join(import.meta.dirname, `.scratch-${process.pid}`);
const RATES = join(SCRATCH, "rates.json");

/** A fresh copy of the sample job with its state rows built. */
function sampleJob(name: string): string {
  const dir = join(SCRATCH, name);
  cpSync(SAMPLE, dir, { recursive: true });
  execFileSync("sqlite3", [join(dir, "t3", "state-subset.sqlite"), `.read ${join(dir, "t3", "state.sql")}`]);
  return dir;
}
const job = (dir: string) => JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(RATES, JSON.stringify({ document: { "claude-opus-5-5": { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6 } } }));
});
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("R4: the cap", () => {
  test("the real jobSpend path prices the sample and the cap refuses once it is reached", () => {
    const dir = sampleJob("cap");
    const costs = liveCosts({ stateDb: join(dir, "t3", "state-subset.sqlite"), projectsDir: join(dir, "transcripts"), ratesPath: RATES });
    const spent = jobSpend(job(dir), costs);
    // By hand from the sample's seven calls (seating included): input 19, cache read 62500, cache write 46000, output 2730.
    const expected = 19 * 4e-6 + 62500 * 2e-7 + 46000 * 5e-6 + 2730 * 2e-5;
    assert.ok(Math.abs(spent - expected) < 1e-9, `${spent} vs ${expected}`);
  });

  test("an unreadable price table or an unpriced model throws instead of costing $0", () => {
    const dir = sampleJob("cap-closed");
    assert.throws(() => liveCosts({ stateDb: join(dir, "t3", "state-subset.sqlite"), projectsDir: join(dir, "transcripts"), ratesPath: join(SCRATCH, "missing.json") }), /no price table/);
    writeFileSync(join(SCRATCH, "other-rates.json"), JSON.stringify({ document: { "some-other-model": { input_cost_per_token: 1e-6 } } }));
    const costs = liveCosts({ stateDb: join(dir, "t3", "state-subset.sqlite"), projectsDir: join(dir, "transcripts"), ratesPath: join(SCRATCH, "other-rates.json") });
    assert.throws(() => jobSpend(job(dir), costs), /no price for model claude-opus-5-5/);
  });

  const r0 = join(import.meta.dirname, "..", "..", "..", "..", "backroom-handoff", "compare-live", "r0", "jobs");
  test("capGate on R0's own jobs with the live strict reader: what was spent, and a lower cap refuses", { skip: !existsSync(r0) }, () => {
    const costs = liveCosts();
    const at100 = capGate("r0", 100, (record) => jobSpend(record, costs));
    assert.ok(at100.spent > 20 && at100.spent < 30, String(at100.spent));
    assert.equal(at100.allowed, true);
    assert.equal(capGate("r0", 20, (record) => jobSpend(record, costs)).allowed, false);
  });

  test("the cap comes from the registration: R0 $100; other campaigns gate.json's fromR0.z1CapUsd; more needs --user-ok", () => {
    const gatePath = join(SCRATCH, "gate.json");
    writeFileSync(gatePath, JSON.stringify({ fromR0: { z1CapUsd: 82.2 } }));
    assert.equal(campaignCap("r0", null, null, gatePath), 100);
    assert.throws(() => campaignCap("r0", 120, null, gatePath), /--user-ok/);
    assert.equal(campaignCap("z1", null, null, gatePath), 82.2);
    assert.equal(campaignCap("z1", 50, null, gatePath), 50);
    assert.throws(() => campaignCap("z1", 90, null, gatePath), /--user-ok/);
    assert.equal(campaignCap("z1", 90, "#400", gatePath), 90);
    assert.throws(() => campaignCap("z1", null, null, join(SCRATCH, "none.json")), /no registered cap/);
  });
});

describe("--verify guards", () => {
  test("R3: a job thread without a record fails", () => {
    const dir = sampleJob("missing-thread");
    const threads = JSON.parse(readFileSync(join(dir, "t3", "threads.json"), "utf8")) as Array<{ threadId: string }>;
    writeFileSync(join(dir, "t3", "threads.json"), JSON.stringify(threads.filter((t) => !t.threadId.startsWith("2222"))));
    const differences = verifyJob(dir, measureJob(dir, { liveStateDb: null }));
    assert.ok(differences.some((d) => /has no T3 record/.test(d.what)), JSON.stringify(differences));
  });

  test("R6b: a transcript that mentions the harness, the evidence, the fixture or another job's folder fails", () => {
    for (const [index, mention] of ["cat scripts/compare-live/checkers.ts", "ls /home/u/Projects/backroom-handoff", "cd /home/u/Projects/backroom-compare/fixture", "ls /home/u/Projects/backroom-compare/jobs/abc123/tally"].entries()) {
      const dir = sampleJob(`leak-${index}`);
      appendFileSync(join(dir, "transcripts", "-sample-tally", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-10-08T10:02:30.000Z", message: { role: "user", content: mention } })}\n`);
      const differences = verifyJob(dir, measureJob(dir, { liveStateDb: null }));
      assert.ok(differences.some((d) => /a transcript mentions/.test(d.what)), mention);
    }
  });

  test("S3: a transcript of no job thread, and a usage copy without a timestamp, fail", () => {
    const dir = sampleJob("orphan");
    writeFileSync(join(dir, "transcripts", "-sample-tally", "cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl"), "\n");
    appendFileSync(join(dir, "transcripts", "-sample-tally", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"), `${JSON.stringify({ type: "assistant", message: { id: "msg_untimed", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
    const differences = verifyJob(dir, measureJob(dir, { liveStateDb: null }));
    assert.ok(differences.some((d) => /belongs to no job thread/.test(d.what)));
    assert.ok(differences.some((d) => /without a readable timestamp/.test(d.what)));
  });

  test("R5: a report copy with a file newer than T3's report fails; the tree as at the report passes", () => {
    const copy = join(SCRATCH, "r5", "report");
    mkdirSync(join(copy, "src"), { recursive: true });
    writeFileSync(join(copy, "src", "dates.ts"), "x");
    const at = "2026-10-08T10:20:00.000Z";
    utimesSync(join(copy, "src", "dates.ts"), new Date("2026-10-08T10:19:00Z"), new Date("2026-10-08T10:19:00Z"));
    const snapshot: Snapshot = { kind: "report", alias: "C", postId: null, at: "2026-10-08T10:20:30.000Z", observedAt: "2026-10-08T10:20:31.000Z", dir: copy, check: { pass: true, parts: {} } };
    const record = { task: "T2", dry: false, copiesKeepTimes: true, snapshots: [snapshot] } as unknown as JobRecord;
    assert.deepEqual(reportCopyChecks(record, "j", at), []);
    utimesSync(join(copy, "src", "dates.ts"), new Date("2026-10-08T10:20:10Z"), new Date("2026-10-08T10:20:10Z"));
    assert.match(reportCopyChecks(record, "j", at)[0]?.what ?? "", /changed after T3's report/);
  });

  test("R2: registering the gate or giving a verdict refuses while the accuracy check finds a difference", () => {
    const evidence = join(SCRATCH, "evidence");
    const dir = join(evidence, "sample", "jobs", "old-T1-1-sample");
    mkdirSync(join(evidence, "sample", "jobs"), { recursive: true });
    cpSync(sampleJob("r2"), dir, { recursive: true });
    appendFileSync(join(dir, "transcripts", "-sample-tally", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-10-08T10:02:30.000Z", message: { role: "user", content: "cat scripts/compare-live/checkers.ts" } })}\n`);
    for (const flag of ["--register-gate", "--verdict"]) {
      const run = spawnSync(process.execPath, ["--no-warnings", join(import.meta.dirname, "measure.ts"), "--campaign", "sample", flag], { env: { ...process.env, COMPARE_EVIDENCE: evidence }, encoding: "utf8" });
      assert.notEqual(run.status, 0, flag);
      assert.match(run.stderr, /accuracy check found 1 differences/, flag);
    }
    assert.match(readFileSync(join(evidence, "sample", "report.md"), "utf8"), /\*\*1 differences\*\*/);
  });
});

describe("S5: runs without a report", () => {
  const run = (task: GateRun["task"], side: GateRun["side"], wall: number | null): GateRun => ({ task, side, correct: wall !== null, premature: false, metrics: { wakes: 2, tokens: 100, turns: 5, wallToReportMs: wall } });
  test("a missing wall-clock is the worst value; one missing makes the spread unbounded, two make it 1", () => {
    assert.equal(compareCell([20_000, Number.POSITIVE_INFINITY], [30_000, 40_000]), "neither");
    assert.equal(compareCell([Number.POSITIVE_INFINITY], [30_000]), "worse");
    const one = spread([run("T3", "old", null), run("T3", "old", 600_000)]);
    assert.equal(one.T3?.wallToReportMs, Number.POSITIVE_INFINITY);
    const two = spread([run("T3", "old", null), run("T3", "old", null)]);
    assert.equal(two.T3?.wallToReportMs, 1);
    assert.deepEqual(chooseNK({ T3: one.T3 as Record<Metric, number>, T4: { wakes: 1, tokens: 1, turns: 1, wallToReportMs: 1 } }).wideTasks, ["T3"]);
  });

  test("gate.json's fromR0 matches the R0 report it was registered from", { skip: !existsSync(join(import.meta.dirname, "..", "..", "..", "..", "backroom-handoff", "compare-live", "r0", "report.json")) }, () => {
    const gate = JSON.parse(readFileSync(join(import.meta.dirname, "gate.json"), "utf8")) as { N: number; K: number; fromR0: { spread: Record<string, Record<string, number | string>>; medianJobUsd: number; z1CapUsd: number } };
    const report = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "backroom-handoff", "compare-live", "r0", "report.json"), "utf8")) as { measures: Array<{ side: string; task: GateRun["task"]; correct: boolean; premature: boolean; metrics: Record<Metric, number | null>; spend: { totalUsd: number } }> };
    const old = report.measures.filter((m) => m.side === "old");
    const bySpread = spread(old.map((m) => ({ task: m.task, side: "old", correct: m.correct, premature: m.premature, metrics: m.metrics })));
    for (const [task, row] of Object.entries(bySpread)) for (const [metric, v] of Object.entries(row)) assert.equal(gate.fromR0.spread[task]?.[metric], Number.isFinite(v) ? v : "unbounded", `${task} ${metric}`);
    const sorted = old.map((m) => m.spend.totalUsd).sort((a, b) => a - b);
    const median = ((sorted[3] as number) + (sorted[4] as number)) / 2;
    assert.ok(Math.abs(gate.fromR0.medianJobUsd - median) < 1e-9);
    assert.ok(Math.abs(gate.fromR0.z1CapUsd - 1.5 * 24 * median) < 1e-9);
    assert.deepEqual([gate.N, gate.K], [3, 2]);
    assert.deepEqual(GATE_RULES.primary, ["wakes", "tokens"]);
  });
});

describe("the verdict's limits", () => {
  test("every verdict carries the plan's limits and T2's rule as the user decided it", () => {
    assert.equal(VERDICT_LIMITS.length, 8);
    assert.ok(VERDICT_LIMITS.some((l) => /V's review comes before the report/.test(l) && /mostly measures the review exchange/.test(l)));
    assert.ok(VERDICT_LIMITS.some((l) => /Small N/.test(l)));
    assert.ok(VERDICT_LIMITS.some((l) => /Claude only/.test(l)));
  });
});
