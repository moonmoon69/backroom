/**
 * The page's keys (web/src/keys.ts): where each arrow goes on the overview's grid, on layouts as the overview draws them
 * (a header row, each section's head with its + at the far right, tiles stacked per column); the key table (keyOrder.ts,
 * KEYS) and what the key bar shows from it on a place; README.md's Keyboard section drawn from the same table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { barEntries, entryText, gridStart, gridTarget, KEYS, keysMarkdown, placeById, type Boxed, type KeyWhen, type NavKey, type PlaceId, type Span } from "../web/src/keyOrder.ts";

/** An item: its key and box; a tile when `tile` says so. */
const box = (key: string, left: number, right: number, top: number, bottom: number, tile = false, needs = false): Boxed<string> => ({ element: key, left, right, top, bottom, tile, needs });

/**
 * The overview at 1439 px as the throwaway draws it: the header's buttons; the project's head (+ New room at the far
 * right); its tiles on three columns, stacked per column (the thread short, Rehearsal tall, Second between, Third under
 * the thread, starting above Rehearsal's foot); Crew's head and two crew members; Browsers' head and two browsers.
 */
const page: Boxed<string>[] = [
  box("head:project", 155, 189, 10, 34),
  box("head:arrange", 205, 270, 10, 33),
  box("head:t3", 1266, 1347, 10, 33),
  box("head:updates", 1349, 1383, 10, 34),
  box("head:settings", 1385, 1419, 9, 33),
  box("head:room", 1377, 1411, 66, 90),
  box("thread:loose", 29, 480, 112, 202, true),
  box("room:rehearsal", 494, 945, 112, 292, true),
  box("room:second", 959, 1410, 112, 247, true),
  box("room:third", 29, 480, 216, 306, true),
  box("head:crew", 1266, 1411, 335, 359),
  box("preset:sol", 29, 289, 381, 435, true),
  box("preset:astra", 307, 567, 381, 435, true),
  box("head:browsers", 1298, 1411, 464, 488),
  box("browser:general", 29, 297, 510, 563, true),
  box("browser:testing", 307, 575, 510, 563, true),
];

/** Where a key goes from an item, with the column a run of ↑ ↓ keeps to if one is given. */
const move = (from: string, key: NavKey, column?: Span): string | null => gridTarget(page, page.findIndex((p) => p.element === from), key, column)?.element ?? null;

/** A run of presses from an item, as the overview keeps its column: the span it began on while ↑ ↓ go on, none after ← →. */
const walk = (from: string, keys: NavKey[]): string[] => {
  const seen: string[] = [];
  let here = from;
  let column: Span | undefined;
  for (const key of keys) {
    const vertical = key === "up" || key === "down";
    const at = page.find((p) => p.element === here)!;
    const next = move(here, key, vertical ? column : undefined);
    column = vertical ? (column ?? at) : undefined;
    here = next ?? here;
    seen.push(here);
  }
  return seen;
};

test("Down from a room's tile reaches the tile below, then Crew's head, its tiles, then Browsers', keeping to its column", () => {
  assert.deepEqual(walk("thread:loose", ["down", "down", "down", "down", "down", "down"]), ["room:third", "head:crew", "preset:sol", "head:browsers", "browser:general", "browser:general"]);
  // From the middle column: nothing under Rehearsal, so the next row is Crew's head; then the crew member in its column.
  assert.deepEqual(walk("room:rehearsal", ["down", "down", "down", "down"]), ["head:crew", "preset:astra", "head:browsers", "browser:testing"]);
  // A tile beside that starts above the ring's foot (Third, beside Rehearsal) is not the row below it.
  assert.equal(move("room:second", "down"), "head:crew");
  // Without a run's column, the row below is entered at the item nearest the ring: Crew's + is at the far right.
  assert.equal(move("head:crew", "down"), "preset:astra");
  assert.equal(move("head:crew", "down", page.find((p) => p.element === "room:third")), "preset:sol");
});

test("Up from the first row reaches its section's + and then the page's header; the header is the top", () => {
  assert.deepEqual(walk("thread:loose", ["up", "up", "up"]), ["head:room", "head:arrange", "head:arrange"]);
  assert.deepEqual(walk("room:second", ["up", "up"]), ["head:room", "head:t3"]);
  assert.deepEqual(walk("browser:general", ["up", "up", "up", "up", "up"]), ["head:browsers", "preset:sol", "head:crew", "room:third", "thread:loose"]);
  // Up from a tile stacked under another goes to that one, not to the section's head.
  assert.equal(move("room:third", "up"), "thread:loose");
  // Rehearsal taller than both tiles of the first column together: the row above Crew's head holds all three, and Up
  // in the first column goes to the nearer of its two, Third, not the first on the page.
  const tall = page.map((p) => (p.element === "room:rehearsal" ? { ...p, bottom: 320 } : p));
  const column = page.find((p) => p.element === "thread:loose");
  assert.equal(gridTarget(tall, tall.findIndex((p) => p.element === "head:crew"), "up", column)?.element, "room:third");
  assert.equal(move("head:project", "up"), null);
});

test("Left and Right go along the row and stop at its ends; Home and End go to them", () => {
  assert.deepEqual(walk("head:project", ["left", "right", "right", "right", "right", "right"]), ["head:project", "head:arrange", "head:t3", "head:updates", "head:settings", "head:settings"]);
  assert.deepEqual(walk("thread:loose", ["right", "right", "right", "left", "left", "left"]), ["room:rehearsal", "room:second", "room:second", "room:rehearsal", "thread:loose", "thread:loose"]);
  // Third sits beside Rehearsal (their heights overlap): Right goes there; back Left, the tile with the nearest top.
  assert.equal(move("room:third", "right"), "room:rehearsal");
  assert.equal(move("room:rehearsal", "left"), "thread:loose");
  // A section's head holds one button: nothing beside it.
  assert.equal(move("head:crew", "left"), null);
  assert.equal(move("head:crew", "right"), null);
  assert.equal(move("preset:astra", "right"), null);
  assert.equal(move("head:arrange", "first"), "head:project");
  assert.equal(move("head:arrange", "last"), "head:settings");
  assert.equal(move("preset:sol", "last"), "preset:astra");
});

test("with nothing focused, the ring starts on the first tile that needs you, else the first tile", () => {
  assert.equal(gridStart(page)?.element, "thread:loose");
  const needing = page.map((p) => (p.element === "room:second" ? { ...p, needs: true } : p));
  assert.equal(gridStart(needing)?.element, "room:second");
  assert.equal(gridStart(page.filter((p) => !p.tile))?.element, "head:project");
  assert.equal(gridStart([]), null);
  assert.equal(gridTarget(page, -1, "down"), null);
});

/** The bar on a place, as it reads: each entry's keys, then what they do. */
const bar = (place: PlaceId, now: KeyWhen[] = []): string[] => barEntries(place, now).map((entry) => `${entry.keys.join(" ")} ${entry.does}`);

test("the bar names the keys of a room's tile, a post and the composer by what they do there", () => {
  assert.deepEqual(bar("overview-room"), ["↑ ↓ the row above or below", "← → along the row", "Enter open the room", "Home End first or last in the row", "? all keys"]);
  // A button in the header or a section's head is a stop of the grid: its arrows are the overview's, Enter presses it.
  assert.deepEqual(bar("overview-head"), ["↑ ↓ the row above or below", "← → along the row", "Enter press it", "Home End first or last in the row", "? all keys"]);
  assert.ok(bar("overview-crew").includes("Enter edit them"));
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
