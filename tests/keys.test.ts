/**
 * The page's keys (web/src/keys.ts): where each arrow goes on the overview's grid, on layouts as the overview draws them
 * (a header row, each section's head with its + at the far right, tiles stacked per column); a room's lanes and where
 * each arrow goes in them; the key table (keyOrder.ts, KEYS) and what the key bar shows from it on a place; README.md's
 * Keyboard section drawn from the same table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_KINDS, BAR_NAME, barDoes, barEntries, chipOffers, chipTarget, entryText, fourKeysMarkdown, gridStart, gridTarget, imageAction, KEYS, keysMarkdown, laneTarget, nearestInHeight, numberRepeats, openLanding, placeById, runCanStop, stripOrder, stripStep, type ActionKind, type Boxed, type KeyWhen, type Lane, type LaneAt, type NavKey, type PlaceId, type Span } from "../web/src/keyOrder.ts";

/** An item: its key and box; a tile when `tile` says so. */
const box = (key: string, left: number, right: number, top: number, bottom: number, tile = false, needs = false): Boxed<string> => ({ element: key, left, right, top, bottom, tile, needs });

test("review: keyboard help explains the secret field and saving it", () => {
  const chip = placeById("room-chip").entries.map(entryText).join("\n");
  const choices = placeById("room-chip-actions").entries.map(entryText).join("\n");
  assert.match(chip, /secret/i, "opening the chip exposes a secret field too");
  assert.match(choices, /secret/i, "the choices explain entering the secret field and leaving it waiting");
  assert.match(choices, /sav/i, "Enter in the secret field saves it");
});

/**
 * The page's keys (K1-5 adds a post's action strip: its keys on the bar, the order of its buttons, and the turns running
 * now after the posts).
 */

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

/**
 * A room's lanes as OverviewRoom reads them: the header (× and the two tabs, the chat open; Members), the room state, the
 * status chips (an approval, a running turn), three posts (#1 to #3, the second last visited) and the composer's strip.
 */
const room: Lane<string>[] = [
  { name: "header", items: ["close", "chat", "board", "people"], landing: "chat" },
  { name: "state", items: ["state"], landing: "state" },
  { name: "status", items: ["approval", "working"], landing: "approval" },
  { name: "posts", items: ["#1", "#2", "#3"], landing: "#2" },
  { name: "strip", items: ["strip"], landing: "strip" },
];
/** Where a key goes in `lanes` from an item (by name), or from between items (`{ lane, before }`), or from nothing. */
const inRoom = (from: string | LaneAt | null, key: NavKey, earlier = false, lanes = room) => {
  const at = typeof from === "string" ? lanes.map((lane, index) => ({ lane: index, item: lane.items.indexOf(from) })).find((p) => p.item >= 0)! : from;
  const move = laneTarget(lanes, at, key, earlier);
  return move === null || move === "stay" ? move : "to" in move ? move.to : "earlier";
};

test("a room reads in lanes: Up and Down lane to lane and post to post, past the first post the earlier ones, then the lanes above", () => {
  // Up from the first post: the status chips, the room state, the header; at the top it stays.
  assert.equal(inRoom("#1", "up"), "approval");
  assert.equal(inRoom("approval", "up"), "state");
  assert.equal(inRoom("working", "up"), "state");
  assert.equal(inRoom("state", "up"), "chat");
  assert.equal(inRoom("board", "up"), "stay");
  // With earlier posts to draw, Up from the first post draws them first.
  assert.equal(inRoom("#1", "up", true), "earlier");
  assert.equal(inRoom("#2", "up", true), "#1");
  // Down from the header lands on each lane's landing: the room state, the needs-you chip, the post last visited.
  assert.equal(inRoom("people", "down"), "state");
  assert.equal(inRoom("state", "down"), "approval");
  assert.equal(inRoom("working", "down"), "#2");
  assert.equal(inRoom("#3", "down"), "strip");
  assert.equal(inRoom("strip", "down"), "stay");
  // Up from the strip: back to the post last visited.
  assert.equal(inRoom("strip", "up"), "#2");
  // A lane with no item is not there: without a state or chips, Up from the first post reaches the header.
  const bare = room.filter((lane) => lane.name !== "state" && lane.name !== "status");
  assert.equal(inRoom("#1", "up", false, bare), "chat");
  assert.equal(inRoom("chat", "down", false, bare), "#2");
});

