import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { isSubagentThread, type BrowserListItem, type CommandResult, type RoomCommand } from "../types.ts";
import { NewProjectDialog, NewRoomDialog } from "./NewDialogs.tsx";
import { ArrangeDialog, BrowsersSection, CrewSection, ThreadShelf } from "./OverviewSections.tsx";
import { RoomMenu } from "./RoomActions.tsx";
import { PlusIcon, StarMark } from "./icons.tsx";
import { useSkin } from "../skin.ts";
import { carriesPreset, droppedPresetId, usePresets } from "./presets.tsx";
import { describeStatus } from "../memberActivity.ts";
import { useConsigliereSetting } from "../consigliere.ts";
import { useDraftScopes } from "../drafts.ts";
import { roomKey, threadKey } from "../news.ts";
import type { AgentsFileWritten, OverviewRoom, OverviewThread, RoomListItem, T3Project, T3ThreadShell } from "../types.ts";
import { useToast } from "./Toast.tsx";
import { LookSprite, MemberMark } from "./MemberMark.tsx";
import { threadActivity, threadCrew } from "./ThreadView.tsx";
import { useCatalog } from "./catalog.ts";
import { byKey, focusItem, itemOf, keyOf, navKey, overviewItems } from "../keys.ts";
import { gridStart, gridTarget, type Span } from "../keyOrder.ts";

