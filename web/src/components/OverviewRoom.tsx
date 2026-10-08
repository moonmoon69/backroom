import { useEffect, useRef, useState } from "react";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, type T3Project } from "../types.ts";
import { BackgroundBar } from "./BackgroundBar.tsx";
import { Composer } from "./Composer.tsx";
import { GitButton, Inspector, type InspectorTab } from "./Inspector.tsx";
import { CrewButton } from "./Crew.tsx";
import { Monogram } from "./Monogram.tsx";
import { RoomBrowserButton } from "./RoomBrowser.tsx";
import { RoomHeaderMenu } from "./RoomActions.tsx";
import { RoomStatePanel } from "./RoomState.tsx";
import { Timeline } from "./Timeline.tsx";
import { WorkBar } from "./WorkBar.tsx";
import { CloseIcon } from "./icons.tsx";
import { byKey, focusItem, focusWhen, itemOf, listTarget, navItems, navKey, tabbables } from "../keys.ts";

/** The room's panes, left to right (keys.ts): the board (or the chat), then the side panel's tabs as the header orders them. */
const PANES = ["board", "people", "browser", "git"] as const;
type Pane = (typeof PANES)[number];

/** How many posts the sheet draws at first; "earlier" above them draws the next window. */
const CHAT_WINDOW = 40;
const BOARD_WINDOW = 60;

/**
 * A room as the Overview look opens it: a sheet over the page of cards. One header (close, the room's name, the two
 * views as tabs, the crew, the side panels), the room state, the status bar, then one view at a time: the conversation
 * with the Consigliere, read like a chat, or the board, read like a ledger of every post. The composer is under both,
 * closed to a strip until wanted and then over the conversation; what is typed goes the same way whichever is showing.
 * A room without a Consigliere has only the board.
 */
