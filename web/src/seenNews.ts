/** News the page has marked seen, against a list read before the mark landed (no DOM here: the tests import it). */

/**
 * A thread's news as the overview's own read has it, less what this page has marked seen since (`seenAt`, the time of
 * the finish it marked). The overview reads every five seconds and the mark lands at once, so without this a thread's
 * tile kept its "new" for up to five seconds after you looked at it, then moved under you when the read caught up.
 */
export function newsUnlessSeen<T extends { at: string }>(news: T | null, seenAt: string | undefined): T | null {
  return news && seenAt !== undefined && news.at <= seenAt ? null : news;
}
