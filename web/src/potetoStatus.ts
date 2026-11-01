import type { PotetoScope, PotetoState, RoomCommand } from "./types.ts";

/** The Skills control's three positions, on the service's two keys: Off, or on with a scope. */
export type PotetoPosition = "off" | PotetoScope;

export const potetoPosition = (state: Pick<PotetoState, "enabled" | "scope">): PotetoPosition => (state.enabled ? state.scope : "off");

/** The commands that move the setting to a position. The scope goes first, so turning it on never renders the old scope. */
export function potetoMove(state: Pick<PotetoState, "enabled">, position: PotetoPosition): RoomCommand[] {
  if (position === "off") return [{ type: "poteto.enabled.set", enabled: false }];
  return [{ type: "poteto.scope.set", scope: position }, ...(state.enabled ? [] : [{ type: "poteto.enabled.set", enabled: true } as const])];
}

/**
 * The status line of Settings → Agents file, Skills (components/SkillsSection.tsx): the setting first, then the clone. Off,
 * seats are not pointed at it whatever the clone is (review #206); on, it is being worked on, ready, or not cloned yet.
 */
export function potetoStatus(state: Pick<PotetoState, "enabled" | "busy" | "ready">): string {
  if (!state.enabled) return state.ready ? "Off: seats are not pointed at it; the clone is kept." : "Off: seats are not pointed at it.";
  if (state.busy) return "Working on the clone…";
  return state.ready ? "Ready: seats are pointed at it." : "Not cloned yet.";
}
