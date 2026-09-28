import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RoomContext, type FollowUpPrefill, type RoomContextValue } from "../../context.tsx";
import { useSkin } from "../../skin.ts";
import { useBooks } from "../../street/books.ts";
import { layoutStreet, type Lot, type StreetWindow } from "../../street/layout.ts";
import "../../street/street.css";
import type { ThemeChoice } from "../../theme.ts";
import type { BrowserListItem, CommandResult, Preset, RoomCommand, RoomListItem, StatusResponse, T3Project, T3ThreadShell } from "../../types.ts";
import { useMediaQuery } from "../../useMediaQuery.ts";
import { BrowserView } from "../BrowserView.tsx";
import type { InspectorTab } from "../Inspector.tsx";
import { PresetDialog, usePresets } from "../presets.tsx";
import { NewProjectDialog, NewRoomDialog, rememberProject, type Selection } from "../Sidebar.tsx";
import { ArchivedThreadView, NewThreadView, ThreadView } from "../ThreadView.tsx";
import { BackRoom } from "./BackRoom.tsx";
import { ClubCard, DirectoryCard } from "./StreetPanels.tsx";
import { StreetView, type JumpItem } from "./StreetView.tsx";

/** Where you are: out on the street, or inside somewhere. */
type Place =
  | { kind: "street" }
  | { kind: "room"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "new-thread"; projectId: string; presetId?: string }
  | { kind: "browser"; id: string };

/** The room or thread you were last in, per project: what its front door opens. */
const LAST_KEY = "backroom.street.last";

function readLast(): Record<string, { kind: "room" | "thread"; id: string }> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<string, { kind: "room" | "thread"; id: string }>;
  } catch {
    return {};
  }
}

interface Props {
  status: StatusResponse | null;
  rooms: RoomListItem[];
  projects: T3Project[] | null;
  threads: T3ThreadShell[];
  t3Error: string | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  /** Out on the street, the room last opened is not being looked at (its news stays news). */
  onOutside: (outside: boolean) => void;
  /** The open room, once its snapshot is read. */
  room: RoomContextValue | null;
  followUp: FollowUpPrefill | null;
  panel: InspectorTab | null;
  onPanel: (tab: InspectorTab | null) => void;
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  onSeatPreset: (roomId: string, presetId: string) => Promise<void>;
  onT3Changed: () => void;
  onThreadChanged: (threadId: string, patch: Partial<T3ThreadShell>) => void;
  browsers: BrowserListItem[] | null;
  onBrowsersChanged: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onOpenConnection: () => void;
  onOpenLibrary: () => void;
  needsPairing: boolean;
  staleUi: boolean;
}

const motionAllowed = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Settings → Look → Street: the whole of Backroom as one block of Mulberry Street. It takes the place of the sidebar,
 * header and panels, and Look → Desk (or "Back to the desk" in the club) brings them back; the room you were in stays
 * open either way. The street is drawn from what Backroom already has (street/layout.ts) and keeps nothing of its
 * own but which room each building's door opens.
 */
