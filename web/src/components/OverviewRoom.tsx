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
import { laneTarget, openLanding, type Lane } from "../keyOrder.ts";
import { byKey, focusItem, focusWhen, itemOf, laneAt, listTarget, navItems, navKey, navProps, roomLanes, showsAtBottom, tabbables } from "../keys.ts";

/** The room's panes, left to right (keys.ts): the board (or the chat), then the side panel's tabs as the header orders them. */
const PANES = ["board", "people", "browser", "git"] as const;
type Pane = (typeof PANES)[number];

/**
 * The ring's landing as a room opens: the item it put the ring on (by key), whether the room's desk had been read when
 * it began or has been since, and how to stop it.
 */
type Opening = { roomId: string; deskSeen: boolean; landed: string | null; cancel: () => void };

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
  const { snapshot, participantById, desk, deskError } = useRoom();
  const designated = snapshot.room.consigliereId ? participantById(snapshot.room.consigliereId) : undefined;
  const consigliere = designated && !designated.retiredAt ? designated : null;
  const [view, setView] = useState<"chat" | "board">("chat");
  useEffect(() => {
    setView("chat");
    onPanel(null);
  }, [snapshot.room.id, onPanel]);
  // ---- the keys (keys.ts) ----
  // The conversation reads in lanes, top to bottom: the header, the room state, the status chips, the posts and the
  // composer's strip (keyOrder.ts, laneTarget). Up and Down go lane to lane, post to post in the posts lane; Left and
  // Right go along the header and the status chips, and elsewhere between the panes: the board (the conversation), then
  // the side panel's Members, Browser and Git, where Up and Down go through the members (or the pane's controls).
  const sheet = useRef<HTMLDivElement>(null);
  // The item last focused in each pane and in each lane, by key: coming back to one comes back to it.
  const lastIn = useRef<Partial<Record<Pane, string>>>({});
  const lastInLane = useRef<Partial<Record<Lane<HTMLElement>["name"], string>>>({});
  const paneElement = (pane: Pane) => sheet.current?.querySelector<HTMLElement>(`[data-nav-pane="${pane}"]`) ?? null;
  useEffect(() => {
    const root = sheet.current;
    if (!root) return;
    const onFocus = (event: FocusEvent) => {
      const item = itemOf(event.target as Element);
      const key = item?.dataset.navKey;
      if (!item || !key) return;
      // The conversation's lanes are the board's pane; the side panel's are its own.
      lastIn.current[(item.closest<HTMLElement>("[data-nav-pane]")?.dataset.navPane as Pane | undefined) ?? "board"] = key;
      const lane = item.closest<HTMLElement>("[data-nav-lane]")?.dataset.navLane as Lane<HTMLElement>["name"] | undefined;
      if (lane) lastInLane.current[lane] = key;
    };
    root.addEventListener("focusin", onFocus);
    return () => root.removeEventListener("focusin", onFocus);
  }, []);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  // Where the ring lands coming into a lane: the item last visited there; else the header's open view (or Members), the
  // first status chip that needs you, the newest post.
  const laneLanding = (name: Lane<HTMLElement>["name"], items: HTMLElement[]): HTMLElement | null => {
    const last = lastInLane.current[name];
    const kept = last ? items.find((item) => item.dataset.navKey === last) : undefined;
    if (kept) return kept;
    if (name === "header") return items.find((item) => item.getAttribute("aria-selected") === "true") ?? items.find((item) => item.dataset.navKey === "head:people") ?? null;
    if (name === "status") return items.find((item) => item.closest(".work-needs")) ?? null;
    if (name === "posts") return items.at(-1) ?? null;
    return null;
  };
  const lanes = () => (sheet.current ? roomLanes(sheet.current, laneLanding) : []);
  // What a pane's arrows land on first: the item last focused there, else the newest post or the first member, else the
  // composer's strip (an empty board) or the pane itself.
  const landing = (pane: Pane): HTMLElement | null => {
    const element = paneElement(pane);
    if (!element) return null;
    if (pane === "board") return byKey(sheet.current!, lastIn.current.board) ?? lanes().find((lane) => lane.name === "posts")?.landing ?? element.querySelector<HTMLElement>(".composer-strip") ?? element;
    return byKey(element, lastIn.current[pane]) ?? navItems(element)[0] ?? element;
  };
  const landingRef = useRef(landing);
  landingRef.current = landing;
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  // Members, Browser or Git from the header: the panel opens or folds; opened by a key (a click from the keyboard has
  // no pointer behind it), the ring goes into it, and Backspace there brings it back to the header.
  const togglePanel = (tab: InspectorTab, fromKey = false) => {
    if (panel === tab) {
      onPanel(null);
      return;
    }
    onPanel(tab);
    if (fromKey) focusWhen(() => (panelRef.current === tab ? landingRef.current(tab) : null));
  };

  // Where the ring lands when the room opens (keyOrder.ts, openLanding: a chip that needs you, else the newest post if it
  // shows, else the running turn's chip, else the strip), once the room's first desk read is drawn and its running
  // turns' rows are laid out at their size (rows are content-visibility: auto, drawn at a placeholder height at first):
  // a running turn's live feed comes with the desk, and its bubble can push the newest post out of the board's view.
  // Whether it shows is judged with the board at its bottom, where it opens and stays. Focused without scrolling, so
  // the board stays at its bottom and keeps following the turn. Typing anywhere still opens the composer; a ring
  // already moved into the room (a key pressed while it opened) stays where it is. A desk read slower than the wait
  // lands the ring once more when it comes, if the ring is still where the landing put it.
  const deskRead = desk !== null || deskError !== null;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(timer);
  }, [snapshot.room.id]);
  // The landing under way, kept outside the effect: its next run (the wait ending) must not cancel it.
  const opening = useRef<Opening | null>(null);
  useEffect(() => () => opening.current?.cancel(), []);
  /** Land the ring, tried each frame. A ring in the room stays, unless it is on the item this landing put it on before. */
  const land = (record: Opening): (() => void) => {
    const since = performance.now();
    const ours = record.landed;
    return focusWhen(() => {
      const root = sheet.current;
      const active = document.activeElement;
      // Already in the room: focusing it again moves nothing.
      if (root && active instanceof HTMLElement && root.contains(active) && (ours === null || active.dataset.navKey !== ours)) return active;
      const all = lanesRef.current();
      const chips = all.find((lane) => lane.name === "status")?.items ?? [];
      const newest = all.find((lane) => lane.name === "posts")?.items.at(-1) ?? null;
      const live = [...(root?.querySelectorAll<HTMLElement>(".timeline .live-turn") ?? [])];
      // A row's own box is drawn while its contents are skipped: the check is on what is in it (for up to a second).
      if (performance.now() - since < 1000 && live.some((row) => row.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }) === false)) return null;
      const chosen = openLanding({
        needs: chips.find((item) => item.closest(".work-needs")) ?? null,
        newest,
        newestInView: newest !== null && showsAtBottom(newest),
        running: chips.find((item) => item.dataset.navKey?.startsWith("chip:run:")) ?? null,
        strip: all.find((lane) => lane.name === "strip")?.items[0] ?? null,
      });
      record.landed = chosen?.dataset.navKey ?? null;
      return chosen;
    }, 2000, false);
  };
  useEffect(() => {
    const roomId = snapshot.room.id;
    const current = opening.current?.roomId === roomId ? opening.current : null;
    if (current) {
      // The desk came after the landing stopped waiting for it: land again, unless a key has moved the ring since.
      if (!deskRead || current.deskSeen) return;
      current.deskSeen = true;
      const active = document.activeElement;
      if (current.landed !== null && !(active instanceof HTMLElement && active.dataset.navKey === current.landed)) return;
      current.cancel();
      current.cancel = land(current);
      return;
    }
    if (!deskRead && !waited) return;
    opening.current?.cancel();
    const record: Opening = { roomId, deskSeen: deskRead, landed: null, cancel: () => undefined };
    record.cancel = land(record);
    opening.current = record;
  }, [snapshot.room.id, deskRead, waited]);

  // The panel closed with the focus in it (Backspace, its ×): the focus goes back to the conversation, on the item it
  // came from, without moving the board. A key closed it when the ring shows there (:focus-visible follows the last
  // input), and then the item is brought into view; after a click the board stays where it was.
  const hadPanel = useRef(panel);
  useEffect(() => {
    const had = hadPanel.current;
    hadPanel.current = panel;
    const now = document.activeElement;
    if (!had || panel || (now && now !== document.body)) return;
    const item = landingRef.current("board");
    item?.focus({ preventScroll: true });
    if (item?.matches(":focus-visible")) item.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [panel]);
  useEffect(() => {
    const landing = (pane: Pane) => landingRef.current(pane);
    const onKey = (event: KeyboardEvent) => {
      const key = navKey(event);
      const root = sheet.current;
      if (!key || !root || root.closest("[inert]")) return;
      const target = event.target instanceof Element ? event.target : null;
      // The focus is in the room, or nowhere in particular (the page, the drawer around the room).
      if (target && !root.contains(target) && !target.contains(root)) return;
      const scope = target?.closest<HTMLElement>("[data-nav-pane]:not([data-nav-pane='board'])") ?? null;
      const pane = (scope?.dataset.navPane as Pane | undefined) ?? "board";
      // The conversation: its lanes, unless the key is Left or Right off the header and the status chips.
      if (pane === "board") {
        const all = lanesRef.current();
        const posts = all.find((lane) => lane.name === "posts");
        const earlier = posts?.element.querySelector<HTMLButtonElement>(".earlier-posts:not(:disabled)") ?? null;
        const at = target && root.contains(target) ? laneAt(all, target) : null;
        const move = laneTarget(all, at, key, earlier !== null);
        if (move !== null) {
          event.preventDefault();
          if (move === "stay") return;
          if ("to" in move) {
            focusItem(move.to);
            return;
          }
          // Past the first post: the earlier posts are drawn (or read), and the focus goes on to the one above.
          const from = posts!.items[0]!.dataset.navKey;
          earlier!.click();
          focusWhen(() => {
            const list = navItems(posts!.element);
            const index = list.findIndex((item) => item.dataset.navKey === from);
            return index > 0 ? list[index - 1] : null;
          }, 8000);
          return;
        }
      }
      event.preventDefault();
      if (key === "left" || key === "right") {
        const next = PANES[PANES.indexOf(pane) + (key === "right" ? 1 : -1)];
        if (!next) return;
        if (next !== "board" && panelRef.current !== next) onPanel(next);
        focusWhen(() => landing(next));
        return;
      }
      // The side panel: its members; a pane without any (Browser, Git) goes through its controls.
      const element = scope!;
      const navigable = navItems(element);
      const items = navigable.length > 0 ? navigable : tabbables(element);
      const current = navigable.length > 0 ? itemOf(target) : (target as HTMLElement | null);
      // From outside the pane's items (a button, the pane itself), the first key lands on the pane's item.
      if (!current || !items.includes(current)) {
        const land = landing(pane);
        focusItem(land && land !== target ? land : listTarget(items, null, key));
        return;
      }
      const next = listTarget(items, current, key);
      if (next) focusItem(next);
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
      {/* The header lane: ×, the view's tabs, Members, Browser, Git and the room's options, Left and Right along it. */}
      <header className="sheet-head" data-nav-lane="header">
        <button type="button" className="small ghost icon-only sheet-close" aria-label="Back to the overview" title="Back to the overview (Backspace)" onClick={onClose} {...navProps("head", "head:close", "header · back to the overview")}>
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
          // The arrows move along the header (keys.ts); Enter on a tab shows its view.
          <div className="sheet-tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={chat} tabIndex={chat ? 0 : -1} className={chat ? "on" : ""} title={`Your conversation with ${consigliere.alias}, the Consigliere`} onClick={() => setView("chat")} {...navProps("head", "head:chat", `header · the chat with @${consigliere.alias}`)}>
              <Monogram participant={consigliere} size="xs" />
              {consigliere.alias}
            </button>
            <button type="button" role="tab" aria-selected={!chat} tabIndex={chat ? -1 : 0} className={chat ? "" : "on"} title="Every post in the room, by number" onClick={() => setView("board")} {...navProps("head", "head:board", "header · the board")}>
              Board
              <span className="sheet-count mono">{posts}</span>
            </button>
          </div>
        ) : null}
        <span className="spacer" />
        <span className="sheet-tools">
          <CrewButton active={panel === "people"} onClick={(event) => togglePanel("people", event.detail === 0)} nav={navProps("head", "head:people", "header · Members")} />
          <RoomBrowserButton active={panel === "browser"} onClick={(event) => togglePanel("browser", event.detail === 0)} nav={navProps("head", "head:browser", "header · Browser")} />
          <GitButton active={panel === "git"} onClick={(event) => togglePanel("git", event.detail === 0)} nav={navProps("head", "head:git", "header · Git")} />
          <RoomHeaderMenu projectTitle={project?.title ?? null} nav={navProps("head", "head:menu", "header · the room's options")} />
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
