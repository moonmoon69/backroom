/**
 * The page's keys without the page (keys.ts does the DOM side): the table of every key by the place it works in, which
 * the key bar (KeyBar.tsx), the `?` list (KeyHelp.tsx) and README.md's Keyboard section are all drawn from, and the
 * overview's reading order with where each arrow goes, on items placed as the overview draws them.
 */

/** Something about the moment that changes what a key does (keys.ts, keyPlace, reads it off the page). */
export type KeyWhen = "typing" | "empty" | "composer-open" | "help";

/** What the conditions are called in `?` and README. */
const WHEN_WORDS: Record<KeyWhen, [when: string, unless: string]> = {
  typing: ["in a text field", "outside a text field"],
  empty: ["in an empty field", "with text in the field"],
  "composer-open": ["while the composer is open", "while the composer is closed"],
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
  | "room"
  | "room-post"
  | "room-tabs"
  | "room-strip"
  | "room-member"
  | "room-pane"
  | "room-button"
  | "room-other"
  | "member-thread"
  | "thread"
  | "thread-strip"
  | "thread-log"
  | "thread-other"
  | "browser-page"
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
        ],
      },
      { id: "overview-room", on: "a room's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the room" }] },
      { id: "overview-thread", on: "a thread's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the thread" }] },
      { id: "overview-member", on: "a member on a room's tile", within: "overview", entries: [{ keys: ["Enter"], does: "its thread, over its room", more: "read only; Esc goes back to the room, then the overview" }] },
      { id: "overview-crew", on: "a crew member", within: "overview", entries: [{ keys: ["Enter"], does: "edit them" }] },
      { id: "overview-browser", on: "a browser", within: "overview", entries: [{ keys: ["Enter"], does: "open its page" }] },
      { id: "overview-shelf", on: "settled or archived threads", within: "overview", entries: [{ keys: ["Enter"], does: "show or hide them" }] },
      {
        id: "overview-other",
        on: "a button, or nothing",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓", "←", "→"], does: "back to the tiles" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
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
          { keys: ["←", "→"], does: "between the board, Members, Browser and Git", more: "→ opens the side panel" },
          { keys: ["Esc"], does: "back to the overview", more: "the ring back on the room's tile" },
          { keys: ["Esc"], does: "close the composer", when: "composer-open" },
          { keys: ["a–z"], does: "start writing", more: "any letter opens the composer and goes in" },
        ],
      },
      {
        id: "room-post",
        on: "a post",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next post", more: "past the first, the earlier posts load, then the view's tabs" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "its detail" },
        ],
      },
      {
        id: "room-tabs",
        on: "the view's tabs",
        within: "room",
        entries: [
          { keys: ["←", "→"], does: "the chat or the board" },
          { keys: ["↓"], does: "back to the posts" },
        ],
      },
      {
        id: "room-strip",
        on: "the composer's strip",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "to the posts" },
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
          { keys: ["Enter"], does: "its thread, over the room", more: "read only; Esc comes back to the member" },
        ],
      },
      {
        id: "room-pane",
        on: "the Browser or Git panel",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "its buttons and fields, in order" },
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
          { keys: ["↑", "↓"], does: "to the posts" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "member-thread",
        on: "a member's thread",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓"], does: "scroll it" },
          { keys: ["Esc"], does: "back to the room", more: "Members open, the ring on the member" },
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
          { keys: ["Esc"], does: "back to the overview" },
          { keys: ["Esc"], does: "close the composer", when: "composer-open" },
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
      { id: "thread-other", on: "a button", within: "thread", entries: [{ keys: ["Enter"], does: "press it" }] },
      {
        id: "browser-page",
        on: "a browser's page",
        within: "everywhere",
        entries: [
          { keys: ["Enter"], does: "press it" },
          { keys: ["Esc"], does: "back to the overview" },
        ],
      },
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
          { keys: ["Backspace"], does: "close it", when: "empty" },
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
          { keys: ["Enter"], does: "press it" },
          { keys: ["Esc"], does: "close it", more: "the ring back where it was" },
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
          { keys: ["Esc"], does: "close it" },
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
          { keys: ["Alt+R"], does: "look for new models" },
          { keys: ["Esc"], does: "close the list" },
        ],
      },
    ],
  },
];

const PLACES = new Map(KEYS.flatMap((area) => area.places).map((place) => [place.id, place]));

export const placeById = (id: PlaceId): KeyPlace => PLACES.get(id)!;

/** The order keys take on the bar, wherever they are listed: the arrows first, `?` last. */
const KEY_RANK = ["↑", "↓", "←", "→", "Home", "End", "Enter", "Shift+Enter", "Tab", "Shift+Tab", "Esc", "Backspace", "a–z", "@", "/", "Alt+R", "?"];
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