export function StreetMode(props: Props) {
  const { rooms, projects, threads, onSelect, onOutside, room, panel, onPanel, runCommand, theme, onTheme } = props;
  const [place, setPlace] = useState<Place>({ kind: "street" });
  // Coming from the desk, face the building of the room or thread that was open there.
  const [focus, setFocus] = useState<string | null>(() => {
    const open = props.selection;
    if (open?.kind === "room") return rooms.find((r) => r.id === open.id)?.projectId ?? null;
    if (open?.kind === "thread") return threads.find((t) => t.id === open.id)?.projectId ?? null;
    return null;
  });
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [clubOpen, setClubOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "project" } | { kind: "room"; projectId: string | null } | { kind: "preset"; preset: Preset | null } | null>(null);
  const [, setSkin] = useSkin();
  const { presets } = usePresets();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const night = theme === "dark" || (theme === "system" && prefersDark);

  const street = useMemo(() => layoutStreet(projects, rooms, threads), [projects, rooms, threads]);
  const books = useBooks(threads, place.kind === "street");

  useEffect(() => {
    onOutside(place.kind === "street");
  }, [place.kind, onOutside]);
  useEffect(() => () => onOutside(false), [onOutside]);

  const projectOf = useCallback(
    (target: Place): string | null => {
      if (target.kind === "room") return rooms.find((r) => r.id === target.id)?.projectId ?? null;
      if (target.kind === "thread") return threads.find((t) => t.id === target.id)?.projectId ?? null;
      if (target.kind === "new-thread") return target.projectId;
      return null;
    },
    [rooms, threads],
  );

  const enter = useCallback(
    (target: Place, from: DOMRect | null = null) => {
      setDirectory(null);
      setClubOpen(false);
      const arrive = () => {
        setZoom(null);
        // A room opens without a panel; its board, ledger, telephone and cabinet open them.
        if (target.kind === "room") onPanel(null);
        setPlace(target);
        if (target.kind !== "street") onSelect(target);
        const projectId = projectOf(target);
        if (projectId && (target.kind === "room" || target.kind === "thread")) {
          localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), [projectId]: { kind: target.kind, id: target.id } }));
        }
      };
      if (from && motionAllowed()) {
        setZoom({ x: from.left + from.width / 2, y: from.top + from.height / 2 });
        window.setTimeout(arrive, 360);
      } else arrive();
    },
    [onSelect, projectOf, onPanel],
  );

  // Something else opened a room or thread (a system notification): walk in.
  const seenSelection = useRef(props.selection);
  useEffect(() => {
    const next = props.selection;
    const previous = seenSelection.current;
    seenSelection.current = next;
    // Nothing was open before: that is the app picking its first room, not someone asking to go there.
    if (!next || !previous || next === previous || (next.kind !== "room" && next.kind !== "thread")) return;
    if ((place.kind === "room" || place.kind === "thread") && place.id === next.id) return;
    if (previous && previous.kind === next.kind && "id" in previous && previous.id === next.id) return;
    enter(next);
  }, [props.selection, place, enter]);

  const leave = useCallback(() => {
    setFocus(projectOf(place));
    onPanel(null);
    setPlace({ kind: "street" });
  }, [place, projectOf, onPanel]);

  const windowPlace = (w: StreetWindow): Place => (w.kind === "room" ? { kind: "room", id: w.id } : { kind: "thread", id: w.id });

  /** A building's door: the room or thread you were last in there, else its first; an empty building shows its directory. */
  const onDoor = (lot: Lot, from: DOMRect | null) => {
    const last = lot.project ? readLast()[lot.project.id] : undefined;
    const all = [...lot.windows, ...lot.hidden];
    const known = last && all.some((w) => w.kind === last.kind && w.id === last.id) ? last : null;
    const first = known ?? all.find((w) => w.kind === "room") ?? all[0] ?? null;
    if (first) enter(first.kind === "room" ? { kind: "room", id: first.id } : { kind: "thread", id: first.id }, from);
    else if (lot.project) setDirectory(lot.project.id);
  };

  const newThread = (projectId: string | null, presetId?: string) => {
    const target = projectId ?? projects?.[0]?.id ?? null;
    if (!target) return;
    rememberProject(target);
    enter({ kind: "new-thread", projectId: target, ...(presetId ? { presetId } : {}) });
  };

  const jumpItems = useMemo<JumpItem[]>(() => {
    const items: JumpItem[] = [];
    for (const lot of street.lots) {
      if (!lot.project) continue;
      const project = lot.project;
      items.push({ key: `p:${project.id}`, label: project.title, detail: `${lot.business?.word ?? "Business"} · directory`, go: () => setDirectory(project.id) });
      for (const w of [...lot.windows, ...lot.hidden]) {
        items.push({ key: `${w.kind}:${w.id}`, label: w.title, detail: `${w.kind === "room" ? "Room" : "Thread"} in ${project.title} · ${w.label}`, go: () => enter(windowPlace(w)) });
      }
    }
    return items;
  }, [street, enter]);

  const t3Notice = props.needsPairing
    ? "T3 is not paired: pair it to see your projects"
    : props.status?.t3.error
      ? `T3 cannot be reached: ${props.status.t3.error}`
      : props.t3Error
        ? `T3 did not answer: ${props.t3Error}`
        : null;

  // Esc closes what is open over the street.
  useEffect(() => {
    if (place.kind !== "street" || (!directory && !clubOpen)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".dialog-backdrop")) return;
      setDirectory(null);
      setClubOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [place.kind, directory, clubOpen]);

  const back = (
    <button type="button" className="small ghost st-back" onClick={leave} title="Back to the street (Esc)">
      ← Mulberry St
    </button>
  );
  const projectTitle = (id: string | null | undefined) => (id ? (projects?.find((p) => p.id === id)?.title ?? null) : null);
  const directoryLot = directory ? street.lots.find((lot) => lot.project?.id === directory) ?? null : null;

  let inside: ReactNode = null;
  if (place.kind === "room") {
    inside =
      room && room.snapshot.room.id === place.id ? (
        <RoomContext.Provider value={room}>
          <BackRoom
            night={night}
            projectTitle={projectTitle(room.snapshot.room.projectId)}
            followUp={props.followUp}
            panel={panel}
            onPanel={onPanel}
            onLeave={leave}
            onManageBrowser={(browserId) => {
              const target = browserId ?? props.browsers?.[0]?.id;
              if (target) enter({ kind: "browser", id: target });
            }}
          />
        </RoomContext.Provider>
      ) : (
        <div className={`street-walking${night ? " is-night" : ""}`}>
          <p>Walking in…</p>
          {back}
        </div>
      );
  } else if (place.kind === "thread") {
    const archived = threads.find((t) => t.id === place.id && t.archivedAt) ?? null;
    inside = archived ? (
      <ArchivedThreadView
        thread={archived}
        project={projects?.find((p) => p.id === archived.projectId) ?? null}
        runCommand={runCommand}
        onUnarchived={() => {
          props.onThreadChanged(archived.id, { archivedAt: null });
          props.onT3Changed();
        }}
        onGone={() => {
          setPlace({ kind: "street" });
          props.onT3Changed();
        }}
        headerStart={back}
      />
    ) : (
      <ThreadView
        threadId={place.id}
        rooms={rooms}
        browsers={props.browsers}
        runCommand={runCommand}
        onGone={() => {
          setPlace({ kind: "street" });
          props.onT3Changed();
        }}
        onChanged={props.onT3Changed}
        onArchived={() => {
          props.onThreadChanged(place.id, { archivedAt: new Date().toISOString() });
          props.onT3Changed();
        }}
        onOpenRoom={(roomId) => enter({ kind: "room", id: roomId })}
        headerStart={back}
      />
    );
  } else if (place.kind === "new-thread") {
    inside = (
      <NewThreadView
        projectId={place.projectId}
        presetId={place.presetId ?? null}
        projects={projects ?? []}
        browsers={props.browsers}
        runCommand={runCommand}
        onProject={(projectId) => {
          rememberProject(projectId);
          enter({ kind: "new-thread", projectId, ...(place.presetId ? { presetId: place.presetId } : {}) });
        }}
        onStarted={(threadId) => {
          props.onT3Changed();
          enter({ kind: "thread", id: threadId });
        }}
        onCancel={leave}
        headerStart={back}
      />
    );
  } else if (place.kind === "browser") {
    inside = (
      <BrowserView
        browserId={place.id}
        runCommand={runCommand}
        onGone={() => {
          setPlace({ kind: "street" });
          props.onBrowsersChanged();
        }}
        onChanged={props.onBrowsersChanged}
        onOpenRoom={(roomId) => enter({ kind: "room", id: roomId })}
        headerStart={back}
      />
    );
  }

  return (
    <div className={`street-mode${night ? " is-night" : " is-day"}`}>
      {props.staleUi ? (
        <div className="update-banner" role="status">
          <span>Backroom was updated.</span>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      {place.kind === "street" ? (
        <div className="street-zoom" style={zoom ? { transformOrigin: `${zoom.x}px ${zoom.y}px` } : undefined} data-zooming={zoom ? "" : undefined}>
          <StreetView
            street={street}
            night={night}
            books={books}
            crew={presets.length}
            t3Notice={t3Notice}
            focus={focus}
            jumpItems={jumpItems}
            onWindow={(_lot, w, from) => enter(windowPlace(w), from)}
            onDoor={onDoor}
            onDirectory={(lot) => {
              setClubOpen(false);
              setDirectory(lot.project?.id ?? null);
            }}
            onClub={() => {
              setDirectory(null);
              setClubOpen(true);
            }}
            onRent={() => setDialog({ kind: "project" })}
            onNight={() => onTheme(night ? "light" : "dark")}
            onT3={props.onOpenConnection}
            busy={Boolean(directory || clubOpen || dialog || zoom)}
          />
          {directoryLot ? (
            <DirectoryCard
              lot={directoryLot}
              spend={directoryLot.project ? books.byProject.get(directoryLot.project.id) : undefined}
              partial={books.partial}
              onOpen={(w) => enter(windowPlace(w))}
              onNewRoom={() => setDialog({ kind: "room", projectId: directoryLot.project?.id ?? null })}
              onNewThread={() => newThread(directoryLot.project?.id ?? null)}
              onClose={() => setDirectory(null)}
            />
          ) : null}
          {clubOpen ? (
            <ClubCard
              books={books}
              rooms={rooms}
              projects={projects}
              browsers={props.browsers}
              status={props.status}
              theme={theme}
              onTheme={onTheme}
              onOpenConnection={props.onOpenConnection}
              onOpenLibrary={props.onOpenLibrary}
              rolesDisabled={props.needsPairing}
              onSeat={(roomId, presetId) => void props.onSeatPreset(roomId, presetId)}
              onNewThread={(preset) => newThread(localStorage.getItem("backroom.lastProject"), preset.id)}
              onEditPreset={(preset) => setDialog({ kind: "preset", preset })}
              onBrowser={(browserId) => enter({ kind: "browser", id: browserId })}
              onDesk={() => setSkin("desk")}
              onClose={() => setClubOpen(false)}
            />
          ) : null}
        </div>
      ) : (
        <div className="street-inside">{inside}</div>
      )}
      {dialog?.kind === "project" ? (
        <NewProjectDialog
          projects={projects ?? []}
          onClose={() => setDialog(null)}
          onCreate={async (input) => {
            const result = await runCommand({ type: "project.create", ...input });
            if (result && result.type === "project.created" && "projectId" in result) {
              setDialog(null);
              props.onT3Changed();
              rememberProject(result.projectId as string);
              setFocus(result.projectId as string);
            }
          }}
        />
      ) : null}
      {dialog?.kind === "room" ? (
        <NewRoomDialog
          initialProjectId={dialog.projectId}
          onClose={() => setDialog(null)}
          onCreate={async (projectId, title) => {
            const result = await runCommand({ type: "room.create", projectId, title });
            if (result && "roomId" in result && result.roomId) {
              setDialog(null);
              enter({ kind: "room", id: result.roomId as string });
            }
          }}
        />
      ) : null}
      {dialog?.kind === "preset" ? <PresetDialog preset={dialog.preset} runCommand={runCommand} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
