import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { CrewButton, CrewPanel } from "./Crew.tsx";
import { ageOf } from "./deskFormat.ts";
import { TaskLanes, taskCount } from "./QueueDrawer.tsx";
import { RoomBrowserButton, RoomBrowserPanel } from "./RoomBrowser.tsx";

export type InspectorTab = "people" | "browser" | "tasks" | "changes";

const TITLES: Record<InspectorTab, string> = { people: "People", browser: "Browser", tasks: "Tasks", changes: "Changes" };

/** A checklist: the room's tasks. */
function TasksIcon() {
  return (
    <svg className="panel-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.9 3.9 3.2 5.2 5.5 2.8" />
      <path d="M1.9 9.4 3.2 10.7 5.5 8.3" />
      <path d="M7.75 4h6.5M7.75 9.5h6.5M7.75 13.5h6.5" />
    </svg>
  );
}

/** A page with a plus over a minus: the diff of the files the room's threads changed. */
function ChangesIcon() {
  return (
    <svg className="panel-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 1.75H4.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.75z" />
      <path d="M8 4.75v3.5M6.25 6.5h3.5M6.25 10.75h3.5" />
    </svg>
  );
}

/** Files changed across the room's threads; null until the desk has been read. */
function useChangedCount(): number | null {
  const { desk } = useRoom();
  return desk ? Object.values(desk.participants).reduce((n, d) => n + d.changedFiles.length, 0) : null;
}

/**
 * The room header's switches for the side panel, as icons with counts: people, browser, tasks and changes. Each opens
 * the panel on its tab; the tab already showing closes it. Hover says what each is.
 */
export function PanelButtons({ open, tab, onToggle }: { open: boolean; tab: InspectorTab; onToggle: (tab: InspectorTab) => void }) {
  const { snapshot } = useRoom();
  const tasks = taskCount(snapshot.tasks, snapshot.nativeRequests.length);
  const needInput = snapshot.nativeRequests.length;
  const changed = useChangedCount();
  const on = (key: InspectorTab) => open && tab === key;
  const tasksTitle = `Tasks: ${tasks} waiting, running or needing input${needInput > 0 ? `; ${needInput} need${needInput === 1 ? "s" : ""} your answer` : ""}`;
  const changesTitle = `Changes: ${changed ?? "…"} file${changed === 1 ? "" : "s"} changed across the room's threads`;
  return (
    <span className="panel-buttons" role="group" aria-label="Side panel">
      <CrewButton active={on("people")} onClick={() => onToggle("people")} />
      <RoomBrowserButton active={on("browser")} onClick={() => onToggle("browser")} />
      <button type="button" className={`small${on("tasks") ? " active" : ""}`} aria-pressed={on("tasks")} aria-label={tasksTitle} title={tasksTitle} onClick={() => onToggle("tasks")}>
        <TasksIcon />
        {tasks > 0 ? <span className="panel-count mono">{tasks}</span> : null}
        {needInput > 0 ? (
          <span className="pill pill-input">
            {needInput}
            <span className="pill-words"> need input</span>
          </span>
        ) : null}
      </button>
      <button type="button" className={`small${on("changes") ? " active" : ""}`} aria-pressed={on("changes")} aria-label={changesTitle} title={changesTitle} onClick={() => onToggle("changes")}>
        <ChangesIcon />
        {changed ? <span className="panel-count mono">{changed}</span> : null}
      </button>
    </span>
  );
}

interface Props {
  tab: InspectorTab;
  onClose: () => void;
  /** Open a browser's own page (from the Browser tab's Manage…). */
  onManageBrowser: (browserId: string | null) => void;
}

/**
 * Right side panel, switched from the header: People (who is seated, their threads), Browser (the room's browser),
 * Tasks (the queue, with what each participant is doing outside it) and Changes (files across the room).
 */
export function Inspector({ tab, onClose, onManageBrowser }: Props) {
  const { snapshot, desk, deskError, aliasOf } = useRoom();
  const errors = Object.entries(desk?.errors ?? {});
  const tasks = taskCount(snapshot.tasks, snapshot.nativeRequests.length);
  const changed = useChangedCount();
  const count = tab === "tasks" ? tasks : tab === "changes" ? changed : null;

  // Re-render the "updated Ns ago" footer once a second while desk data is shown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab !== "people" && tab !== "changes") return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [tab]);

  return (
    <aside className="queue-drawer inspector" aria-label={TITLES[tab]}>
      <div className="inspector-head">
        <h2>{TITLES[tab]}</h2>
        {count !== null ? <span className="lane-count mono">{count}</span> : null}
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="queue-body">
        {tab === "people" ? <CrewPanel /> : null}
        {tab === "browser" ? <RoomBrowserPanel onManage={onManageBrowser} /> : null}
        {tab === "tasks" ? <TaskLanes /> : null}
        {tab === "changes" ? <ChangesTab /> : null}
      </div>
      {tab === "people" || tab === "changes" ? (
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
