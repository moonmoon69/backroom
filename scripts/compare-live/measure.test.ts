/**
 * measure.ts and rawsum.mjs on a committed sample job (testdata/job): two seats, a message id repeated within a
 * transcript and again in a subagent transcript, a seating call before the post and a job window after it. The
 * expected totals are written by hand from the sample lines.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { measureJob, verifyJob } from "./measure.ts";

const SAMPLE = join(import.meta.dirname, "testdata", "job");
const SCRATCH = join(import.meta.dirname, `.scratch-${process.pid}`);
const JOB = join(SCRATCH, "job");
const C = "11111111-1111-4111-8111-111111111111";
const W = "22222222-2222-4222-8222-222222222222";

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(SAMPLE, JOB, { recursive: true });
  execFileSync("sqlite3", [join(JOB, "t3", "state-subset.sqlite"), `.read ${join(JOB, "t3", "state.sql")}`]);
});
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const rawsum = (thread: string, from: string, to: string) =>
  JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "rawsum.mjs"), join(JOB, "t3", "state-subset.sqlite"), join(JOB, "transcripts"), thread, from, to], { encoding: "utf8" })) as Record<string, number>;

// By hand: the Consigliere's job window has msg_c1 once (it repeats in its own file and in the subagent's), msg_c2 and
// the subagent's msg_s1; his seating window msg_c0. W1: msg_w1 in the window, msg_w0 in seating.
const EXPECTED = {
  consigliere: { input: 2 + 1 + 5, cacheRead: 20000 + 21500, cacheWrite: 1500 + 800 + 3000, output: 300 + 250 + 400 },
  consigliereSeating: { input: 3, cacheRead: 0, cacheWrite: 20000, output: 100 },
  w1: { input: 4, cacheRead: 18000, cacheWrite: 2500, output: 900 },
  w1Seating: { input: 3, cacheRead: 0, cacheWrite: 18000, output: 80 },
};
const POSTED = "2026-10-08T10:00:00.000Z";
const BEFORE_POST = "2026-10-08T09:59:59.999Z";
const CLOSE = "2026-10-08T10:30:00.000Z";
const four = (t: { input: number; cacheRead: number; cacheWrite: number; output: number } | null) => (t ? { input: t.input, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output } : null);

describe("tokens", () => {
  test("rawsum.mjs gives the hand totals, the repeated message id counted once", () => {
    const { messages: _c, ...consigliere } = rawsum(C, POSTED, CLOSE);
    assert.deepEqual(consigliere, EXPECTED.consigliere);
    const { messages: _s, ...seating } = rawsum(C, "1970-01-01T00:00:00.000Z", BEFORE_POST);
    assert.deepEqual(seating, EXPECTED.consigliereSeating);
    const { messages: _w, ...w1 } = rawsum(W, POSTED, CLOSE);
    assert.deepEqual(w1, EXPECTED.w1);
  });

  test("measure.ts gives the same totals per seat, with seating apart", () => {
    const measured = measureJob(JOB, { liveStateDb: null });
    const c = measured.seats.find((s) => s.threadId === C);
    const w = measured.seats.find((s) => s.threadId === W);
    assert.deepEqual(four(c?.tokens ?? null), EXPECTED.consigliere);
    assert.deepEqual(four(c?.seating ?? null), EXPECTED.consigliereSeating);
    assert.deepEqual(four(w?.tokens ?? null), EXPECTED.w1);
    assert.deepEqual(four(w?.seating ?? null), EXPECTED.w1Seating);
    const total = Object.values(EXPECTED.consigliere).reduce((a, b) => a + b, 0) + Object.values(EXPECTED.w1).reduce((a, b) => a + b, 0);
    assert.equal(measured.metrics.tokens, total);
  });

  test("turns, wakes, wall-clock and briefing bytes from T3's records", () => {
    const measured = measureJob(JOB, { liveStateDb: null });
    assert.equal(measured.metrics.turns, 3);
    assert.equal(measured.metrics.wakes, 1);
    assert.equal(measured.wakesAfterReport, 0);
    // The report is the Consigliere's final message with the JOB-DONE line, at 10:20:00 in T3.
    assert.equal(measured.times.reportAt, "2026-10-08T10:20:00.000Z");
    assert.equal(measured.metrics.wallToReportMs, 20 * 60_000);
    assert.equal(measured.seats.find((s) => s.threadId === W)?.seatingTurns, 1);
    assert.deepEqual(measured.seats.find((s) => s.threadId === C)?.briefingBytes, [9, Buffer.byteLength("wake: W1 answered ✓")]);
    assert.equal(measured.subagentRan, true);
    assert.equal(measured.correct, true);
    assert.equal(measured.premature, false);
  });

  test("--verify finds no difference on the sample, and finds one when a transcript changes", () => {
    const measured = measureJob(JOB, { liveStateDb: null });
    assert.deepEqual(verifyJob(JOB, measured), []);
    appendFileSync(
      join(JOB, "transcripts", "-sample-tally", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
      `${JSON.stringify({ type: "assistant", timestamp: "2026-10-08T10:10:00.000Z", requestId: "req_extra", message: { id: "msg_extra", model: "claude-opus-5-5", usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 1 } } })}\n`,
    );
    const differences = verifyJob(JOB, measured);
    assert.equal(differences.length, 1);
    assert.match(differences[0]?.what ?? "", /tokens @W1 \(job window\)/);
  });
});
