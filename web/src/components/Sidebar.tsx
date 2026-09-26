import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import type { BrowserListItem, CommandResult, RoomCommand, RoomListItem, T3Project, T3ThreadShell } from "../types.ts";
import { BrowserFormDialog } from "./BrowserForm.tsx";
import { Dialog } from "./Dialog.tsx";
import { titleMonogram } from "./Monogram.tsx";
import { Popover } from "./Popover.tsx";
import { RoomMenu } from "./RoomActions.tsx";
import { threadActivity } from "./ThreadView.tsx";
import { useToast } from "./Toast.tsx";

/** What the main area shows: a room, a thread used on its own, or a new thread being started in a project. */
export type Selection =
  | { kind: "room"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "new-thread"; projectId: string }
  | { kind: "browser"; id: string };

interface Props {
  rooms: RoomListItem[];
  /** T3's projects; null until the first read (or while T3 cannot be reached). */
  projects: T3Project[] | null;
  /** Every unarchived T3 thread; the ones no room holds are listed under their project. */
  threads: T3ThreadShell[];
  /** Why projects and threads could not be read from T3, if they could not. */
  t3Error: string | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  /** Re-read projects and threads from T3 (after a project was added). */
  onT3Changed: () => void;
  /** The shared browsers on this machine; null when the service cannot run browsers (or before the first read). */
  browsers: BrowserListItem[] | null;
  onBrowsersChanged: () => void;
  /** App-wide controls (roles, the T3 connection, the theme), at the foot of the sidebar. */
  footer?: ReactNode;
  /** Hide the sidebar (desktops), or keep it open when it is shown over the page from the rail; absent on phones. */
  onCollapse?: (() => void) | undefined;

  disabled: boolean;
  /** Phones: the sidebar is an off-canvas drawer; these say whether it is showing and how to dismiss it. */
  open: boolean;
  onClose: () => void;
}

interface Group {
  id: string;
  title: string;
  workspaceRoot: string | null;
  rooms: RoomListItem[];
  /** Threads no room holds, by T3's lifecycle: active, settled (T3's done list), archived (hidden in T3). */
  threads: T3ThreadShell[];
  settled: T3ThreadShell[];
  archived: T3ThreadShell[];
}

type Section = "settled" | "archived";

const COLLAPSED_KEY = "t3rooms.collapsedProjects";
/** The Browsers section folds like a project; its key cannot clash with a project id. */
const BROWSERS_KEY = "__browsers__";
const OPEN_SECTIONS_KEY = "t3rooms.openThreadSections";
const LAST_PROJECT_KEY = "t3rooms.lastProject";
/** Loose threads shown per project before "Show more". */
const THREAD_LIMIT = 5;

const lastActive = (thread: T3ThreadShell): string => thread.latestUserMessageAt ?? thread.updatedAt;

/** "now", "5m", "3h", "2d", "4w": how long ago the thread was last used. */
function shortAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** A window with a side pane: the control that hides and shows the sidebar. */
export function SidebarIcon() {
  return (
    <svg className="sidebar-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6.25 3v10" />
    </svg>
  );
}

/** A room's activity as one dot tone for the rail: needs you, working, background work, or none. */
function roomTone(room: RoomListItem): { tone: "input" | "working" | "background"; label: string } | null {
  if (room.activity && room.activity.needsInput > 0) return { tone: "input", label: `${room.activity.needsInput} needs you` };
  const working = Math.max(room.working, room.activity?.turn ?? 0);
  if (working > 0) return { tone: "working", label: `${working} working` };
  if (room.activity && room.activity.background + room.activity.monitoring > 0) return { tone: "background", label: "background work" };
  return null;
}

/**
 * The collapsed sidebar: a narrow rail that still switches rooms. It shows the expand button, a tile per room
 * (grouped by project, in the sidebar's order, with a dot for what needs you or is working), and the T3 connection
 * at the foot. Threads and browsers are in the full sidebar, one click (or ⌘B) away.
 */
