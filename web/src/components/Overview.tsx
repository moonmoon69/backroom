import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import type { CommandResult, RoomCommand } from "../types.ts";
import { NewProjectDialog, NewRoomDialog, rememberProject } from "./Sidebar.tsx";
import { RoomMenu } from "./RoomActions.tsx";
import { PlusIcon } from "./icons.tsx";
import { describeStatus } from "../memberActivity.ts";
import type { OverviewRoom, OverviewThread, RoomListItem, T3Project, T3ThreadShell } from "../types.ts";
import { ModelIcon } from "./ProviderIcon.tsx";
import { threadActivity, threadCrew } from "./ThreadView.tsx";
import { useCatalog } from "./catalog.ts";

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
 * Look → Overview: the whole of Backroom on one page. One card per project; inside it every room, and under each
 * room its members with a status dot and one line of what each is doing now (a turn's latest note or the tools
 * running) or last said. Loose threads of the project follow as a short list. Click a room or thread to open it.
 * "+ New room" on a project is the one way to add: a new room opens with the Consigliere seated.
 *
 * Inside a project the tiles are ranked by what they ask of you: needs you first (an approval, a question, a failure
 * nobody followed up), then new for you (a reply you have not seen), then busy, then the rest. Inside a tier they keep
 * the sidebar's order, so a tile moves only when its tier changes: forward when it wants you, back once you looked.
 */
export function Overview({
  rooms,
  projects,
  threads,
  onOpenRoom,
  onOpenThread,
  onCommand,
  onT3Changed,
  controls,
}: {
  rooms: RoomListItem[];
  projects: T3Project[] | null;
  threads: T3ThreadShell[];
  onOpenRoom: (roomId: string) => void;
  onOpenThread: (threadId: string) => void;
  onCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  /** Re-read projects from T3 (after one was added). */
  onT3Changed: () => void;
  /** The app-wide controls (connection, updates, settings) for the page's header. */
  controls: ReactNode;
}) {
  const [dialog, setDialog] = useState<{ kind: "room"; projectId: string | null } | { kind: "project" } | null>(null);
  const [detail, setDetail] = useState<Map<string, OverviewRoom>>(new Map());
  const [looseThreads, setLooseThreads] = useState<OverviewThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // Threads outside rooms are shown as rooms of one. Until the service has described them, the sidebar's list stands in.
  const standIn: OverviewThread[] = threads
    .filter((thread) => !thread.boundToRoom && !thread.archivedAt && !thread.settledAt && !thread.deletedAt && thread.lineage?.relationshipToParent !== "subagent")
    .map((thread) => ({ id: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, status: thread.status, pendingRequest: thread.pendingRequest, backgroundLiveness: thread.backgroundLiveness ?? null, latestRunCompletedAt: thread.latestRunCompletedAt, updatedAt: thread.updatedAt, line: null, news: thread.news ?? null }));
  const described = looseThreads ?? standIn;
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
    <div className="overview">
      <header className="overview-head">
        <span className="brand serif">
          <img src="/logo.png" alt="" className="brand-mark" width={22} height={22} />
          Backroom
        </span>
        <span className="overview-title muted">Run the family</span>
        <button type="button" className="small ghost overview-new" title="Add a project: a folder on the T3 machine" disabled={!projects} onClick={() => setDialog({ kind: "project" })}>
          <PlusIcon />
          New project
        </button>
        <span className="spacer" />
        {error ? <span className="status-error mono">{error}</span> : null}
        {controls}
      </header>
      <div className="overview-grid">
        {groups.map(({ project, tiles: projectTiles }) => (
          <section key={project.id} className="ov-project" aria-label={project.title}>
            <h2 className="ov-project-title">
              {project.title}
              <span className="ov-project-path mono muted">{project.workspaceRoot}</span>
              <span className="spacer" />
              {project.id !== "unknown" ? (
                <button type="button" className="small ghost ov-project-new" title={`A new room in ${project.title}, with the Consigliere seated`} onClick={() => setDialog({ kind: "room", projectId: project.id })}>
                  <PlusIcon />
                  New room
                </button>
              ) : null}
            </h2>
            {projectTiles.length === 0 ? <p className="muted ov-empty">Nothing here yet.</p> : null}
            <div className="ov-tiles">
              {projectTiles.map((tile) =>
                tile.kind === "room" ? (
                  <RoomCard key={tile.room.id} room={tile.room} detail={detail.get(tile.room.id)} onOpen={() => onOpenRoom(tile.room.id)} onCommand={onCommand} />
                ) : (
                  <ThreadCard key={tile.thread.id} thread={tile.thread} onOpen={() => onOpenThread(tile.thread.id)} />
                ),
              )}
            </div>
          </section>
        ))}
      </div>
      {dialog?.kind === "room" ? (
        <NewRoomDialog
          initialProjectId={dialog.projectId}
          onClose={() => setDialog(null)}
          onCreate={async (projectId, title) => {
            const result = await onCommand({ type: "room.create", projectId, title });
            if (result && "roomId" in result && result.roomId) {
              setDialog(null);
              rememberProject(projectId);
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
              rememberProject(result.projectId as string);
              setDialog({ kind: "room", projectId: result.projectId as string });
            }
          }}
        />
      ) : null}
    </div>
  );
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
    needs: detail?.needs ?? room.activity?.needsInput ?? 0,
    busy: detail ? detail.members.filter((m) => describeStatus(m.status).motion !== null).length : Math.max(room.working, room.activity?.turn ?? 0) + (room.activity?.background ?? 0),
    unseen: room.news?.unseen ?? 0,
  };
}

