/**
 * The words on a browser's controls, and their accessible names. One of several browsers in a panel, a control's name
 * says which browser it is for, but it holds the words the control shows, so a person who says what they read
 * ("Open the browser screen") is understood by voice control and screen readers (WCAG 2.5.3, label in name).
 */

/** The Watch link's words. */
export const WATCH_LINK_TEXT = "Open the browser screen";
/** The Copy button's words (pickers.tsx's CopyButton). */
export const COPY_TEXT = "Copy";

export type PowerPhase = "start" | "stop" | "starting" | "stopping";

const PHASE_WORDS: Record<PowerPhase, string> = { start: "Start", stop: "Stop", starting: "Starting", stopping: "Stopping" };

/** What a Start or Stop button shows: the verb alone beside others' (named), else "Start browser"; while it works, "Starting…". */
export function powerText(phase: PowerPhase, named: boolean): string {
  if (phase === "starting" || phase === "stopping") return `${PHASE_WORDS[phase]}…`;
  return named ? PHASE_WORDS[phase] : `${PHASE_WORDS[phase]} browser`;
}

/** The accessible name of a Start or Stop button of the browser called `name`: "Stop staging", "Starting staging". */
export const powerName = (phase: PowerPhase, name: string): string => `${PHASE_WORDS[phase]} ${name}`;

/** The Watch link's accessible name: with no name (the browser's own page) it is its words alone. */
export const watchLinkName = (name?: string): string => (name ? `${WATCH_LINK_TEXT} of ${name}` : WATCH_LINK_TEXT);

/** The Copy button's accessible name for the watch link. */
export const copyWatchLinkName = (name?: string): string => (name ? `${COPY_TEXT} the watch link of ${name}` : `${COPY_TEXT} watch link`);

/** Whether an accessible name holds the words the control shows (the ellipsis of "Starting…" is not a word). */
export const nameHoldsText = (name: string, shown: string): boolean => name.toLowerCase().includes(shown.replace(/…/g, "").trim().toLowerCase());
