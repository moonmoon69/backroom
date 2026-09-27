import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import type { BrowserListItem, CommandResult, FolderListing, Preset, RoomCommand, RoomListItem, RoomNews, T3Project, T3ThreadShell } from "../types.ts";
import { describeRoomNews } from "../news.ts";
import { BrowserFormDialog } from "./BrowserForm.tsx";
import { Dialog } from "./Dialog.tsx";
import { titleMonogram } from "./Monogram.tsx";
import { Popover } from "./Popover.tsx";
import { RoomMenu } from "./RoomActions.tsx";
import { threadActivity } from "./ThreadView.tsx";
import { useToast } from "./Toast.tsx";
import { ChevronIcon, CloseIcon, FolderIcon, MoreIcon, PlusIcon, SidebarIcon, UpFolderIcon } from "./icons.tsx";
import { carriesPreset, droppedPresetId, PresetDialog, PresetIcon, startPresetDrag, usePresets, usePresetText } from "./presets.tsx";

/** What the main area shows: a room, a thread used on its own, or a new thread being started in a project. */
export type Selection =
  | { kind: "room"; id: string }
  | { kind: "thread"; id: string }
  /** With a preset, the new thread's settings start from it. */
  | { kind: "new-thread"; projectId: string; presetId?: string }
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
  /** Seat a preset in a room on a new thread (a preset dropped on the room, or picked from the preset's menu). */
  onSeatPreset: (roomId: string, presetId: string) => Promise<void>;
  /** Re-read projects and threads from T3 (after a project was added). */
  onT3Changed: () => void;
  /** The shared browsers on this machine; null when the service cannot run browsers (or before the first read). */
  browsers: BrowserListItem[] | null;
  onBrowsersChanged: () => void;
  /** Leave the "New thread" page without starting one (its row in the list offers it). */
  onCancelNewThread?: (() => void) | undefined;
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

const COLLAPSED_KEY = "backroom.collapsedProjects";
/** The Browsers section folds like a project; its key cannot clash with a project id. */
const BROWSERS_KEY = "__browsers__";
const PRESETS_KEY = "__presets__";
const OPEN_SECTIONS_KEY = "backroom.openThreadSections";
const LAST_PROJECT_KEY = "backroom.lastProject";
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

/** A room's activity as one dot tone for the rail: needs you, working, background work, or none. */
function roomTone(room: RoomListItem): { tone: "input" | "new" | "working" | "background"; label: string } | null {
  if (room.activity && room.activity.needsInput > 0) return { tone: "input", label: `${room.activity.needsInput} needs you` };
  if (room.news && room.news.unseen > 0) return { tone: "new", label: newsLabel(room.news) };
  const working = Math.max(room.working, room.activity?.turn ?? 0);
  if (working > 0) return { tone: "working", label: `${working} working` };
  if (room.activity && room.activity.background + room.activity.monitoring > 0) return { tone: "background", label: "background work" };
  return null;
}