/** How old something is, in a word: "now", "3m", "2h", "4d". */
function age(iso: string | null | undefined): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const oneLine = (text: string, max = 140): string => {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/[`*_>#]+/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Backroom's page (the Street look aside): the whole of it on one page. A section per project; inside it every room,
 * and under each room its members with a status dot and one line of what each is doing now (a turn's latest note or
 * the tools running) or last said. The project's loose threads are tiles too, as rooms of one, and its settled and
 * archived threads fold open under them. Then the crew and the shared browsers. Click any of them to open it in the
 * drawer. The + on a project opens a new room there, with the Consigliere seated; the + in the header adds a project.
 * Arrange sets the order of projects and rooms. Rooms are the one thing made here; threads started in T3 show up as
 * their own tiles.
 *
 * From the keyboard it is a grid of rows (keys.ts): the header's buttons, then per section its head (the + button) and
 * its tiles. The tiles are the items, not the members drawn on them: a room's members are acted on inside the room.
 *
 * Inside a project the tiles are ranked by what they ask of you: needs you first (an approval, a question, a failure
 * nobody followed up), then new for you (a reply you have not seen), then busy, then the rest. Inside a tier they keep
 * the arranged order (Arrange), so a tile moves only when its tier changes: forward when it wants you, back once you looked.
 */
export function Overview({
  rooms,
  projects,
  threads,
  t3Error,
  browsers,
  onOpenRoom,
  onOpenThread,
  onOpenBrowser,
  onSeatPreset,
  onCommand,
  onT3Changed,
  onBrowsersChanged,
  controls,
  active,
  returnTo,
}: {
  rooms: RoomListItem[];
  projects: T3Project[] | null;
  /** Every T3 thread, archived ones too. */
  threads: T3ThreadShell[];
  /** Why projects and threads could not be read from T3, if they could not. */
  t3Error: string | null;
  /** The shared browsers on this machine; null when the service cannot run browsers. */
  browsers: BrowserListItem[] | null;
  onOpenRoom: (roomId: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenBrowser: (browserId: string) => void;
  onSeatPreset: (roomId: string, presetId: string) => Promise<void>;
  onCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  /** Re-read projects from T3 (after one was added). */
  onT3Changed: () => void;
  onBrowsersChanged: () => void;
  /** The app-wide controls (connection, updates, settings) for the page's header. */
  controls: ReactNode;
  /** Nothing covers the page (no room, thread or browser open over it): the arrows are the page's. */
  active: boolean;
  /** The item the focus goes back to when what covered the page closes, if the page does not remember one. */
  returnTo: string | null;
}) {
  const [dialog, setDialog] = useState<{ kind: "room"; projectId: string | null } | { kind: "project" } | { kind: "arrange" } | null>(null);
  const { toast } = useToast();
  const { presets } = usePresets();
  const consigliereSetting = useConsigliereSetting();
  const consigliere = presets.find((p) => p.id === consigliereSetting) ?? null;
  // The room tile a dragged crew member would be seated in.
  const [presetOver, setPresetOver] = useState<string | null>(null);
  const presetTarget = (key: string, onDrop: (presetId: string) => void) => ({
    onDragOver: (event: DragEvent) => {
      if (!carriesPreset(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setPresetOver(key);
    },
    onDragLeave: () => setPresetOver((current) => (current === key ? null : current)),
    onDrop: (event: DragEvent) => {
      const presetId = droppedPresetId(event);
      setPresetOver(null);
      if (!presetId) return;
      event.preventDefault();
      onDrop(presetId);
    },
  });
  const [detail, setDetail] = useState<Map<string, OverviewRoom>>(new Map());
  const [looseThreads, setLooseThreads] = useState<OverviewThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Conversations with unsent text (drafts.ts) carry a mark.
  const drafts = useDraftScopes();
  useEffect(() => {
    let stopped = false;
    const read = () =>
      api
        .overview()
        .then((result) => {
          if (stopped) return;
          setDetail(new Map(result.rooms.map((room) => [room.id, room])));
          setLooseThreads(result.threads);
          setError(null);
        })
        .catch((caught) => !stopped && setError(caught instanceof Error ? caught.message : String(caught)));
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // ---- the keys (keys.ts): the arrows move the focus over the page's rows of tiles and buttons ----
  const root = useRef<HTMLDivElement>(null);
  // The header sticks at the top while the page scrolls under it: what the ring goes to is brought into view below it
  // (scroll-padding-top in styles.css, from the header's height in either look, wrapped or not).
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    const header = head.current;
    if (!element || !header) return;
    const measure = () => element.style.setProperty("--overview-head", `${header.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  // The item last focused here, by key. A poll that redraws the page can move a card (to another tier, another project),
  // and the browser drops the focus of what it moves: the same item takes it back before the frame is painted.
  const remembered = useRef<string | null>(null);
  // Whether the item last focused anywhere on the page was that one: only then was it the poll that took the focus. A
  // dialog that closed (it gives the focus back itself), a click elsewhere, the address bar: none of them is.
  const holding = useRef(false);
  // The column a run of Up and Down keeps to: the span of the item it began on, while the ring is still on the item the
  // run's last press landed on (not on its ⋯, not elsewhere). A section's head (one + at the far right) is passed on the
  // way without pulling it over.
  const column = useRef<{ key: string | null; span: Span } | null>(null);
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const element = root.current;
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (!active || !element) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    // Back from what covered the page: the focus goes to where it was when that opened.
    const key = activated ? (returnTo ?? remembered.current) : lost && holding.current ? remembered.current : null;
    const item = byKey(element, key) ?? (activated ? byKey(element, remembered.current) : null);
    if (activated) focusItem(item);
    else item?.focus({ preventScroll: true });
  });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onFocus = (event: FocusEvent) => {
      const key = element.contains(event.target as Node) ? keyOf(event.target as Element) : null;
      remembered.current = key ?? remembered.current;
      holding.current = key !== null;
    };
    // A click elsewhere on the page is the user moving on: nothing is given the focus back.
    const onPointer = (event: MouseEvent) => {
      if (!itemOf(event.target as Element)) remembered.current = null;
    };
    document.addEventListener("focusin", onFocus);
    element.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("focusin", onFocus);
      element.removeEventListener("mousedown", onPointer);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const key = navKey(event);
      const element = root.current;
      if (!key || !element) return;
      const target = event.target instanceof Element ? event.target : null;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!onPage && !element.contains(target)) return;
      event.preventDefault();
      // On a card's own button (its ⋯), the card's head is where the arrows start from.
      const card = target?.closest<HTMLElement>("[data-nav-card]")?.querySelector<HTMLElement>("[data-nav]") ?? null;
      const from = itemOf(target) ?? card ?? (onPage ? byKey(element, remembered.current) : null);
      const items = overviewItems(element);
      const at = items.findIndex((item) => item.element === from);
      const run = column.current && at >= 0 && from === target && column.current.key === keyOf(from) ? column.current.span : undefined;
      const next = at < 0 ? gridStart(items) : gridTarget(items, at, key, run);
      if (!next) return;
      focusItem(next.element);
      column.current = at >= 0 && (key === "up" || key === "down") ? { key: keyOf(next.element), span: run ?? items[at]! } : null;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  // Threads outside rooms are shown as rooms of one. Until the service has described them, T3's thread list stands in;
  // it also stands in for any the service left out (it describes forty at most).
  const loose = threads.filter((thread) => !thread.boundToRoom && !thread.deletedAt && !isSubagentThread(thread));
  const standIn: OverviewThread[] = loose
    .filter((thread) => !thread.archivedAt && !thread.settledAt)
    .map((thread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, status: thread.status, pendingRequest: thread.pendingRequest, backgroundLiveness: thread.backgroundLiveness ?? null, latestRunCompletedAt: thread.latestRunCompletedAt, updatedAt: thread.updatedAt, line: null, news: thread.news ?? null }));
  const described = looseThreads ? [...looseThreads, ...standIn.filter((thread) => !looseThreads.some((d) => d.id === thread.id))] : standIn;
  const settledIn = (projectId: string) => loose.filter((t) => t.projectId === projectId && t.settledAt && !t.archivedAt).sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  const archivedIn = (projectId: string) => loose.filter((t) => t.projectId === projectId && t.archivedAt).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const tiles = (projectRooms: RoomListItem[], projectThreads: OverviewThread[]): Tile[] =>
    [
      ...projectRooms.map((room): Tile => ({ kind: "room", room, tier: tierOf(roomState(room, detail.get(room.id))) })),
      ...projectThreads.map((thread): Tile => ({ kind: "thread", thread, tier: tierOf(threadState(thread)) })),
    ].sort((a, b) => a.tier - b.tier);
  const groups = (projects ?? []).map((project) => ({
    project,
    tiles: tiles(
      rooms.filter((room) => room.projectId === project.id),
      described.filter((thread) => thread.projectId === project.id),
    ),
  }));
  const orphans = rooms.filter((room) => !projects?.some((project) => project.id === room.projectId));
  if (orphans.length > 0) groups.push({ project: { id: "unknown", title: "Unknown project", workspaceRoot: "" } as T3Project, tiles: tiles(orphans, []) });

  return (
    <div className="overview" ref={root} inert={!active}>
      <header className="overview-head" ref={head}>
        <span className="brand serif">
          <BrandMark />
          Backroom
        </span>
        <span className="overview-title muted">Run the family</span>
        <button type="button" className="small ghost icon-only overview-new" aria-label="New project" title="New project: add a folder on the T3 machine" disabled={!projects} onClick={() => setDialog({ kind: "project" })} data-nav="ov" data-nav-key="head:project">
          <PlusIcon />
        </button>
        <button type="button" className="small ghost overview-new" title="The order of projects, and of rooms within each" disabled={!projects?.length} onClick={() => setDialog({ kind: "arrange" })} data-nav="ov" data-nav-key="head:arrange">
          Arrange
        </button>
        <span className="spacer" />
        {error ? <span className="status-error mono">{error}</span> : null}
        {controls}
      </header>
      <div className="overview-grid">
        {t3Error ? (
          <p className="muted ov-empty" title={t3Error}>
            T3 is not answering; its projects and threads are not listed.
          </p>
        ) : projects === null ? (
          <p className="muted ov-empty">Loading projects…</p>
        ) : groups.length === 0 ? (
          <p className="muted ov-empty">No projects yet: + in the header adds a folder.</p>
        ) : null}
        {groups.map(({ project, tiles: projectTiles }) => {
          const known = project.id !== "unknown";
          return (
            <section key={project.id} className="ov-project" aria-label={project.title}>
              <h2 className="ov-project-title">
                <span className="ov-project-name">{project.title}</span>
                <span className="ov-project-path mono muted">{project.workspaceRoot}</span>
                <span className="spacer" />
                {known ? (
                  <button
                    type="button"
                    className="small ghost icon-only ov-project-new"
                    aria-label={`New room in ${project.title}`}
                    title={`New room in ${project.title}${consigliere ? `, with ${consigliere.name} seated as its Consigliere` : ""}`}
                    onClick={() => setDialog({ kind: "room", projectId: project.id })}
                    data-nav="ov"
                    data-nav-key={`head:room:${project.id}`}
                  >
                    <PlusIcon />
                  </button>
                ) : null}
              </h2>
              {projectTiles.length === 0 ? <p className="muted ov-empty">Nothing here yet.</p> : null}
              <ProjectTiles>
                {projectTiles.map((tile) =>
                  tile.kind === "room" ? (
                    <RoomCard
                      key={tile.room.id}
                      room={tile.room}
                      detail={detail.get(tile.room.id)}
                      drafted={drafts.has(roomKey(tile.room.id))}
                      presetOver={presetOver === tile.room.id}
                      dropTarget={presetTarget(tile.room.id, (presetId) => void onSeatPreset(tile.room.id, presetId))}
                      onOpen={() => onOpenRoom(tile.room.id)}
                      onCommand={onCommand}
                    />
                  ) : (
                    <ThreadCard key={tile.thread.id} thread={tile.thread} drafted={drafts.has(threadKey(tile.thread.id))} onOpen={() => onOpenThread(tile.thread.id)} />
                  ),
                )}
              </ProjectTiles>
              {known ? <ThreadShelf settled={settledIn(project.id)} archived={archivedIn(project.id)} drafted={(threadId) => drafts.has(threadKey(threadId))} onOpen={onOpenThread} /> : null}
            </section>
          );
        })}
        {projects !== null ? <CrewSection rooms={rooms} projects={projects} onSeat={(roomId, presetId) => void onSeatPreset(roomId, presetId)} runCommand={onCommand} /> : null}
        {browsers ? <BrowsersSection browsers={browsers} onOpen={onOpenBrowser} onChanged={onBrowsersChanged} runCommand={onCommand} /> : null}
      </div>
      {dialog?.kind === "room" ? (
        <NewRoomDialog
          initialProjectId={dialog.projectId}
          onClose={() => setDialog(null)}
          onCreate={async (projectId, title) => {
            const result = await onCommand({ type: "room.create", projectId, title });
            if (result && "roomId" in result && result.roomId) {
              setDialog(null);
              onOpenRoom(result.roomId as string);
              // Backroom wrote the default agents file in the project's folder just now: said once.
              if (result.type === "room.created" && result.agentsFile) toast(agentsFileNote(result.agentsFile), agentsFileTone(result.agentsFile));
            }
          }}
        />
      ) : null}
      {dialog?.kind === "project" ? (
        <NewProjectDialog
          projects={projects ?? []}
          onClose={() => setDialog(null)}
          onCreate={async (input) => {
            const result = await onCommand({ type: "project.create", ...input });
            if (result && result.type === "project.created" && "projectId" in result) {
              setDialog(null);
              onT3Changed();
              setDialog({ kind: "room", projectId: result.projectId as string });
            }
          }}
        />
      ) : null}
      {dialog?.kind === "arrange" && projects ? <ArrangeDialog rooms={rooms} projects={projects} runCommand={onCommand} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

/** What creating a room wrote in its project's folder, in one sentence (src/app/agentsFile.ts; README, The agents file). */
function agentsFileNote(written: AgentsFileWritten): string {
  const files = written.written.join(" and ");
  const them = written.written.length > 1 ? "them" : "it";
  if (written.hook === null) return `Backroom wrote ${files} in ${written.folder} for the agents working there.`;
  const kept = written.excluded ? "kept out of git (.git/info/exclude)" : "not kept out of git: the exclude file could not be written (the service log says why)";
  const copied =
    written.hook === "installed" || written.hook === "ours"
      ? `a git hook copies ${them} into each new worktree`
      : written.hook === "own-hook"
        ? `the repository has a post-checkout hook of its own: add Backroom's copy line to it to have ${them} in new worktrees (README, The agents file)`
        : written.hook === "hooks-path"
          ? `the repository sets core.hooksPath: add Backroom's copy line to its post-checkout hook to have ${them} in new worktrees (README, The agents file)`
          : written.hook === "not-main"
            ? `the project is not its repository's main checkout, so no hook copies ${them} into new worktrees`
            : written.hook === "no-exclude"
              ? `so no hook copies ${them} into new worktrees`
              : `the hook that copies ${them} into new worktrees could not be installed (the service log says why)`;
  return `Backroom wrote ${files} in ${written.folder}, ${kept}; ${copied}.`;
}

/** The note's kind: done, something for the user to add by hand, or something that failed. */
const agentsFileTone = (written: AgentsFileWritten): "success" | "info" | "error" =>
  written.hook === "failed" || written.hook === "no-exclude" ? "error" : written.hook === "own-hook" || written.hook === "hooks-path" || written.hook === "not-main" ? "info" : "success";

/** Stack each column independently, keeping the arranged/ranked order in both the DOM and across columns. */
function ProjectTiles({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const cards = Array.from(grid.children) as HTMLElement[];
    const layout = () => {
      // Keep scrollbars (and thus card widths) stable while the old row placements are cleared.
      const minHeight = grid.style.minHeight;
      grid.style.minHeight = getComputedStyle(grid).height;
      // Clear placements first: old column numbers would create implicit columns after a narrower resize.
      for (const card of cards) {
        card.style.gridColumn = "";
        card.style.gridRow = "";
      }
      const style = getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(" ").length;
      const gap = parseFloat(style.columnGap);
      const heights = cards.map((card) => Math.ceil(card.getBoundingClientRect().height));
      const nextRow = Array<number>(columns).fill(1);
      grid.dataset.stacked = "";
      cards.forEach((card, index) => {
        const column = index % columns;
        const height = Math.max(1, heights[index]!);
        card.style.gridColumn = String(column + 1);
        card.style.gridRow = `${nextRow[column]} / span ${height}`;
        nextRow[column]! += height + gap;
      });
      grid.style.minHeight = minHeight;
    };
    layout();
    // Polls, wrapping text, font loads and viewport changes can all change a card's height.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    });
    observer.observe(grid);
    cards.forEach((card) => observer.observe(card));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [children]);
  return <div className="ov-tiles" ref={ref}>{children}</div>;
}

type Tile = { kind: "room"; room: RoomListItem; tier: number } | { kind: "thread"; thread: OverviewThread; tier: number };

/** What a tile asks of you: how many things need you, how many members are busy, how many replies you have not seen. */
interface TileState {
  needs: number;
  busy: number;
  unseen: number;
}

/** The rank of a tile: 0 needs you, 1 new for you, 2 busy, 3 quiet. */
const tierOf = (state: TileState): number => (state.needs > 0 ? 0 : state.unseen > 0 ? 1 : state.busy > 0 ? 2 : 3);

function roomState(room: RoomListItem, detail: OverviewRoom | undefined): TileState {
  return {
    needs: detail?.needs ?? room.counts.needsYou,
    busy: detail ? detail.members.filter((m) => describeStatus(m.status).motion !== null || m.status.working).length : room.counts.busy + room.counts.working,
    unseen: room.news.unseen,
  };
}

function threadState(thread: OverviewThread): TileState {
  const activity = threadActivity(thread);
  return { needs: activity.tone === "input" ? 1 : 0, busy: activity.tone === "working" || activity.tone === "background" ? 1 : 0, unseen: thread.news ? 1 : 0 };
}

/**
 * A click anywhere on a tile opens it, its members' lines included (they take no pointer events, styles.css): only the
 * tile's own controls (its head, its ⋯ and the menu that opens in place) handle their clicks themselves. The tile does
 * not rely on its head's stretched hit area alone: a press that lands on it and a release that lands on the card make a
 * click on the card, which the head never sees.
 */
const openOnClick = (open: () => void) => (event: ReactMouseEvent<HTMLElement>) => {
  const target = event.target as Element;
  // Not a click inside a dialog the tile's menu opened: portalled, it bubbles here through React only.
  if (!event.currentTarget.contains(target) || target.closest("button, a, input, select, textarea, [role='menu'], .menu")) return;
  open();
};

/** Unsent text kept for the conversation: it is there when you open it. */
const DraftMark = () => (
  <span className="pill pill-draft" title="You have an unsent message here">
    draft
  </span>
);

function RoomCard({
  room,
  detail,
  drafted,
  presetOver,
  dropTarget,
  onOpen,
  onCommand,
}: {
  room: RoomListItem;
  detail: OverviewRoom | undefined;
  drafted: boolean;
  /** A crew member is being dragged over it: dropped, they are seated here. */
  presetOver: boolean;
  dropTarget: { onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void };
  onOpen: () => void;
  onCommand: (command: RoomCommand) => Promise<CommandResult | null>;
}) {
  const { needs, busy } = roomState(room, detail);
  const news = room.news.unseen > 0 ? room.news : null;
  return (
    <article className={`ov-room${needs > 0 ? " needs" : busy > 0 ? " busy" : ""}${presetOver ? " preset-over" : ""}`} {...dropTarget} onClick={openOnClick(onOpen)} data-nav-card>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${room.title}`} data-nav="ov" data-nav-key={`room:${room.id}`} data-where={room.title}>
        <span className="ov-room-title">{room.title}</span>
        {needs > 0 ? <span className="pill pill-input">{needs} need{needs === 1 ? "s" : ""} you</span> : null}
        {busy > 0 ? <span className="pill pill-working">{busy} busy</span> : null}
        {news ? <span className="pill pill-new">{news.unseen} new</span> : null}
        {drafted ? <DraftMark /> : null}
        <span className="spacer" />
        <span className="mono muted">{room.participantCount} member{room.participantCount === 1 ? "" : "s"}</span>
      </button>
      {/* Rename or delete, outside the card's button; above its stretched hit area. */}
      <span className="ov-room-menu">
        <RoomMenu room={room} onCommand={onCommand} />
      </span>
      {detail ? (
        <ul className="ov-members">
          {/* The Consigliere first: what he says is the room's news. */}
          {[...detail.members].sort((a, b) => Number(b.consigliere) - Number(a.consigliere)).map((member) => {
            const described = describeStatus(member.status);
            // A turn's latest line; else the request it is on; else what it last said (also between turns, while its
            // background work runs).
            const line = member.live ?? member.doing ?? member.lastReply?.text ?? "";
            // T3's time of it, or the lower bound when T3 did not time it.
            const when = member.live || member.doing ? "" : age(member.lastReply?.at ?? member.lastReply?.after);
            // Read on the tile, not an item of its own: the arrows pass over it, a click or a hover on it is the tile's
            // (no pointer events, styles.css), and the room's Members has it.
            return (
              <li
                key={member.id}
                className={`ov-member status-${described.tone}${member.consigliere ? " ov-consigliere" : ""}`}
                aria-label={`@${member.alias}${member.consigliere ? ", the Consigliere" : ""}, ${described.label}${line ? `: ${oneLine(line, 160)}` : ""}`}
              >
                <span className="avatar avatar-xs" aria-hidden="true">
                  <MemberMark seed={member.id} selection={member.modelSelection} presetId={member.presetId} name={member.alias} />
                </span>
                <span className="ov-alias mono">
                  {member.alias}
                  {member.consigliere ? <span className="ov-mark" title="The Consigliere: the one you talk to in this room"><StarMark /></span> : null}
                </span>
                <span className={`ov-state mono status-${described.tone}`}>
                  {described.motion ? <span className="dot dot-working" aria-hidden="true" /> : null}
                  {described.label}
                </span>
                <span className="ov-line">{line ? oneLine(line, member.consigliere ? 400 : 160) : <span className="muted">nothing yet</span>}</span>
                {when ? <span className="mono muted ov-when">{when}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted mono ov-loading">reading…</p>
      )}
    </article>
  );
}

/** A thread outside rooms, drawn like a room with one member: its agent, named by the saved crew member it started as, else its model. */
function ThreadCard({ thread, drafted, onOpen }: { thread: OverviewThread; drafted: boolean; onOpen: () => void }) {
  const catalog = useCatalog();
  const activity = threadActivity(thread);
  const crew = threadCrew(thread.id);
  const name = crew?.name ?? catalog?.find((e) => e.instanceId === thread.modelSelection.instanceId && e.model === thread.modelSelection.model)?.label ?? thread.modelSelection.model;
  const working = activity.tone === "working" || activity.tone === "background";
  const when = working ? "" : age(thread.latestRunCompletedAt ?? thread.updatedAt);
  return (
    <article className={`ov-room${activity.tone === "input" ? " needs" : working ? " busy" : ""}`} onClick={openOnClick(onOpen)} data-nav-card>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${thread.title}`} data-nav="ov" data-nav-key={`thread:${thread.id}`} data-where={thread.title}>
        <span className="ov-room-title">{thread.title || "Thread"}</span>
        {activity.tone === "input" ? <span className="pill pill-input">needs you</span> : null}
        {/* Its turn finished (or failed) since you looked. */}
        {thread.news ? <span className={`pill ${thread.news.state === "error" ? "pill-failed" : "pill-new"}`}>{thread.news.state === "error" ? "failed" : "new"}</span> : null}
        {drafted ? <DraftMark /> : null}
        <span className="spacer" />
        <span className="mono muted">1 member</span>
      </button>
      <ul className="ov-members">
        <li className={`ov-member status-${activity.tone}`}>
          <span className="avatar avatar-xs" aria-hidden="true">
            <MemberMark seed={thread.id} selection={thread.modelSelection} presetId={crew?.presetId} />
          </span>
          <span className="ov-alias mono">{name}</span>
          <span className={`ov-state mono status-${activity.tone}`}>
            {working ? <span className="dot dot-working" aria-hidden="true" /> : null}
            {activity.label}
          </span>
          <span className="ov-line">{thread.line ? oneLine(thread.line) : <span className="muted">nothing yet</span>}</span>
          {when ? <span className="mono muted ov-when">{when}</span> : null}
        </li>
      </ul>
    </article>
  );
}

/** The boss in the pixel look: a capybara in a fedora, dark shades and a dark suit, drawn like the crew. */
const BRAND_LOOK = { hat: "fedora", hatColour: "black", band: "black", fur: "sandy", eyes: "dots", glasses: "shades", brows: "none", whiskers: "none", neckwear: "tie", neckwearColour: "black", outfit: "suit", outfitColour: "charcoal", accessory: "none" };

/** The app's mark beside its name: the logo, or in the pixel look the boss as a 16 × 16 sprite at 2×. */
function BrandMark() {
  const [skin] = useSkin();
  if (skin === "pixel") return <LookSprite look={BRAND_LOOK} harness="#ece6d6" className="brand-mark pixel-avatar" size={32} />;
  return <img src="/logo.png" alt="" className="brand-mark" width={22} height={22} />;
}
