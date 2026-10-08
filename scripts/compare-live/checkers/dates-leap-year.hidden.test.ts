/**
 * Hidden check for T2, defect 2 (leap years): the Gregorian century rule in the copy at FIXTURE_DIR. 1900 and 2100
 * are not leap years; 2000 is.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

interface DatesModule {
  daysInMonth(year: number, month: number): number;
  endOfMonth(isoDate: string): string;
}

const dir = process.env.FIXTURE_DIR;
if (!dir) throw new Error("FIXTURE_DIR is not set");
const dates = (await import(pathToFileURL(join(dir, "src/dates.ts")).href)) as DatesModule;

test("daysInMonth applies the century rule to February", () => {
  assert.equal(dates.daysInMonth(1900, 2), 28, "1900 is not a leap year");
  assert.equal(dates.daysInMonth(2000, 2), 29, "2000 is a leap year");
  assert.equal(dates.daysInMonth(2100, 2), 28, "2100 is not a leap year");
  assert.equal(dates.daysInMonth(2024, 2), 29, "2024 is a leap year");
  assert.equal(dates.daysInMonth(2023, 2), 28, "2023 is not a leap year");
});

test("endOfMonth finds the end of February in century years", () => {
  assert.equal(dates.endOfMonth("2100-02-03"), "2100-02-28");
  assert.equal(dates.endOfMonth("2000-02-10"), "2000-02-29");
});
