import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { AddParticipantButton, CrewPanel } from "./Crew.tsx";
import { GitTab } from "./GitTab.tsx";
import { BranchIcon, CloseIcon } from "./icons.tsx";
import { ageOf } from "./deskFormat.ts";
import { RoomBrowserPanel } from "./RoomBrowser.tsx";

export type InspectorTab = "people" | "browser" | "git";

const TITLES: Record<InspectorTab, string> = { people: "Members", browser: "Browser", git: "Git" };

/** Uncommitted files across the room's working folders, and the branch when there is one folder; null until read. */
function useUncommitted(): { count: number; branch: string | null; folders: number } | null {
  const { git } = useRoom();
  const folders = git.data?.folders.filter((folder) => folder.isRepo);
  if (!folders) return null;
  return { count: folders.reduce((n, folder) => n + folder.changed, 0), branch: folders.length === 1 ? folders[0]!.branch : null, folders: folders.length };
}

/** The header's Git switch: the branch icon with the count of uncommitted files; hover says the branch. */
export function GitButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const uncommitted = useUncommitted();
  const gitTitle = uncommitted
    ? `Git: ${uncommitted.count} uncommitted file${uncommitted.count === 1 ? "" : "s"}${uncommitted.branch ? ` on ${uncommitted.branch}` : uncommitted.folders > 1 ? ` across ${uncommitted.folders} folders` : ""}; commits, worktrees`
    : "Git: branches, commits, worktrees and uncommitted changes";
  return (
    <button type="button" className={`small${active ? " active" : ""}`} aria-pressed={active} aria-label={gitTitle} title={gitTitle} onClick={onClick}>
      <BranchIcon />
      {uncommitted?.count ? <span className="panel-count mono">{uncommitted.count}</span> : null}
    </button>
  );
}

interface Props {
  tab: InspectorTab;
  onClose: () => void;
  /** Open a browser's own page (from the Browser tab's Manage…). */
  onManageBrowser: (browserId: string | null) => void;
}

/**
 * Right side panel, switched from the header: People (who is seated, their threads), Browser (the room's browser) and
 * Git (the room's folders: branch, uncommitted files, commits, worktrees). What the tasks are doing is the status bar
 * above the conversation (WorkBar.tsx).
 */
export function Inspector({ tab, onClose, onManageBrowser }: Props) {
  const { desk, deskError, aliasOf, git } = useRoom();
  const errors = Object.entries(desk?.errors ?? {});

  // Re-render the "updated Ns ago" footer once a second while desk data is shown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab !== "people" && tab !== "git") return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [tab]);

  return (
    <aside className="queue-drawer inspector" aria-label={TITLES[tab]}>
      <div className="inspector-head">
        <h2>{TITLES[tab]}</h2>
        <span className="spacer" />
        {tab === "people" ? <AddParticipantButton /> : null}
        <button type="button" className="small ghost icon-only" aria-label="Close panel" title="Close panel" onClick={onClose}>
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
