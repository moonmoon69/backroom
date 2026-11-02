/** The phone keyboard's fit as pure rules over one sample of the viewport; viewportFit.ts samples and applies them. */
const KEYBOARD_MIN_PX = 80;
// Sub-pixel rounding between a rect and the viewport's height is not a hidden field.
const EDGE_SLACK_PX = 1;

/** The focused text field's edges, in the layout viewport's coordinates (getBoundingClientRect). */
export type FieldBox = { tag: string; top: number; bottom: number };

export type ViewportSample = {
  innerHeight: number;
  viewportHeight: number;
  offsetTop: number;
  scale: number;
  scrollY: number;
  field: FieldBox | null;
};

export type Fit = { keyboard: boolean; appHeight: number | null };

export type ScrollMove = "none" | "pin" | "reveal";

const zoomed = (sample: ViewportSample) => Math.abs(sample.scale - 1) > 0.01;

/**
 * The focused field's bottom edge lies below the visible area. A field taller than the visible area never counts:
 * it cannot fit, the browser keeps its caret in view, and bringing its edge in would jump away from the caret.
 */
export function fieldHidden(sample: ViewportSample): boolean {
  const field = sample.field;
  if (!field || field.bottom - field.top > sample.viewportHeight) return false;
  return field.bottom > sample.offsetTop + sample.viewportHeight + EDGE_SLACK_PX;
}

/**
 * Whether the keyboard is open, and the app's height for it. Pinch zoom is left alone, since the visual viewport
 * shrinks then too. Otherwise the keyboard is open when the visual viewport is markedly shorter than the window,
 * or a text field has focus and lies below the visible area (iOS builds where innerHeight shrinks with the
 * keyboard, and keyboards that send no event). `fitted` is the previous result: once the fit has brought the
 * field into view it stays while the field keeps focus, or the next sample would see the field visible, drop the
 * fit and hide it again. Browsers that resize the layout for the keyboard (Android Chrome) trip neither rule.
 */
export function fitFor(sample: ViewportSample, fitted: boolean): Fit {
  if (zoomed(sample)) return { keyboard: false, appHeight: null };
  const keyboard = sample.innerHeight - sample.viewportHeight > KEYBOARD_MIN_PX || (sample.field !== null && (fitted || fieldHidden(sample)));
  return { keyboard, appHeight: keyboard ? Math.floor(sample.viewportHeight) : null };
}

/**
 * The scroll after the fit has applied, from a sample taken after it. The page is pinned at the top, except while
 * the keyboard is open and the focused field would be hidden there: then the field is brought into view instead
 * (when `mayReveal`), and the pin waits, so pin and reveal never undo each other.
 */
export function scrollFor(sample: ViewportSample, keyboard: boolean, mayReveal: boolean): ScrollMove {
  if (zoomed(sample)) return "none";
  const field = sample.field;
  if (keyboard && field) {
    const atTop: ViewportSample = { ...sample, scrollY: 0, offsetTop: 0, field: { ...field, top: field.top + sample.scrollY, bottom: field.bottom + sample.scrollY } };
    if (fieldHidden(atTop)) return mayReveal && fieldHidden(sample) ? "reveal" : "none";
  }
  return sample.scrollY !== 0 || sample.offsetTop !== 0 ? "pin" : "none";
}