function threadState(thread: OverviewThread): TileState {
  const activity = threadActivity(thread);
  return { needs: activity.tone === "input" ? 1 : 0, busy: activity.tone === "working" || activity.tone === "background" ? 1 : 0, unseen: thread.news ? 1 : 0 };
}

function RoomCard({ room, detail, onOpen, onCommand }: { room: RoomListItem; detail: OverviewRoom | undefined; onOpen: () => void; onCommand: (command: RoomCommand) => Promise<CommandResult | null> }) {
  const { needs, busy } = roomState(room, detail);
  const news = room.news && room.news.unseen > 0 ? room.news : null;
  return (
    <article className={`ov-room${needs > 0 ? " needs" : busy > 0 ? " busy" : ""}`}>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${room.title}`}>
        <span className="ov-room-title">{room.title}</span>
        {needs > 0 ? <span className="pill pill-input">{needs} need{needs === 1 ? "s" : ""} you</span> : null}
        {busy > 0 ? <span className="pill pill-working">{busy} busy</span> : null}
        {news ? <span className="pill pill-new">{news.unseen} new</span> : null}
        <span className="spacer" />
        <span className="mono muted">{room.participantCount} member{room.participantCount === 1 ? "" : "s"}</span>
      </button>
      {/* Rename or delete, outside the card's button; above its stretched hit area. */}
      <span className="ov-room-menu">
        <RoomMenu room={room} onCommand={onCommand} />
      </span>
      {detail ? (
        <ul className="ov-members">
          {detail.members.map((member) => {
            const described = describeStatus(member.status);
            // A turn's latest line; else the task it is on; else what it last said (also between turns, while its
            // background work runs).
            const line = member.live ?? member.doing ?? member.lastReply?.text ?? "";
            const when = member.live || member.doing ? "" : age(member.lastReply?.at);
            return (
              <li key={member.id} className={`ov-member status-${described.tone}`} title={line ? oneLine(line, 400) : described.label}>
                <span className="avatar avatar-xs" aria-hidden="true">
                  <ModelIcon selection={member.modelSelection} size={14} />
                </span>
                <span className="ov-alias mono">
                  {member.alias}
                  {member.consigliere ? <span className="ov-mark" title="The Consigliere: the one you talk to in this room">★</span> : null}
                </span>
                <span className={`ov-state mono status-${described.tone}`}>
                  {described.motion ? <span className="dot dot-working" aria-hidden="true" /> : null}
                  {described.label}
                </span>
                <span className="ov-line">{line ? oneLine(line) : <span className="muted">nothing yet</span>}</span>
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
function ThreadCard({ thread, onOpen }: { thread: OverviewThread; onOpen: () => void }) {
  const catalog = useCatalog();
  const activity = threadActivity(thread);
  const crew = threadCrew(thread.id);
  const name = crew?.name ?? catalog?.find((e) => e.instanceId === thread.modelSelection.instanceId && e.model === thread.modelSelection.model)?.label ?? thread.modelSelection.model;
  const working = activity.tone === "working" || activity.tone === "background";
  const when = working ? "" : age(thread.latestRunCompletedAt ?? thread.updatedAt);
  return (
    <article className={`ov-room${activity.tone === "input" ? " needs" : working ? " busy" : ""}`}>
      <button type="button" className="ov-room-head" onClick={onOpen} title={`Open ${thread.title}`}>
        <span className="ov-room-title">{thread.title || "Thread"}</span>
        {activity.tone === "input" ? <span className="pill pill-input">needs you</span> : null}
        <span className="spacer" />
        <span className="mono muted">1 member</span>
      </button>
      <ul className="ov-members">
        <li className={`ov-member status-${activity.tone}`} title={thread.line ? oneLine(thread.line, 400) : activity.label}>
          <span className="avatar avatar-xs" aria-hidden="true">
            <ModelIcon selection={thread.modelSelection} size={14} />
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
