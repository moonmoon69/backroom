/**
 * Updates for T3 and its harnesses, shared by the sidebar's Updates button (its count) and the Updates popup. Read
 * every 30 minutes; while the popup is open, fresh from T3 every 30 seconds, and every 2 while an update runs.
 * Nothing here starts an update: only the popup's buttons do.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { UpdatesView } from "./types.ts";

export interface UpdatesState {
  view: UpdatesView | null;
  error: string | null;
}

const IDLE_MS = 30 * 60_000;
const OPEN_MS = 30_000;
const BUSY_MS = 2_000;

let state: UpdatesState = { view: null, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Open popups. */
let watchers = 0;

/** An update is on its way: T3 installing or restarting, or a harness asked for, queued or running. */
export function updateRunning(view: UpdatesView): boolean {
  const job = view.server.job?.state;
  return job === "installing" || job === "restarting" || view.harnesses.some((h) => h.pending || h.update?.status === "queued" || h.update?.status === "running");
}

function set(next: UpdatesState): void {
  state = next;
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  const delay = watchers === 0 ? IDLE_MS : state.view && updateRunning(state.view) ? BUSY_MS : OPEN_MS;
  timer = setTimeout(() => void loadUpdates(watchers > 0), delay);
}

export async function loadUpdates(fresh = false): Promise<void> {
  try {
    set({ view: await api.updates(fresh), error: null });
  } catch (caught) {
    set({ view: state.view, error: caught instanceof Error ? caught.message : String(caught) });
  }
  schedule();
}

/** The view an action answered with (an update started, a check done). */
export function showUpdates(view: UpdatesView): void {
  set({ view, error: null });
  schedule();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (state.view === null) void loadUpdates();
    else schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export const useUpdates = (): UpdatesState => useSyncExternalStore(subscribe, () => state);

/** While the popup is open: read T3 now, and often while something updates. Returns the stop. */
export function watchUpdates(): () => void {
  watchers += 1;
  void loadUpdates(true);
  return () => {
    watchers -= 1;
    schedule();
  };
}
