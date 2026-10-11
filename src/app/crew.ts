/**
 * The user's saved crew in words, as the Consigliere reads it when he seats: `rooms-board crew` and his "Your crew"
 * standing section (src/briefing/assemble.ts) both take their lines from here, so the two say the same.
 */
import type { ModelSelection, Preset } from "../domain/types.ts";

/**
 * The model option that is a harness's effort level: `effort` (Claude, and Cursor for some models), `reasoning` and
 * `reasoning_effort` (Cursor, by model), `reasoningEffort` (Codex). Matched by the id's letters alone, in any case,
 * so a harness's own spelling of the same word (reasoning_effort, reasoning-effort, ReasoningEffort) counts too.
 */
export const EFFORT_OPTION_IDS = ["effort", "reasoning", "reasoningEffort", "reasoning_effort"] as const;

const EFFORT_KEYS = new Set(["effort", "reasoning", "reasoningeffort"]);

/** Whether a model option id names the effort level, whatever the harness's spelling. */
export const isEffortOption = (id: string): boolean => EFFORT_KEYS.has(id.toLowerCase().replace(/[^a-z]/g, ""));

/** The saved effort level of a model selection, or null when it has none. */
export function selectionEffort(selection: ModelSelection): string | null {
  const option = selection.options?.find((o) => isEffortOption(o.id));
  const value = option?.value;
  return (typeof value === "string" && value.trim()) || typeof value === "number" ? String(value).trim() : null;
}

/** One crew member: name · model · effort · worktree note when it has one · its sentence when it has one. */
export function crewLine(preset: Preset): string {
  return [
    preset.name,
    preset.modelSelection.model,
    `effort ${selectionEffort(preset.modelSelection) ?? "none"}`,
    preset.workspaceMode === "worktree" ? "works in its own worktree" : "",
    preset.description.trim(),
  ].filter(Boolean).join(" · ");
}

/** The crew listing: a heading line and one line per member, or the line that says there is none. */
export function crewListing(presets: Preset[]): string[] {
  if (presets.length === 0) return ["The user has no saved crew."];
  return ["The user's saved crew (seat one with: rooms-board seat <name>):", ...presets.map(crewLine)];
}
