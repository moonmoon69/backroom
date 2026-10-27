import type { PotetoState } from "./types.ts";

/**
 * The status line of Settings → Poteto mode (components/PotetoMode.tsx): the setting first, then the clone. Off, seats
 * are not pointed at it whatever the clone is (review #206); on, it is being worked on, ready, or not cloned yet.
 */
export function potetoStatus(state: Pick<PotetoState, "enabled" | "busy" | "ready">): string {
  if (!state.enabled) return state.ready ? "Off: seats are not pointed at it; the clone is kept." : "Off: seats are not pointed at it.";
  if (state.busy) return "Working on the clone…";
  return state.ready ? "Ready: seats are pointed at it." : "Not cloned yet.";
}
