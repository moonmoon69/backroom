/**
 * A model selection's effort level, whatever the harness calls the option. Shared by the service (the crew listing,
 * src/app/crew.ts) and the page (a member's tile, web/src/components/Crew.tsx), so both find the same level.
 */
import type { ModelSelection } from "./types.ts";

const EFFORT_KEYS = new Set(["effort", "reasoning", "reasoningeffort"]);

/**
 * Whether a model option id names the effort level. The harnesses spell it differently: `effort` (Claude, and Cursor for
 * some models), `reasoning` and `reasoning_effort` (Cursor, by model), `reasoningEffort` (Codex). The id is matched by
 * its letters alone, in any case, so each of those counts, and so would reasoning-effort or ReasoningEffort; an id that
 * says something else (thinking, reasoning_summary, effortless) does not.
 */
export const isEffortOption = (id: string): boolean => EFFORT_KEYS.has(id.toLowerCase().replace(/[^a-z]/g, ""));

/** The saved effort level of a model selection, or null when it has none. */
export function selectionEffort(selection: ModelSelection): string | null {
  const option = selection.options?.find((o) => isEffortOption(o.id));
  const value = option?.value;
  return (typeof value === "string" && value.trim()) || typeof value === "number" ? String(value).trim() : null;
}
