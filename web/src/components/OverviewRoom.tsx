import { useEffect, useState } from "react";
import { useRoom, type FollowUpPrefill } from "../context.tsx";
import { isActiveParticipant, type T3Project } from "../types.ts";
import { BackgroundBar } from "./BackgroundBar.tsx";
import { Composer } from "./Composer.tsx";
import { GitButton, Inspector, type InspectorTab } from "./Inspector.tsx";
import { CrewButton } from "./Crew.tsx";
import { Monogram } from "./Monogram.tsx";
import { RoomBrowserButton } from "./RoomBrowser.tsx";
import { RoomHeaderMenu } from "./RoomActions.tsx";
import { Timeline } from "./Timeline.tsx";
import { WorkBar } from "./WorkBar.tsx";
import { CloseIcon } from "./icons.tsx";

/** How many posts the sheet draws at first; "earlier" above them draws the next window. */
const CHAT_WINDOW = 40;
const BOARD_WINDOW = 60;

/**
 * A room as the Overview look opens it: a sheet over the page of cards. One header (close, the room's name, the two
 * views as tabs, the crew, the side panels), the status bar, then one view at a time: the conversation with the
 * Consigliere, read like a chat, or the board, read like a ledger of every post. The composer is under both; what is
 * typed goes the same way whichever is showing. A room without a Consigliere has only the board.
 */
export function OverviewRoom({
  project,
  followUp,
  onClose,
  onManageBrowser,
}: {
  project: T3Project | null;
  followUp: FollowUpPrefill | null;
  onClose: () => void;
  onManageBrowser: (browserId: string | null) => void;
}) {
  const { snapshot, participantById } = useRoom();
  const designated = snapshot.room.consigliereId ? participantById(snapshot.room.consigliereId) : undefined;
  const consigliere = designated && !designated.retiredAt ? designated : null;
  const [view, setView] = useState<"chat" | "board">("chat");
  const [panel, setPanel] = useState<InspectorTab | null>(null);
  useEffect(() => {
    setView("chat");
    setPanel(null);
  }, [snapshot.room.id]);
  const togglePanel = (tab: InspectorTab) => setPanel((current) => (current === tab ? null : tab));
  const members = snapshot.participants.filter(isActiveParticipant);
  const posts = snapshot.events.filter((event) => event.kind !== "task.status" && event.kind !== "system").length;
  const chat = consigliere !== null && view === "chat";
  return (
    <div className={`sheet ${chat ? "sheet-chat" : "sheet-board"}`}>
      <header className="sheet-head">
        <button type="button" className="small ghost icon-only sheet-close" aria-label="Back to the overview" title="Back to the overview (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="sheet-title">
          <h1 title={snapshot.room.title}>{snapshot.room.title}</h1>
          <span className="sheet-sub muted">
            {project ? `${project.title} · ` : ""}
            {members.length} member{members.length === 1 ? "" : "s"}
          </span>
        </div>
        {consigliere ? (
          <div className="sheet-tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={chat} className={chat ? "on" : ""} title={`Your conversation with ${consigliere.alias}, the Consigliere`} onClick={() => setView("chat")}>
              <Monogram participant={consigliere} size="xs" />
              {consigliere.alias}
            </button>
            <button type="button" role="tab" aria-selected={!chat} className={chat ? "" : "on"} title="Every post in the room, by number" onClick={() => setView("board")}>
              Board
              <span className="sheet-count mono">{posts}</span>
            </button>
          </div>
        ) : null}
        <span className="spacer" />
        <span className="sheet-tools">
          <CrewButton active={panel === "people"} onClick={() => togglePanel("people")} />
          <RoomBrowserButton active={panel === "browser"} onClick={() => togglePanel("browser")} />
          <GitButton active={panel === "git"} onClick={() => togglePanel("git")} />
          <RoomHeaderMenu projectTitle={project?.title ?? null} />
        </span>
      </header>
      <WorkBar />
      <div className="sheet-body">
        <section className="sheet-main" aria-label={chat ? `Conversation with ${consigliere?.alias}` : "Board"}>
          <Timeline key={chat ? "chat" : "board"} view={chat ? "chat" : "board"} limit={chat ? CHAT_WINDOW : BOARD_WINDOW} />
          <BackgroundBar />
          <Composer followUp={followUp} />
        </section>
        {panel ? <Inspector tab={panel} onClose={() => setPanel(null)} onManageBrowser={onManageBrowser} /> : null}
      </div>
    </div>
  );
}
