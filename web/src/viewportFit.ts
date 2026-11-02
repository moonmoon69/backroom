/**
 * Keep the app inside the visible area while the on-screen keyboard is open.
 *
 * iOS Safari does not shrink the layout viewport for the keyboard (it ignores interactive-widget=resizes-content);
 * instead it scrolls the whole page up to reveal the focused field, and that offset sticks around after the
 * composer clears, leaving the header off-screen and a gap under the composer. Here the app's height follows
 * the visual viewport while the keyboard is open, and the page scroll is pinned at zero, so the composer sits
 * directly above the keyboard without Safari having to scroll anything. The rules are keyboardFit.ts's.
 *
 * No one event can be trusted to say the keyboard moved: in the installed app, with a third-party keyboard, or when
 * the AutoFill bar comes and goes, iOS can change the visible area without a resize event, or report it before the
 * keyboard has settled. So the fit is sampled on the viewport's and window's events, in a series over 1.2 s after
 * each focus change, on input, on orientation and visibility changes, and every 250 ms while a text field has
 * focus; the poll stops when focus leaves the field. A sample reads a few numbers and one rect and writes the
 * style only when the result changes, so a poll on a page at rest causes no layout.
 *
 * Each sample's numbers and result go into a ring of the last 40 (keyboardLog, copied from Settings → Copy keyboard
 * log), so a case the rules miss on a phone can come back here as a test.
 */
import { fitFor, scrollFor, type Fit, type ScrollMove, type ViewportSample } from "./keyboardFit.ts";

const SERIES_MS = [50, 150, 300, 500, 800, 1200];
const POLL_MS = 250;
const LOG_SIZE = 40;

const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

function textField(element: Element | null): HTMLElement | null {
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLInputElement && !NOT_TEXT.has(element.type)) return element;
  if (element instanceof HTMLElement && element.isContentEditable) return element;
  return null;
}

const ring: string[] = [];
let lastKey = "";

const round = (n: number) => Math.round(n * 10) / 10;

function record(why: string, before: ViewportSample, fit: Fit, after: ViewportSample, move: ScrollMove): void {
  const field = before.field ? `${before.field.tag} ${round(before.field.top)}-${round(before.field.bottom)} after ${round(after.field?.bottom ?? 0)}` : "none";
  const key = `inner ${round(before.innerHeight)} vv ${round(before.viewportHeight)} top ${round(before.offsetTop)} scale ${round(before.scale)} scrollY ${round(before.scrollY)} field ${field} → ${fit.keyboard ? `fit ${fit.appHeight}` : "no fit"}, ${move}`;
  // The poll repeats a page at rest; keep the ring for the moments something changed.
  if (key === lastKey) return;
  lastKey = key;
  ring.push(`${new Date().toISOString().slice(11, 23)} ${why}: ${key}`);
  if (ring.length > LOG_SIZE) ring.shift();
}

/** The last samples whose numbers or result changed, oldest first, as plain text to paste into a report. */
export function keyboardLog(): string {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return [`${navigator.userAgent}${standalone ? " (installed app)" : ""}`, ...ring].join("\n");
}

export function installViewportFit(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let frame = 0;
  let poll = 0;
  let fitted = false;
  let applied: number | null = null;
  const reasons = new Set<string>();

  const read = (field: HTMLElement | null): ViewportSample => {
    const rect = field?.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      viewportHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
      scrollY: window.scrollY,
      field: field && rect ? { tag: field.tagName.toLowerCase(), top: rect.top, bottom: rect.bottom } : null,
    };
  };

  const apply = () => {
    frame = 0;
    const why = [...reasons].join("+") || "start";
    // A user scrolling a panel past its focused field moves no viewport; only the poll would see it, so the poll
    // (and a viewport scroll) never reveals: a field is brought in when focus, typing or the viewport's size moves.
    const mayReveal = [...reasons].some((reason) => reason !== "poll" && reason !== "scroll");
    reasons.clear();
    const field = textField(document.activeElement);
    const before = read(field);
    const fit = fitFor(before, fitted);
    fitted = fit.keyboard;
    const changed = fit.appHeight !== applied;
    if (changed) {
      applied = fit.appHeight;
      if (applied === null) root.style.removeProperty("--app-height");
      else root.style.setProperty("--app-height", `${applied}px`);
      root.classList.toggle("keyboard-open", fit.keyboard);
    }
    // The field moves with the new height; measure it again only when the height changed.
    const after = changed ? read(field) : before;
    const move = scrollFor(after, fit.keyboard, mayReveal);
    if (move === "pin") window.scrollTo(0, 0);
    else if (move === "reveal") field?.scrollIntoView({ block: "nearest" });
    record(why, before, fit, after, move);
    if (field && !poll) poll = window.setInterval(() => schedule("poll"), POLL_MS);
    else if (!field && poll) {
      window.clearInterval(poll);
      poll = 0;
    }
  };
  const schedule = (reason: string) => {
    reasons.add(reason);
    if (!frame) frame = requestAnimationFrame(apply);
  };
  // Safari scrolls the page on focus before it fires any viewport event, and the keyboard (and its AutoFill bar)
  // can settle well after; a series of samples catches each step.
  const series = (reason: string) => () => {
    for (const ms of SERIES_MS) setTimeout(() => schedule(reason), ms);
  };

  viewport.addEventListener("resize", () => schedule("resize"));
  viewport.addEventListener("scroll", () => schedule("scroll"));
  window.addEventListener("resize", () => schedule("window"));
  window.addEventListener("orientationchange", () => schedule("orientation"));
  document.addEventListener("visibilitychange", () => schedule("visible"));
  document.addEventListener("input", () => schedule("input"));
  document.addEventListener("focusin", series("focusin"));
  document.addEventListener("focusout", series("focusout"));
  apply();
}
