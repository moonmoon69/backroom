/**
 * The page's keys without the page (keys.ts does the DOM side): the list `?` shows and README.md repeats, and the
 * overview's reading order with where each arrow goes, on items placed as the overview draws them.
 */

export interface KeyHelpEntry {
  keys: string[];
  what: string;
}

/** Every shortcut, by where it works: what `?` shows (KeyHelp.tsx) and README.md lists. */
export const KEYS: Array<{ where: string; entries: KeyHelpEntry[] }> = [
  {
    where: "Everywhere",
    entries: [
      { keys: ["?"], what: "Show these keys (outside a text field)" },
      { keys: ["Tab", "Shift+Tab"], what: "Every button, link and field, in order" },
      { keys: ["Enter"], what: "Open or press what has the focus" },
      { keys: ["Esc"], what: "Close what is in front: a menu, the composer (its draft kept), a status chip's choices, a Correct… box, a dialog, these keys; never the room, a member's thread or the side panel" },
      { keys: ["Backspace"], what: "Back one step, outside a text field: what is in front first, then a member's thread, the side panel, then the room to its card" },
    ],
  },
  {
    where: "Overview",
    entries: [
      { keys: ["↓", "↑"], what: "Next or previous card or member: column by column, each top to bottom" },
      { keys: ["→", "←"], what: "The column beside, at the same height" },
      { keys: ["Home", "End"], what: "First or last item on the page" },
      { keys: ["Enter"], what: "Open the room or thread; on a member, its room with the member's thread over it" },
    ],
  },
  {
    where: "In a room",
    entries: [
      { keys: ["↑", "↓"], what: "Previous or next post (or member, in Members); past the top the earlier posts load, then the view's tabs, where ← → switch the chat and the board and ↓ comes back" },
      { keys: ["←", "→"], what: "Between the panes: the board, Members, Browser, Git (opening the panel)" },
      { keys: ["Home", "End"], what: "First or last item of the pane" },
      { keys: ["Enter"], what: "On a post, its detail; on a member, its thread; elsewhere, write a message" },
    ],
  },
  {
    where: "Model list",
    entries: [
      { keys: ["↑", "↓"], what: "The models; ← → the providers (with the search empty)" },
      { keys: ["Enter"], what: "Choose the highlighted model" },
      { keys: ["Shift+Enter"], what: "Star or unstar it (favorites)" },
      { keys: ["Alt+R"], what: "Look for new models" },
    ],
  },
];

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
