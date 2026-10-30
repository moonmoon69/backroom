/**
 * What T3's watch of a pull request is waiting for, in a line (the user's #160, item D): "Watching pull request #70: 1
 * check pending (Browser harness) · watched for 8h". So a hung job shows in the room without opening GitHub.
 *
 * The sources: T3's checks read (pullRequests.checks: each check by name and status) and the link's snapshot
 * (checksState only: pending, failing or passing, with the watch's own record of the checks that failed), whichever T3
 * read later; the checks read when the snapshot does not say when it was read. Neither
 * says when a check started, so the time said is the watch's age, labelled as such; a reading older than STALE_MS says
 * how old it is. The line is detail only: the watch's task keeps its title, so a refresh never reads as work ending.
 */
import type { T3PullRequest, T3PullRequestChecks } from "../adapter/types.ts";

/** A reading of the checks older than this says its age. */
export const STALE_MS = 15 * 60_000;

/** "8h", "35m", "2d 3h": how long, in the largest units that say it. */
export function ageWords(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const PENDING = new Set(["pending", "action-required"]);
const FAILED = new Set(["failure", "cancelled"]);

/** "1 check pending (Browser harness)", "3 checks pending (A, B, …)". */
function counted(n: number, state: string, names: readonly string[]): string {
  const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ", …" : "");
  return `${n} check${n === 1 ? "" : "s"} ${state}${shown ? ` (${shown})` : ""}`;
}

/** What the checks are doing, from the freshest source there is; null when nothing says. */
function checksWords(link: T3PullRequest, checks: T3PullRequestChecks | null, now: number): string | null {
  const snapshot = (link.snapshot ?? {}) as { checksState?: unknown; syncedAt?: unknown };
  const synced = typeof snapshot.syncedAt === "string" ? snapshot.syncedAt : null;
  // An older checks read than the snapshot gives way to it: a fresh "passing" never reads as a check still pending.
  const readLater = checks !== null && (synced === null || (checks.observedAt !== null && Date.parse(checks.observedAt) >= Date.parse(synced)));
  if (checks && checks.checks.length > 0 && readLater) {
    const pending = checks.checks.filter((c) => PENDING.has(c.status));
    const failed = checks.checks.filter((c) => FAILED.has(c.status));
    const words = pending.length > 0 ? counted(pending.length, "pending", pending.map((c) => c.name)) : failed.length > 0 ? counted(failed.length, "failing", failed.map((c) => c.name)) : "checks passed";
    return withAge(words, checks.observedAt, now);
  }
  if (snapshot.checksState === "failing") return withAge(link.watch && link.watch.failedChecks.length > 0 ? counted(link.watch.failedChecks.length, "failing", link.watch.failedChecks) : "checks failing", synced, now);
  if (snapshot.checksState === "pending") return withAge("checks pending", synced, now);
  if (snapshot.checksState === "passing") return withAge("checks passed", synced, now);
  if (link.watch?.checksAwaitedSince) return `no checks yet, for ${ageWords(now - Date.parse(link.watch.checksAwaitedSince))}`;
  return null;
}

function withAge(words: string, at: string | null, now: number): string {
  const ms = at ? now - Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) && ms > STALE_MS ? `${words}, as of ${ageWords(ms)} ago` : words;
}

/** The watch's line: what its pull request waits for and how long the watch has run. */
export function watchLine(link: T3PullRequest, checks: T3PullRequestChecks | null, now: number): string {
  const state = (link.snapshot as { state?: unknown } | null)?.state;
  const what = state === "merged" || state === "closed" ? state : (checksWords(link, checks, now) ?? "checks not known yet");
  const age = link.watch ? ` · watched for ${ageWords(now - Date.parse(link.watch.startedAt))}` : "";
  return `Watching pull request #${link.number}: ${what}${age}`;
}

/** The thread's link a watch task is for: its task id names host, repository and number, as T3 forms it (lowercased). */
export function watchedLink(links: readonly T3PullRequest[], taskId: string): T3PullRequest | null {
  const match = /^pull-request-watch:([^/]*)\/(.+)#(\d+)$/.exec(taskId);
  if (!match) return null;
  return links.find((link) => (link.host ?? "").toLowerCase() === match[1] && link.repository.toLowerCase() === match[2] && link.number === Number(match[3])) ?? null;
}
