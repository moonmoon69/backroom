/** News the page has marked seen, against a list read before the mark landed (no DOM here: the tests import it). */

/**
 * A thread's news as the overview's own read has it, less what this page has marked seen since (`seenAt`, the time of
 * the finish it marked). The overview reads every five seconds and the mark lands at once, so without this a thread's
 * tile kept its "new" for up to five seconds after you looked at it, then moved under you when the read caught up.
 */
export function newsUnlessSeen<T extends { at: string }>(news: T | null, seenAt: string | undefined): T | null {
  return news && seenAt !== undefined && news.at <= seenAt ? null : news;
}

/**
 * The threads the overview draws as tiles, with their news: its own read of them (null before the first), then T3's
 * list standing in for any the read left out, each without the news this page has marked seen (`seen`: thread id → the
 * finish it was marked up to). A thread's news is what puts its tile with the unseen ones (Overview.tsx, tierOf).
 */
export function overviewThreads<T extends { id: string; news: { at: string } | null }>(read: readonly T[] | null, standIn: readonly T[], seen: ReadonlyMap<string, string>): T[] {
  const listed = read ? [...read, ...standIn.filter((thread) => !read.some((d) => d.id === thread.id))] : [...standIn];
  return listed.map((thread) => ({ ...thread, news: newsUnlessSeen(thread.news, seen.get(thread.id)) }));
}
