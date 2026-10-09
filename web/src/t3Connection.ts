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
