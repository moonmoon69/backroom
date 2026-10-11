/**
 * The user's saved crew in words, as the Consigliere reads it when he seats: `rooms-board crew` and his "Your crew"
 * standing section (src/briefing/assemble.ts) both take their lines from here, so the two say the same.
 */
import { selectionEffort } from "../domain/effort.ts";
import type { Preset } from "../domain/types.ts";

/** One crew member: name · model · effort · worktree note when it has one · what it is good at and what to avoid, each when set. */
export function crewLine(preset: Preset): string {
  return [
    preset.name,
    preset.modelSelection.model,
    `effort ${selectionEffort(preset.modelSelection) ?? "none"}`,
    preset.workspaceMode === "worktree" ? "works in its own worktree" : "",
    preset.goodAt.trim() ? `good at: ${preset.goodAt.trim()}` : "",
    preset.avoid.trim() ? `avoid: ${preset.avoid.trim()}` : "",
  ].filter(Boolean).join(" · ");
}

/** The crew listing: a heading line and one line per member, or the line that says there is none. */
export function crewListing(presets: Preset[]): string[] {
  if (presets.length === 0) return ["The user has no saved crew."];
  return ["The user's saved crew (seat one with: rooms-board seat <name>):", ...presets.map(crewLine)];
}
