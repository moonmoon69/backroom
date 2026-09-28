import { useEffect, useState } from "react";
import type { FollowUpPrefill } from "../../context.tsx";
import { BackgroundBar } from "../BackgroundBar.tsx";
import { Composer } from "../Composer.tsx";
import { Inspector, type InspectorTab } from "../Inspector.tsx";
import { Timeline } from "../Timeline.tsx";
import { BackRoomScene } from "./BackRoomScene.tsx";

/** Whether the conversation shows under the table, kept on this device. */
const LOG_KEY = "backroom.street.log";

interface Props {
  night: boolean;
  projectTitle: string | null;
  followUp: FollowUpPrefill | null;
  /** The room's panel opened from one of its things, or null. */
  panel: InspectorTab | null;
  onPanel: (tab: InspectorTab | null) => void;
  onLeave: () => void;
  onManageBrowser: (browserId: string | null) => void;
}

/**
 * Inside a building: a room's back room. The table scene on top, the conversation under it (the letters, which can
 * be put away so the table fills the screen), and what you say at the bottom. The board, the ledger, the telephone
 * and the cabinet open the room's panels; the door, or Esc, goes back out to the street.
 */
export function BackRoom({ night, projectTitle, followUp, panel, onPanel, onLeave, onManageBrowser }: Props) {
  const [logOpen, setLogOpen] = useState(() => localStorage.getItem(LOG_KEY) !== "min");
  useEffect(() => {
    localStorage.setItem(LOG_KEY, logOpen ? "open" : "min");
  }, [logOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      // Not while writing, and not from a dialog: those close themselves.
      if (target?.closest("textarea, input, select, [role='dialog'], .dialog, .menu")) return;
      if (document.querySelector(".dialog-backdrop, [role='dialog'][aria-modal='true']")) return;
      if (panel) onPanel(null);
      else onLeave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onPanel, onLeave]);

  return (
    <div className={`street-room${logOpen ? "" : " log-hidden"}${night ? " is-night" : " is-day"}`}>
      <BackRoomScene night={night} projectTitle={projectTitle} logOpen={logOpen} onLog={setLogOpen} onLeave={onLeave} onPanel={onPanel} />
      <div className="street-room-log">
        <Timeline />
      </div>
      <BackgroundBar />
      <Composer followUp={followUp} />
      {panel ? <Inspector tab={panel} onClose={() => onPanel(null)} onManageBrowser={onManageBrowser} /> : null}
    </div>
  );
}
