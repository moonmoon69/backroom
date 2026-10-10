/** Distance from the bottom (px) under which the room's board keeps following new content. */
export const STICK_PX = 40;

/**
 * Whether the board follows its bottom after a scroll. Near the bottom it does. Scrolled up from where it was, the reader
 * has left the bottom, and it stops. Any other scroll keeps what it did: the browser moves the board by itself to keep
 * what is in view steady while the page around it changes (scroll anchoring, as the status bar above the board opens
 * a chip's choices), which is not the reader leaving the bottom; the board's resize then brings it back to the bottom.
 */
export function followsBottom(following: boolean, previousTop: number, top: number, distance: number): boolean {
  if (distance < STICK_PX) return true;
  if (top < previousTop) return false;
  return following;
}
