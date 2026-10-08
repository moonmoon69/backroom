/**
 * The page's keys (web/src/keys.ts): the overview's reading order and where each arrow goes from an item, on layouts
 * as the overview draws them (tiles stacked per column), and the shortcuts the page shows with ? listed in README.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inReadingOrder, KEYS, readingTarget, type NavKey, type Placed } from "../web/src/keyOrder.ts";

/** An item: its key, section, column (left edge) and top; 30 px tall. */
const at = (key: string, section: number, column: number, top: number): Placed<string> => ({ element: key, section, column, top, middle: top + 15 });

/**
 * Four tiles ranked first to fourth on three columns, as ProjectTiles places them: the fourth under the first. Room A has
 * two members; then a crew section of two tiles side by side.
 */
const page: Placed<string>[] = [
  at("room:A", 0, 0, 100),
  at("member:A:1", 0, 0, 140),
  at("member:A:2", 0, 0, 180),
  at("room:B", 0, 400, 100),
  at("member:B:1", 0, 400, 140),
  at("thread:C", 0, 800, 100),
  at("room:D", 0, 0, 240),
  at("member:D:1", 0, 0, 280),
  at("preset:x", 1, 0, 400),
  at("preset:y", 1, 300, 400),
];

const move = (from: string, key: NavKey): string | null => {
  const order = inReadingOrder(page);
  return readingTarget(order, order.findIndex((p) => p.element === from), key)?.element ?? null;
};

test("Down and Up read the overview column by column, each top to bottom, section by section", () => {
  assert.deepEqual(
    inReadingOrder(page).map((p) => p.element),
    ["room:A", "member:A:1", "member:A:2", "room:D", "member:D:1", "room:B", "member:B:1", "thread:C", "preset:x", "preset:y"],
  );
  // From the first tile's last member, Down goes to the tile under it (the fourth), not to the second in rank.
  assert.equal(move("member:A:2", "down"), "room:D");
  assert.equal(move("member:D:1", "down"), "room:B");
  assert.equal(move("room:B", "up"), "member:D:1");
  assert.equal(move("thread:C", "down"), "preset:x");
  // At the ends the focus stays.
  assert.equal(move("room:A", "up"), null);
  assert.equal(move("preset:y", "down"), null);
  assert.equal(move("member:B:1", "first"), "room:A");
  assert.equal(move("room:A", "last"), "preset:y");
});

test("Left and Right go to the column beside, to the item nearest in height, inside the section", () => {
  assert.equal(move("member:A:1", "right"), "member:B:1");
  assert.equal(move("member:D:1", "right"), "member:B:1");
  assert.equal(move("room:B", "right"), "thread:C");
  assert.equal(move("thread:C", "left"), "room:B");
  assert.equal(move("room:B", "left"), "room:A");
  // No column beyond the last, nor before the first: the focus stays; sections are not crossed sideways.
  assert.equal(move("thread:C", "right"), null);
  assert.equal(move("room:D", "left"), null);
  assert.equal(move("preset:x", "right"), "preset:y");
  assert.equal(move("preset:y", "right"), null);
});

test("with nothing focused, any arrow starts at the first item", () => {
  const order = inReadingOrder(page);
  for (const key of ["down", "up", "left", "right"] as const) assert.equal(readingTarget(order, -1, key)?.element, "room:A");
  assert.equal(readingTarget([], -1, "down"), null);
});

test("every shortcut ? shows is in README.md's Keyboard section", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Keyboard"), readme.indexOf("## The pixel look"));
  assert.ok(section.length > 0, "README.md has a Keyboard section");
  for (const group of KEYS) {
    assert.ok(section.includes(`**${group.where}**`), `README.md lists the keys of "${group.where}"`);
    for (const entry of group.entries) {
      const row = `| ${entry.keys.map((key) => `\`${key}\``).join(" ")} | ${entry.what} |`;
      assert.ok(section.includes(row), `README.md has the row ${row}`);
    }
  }
});
