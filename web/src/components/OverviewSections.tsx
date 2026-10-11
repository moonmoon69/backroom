import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserListItem, CommandResult, Preset, RoomCommand, RoomListItem, T3Project, T3ThreadShell } from "../types.ts";
import { BrowserFormDialog } from "./BrowserForm.tsx";
import { Dialog } from "./Dialog.tsx";
import { Popover } from "./Popover.tsx";
import { ChevronIcon, MoreIcon, PlusIcon } from "./icons.tsx";
import { PresetDialog, PresetIcon, RoomChoices, startPresetDrag, usePresets, usePresetText } from "./presets.tsx";
import { useSortable } from "./sortable.ts";

type RunCommand = (command: RoomCommand) => Promise<CommandResult | null>;

/** "now", "5m", "3h", "2d", "4w": how long ago. */
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

/**
 * Your crew, under the projects: each saved member with their model and what they are for. A click (or Enter) opens them
 * to edit (settings and look), and the dialog's Seat in a room… seats them; so does their ⋯, or dragging them onto a
 * room's tile.
 */
export function CrewSection({ rooms, projects, onSeat, runCommand }: { rooms: RoomListItem[]; projects: T3Project[]; onSeat: (roomId: string, presetId: string) => void; runCommand: RunCommand }) {
  const { presets } = usePresets();
  const presetText = usePresetText();
  const [editing, setEditing] = useState<{ preset: Preset | null } | null>(null);
  return (
    <section className="ov-project ov-shelf" aria-label="Crew">
      <h2 className="ov-project-title">
        <span className="ov-project-name">Crew</span>
        <span className="ov-project-path muted">who you bring into rooms · drag one onto a room to seat them</span>
        <span className="spacer" />
        <button type="button" className="small ghost ov-project-new" title="Save a crew member: a name with a model, its options, permission mode and where it works" onClick={() => setEditing({ preset: null })} data-nav="ov" data-nav-key="head:crew">
          <PlusIcon />
          New crew member
        </button>
      </h2>
      {presets.length === 0 ? <p className="muted ov-empty">Nobody in your crew yet.</p> : null}
      <ul className="ov-shelf-items">
        {presets.map((preset) => {
          const { model, what, detail } = presetText(preset);
          const goodAt = preset.goodAt?.trim() ?? "";
          const avoid = preset.avoid?.trim() ?? "";
          const about = [goodAt ? `Good at ${goodAt}` : "", avoid ? `Avoid ${avoid}` : ""].filter(Boolean);
          return (
            <li key={preset.id} className="ov-shelf-item" draggable onDragStart={(event) => startPresetDrag(event, preset)} data-nav-card>
              <button
                type="button"
                className="ov-shelf-tile"
                title={`${preset.name}: ${model} · ${detail}${about.map((line) => `\n${line}`).join("")}\nClick to edit them. Drag them onto a room to seat them there.`}
                onClick={() => setEditing({ preset })}
                data-nav="ov"
                data-nav-key={`preset:${preset.id}`}
                data-where={`${preset.name} · crew member`}
              >
                <PresetIcon preset={preset} size={16} />
                <span className="ov-shelf-name mono">{preset.name}</span>
                <span className="ov-shelf-what">{what}</span>
                {about.map((line) => (
                  <span key={line} className="ov-shelf-about">
                    {line}
                  </span>
                ))}
              </button>
              <PresetMenu preset={preset} rooms={rooms} projects={projects} onSeat={(roomId) => onSeat(roomId, preset.id)} onEdit={() => setEditing({ preset })} />
            </li>
          );
        })}
      </ul>
      {editing ? (
        <PresetDialog
          preset={editing.preset}
          runCommand={runCommand}
          onClose={() => setEditing(null)}
          seat={{ rooms, projects, onSeat: (roomId) => editing.preset && onSeat(roomId, editing.preset.id) }}
        />
      ) : null}
    </section>
  );
}

