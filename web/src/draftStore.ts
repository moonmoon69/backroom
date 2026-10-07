/**
 * Unsent text and images, one draft per room or thread, kept in this browser's storage. A scope is news.ts's key for
 * the conversation ("room:<id>", "thread:<id>"). A draft is its text, its images, or both; blank text and no images
 * is no draft. An image is kept here by reference only (id, name, size): a room's images are already stored by the
 * service when they are attached, and a thread's are in this browser's IndexedDB (draftImageData.ts), since they can
 * be far larger than this storage holds. The hooks that use it are in drafts.ts.
 */
const PREFIX = "backroom.draft.";
const IMAGES = "backroom.draftimages.";

export const isDraftKey = (key: string): boolean => key.startsWith(PREFIX) || key.startsWith(IMAGES);

/** An image kept with a draft: the service's attachment id (rooms) or its copy's key in IndexedDB (threads). */
export interface DraftImage {
  id: string;
  name: string;
  sizeBytes: number;
}

const isDraftImage = (value: unknown): value is DraftImage =>
  typeof value === "object" && value !== null && typeof (value as DraftImage).id === "string" && typeof (value as DraftImage).name === "string" && typeof (value as DraftImage).sizeBytes === "number";

export function readDraftImages(scope: string | null): DraftImage[] {
  if (!scope) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(IMAGES + scope) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isDraftImage) : [];
  } catch {
    return [];
  }
}

/** Keeps `images` as the draft images of `scope`; none clears them. True when the scope gained or lost its images. */
export function keepDraftImages(scope: string, images: readonly DraftImage[]): boolean {
  try {
    const had = localStorage.getItem(IMAGES + scope) !== null;
    if (images.length > 0) localStorage.setItem(IMAGES + scope, JSON.stringify(images.map(({ id, name, sizeBytes }) => ({ id, name, sizeBytes }))));
    else localStorage.removeItem(IMAGES + scope);
    return had !== images.length > 0;
  } catch {
    // Storage full or blocked: the images live as long as the page.
    return false;
  }
}

export function readDraft(scope: string | null): string {
  if (!scope) return "";
  try {
    return localStorage.getItem(PREFIX + scope) ?? "";
  } catch {
    return "";
  }
}

/** Keeps `text` as the draft of `scope`; blank text clears it. True when the conversation gained or lost its draft. */
export function keepDraft(scope: string, text: string): boolean {
  const keep = text.trim().length > 0;
  try {
    const had = localStorage.getItem(PREFIX + scope) !== null;
    if (keep) localStorage.setItem(PREFIX + scope, text);
    else localStorage.removeItem(PREFIX + scope);
    return had !== keep;
  } catch {
    // Storage full or blocked: the draft lives as long as the page.
    return false;
  }
}

/** The conversations with a draft: text, images or both. */
export function draftScopes(): Set<string> {
  const scopes = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) scopes.add(key.slice(PREFIX.length));
      else if (key?.startsWith(IMAGES)) scopes.add(key.slice(IMAGES.length));
    }
  } catch {
    // No storage: no drafts.
  }
  return scopes;
}
