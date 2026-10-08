/**
 * The Consigliere on the page: the app-wide setting (which saved crew member is the Consigliere of new rooms), read once
 * and shared by the settings picker, the overview's New room and the saved crew dialog.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";

let presetId: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Read the setting from the service again (at start, and after a saved crew member is deleted). */
export function reloadConsigliereSetting(): void {
  void api
    .settings()
    .then((settings) => {
      presetId = settings.consiglierePresetId;
      loaded = true;
      emit();
    })
    .catch(() => undefined);
}

/** What the page last read; the caller sends the command, this only mirrors its result. */
export function rememberConsigliereSetting(next: string | null): void {
  presetId = next;
  emit();
}

/** The id of the saved crew member who is the Consigliere of new rooms, or null. */
export function useConsigliereSetting(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      if (!loaded) reloadConsigliereSetting();
      return () => listeners.delete(listener);
    },
    () => presetId,
  );
}
