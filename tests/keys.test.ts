/**
 * The page's keys (web/src/keys.ts): the overview's reading order and where each arrow goes from an item, on layouts
 * as the overview draws them (tiles stacked per column); the key table (keyOrder.ts, KEYS) and what the key bar shows
 * from it on a place; README.md's Keyboard section drawn from the same table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { barEntries, entryText, inReadingOrder, KEYS, keysMarkdown, placeById, readingTarget, type KeyWhen, type NavKey, type PlaceId, type Placed } from "../web/src/keyOrder.ts";

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

/** The bar on a place, as it reads: each entry's keys, then what they do. */
const bar = (place: PlaceId, now: KeyWhen[] = []): string[] => barEntries(place, now).map((entry) => `${entry.keys.join(" ")} ${entry.does}`);

test("the bar names the keys of a room's tile, a post and the composer by what they do there", () => {
  assert.deepEqual(bar("overview-room"), ["↑ ↓ previous or next, column by column", "← → the column beside, at the same height", "Enter open the room", "Home End first or last on the page", "? all keys"]);
  // Backspace has nothing to go back to on the overview: said in ? and README, not on the bar, which names what works.
  assert.ok(!bar("overview-room").some((line) => line.startsWith("Backspace")));
  assert.deepEqual(bar("room-post"), ["↑ ↓ previous or next post", "← → between the panes", "Enter its detail", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
  // In the field: no ? (it types), Backspace only while the field is empty.
  assert.deepEqual(bar("room-composer", ["typing"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept", "@ mention a member", "/ a command"]);
  assert.deepEqual(bar("room-composer", ["typing", "empty"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept", "Backspace close it", "@ mention a member", "/ a command"]);
  // A thread's composer has no lists.
  assert.deepEqual(bar("composer", ["typing"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept"]);
});

test("with nothing focused, Enter is what it does there: a message in a room or a thread, nothing on the overview", () => {
  // The room's or thread's window itself (as it opens, after a click on empty space) or the page under it: Enter opens
  // the composer.
  assert.deepEqual(bar("room-itself"), ["↑ ↓ to the posts", "← → between the panes", "Enter write a message", "Backspace back to the overview", "a–z start writing", "? all keys"]);
  assert.deepEqual(bar("thread-itself"), ["Enter write a message", "Backspace back to the overview", "a–z start writing", "? all keys"]);
  // A button there is pressed.
  assert.ok(bar("room-other").includes("Enter press it"));
  assert.ok(bar("thread-other").includes("Enter press it"));
  // The overview with nothing focused: the arrows go to the tiles, Enter does nothing; a button on it is pressed.
  assert.deepEqual(bar("overview-page"), ["↑ ↓ ← → to the tiles", "? all keys"]);
  assert.ok(bar("overview-other").includes("Enter press it"));
  // A browser's page: Enter only on a button.
  assert.deepEqual(bar("browser-page"), ["Backspace back to the overview", "? all keys"]);
  assert.deepEqual(bar("browser-other"), ["Enter press it", "Backspace back to the overview", "? all keys"]);
  // In a dialog's text field Enter is the field's (it sends the form or makes a line): the bar names no Enter there.
  assert.ok(bar("dialog").includes("Enter press it"));
  assert.ok(!bar("dialog", ["typing"]).some((line) => line.startsWith("Enter")));
});

test("a side panel itself writes a message with Enter; a button in it is pressed; the Members panel's arrows go to the members", () => {
  // Browser or Git itself (→ → from a post): ↑ ↓ into its controls, Enter opens the composer.
  // The ring on a panel means the panel is open: Backspace folds it.
  assert.deepEqual(bar("room-pane", ["panel-open"]), ["↑ ↓ its buttons and fields", "← → between the panes", "Enter write a message", "Backspace fold the side panel", "a–z start writing", "? all keys"]);
  assert.ok(bar("room-pane-button").includes("Enter press it"));
  assert.ok(bar("room-pane-button").includes("↑ ↓ its buttons and fields, in order"));
  // Members itself (after a click on empty space): ↑ ↓ to a member, Enter opens the composer.
  assert.deepEqual(bar("room-members", ["panel-open"]), ["↑ ↓ to the members", "← → between the panes", "Enter write a message", "Backspace fold the side panel", "a–z start writing", "? all keys"]);
  // A button in Members' head (+ Add member, ×): pressed; its arrows go to the members too.
  assert.ok(bar("room-members-button").includes("Enter press it"));
  assert.ok(bar("room-members-button").includes("↑ ↓ to the members"));
  for (const place of ["room-pane", "room-members", "room-members-button"] as const) assert.ok(!bar(place).includes("↑ ↓ to the posts"), place);
});

test("the bar takes the nearest place's wording, and the one for the moment over the rest of the time", () => {
  // The tabs' own Left and Right, and their Down; Up does nothing there.
  assert.deepEqual(bar("room-tabs"), ["↓ back to the posts", "← → the chat or the board", "Backspace back to the overview", "a–z start writing", "? all keys"]);
  // Esc closes what is in front and nothing else; Backspace closes the same first, then the panel, then the room.
  // Where the two keys do the same, they share one chip.
  assert.ok(bar("room-post", ["composer-open", "panel-open"]).includes("Esc Backspace close composer"));
  assert.ok(bar("room-post", ["chip-open", "panel-open"]).includes("Esc Backspace fold the choices"));
  // An open correction is in front wherever the focus is, after the composer and a chip's choices, before the panel.
  assert.ok(bar("room-post", ["correcting", "panel-open"]).includes("Esc Backspace close correction"));
  assert.ok(bar("room-post", ["correcting", "composer-open"]).includes("Esc Backspace close composer"));
  assert.ok(bar("room-member", ["panel-open"]).includes("Backspace fold the side panel"));
  assert.ok(!bar("room-member", ["panel-open"]).some((line) => line.startsWith("Esc ")), "Esc closes nothing with only the panel open");
  // ? closes the list it opened; Tab is on the bar only where it is the way on.
  assert.deepEqual(bar("dialog", ["help"]), ["Enter press it", "Tab Shift+Tab next or previous button or field", "Esc close it", "Backspace close it", "? close the keys"]);
  // In a dialog's text field Backspace deletes.
  assert.ok(!bar("dialog", ["typing"]).some((line) => line.startsWith("Backspace")));
  assert.ok(!bar("dialog").some((line) => line.startsWith("?")), "? opens nothing over a dialog");
  assert.ok(!bar("menu").some((line) => line.startsWith("?")), "? opens nothing over a menu");
  assert.ok(!bar("overview-room").some((line) => line.startsWith("Tab")));
  // A member's thread is read only: no letters.
  assert.deepEqual(bar("member-thread"), ["↑ ↓ scroll it", "Backspace back to the room", "? all keys"]);
});

test("every place but a dialog's and a menu's reaches Everywhere, each key once per place and moment, each worded", () => {
  const places = KEYS.flatMap((area) => area.places);
  assert.equal(new Set(places.map((place) => place.id)).size, places.length, "place ids are unique");
  for (const place of places) {
    const chain: string[] = [];
    for (let at: typeof place | undefined = place; at; at = at.within ? placeById(at.within) : undefined) {
      assert.ok(!chain.includes(at.id), `${place.id} is within itself`);
      chain.push(at.id);
    }
    // Under a dialog or a menu the page is out of reach, ? included.
    assert.equal(chain.at(-1), ["dialog", "menu", "model-list"].includes(place.id) ? place.id : "everywhere", `${place.id} reaches Everywhere`);
    const keys = place.entries.flatMap((entry) => entry.keys.map((key) => `${key}:${entry.when ?? ""}:${entry.unless ?? ""}`));
    assert.equal(new Set(keys).size, keys.length, `${place.id} lists a key twice for the same moment`);
    // As the bar says it, in the middle of its line: lower case (`?` and README capitalise it).
    for (const entry of place.entries) assert.match(entry.does, /^[a-z]/, `${place.id}: "${entry.does}"`);
  }
  assert.equal(entryText({ keys: ["?"], does: "all keys", unless: "typing" }), "All keys (outside a text field)");
});

test("README.md's Keyboard section is the key table, row for row", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Keyboard"), readme.indexOf("## The pixel look"));
  assert.ok(section.length > 0, "README.md has a Keyboard section");
  const tables = keysMarkdown();
  assert.ok(section.includes(tables), "README.md's Keyboard tables differ from KEYS: node scripts/keys-readme.ts draws them again");
  const rows = (text: string) => text.split("\n").filter((line) => line.startsWith("|")).length;
  assert.equal(rows(section), rows(tables), "README.md's Keyboard section has no table rows besides KEYS'");
});
