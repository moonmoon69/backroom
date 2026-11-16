/** How many of the view's items are drawn above the line, so a little of what was read stands over it. */
export const READ_ABOVE = 3;

/**
 * Where the "new" line goes in a room opened with news (docs/room.md, News): over the first item of the view that is
 * after the mark (the seq the room was seen up to before this opening) and not the user's own. `items` are the view's
 * items, oldest first, each as its posts (a day's separator has none); `shown` is how many of the latest are drawn.
 * Answers the item's index and the window that holds it, or null when nothing in the view is new. A first new post
 * older than the posts read is not looked for: the line is then over the first one read.
 */
export function lastReadLine(items: ReadonlyArray<ReadonlyArray<{ seq: number; author: string }>>, mark: number, shown: number): { over: number; shown: number } | null {
  const over = items.findIndex((posts) => posts.length > 0 && posts[0]!.seq > mark && posts[0]!.author !== "$user");
  return over < 0 ? null : { over, shown: Math.max(shown, items.length - over + READ_ABOVE) };
}
