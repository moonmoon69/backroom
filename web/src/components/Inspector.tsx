import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { ageOf } from "./deskFormat.ts";
import { BoardLanes, boardCount } from "./QueueDrawer.tsx";

export type InspectorTab = "board" | "changes";

interface Props {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
}

/**
 * Right rail: Board (the queue, with what each participant is doing outside it) and Changes (files across the room).
 * Per-participant thread detail lives on the participant tile: usage card on hover, "Thread details…" in its menu.
 */
export function Inspector({ tab, onTab, onClose }: Props) {
  const { snapshot, desk, deskError, aliasOf } = useRoom();
  const board = boardCount(snapshot.tasks, snapshot.nativeRequests.length);
  const changed = Object.values(desk?.participants ?? {}).reduce((n, d) => n + d.changedFiles.length, 0);
  const errors = Object.entries(desk?.errors ?? {});

  // Re-render the "updated Ns ago" footer once a second while desk data is shown.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (tab === "board") return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [tab]);

  const tabs: Array<{ key: InspectorTab; label: string; count: number | null }> = [
    { key: "board", label: "Board", count: board },
    { key: "changes", label: "Changes", count: desk ? changed : null },
  ];

  return (
    <aside className="queue-drawer inspector" aria-label="Inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`inspector-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`inspector-panel-${t.key}`}
            className={`inspector-tab mono${tab === t.key ? " on" : ""}`}
            onClick={() => onTab(t.key)}
          >
            {t.label}
            {t.count !== null ? <span className="lane-count mono">{t.count}</span> : null}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="queue-body" role="tabpanel" id={`inspector-panel-${tab}`} aria-labelledby={`inspector-tab-${tab}`}>
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
