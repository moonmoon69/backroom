/** How many of the view's items are drawn above the line, so a little of what was read stands over it. */
export const READ_ABOVE = 3;

/**
 * Where the "new" line goes (docs/room.md, News): over the first item of the view that is after the mark (the room's
 * last read) and not the user's own. `items` are the view's items, oldest first, each as its posts (a day's separator
 * has none). Answers the item's index, or null when nothing in the view is new. A first new post older than the posts
 * read is not looked for: the line is then over the first one read.
 */
export function lastReadLine(items: ReadonlyArray<ReadonlyArray<{ seq: number; author: string }>>, mark: number): number | null {
  const over = items.findIndex((posts) => posts.length > 0 && posts[0]!.seq > mark && posts[0]!.author !== "$user");
  return over < 0 ? null : over;
}

/**
 * The first of the view's items that is drawn. `start` is the seq the window starts at, or null for the latest
 * `limit` items; a line (`over`, lastReadLine's answer) has the window start no later than READ_ABOVE items above it.
 * The window starts with the day's separator over its first post. A limit of 0 draws everything.
 */
export function windowStart(items: ReadonlyArray<ReadonlyArray<{ seq: number }>>, start: number | null, limit: number, over: number | null): number {
  if (limit <= 0) return 0;
  const at = start === null ? -1 : items.findIndex((posts) => posts.length > 0 && posts[0]!.seq >= start);
  const latest = Math.max(0, items.length - limit);
  const first = Math.max(0, Math.min(at < 0 ? latest : at, over === null ? Infinity : over - READ_ABOVE));
  return first > 0 && items[first - 1]!.length === 0 ? first - 1 : first;
}

/**
 * Where the board puts itself when it follows its bottom: at `bottom` (its greatest scroll offset), or at `place` (the
 * offset that puts the held "new" line at its place near the top; null with no line held) when that is higher up,
 * where it follows no longer: what is new is longer than the screen.
 */
export function heldTop(bottom: number, place: number | null): { top: number; following: boolean } {
  return place !== null && place < bottom ? { top: Math.max(0, place), following: false } : { top: bottom, following: true };
}
