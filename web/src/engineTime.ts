import type { EngineTime } from "./types.ts";

/** A clock time in the user's locale, e.g. "10:13 AM". */
export const clock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * When something started, as the journal knows it (times come from T3 only): "10:13 AM" when T3 timed it, "after
 * 10:13 AM" when only a lower bound is known, "an unknown time" otherwise. Never a guess.
 */
export function sinceWords(time: EngineTime): string {
  if (time.at) return clock(time.at);
  if (time.after) return `after ${clock(time.after)}`;
  return "an unknown time";
}
