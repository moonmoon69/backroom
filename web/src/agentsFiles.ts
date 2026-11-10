/**
 * The agents files on the page (src/app/agentsFile.ts): every one of T3's projects with its AGENTS.md's state against
 * the saved template, read from GET /api/agents-files and shared by the overview's heading marks and
 * Settings → Agents file. Read when the overview mounts and again when the editor or a diff dialog closes.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { AgentsFileEntry } from "./types.ts";

let entries: AgentsFileEntry[] | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let snapshot: { entries: AgentsFileEntry[] | null; error: string | null } = { entries, error };

/** Read the states from the service again. */
export function reloadAgentsFiles(): void {
  void api.agentsFiles().then(
    (next) => {
      entries = next;
      error = null;
      snapshot = { entries, error };
      emit();
    },
    (caught: unknown) => {
      // No answer, no list: an earlier one would show states (and overview marks) the service can no longer vouch for.
      entries = null;
      error = caught instanceof Error ? caught.message : String(caught);
      snapshot = { entries, error };
      emit();
    },
  );
}

/** What the page last read: null until the first answer and after a read that failed, with its error. */
export function useAgentsFiles(): { entries: AgentsFileEntry[] | null; error: string | null } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
