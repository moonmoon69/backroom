/**
 * The page's keys without the page (keys.ts does the DOM side): the table of every key by the place it works in, which
 * the key bar (KeyBar.tsx), the `?` list (KeyHelp.tsx) and README.md's Keyboard section are all drawn from, the
 * overview's reading order with where each arrow goes, on items placed as the overview draws them, and a room's lanes
 * with where each arrow goes in them.
 */

/** Something about the moment that changes what a key does (keys.ts, keyPlace, reads it off the page). */
export type KeyWhen = "typing" | "empty" | "correcting" | "composer-open" | "chip-open" | "panel-open" | "help";

/** What the conditions are called in `?` and README. */
const WHEN_WORDS: Record<KeyWhen, [when: string, unless: string]> = {
  typing: ["in a text field", "outside a text field"],
  empty: ["in an empty field", "with text in the field"],
  correcting: ["while a correction is open", "while no correction is open"],
  "composer-open": ["while the composer is open", "while the composer is closed"],
  "chip-open": ["while a status chip's choices are open", "while no chip's choices are open"],
  "panel-open": ["while the side panel is open", "while the side panel is folded"],
  help: ["while this list is open", "while this list is closed"],
};

export interface KeyEntry {
  keys: string[];
  /** What the keys do there, worded by their effect, as the key bar says it ("open the room"). */
  does: string;
  /** More about it, for `?` and README only. */
  more?: string;
  /** Left off the key bar (Tab where it is not the way on): `?` and README only. */
  bar?: false;
  /** Only while this holds: it goes before an entry for the same key without it, which is the rest of the time. */
  when?: KeyWhen;
  unless?: KeyWhen;
}

/** Every place the ring (the focus) can be, as keys.ts tells them apart. */
export type PlaceId =
  | "everywhere"
  | "overview"
  | "overview-room"
  | "overview-thread"
  | "overview-member"
  | "overview-crew"
  | "overview-browser"
  | "overview-shelf"
  | "overview-other"
  | "overview-page"
  | "room"
  | "room-header"
  | "room-head-close"
  | "room-head-tab"
  | "room-head-panel"
  | "room-head-options"
  | "room-state"
  | "room-chip"
  | "room-post"
  | "room-strip"
  | "room-member"
  | "room-pane"
  | "room-pane-button"
  | "room-members"
  | "room-members-button"
  | "room-button"
  | "room-other"
  | "room-itself"
  | "member-thread"
  | "thread"
  | "thread-strip"
  | "thread-log"
  | "thread-other"
  | "thread-itself"
  | "browser-page"
  | "browser-other"
  | "composer"
  | "room-composer"
  | "suggestions"
  | "correction"
  | "field"
  | "dialog"
  | "menu"
  | "model-list";

export interface KeyPlace {
  id: PlaceId;
  /** What the ring is on there, as `?` and README name it ("a room's tile"). */
  on: string;
  /**
   * The place whose keys work here too, under these (a tile's keys are the overview's and its own Enter). Dialogs and
   * menus are within nothing: what is under them is out of reach, `?` included.
   */
  within?: PlaceId;
  entries: KeyEntry[];
}

