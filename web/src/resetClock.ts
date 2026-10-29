import { useEffect, useState } from "react";

/**
 * Draw again when the next of these times passes (a usage limit's reset), so what is said before it ("until 15:30")
 * becomes what is said after it without anything else changing. Returns the time to draw with.
 */
export function useResetClock(times: ReadonlyArray<string | null | undefined>): number {
  const [, redraw] = useState(0);
  const now = Date.now();
  const next = times.map((time) => (time ? Date.parse(time) : Number.NaN)).filter((at) => Number.isFinite(at) && at > now).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    // A browser cuts a longer timer (about 24.8 days) short; drawn early, the next one is set from there.
    const timer = setTimeout(() => redraw((n) => n + 1), Math.min(next - Date.now() + 250, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}
