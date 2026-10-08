/**
 * A room's keep-alive setting (H6), in the kv table. The engine host wakes an idle seat whose work is in flight once
 * nothing has woken it for the interval, so its thread's prompt cache, which lasts an hour, stays warm
 * (src/runtime/host.ts). The interval is the room's own, else ROOMS_KEEPALIVE_MS, else 55 minutes, and always under
 * the hour. Keep-alives are on for the Consigliere and off for members unless the room turns them on or off for one;
 * the choice is kept by member, so a reseat keeps it. The Consigliere sets it with `rooms-board keepalive`.
 */
import type { Repos } from "../db/repos.ts";
import type { KeepAliveSetting } from "../runtime/index.ts";

/** The prompt cache's lifetime: an interval at or over it keeps nothing warm. */
export const CACHE_LIFETIME_MS = 60 * 60_000;

export interface RoomKeepAlive {
  /** The room's own interval; null leaves ROOMS_KEEPALIVE_MS's. */
  intervalMs: number | null;
  /** Members (by participant ID) the room turned keep-alives on (true) or off (false) for; the rest have the default. */
  members: Record<string, boolean>;
}

/** kv key of a room's keep-alive setting. */
export const keepAliveKey = (roomId: string): string => `room.keepalive:${roomId}`;

/** A whole number of milliseconds, at least one minute and under the cache's hour. */
export function validInterval(ms: number): boolean {
  return Number.isInteger(ms) && ms >= 60_000 && ms < CACHE_LIFETIME_MS;
}

export function readKeepAlive(repos: Repos, roomId: string): RoomKeepAlive {
  const raw = repos.getKv(keepAliveKey(roomId));
  if (!raw) return { intervalMs: null, members: {} };
  try {
    const value = JSON.parse(raw) as Partial<RoomKeepAlive>;
    const members = Object.fromEntries(Object.entries(value.members ?? {}).filter(([, on]) => typeof on === "boolean"));
    return { intervalMs: typeof value.intervalMs === "number" && validInterval(value.intervalMs) ? value.intervalMs : null, members };
  } catch {
    return { intervalMs: null, members: {} };
  }
}

export function writeKeepAlive(repos: Repos, roomId: string, value: RoomKeepAlive): void {
  repos.setKv(keepAliveKey(roomId), JSON.stringify(value));
}

/** What the host reads for a seat: the room's interval (or `defaultMs`, ROOMS_KEEPALIVE_MS's) and the room's choice for its member. */
export function keepAliveSetting(repos: Repos, defaultMs: number): (roomId: string, seatId: string) => KeepAliveSetting {
  return (roomId, seatId) => {
    const room = readKeepAlive(repos, roomId);
    const participantId = repos.getBinding(seatId)?.participantId;
    const on = participantId === undefined ? undefined : room.members[participantId];
    return { intervalMs: room.intervalMs ?? defaultMs, on: on ?? null };
  };
}
