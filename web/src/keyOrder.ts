/**
 * The page's keys without the page (keys.ts does the DOM side): the table of every key by the place it works in, which
 * the key bar (KeyBar.tsx), the `?` list (KeyHelp.tsx) and README.md's Keyboard section are all drawn from, and where
 * each arrow goes on the overview's grid, on items boxed as the overview draws them.
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
  | "overview-crew"
  | "overview-browser"
  | "overview-shelf"
  | "overview-head"
  | "overview-other"
  | "overview-page"
  | "room"
  | "room-post"
  | "room-tabs"
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
        on: "a tile or a button in a row",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓"], does: "the row above or below", more: "the nearest item there, across sections: the header's buttons, each section's +, its tiles, then the crew's and the browsers'; a run of ↑ ↓ keeps to the column it began in" },
          { keys: ["←", "→"], does: "along the row", more: "stops at the row's ends" },
          { keys: ["Home", "End"], does: "first or last in the row" },
          { keys: ["Backspace"], does: "nothing to go back to", more: "the overview is the top", bar: false },
        ],
      },
      { id: "overview-room", on: "a room's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the room", more: "its members are read on the tile, not visited; in the room, Members has them" }] },
      { id: "overview-thread", on: "a thread's tile", within: "overview", entries: [{ keys: ["Enter"], does: "open the thread" }] },
      { id: "overview-crew", on: "a crew member", within: "overview", entries: [{ keys: ["Enter"], does: "edit them", more: "the dialog's Seat in a room… seats them, as dragging them onto a room's tile does" }] },
      { id: "overview-browser", on: "a browser", within: "overview", entries: [{ keys: ["Enter"], does: "open its page" }] },
      { id: "overview-shelf", on: "settled or archived threads", within: "overview", entries: [{ keys: ["Enter"], does: "show or hide them" }] },
      { id: "overview-head", on: "a button in the header or a section's head", within: "overview", entries: [{ keys: ["Enter"], does: "press it" }] },
      {
        id: "overview-other",
        on: "a tile's ⋯, or another button",
        within: "everywhere",
        entries: [
          { keys: ["↑", "↓", "←", "→"], does: "as from its tile", more: "a button outside a tile: to the tiles" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      { id: "overview-page", on: "nothing", within: "everywhere", entries: [{ keys: ["↑", "↓", "←", "→"], does: "to the tiles", more: "the first that needs you, else the first" }] },
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
          { keys: ["←", "→"], does: "between the panes", more: "the board, Members, Browser and Git; → opens the side panel" },
          { keys: ["Esc", "Backspace"], does: "close composer", when: "composer-open", more: "the draft kept" },
          { keys: ["Esc", "Backspace"], does: "fold the choices", when: "chip-open", more: "a status chip's" },
          { keys: ["Esc", "Backspace"], does: "close correction", when: "correcting", more: "Correct…'s box, its text kept" },
          { keys: ["Backspace"], does: "fold the side panel", when: "panel-open", more: "the ring back on the conversation" },
          { keys: ["Backspace"], does: "back to the overview", more: "the ring back on the room's tile; Esc never leaves a room" },
          { keys: ["a–z"], does: "start writing", more: "any key that types a character, space aside, opens the composer and goes in" },
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
          { keys: ["↑", "↓"], does: "to the posts" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-itself",
        on: "nothing in it",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "to the posts" },
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

/** A stretch of the page across: an item's left and right edges, or the column a run of ↑ ↓ keeps to. */
export interface Span {
  left: number;
  right: number;
}

/** An item where it is drawn: its box on the page (a tile's is its whole card). */
export interface Boxed<T> extends Span {
  element: T;
  top: number;
  bottom: number;
  /** A tile (a room, a thread, a crew member, a browser), not a button in a row. */
  tile?: boolean;
  /** A tile that needs you (an approval, a question, a failure nobody followed up). */
  needs?: boolean;
}

/** Slack for edges that touch, in pixels. */
const EDGE = 1;
/** How far apart two stretches are; 0 when they overlap. */
const apart = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
const overlap = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > 0;
const middle = (span: Span): number => (span.left + span.right) / 2;
/** The first by these measures, each breaking the ties of the one before; the earliest in the list after that. */
const first = <T>(items: T[], ...by: Array<(item: T) => number>): T | null =>
  [...items].sort((a, b) => by.reduce((order, measure) => order || measure(a) - measure(b), 0))[0] ?? null;

/**
 * Where a key moves from `items[at]` on a page laid out in rows, as on a game grid (null: it stays). Down and Up go to
 * the nearest row below or above, across sections (the item nearest the ring's edge and the items beside it, whose
 * height overlaps its own), and in that row to the item in `column` (overlapping it across, else the nearest to it, and
 * of two there the nearer; the ring's own span when no run of ↑ ↓ is going on), so a section's head with one button at the far right is a row
 * passed on the way and does not pull the ring over. Left and Right go to the nearest item beside the ring whose
 * height overlaps its own, and stop at the row's ends; Home and End go to the row's first and last.
 */
export function gridTarget<T>(items: Boxed<T>[], at: number, key: NavKey, column?: Span): Boxed<T> | null {
  const here = items[at];
  if (!here) return null;
  const inRow = (item: Boxed<T>) => overlap(item.top, item.bottom, here.top, here.bottom);
  if (key === "first" || key === "last") return first(items.filter(inRow), (item) => (key === "first" ? item.left : -item.right));
  if (key === "left" || key === "right") {
    const beside = items.filter((item) => item !== here && inRow(item) && (key === "right" ? item.left >= here.right - EDGE : item.right <= here.left + EDGE));
    return first(beside, (item) => apart(item.left, item.right, here.left, here.right), (item) => Math.abs(item.top - here.top));
  }
  const down = key === "down";
  const ahead = items.filter((item) => item !== here && (down ? item.top >= here.bottom - EDGE : item.bottom <= here.top + EDGE));
  const edge = first(ahead, (item) => (down ? item.top : -item.bottom));
  if (!edge) return null;
  const span = column ?? here;
  return first(
    ahead.filter((item) => overlap(item.top, item.bottom, edge.top, edge.bottom)),
    (item) => apart(item.left, item.right, span.left, span.right),
    (item) => Math.abs(middle(item) - middle(span)),
    // Two in that column (tiles stacked beside a tall one): the nearer.
    (item) => (down ? item.top : -item.bottom),
  );
}

/** Where the ring starts with nothing focused: the first tile that needs you, else the first tile, else the first item. */
export function gridStart<T>(items: Boxed<T>[]): Boxed<T> | null {
  return items.find((item) => item.tile && item.needs) ?? items.find((item) => item.tile) ?? items[0] ?? null;
}
