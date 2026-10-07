import { useCallback, useEffect, useState } from "react";
import { draftScopes, isDraftKey, keepDraft, keepDraftImages, readDraft, readDraftImages, type DraftImage } from "./draftStore.ts";

export type { DraftImage } from "./draftStore.ts";
export { readDraftImages } from "./draftStore.ts";

/**
 * Drafts in the page: a composer's unsent text is kept as its conversation's draft as it is typed, and its images as
 * they are attached (draftStore.ts). Closing the composer, leaving the conversation and reloading the page keep them;
 * sending clears them, as do deleting the text and removing the images.
 */

/** Fired on this page when a conversation gains or loses its draft (other tabs hear the storage event). */
const CHANGED = "backroom:drafts";

/** A composer's text, kept as the draft of `scope` and restored from it; with no scope it is plain state. */
export function useDraft(scope: string | null): [string, (text: string) => void] {
  const [state, setState] = useState(() => ({ scope, text: readDraft(scope) }));
  let current = state;
  if (state.scope !== scope) {
    current = { scope, text: readDraft(scope) };
    setState(current);
  }
  const setText = useCallback(
    (text: string) => {
      setState({ scope, text });
      if (scope && keepDraft(scope, text)) window.dispatchEvent(new Event(CHANGED));
    },
    [scope],
  );
  return [current.text, setText];
}

/**
 * Changes the images kept with the draft of `scope` (a no-op without a scope). Always by scope, never "the current
 * conversation": an upload that finishes after the user moved on still lands in the draft it was attached to.
 */
export function changeDraftImages(scope: string | null, change: (images: DraftImage[]) => DraftImage[]): void {
  if (!scope) return;
  if (keepDraftImages(scope, change(readDraftImages(scope)))) window.dispatchEvent(new Event(CHANGED));
}

/** The conversations with a draft, kept current as drafts start and end on this page or in another tab. */
export function useDraftScopes(): Set<string> {
  const [scopes, setScopes] = useState(draftScopes);
  useEffect(() => {
    const update = () => setScopes(draftScopes());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || isDraftKey(event.key)) update();
    };
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return scopes;
}
