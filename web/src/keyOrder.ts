/**
 * The page's keys without the page (keys.ts does the DOM side): the table of every key by the place it works in, which
 * the key bar (KeyBar.tsx), the `?` list (KeyHelp.tsx) and README.md's Keyboard section are all drawn from, where each
 * arrow goes on the overview's grid, on items boxed as the overview draws them, a room's lanes with where each arrow
 * goes in them, and the order of the buttons in an item's action strip.
 */

/** Something about the moment that changes what a key does (keys.ts, keyPlace, reads it off the page). */
export type KeyWhen = "typing" | "empty" | "correcting" | "composer-open" | "chip-open" | "asking" | "panel-open" | "help" | "disabled";

/** What the conditions are called in `?` and README. */
const WHEN_WORDS: Record<KeyWhen, [when: string, unless: string]> = {
  typing: ["in a text field", "outside a text field"],
  empty: ["in an empty field", "with text in the field"],
  correcting: ["while a correction is open", "while no correction is open"],
  "composer-open": ["while the composer is open", "while the composer is closed"],
  "chip-open": ["while a status chip's choices are open", "while no chip's choices are open"],
  asking: ["on an approval's, a question's or a secret's choices", "on a failed or running turn's choices"],
  "panel-open": ["while the side panel is open", "while the side panel is folded"],
  help: ["while this list is open", "while this list is closed"],
  disabled: ["on a button that cannot be pressed now", "on a button that can be pressed"],
};

