/**
 * How Backroom words a usage-limit pause, on the page (in the viewer's time zone) and in the room's notices (in the
 * service's, named). Shared by the server and the page.
 */

/** The providers' names as T3 shows them, by T3 instance; another instance is named by its id. */
const PROVIDERS: Readonly<Record<string, string>> = { claudeAgent: "Claude", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", opencode: "OpenCode" };

export const providerLabel = (instanceId: string): string => PROVIDERS[instanceId] ?? instanceId;

/**
 * When a limit resets, in `timeZone` (the runtime's own when omitted): "15:30" on the day of `now` there, "15:30 on Sat
 * 31 Oct" on another day. Null for no time or an unreadable one.
 */
export function resetTime(resetAt: string | null, now: number, timeZone?: string): string | null {
  const at = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (!Number.isFinite(at)) return null;
  const zone = timeZone ? { timeZone } : {};
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return day(at) === day(now) ? time : `${time} on ${new Intl.DateTimeFormat("en-GB", { ...zone, weekday: "short", day: "numeric", month: "short" }).format(at)}`;
}

/** "paused on Claude's limit until 15:30", "… until it resets" when the time is unknown, "… (reset passed)" once it has passed. */
export function pauseLabel(limit: { provider: string; resetAt: string | null }, now: number, timeZone?: string): string {
  const who = `paused on ${providerLabel(limit.provider)}'s limit`;
  const time = resetTime(limit.resetAt, now, timeZone);
  if (time === null) return `${who} until it resets`;
  return Date.parse(limit.resetAt!) <= now ? `${who}, reset at ${time}` : `${who} until ${time}`;
}

/**
 * Whether a post is the room's notice of a turn a usage limit paused (the engine host writes it: "@w's turn is paused on
 * Claude's usage limit until …"): the board tags it paused, not failed.
 */
export const isPausedNotice = (body: string): boolean => /'s turn is paused on .+'s usage limit/.test(body);
