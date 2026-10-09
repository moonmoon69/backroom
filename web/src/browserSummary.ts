import type { Browser, RoomBrowserStatus } from "./types.ts";

export const BROWSER_STATE_LABEL: Record<RoomBrowserStatus["state"], string> = {
  stopped: "off",
  starting: "starting…",
  running: "running",
  error: "failed",
};

/** What the room header's Browser button shows and says: the tabs open across the browsers the room may use, and each browser's state. */
export interface RoomBrowserSummary {
  /** The button's hover text and accessible name. */
  title: string;
  /** Open tabs in the browsers that run, all the room's browsers together. */
  tabs: number;
  /** A browser the room may use failed to start. */
  failed: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One line per browser the room may use ("general (default) running, 3 tabs; staging off"), so the button speaks for all
 * of them, not only the default; the visible count is their tabs added up.
 */
export function roomBrowserSummary(
  enabled: boolean,
  browsers: ReadonlyArray<{ browser: Pick<Browser, "id" | "name">; status: Pick<RoomBrowserStatus, "state" | "mode" | "tabs"> }>,
  defaultId: string | null,
): RoomBrowserSummary {
  const tabsOf = (status: Pick<RoomBrowserStatus, "state" | "tabs">) => (status.state === "running" ? status.tabs.length : 0);
  const each = browsers.map(({ browser, status }) => {
    const state = status.mode === null ? "unavailable" : BROWSER_STATE_LABEL[status.state];
    const tabs = tabsOf(status);
    return `${browser.name}${browser.id === defaultId ? " (default)" : ""} ${state}${tabs > 0 ? `, ${plural(tabs, "tab")}` : ""}`;
  });
  return {
    title: `Browser: ${enabled ? "on" : "off"} for this room's agents · ${each.length > 0 ? each.join("; ") : "no browser yet"}`,
    tabs: browsers.reduce((sum, { status }) => sum + tabsOf(status), 0),
    failed: browsers.some(({ status }) => status.state === "error"),
  };
}
