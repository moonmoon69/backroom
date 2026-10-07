/**
 * Hidden check for T2, defect 1 (month-end off by one): month lengths, month-end and month arithmetic in the copy at
 * FIXTURE_DIR, in years where the leap-year rule does not matter.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

interface DatesModule {
  daysInMonth(year: number, month: number): number;
  endOfMonth(isoDate: string): string;
  addMonths(isoDate: string, months: number): string;
}

const dir = process.env.FIXTURE_DIR;
if (!dir) throw new Error("FIXTURE_DIR is not set");
const dates = (await import(pathToFileURL(join(dir, "src/dates.ts")).href)) as DatesModule;

test("daysInMonth knows every month of 2026", () => {
  const expected = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const [index, days] of expected.entries()) {
    assert.equal(dates.daysInMonth(2026, index + 1), days, `month ${index + 1} of 2026`);
  }
});

test("endOfMonth returns the last day of the month", () => {
  assert.equal(dates.endOfMonth("2026-01-15"), "2026-01-31");
  assert.equal(dates.endOfMonth("2026-04-10"), "2026-04-30");
  assert.equal(dates.endOfMonth("2026-06-01"), "2026-06-30");
  assert.equal(dates.endOfMonth("2026-09-30"), "2026-09-30");
  assert.equal(dates.endOfMonth("2026-12-05"), "2026-12-31");
});

test("addMonths clamps the day to the target month", () => {
  assert.equal(dates.addMonths("2026-01-31", 2), "2026-03-31");
  assert.equal(dates.addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(dates.addMonths("2026-05-31", -1), "2026-04-30");
});