/** The ring's places by area, each key worded by what it does there. */
export const KEYS: Array<{ area: string; places: KeyPlace[] }> = [
  {
    area: "Everywhere",
    places: [
      {
        id: "everywhere",
        on: "anywhere",
        entries: [
          { keys: ["?"], does: "all keys", unless: "typing" },
          { keys: ["Tab", "Shift+Tab"], does: "every button, link and field, in order", bar: false },
        ],
      },
    ],
  },
  {
    area: "Overview",
    places: [
      {
        id: "overview",
        on: "a tile or a member",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next, column by column", more: "section by section: each project, its settled and archived threads, the crew, the browsers" },
          { keys: ["←", "→"], does: "the column beside, at the same height" },
          { keys: ["Home", "End"], does: "first or last on the page" },
          { keys: ["Backspace"], does: "nothing to go back to", more: "the overview is the top", bar: false },
        ],
      },
      { id: "overview-room", on: "a room's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the room" }] },
      { id: "overview-thread", on: "a thread's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the thread" }] },
      { id: "overview-member", on: "a member on a room's tile", within: "overview", entries: [{ keys: ["Enter"], does: "its thread, over its room", more: "read only; Backspace goes back to the room, folds the panel, then back to the overview" }] },
      { id: "overview-crew", on: "a crew member", within: "overview", entries: [{ keys: ["Enter"], does: "edit them" }] },
      { id: "overview-browser", on: "a browser", within: "overview", entries: [{ keys: ["Enter"], does: "open its page" }] },
      { id: "overview-shelf", on: "settled or archived threads", within: "overview", entries: [{ keys: ["Enter"], does: "show or hide them" }] },
      {
        id: "overview-other",
        on: "a button",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓", "←", "→"], does: "to the tiles" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      { id: "overview-page", on: "nothing", within: "everywhere", entries: [{ keys: ["↑", "↓", "←", "→"], does: "to the tiles" }] },
    ],
  },
  {
    area: "In a room",
    places: [
      {
        id: "room",
        on: "anywhere in it",
        within: "everywhere",
        entries: [
          { keys: ["←", "→"], does: "between the panes", more: "the board, Members, Browser and Git; → opens the side panel; along the header and the status chips they move along them instead" },
          { keys: ["Esc", "Backspace"], does: "close composer", when: "composer-open", more: "the draft kept" },
          { keys: ["Esc", "Backspace"], does: "fold the choices", when: "chip-open", more: "a status chip's" },
          { keys: ["Esc", "Backspace"], does: "close correction", when: "correcting", more: "Correct…'s box, its text kept" },
          { keys: ["Backspace"], does: "fold the side panel", when: "panel-open", more: "the ring back on the conversation" },
          { keys: ["Backspace"], does: "back to the overview", more: "the ring back on the room's tile; Esc never leaves a room" },
          { keys: ["a–z"], does: "start writing", more: "any key that types a character, space aside, opens the composer and goes in" },
        ],
      },
      {
        id: "room-header",
        on: "the header (any of its buttons)",
        within: "room",
        entries: [
          { keys: ["←", "→"], does: "along the header", more: "×, the chat and the board, Members, Browser, Git, the room's options; it stops at its ends" },
          { keys: ["↓"], does: "the lane below", more: "the room state, the status chips or the posts, the first there is" },
          { keys: ["Home", "End"], does: "first or last post" },
        ],
      },
      { id: "room-head-close", on: "× in the header", within: "room-header", entries: [{ keys: ["Enter"], does: "back to the overview" }] },
      { id: "room-head-tab", on: "a view's tab in the header", within: "room-header", entries: [{ keys: ["Enter"], does: "show this view", more: "the chat with the Consigliere, or the board" }] },
      { id: "room-head-panel", on: "Members, Browser or Git in the header", within: "room-header", entries: [{ keys: ["Enter"], does: "open or fold its panel", more: "opened, the ring goes into it; Backspace there brings it back" }] },
      { id: "room-head-options", on: "the room's options (⋯) in the header", within: "room-header", entries: [{ keys: ["Enter"], does: "its menu", more: "read new replies aloud, rename, delete" }] },
      {
        id: "room-state",
        on: "the room state",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "the lane above or below" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "open or fold it" },
        ],
      },
      {
        id: "room-chip",
        on: "a status chip",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "the lane above or below" },
          { keys: ["←", "→"], does: "between the chips", more: "those with choices; it stops at the ends" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "its choices", more: "again to fold them" },
        ],
      },
      {
        id: "room-post",
        on: "a post",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next post", more: "past the first, the earlier posts load, then the status chips, the room state and the header; past the last, the composer's strip" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "its detail" },
        ],
      },
      {
        id: "room-strip",
        on: "the composer's strip",
        within: "room",
        entries: [
          { keys: ["↑"], does: "the posts", more: "the post you were on, else the newest" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "room-member",
        on: "a member, in Members",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next member" },
          { keys: ["Home", "End"], does: "first or last member" },
          { keys: ["Enter"], does: "its thread", more: "over the room, read only; Backspace comes back to the member" },
        ],
      },
      {
        id: "room-pane",
        on: "the Browser or Git panel itself",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "its buttons and fields" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "room-pane-button",
        on: "a button in the Browser or Git panel",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "its buttons and fields, in order" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-members",
        on: "the Members panel itself",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "to the members" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "room-members-button",
        on: "a button in the Members panel's head",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "to the members" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-button",
        on: "a button on a post or a member",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next item", more: "from the post or member it is on" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-other",
        on: "another button",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "the item above or below", more: "in its lane, else the lane above or below; outside the lanes, the posts" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-itself",
        on: "nothing in it",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "to the posts" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "member-thread",
        on: "a member's thread",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓"], does: "scroll it" },
          { keys: ["Backspace"], does: "back to the room", more: "Members open, the ring on the member" },
        ],
      },
    ],
  },
  {
    area: "A thread or a browser",
    places: [
      {
        id: "thread",
        on: "anywhere in a thread",
        within: "everywhere",
        entries: [
          { keys: ["Esc", "Backspace"], does: "close composer", when: "composer-open", more: "the draft kept" },
          { keys: ["Backspace"], does: "back to the overview" },
          { keys: ["a–z"], does: "start writing" },
        ],
      },
      {
        id: "thread-strip",
        on: "the composer's strip",
        within: "thread",
        entries: [
          { keys: ["↑"], does: "the conversation" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "thread-log",
        on: "the conversation",
        within: "thread",
        entries: [
          { keys: ["↑", "↓"], does: "scroll it" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      { id: "thread-other", on: "a button in a thread", within: "thread", entries: [{ keys: ["Enter"], does: "press it" }] },
      { id: "thread-itself", on: "nothing in a thread", within: "thread", entries: [{ keys: ["Enter"], does: "write a message" }] },
      { id: "browser-page", on: "a browser's page", within: "everywhere", entries: [{ keys: ["Backspace"], does: "back to the overview" }] },
      { id: "browser-other", on: "a button on it", within: "browser-page", entries: [{ keys: ["Enter"], does: "press it" }] },
    ],
  },
  {
    area: "Writing",
    places: [
      {
        id: "composer",
        on: "the message",
        within: "everywhere",
        entries: [
          { keys: ["Enter"], does: "send" },
          { keys: ["Shift+Enter"], does: "new line" },
          { keys: ["Esc"], does: "close it, the draft kept" },
          { keys: ["Backspace"], does: "close it", when: "empty", more: "on a fresh press, not a held one's repeats" },
        ],
      },
      {
        id: "room-composer",
        on: "the message, in a room",
        within: "composer",
        entries: [
          { keys: ["@"], does: "mention a member" },
          { keys: ["/"], does: "a command" },
        ],
      },
      {
        id: "suggestions",
        on: "the @ or / list",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓"], does: "choose" },
          { keys: ["Enter", "Tab"], does: "take it" },
          { keys: ["Esc"], does: "close the list" },
        ],
      },
      {
        id: "correction",
        on: "a correction",
        within: "everywhere",
        entries: [
          { keys: ["Enter"], does: "new line" },
          { keys: ["Tab"], does: "on to Send correction" },
          { keys: ["Esc"], does: "close it, back to Correct…" },
        ],
      },
      { id: "field", on: "another text field", within: "everywhere", entries: [{ keys: ["Esc"], does: "leave the field", more: "the ring goes to the item it is in" }] },
    ],
  },
  {
    area: "Dialogs and menus",
    places: [
      {
        id: "dialog",
        on: "a dialog",
        entries: [
          { keys: ["Tab", "Shift+Tab"], does: "next or previous button or field", more: "round inside the dialog" },
          { keys: ["Enter"], does: "press it", unless: "typing" },
          { keys: ["Esc"], does: "close it", more: "the ring back where it was" },
          { keys: ["Backspace"], does: "close it", unless: "typing" },
          { keys: ["?"], does: "close the keys", when: "help" },
        ],
      },
      {
        id: "menu",
        on: "a menu",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next item" },
          { keys: ["Home", "End"], does: "first or last item" },
          { keys: ["Enter"], does: "choose it" },
          { keys: ["Esc", "Backspace"], does: "close it" },
          { keys: ["Tab"], does: "close it and go on" },
        ],
      },
      {
        id: "model-list",
        on: "the model list",
        entries: [
          { keys: ["↑", "↓"], does: "the models" },
          { keys: ["←", "→"], does: "the providers", more: "with the search empty" },
          { keys: ["Enter"], does: "choose it" },
          { keys: ["Shift+Enter"], does: "star or unstar it", more: "favorites" },
          { keys: ["Alt+1…9"], does: "pick by number", more: "the first nine in the list; Ctrl or ⌘ with the digit too" },
          { keys: ["Alt+R"], does: "find new models", more: "T3 looks for models it has not listed yet" },
          { keys: ["Esc"], does: "close the list" },
        ],
      },
    ],
  },
];

const PLACES = new Map(KEYS.flatMap((area) => area.places).map((place) => [place.id, place]));

export const placeById = (id: PlaceId): KeyPlace => PLACES.get(id)!;

/**
 * The order keys take on the bar, wherever they are listed: the arrows first, `?` last. A key that does not fit the
 * window is left out from the end (KeyBar.tsx), so the ones needed least come last: Home and End after the letters.
 */
const KEY_RANK = ["↑", "↓", "←", "→", "Enter", "Shift+Enter", "Tab", "Shift+Tab", "Esc", "Backspace", "a–z", "@", "/", "Home", "End", "Alt+1…9", "Alt+R", "?"];
const rank = (entry: KeyEntry): number => Math.min(...entry.keys.map((key) => (KEY_RANK.includes(key) ? KEY_RANK.indexOf(key) : KEY_RANK.length)));

/**
 * The keys the bar shows on a place now: the place's own, then those of the places it is within, each key once (the
 * nearest place's wording wins, an entry for while something holds wins over one for the rest of the time, and an entry
 * whose condition does not hold now is passed over), in KEY_RANK order.
 */
export function barEntries(id: PlaceId, now: Iterable<KeyWhen> = []): KeyEntry[] {
  const holds = new Set(now);
  const taken = new Set<string>();
  const shown: KeyEntry[] = [];
  for (let place: KeyPlace | undefined = placeById(id); place; place = place.within ? placeById(place.within) : undefined) {
    for (const entry of [...place.entries].sort((a, b) => Number(Boolean(b.when)) - Number(Boolean(a.when)))) {
      if ((entry.when && !holds.has(entry.when)) || (entry.unless && holds.has(entry.unless))) continue;
      if (entry.keys.some((key) => taken.has(key))) continue;
      for (const key of entry.keys) taken.add(key);
      if (entry.bar !== false) shown.push(entry);
    }
  }
  return shown.sort((a, b) => rank(a) - rank(b));
}

/** An entry as `?` and README say it: its effect, capitalised, with what more there is to it and when it holds. */
export function entryText(entry: KeyEntry): string {
  const notes = [entry.more, entry.when ? WHEN_WORDS[entry.when][0] : null, entry.unless ? WHEN_WORDS[entry.unless][1] : null].filter(Boolean);
  return `${entry.does[0]!.toUpperCase()}${entry.does.slice(1)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/** README.md's tables of the keys, as `?` lists them: one per area, a row per key on each place (named on its first). */
export function keysMarkdown(): string {
  return KEYS.map(({ area, places }) => {
    const rows = places.flatMap((place) => place.entries.map((entry, index) => `| ${index === 0 ? place.on : ""} | ${entry.keys.map((key) => `\`${key}\``).join(" ")} | ${entryText(entry)} |`));
    return [`**${area}**`, "", "| On | Keys | What they do |", "|---|---|---|", ...rows].join("\n");
  }).join("\n\n");
}

/** A key the page's navigation takes: the four arrows and the two ends. */
export type NavKey = "up" | "down" | "left" | "right" | "first" | "last";

/** Where an item sits, as the reading order needs it. */
export interface Placed<T> {
  element: T;
  /** Its section, in document order (`data-nav-section`). */
  section: number;
  /** The left edge of the card it is in (its column). */
  column: number;
  top: number;
  middle: number;
}

/** Reading order: section by section; inside a section column by column, left to right; each column top to bottom. */
export function inReadingOrder<T>(placed: Placed<T>[]): Placed<T>[] {
  return [...placed].sort((a, b) => a.section - b.section || a.column - b.column || a.top - b.top);
}

/**
 * Where a key moves from the item at `at` in a reading order (null: it stays). Down and Up are the next and previous
 * item; Left and Right the next column over in the same section, at the item there nearest in height; Home and End the
 * ends. With no current item (`at` < 0), the first.
 */
export function readingTarget<T>(order: Placed<T>[], at: number, key: NavKey): Placed<T> | null {
  if (order.length === 0) return null;
  if (key === "first" || at < 0) return order[0]!;
  if (key === "last") return order.at(-1)!;
  const here = order[at]!;
  if (key === "down") return order[at + 1] ?? null;
  if (key === "up") return order[at - 1] ?? null;
  const columns = [...new Set(order.filter((p) => p.section === here.section).map((p) => p.column))].sort((a, b) => a - b);
  const next = columns[columns.indexOf(here.column) + (key === "right" ? 1 : -1)];
  if (next === undefined) return null;
  const candidates = order.filter((p) => p.section === here.section && p.column === next);
  candidates.sort((a, b) => Math.abs(a.middle - here.middle) - Math.abs(b.middle - here.middle) || a.top - b.top);
  return candidates[0] ?? null;
}

/**
 * One of a room's lanes, as its conversation reads top to bottom: the header, the room state, the status chips, the
 * posts and the composer's strip (keys.ts reads them off the page; a lane with no item is left out).
 */
export interface Lane<T> {
  name: "header" | "state" | "status" | "posts" | "strip";
  items: T[];
  /** Where the ring lands coming into the lane from above or below (the item last visited there, else the lane's own). */
  landing: T;
}

/** Where the ring is in the lanes: on an item, or on something of a lane between its items (before the item `before`). */
export type LaneAt = { lane: number; item: number } | { lane: number; before: number };

/** A lane move: to an item; on past the first post into the earlier ones (drawn first); nowhere (the key is taken); not a lane key (null). */
export type LaneMove<T> = { to: T } | { earlier: true } | "stay" | null;

/** The lanes ← → move along; elsewhere they are the room's (between the panes). */
const ACROSS = new Set<Lane<unknown>["name"]>(["header", "status"]);

/**
 * Where a key moves in a room's lanes from `at` (null: from nothing in particular, the room itself). ↑ ↓ go post to post
 * in the posts lane and lane to lane elsewhere, landing on the next lane's landing; past the first post, with earlier
 * posts to draw (`earlier`), they are drawn first. From something of a lane that is no item, they go to the lane's item
 * on that side of it (in the posts, the post above or below), else on to the next lane. ← → go along the header and the status chips, stopping at the ends,
 * and are the room's anywhere else (null). Home and End go to the first and the last post.
 */
export function laneTarget<T>(lanes: Lane<T>[], at: LaneAt | null, key: NavKey, earlier = false): LaneMove<T> {
  const postsAt = lanes.findIndex((lane) => lane.name === "posts");
  const posts = postsAt >= 0 ? lanes[postsAt]!.items : [];
  if (key === "first" || key === "last") return posts.length > 0 ? { to: key === "first" ? posts[0]! : posts.at(-1)! } : "stay";
  if (key === "left" || key === "right") {
    if (!at || !("item" in at) || !ACROSS.has(lanes[at.lane]!.name)) return null;
    const next = lanes[at.lane]!.items[at.item + (key === "right" ? 1 : -1)];
    return next ? { to: next } : "stay";
  }
  const step = key === "down" ? 1 : -1;
  if (!at) {
    const lane = lanes[postsAt] ?? lanes.at(-1);
    return lane ? { to: lane.landing } : "stay";
  }
  const lane = lanes[at.lane]!;
  if (at.lane === postsAt) {
    const next = "item" in at ? at.item + step : at.before + (step > 0 ? 0 : -1);
    if (next >= 0 && next < posts.length) return { to: posts[next]! };
    if (next < 0 && "item" in at && earlier) return { earlier: true };
  } else if ("before" in at && (step > 0 ? at.before < lane.items.length : at.before > 0)) {
    // Something of a lane after its items (a chip's open choices, the room state's text): Up is back to the lane's item.
    return { to: lane.landing };
  }
  const beyond = lanes[at.lane + step];
  return beyond ? { to: beyond.landing } : "stay";
}
