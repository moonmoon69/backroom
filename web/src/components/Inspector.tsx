import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { CrewButton, CrewPanel } from "./Crew.tsx";
import { ageOf } from "./deskFormat.ts";
import { BoardLanes, boardCount } from "./QueueDrawer.tsx";

export type InspectorTab = "people" | "board" | "changes";

const TITLES: Record<InspectorTab, string> = { people: "People", board: "Board", changes: "Changes" };

/** Files changed across the room's threads; null until the desk has been read. */
function useChangedCount(): number | null {
  const { desk } = useRoom();
  return desk ? Object.values(desk.participants).reduce((n, d) => n + d.changedFiles.length, 0) : null;
}

/**
 * The room header's switches for the side panel: people, board and changes. Each opens the panel on its tab; the
 * tab already showing closes it.
 */
export function PanelButtons({ open, tab, onToggle }: { open: boolean; tab: InspectorTab; onToggle: (tab: InspectorTab) => void }) {
  const { snapshot } = useRoom();
  const board = boardCount(snapshot.tasks, snapshot.nativeRequests.length);
  const needInput = snapshot.nativeRequests.length;
  const changed = useChangedCount();
  const on = (key: InspectorTab) => open && tab === key;
  return (
    <span className="panel-buttons" role="group" aria-label="Side panel">
      <CrewButton active={on("people")} onClick={() => onToggle("people")} />
      <button type="button" className={`small${on("board") ? " active" : ""}`} aria-pressed={on("board")} onClick={() => onToggle("board")} title="Work waiting, running and needing input">
        Board
        {board > 0 ? <span className="panel-count mono">{board}</span> : null}
        {needInput > 0 ? <span className="pill pill-input">{needInput} need input</span> : null}
      </button>
      <button type="button" className={`small${on("changes") ? " active" : ""}`} aria-pressed={on("changes")} onClick={() => onToggle("changes")} title="Files changed across the room's threads">
        Changes
        {changed ? <span className="panel-count mono">{changed}</span> : null}
      </button>
    </span>
  );
}

interface Props {
  tab: InspectorTab;
  onClose: () => void;
}

/**
 * Right side panel, switched from the header: People (who is seated, their threads), Board (the queue, with what each
 * participant is doing outside it) and Changes (files across the room).
 */
export function Inspector({ tab, onClose }: Props) {
  const { snapshot, desk, deskError, aliasOf } = useRoom();
  const errors = Object.entries(desk?.errors ?? {});
  const board = boardCount(snapshot.tasks, snapshot.nativeRequests.length);
  const changed = useChangedCount();
  const count = tab === "board" ? board : tab === "changes" ? changed : null;

  // Re-render the "updated Ns ago" footer once a second while desk data is shown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab === "board") return;
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
        {tab === "board" ? <BoardLanes /> : null}
        {tab === "changes" ? <ChangesTab /> : null}
      </div>
      {tab !== "board" ? (
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