/** A crew member's menu. "Seat in a room" opens the list of rooms in the menu's place, so they can be seated without dragging (on a phone too). */
function PresetMenu({ preset, rooms, projects, onSeat, onEdit }: { preset: Preset; rooms: RoomListItem[]; projects: T3Project[]; onSeat: (roomId: string) => void; onEdit: () => void }) {
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
        onClick={() => setLevel((current) => (current === "closed" ? "main" : "closed"))}
      >
        <MoreIcon />
      </button>
      {open ? (
        // Keyed by level, so the menu is placed again for the list it now holds.
        <Popover key={level} anchor={anchor} menuRef={menuRef} role="menu" className="preset-menu" onClose={() => setLevel("closed")} menuProps={{ "aria-label": level === "rooms" ? `Seat ${preset.name} in a room` : `${preset.name} options` }}>
          {level === "main" ? (
            <>
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
              <RoomChoices rooms={rooms} projects={projects} onPick={(roomId) => pick(() => onSeat(roomId))} />
            </>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/** The shared browsers on this machine, for agents: a click opens one (start, stop, tabs, profile); + adds one. */
export function BrowsersSection({ browsers, onOpen, onChanged, runCommand }: { browsers: BrowserListItem[]; onOpen: (browserId: string) => void; onChanged: () => void; runCommand: RunCommand }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="ov-project ov-shelf" aria-label="Browsers">
      <h2 className="ov-project-title">
        <span className="ov-project-name">Browsers</span>
        <span className="ov-project-path muted">shared Chrome browsers on this machine, for agents</span>
        <span className="spacer" />
        <button type="button" className="small ghost ov-project-new" title="A new shared browser, named for what it is for" onClick={() => setAdding(true)} data-nav="ov" data-nav-key="head:browsers">
          <PlusIcon />
          New browser
        </button>
      </h2>
      <ul className="ov-shelf-items">
        {browsers.map((browser) => {
          const state = browser.status.state;
          return (
            <li key={browser.id} className="ov-shelf-item" data-nav-card>
              <button type="button" className="ov-shelf-tile" title={`${browser.name}${browser.description ? `\n${browser.description}` : ""}`} onClick={() => onOpen(browser.id)} data-nav="ov" data-nav-key={`browser:${browser.id}`} data-where={`${browser.name} · browser`}>
                <span className={`thread-dot tone-${state === "running" ? "on" : state === "starting" ? "working" : state === "error" ? "error" : "idle"}`} aria-hidden="true" />
                <span className="ov-shelf-name mono">{browser.name}</span>
                <span className="ov-shelf-what">
                  {state === "running" ? `${browser.status.tabs.length} tab${browser.status.tabs.length === 1 ? "" : "s"}` : state === "error" ? "failed" : state === "starting" ? "starting" : "off"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <BrowserFormDialog
          title="New browser"
          submitLabel="Create browser"
          onClose={() => setAdding(false)}
          onSubmit={async (values) => {
            const result = await runCommand({ type: "browser.create", ...values });
            if (result && result.type === "browser.created" && "browserId" in result) {
              setAdding(false);
              onChanged();
              onOpen(result.browserId as string);
            }
          }}
        />
      ) : null}
    </section>
  );
}

/** A project's settled and archived threads (T3's done list and its hidden one), folded under its tiles until opened. */
export function ThreadShelf({ settled, archived, drafted, onOpen }: { settled: T3ThreadShell[]; archived: T3ThreadShell[]; drafted: (threadId: string) => boolean; onOpen: (threadId: string) => void }) {
  const [open, setOpen] = useState<"settled" | "archived" | null>(null);
  if (settled.length + archived.length === 0) return null;
  const shown = open === "settled" ? settled : open === "archived" ? archived : [];
  const toggle = (section: "settled" | "archived", count: number, title: string) =>
    count > 0 ? (
      <button type="button" className="thread-section-toggle mono" aria-expanded={open === section} title={title} onClick={() => setOpen(open === section ? null : section)} data-nav="ov" data-nav-key={`shelf:${(settled[0] ?? archived[0])?.projectId}:${section}`} data-where={`${section === "settled" ? "Settled" : "Archived"} threads · ${count}`}>
        <ChevronIcon dir={open === section ? "down" : "right"} />
        {section === "settled" ? "Settled" : "Archived"} · {count}
      </button>
    ) : null;
  return (
    <div className="ov-thread-shelf">
      <div className="ov-thread-shelf-toggles">
        {toggle("settled", settled.length, "Threads in T3's settled list: done for now. Sending one a message makes it active again.")}
        {toggle("archived", archived.length, "Threads archived in T3: hidden there, reversible. Open one to unarchive or delete it.")}
      </div>
      {shown.length > 0 ? (
        <ul className="ov-threads">
          {shown.map((thread) => (
            <li key={thread.id}>
              <button type="button" className="ov-thread" title={`${thread.title}\n${thread.modelSelection.model}`} onClick={() => onOpen(thread.id)} data-nav="ov" data-nav-key={`thread:${thread.id}`} data-where={thread.title}>
                <span className="ov-thread-title">{thread.title}</span>
                {drafted(thread.id) ? (
                  <span className="pill pill-draft" title="You have an unsent message here">
                    draft
                  </span>
                ) : null}
                <span className="mono muted ov-when">{shortAge(thread.archivedAt ?? thread.settledAt ?? thread.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The order of projects, and of rooms within each, as the service keeps it for every device. The overview keeps it
 * inside each of its tiers. Drag a row (a long press first on a phone), or
 * Alt+↑/↓ on a focused one; rooms move within their project.
 */
export function ArrangeDialog({ rooms, projects, runCommand, onClose }: { rooms: RoomListItem[]; projects: T3Project[]; runCommand: RunCommand; onClose: () => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  const roomIds = useMemo(() => rooms.map((r) => r.id), [rooms]);
  const projectOfRoom = useMemo(() => new Map(rooms.map((r) => [r.id, r.projectId])), [rooms]);
  const roomSort = useSortable({
    name: "room",
    ids: roomIds,
    scopeOf: (id) => projectOfRoom.get(id) ?? "",
    container: listRef,
    onCommit: (ids) => runCommand({ type: "room.reorder", roomIds: ids }),
  });
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const projectSort = useSortable({ name: "project", ids: projectIds, container: listRef, onCommit: (ids) => runCommand({ type: "project.reorder", projectIds: ids }) });
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const orderedRooms = roomSort.order.map((id) => roomById.get(id)).filter((r): r is RoomListItem => Boolean(r));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const orderedProjects = projectSort.order.map((id) => projectById.get(id)).filter((p): p is T3Project => Boolean(p));
  return (
    <Dialog title="Arrange" onClose={onClose}>
      <p className="muted">
        Drag a project or a room to move it (a long press first on a phone), or press Alt+↑/↓ on one. Rooms move within their project. The overview keeps this order among tiles that ask the same of you; every
        device shows the same.
      </p>
      <ul className="arrange-list" ref={listRef}>
        {orderedProjects.map((project) => (
          <li key={project.id} className={`arrange-project${projectSort.dragging === project.id ? " dragging" : ""}`}>
            <div {...projectSort.handle(project.id)} tabIndex={0} className="arrange-row arrange-project-head" title={project.workspaceRoot}>
              {project.title}
            </div>
            <ul className="arrange-rooms">
              {orderedRooms
                .filter((room) => room.projectId === project.id)
                .map((room) => (
                  <li key={room.id} {...roomSort.handle(room.id)} tabIndex={0} className={`arrange-row arrange-room${roomSort.dragging === room.id ? " dragging" : ""}`}>
                    {room.title}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
