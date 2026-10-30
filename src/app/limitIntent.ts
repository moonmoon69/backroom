/**
 * What the user wants for a turn its usage limit paused, kept by Backroom per thread, run and reset: "stopped" when Stop
 * everything reached that run, "off" when Don't resume was pressed, nothing otherwise. T3's recovery record is
 * overwritten by any arming, so it cannot hold this: Backroom writes the intent before the command goes out, keeps it
 * across a restart, and brings T3's record back to it (limitRecovery.ts). Resume now clears it.
 */
import { limitIdentity } from "../adapter/types.ts";
import type { Repos } from "../db/repos.ts";

export type LimitIntent = "stopped" | "off";

export interface LimitIntents {
  get(threadId: string, runId: string, resetAt: string): LimitIntent | null;
  set(threadId: string, runId: string, resetAt: string, intent: LimitIntent): void;
  clear(threadId: string, runId: string, resetAt: string): void;
}

const key = (threadId: string, runId: string, resetAt: string) => `limit.intent:${limitIdentity(threadId, runId, resetAt)}`;

/** Kept in Backroom's database (its key-value table): it outlives a restart of the service. */
export function storedLimitIntents(repos: Pick<Repos, "getKv" | "setKv" | "deleteKv">): LimitIntents {
  return {
    get: (threadId, runId, resetAt) => {
      const value = repos.getKv(key(threadId, runId, resetAt));
      return value === "stopped" || value === "off" ? value : null;
    },
    set: (threadId, runId, resetAt, intent) => repos.setKv(key(threadId, runId, resetAt), intent),
    clear: (threadId, runId, resetAt) => repos.deleteKv(key(threadId, runId, resetAt)),
  };
}

/** Kept in memory: for a fake T3 in a test, and wherever no database is at hand. */
export function memoryLimitIntents(): LimitIntents {
  const kept = new Map<string, LimitIntent>();
  return {
    get: (threadId, runId, resetAt) => kept.get(key(threadId, runId, resetAt)) ?? null,
    set: (threadId, runId, resetAt, intent) => void kept.set(key(threadId, runId, resetAt), intent),
    clear: (threadId, runId, resetAt) => void kept.delete(key(threadId, runId, resetAt)),
  };
}