export function SidebarRail({
  rooms,
  projects,
  selection,
  onSelect,
  onExpand,
  connection,
}: {
  rooms: RoomListItem[];
  projects: T3Project[] | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onExpand: () => void;
  connection: ReactNode;
}) {
  const groups = useMemo(() => {
    const order = new Map((projects ?? []).map((p, index) => [p.id, index]));
    const byProject = new Map<string, RoomListItem[]>();
    for (const room of rooms) byProject.set(room.projectId, [...(byProject.get(room.projectId) ?? []), room]);
    return [...byProject.entries()]
      .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
      .map(([projectId, list]) => ({ projectId, title: projects?.find((p) => p.id === projectId)?.title ?? "Unknown project", rooms: list }));
  }, [rooms, projects]);
  return (
    <nav className="sidebar-rail" aria-label="Rooms (sidebar collapsed)">
      <div className="rail-top">
        <button type="button" className="small ghost icon-only sidebar-toggle" aria-label="Show sidebar" title="Show sidebar (⌘B)" onClick={onExpand}>
          <SidebarIcon />
        </button>
      </div>
      <div className="rail-rooms">
        {groups.map((group, index) => (
          <div key={group.projectId} className="rail-group" role="group" aria-label={group.title}>
            {index > 0 ? <span className="rail-sep" aria-hidden="true" /> : null}
            {group.rooms.map((room) => {
              const selected = selection?.kind === "room" && selection.id === room.id;
              const tone = roomTone(room);
              const label = `${room.title} · ${group.title}${tone ? ` · ${tone.label}` : ""}`;
              return (
                <button
                  key={room.id}
                  type="button"
                  className={`rail-room${selected ? " selected" : ""}`}
                  aria-label={label}
                  aria-current={selected ? "true" : undefined}
                  title={label}
                  onClick={() => onSelect({ kind: "room", id: room.id })}
                >
                  <span className="room-mono serif" aria-hidden="true">
                    {titleMonogram(room.title)}
                  </span>
                  {tone ? <span className={`rail-dot rail-dot-${tone.tone}`} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="rail-foot">{connection}</div>
    </nav>
  );
}

export function rememberProject(projectId: string): void {
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
}

export function Sidebar({ rooms, projects, threads, t3Error, selection, onSelect, onCommand, onT3Changed, browsers, onBrowsersChanged, footer, onCollapse, disabled, open, onClose }: Props) {
  const [dialog, setDialog] = useState<{ kind: "room"; projectId: string | null } | { kind: "project" } | { kind: "browser" } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  // Settled and Archived sections under each project, closed until opened ("projectId:settled").
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleSection = (key: string) => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify([...next]));
      return next;
    });
  };
  // Drag to reorder rooms within their project: the order shown while dragging, committed on drop.
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const ordered = order ? order.map((id) => rooms.find((r) => r.id === id)).filter((r): r is RoomListItem => Boolean(r)) : rooms;

  const groups = useMemo<Group[]>(() => {
    const list: Group[] = (projects ?? []).map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot, rooms: [], threads: [], settled: [], archived: [] }));
    const byId = new Map(list.map((g) => [g.id, g]));
    for (const room of ordered) {
      let group = byId.get(room.projectId);
      if (!group) {
        // A room whose project T3 no longer lists (or T3 has not answered yet).
        group = { id: room.projectId, title: projects ? "Unknown project" : "", workspaceRoot: null, rooms: [], threads: [], settled: [], archived: [] };
        byId.set(group.id, group);
        list.push(group);
      }
      group.rooms.push(room);
    }
    for (const thread of threads) {
      const group = byId.get(thread.projectId);
      if (!group || thread.boundToRoom || thread.deletedAt) continue;
      (thread.archivedAt ? group.archived : thread.settledAt ? group.settled : group.threads).push(thread);
    }
    for (const group of list) {
      group.threads.sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
      group.settled.sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
      group.archived.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
    }
    return list;
  }, [projects, ordered, threads]);

  const toggleCollapsed = (projectId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const newThread = (projectId: string | null) => {
    const target = projectId ?? localStorage.getItem(LAST_PROJECT_KEY) ?? projects?.[0]?.id ?? null;
    const known = target && projects?.some((p) => p.id === target) ? target : projects?.[0]?.id;
    if (!known) return;
    rememberProject(known);
    onSelect({ kind: "new-thread", projectId: known });
  };

  const moveOver = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const current = order ?? rooms.map((r) => r.id);
    const dragged = rooms.find((r) => r.id === dragId);
    const target = rooms.find((r) => r.id === targetId);
    if (!dragged || !target || dragged.projectId !== target.projectId) return;
    const from = current.indexOf(dragId);
    const to = current.indexOf(targetId);
    const ids = current.filter((id) => id !== dragId);
    const at = ids.indexOf(targetId);
    ids.splice(from < to ? at + 1 : at, 0, dragId);
    setOrder(ids);
  };
  const finishDrag = async () => {
    const ids = order;
    setDragId(null);
    if (ids && ids.join() !== rooms.map((r) => r.id).join()) await onCommand({ type: "room.reorder", roomIds: ids });
    setOrder(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const nothing = groups.length === 0;

  return (
    <>
      {open ? <div className="sidebar-backdrop mobile-only" onClick={onClose} aria-hidden="true" /> : null}
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Projects, rooms and threads">
        <div className="sidebar-header">
          <span className="brand serif">T3 Rooms</span>
          <span className="sidebar-header-actions">
            <AddMenu
              label="+ New"
              title="Start a thread, create a room, or add a project"
              disabled={disabled}
              items={[
                { label: "New thread", onPick: () => newThread(null), disabled: !projects || projects.length === 0 },
                { label: "New room…", onPick: () => setDialog({ kind: "room", projectId: null }) },
                { label: "New project…", onPick: () => setDialog({ kind: "project" }), disabled: !projects },
              ]}
            />
            {onCollapse ? (
              <button
                type="button"
                className="small ghost icon-only sidebar-toggle"
                aria-label="Hide sidebar"
                title="Hide sidebar (⌘B)"
                onClick={onCollapse}
              >
                <SidebarIcon />
              </button>
            ) : null}
            <button type="button" className="icon-button mobile-only sidebar-close" aria-label="Close sidebar" onClick={onClose}>
              ×
            </button>
          </span>
        </div>
        <ul className="room-list project-list">
          {nothing ? (
            <li className="room-empty">
              <p className="serif muted">{projects === null && !t3Error ? "Loading projects…" : "No projects or rooms yet."}</p>
              {projects !== null ? <p className="mono muted">+ New → New project</p> : null}
            </li>
          ) : null}
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.id);
            const newHere = selection?.kind === "new-thread" && selection.projectId === group.id;
            const expanded = showAll.has(group.id);
            const visibleThreads = group.threads.filter((thread, index) => expanded || index < THREAD_LIMIT || (selection?.kind === "thread" && selection.id === thread.id));
            const hiddenCount = group.threads.length - visibleThreads.length;
            const attention = group.threads.some((t) => threadActivity(t).tone === "input") || group.rooms.some((r) => (r.activity?.needsInput ?? 0) > 0);
            const known = projects?.some((p) => p.id === group.id) ?? false;
            return (
              <li key={group.id} className="project-group">
                <div className="project-head">
                  <button
                    type="button"
                    className="project-toggle"
                    aria-expanded={!isCollapsed}
                    title={group.workspaceRoot ?? `T3 project ${group.id}`}
                    onClick={() => toggleCollapsed(group.id)}
                  >
                    <span className="chevron mono" aria-hidden="true">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span className="project-name">{group.title || "…"}</span>
                    {isCollapsed && group.rooms.length + group.threads.length > 0 ? <span className="project-count mono">{group.rooms.length + group.threads.length}</span> : null}
                    {isCollapsed && attention ? <span className="thread-dot tone-input" title="Something here needs you" /> : null}
                  </button>
                  {known ? (
                    <AddMenu
                      label="+"
                      title={`New thread or room in ${group.title}`}
                      className="project-add"
                      disabled={disabled}
                      items={[
                        { label: "New thread", onPick: () => newThread(group.id) },
                        { label: "New room…", onPick: () => setDialog({ kind: "room", projectId: group.id }) },
                      ]}
                    />
                  ) : null}
                </div>
                {!isCollapsed ? (
                  <ul className="project-items">
                    {group.rooms.map((room) => (
                      <li
                        key={room.id}
                        className={`room-item${dragId === room.id ? " dragging" : ""}`}
                        draggable
                        onDragStart={(event) => {
                          setDragId(room.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", room.id);
                        }}
                        onDragOver={(event) => {
                          if (!dragId) return;
                          event.preventDefault();
                          moveOver(room.id);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          void finishDrag();
                        }}
                        onDragEnd={() => void finishDrag()}
                      >
                        <RoomTile room={room} selected={selection?.kind === "room" && selection.id === room.id} onSelect={() => onSelect({ kind: "room", id: room.id })} />
                        <RoomMenu room={room} onCommand={onCommand} />
                      </li>
                    ))}
                    {newHere ? (
                      <li className="side-thread">
                        <button type="button" className="side-thread-tile selected new-thread-tile" aria-current="true">
                          <span className="thread-dot tone-idle" aria-hidden="true" />
                          <span className="thread-title">New thread</span>
                        </button>
                      </li>
                    ) : null}
                    {visibleThreads.map((thread) => (
                      <ThreadTile key={thread.id} thread={thread} selected={selection?.kind === "thread" && selection.id === thread.id} onSelect={() => onSelect({ kind: "thread", id: thread.id })} />
                    ))}
                    {hiddenCount > 0 || expanded ? (
                      <li>
                        <button
                          type="button"
                          className="status-toggle mono thread-more"
                          onClick={() =>
                            setShowAll((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          {expanded ? "show fewer" : `show ${hiddenCount} more`}
                        </button>
                      </li>
                    ) : null}
                    {(["settled", "archived"] as const).map((section) => (
                      <ThreadSection
                        key={section}
                        section={section}
                        threads={group[section]}
                        // A section holding the open thread stays open.
                        open={openSections.has(`${group.id}:${section}`) || group[section].some((t) => selection?.kind === "thread" && selection.id === t.id)}
                        onToggle={() => toggleSection(`${group.id}:${section}`)}
                        selectedId={selection?.kind === "thread" ? selection.id : null}
                        onSelect={(id) => onSelect({ kind: "thread", id })}
                      />
                    ))}
                    {group.rooms.length === 0 && group.threads.length + group.settled.length + group.archived.length === 0 && !newHere ? (
                      <li className="project-empty muted">No rooms or threads</li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {browsers ? (
            <li className="project-group browsers-group">
              <div className="project-head">
                <button type="button" className="project-toggle" aria-expanded={!collapsed.has(BROWSERS_KEY)} onClick={() => toggleCollapsed(BROWSERS_KEY)} title="Shared Chrome browsers on this machine, for agents">
                  <span className="chevron mono" aria-hidden="true">
                    {collapsed.has(BROWSERS_KEY) ? "▸" : "▾"}
                  </span>
                  <span className="project-name">Browsers</span>
                  {collapsed.has(BROWSERS_KEY) ? <span className="project-count mono">{browsers.length}</span> : null}
                </button>
                <button type="button" className="small ghost project-add" aria-label="New browser" title="New browser" disabled={disabled} onClick={() => setDialog({ kind: "browser" })}>
                  +
                </button>
              </div>
              {!collapsed.has(BROWSERS_KEY) ? (
                <ul className="project-items">
                  {browsers.map((browser) => {
                    const selected = selection?.kind === "browser" && selection.id === browser.id;
                    const state = browser.status.state;
                    return (
                      <li key={browser.id} className="side-thread">
                        <button
                          type="button"
                          className={`side-thread-tile side-browser-tile${selected ? " selected" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          title={`${browser.name}${browser.description ? `\n${browser.description}` : ""}`}
                          onClick={() => onSelect({ kind: "browser", id: browser.id })}
                        >
                          <span className={`thread-dot tone-${state === "running" ? "on" : state === "starting" ? "working" : state === "error" ? "error" : "idle"}`} aria-hidden="true" />
                          <span className="thread-title mono">{browser.name}</span>
                          <span className="side-thread-age mono">
                            {state === "running" ? `${browser.status.tabs.length} tab${browser.status.tabs.length === 1 ? "" : "s"}` : state === "error" ? "failed" : "off"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
        {t3Error ? (
          <p className="sidebar-note muted" title={t3Error}>
            T3 is not answering; its projects and threads are not listed.
          </p>
        ) : null}
        {footer ? <div className="sidebar-footer">{footer}</div> : null}
        {dialog?.kind === "room" ? (
          <NewRoomDialog
            initialProjectId={dialog.projectId}
            onClose={() => setDialog(null)}
            onCreate={async (projectId, title) => {
              const result = await onCommand({ type: "room.create", projectId, title });
              if (result && "roomId" in result && result.roomId) {
                setDialog(null);
                onSelect({ kind: "room", id: result.roomId as string });
              }
            }}
          />
        ) : null}
        {dialog?.kind === "browser" ? (
          <BrowserFormDialog
            title="New browser"
            submitLabel="Create browser"
            onClose={() => setDialog(null)}
            onSubmit={async (values) => {
              const result = await onCommand({ type: "browser.create", ...values });
              if (result && result.type === "browser.created" && "browserId" in result) {
                setDialog(null);
                onBrowsersChanged();
                onSelect({ kind: "browser", id: result.browserId as string });
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
                onSelect({ kind: "new-thread", projectId: result.projectId as string });
              }
            }}
          />
        ) : null}
      </aside>
    </>
  );
}

function RoomTile({ room, selected, onSelect }: { room: RoomListItem; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`room-tile${selected ? " selected" : ""}`} onClick={onSelect} aria-current={selected ? "true" : undefined}>
      <span className="room-mono serif" aria-hidden="true">
        {titleMonogram(room.title)}
      </span>
      <span className="tile-body">
        <span className="room-title">{room.title}</span>
        <span className="room-meta mono">
          <span title="Participants">{room.participantCount} crew</span>
          {room.activity && room.activity.needsInput > 0 ? (
            <span className="pill pill-input" title="Waiting for your approval or answer">
              {room.activity.needsInput} needs you
            </span>
          ) : null}
          {room.working > 0 || (room.activity?.turn ?? 0) > 0 ? (
            <span className="pill pill-working" title="Mid-turn (room tasks or typed in T3)">
              {Math.max(room.working, room.activity?.turn ?? 0)} working
            </span>
          ) : null}
          {room.activity && room.activity.background > 0 ? (
            <span className="pill pill-background" title="Between turns, with subagents or background jobs running: not done yet">
              {room.activity.background} background
            </span>
          ) : null}
          {room.activity && room.activity.monitoring > 0 ? (
            <span className="pill pill-background" title="Only watch loops running">
              {room.activity.monitoring} monitoring
            </span>
          ) : null}
          {room.waiting > 0 ? (
            <span className="pill pill-waiting" title="Waiting">
              {room.waiting} waiting
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** "Settled · 3" / "Archived · 1" under a project: a toggle, and the threads when open. Nothing when empty. */
function ThreadSection({
  section,
  threads,
  open,
  onToggle,
  selectedId,
  onSelect,
}: {
  section: Section;
  threads: T3ThreadShell[];
  open: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (threadId: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <>
      <li>
        <button
          type="button"
          className="thread-section-toggle mono"
          aria-expanded={open}
          onClick={onToggle}
          title={section === "settled" ? "Threads in T3's settled list: done for now. Sending one a message makes it active again." : "Threads archived in T3: hidden there, reversible. Open one to unarchive or delete it."}
        >
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {section === "settled" ? "Settled" : "Archived"} · {threads.length}
        </button>
      </li>
      {open ? threads.map((thread) => <ThreadTile key={thread.id} thread={thread} selected={selectedId === thread.id} onSelect={() => onSelect(thread.id)} />) : null}
    </>
  );
}

function ThreadTile({ thread, selected, onSelect }: { thread: T3ThreadShell; selected: boolean; onSelect: () => void }) {
  const activity = threadActivity(thread);
  const state = thread.archivedAt ? "archived" : thread.settledAt ? "settled" : null;
  // Settled and archived threads show when they got there; active ones when they were last used.
  const age = shortAge(thread.archivedAt ?? thread.settledAt ?? lastActive(thread));
  return (
    <li className="side-thread">
      <button
        type="button"
        className={`side-thread-tile${selected ? " selected" : ""}${state ? ` ${state}` : ""}`}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={`${thread.title}\n${thread.modelSelection.model} · ${state ?? activity.label}`}
      >
        <span className={`thread-dot tone-${state ? "idle" : activity.tone}`} aria-hidden="true" />
        <span className="thread-title">{thread.title}</span>
        {activity.tone === "input" && !state ? <span className="pill pill-input">needs you</span> : <span className="side-thread-age mono">{age}</span>}
      </button>
    </li>
  );
}

/** A small button opening a menu of actions (rendered at the body so the scrolling sidebar cannot clip it). */
function AddMenu({
  label,
  title,
  className,
  disabled,
  items,
}: {
  label: string;
  title: string;
  className?: string;
  disabled: boolean;
  items: Array<{ label: string; onPick: () => void; disabled?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`small ghost${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="menu" onClose={() => setOpen(false)}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onPick();
              }}
            >
              {item.label}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

function NewRoomDialog({
  initialProjectId,
  onClose,
  onCreate,
}: {
  initialProjectId: string | null;
  onClose: () => void;
  onCreate: (projectId: string, title: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const first = list.find((p) => p.id === initialProjectId) ?? list[0];
        if (first) {
          setProjectId(first.id);
          setTitle((t) => t || first.title);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProjects([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toast, initialProjectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !title.trim()) return;
    setBusy(true);
    try {
      await onCreate(projectId, title.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New room" onClose={onClose}>
      <form onSubmit={submit} className="form" id="new-room-form">
        <label>
          T3 project
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              const project = projects?.find((p) => p.id === event.target.value);
              if (project && !title) setTitle(project.title);
            }}
            disabled={!projects}
          >
            {!projects ? <option value="">Loading projects…</option> : null}
            {projects && projects.length === 0 ? <option value="">No projects available</option> : null}
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title} — {project.workspaceRoot}
              </option>
            ))}
          </select>
        </label>
        <label>
          Room title
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required data-autofocus />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !projectId || !title.trim()}>
            Create room
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The folder most existing projects sit in ("/home/me/Projects"), as a starting point for a new one. */
function commonParent(projects: T3Project[]): string | null {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const parent = project.workspaceRoot.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function NewProjectDialog({
  projects,
  onClose,
  onCreate,
}: {
  projects: T3Project[];
  onClose: () => void;
  onCreate: (input: { workspaceRoot: string; title?: string; createIfMissing: boolean }) => Promise<void>;
}) {
  const parent = useMemo(() => commonParent(projects), [projects]);
  const [path, setPath] = useState(parent ? `${parent}/` : "");
  const [title, setTitle] = useState("");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const folderName = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const ready = /^(~|\/|[A-Za-z]:[\\/])/.test(path.trim()) && folderName.length > 0 && !path.trim().endsWith("/");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await onCreate({ workspaceRoot: path.trim(), ...(title.trim() ? { title: title.trim() } : {}), createIfMissing: create });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="muted">Adds a project to T3 Code for a folder on the machine T3 runs on. Rooms and threads in it work in that folder.</p>
        <label>
          Folder
          <input type="text" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/Projects/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-autofocus />
          <span className="hint">The full path on the T3 machine; ~ works.</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
          Create the folder if it does not exist
        </label>
        <label>
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={folderName || "folder name"} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            Add project
          </button>
        </div>
      </form>
    </Dialog>
  );
}