test("Left and Right go along the header and the status chips and stop at their ends; elsewhere they are the room's", () => {
  assert.equal(inRoom("chat", "right"), "board");
  assert.equal(inRoom("board", "right"), "people");
  assert.equal(inRoom("people", "right"), "stay");
  assert.equal(inRoom("close", "left"), "stay");
  assert.equal(inRoom("chat", "left"), "close");
  assert.equal(inRoom("approval", "right"), "working");
  assert.equal(inRoom("working", "right"), "stay");
  // The room state, a post, the strip and nothing focused: into the side panel (OverviewRoom), not the lanes'.
  for (const from of ["state", "#2", "strip", null]) for (const key of ["left", "right"] as const) assert.equal(inRoom(from, key), null, `${from} ${key}`);
  // Something of the status lane that is no item (a chip's choices): its arrows are the room's too.
  assert.equal(inRoom({ lane: 2, before: 2 }, "right"), null);
});

test("Home and End go to the first and last post from every lane; from nothing, Up and Down go to the posts", () => {
  for (const from of ["board", "state", "working", "#2", "strip", null]) {
    assert.equal(inRoom(from, "first"), "#1");
    assert.equal(inRoom(from, "last"), "#3");
  }
  assert.equal(inRoom(null, "up"), "#2");
  assert.equal(inRoom(null, "down"), "#2");
  // An empty board: Home and End stay; Up and Down from nothing go to the strip.
  const empty = room.filter((lane) => lane.name !== "posts");
  assert.equal(inRoom("strip", "first", false, empty), "stay");
  assert.equal(inRoom(null, "down", false, empty), "strip");
  assert.equal(inRoom("approval", "down", false, empty), "strip");
});

test("from something of a lane that is no item (the earlier posts' button, a chip's choices), Up and Down go to the item on that side, else the next lane", () => {
  // The earlier posts' button, above the first post: Down to it, Up to the lane above (it is pressed with Enter).
  assert.equal(inRoom({ lane: 3, before: 0 }, "down"), "#1");
  assert.equal(inRoom({ lane: 3, before: 0 }, "up", true), "approval");
  // Jump to latest, after the last post: Up to it, Down to the strip.
  assert.equal(inRoom({ lane: 3, before: 3 }, "up"), "#3");
  assert.equal(inRoom({ lane: 3, before: 3 }, "down"), "strip");
  // A chip's open choices, after the chips: Up back to the chip (the lane's landing), Down to the posts.
  assert.equal(inRoom({ lane: 2, before: 2 }, "up"), "approval");
  assert.equal(inRoom({ lane: 2, before: 2 }, "down"), "#2");
  // The room state's text, open under its line: Up to the line, Down on to the chips.
  assert.equal(inRoom({ lane: 1, before: 1 }, "up"), "state");
  assert.equal(inRoom({ lane: 1, before: 1 }, "down"), "approval");
});

test("a room opens with the ring on something in view: a chip that needs you, the newest post if it shows, the running turn's chip, the strip", () => {
  const room = { needs: null, newest: "#88", newestInView: true, running: "working", strip: "strip" };
  assert.equal(openLanding({ ...room, needs: "approval" }), "approval");
  assert.equal(openLanding({ ...room, needs: "approval", newestInView: false }), "approval");
  assert.equal(openLanding(room), "#88");
  // A running turn's tall live bubble pushed the newest post out of the board's view: its chip, in the status lane.
  assert.equal(openLanding({ ...room, newestInView: false }), "working");
  // No room run's chip (a turn typed in T3 is no stop): the strip.
  assert.equal(openLanding({ ...room, newestInView: false, running: null }), "strip");
  // An empty room.
  assert.equal(openLanding({ ...room, newest: null, newestInView: false, running: null }), "strip");
});

/** The bar on a place, as it reads: each entry's keys, then what they do. */
const bar = (place: PlaceId, now: KeyWhen[] = []): string[] => barEntries(place, now).map((entry) => `${entry.keys.join(" ")} ${entry.does}`);
/** The bar on a place as it reads with the ring on a button of this name (an action strip's). */
const barNamed = (place: PlaceId, name: string, now: KeyWhen[] = []): string[] => barEntries(place, now).map((entry) => `${entry.keys.join(" ")} ${barDoes(entry, name)}`);

