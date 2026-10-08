/**
 * The hard cap: the runner adds up the campaign's measured spend before each job and starts none once it has reached
 * the cap. A scripted campaign of $45 jobs under a $100 cap runs three and refuses the fourth.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

const SCRATCH = join(import.meta.dirname, `.scratch-${process.pid}`);
process.env.COMPARE_EVIDENCE = SCRATCH;
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test("a scripted over-budget campaign is stopped by the cap", async () => {
  const { capGate } = await import("./run.ts");
  const { jobsDir } = await import("./campaign.ts");
  const spend = new Map<string, number>();
  const started: string[] = [];
  for (const job of ["T1:1", "T2:1", "T3:1", "T4:1", "T1:2"]) {
    const gate = capGate("scripted", 100, (record) => spend.get(record.jobId) ?? 0);
    if (!gate.allowed) break;
    // The job runs and spends $45 (seating included), recorded where the runner records it.
    const jobId = `job${started.length + 1}`;
    mkdirSync(join(jobsDir("scripted"), jobId), { recursive: true });
    writeFileSync(join(jobsDir("scripted"), jobId, "job.json"), JSON.stringify({ jobId, seats: [], childThreads: [] }));
    spend.set(jobId, 45);
    started.push(job);
  }
  assert.deepEqual(started, ["T1:1", "T2:1", "T3:1"]);
  assert.deepEqual(capGate("scripted", 100, (record) => spend.get(record.jobId) ?? 0), { spent: 135, allowed: false });
});

test("spend exactly at the cap stops the next job; just under it does not", async () => {
  const { capCheck } = await import("./campaign.ts");
  assert.deepEqual(capCheck([60, 40], 100), { spent: 100, allowed: false });
  assert.equal(capCheck([60, 39.5], 100).allowed, true);
});