export interface KeyEntry {
  keys: string[];
  /** What the keys do there, worded by their effect, as the key bar says it ("open the room"). */
  does: string;
  /** More about it, for `?` and README only. */
  more?: string;
  /** Left off the key bar (Tab where it is not the way on): `?` and README only. */
  bar?: false;
  /** The bar says the name of the button the ring is on instead ("Enter Correct…"), cut to BAR_NAME characters. */
  named?: true;
  /** Only while this holds: it goes before an entry for the same key without it, which is the rest of the time. */
  when?: KeyWhen;
  unless?: KeyWhen;
  /** While its `when` holds it wins over every place's entry for the same key, wherever it is listed (Enter on a button that waits). */
  over?: true;
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
  | "room-talk"
  | "room-header"
  | "room-head-close"
  | "room-head-tab"
  | "room-head-panel"
  | "room-head-options"
  | "room-state"
  | "room-chip"
  | "room-post"
  | "room-actions"
  | "room-chip-actions"
  | "room-strip"
  | "room-side"
  | "room-side-panel"
  | "room-side-head"
  | "room-side-tab"
  | "room-side-add"
  | "room-side-close"
  | "room-member"
  | "room-member-actions"
  | "room-side-row"
  | "room-side-other"
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
  | "dialog-mode"
  | "dialog-crew"
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
          { keys: ["Enter"], does: "not now", when: "disabled", over: true, more: "the button waits for something, said beside it" },
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
          { keys: ["Esc", "Backspace"], does: "close composer", when: "composer-open", more: "the draft kept" },
          { keys: ["Esc", "Backspace"], does: "fold the choices", when: "chip-open", more: "a status chip's" },
          { keys: ["Esc", "Backspace"], does: "close correction", when: "correcting", more: "Correct…'s box, its text kept" },
          { keys: ["Backspace"], does: "fold the side panel", when: "panel-open", more: "the ring back on the conversation" },
          { keys: ["Backspace"], does: "back to the overview", more: "the ring back on the room's tile; Esc never leaves a room" },
          { keys: ["a–z"], does: "start writing", more: "any key that types a character, space aside, opens the composer and goes in" },
        ],
      },
      {
        id: "room-talk",
        on: "the conversation (its lanes)",
        within: "room",
        entries: [{ keys: ["→"], does: "the side panel", more: "its item nearest in height; folded, Members unfolds; along the header and the status chips → moves along them instead" }],
      },
      {
        id: "room-header",
        on: "the header (any of its buttons)",
        within: "room-talk",
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
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "the lane above or below" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "open or fold it" },
        ],
      },
      {
        id: "room-chip",
        on: "a status chip",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "the lane above or below" },
          { keys: ["←", "→"], does: "between the chips", more: "those with choices; it stops at the ends" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "its choices", more: "in a row under the bar, the ring on the first: an approval's Accept…, a question's options, a secret's field, a failed turn's Retry, a running turn's Stop and Stop everything, a paused member's Resume now and Don't resume, a held queue's Resume queue, then the posts it is about" },
        ],
      },
      {
        id: "room-post",
        on: "a post, or a turn running (its live bubble)",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next post", more: "past the first, the earlier posts load, then the status chips, the room state and the header; past the newest, the turns running now, then the composer's strip" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "its actions", more: "in a row under it, the ring on the first: every button the post has, then Detail, its detail" },
        ],
      },
      {
        id: "room-actions",
        on: "a post's actions",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next post", more: "the actions close" },
          { keys: ["←", "→"], does: "choose", more: "between its buttons; it stops at the ends" },
          { keys: ["Enter"], does: "press it", named: true, more: "the bar names the button the ring is on" },
          { keys: ["Esc", "Backspace"], does: "close", more: "the ring back on the post" },
          { keys: ["Home", "End"], does: "first or last post" },
        ],
      },
      {
        id: "room-chip-actions",
        on: "a status chip's choices",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "chip or posts", more: "↑ back to the chip, ↓ on to the posts; the choices fold" },
          { keys: ["←", "→"], does: "choose", more: "between its buttons; it stops at the ends" },
          { keys: ["Enter"], does: "press it", named: true, more: "the bar names the button the ring is on; Custom answer and a secret's field go into the field, Esc there comes back; Enter in a secret's field saves it; a held Enter presses nothing" },
          { keys: ["Esc", "Backspace"], does: "leave it waiting", when: "asking", more: "the choices fold, the ring back on the chip; the approval, question or secret still waits for you" },
          { keys: ["Esc", "Backspace"], does: "fold the choices", more: "the ring back on the chip" },
          { keys: ["Home", "End"], does: "first or last post" },
        ],
      },
      {
        id: "room-strip",
        on: "the composer's strip",
        within: "room-talk",
        entries: [
          { keys: ["↑"], does: "the posts", more: "the post you were on, else the newest" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "write a message" },
        ],
      },
      {
        id: "room-side",
        on: "anywhere in the side panel",
        within: "room",
        entries: [
          { keys: ["↑", "↓"], does: "row above or below", more: "its head (its tabs, + Add member, ×), then its members or rows; it stops at the ends" },
          { keys: ["←", "→"], does: "along the row", more: "it stops at the right end; ← from the row's first: back to the conversation, to its item nearest in height, the panel left open" },
          { keys: ["Home", "End"], does: "first or last in the panel", more: "under its head" },
        ],
      },
      { id: "room-side-panel", on: "the side panel itself", within: "room-side", entries: [{ keys: ["Enter"], does: "write a message" }] },
      {
        id: "room-side-head",
        on: "the side panel's head",
        within: "room-side",
        entries: [{ keys: ["←", "→"], does: "along its head", more: "Members, Browser, Git, + Add member (on Members), ×; ← from Members: back to the conversation" }],
      },
      { id: "room-side-tab", on: "Members, Browser or Git in the panel's head", within: "room-side-head", entries: [{ keys: ["Enter"], does: "show its panel" }] },
      { id: "room-side-add", on: "+ Add member in the panel's head", within: "room-side-head", entries: [{ keys: ["Enter"], does: "add a member", more: "its dialog: ↓ from New and Existing to the crew, ← → along it, Enter or Space picks; Tab between the fields, Enter in one adds" }] },
      { id: "room-side-close", on: "× in the panel's head", within: "room-side-head", entries: [{ keys: ["Enter"], does: "fold the panel", more: "the ring back on the conversation" }] },
      {
        id: "room-member",
        on: "a member, in Members",
        within: "room-side",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next member", more: "↑ from the first: the panel's head" },
          { keys: ["←"], does: "the conversation", more: "back to its item nearest in height, the panel left open" },
          { keys: ["Home", "End"], does: "first or last member" },
          { keys: ["Enter"], does: "its actions", more: "in a row under it, the ring on the first: Open thread, Settings…, Thread details…, Open in T3, Make or Remove as Consigliere, Remove from room…" },
        ],
      },
      {
        id: "room-member-actions",
        on: "a member's actions",
        within: "room-side",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next member", more: "the actions close" },
          { keys: ["←", "→"], does: "choose", more: "between its buttons; it stops at the ends" },
          { keys: ["Enter"], does: "press it", named: true, more: "the bar names the button the ring is on; Open thread opens it over the room, Backspace there comes back to the member" },
          { keys: ["Esc", "Backspace"], does: "close", more: "the ring back on the member" },
          { keys: ["Home", "End"], does: "first or last member", bar: false },
        ],
      },
      {
        id: "room-side-row",
        on: "a row of the Browser or Git panel",
        within: "room-side",
        entries: [{ keys: ["Enter"], does: "press it", more: "Browser: a switch, a browser's allow, make default, Edit, Page, Start or Stop; Git: a folder shows its state, a file its diff, a commit its files" }],
      },
      { id: "room-side-other", on: "another button in the side panel", within: "room-side", entries: [{ keys: ["Enter"], does: "press it" }] },
      {
        id: "room-button",
        on: "a button on a post",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "previous or next item", more: "from the post it is on" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-other",
        on: "another button",
        within: "room-talk",
        entries: [
          { keys: ["↑", "↓"], does: "the item above or below", more: "in its lane, else the lane above or below; outside the lanes, the posts" },
          { keys: ["Home", "End"], does: "first or last post" },
          { keys: ["Enter"], does: "press it" },
        ],
      },
      {
        id: "room-itself",
        on: "nothing in it",
        within: "room-talk",
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
          { keys: ["Enter"], does: "send it", more: "back to Correct…" },
          { keys: ["Shift+Enter"], does: "new line" },
          { keys: ["Tab"], does: "on to Send correction" },
          { keys: ["Esc"], does: "close it, back to Correct…", more: "the post's actions' Correct… when they are open" },
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
          { keys: ["Enter"], does: "not now", when: "disabled", more: "the button waits for something, said beside it" },
          { keys: ["Esc"], does: "close it", more: "the ring back where it was" },
          { keys: ["Backspace"], does: "close it", unless: "typing" },
          { keys: ["?"], does: "close the keys", when: "help" },
        ],
      },
      {
        id: "dialog-mode",
        on: "New or Existing, in Add member",
        within: "dialog",
        entries: [
          { keys: ["↓"], does: "the crew", more: "the crew member the ring was last on, else the first; under Existing, the threads" },
          { keys: ["←", "→"], does: "choose New or Existing", more: "the form under them changes with it" },
        ],
      },
      {
        id: "dialog-crew",
        on: "a crew member, in Add member",
        within: "dialog",
        entries: [
          { keys: ["↑", "↓"], does: "out of the crew", more: "↑ back to New and Existing; ↓ on to the fields, Name, or with several picked the buttons" },
          { keys: ["←", "→"], does: "along it", more: "along the crew, in order, across its lines; it stops at the ends" },
          { keys: ["Home", "End"], does: "first or last of the crew", bar: false },
          { keys: ["Enter", "Space"], does: "pick or unpick", more: "as a click does: one picked fills in the settings below, several are added at once; the form is not sent, and a held Enter picks once" },
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

/**
 * The four keys, as `?` and README's Keyboard section open with them (the design's key map, K1-Fable section 2): the
 * arrows move, Enter goes in, Backspace goes back, Esc closes what is in front.
 */
export const FOUR_KEYS: Array<{ keys: string[]; does: string }> = [
  { keys: ["↑", "↓", "←", "→"], does: "move the ring to the nearest item that way; they press nothing (an action strip or a chip's choices the ring leaves fold, and → off a room's conversation unfolds the side panel to go into it)" },
  { keys: ["Enter"], does: "go in: open what the ring is on (a tile, a status chip's choices, a post's or a member's actions), press a button" },
  { keys: ["Backspace"], does: "back out one step: what is in front, then a member's thread, the side panel, the room; the one key that leaves a room (in a text field it deletes)" },
  { keys: ["Esc"], does: "close what is in front (a menu, an action strip, a dialog, the composer with its draft kept, these keys), and nothing else" },
];

/** README's list of the four keys (scripts/keys-readme.ts draws it at the top of the Keyboard section). */
export const fourKeysMarkdown = (): string => FOUR_KEYS.map(({ keys, does }) => `- ${keys.map((key) => `\`${key}\``).join(" ")}: ${does}.`).join("\n");

const PLACES = new Map(KEYS.flatMap((area) => area.places).map((place) => [place.id, place]));

export const placeById = (id: PlaceId): KeyPlace => PLACES.get(id)!;

/**
 * The order keys take on the bar, wherever they are listed: the arrows first, `?` last. A key that does not fit the
 * window is left out from the end (KeyBar.tsx), so the ones needed least come last: Home and End after the letters.
 */
const KEY_RANK = ["↑", "↓", "←", "→", "Enter", "Space", "Shift+Enter", "Tab", "Shift+Tab", "Esc", "Backspace", "a–z", "@", "/", "Home", "End", "Alt+1…9", "Alt+R", "?"];
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
  const chain: KeyPlace[] = [];
  for (let place: KeyPlace | undefined = placeById(id); place; place = place.within ? placeById(place.within) : undefined) chain.push(place);
  // An entry that wins wherever it is listed (Enter on a button that waits) while its condition holds, taken first.
  for (const entry of chain.flatMap((place) => place.entries)) {
    if (!entry.over || !entry.when || !holds.has(entry.when) || entry.keys.some((key) => taken.has(key))) continue;
    for (const key of entry.keys) taken.add(key);
    if (entry.bar !== false) shown.push(entry);
  }
  for (const place of chain) {
    for (const entry of [...place.entries].sort((a, b) => Number(Boolean(b.when)) - Number(Boolean(a.when)))) {
      if ((entry.when && !holds.has(entry.when)) || (entry.unless && holds.has(entry.unless))) continue;
      if (entry.keys.some((key) => taken.has(key))) continue;
      for (const key of entry.keys) taken.add(key);
      if (entry.bar !== false) shown.push(entry);
    }
  }
  return shown.sort((a, b) => rank(a) - rank(b));
}

/** The longest a button's name gets on the bar (a file chip, a link): longer ones are cut with an ellipsis. */
export const BAR_NAME = 18;

/** What the bar says an entry does: its words, or for a named one the name of the button the ring is on. */
export function barDoes(entry: KeyEntry, name?: string | null): string {
  if (!entry.named || !name) return entry.does;
  return name.length > BAR_NAME ? `${name.slice(0, BAR_NAME - 1)}…` : name;
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

/**
 * Where a key goes from crew chip `at` of `count` in the Add member dialog, the crew read in order however its lines
 * wrap: ← → to the chip beside it, null at the ends (the ring stays); Home and End to the first and last; ↑ back to New
 * and Existing ("above"); ↓ on to the fields below ("below"). Null from outside the chips.
 */
export function chipTarget(count: number, at: number, key: NavKey): number | "above" | "below" | null {
  if (at < 0 || at >= count) return null;
  if (key === "up") return "above";
  if (key === "down") return "below";
  if (key === "first") return 0;
  if (key === "last") return count - 1;
  const next = at + (key === "right" ? 1 : -1);
  return next >= 0 && next < count ? next : null;
}

/**
 * Across a room's two columns (the conversation, the side panel): the item of the other column nearest in height to the
 * one the ring is on (`from`, its top and bottom), of those in view: in the row nearest it (the least gap, then the
 * nearest top), the row's first.
 */
export function nearestInHeight<T>(items: Boxed<T>[], from: { top: number; bottom: number }): Boxed<T> | null {
  const nearest = first(
    items,
    (item) => apart(item.top, item.bottom, from.top, from.bottom),
    (item) => Math.abs(item.top - from.top),
  );
  return nearest && first(items.filter((item) => item === nearest || overlap(item.top, item.bottom, nearest.top, nearest.bottom)), (item) => item.left);
}

/** Where the ring starts with nothing focused: the first tile that needs you, else the first tile, else the first item. */
export function gridStart<T>(items: Boxed<T>[]): Boxed<T> | null {
  return items.find((item) => item.tile && item.needs) ?? items.find((item) => item.tile) ?? items[0] ?? null;
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
  /**
   * The posts lane: its newest post, where End goes, when the turns running now (their live bubbles, items after the
   * posts) follow it. Without it End goes to the lane's last item.
   */
  newest?: T;
}

/** Where the ring is in the lanes: on an item, or on something of a lane between its items (before the item `before`). */
export type LaneAt = { lane: number; item: number } | { lane: number; before: number };

/** A lane move: to an item; on past the first post into the earlier ones (drawn first); nowhere (the key is taken); not a lane key (null). */
export type LaneMove<T> = { to: T } | { earlier: true } | "stay" | null;

/** The lanes ← → move along; elsewhere → goes into the side panel (OverviewRoom). */
const ACROSS = new Set<Lane<unknown>["name"]>(["header", "status"]);

/**
 * Where a key moves in a room's lanes from `at` (null: from nothing in particular, the room itself). ↑ ↓ go post to post
 * in the posts lane (past the newest post, on to the turns running now) and lane to lane elsewhere, landing on the next
 * lane's landing; past the first post, with earlier posts to draw (`earlier`), they are drawn first. From something of a lane that is no item, they go to the lane's
 * landing when an item of the lane is on that side of it (in the posts, the post above or below), else on to the next
 * lane. ← → go along the header and the status chips, stopping at the ends, and are the room's anywhere else (null).
 * Home and End go to the first and the newest post.
 */
export function laneTarget<T>(lanes: Lane<T>[], at: LaneAt | null, key: NavKey, earlier = false): LaneMove<T> {
  const postsAt = lanes.findIndex((lane) => lane.name === "posts");
  const posts = postsAt >= 0 ? lanes[postsAt]!.items : [];
  if (key === "first" || key === "last") return posts.length > 0 ? { to: key === "first" ? posts[0]! : (lanes[postsAt]!.newest ?? posts.at(-1)!) } : "stay";
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
    // Something of a lane after its items (a chip's open choices, the room state's text): Up is back to the lane's
    // landing (the item last visited there: the chip whose choices are open).
    return { to: lane.landing };
  }
  const beyond = lanes[at.lane + step];
  return beyond ? { to: beyond.landing } : "stay";
}

/** Whether a turn in this phase can be stopped from its status chip (its choices show Stop): not one still being
 * prepared, one T3 refused, or one that has ended. */
export const runCanStop = (phase: string): boolean => phase !== "prepared" && phase !== "rejected" && phase !== "terminal";

/**
 * Whether a status chip is a stop of the room's status lane: its choices offer something to press (as a running turn's
 * bubble is a stop only then, K1-5), so Enter on it never does nothing. An approval or a question always; a notice that
 * needs you always (Dismiss at least); a member's paused turn or held queue always (Resume); a running turn its Stop, in the phases its choices show it, or a post it is about
 * ("show #n").
 */
export function chipOffers(chip: { kind: "ask" | "notice" | "member" } | { kind: "run"; phase: string; member: boolean; posts: number }): boolean {
  return chip.kind !== "run" || (chip.member && runCanStop(chip.phase)) || chip.posts > 0;
}

/** What a room offers the ring as it opens, read off the page (OverviewRoom). */
export interface OpenChoices<T> {
  /** The first status chip that needs you (an approval, a question, a failed turn). */
  needs: T | null;
  /** The newest post, and whether enough of it shows in the board's view to see the ring around it. */
  newest: T | null;
  newestInView: boolean;
  /** A running turn's status chip. */
  running: T | null;
  /** The composer's strip. */
  strip: T | null;
}

/**
 * Where the ring lands when a room opens, always on something in view: the first chip that needs you; else the newest
 * post if it shows in the board's view (a running turn's live bubble under it can push it out); else the running
 * turn's chip; else the composer's strip.
 */
export function openLanding<T>(choices: OpenChoices<T>): T | null {
  return choices.needs ?? (choices.newestInView ? choices.newest : null) ?? choices.running ?? choices.strip;
}

/**
 * The kinds of button an item's action strip holds, in the order it shows them (the design's section 4, K1-Fable): a
 * request's Correct… and Cancel (a message to several members has a pair for each request, in turn), a failed turn's
 * Retry and Dismiss, a running turn's Stop and the choices of what it asks you; then Copy, Read aloud, each #ref, each
 * file chip, each image, "turn in T3", "sent to T3"; then what else a mouse finds on the item (a link, a code block's
 * Copy, a folded text, a live feed's earlier part, anything more); and Detail, the post's detail, last.
 */
export const ACTION_KINDS = ["correct", "cancel", "retry", "dismiss", "stop", "choice", "copy", "speak", "ref", "file", "image", "turn", "sent", "link", "code", "text", "more", "other", "detail"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Where a kind stands in the strip: Cancel with Correct…, so each request's pair stays together. */
const actionRank = (kind: ActionKind): number => ACTION_KINDS.indexOf(kind === "cancel" ? "correct" : kind);

/** An item's buttons in the strip's order: by kind (ACTION_KINDS), and as the item draws them within a kind. */
export function stripOrder<T extends { kind: ActionKind }>(controls: readonly T[]): T[] {
  return controls
    .map((control, index) => ({ control, index }))
    .sort((a, b) => actionRank(a.control.kind) - actionRank(b.control.kind) || a.index - b.index)
    .map(({ control }) => control);
}

/**
 * Where ← or → goes in a strip from button `at`, given which buttons can be pressed: the nearest one that can on that
 * side; null at the end (the ring stays) or from outside the strip.
 */
export function stripStep(enabled: readonly boolean[], at: number, key: "left" | "right"): number | null {
  if (at < 0 || at >= enabled.length) return null;
  const step = key === "right" ? 1 : -1;
  for (let next = at + step; next >= 0 && next < enabled.length; next += step) if (enabled[next]) return next;
  return null;
}

/**
 * A strip's image button: "Image" on it, named with the image's alt text ("Image: the parser's diagram"), as the post's
 * own button is ("Open image: …"), so a screen reader and the bar's Enter say which image it is.
 */
export function imageAction(alt: string | null | undefined): { label: string; name: string } {
  const said = (alt ?? "").replace(/\s+/g, " ").trim();
  return { label: "Image", name: said ? `Image: ${said}` : "Image" };
}

/**
 * A strip's repeated labels, numbered in order ("Image 1", "Image 2"). A name that begins with its label takes the
 * number after the label ("Image 1: a diagram"); any other takes it at its end.
 */
export function numberRepeats<T extends { label: string; name: string }>(controls: readonly T[]): T[] {
  const times = new Map<string, number>();
  for (const control of controls) times.set(control.label, (times.get(control.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return controls.map((control) => {
    if ((times.get(control.label) ?? 0) < 2) return control;
    const n = (seen.get(control.label) ?? 0) + 1;
    seen.set(control.label, n);
    const label = `${control.label} ${n}`;
    return { ...control, label, name: control.name.startsWith(control.label) ? `${label}${control.name.slice(control.label.length)}` : `${control.name} ${n}` };
  });
}
