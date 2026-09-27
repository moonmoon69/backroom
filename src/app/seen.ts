/**
 * What you have seen: one mark per room and per thread outside rooms, the time of the newest finish that was on screen
 * when you looked. The service keeps them (in kv), so looking on one device clears the news on the others. Before a
 * room or thread has a mark, "since" stands in: the time this service first kept marks, so what finished before then
 * is not news.
 */
import type { Repos } from "../db/repos.ts";

const PREFIX = "seen.";
const SINCE = `${PREFIX}since`;

/** "room:<id>" or "thread:<id>". */
export const SEEN_KEY = /^(room|thread):[A-Za-z0-9_-]{1,80}$/;

/** Start keeping marks (once): from now on, finishes are news until seen. */
export function startSeen(repos: Repos, at = new Date().toISOString()): void {
  if (repos.getKv(SINCE) === null) repos.setKv(SINCE, at);
}

/** Every mark, and the one that stands in for a key without its own. */
export function seenMarks(repos: Repos): { since: string; of: (key: string) => string } {
  const marks = repos.listKv(PREFIX);
  const since = marks.get(SINCE) ?? new Date(0).toISOString();
  return { since, of: (key) => marks.get(`${PREFIX}${key}`) ?? since };
}

/** Seen up to `at`; a mark only moves forward (another device may have seen more). Returns the mark kept. */
export function markSeen(repos: Repos, key: string, at: string): string {
  const current = seenMarks(repos).of(key);
  if (!isAfter(at, current)) return current;
  repos.setKv(`${PREFIX}${key}`, at);
  return at;
}

/** Whether ISO time `a` is later than `b` (as times: T3's and Backroom's clocks may write them differently). */
export const isAfter = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);
