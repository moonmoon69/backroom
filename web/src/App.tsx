import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, useDesk, useRoomStream } from "./api.ts";
import { BackgroundBar } from "./components/BackgroundBar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { BrowserView } from "./components/BrowserView.tsx";
import { Composer } from "./components/Composer.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { Inspector, type InspectorTab } from "./components/Inspector.tsx";
import { RoomBrowserButton } from "./components/RoomBrowser.tsx";
import { AppControls } from "./components/AppControls.tsx";
import { participantColor } from "./components/Monogram.tsx";
import { ParticipantBar } from "./components/ParticipantBar.tsx";
import { rememberProject, Sidebar, type Selection } from "./components/Sidebar.tsx";
import { ArchivedThreadView, NewThreadView, ThreadView } from "./components/ThreadView.tsx";
import { RolesDialog } from "./components/RolesLibrary.tsx";
import { ProvidersSection } from "./components/Providers.tsx";
import { PairingPanel } from "./components/StatusStrip.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { useToast } from "./components/Toast.tsx";
import { RoomContext, type FollowUpPrefill, type RoomContextValue } from "./context.tsx";
import { useTheme } from "./theme.ts";
import { MOBILE_QUERY, mediaMatches, useMediaQuery } from "./useMediaQuery.ts";
import type { BrowserListItem, CommandResult, RoomCommand, RoomListItem, RoomSnapshot, StatusResponse, T3Project, T3ThreadShell } from "./types.ts";

const SELECTION_KEY = "t3rooms.selection";
/** Where the selected room was kept before threads could be selected too. */
const LEGACY_ROOM_KEY = "t3rooms.selectedRoom";

function storedSelection(): Selection | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
    if (parsed && (parsed.kind === "room" || parsed.kind === "thread" || parsed.kind === "browser") && typeof parsed.id === "string") return parsed;
    if (parsed && parsed.kind === "new-thread" && typeof parsed.projectId === "string") return parsed;
  } catch {
    // fall through
  }
  const legacy = localStorage.getItem(LEGACY_ROOM_KEY);
  return legacy ? { kind: "room", id: legacy } : null;
}