test("the bar names the keys of a room's tile, a post and the composer by what they do there", () => {
  assert.deepEqual(bar("overview-room"), ["↑ ↓ the row above or below", "← → along the row", "Enter open the room", "Home End first or last in the row", "? all keys"]);
  // A button in the header or a section's head is a stop of the grid: its arrows are the overview's, Enter presses it.
  assert.deepEqual(bar("overview-head"), ["↑ ↓ the row above or below", "← → along the row", "Enter press it", "Home End first or last in the row", "? all keys"]);
  assert.ok(bar("overview-crew").includes("Enter edit them"));
  // Backspace has nothing to go back to on the overview: said in ? and README, not on the bar, which names what works.
  assert.ok(!bar("overview-room").some((line) => line.startsWith("Backspace")));
  assert.deepEqual(bar("room-post"), ["↑ ↓ previous or next post", "→ the side panel", "Enter its actions", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
  // In the field: no ? (it types), Backspace only while the field is empty.
  assert.deepEqual(bar("room-composer", ["typing"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept", "@ mention a member", "/ a command"]);
  assert.deepEqual(bar("room-composer", ["typing", "empty"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept", "Backspace close it", "@ mention a member", "/ a command"]);
  // A thread's composer has no lists.
  assert.deepEqual(bar("composer", ["typing"]), ["Enter send", "Shift+Enter new line", "Esc close it, the draft kept"]);
});

test("with nothing focused, Enter is what it does there: a message in a room or a thread, nothing on the overview", () => {
  // The room's or thread's window itself (as it opens, after a click on empty space) or the page under it: Enter opens
  // the composer.
  assert.deepEqual(bar("room-itself"), ["↑ ↓ to the posts", "→ the side panel", "Enter write a message", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
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

test("each lane says its keys: the header's buttons by what Enter does on each, the room state, a status chip, the strip", () => {
  const enter = (place: PlaceId) => bar(place).find((line) => line.startsWith("Enter "));
  assert.equal(enter("room-head-close"), "Enter back to the overview");
  assert.equal(enter("room-head-tab"), "Enter show this view");
  assert.equal(enter("room-head-panel"), "Enter open or fold its panel");
  assert.equal(enter("room-head-options"), "Enter its menu");
  for (const place of ["room-head-close", "room-head-tab", "room-head-panel", "room-head-options"] as const) {
    assert.ok(bar(place).includes("← → along the header"), place);
    assert.ok(bar(place).includes("↓ the lane below"), place);
    assert.ok(!bar(place).some((line) => line.startsWith("↑")), `${place}: nothing above the header`);
  }
  assert.deepEqual(bar("room-state"), ["↑ ↓ the lane above or below", "→ the side panel", "Enter open or fold it", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
  assert.deepEqual(bar("room-chip"), ["↑ ↓ the lane above or below", "← → between the chips", "Enter its choices", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
  assert.ok(bar("room-chip", ["chip-open"]).includes("Esc Backspace fold the choices"));
  assert.deepEqual(bar("room-strip"), ["↑ the posts", "→ the side panel", "Enter write a message", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
  // Home and End go to the posts from every lane of the conversation, and stay the side panel's own there.
  for (const place of ["room-post", "room-state", "room-chip", "room-strip", "room-other", "room-itself"] as const) assert.ok(bar(place).includes("Home End first or last post"), place);
  for (const place of ["room-side-panel", "room-side-tab", "room-member", "room-member-actions", "room-side-row"] as const) assert.ok(!bar(place).includes("Home End first or last post"), place);
});

test("the side panel's places: its head, a member, a member's actions, a row; ← goes back to the conversation, → is never the side panel there", () => {
  // The panel itself (after a click on empty space): Enter opens the composer; the ring on it means it is open.
  assert.deepEqual(bar("room-side-panel", ["panel-open"]), ["↑ ↓ row above or below", "← → along the row", "Enter write a message", "Backspace fold the side panel", "a–z start writing", "Home End first or last in the panel", "? all keys"]);
  // Its head: the tabs show their panel, + adds a member, × folds it.
  assert.deepEqual(bar("room-side-tab"), ["↑ ↓ row above or below", "← → along its head", "Enter show its panel", "Backspace back to the overview", "a–z start writing", "Home End first or last in the panel", "? all keys"]);
  assert.ok(bar("room-side-add").includes("Enter add a member"));
  assert.ok(bar("room-side-close").includes("Enter fold the panel"));
  // A member: Enter its actions, ← back to the conversation, and no → at all (the room's "→ the side panel" is the conversation's).
  assert.deepEqual(bar("room-member", ["panel-open"]), ["↑ ↓ previous or next member", "← the conversation", "Enter its actions", "Backspace fold the side panel", "a–z start writing", "Home End first or last member", "? all keys"]);
  // In a member's actions: choose, the button's name for Enter, Esc and Backspace close them.
  assert.deepEqual(barNamed("room-member-actions", "Settings…"), ["↑ ↓ previous or next member", "← → choose", "Enter Settings…", "Esc Backspace close", "a–z start writing", "? all keys"]);
  // A row of the Browser or Git panel: along it, Enter presses.
  assert.ok(bar("room-side-row").includes("← → along the row"));
  assert.ok(bar("room-side-row").includes("Enter press it"));
  for (const place of ["room-side-panel", "room-side-head", "room-side-tab", "room-side-add", "room-side-close", "room-member", "room-member-actions", "room-side-row", "room-side-other"] as const) {
    assert.ok(!bar(place).some((line) => line.startsWith("→ ") || line.includes("the side panel") && !line.startsWith("Backspace")), place);
    assert.ok(!bar(place).includes("↑ ↓ to the posts"), place);
  }
  // The conversation's lanes say where → goes; the header and the chips keep → for themselves.
  for (const place of ["room-post", "room-state", "room-strip", "room-other", "room-itself", "room-button"] as const) assert.ok(bar(place).includes("→ the side panel"), place);
  for (const place of ["room-head-tab", "room-chip", "room-actions", "room-chip-actions"] as const) assert.ok(!bar(place).includes("→ the side panel"), place);
});

/**
 * A room at 1439 px with the side panel open (Members), boxed as the page draws it: the conversation's posts on the left;
 * the panel's head on the right (its tabs, + Add member, ×), then three members.
 */
const sidePanel: Boxed<string>[] = [
  box("side:tab:people", 1092, 1160, 112, 134),
  box("side:tab:browser", 1162, 1220, 114, 132),
  box("side:tab:git", 1222, 1250, 114, 132),
  box("side:add", 1370, 1398, 110, 136),
  box("side:close", 1402, 1430, 110, 136),
  box("member:a", 1092, 1430, 150, 260),
  box("member:b", 1092, 1430, 268, 378),
  box("member:c", 1092, 1430, 386, 496),
];
const conversation: Boxed<string>[] = [box("post:1", 40, 1060, 120, 240), box("post:2", 40, 1060, 250, 300), box("post:3", 40, 1060, 310, 640), box("strip", 40, 1060, 760, 800)];
/** Where a key goes in the side panel from the item with that key. */
const inSide = (from: string, key: NavKey): string | null => gridTarget(sidePanel, sidePanel.findIndex((item) => item.element === from), key)?.element ?? null;

test("the side panel is a column of rows: its head's tabs, + and × along it, then the members; it stops at its ends", () => {
  assert.equal(inSide("side:tab:people", "right"), "side:tab:browser");
  assert.equal(inSide("side:tab:git", "right"), "side:add");
  assert.equal(inSide("side:add", "right"), "side:close");
  assert.equal(inSide("side:close", "right"), null, "the head's right end");
  assert.equal(inSide("side:tab:people", "down"), "member:a");
  assert.equal(inSide("side:close", "down"), "member:a");
  assert.equal(inSide("member:a", "down"), "member:b");
  assert.equal(inSide("member:c", "down"), null, "the last member");
  // Up from a member reaches the head (OverviewRoom puts the ring on the tab showing, the head's landing).
  assert.ok(["side:tab:people", "side:tab:browser", "side:tab:git", "side:add", "side:close"].includes(inSide("member:a", "up")!));
  assert.equal(inSide("side:tab:browser", "up"), null, "the head is the top");
  // Left from a row's first is no move inside the panel: OverviewRoom takes the ring back to the conversation.
  assert.equal(inSide("member:b", "left"), null);
  assert.equal(inSide("side:tab:people", "left"), null);
});

test("across the two columns the ring goes to the item nearest in height, of those in view", () => {
  // From the conversation into the panel: a post beside the head and the first member goes to the one it overlaps
  // most nearly, then the nearest top, then the row's first.
  assert.equal(nearestInHeight(sidePanel, conversation[0]!)?.element, "side:tab:people");
  assert.equal(nearestInHeight(sidePanel, conversation[1]!)?.element, "member:b");
  assert.equal(nearestInHeight(sidePanel, conversation[2]!)?.element, "member:b", "a tall post: the member whose top is nearest its own");
  assert.equal(nearestInHeight(sidePanel, conversation[3]!)?.element, "member:c", "below every member: the nearest");
  // Back from the panel: to the post beside it.
  assert.equal(nearestInHeight(conversation, sidePanel[6]!)?.element, "post:2");
  assert.equal(nearestInHeight(conversation, sidePanel[7]!)?.element, "post:3");
  assert.equal(nearestInHeight([], sidePanel[0]!), null);
});

test("Enter on a button that waits says so: over every place's Enter while it cannot be pressed", () => {
  assert.ok(bar("overview-other", ["disabled"]).includes("Enter not now"));
  assert.ok(!bar("overview-other", ["disabled"]).includes("Enter press it"));
  assert.ok(bar("dialog", ["disabled"]).includes("Enter not now"));
  assert.ok(bar("room-side-row", ["disabled"]).includes("Enter not now"));
  assert.ok(bar("overview-other").includes("Enter press it"), "a button that can be pressed");
  assert.ok(!bar("overview-other").includes("Enter not now"));
});

test("the bar takes the nearest place's wording, and the one for the moment over the rest of the time", () => {
  // A view's tab is in the header: Left and Right along it, Down to the lanes below, Enter shows its view; Up does
  // nothing there.
  assert.deepEqual(bar("room-head-tab"), ["↓ the lane below", "← → along the header", "Enter show this view", "Backspace back to the overview", "a–z start writing", "Home End first or last post", "? all keys"]);
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
    // Under a dialog or a menu the page is out of reach, ? included; a place in a dialog (Add member's crew) reaches the dialog.
    assert.equal(chain.at(-1), ["dialog", "menu", "model-list"].includes(place.id) ? place.id : chain.includes("dialog") ? "dialog" : "everywhere", `${place.id} reaches Everywhere`);
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
  // It opens with the four keys, as `?` does (KeyHelp.tsx draws the same FOUR_KEYS).
  assert.ok(section.startsWith(`## Keyboard\n\n${fourKeysMarkdown()}\n\n`), "README.md's Keyboard section opens with FOUR_KEYS: node scripts/keys-readme.ts draws it again");
  const rows = (text: string) => text.split("\n").filter((line) => line.startsWith("|")).length;
  assert.equal(rows(section), rows(tables), "README.md's Keyboard section has no table rows besides KEYS'");
});

test("the turns running now follow the posts: Down from the newest post reaches them, End stays the newest post", () => {
  // The posts lane holds three posts, then two live bubbles; the newest post is #3.
  const live: Lane<string>[] = room.map((lane) => (lane.name === "posts" ? { ...lane, items: ["#1", "#2", "#3", "live:a", "live:b"], newest: "#3" } : lane));
  assert.equal(inRoom("#3", "down", false, live), "live:a");
  assert.equal(inRoom("live:a", "down", false, live), "live:b");
  assert.equal(inRoom("live:b", "down", false, live), "strip");
  assert.equal(inRoom("live:a", "up", false, live), "#3");
  for (const from of ["live:b", "#1", "approval", "strip", null]) {
    assert.equal(inRoom(from, "last", false, live), "#3", `End from ${from}`);
    assert.equal(inRoom(from, "first", false, live), "#1", `Home from ${from}`);
  }
  // A room with no post yet and a turn running: End goes to its bubble.
  const fresh: Lane<string>[] = room.map((lane) => (lane.name === "posts" ? { ...lane, items: ["live:a"], landing: "live:a" } : lane));
  assert.equal(inRoom("strip", "last", false, fresh), "live:a");
});

test("on a post Enter opens its actions; in them the bar says choose, Enter and the button's name, Esc close", () => {
  assert.ok(bar("room-post").includes("Enter its actions"));
  assert.deepEqual(barNamed("room-actions", "Correct…"), ["↑ ↓ previous or next post", "← → choose", "Enter Correct…", "Esc Backspace close", "a–z start writing", "Home End first or last post", "? all keys"]);
  assert.ok(barNamed("room-actions", "Cancel").includes("Enter Cancel"));
  // A long name (a file chip, a link) is cut on the bar, so the bar still fits.
  const long = "web/src/components/ActionStrip.tsx:42";
  const enter = barNamed("room-actions", long).find((line) => line.startsWith("Enter "))!;
  assert.equal(enter, `Enter ${long.slice(0, BAR_NAME - 1)}…`);
  // The strip is in front of a correction, a chip's choices and the panel: Esc and Backspace close it first.
  for (const now of [["correcting"], ["chip-open"], ["panel-open"], ["correcting", "chip-open", "panel-open"]] as KeyWhen[][]) {
    assert.ok(barNamed("room-actions", "Copy", now).includes("Esc Backspace close"), now.join());
    assert.ok(!barNamed("room-actions", "Copy", now).some((line) => line.startsWith("Backspace ") || line.startsWith("Esc ") && line !== "Esc Backspace close"), now.join());
  }
  // Without a name (nothing to name) the bar says what the table says.
  assert.ok(bar("room-actions").includes("Enter press it"));
  assert.equal(barDoes({ keys: ["Enter"], does: "send" }, "Correct…"), "send");
});

test("on a status chip Enter opens its choices as a strip; in it the bar says choose, Enter and the choice, Esc leave it waiting or fold", () => {
  assert.ok(bar("room-chip").includes("Enter its choices"));
  // An approval's or a question's: Esc and Backspace leave it waiting.
  assert.deepEqual(barNamed("room-chip-actions", "Accept for session", ["chip-open", "asking"]), ["↑ ↓ chip or posts", "← → choose", "Enter Accept for session", "Esc Backspace leave it waiting", "a–z start writing", "Home End first or last post", "? all keys"]);
  // A failed or running turn's: they fold the choices.
  assert.deepEqual(barNamed("room-chip-actions", "Retry", ["chip-open"]), ["↑ ↓ chip or posts", "← → choose", "Enter Retry", "Esc Backspace fold the choices", "a–z start writing", "Home End first or last post", "? all keys"]);
  // Its own place, not a post's: ↑ ↓ are not "previous or next post".
  assert.ok(!barNamed("room-chip-actions", "Stop").includes("↑ ↓ previous or next post"));
  // In front of the composer, a correction and the panel, as a post's strip is.
  for (const now of [["chip-open", "composer-open"], ["chip-open", "correcting"], ["chip-open", "panel-open"]] as KeyWhen[][]) {
    for (const asking of [[], ["asking"]] as KeyWhen[][]) {
      const lines = barNamed("room-chip-actions", "Retry", [...now, ...asking]);
      const esc = asking.length > 0 ? "Esc Backspace leave it waiting" : "Esc Backspace fold the choices";
      assert.ok(lines.includes(esc), [...now, ...asking].join());
      assert.ok(!lines.some((line) => line.startsWith("Backspace ") || (line.startsWith("Esc ") && line !== esc)), now.join());
    }
  }
  // A long option is cut as any button's name is.
  assert.equal(barNamed("room-chip-actions", "the answer of your own").find((line) => line.startsWith("Enter ")), `Enter ${"the answer of your own".slice(0, BAR_NAME - 1)}…`);
});

test("a status chip is a stop only with something to press; a turn can be stopped in the phases its choices show Stop", () => {
  assert.deepEqual(["prepared", "sending", "accepted", "running", "uncertain", "rejected", "terminal"].filter(runCanStop), ["sending", "accepted", "running", "uncertain"]);
  assert.ok(chipOffers({ kind: "ask" }));
  assert.ok(chipOffers({ kind: "notice" }));
  assert.ok(chipOffers({ kind: "run", phase: "running", member: true, posts: 0 }));
  assert.ok(chipOffers({ kind: "run", phase: "uncertain", member: true, posts: 0 }));
  // Nothing to stop: a stop only if it is about a post ("show #n").
  assert.ok(!chipOffers({ kind: "run", phase: "prepared", member: true, posts: 0 }));
  assert.ok(!chipOffers({ kind: "run", phase: "rejected", member: true, posts: 0 }));
  assert.ok(!chipOffers({ kind: "run", phase: "running", member: false, posts: 0 }));
  assert.ok(chipOffers({ kind: "run", phase: "prepared", member: true, posts: 1 }));
  // The chip gone with the ring in its strip, the ring lands as a room opens: a chip that needs you, else the newest
  // post if it shows, else a running turn's chip, else the composer's strip.
  assert.equal(openLanding({ needs: "chip", newest: "#9", newestInView: true, running: "run", strip: "strip" }), "chip");
  assert.equal(openLanding({ needs: null, newest: "#9", newestInView: true, running: "run", strip: "strip" }), "#9");
  assert.equal(openLanding({ needs: null, newest: "#9", newestInView: false, running: "run", strip: "strip" }), "run");
  assert.equal(openLanding({ needs: null, newest: null, newestInView: false, running: null, strip: "strip" }), "strip");
});

test("in a correction Enter sends it and Shift+Enter makes a line; Esc closes it, back to Correct…", () => {
  assert.deepEqual(bar("correction", ["typing"]), ["Enter send it", "Shift+Enter new line", "Tab on to Send correction", "Esc close it, back to Correct…"]);
});

test("an action strip's buttons in the design's order, Detail last", () => {
  /** Kinds as an item draws them, in the strip's order. */
  const order = (kinds: ActionKind[]): ActionKind[] => stripOrder(kinds.map((kind) => ({ kind }))).map((control) => control.kind);
  // Your message with an open request: its Copy beside the bubble, then the request's Correct… and Cancel, its #refs.
  assert.deepEqual(order(["copy", "correct", "cancel", "ref", "detail"]), ["correct", "cancel", "copy", "ref", "detail"]);
  // A reply: what it answers (#ref) in its head, then its text's file chips and images, sent to T3, turn in T3, then
  // Copy at its foot.
  assert.deepEqual(order(["ref", "file", "image", "file", "sent", "turn", "copy", "detail"]), ["copy", "ref", "file", "file", "image", "turn", "sent", "detail"]);
  // A failed-turn notice: the post it is on, then Retry and Dismiss.
  assert.deepEqual(order(["ref", "retry", "dismiss", "detail"]), ["retry", "dismiss", "ref", "detail"]);
  // A live bubble: what it works on, Stop, an approval's choices, its feed's earlier part, sent to T3 (no Detail).
  assert.deepEqual(order(["ref", "stop", "choice", "choice", "more", "sent"]), ["stop", "choice", "choice", "ref", "sent", "more"]);
  // Within a kind, as the item draws them; a link, a code block's Copy and a folded text after the table's, before Detail.
  assert.deepEqual(stripOrder([{ kind: "file" as const, n: 2 }, { kind: "link" as const, n: 1 }, { kind: "file" as const, n: 1 }, { kind: "code" as const, n: 1 }, { kind: "text" as const, n: 1 }]).map((c) => `${c.kind}${c.n}`), ["file2", "file1", "link1", "code1", "text1"]);
  assert.equal(ACTION_KINDS.at(-1), "detail");
  // A message to two members: each request's Correct… and Cancel stay together, in the message's order.
  const pairs = stripOrder([{ kind: "copy" as const, n: 0 }, { kind: "correct" as const, n: 33 }, { kind: "cancel" as const, n: 33 }, { kind: "correct" as const, n: 34 }, { kind: "cancel" as const, n: 34 }, { kind: "ref" as const, n: 0 }]);
  assert.deepEqual(pairs.map((c) => `${c.kind}${c.n || ""}`), ["correct33", "cancel33", "correct34", "cancel34", "copy", "ref"]);
});

test("Left and Right in a strip go to the next button that can be pressed, and stop at its ends", () => {
  const all = [true, true, true, true];
  assert.equal(stripStep(all, 0, "right"), 1);
  assert.equal(stripStep(all, 3, "right"), null);
  assert.equal(stripStep(all, 0, "left"), null);
  assert.equal(stripStep(all, 2, "left"), 1);
  // A busy button (Retry while it is sent) is passed over; with none further on, the ring stays.
  assert.equal(stripStep([true, false, true], 0, "right"), 2);
  assert.equal(stripStep([true, false, true], 2, "left"), 0);
  assert.equal(stripStep([true, false, false], 0, "right"), null);
  // From outside the strip, nothing.
  assert.equal(stripStep(all, -1, "right"), null);
});

test("a strip's image button is named with the image's alt text, and the bar's Enter with it", () => {
  // As the post's own button says it ("Open image: the parser's diagram"); no alt text, no more than Image.
  assert.deepEqual(imageAction("the parser's diagram"), { label: "Image", name: "Image: the parser's diagram" });
  assert.deepEqual(imageAction("  a\n diagram "), { label: "Image", name: "Image: a diagram" });
  assert.deepEqual(imageAction(""), { label: "Image", name: "Image" });
  assert.deepEqual(imageAction(undefined), { label: "Image", name: "Image" });
  const room = placeById("room-actions").entries.find((entry) => entry.named)!;
  assert.equal(barDoes(room, imageAction("a diagram").name), "Image: a diagram");
  assert.equal(barDoes(room, imageAction("the parser's diagram").name), `${"Image: the parser's diagram".slice(0, BAR_NAME - 1)}…`);
  // Two images: each numbered after its label, its alt text kept; other repeats as before.
  const two = numberRepeats([{ label: "Copy", name: "Copy" }, { ...imageAction("a diagram") }, { ...imageAction("a photo") }, { label: "Copy code", name: "Copy code" }, { label: "Copy code", name: "Copy code" }, { label: "notes.md", name: "docs/notes.md" }, { label: "notes.md", name: "src/notes.md" }]);
  assert.deepEqual(two, [
    { label: "Copy", name: "Copy" },
    { label: "Image 1", name: "Image 1: a diagram" },
    { label: "Image 2", name: "Image 2: a photo" },
    { label: "Copy code 1", name: "Copy code 1" },
    { label: "Copy code 2", name: "Copy code 2" },
    { label: "notes.md 1", name: "docs/notes.md 1" },
    { label: "notes.md 2", name: "src/notes.md 2" },
  ]);
});

test("in Add member the crew is one row read in order, however it wraps: ← → along it to its ends, ↑ back to New and Existing, ↓ on", () => {
  // Eight crew members, on four lines in the dialog: ← → go through them in order, line to line, and stop at the ends.
  assert.equal(chipTarget(8, 0, "right"), 1);
  assert.equal(chipTarget(8, 1, "right"), 2, "on past the end of the first line");
  assert.equal(chipTarget(8, 2, "left"), 1);
  assert.equal(chipTarget(8, 7, "right"), null, "the last stays");
  assert.equal(chipTarget(8, 0, "left"), null, "the first stays");
  assert.equal(chipTarget(8, 5, "first"), 0);
  assert.equal(chipTarget(8, 2, "last"), 7);
  // From any of them, ↑ is New and Existing and ↓ the fields below, whatever line it is on.
  for (const at of [0, 3, 7]) {
    assert.equal(chipTarget(8, at, "up"), "above");
    assert.equal(chipTarget(8, at, "down"), "below");
  }
  assert.equal(chipTarget(1, 0, "right"), null, "one alone stays");
  assert.equal(chipTarget(8, -1, "right"), null, "from outside the crew, nothing");
});

test("the bar names Add member's keys: ↓ to the crew from New and Existing; on a crew member ↑ ↓ ← →, Enter and Space pick", () => {
  assert.deepEqual(bar("dialog-mode"), ["↓ the crew", "← → choose New or Existing", "Enter press it", "Tab Shift+Tab next or previous button or field", "Esc close it", "Backspace close it"]);
  assert.deepEqual(bar("dialog-crew"), ["↑ ↓ out of the crew", "← → along it", "Enter Space pick or unpick", "Tab Shift+Tab next or previous button or field", "Esc close it", "Backspace close it"]);
  // Home and End are in ? and README, off the bar, which has no room for them in the pixel look.
  assert.ok(placeById("dialog-crew").entries.some((entry) => entry.keys.includes("Home") && entry.bar === false));
  assert.ok(!bar("dialog-crew").some((line) => line.startsWith("?")), "? opens nothing over a dialog");
  assert.match(placeById("room-side-add").entries[0]!.more!, /↓ from New and Existing to the crew/);
});
