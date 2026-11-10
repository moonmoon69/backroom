/** Backroom's row in the Updates popup: what it says under the versions (components/Updates.tsx). */
import type { BackroomUpdateView } from "./types.ts";

/**
 * The quiet line under Backroom's row: a lookup that failed, whatever the row still shows from an earlier one (a newer
 * release, a job); else, with nothing newer and no update to show, up to date or no release yet.
 */
export function backroomCheckNote(backroom: BackroomUpdateView): string | null {
  const running = backroom.job?.state === "installing" || backroom.job?.state === "restarting";
  if (running) return null;
  if (backroom.releaseError) return `Could not check for a newer Backroom (${backroom.releaseError})`;
  if (backroom.newer || backroom.job) return null;
  return backroom.latest ? "Up to date" : "No release yet";
}
