/**
 * A provider's usage windows grouped for its header line (web/src/usageFamilies.ts): windows that share a family before
 * " · " are one row, the family once and each window by the part after it; a window with no sibling stays whole.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageRows, type UsageRow } from "../web/src/usageFamilies.ts";
import type { UsageWindow } from "../web/src/types.ts";

const window = (id: string, label: string): UsageWindow => ({ id, label, usedPercent: 10, resetsAt: null });

/** A row as words: a window by its label, a family as "Family: short, short" with the window ids. */
const words = (rows: UsageRow[]): string[] =>
  rows.map((row) => (row.kind === "window" ? row.window.label : `${row.family}: ${row.windows.map(({ window, short }) => `${short}=${window.id}`).join(", ")}`));

test("Antigravity's four windows are two family rows, each window by its short label, in the order reported", () => {
  const rows = usageRows([
    window("3p-5h", "Claude & GPT (shared) · 5-hour"),
    window("gemini-5h", "Gemini · 5-hour"),
    window("3p-weekly", "Claude & GPT (shared) · Weekly"),
    window("gemini-weekly", "Gemini · Weekly"),
  ]);
  assert.deepEqual(words(rows), ["Claude & GPT (shared): 5-hour=3p-5h, Weekly=3p-weekly", "Gemini: 5-hour=gemini-5h, Weekly=gemini-weekly"]);
});

test("Claude's three windows stay as they are: 'Weekly · Fable' has no sibling and stays whole", () => {
  const claude = [window("five_hour", "Session"), window("seven_day", "Weekly"), window("seven_day_fable", "Weekly · Fable")];
  const rows = usageRows(claude);
  assert.ok(rows.every((row) => row.kind === "window"));
  assert.deepEqual(words(rows), ["Session", "Weekly", "Weekly · Fable"]);
});

test("a single window stays whole, with or without a family in its label", () => {
  assert.deepEqual(words(usageRows([window("primary", "Weekly")])), ["Weekly"]);
  assert.deepEqual(words(usageRows([window("gemini-5h", "Gemini · 5-hour")])), ["Gemini · 5-hour"]);
  assert.deepEqual(usageRows([]), []);
});

test("a family sits where its first window is; a lone window between stays in place", () => {
  const rows = usageRows([window("a", "Session"), window("g5", "Gemini · 5-hour"), window("f", "Weekly · Fable"), window("gw", "Gemini · Weekly")]);
  assert.deepEqual(words(rows), ["Session", "Gemini: 5-hour=g5, Weekly=gw", "Weekly · Fable"]);
});

test("a label with two ' · ' splits at the first: the family is what comes before it", () => {
  const rows = usageRows([window("a", "Gemini · Pro · 5-hour"), window("b", "Gemini · Weekly"), window("c", "Pro · Weekly · Max")]);
  assert.deepEqual(words(rows), ["Gemini: Pro · 5-hour=a, Weekly=b", "Pro · Weekly · Max"]);
});

test("the meters keep their windows whole: the full label stays for the tooltip, the short one is apart", () => {
  const gemini = window("gemini-5h", "Gemini · 5-hour");
  const [row] = usageRows([gemini, window("gemini-weekly", "Gemini · Weekly")]);
  assert.ok(row?.kind === "family");
  assert.equal(row.windows[0]!.window, gemini, "the window itself, not a copy with a shortened label");
  assert.equal(row.windows[0]!.window.label, "Gemini · 5-hour");
  assert.equal(row.windows[0]!.short, "5-hour");
});

test("a label with nothing before or after ' · ' has no family", () => {
  assert.deepEqual(words(usageRows([window("a", " · Weekly"), window("b", " · 5-hour"), window("c", "Gemini · "), window("d", "Gemini · ")])), [" · Weekly", " · 5-hour", "Gemini · ", "Gemini · "]);
});