/** A room's news for a hover: "2 new: @sol1 replied: Fixed the parser…". */
function newsLabel(news: RoomNews): string {
  const latest = news.latest;
  const preview = latest?.preview.replace(/\s+/g, " ").trim() ?? "";
  const what = latest ? `${describeRoomNews(latest)}${preview ? `: ${preview.length > 120 ? `${preview.slice(0, 117)}…` : preview}` : ""}` : "";
  return `${news.unseen} new since you looked${what ? `. Latest: ${what}` : ""}`;
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
                  {tone?.tone === "new" && room.news ? (
                    <NewsCount news={room.news} />
                  ) : tone ? (
                    <span className={`rail-dot rail-dot-${tone.tone}`} aria-hidden="true" />
                  ) : null}
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

export function Sidebar({ rooms, projects, threads, t3Error, selection, onSelect, onCommand, onSeatPreset, onT3Changed, browsers, onBrowsersChanged, onCancelNewThread, footer, onCollapse, disabled, open, onClose }: Props) {
  const [dialog, setDialog] = useState<{ kind: "room"; projectId: string | null } | { kind: "project" } | { kind: "browser" } | { kind: "preset"; preset: Preset | null } | null>(null);
  const { presets } = usePresets();
  const presetText = usePresetText();
  // Where a dragged preset would land: a room (it is seated there) or a project (a thread starts there).
  const [presetOver, setPresetOver] = useState<string | null>(null);
  const openRoom = selection?.kind === "room" ? (rooms.find((r) => r.id === selection.id) ?? null) : null;
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

  const newThread = (projectId: string | null, presetId?: string) => {
    // Without a project named: the open room's or the open new thread's, else the last one used.
    const here = selection?.kind === "new-thread" ? selection.projectId : (openRoom?.projectId ?? null);
    const target = projectId ?? here ?? localStorage.getItem(LAST_PROJECT_KEY) ?? projects?.[0]?.id ?? null;
    const known = target && projects?.some((p) => p.id === target) ? target : projects?.[0]?.id;
    if (!known) return;
    rememberProject(known);
    onSelect({ kind: "new-thread", projectId: known, ...(presetId ? { presetId } : {}) });
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
          <span className="brand serif">
            <img src="/logo.png" alt="" className="brand-mark" width={22} height={22} />
            Backroom
          </span>
          <span className="sidebar-header-actions">
            <AddMenu
              label={
                <>
                  <PlusIcon />
                  New
                </>
              }
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
            <button type="button" className="small ghost icon-only mobile-only sidebar-close" aria-label="Close sidebar" title="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </span>
        </div>
        <ul className="room-list project-list">
          {nothing ? (
            <li className="room-empty">
              <p className="serif muted">{projects === null && !t3Error ? "Loading projects…" : "No projects or rooms yet."}</p>
              {projects !== null ? <p className="mono muted">New → New project</p> : null}
            </li>
          ) : null}
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.id);
            const newHere = selection?.kind === "new-thread" && selection.projectId === group.id;
            const expanded = showAll.has(group.id);
            // A thread that finished since you looked is never behind "show more".
            const visibleThreads = group.threads.filter((thread, index) => expanded || index < THREAD_LIMIT || Boolean(thread.news) || (selection?.kind === "thread" && selection.id === thread.id));
            const hiddenCount = group.threads.length - visibleThreads.length;
            const attention = group.threads.some((t) => threadActivity(t).tone === "input") || group.rooms.some((r) => (r.activity?.needsInput ?? 0) > 0);
            const fresh = group.threads.some((t) => t.news) || group.rooms.some((r) => (r.news?.unseen ?? 0) > 0);
            const known = projects?.some((p) => p.id === group.id) ?? false;
            return (
              <li key={group.id} className="project-group">
                <div
                  className={`project-head${presetOver === `project:${group.id}` ? " preset-over" : ""}`}
                  onDragOver={(event) => {
                    if (!known || !carriesPreset(event)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setPresetOver(`project:${group.id}`);
                  }}
                  onDragLeave={() => setPresetOver((current) => (current === `project:${group.id}` ? null : current))}
                  onDrop={(event) => {
                    const presetId = droppedPresetId(event);
                    setPresetOver(null);
                    if (!known || !presetId) return;
                    event.preventDefault();
                    newThread(group.id, presetId);
                  }}
                >
                  <button
                    type="button"
                    className="project-toggle"
                    aria-expanded={!isCollapsed}
                    title={group.workspaceRoot ?? `T3 project ${group.id}`}
                    onClick={() => toggleCollapsed(group.id)}
                  >
                    <ChevronIcon dir={isCollapsed ? "right" : "down"} />
                    <span className="project-name">{group.title || "…"}</span>
                    {isCollapsed && group.rooms.length + group.threads.length > 0 ? <span className="project-count mono">{group.rooms.length + group.threads.length}</span> : null}
                    {isCollapsed && attention ? (
                      <span className="thread-dot tone-input" title="Something here needs you" />
                    ) : isCollapsed && fresh ? (
                      <span className="thread-dot tone-new" title="Something here finished since you looked" />
                    ) : null}
                  </button>
                  {known ? (
                    <AddMenu
                      label={<PlusIcon />}
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
                        className={`room-item${dragId === room.id ? " dragging" : ""}${presetOver === room.id ? " preset-over" : ""}`}
                        draggable
                        onDragStart={(event) => {
                          setDragId(room.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", room.id);
                        }}
                        onDragOver={(event) => {
                          if (carriesPreset(event)) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "copy";
                            setPresetOver(room.id);
                            return;
                          }
                          if (!dragId) return;
                          event.preventDefault();
                          moveOver(room.id);
                        }}
                        onDragLeave={() => setPresetOver((current) => (current === room.id ? null : current))}
                        onDrop={(event) => {
                          event.preventDefault();
                          const presetId = droppedPresetId(event);
                          if (presetId) {
                            setPresetOver(null);
                            void onSeatPreset(room.id, presetId);
                            return;
                          }
                          void finishDrag();
                        }}
                        onDragEnd={() => void finishDrag()}
                      >
                        <RoomTile room={room} selected={selection?.kind === "room" && selection.id === room.id} onSelect={() => onSelect({ kind: "room", id: room.id })} />
                        <RoomMenu room={room} onCommand={onCommand} />
                      </li>
                    ))}
                    {newHere ? (
                      <li className="side-thread new-thread-item">
                        <button type="button" className="side-thread-tile selected new-thread-tile" aria-current="true">
                          <span className="thread-dot tone-idle" aria-hidden="true" />
                          <span className="thread-title">New thread</span>
                        </button>
                        {onCancelNewThread ? (
                          <button type="button" className="room-menu-button new-thread-cancel" aria-label="Cancel new thread" title="Cancel new thread" onClick={onCancelNewThread}>
                            <CloseIcon />
                          </button>
                        ) : null}
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
          {projects !== null ? (
            <li className="project-group presets-group">
              <div className="project-head">
                <button
                  type="button"
                  className="project-toggle"
                  aria-expanded={!collapsed.has(PRESETS_KEY)}
                  onClick={() => toggleCollapsed(PRESETS_KEY)}
                  title="Your crew: the people you bring into rooms, each a model with its options, permission mode, role and where it works"
                >
                  <ChevronIcon dir={collapsed.has(PRESETS_KEY) ? "right" : "down"} />
                  <span className="project-name">Crew</span>
                  {collapsed.has(PRESETS_KEY) ? <span className="project-count mono">{presets.length}</span> : null}
                </button>
                <button type="button" className="small ghost project-add" aria-label="New crew member" title="New crew member" disabled={disabled} onClick={() => setDialog({ kind: "preset", preset: null })}>
                  <PlusIcon />
                </button>
              </div>
              {!collapsed.has(PRESETS_KEY) ? (
                <ul className="project-items">
                  {presets.map((preset) => {
                    const { model, what, detail } = presetText(preset);
                    return (
                      <li key={preset.id} className="room-item side-preset" draggable onDragStart={(event) => startPresetDrag(event, preset)} onDragEnd={() => setPresetOver(null)}>
                        <button
                          type="button"
                          className="side-thread-tile side-preset-tile"
                          title={`${preset.name}: ${model} · ${detail}\nClick to start a thread with them. Drag them onto a room to seat them there, or onto a project to start a thread there.`}
                          disabled={disabled}
                          onClick={() => newThread(null, preset.id)}
                        >
                          <PresetIcon preset={preset} size={16} />
                          <span className="tile-body">
                            <span className="thread-title mono">{preset.name}</span>
                            <span className="side-preset-what">{what}</span>
                          </span>
                        </button>
                        <PresetMenu
                          preset={preset}
                          rooms={rooms}
                          projects={projects ?? []}
                          openRoomId={openRoom?.id ?? null}
                          disabled={disabled}
                          onStart={() => newThread(null, preset.id)}
                          onAdd={(roomId) => void onSeatPreset(roomId, preset.id)}
                          onEdit={() => setDialog({ kind: "preset", preset })}
                        />
                      </li>
                    );
                  })}
                  {presets.length === 0 ? <li className="project-empty muted">Nobody in your crew yet</li> : null}
                </ul>
              ) : null}
            </li>
          ) : null}
          {browsers ? (
            <li className="project-group browsers-group">
              <div className="project-head">
                <button type="button" className="project-toggle" aria-expanded={!collapsed.has(BROWSERS_KEY)} onClick={() => toggleCollapsed(BROWSERS_KEY)} title="Shared Chrome browsers on this machine, for agents">
                  <ChevronIcon dir={collapsed.has(BROWSERS_KEY) ? "right" : "down"} />
                  <span className="project-name">Browsers</span>
                  {collapsed.has(BROWSERS_KEY) ? <span className="project-count mono">{browsers.length}</span> : null}
                </button>
                <button type="button" className="small ghost project-add" aria-label="New browser" title="New browser" disabled={disabled} onClick={() => setDialog({ kind: "browser" })}>
                  <PlusIcon />
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
        {dialog?.kind === "preset" ? <PresetDialog preset={dialog.preset} runCommand={onCommand} onClose={() => setDialog(null)} /> : null}
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
  const news = room.news && room.news.unseen > 0 ? room.news : null;
  return (
    <button type="button" className={`room-tile${selected ? " selected" : ""}${news ? " has-news" : ""}`} onClick={onSelect} aria-current={selected ? "true" : undefined} title={news ? newsLabel(news) : undefined}>
      <span className="room-mono serif" aria-hidden="true">
        {titleMonogram(room.title)}
        {news ? <NewsCount news={news} /> : null}
      </span>
      <span className="tile-body">
        <span className="room-title">{room.title}</span>
        <span className="room-meta mono">
          <span title="Members seated">{room.participantCount} member{room.participantCount === 1 ? "" : "s"}</span>
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
        {news?.latest ? (
          <span className={`room-news tone-${news.latest.kind === "failed" ? "err" : "ok"}`}>
            <NewsGlyph failed={news.latest.kind === "failed"} />
            <span className="room-news-text">
              <span className="sr-only">{news.unseen} new: </span>
              <span className="room-news-who">
                {describeRoomNews(news.latest)} · {shortAge(news.latest.at)}
              </span>
              {newsPreview(news.latest.preview)}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The count on a room's monogram (and its rail tile) while something there finished since you looked. */
function NewsCount({ news }: { news: RoomNews }) {
  return (
    <span className={`news-count tone-${news.latest?.kind === "failed" ? "err" : "ok"}`} aria-hidden="true">
      {news.unseen > 9 ? "9+" : news.unseen}
    </span>
  );
}

/** A tick in a green disc for a finish, a cross in a red one for a failure. */
function NewsGlyph({ failed }: { failed: boolean }) {
  return (
    <span className="news-glyph" aria-hidden="true">
      <svg viewBox="0 0 8 8">{failed ? <path d="M2.3 2.3 5.7 5.7M5.7 2.3 2.3 5.7" /> : <path d="M1.9 4.2 3.4 5.6 6.2 2.6" />}</svg>
    </span>
  );
}

/** The opening of a reply after its line: ": Fixed the parser…", as plain words. */
function newsPreview(preview: string): string {
  const text = preview.replace(/```[\s\S]*?```/g, " ").replace(/[`*_>#]+/g, "").replace(/\s+/g, " ").trim();
  return text ? `: ${text}` : "";
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
          <ChevronIcon dir={open ? "down" : "right"} />
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
  const news = state ? null : (thread.news ?? null);
  // Settled and archived threads show when they got there; active ones when they were last used.
  const age = shortAge(thread.archivedAt ?? thread.settledAt ?? lastActive(thread));
  return (
    <li className="side-thread">
      <button
        type="button"
        className={`side-thread-tile${selected ? " selected" : ""}${state ? ` ${state}` : ""}${news ? " has-news" : ""}`}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={`${thread.title}\n${thread.modelSelection.model} · ${state ?? (news ? `${news.state === "error" ? "failed" : "finished"} since you looked` : activity.label)}`}
      >
        <span className={`thread-dot tone-${state ? "idle" : activity.tone === "input" || !news ? activity.tone : news.state === "error" ? "error" : "new"}`} aria-hidden="true" />
        <span className="thread-title">{thread.title}</span>
        {activity.tone === "input" && !state ? (
          <span className="pill pill-input">needs you</span>
        ) : news ? (
          <span className={`thread-news tone-${news.state === "error" ? "err" : "ok"}`}>
            <NewsGlyph failed={news.state === "error"} />
            {shortAge(news.at)}
          </span>
        ) : (
          <span className="side-thread-age mono">{age}</span>
        )}
      </button>
    </li>
  );
}

/** A small button opening a menu of actions (rendered at the body so the scrolling sidebar cannot clip it). */
/**
 * A crew member's menu. "Seat in a room" opens the list of rooms in the menu's place (the open room first), so the preset
 * can be seated anywhere without dragging: on a phone, or in a room that is not the open one.
 */
function PresetMenu({
  preset,
  rooms,
  projects,
  openRoomId,
  disabled,
  onStart,
  onAdd,
  onEdit,
}: {
  preset: Preset;
  rooms: RoomListItem[];
  projects: T3Project[];
  openRoomId: string | null;
  disabled: boolean;
  onStart: () => void;
  onAdd: (roomId: string) => void;
  onEdit: () => void;
}) {
  const [level, setLevel] = useState<"closed" | "main" | "rooms">("closed");
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = level !== "closed";
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setLevel("closed");
    };
    // Escape goes back from the rooms to the menu, then closes it.
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setLevel((current) => (current === "rooms" ? "main" : "closed"));
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Moving between the menu and the rooms keeps the keyboard inside it.
  useEffect(() => {
    if (!open) return;
    // A frame later: the menu is hidden until it has been placed, and a hidden button takes no focus.
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [level, open]);

  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  const listed = [...rooms].sort((a, b) => Number(b.id === openRoomId) - Number(a.id === openRoomId));
  const pick = (action: () => void) => {
    setLevel("closed");
    action();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="small ghost room-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${preset.name} options`}
        aria-label={`${preset.name} options`}
        disabled={disabled}
        onClick={() => setLevel((current) => (current === "closed" ? "main" : "closed"))}
      >
        <MoreIcon />
      </button>
      {open ? (
        // Keyed by level, so the menu is placed again for the list it now holds.
        <Popover key={level} anchor={anchor} menuRef={menuRef} role="menu" className="preset-menu" onClose={() => setLevel("closed")} menuProps={{ "aria-label": level === "rooms" ? `Seat ${preset.name} in a room` : `${preset.name} options` }}>
          {level === "main" ? (
            <>
              <button type="button" role="menuitem" onClick={() => pick(onStart)}>
                Start a thread
              </button>
              <button type="button" role="menuitem" className="menu-more" aria-haspopup="menu" disabled={rooms.length === 0} title={rooms.length === 0 ? "There are no rooms yet" : undefined} onClick={() => setLevel("rooms")}>
                <span>Seat in a room</span>
                <ChevronIcon dir="right" />
              </button>
              <button type="button" role="menuitem" onClick={() => pick(onEdit)}>
                Edit…
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className="menu-back" onClick={() => setLevel("main")}>
                <ChevronIcon dir="left" />
                <span>Seat in a room</span>
              </button>
              {listed.map((room) => (
                <button key={room.id} type="button" role="menuitem" className="menu-room" onClick={() => pick(() => onAdd(room.id))}>
                  <span className="menu-room-title">{room.title}</span>
                  <span className="menu-room-meta">
                    {[projectTitle.get(room.projectId), `${room.participantCount} member${room.participantCount === 1 ? "" : "s"}`, room.id === openRoomId ? "open" : null].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))}
            </>
          )}
        </Popover>
      ) : null}
    </>
  );
}

function AddMenu({
  label,
  title,
  className,
  disabled,
  items,
}: {
  label: ReactNode;
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

/** Whether a typed path is a full one on the T3 machine (T3 resolves a relative path against its own folder). */
const isFullPath = (path: string): boolean => /^(~|\/|[A-Za-z]:[\\/])/.test(path);
const parentOf = (path: string): string => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
const trimSlashes = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * T3's folders for the path as it is typed, a moment after each keystroke. `path` is the one the listing is for, so a
 * listing of an older path is told apart from the current one's.
 */
function useFolderListing(typed: string): { path: string; listing: FolderListing | null } {
  const [state, setState] = useState<{ path: string; listing: FolderListing | null }>({ path: "", listing: null });
  useEffect(() => {
    if (!isFullPath(typed)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.folders(typed).then(
        (listing) => !cancelled && setState({ path: typed, listing }),
        (error) => !cancelled && setState({ path: typed, listing: { parentPath: null, entries: [], unreadable: error instanceof Error ? error.message : String(error) } }),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typed]);
  return state;
}

/**
 * New project: the folder is typed or browsed, as in T3 Code's own picker. The list under the field shows the
 * folders T3 finds for what is typed (a path ending in "/" lists that folder; otherwise the folders whose names start
 * with the last part); clicking one goes into it, ".." goes up. The folder the path names is the one added, whether
 * or not the path ends in "/", so browsing into a folder and pressing Add adds it. Only T3's own picker clones from a
 * Git URL or GitHub; add such a project in T3 Code and it shows here.
 */
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
  const [path, setPath] = useState(parent ? `${parent}/` : "~/");
  const [title, setTitle] = useState("");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const typed = path.trim();
  const folder = trimSlashes(typed);
  const folderName = folder.split("/").pop() ?? "";
  const { path: listedFor, listing } = useFolderListing(typed);
  const current = listedFor === typed ? listing : null;
  const projectAt = (fullPath: string): T3Project | null => projects.find((p) => trimSlashes(p.workspaceRoot) === trimSlashes(fullPath)) ?? null;

  // What T3 says about the folder named: found (with its full path), not there, or nothing yet.
  const found = current?.parentPath ? (typed.endsWith("/") ? current.parentPath : (current.entries.find((e) => e.name === folderName)?.fullPath ?? null)) : null;
  const missing = current !== null && current.unreadable === null && found === null;
  const existing = found ? projectAt(found) : null;
  const ready = isFullPath(typed) && folderName.length > 0 && folderName !== "~" && !existing;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await onCreate({ workspaceRoot: folder, ...(title.trim() ? { title: title.trim() } : {}), createIfMissing: create });
    } finally {
      setBusy(false);
    }
  };

  // ".." lists the parent of the folder listed now (a trailing "/" lists rather than filters).
  const upFrom = current?.parentPath && current.parentPath !== "/" ? parentOf(current.parentPath) : null;
  const up = upFrom === null ? null : upFrom === "/" ? "/" : `${upFrom}/`;

  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="muted">Adds a project to T3 Code for a folder on the machine T3 runs on. Rooms and threads in it work in that folder.</p>
        <label>
          Folder
          <input type="text" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Projects/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-autofocus />
          <span className="hint">
            {!isFullPath(typed)
              ? "Type the full path on the T3 machine (~ works), or pick from the list."
              : existing
                ? `Already the project “${existing.title}”.`
                : found
                  ? `Adds ${found}.`
                  : missing
                    ? `${folder} does not exist on the T3 machine yet.`
                    : "Pick a folder below, or type the path."}
          </span>
        </label>
        <div className="folder-browse" role="group" aria-label="Folders on the T3 machine">
          {up ? (
            <button type="button" className="folder-row folder-up" onClick={() => setPath(up)} title={`Up to ${upFrom}`}>
              <UpFolderIcon />
              <span className="folder-name mono">..</span>
              <span className="folder-meta">{current!.parentPath}</span>
            </button>
          ) : null}
          {current?.entries.map((entry) => {
            const project = projectAt(entry.fullPath);
            return (
              <button type="button" key={entry.fullPath} className="folder-row" onClick={() => setPath(`${entry.fullPath}/`)} title={entry.fullPath}>
                <FolderIcon />
                <span className="folder-name">{entry.name}</span>
                {project ? <span className="folder-meta">project · {project.title}</span> : null}
              </button>
            );
          })}
          {current && current.unreadable === null && current.entries.length === 0 ? <span className="hint">{typed.endsWith("/") ? "No subfolders." : "No folder here starts with that."}</span> : null}
          {current?.unreadable ? <span className="hint">{current.unreadable}</span> : null}
          {!current && isFullPath(typed) ? <span className="hint">Looking…</span> : null}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
          Create the folder if it does not exist
        </label>
        <label>
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={folderName && folderName !== "~" ? folderName : "folder name"} />
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