export function App() {
  const { toast } = useToast();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [selection, setSelection] = useState<Selection | null>(storedSelection);
  const selectedRoomId = selection?.kind === "room" ? selection.id : null;
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  // T3's projects and threads, for the sidebar. Kept at the last good reading while T3 does not answer.
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [threads, setThreads] = useState<T3ThreadShell[]>([]);
  const [t3Error, setT3Error] = useState<string | null>(null);
  // Archive and unarchive switch the view before the next thread-list read confirms them.
  const markThread = useCallback((threadId: string, patch: Partial<T3ThreadShell>) => {
    setThreads((list) => list.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)));
  }, []);
  // T3 serves an archived thread's conversation only after it is unarchived; such a selection gets its own panel.
  const selectedArchived = selection?.kind === "thread" ? threads.find((t) => t.id === selection.id && t.archivedAt) ?? null : null;
  // Phones start with the inspector closed: it covers the timeline there.
  const [inspectorOpen, setInspectorOpen] = useState(() => !mediaMatches(MOBILE_QUERY));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("board");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [followUp, setFollowUp] = useState<FollowUpPrefill | null>(null);
  const followUpNonce = useRef(0);
  const [theme, setTheme] = useTheme();

  const report = useCallback(
    (error: unknown) => toast(error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error)),
    [toast],
  );

  const loadStatus = useCallback(() => {
    api.status().then(setStatus).catch(report);
  }, [report]);

  const loadRooms = useCallback(() => {
    api.rooms().then(setRooms).catch(report);
  }, [report]);

  // Polled with the room list; failures are shown once in the sidebar, not as a toast every poll.
  // Browsers are local processes: cheap to read, polled with the room list. Null when the service cannot run them.
  const [browsers, setBrowsers] = useState<BrowserListItem[] | null>(null);
  const loadBrowsers = useCallback(() => {
    api.browsers().then(
      (list) => setBrowsers(list.length > 0 ? list : null),
      () => undefined,
    );
  }, []);

  const loadT3 = useCallback(() => {
    Promise.all([api.projects(), api.allThreads()])
      .then(([projectList, threadList]) => {
        setProjects(projectList);
        setThreads(threadList);
        setT3Error(null);
      })
      .catch((error: unknown) => setT3Error(error instanceof Error ? error.message : String(error)));
  }, []);

  const loadSnapshot = useCallback(() => {
    if (!selectedRoomId) {
      setSnapshot(null);
      return;
    }
    api
      .room(selectedRoomId)
      .then(setSnapshot)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) {
          setSelection(null);
          setSnapshot(null);
          return;
        }
        report(error);
      });
  }, [selectedRoomId, report]);

  useEffect(() => {
    loadStatus();
    loadRooms();
    loadT3();
    loadBrowsers();
    // The room list and thread list carry live activity (working, background, needs you) for the sidebar; the
    // connection status asks T3 itself, so it stays slow.
    const rooms = setInterval(() => {
      loadRooms();
      loadT3();
      loadBrowsers();
    }, 8000);
    const status = setInterval(loadStatus, 30000);
    return () => {
      clearInterval(rooms);
      clearInterval(status);
    };
  }, [loadStatus, loadRooms, loadT3, loadBrowsers]);

  useEffect(() => {
    if (selection) localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    else localStorage.removeItem(SELECTION_KEY);
    localStorage.removeItem(LEGACY_ROOM_KEY);
  }, [selection]);

  useEffect(() => {
    loadSnapshot();
  }, [selectedRoomId, loadSnapshot]);

  // Pick the first room automatically when nothing is selected.
  useEffect(() => {
    if (!selection && rooms.length > 0) {
      const first = rooms[0];
      if (first) setSelection({ kind: "room", id: first.id });
    }
  }, [rooms, selection]);

  const onRoomChanged = useCallback(() => {
    loadSnapshot();
    loadRooms();
  }, [loadSnapshot, loadRooms]);
  useRoomStream(selectedRoomId, onRoomChanged);

  // Desk data: crew tiles show context on every tab, so poll every 10s while a room is open; every 2.5s while
  // Changes is visible or any participant's thread is running a turn (the timeline shows turns typed in T3 live).
  const [deskRunning, setDeskRunning] = useState(false);
  const snapshotRunning = snapshot
    ? Object.values(snapshot.participantStatus).some((s) => s.session === "running" || s.session === "starting" || s.externalActivity)
    : false;
  const deskInterval = (inspectorOpen && inspectorTab !== "board") || deskRunning || snapshotRunning ? 2500 : 10000;
  const { desk, error: deskError } = useDesk(snapshot ? snapshot.room.id : null, deskInterval);
  useEffect(() => {
    setDeskRunning(desk ? Object.values(desk.participants).some((d) => Boolean(d.runningTurn)) : false);
  }, [desk]);

  const runCommand = useCallback(
    async (command: RoomCommand): Promise<CommandResult | null> => {
      try {
        const result = await api.command(command);
        if (command.type === "room.delete") {
          // Leave the deleted room for the next one in the list (or none).
          if (selectedRoomId === command.roomId) {
            const next = rooms.find((room) => room.id !== command.roomId);
            setSelection(next ? { kind: "room", id: next.id } : null);
          }
          loadRooms();
          loadT3();
        } else if (command.type.startsWith("room.")) {
          loadRooms();
          if (command.type === "room.browser") loadBrowsers();
        } else if (command.type.startsWith("browser.")) loadBrowsers();
        else if (command.type === "project.create" || command.type.startsWith("thread.")) loadT3();
        else {
          onRoomChanged();
          // Seating or removing a participant moves a thread into or out of the sidebar's thread list.
          if (command.type === "participant.create" || command.type === "participant.retire" || command.type === "participant.rebind") loadT3();
        }
        return result;
      } catch (error) {
        if (error instanceof ApiError && error.code === "stale_revision") {
          toast(`The task changed since you loaded it; refreshed. ${error.message}`);
          onRoomChanged();
          return null;
        }
        if (error instanceof ApiError && error.issues && error.issues.length > 0) {
          toast(`${error.message}`);
          return null;
        }
        report(error);
        return null;
      }
    },
    [loadRooms, loadT3, loadBrowsers, onRoomChanged, report, toast, selectedRoomId, rooms],
  );

  const contextValue = useMemo<RoomContextValue | null>(() => {
    if (!snapshot) return null;
    const byId = new Map(snapshot.participants.map((p) => [p.id, p]));
    const indexById = new Map(snapshot.participants.map((p, index) => [p.id, index]));
    return {
      snapshot,
      runCommand,
      refetch: onRoomChanged,
      participantById: (id) => byId.get(id),
      aliasOf: (id) => byId.get(id)?.alias ?? id,
      colorOf: (id) => participantColor(indexById.get(id) ?? 0),
      addFollowUp: (prerequisites) => {
        followUpNonce.current += 1;
        setFollowUp({ prerequisites, nonce: followUpNonce.current });
      },
      desk,
      deskError,
    };
  }, [snapshot, runCommand, onRoomChanged, desk, deskError]);

  const needsPairing = status !== null && status.adapter === "http" && !status.t3.paired;
  const openRequests = snapshot?.nativeRequests.length ?? 0;
  const pendingCount = snapshot
    ? snapshot.tasks.filter((t) => ["queued", "held", "blocked", "needs_input"].includes(t.state)).length
    : 0;

  const onPaired = () => {
    setPairingOpen(false);
    loadStatus();
    loadRooms();
    loadT3();
  };

  // After a rebuild the server serves a new bundle; offer a reload instead of silently running old code.
  const loadedBuild = useMemo(
    () => [...document.scripts].map((script) => /assets\/(index-[^/]+\.js)/.exec(script.src)?.[1]).find(Boolean) ?? null,
    [],
  );
  const staleUi = Boolean(status?.uiBuild && loadedBuild && status.uiBuild !== loadedBuild);

  const appControls = (
    <AppControls
      status={status}
      onOpenConnection={() => setPairingOpen(true)}
      onOpenLibrary={() => setLibraryOpen(true)}
      rolesDisabled={needsPairing}
      theme={theme}
      onTheme={setTheme}
    />
  );

  // Phones: the sidebar is a drawer opened from the header.
  const roomsButton = (
    <button type="button" className="small ghost icon-only mobile-only rooms-toggle" aria-label="Rooms and threads" title="Rooms and threads" onClick={() => setSidebarOpen(true)}>
      <span aria-hidden="true">☰</span>
    </button>
  );

  return (
    <div className={`app${isMobile ? " app-mobile" : ""}`}>
      {staleUi ? (
        <div className="update-banner" role="status">
          <span>The room UI was updated.</span>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      <Sidebar
        rooms={rooms}
        projects={projects}
        threads={threads}
        t3Error={t3Error}
        selection={selection}
        onSelect={(next) => {
          setSelection(next);
          setSidebarOpen(false);
        }}
        onCommand={runCommand}
        onT3Changed={loadT3}
        browsers={browsers}
        onBrowsersChanged={loadBrowsers}
        disabled={needsPairing}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
        <ErrorBoundary
          key={selection ? `${selection.kind}:${selection.kind === "new-thread" ? selection.projectId : selection.id}` : "none"}
          onReset={() => setSelection(null)}
          header={
            <div className="room-header app-header-only">
              {roomsButton}
              <span className="spacer" />
              {appControls}
            </div>
          }
        >
        {selection?.kind === "thread" && selectedArchived && !needsPairing ? (
          <ArchivedThreadView
            thread={selectedArchived}
            project={projects?.find((p) => p.id === selectedArchived.projectId) ?? null}
            runCommand={runCommand}
            onUnarchived={() => {
              markThread(selectedArchived.id, { archivedAt: null });
              loadT3();
            }}
            onGone={() => {
              setSelection(null);
              loadT3();
            }}
            headerStart={roomsButton}
            headerEnd={appControls}
          />
        ) : selection?.kind === "thread" && !needsPairing ? (
          <ThreadView
            threadId={selection.id}
            rooms={rooms}
            browsers={browsers}
            runCommand={runCommand}
            onGone={() => {
              setSelection(null);
              loadT3();
            }}
            onChanged={loadT3}
            onArchived={() => {
              markThread(selection.id, { archivedAt: new Date().toISOString() });
              loadT3();
            }}
            onOpenRoom={(roomId) => {
              setSelection({ kind: "room", id: roomId });
              loadRooms();
              loadT3();
            }}
            headerStart={roomsButton}
            headerEnd={appControls}
          />
        ) : selection?.kind === "browser" ? (
          <BrowserView
            browserId={selection.id}
            runCommand={runCommand}
            onGone={() => {
              setSelection(null);
              loadBrowsers();
            }}
            onChanged={loadBrowsers}
            onOpenRoom={(roomId) => setSelection({ kind: "room", id: roomId })}
            headerStart={roomsButton}
            headerEnd={appControls}
          />
        ) : selection?.kind === "new-thread" && !needsPairing ? (
          <NewThreadView
            projectId={selection.projectId}
            projects={projects ?? []}
            browsers={browsers}
            runCommand={runCommand}
            onProject={(projectId) => {
              rememberProject(projectId);
              setSelection({ kind: "new-thread", projectId });
            }}
            onStarted={(threadId) => {
              setSelection({ kind: "thread", id: threadId });
              loadT3();
            }}
            headerStart={roomsButton}
            headerEnd={appControls}
          />
        ) : contextValue ? (
          <RoomContext.Provider value={contextValue}>
            <div className="room-header">
              {roomsButton}
              <h1 className="room-title">{contextValue.snapshot.room.title}</h1>
              <span className="room-project mono" title="T3 project id">
                {contextValue.snapshot.room.projectId}
              </span>
              <span className="spacer" />
              <RoomBrowserButton
                onManage={(browserId) => {
                  const target = browserId ?? browsers?.[0]?.id;
                  if (target) setSelection({ kind: "browser", id: target });
                }}
              />
              <button
                type="button"
                className={`small${inspectorOpen ? " active" : ""}`}
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen((v) => !v)}
              >
                Queue {pendingCount > 0 ? `(${pendingCount})` : ""}
                {openRequests > 0 ? <span className="pill pill-input"> {openRequests} need input</span> : null}
              </button>
              <span className="header-divider" aria-hidden="true" />
              {appControls}
            </div>
            {/* Everything under the header: on phones the inspector sheet covers exactly this area. */}
            <div className="room-under">
              <ParticipantBar />
              <div className="room-body">
                <div className="room-centre">
                  <Timeline />
                  <BackgroundBar />
                  <Composer followUp={followUp} />
                </div>
                {inspectorOpen ? (
                  <Inspector tab={inspectorTab} onTab={setInspectorTab} onClose={() => setInspectorOpen(false)} />
                ) : null}
              </div>
            </div>
          </RoomContext.Provider>
        ) : (
          <>
          <div className="room-header app-header-only">
            {roomsButton}
            <span className="spacer" />
            {appControls}
          </div>
          <div className="empty-state">
            {needsPairing ? null : selection?.kind === "room" ? (
              <p className="serif muted">Loading room…</p>
            ) : (
              <>
                <p className="serif">Start a thread on its own, or open a room to hand out work orders to a crew.</p>
                <p className="mono muted">+ New → New thread · + New → New room → add a participant → @alias do the thing</p>
              </>
            )}
          </div>
          </>
        )}
        </ErrorBoundary>
      </div>
      {pairingOpen ? (
        <Dialog title="T3 connection" onClose={() => setPairingOpen(false)} wide>
          <PairingPanel status={status} onPaired={onPaired} embedded />
          <ProvidersSection />
        </Dialog>
      ) : null}
      {libraryOpen ? (
        <RolesDialog runCommand={runCommand} onClose={() => setLibraryOpen(false)} />
      ) : null}
    </div>
  );
}
