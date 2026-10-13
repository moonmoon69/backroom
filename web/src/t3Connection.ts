import type { StatusResponse } from "./types.ts";

/**
 * What the T3 button in the overview's header says besides "T3": nothing while all is well (a green dot), else the
 * problem in a word or two, worst first. A failed renewal shows as soon as it happens, not only near expiry.
 */
export function connectionProblem(t3: StatusResponse["t3"]): { tone: "ok" | "warn" | "err"; problem: string | null } {
  if (t3.error) return { tone: "err", problem: "error" };
  if (!t3.paired) return { tone: "warn", problem: "not paired" };
  if (t3.credential?.error) return { tone: "warn", problem: "renewal failed" };
  if (t3.credential?.warning) return { tone: "warn", problem: "pair again soon" };
  return { tone: "ok", problem: null };
}

/**
 * The overview's T3 banner, from one truth, the service's word on T3 (GET /api/status, or its pushed status): shown
 * while the service says T3 is down, and only then; a list read that succeeds never clears it. Its wording fits the
 * case: `feed`, T3's live feed is down but T3's lists have been read the slow way, directly from T3, during this outage
 * (`listsReadInOutage`), so they may lag; `down` otherwise, T3 not answering (its lists failed, or none has been read
 * since the outage began).
 */
export function t3Banner(t3: StatusResponse["t3"] | null, listsError: string | null, listsReadInOutage: boolean): { kind: "down" | "feed"; error: string } | null {
  if (!t3?.error) return null;
  if (!listsError && listsReadInOutage && t3.feed && t3.feed.state !== "connected") return { kind: "feed", error: t3.error };
  return { kind: "down", error: listsError ?? t3.error };
}

/** Whether the service says T3's live feed is down (the HTTP adapter's): then T3's lists are read the slow way, if at all. */
export function feedOut(t3: StatusResponse["t3"] | null): boolean {
  return Boolean(t3?.error && t3.feed && t3.feed.state !== "connected");
}
