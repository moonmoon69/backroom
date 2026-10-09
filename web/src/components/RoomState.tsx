import { useEffect, useState } from "react";
import { useRoom } from "../context.tsx";
import { navProps } from "../keys.ts";
import { ageOf } from "./deskFormat.ts";
import { ChevronIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { Monogram } from "./Monogram.tsx";

/** Open or closed, the same in every room on this device. */
const OPEN_KEY = "backroom.roomState.open";
/** The `at` of the last state opened in a room, so a newer one is marked new. */
const seenKey = (roomId: string) => `backroom.roomState.seen:${roomId}`;

/**
 * The room state at the top of the room: the Consigliere's summary of where the room stands (rooms-board state), read
 * before the posts. Closed it is its first line, with who wrote it and when; open it is the whole text. Open or closed
 * is kept on this device; a state written since you last opened it here is marked new. A new state arrives with the
 * room's snapshot, so it shows without a reload. Written, it is a lane of the room's keys (keys.ts): its line is the one
 * item, and Enter opens or folds it; "none yet" is no stop.
 */
export function RoomStatePanel() {
  const { snapshot } = useRoom();
  const state = snapshot.state ?? null;
  const roomId = snapshot.room.id;
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  // Keyed by the room (OverviewRoom), so this is read once per room.
  const [seen, setSeen] = useState(() => localStorage.getItem(seenKey(roomId)));
  // Open, the state on screen is read.
  useEffect(() => {
    if (!open || !state?.at || state.at === seen) return;
    localStorage.setItem(seenKey(roomId), state.at);
    setSeen(state.at);
  }, [open, state?.at, seen, roomId]);
  const toggle = () => {
    localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    setOpen(!open);
  };

  const keeper = snapshot.room.consigliereId ? "The Consigliere keeps it" : "Kept by the room's members";
  if (!state) {
    return (
      <div className="room-state room-state-none muted" title={`${keeper} with rooms-board state: where the room stands, for you and for every new seat.`}>
        <span className="room-state-label mono">Room state</span>
        <span>none yet; {snapshot.room.consigliereId ? "the Consigliere writes it" : "a member writes it"} with rooms-board state.</span>
      </div>
    );
  }
  const writer = snapshot.participants.find((p) => p.alias === state.by);
  const fresh = Boolean(state.at) && (!seen || state.at > seen);
  const when = state.at ? new Date(state.at).toLocaleString() : "";
  return (
    <section className={`room-state${open ? " open" : ""}`} aria-label="Room state" data-nav-lane="state">
      <button type="button" className="room-state-head" aria-expanded={open} title={open ? "Close the room state" : `Open the room state. ${keeper} current with rooms-board state.`} onClick={toggle} {...navProps("state", "state", `room state · ${state.line}`)}>
        <ChevronIcon dir={open ? "down" : "right"} small />
        <span className="room-state-label mono">Room state</span>
        {fresh ? <span className="pill pill-new">new</span> : null}
        {open ? <span className="spacer" /> : <span className="room-state-line">{state.line}</span>}
        <span className="room-state-by mono muted" title={when ? `Written ${when}` : undefined}>
          {writer ? <Monogram participant={writer} size="xs" /> : null}
          {state.by || "?"}
          {state.at ? ` · ${ageOf(state.at)}` : ""}
        </span>
      </button>
      {open ? (
        <div className="room-state-body">
          <Markdown text={state.text} className="md-small" />
          <p className="room-state-note muted">
            {keeper} with <code>rooms-board state</code>; each write replaces the last, and every new seat starts from it. Posts after {when || "it"} may have moved on.
          </p>
        </div>
      ) : null}
    </section>
  );
}
