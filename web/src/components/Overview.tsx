import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
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
import type { OverviewRoom, OverviewThread, RoomListItem, T3Project, T3ThreadShell } from "../types.ts";
import { LookSprite, MemberMark } from "./MemberMark.tsx";
import { threadActivity, threadCrew } from "./ThreadView.tsx";
import { useCatalog } from "./catalog.ts";
import { byKey, focusItem, itemOf, keyOf, navKey, overviewTarget } from "../keys.ts";

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
  onOpenMember,
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
  /** A member's thread, over its room (Enter on a member). */
  onOpenMember: (roomId: string, participantId: string) => void;
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

  // ---- the keys (keys.ts): the arrows move the focus over the page's cards and members, in reading order ----
  const root = useRef<HTMLDivElement>(null);
  // The item last focused here, by key. A poll that redraws the page can move a card (to another tier, another project),
  // and the browser drops the focus of what it moves: the same item takes it back before the frame is painted.
  const remembered = useRef<string | null>(null);
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const element = root.current;
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (!active || !element) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    // Back from what covered the page: the focus goes to where it was when that opened.
    const key = activated ? (returnTo ?? remembered.current) : lost ? remembered.current : null;
    const item = byKey(element, key);
    if (activated) focusItem(item);
    else item?.focus({ preventScroll: true });
  });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onFocus = (event: FocusEvent) => {
      remembered.current = keyOf(event.target as Element) ?? remembered.current;
    };
    // A click elsewhere on the page is the user moving on: nothing is given the focus back.
    const onPointer = (event: MouseEvent) => {
      if (!itemOf(event.target as Element)) remembered.current = null;
    };
    element.addEventListener("focusin", onFocus);
    element.addEventListener("mousedown", onPointer);
    return () => {
      element.removeEventListener("focusin", onFocus);
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
      focusItem(overviewTarget(element, "ov", itemOf(target) ?? (onPage ? byKey(element, remembered.current) : null), key));
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
      <header className="overview-head">
        <span className="brand serif">
          <BrandMark />
          Backroom
        </span>
        <span className="overview-title muted">Run the family</span>
        <button type="button" className="small ghost icon-only overview-new" aria-label="New project" title="New project: add a folder on the T3 machine" disabled={!projects} onClick={() => setDialog({ kind: "project" })}>
          <PlusIcon />
        </button>
        <button type="button" className="small ghost overview-new" title="The order of projects, and of rooms within each" disabled={!projects?.length} onClick={() => setDialog({ kind: "arrange" })}>
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
            <section key={project.id} className="ov-project" aria-label={project.title} data-nav-section>
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
                      onOpenMember={(participantId) => onOpenMember(tile.room.id, participantId)}
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
  onOpenMember,
  onCommand,
}: {
  room: RoomListItem;
  detail: OverviewRoom | undefined;
  drafted: boolean;
  /** A crew member is being dragged over it: dropped, they are seated here. */
  presetOver: boolean;
  dropTarget: { onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void };
  onOpen: () => void;
  onOpenMember: (participantId: string) => void;
  onCommand: (command: RoomCommand) => Promise<CommandResult | null>;
}) {
  const { needs, busy } = roomState(room, detail);
  const news = room.news.unseen > 0 ? room.news : null;
  return (
    <article className={`ov-room${needs > 0 ? " needs" : busy > 0 ? " busy" : ""}${presetOver ? " preset-over" : ""}`} {...dropTarget} data-nav-card>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${room.title}`} data-nav="ov" data-nav-key={`room:${room.id}`}>
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
            // Reached with the arrows (keys.ts); Enter opens the member's thread over its room.
            const open = (event: KeyboardEvent) => {
              if (event.key !== "Enter" || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              onOpenMember(member.id);
            };
            return (
              <li
                key={member.id}
                className={`ov-member status-${described.tone}${member.consigliere ? " ov-consigliere" : ""}`}
                title={line ? oneLine(line, 400) : described.label}
                tabIndex={-1}
                data-nav="ov"
                data-nav-key={`member:${room.id}:${member.id}`}
                aria-label={`@${member.alias}${member.consigliere ? ", the Consigliere" : ""}, ${described.label}${line ? `: ${oneLine(line, 160)}` : ""}`}
                aria-description="Enter opens its thread"
                onKeyDown={open}
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
    <article className={`ov-room${activity.tone === "input" ? " needs" : working ? " busy" : ""}`} data-nav-card>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${thread.title}`} data-nav="ov" data-nav-key={`thread:${thread.id}`}>
        <span className="ov-room-title">{thread.title || "Thread"}</span>
        {activity.tone === "input" ? <span className="pill pill-input">needs you</span> : null}
        {/* Its turn finished (or failed) since you looked. */}
        {thread.news ? <span className={`pill ${thread.news.state === "error" ? "pill-failed" : "pill-new"}`}>{thread.news.state === "error" ? "failed" : "new"}</span> : null}
        {drafted ? <DraftMark /> : null}
        <span className="spacer" />
        <span className="mono muted">1 member</span>
      </button>
      <ul className="ov-members">
        <li className={`ov-member status-${activity.tone}`} title={thread.line ? oneLine(thread.line, 400) : activity.label}>
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