export function OverviewRoom({
  project,
  panel,
  onPanel,
  onClose,
  onManageBrowser,
}: {
  project: T3Project | null;
  /** The side panel's tab, or none: kept by the app, which reads the Git tab in full only while it shows. */
  panel: InspectorTab | null;
  onPanel: (tab: InspectorTab | null) => void;
  onClose: () => void;
  onManageBrowser: (browserId: string | null) => void;
}) {
  const { snapshot, participantById } = useRoom();
  const designated = snapshot.room.consigliereId ? participantById(snapshot.room.consigliereId) : undefined;
  const consigliere = designated && !designated.retiredAt ? designated : null;
  const [view, setView] = useState<"chat" | "board">("chat");
  useEffect(() => {
    setView("chat");
    onPanel(null);
  }, [snapshot.room.id, onPanel]);
  const togglePanel = (tab: InspectorTab) => onPanel(panel === tab ? null : tab);

  // ---- the keys (keys.ts): Up and Down through the focused pane's items, Left and Right between the panes ----
  const sheet = useRef<HTMLDivElement>(null);
  // The item last focused in each pane, by key: coming back to a pane comes back to it.
  const lastIn = useRef<Partial<Record<Pane, string>>>({});
  const paneElement = (pane: Pane) => sheet.current?.querySelector<HTMLElement>(`[data-nav-pane="${pane}"]`) ?? null;
  useEffect(() => {
    const root = sheet.current;
    if (!root) return;
    const onFocus = (event: FocusEvent) => {
      const item = itemOf(event.target as Element);
      const pane = item?.closest<HTMLElement>("[data-nav-pane]")?.dataset.navPane as Pane | undefined;
      if (item?.dataset.navKey && pane) lastIn.current[pane] = item.dataset.navKey;
    };
    root.addEventListener("focusin", onFocus);
    return () => root.removeEventListener("focusin", onFocus);
  }, []);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  // What a pane's arrows land on first: the item last focused there, else the newest post or the first member, else the
  // composer's strip (an empty board) or the pane itself.
  const landing = (pane: Pane): HTMLElement | null => {
    const element = paneElement(pane);
    if (!element) return null;
    const items = navItems(element);
    return byKey(element, lastIn.current[pane]) ?? (pane === "board" ? (items.at(-1) ?? element.querySelector<HTMLElement>(".composer-strip")) : items[0]) ?? element;
  };
  const landingRef = useRef(landing);
  landingRef.current = landing;
  useEffect(() => {
    const landing = (pane: Pane) => landingRef.current(pane);
    const onKey = (event: KeyboardEvent) => {
      const key = navKey(event);
      const root = sheet.current;
      if (!key || !root || root.closest("[inert]")) return;
      const target = event.target instanceof Element ? event.target : null;
      // The focus is in the room, or nowhere in particular (the page, the drawer around the room).
      if (target && !root.contains(target) && !target.contains(root)) return;
      event.preventDefault();
      const scope = target?.closest<HTMLElement>("[data-nav-pane]") ?? null;
      const pane = (scope?.dataset.navPane as Pane | undefined) ?? "board";
      if (key === "left" || key === "right") {
        const next = PANES[PANES.indexOf(pane) + (key === "right" ? 1 : -1)];
        if (!next) return;
        if (next !== "board" && panelRef.current !== next) onPanel(next);
        focusWhen(() => landing(next));
        return;
      }
      const element = scope ?? paneElement("board");
      if (!element) return;
      // The pane's items; a pane without any (Browser, Git) goes through its controls.
      const navigable = navItems(element);
      const items = navigable.length > 0 ? navigable : tabbables(element);
      const current = navigable.length > 0 ? itemOf(target) : (target as HTMLElement | null);
      // From outside the pane's items (the composer, a button, the pane itself), the first key lands on the pane's item.
      if (!current || !items.includes(current)) {
        const land = landing(pane);
        focusItem(land && land !== target ? land : listTarget(items, null, key));
        return;
      }
      const next = listTarget(items, current, key);
      if (next) {
        focusItem(next);
        return;
      }
      // Past the board's top: its earlier posts are drawn (or read), and the focus goes on to the one above; with none,
      // up to the view's tabs (the chat or the board), whose Left and Right switch the view.
      const earlier = key === "up" && pane === "board" ? element.querySelector<HTMLButtonElement>(".earlier-posts:not(:disabled)") : null;
      if (!earlier) {
        if (key === "up" && pane === "board") root.querySelector<HTMLElement>(".sheet-tabs [role=tab][aria-selected=true]")?.focus();
        return;
      }
      const from = current.dataset.navKey;
      earlier.click();
      focusWhen(() => {
        const list = navItems(element);
        const at = list.findIndex((item) => item.dataset.navKey === from);
        return at > 0 ? list[at - 1] : null;
      }, 8000);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onPanel]);
  const members = snapshot.participants.filter(isActiveParticipant);
  // The board's size: every post on the journal (the page holds the newest of them).
  const posts = snapshot.counts.posts;
  const chat = consigliere !== null && view === "chat";
  return (
    <div className={`sheet ${chat ? "sheet-chat" : "sheet-board"}`} ref={sheet} data-room-id={snapshot.room.id}>
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
          <div
            className="sheet-tabs"
            role="tablist"
            aria-label="View"
            onKeyDown={(event) => {
              // The tabs' own arrows (the ARIA tabs pattern): Left and Right switch the view; Down goes to its posts.
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusItem(landing("board"));
                return;
              }
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setView(chat ? "board" : "chat");
              event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[chat ? 1 : 0]?.focus();
            }}
          >
            <button type="button" role="tab" aria-selected={chat} tabIndex={chat ? 0 : -1} className={chat ? "on" : ""} title={`Your conversation with ${consigliere.alias}, the Consigliere`} onClick={() => setView("chat")}>
              <Monogram participant={consigliere} size="xs" />
              {consigliere.alias}
            </button>
            <button type="button" role="tab" aria-selected={!chat} tabIndex={chat ? -1 : 0} className={chat ? "" : "on"} title="Every post in the room, by number" onClick={() => setView("board")}>
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
      <RoomStatePanel key={snapshot.room.id} />
      <WorkBar />
      <div className="sheet-body">
        <section className="sheet-main" aria-label={chat ? `Conversation with ${consigliere?.alias}` : "Board"} data-nav-pane="board">
          <Timeline key={chat ? "chat" : "board"} view={chat ? "chat" : "board"} limit={chat ? CHAT_WINDOW : BOARD_WINDOW} />
          <BackgroundBar />
          <Composer overlay />
        </section>
        {panel ? <Inspector tab={panel} onClose={() => onPanel(null)} onManageBrowser={onManageBrowser} /> : null}
      </div>
    </div>
  );
}
