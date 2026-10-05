import { useState } from "react";
import { useSkin } from "../skin.ts";
import { useRoom, type FollowUpPrefill } from "../context.tsx";
import { BackgroundBar } from "./BackgroundBar.tsx";
import { Composer } from "./Composer.tsx";
import { Monogram } from "./Monogram.tsx";
import { Timeline } from "./Timeline.tsx";
import { WorkBar } from "./WorkBar.tsx";

/**
 * The middle of a room. Without a Consigliere it is the board with the composer, as always. With one it is two panels:
 * the user's chat with him (a view of the board: the messages addressed to him and his replies), with the composer
 * under it, and the board, where every post of the room is. Wide screens show both; a narrow one shows the chat first
 * (the board can be hidden there) and a button switches to the board. Above either, the status bar says what needs you and who is doing what.
 */
const BOARD_HIDDEN_KEY = "backroom.boardHidden";

export function RoomCentre({ followUp }: { followUp: FollowUpPrefill | null }) {
  const { snapshot, participantById } = useRoom();
  const [pane, setPane] = useState<"chat" | "board">("chat");
  const [skin] = useSkin();
  // On a wide screen the board can be put away, leaving the chat the full width; the choice is kept on this device.
  // From the overview a room opens on the chat alone (that is where the talking happens); the board is one click
  // further, and that choice is not kept.
  const fromOverview = skin === "overview";
  const [boardHidden, setBoardHidden] = useState(() => fromOverview || localStorage.getItem(BOARD_HIDDEN_KEY) === "1");
  const hideBoard = (hidden: boolean) => {
    setBoardHidden(hidden);
    if (fromOverview) return;
    if (hidden) localStorage.setItem(BOARD_HIDDEN_KEY, "1");
    else localStorage.removeItem(BOARD_HIDDEN_KEY);
  };
  const consigliere = snapshot.room.consigliereId ? participantById(snapshot.room.consigliereId) : undefined;
  if (!consigliere || consigliere.retiredAt) {
    return (
      <div className="room-centre">
        <WorkBar />
        <Timeline />
        <BackgroundBar />
        <Composer followUp={followUp} />
      </div>
    );
  }
  const posts = snapshot.events.filter((event) => event.kind !== "task.status" && event.kind !== "system").length;
  return (
    <div className="room-centre">
      <WorkBar />
      <div className={`room-panes${boardHidden ? " board-hidden" : ""}`} data-pane={pane}>
      <section className="room-pane consigliere-pane" aria-label={`Chat with ${consigliere.alias}, the Consigliere`}>
        <div className="pane-head">
          <Monogram participant={consigliere} size="xs" />
          <span className="pane-title mono">{consigliere.alias}</span>
          <span className="pane-role muted">Consigliere</span>
          <span className="spacer" />
          <button type="button" className="small pane-switch" onClick={() => setPane("board")}>
            Board · {posts}
          </button>
          {boardHidden ? (
            <button type="button" className="small pane-wide" title="Show the board beside the chat: every post in the room" onClick={() => hideBoard(false)}>
              Show board · {posts}
            </button>
          ) : null}
        </div>
        <Timeline view="chat" />
        <BackgroundBar />
        <Composer followUp={followUp} />
      </section>
      <section className="room-pane board-pane" aria-label="Board">
        <div className="pane-head">
          <span className="pane-title mono">Board</span>
          <span className="pane-role muted">every post in the room · {posts}</span>
          <span className="spacer" />
          <button type="button" className="small pane-switch" onClick={() => setPane("chat")}>
            Chat with {consigliere.alias}
          </button>
          <button type="button" className="small ghost pane-wide" title="Put the board away; the chat takes the full width" onClick={() => hideBoard(true)}>
            Hide
          </button>
        </div>
        <Timeline />
      </section>
      </div>
    </div>
  );
}
