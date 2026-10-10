import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { byKey, itemOf, lastInputWasKey, navProps, sideItems, type NavProps } from "../keys.ts";
import { useRoom } from "../context.tsx";
import { AddParticipantButton, CrewPanel } from "./Crew.tsx";
import { GitTab } from "./GitTab.tsx";
import { BranchIcon, CloseIcon } from "./icons.tsx";
import { ageOf } from "./deskFormat.ts";
import { RoomBrowserPanel } from "./RoomBrowser.tsx";

export type InspectorTab = "people" | "browser" | "git";

const TITLES: Record<InspectorTab, string> = { people: "Members", browser: "Browser", git: "Git" };
const TABS = ["people", "browser", "git"] as const;

/** Uncommitted files across the room's working folders, and the branch when there is one folder; null until read. */
function useUncommitted(): { count: number; branch: string | null; folders: number } | null {
  const { git } = useRoom();
  const folders = git.data?.folders.filter((folder) => folder.isRepo);
  if (!folders) return null;
  return { count: folders.reduce((n, folder) => n + folder.changed, 0), branch: folders.length === 1 ? folders[0]!.branch : null, folders: folders.length };
}

/**
 * The header's Git switch: the branch icon with the count of uncommitted files; hover says the branch. `nav` makes it an
 * item of the room's header lane (keys.ts).
 */
export function GitButton({ active, onClick, nav }: { active: boolean; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; nav?: NavProps }) {
  const uncommitted = useUncommitted();
  const gitTitle = uncommitted
    ? `Git: ${uncommitted.count} uncommitted file${uncommitted.count === 1 ? "" : "s"}${uncommitted.branch ? ` on ${uncommitted.branch}` : uncommitted.folders > 1 ? ` across ${uncommitted.folders} folders` : ""}; commits, worktrees`
    : "Git: branches, commits, worktrees and uncommitted changes";
  return (
    <button type="button" className={`small${active ? " active" : ""}`} aria-pressed={active} aria-label={gitTitle} title={gitTitle} onClick={onClick} {...nav}>
      <BranchIcon />
      {uncommitted?.count ? <span className="panel-count mono">{uncommitted.count}</span> : null}
    </button>
  );
}

interface Props {
  tab: InspectorTab;
  /** Show another tab (from the panel's head; the room's header has the same three). */
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  /** Open a browser's own page (from the Browser tab's Manage…). */
  onManageBrowser: (browserId: string | null) => void;
}

/**
 * Right side panel, switched from the header or its own head's tabs: People (who is seated, their threads), Browser (the
 * room's browser) and Git (the room's folders: branch, uncommitted files, commits, worktrees). What the members are
 * doing is the status bar above the conversation (WorkBar.tsx).
 *
 * The room's side column for the keys (keys.ts, `data-nav-side`): rows of items, its head first (the tabs, + Add member
 * on Members, ×), then the members or the Browser and Git panes' rows.
 */
export function Inspector({ tab, onTab, onClose, onManageBrowser }: Props) {
  const { desk, deskError, aliasOf, git } = useRoom();
  const errors = Object.entries(desk?.errors ?? {});

  // Re-render the "updated Ns ago" footer once a second while desk data is shown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab !== "people" && tab !== "git") return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [tab]);

  // The ring never falls to the page: a stop that goes away with the ring on it (a member removed, a browser stopped)
  // puts it on the stop that took its place, else the one before it, else the panel's head. After a click nothing moves.
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = aside.current;
    if (!root) return;
    // The stop the ring was last on, while the focus has not gone anywhere else since (an element taken out of the page
    // with the focus on it sends no event: the focus is then on the body).
    let last: { key: string | null; at: number } | null = null;
    const onIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const stop = root.contains(target) ? sideItems(root).find((item) => item === target || item === itemOf(target)) : undefined;
      last = stop ? { key: stop.dataset.navKey ?? null, at: sideItems(root).indexOf(stop) } : null;
    };
    const observer = new MutationObserver(() => {
      const now = document.activeElement;
      if (!last || (now && now !== document.body) || document.querySelector(".dialog-backdrop") || !lastInputWasKey()) return;
      const items = sideItems(root);
      (byKey(root, last.key) ?? items[Math.min(last.at, items.length - 1)])?.focus({ preventScroll: true });
    });
    document.addEventListener("focusin", onIn);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", onIn);
      observer.disconnect();
    };
  }, []);

  return (
    <aside
      className="queue-drawer inspector"
      ref={aside}
      aria-label={TITLES[tab]}
      data-nav-pane={tab}
      data-nav-side=""
      tabIndex={-1}
      onKeyDown={(event) => {
        // Enter presses a row's switch as it presses a button (a checkbox takes only Space of its own).
        const target = event.target as HTMLElement;
        if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
        event.preventDefault();
        target.click();
      }}
    >
      <div className="inspector-head">
        <div className="inspector-tabs" role="tablist" aria-label="Panel">
          {TABS.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={each === tab}
              tabIndex={each === tab ? 0 : -1}
              className={`inspector-tab${each === tab ? " on" : ""}`}
              onClick={() => onTab(each)}
              {...navProps("side", `side:tab:${each}`, `the panel's head · ${TITLES[each]}`)}
            >
              {TITLES[each]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab === "people" ? <AddParticipantButton nav={navProps("side", "side:add", "the panel's head · + Add member")} /> : null}
        <button type="button" className="small ghost icon-only" aria-label="Close panel" title="Close panel (Backspace)" onClick={onClose} {...navProps("side", "side:close", "the panel's head · fold the panel")}>
          <CloseIcon />
        </button>
      </div>
      <div className="queue-body">
        {tab === "people" ? <CrewPanel /> : null}
        {tab === "browser" ? <RoomBrowserPanel onManage={onManageBrowser} /> : null}
        {tab === "git" ? <GitTab /> : null}
      </div>
      {/* Before the first read the tab itself shows any error; afterwards it keeps the last read, and this says why it is stale. */}
      {tab === "git" && git.data ? (
        <div className="inspector-footer mono">
          {git.error ? <span className="status-error">{git.error}</span> : <span className="muted">read from git {ageOf(git.data.fetchedAt)}</span>}
        </div>
      ) : null}
      {tab === "people" ? (
        <div className="inspector-footer mono">
          {deskError ? <span className="status-error">{deskError}</span> : null}
          {!deskError && desk ? <span className="muted">updated {ageOf(desk.fetchedAt)}</span> : null}
          {!deskError && !desk ? <span className="muted">loading desk…</span> : null}
          {errors.length > 0 ? (
            <ul className="inspector-errors">
              {errors.map(([participantId, message]) => (
                <li key={participantId} className="status-error">
                  {aliasOf(participantId)}: {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
