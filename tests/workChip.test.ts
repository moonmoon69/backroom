/** A status bar chip's hover, for a member between turns: its jobs, as T3 lists them, whole. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobsLine } from "../web/src/memberActivity.ts";
import { chipTitle } from "../web/src/workChip.ts";
import type { BackgroundTask, Desk } from "../web/src/types.ts";

const now = Date.parse("2026-10-27T12:00:00Z");
const job = (title: string, kind: string, type: string | null, minutes: number): BackgroundTask => {
  const at = new Date(now - minutes * 60_000).toISOString();
  return { taskId: title, title, kind, type, detail: null, lastTool: null, startedAt: at, updatedAt: at };
};
const desk = (jobs: BackgroundTask[]): Desk => ({ backgroundTasks: jobs }) as Desk;

test("a background chip's hover names each job with its kind and minutes", () => {
  const line = jobsLine(desk([job("Run the gate test", "background", "command", 1), job("Review", "agent", "subagent", 3), job("Watch CI", "background", "monitor", 0)]), now);
  assert.equal(chipTitle("worker", "subagents running", line), "worker · subagents running: Run the gate test (command, 1m) · Review (subagent, 3m) · Watch CI (monitor, 1m)");
  assert.equal(chipTitle("worker", "background work", jobsLine(desk([]), now)), "worker · background work: will continue when it finishes");
});

test("a long list of jobs stays whole in the hover: the chip opens nothing, so nowhere else shows the rest", () => {
  const titles = Array.from({ length: 7 }, (_, n) => `gate-${n}-${"checking-the-parser-".repeat(3)}${n === 6 ? "END_OF_LAST_JOB" : ""}`);
  const title = chipTitle("worker", "background work", jobsLine(desk(titles.map((t) => job(t, "background", "command", 2))), now));
  assert.ok(title.length > 400, `the case is longer than the old 400-character cap (${title.length})`);
  for (const t of titles) assert.ok(title.includes(`${t} (command, 2m)`), `the hover names ${t}`);
  assert.ok(title.endsWith("END_OF_LAST_JOB (command, 2m)"));
});
