import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, endOfMonth, formatDate, parseDate } from "../src/dates.ts";

test("parseDate reads year, month and day", () => {
  assert.deepEqual(parseDate("2026-07-04"), { year: 2026, month: 7, day: 4 });
});

test("parseDate rejects malformed dates", () => {
  assert.throws(() => parseDate("2026-7-4"), RangeError);
  assert.throws(() => parseDate("2026-13-01"), RangeError);
  assert.throws(() => parseDate("2026-05-00"), RangeError);
  assert.throws(() => parseDate("July 4"), RangeError);
});

test("formatDate pads month and day", () => {
  assert.equal(formatDate({ year: 2026, month: 3, day: 9 }), "2026-03-09");
  assert.equal(formatDate(parseDate("2026-11-30")), "2026-11-30");
});

test("endOfMonth returns the last day of the month", () => {
  assert.equal(endOfMonth("2026-04-10"), "2026-04-30");
  assert.equal(endOfMonth("2026-01-15"), "2026-01-31");
});

test("addMonths keeps the day of the month", () => {
  assert.equal(addMonths("2026-03-15", 1), "2026-04-15");
  assert.equal(addMonths("2027-03-10", -4), "2026-11-10");
});
