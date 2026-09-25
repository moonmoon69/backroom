import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, useDesk, useRoomStream } from "./api.ts";
import { BackgroundBar } from "./components/BackgroundBar.tsx";
import { Composer } from "./components/Composer.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { Inspector, type InspectorTab } from "./components/Inspector.tsx";
import { RoomBrowserButton } from "./components/RoomBrowser.tsx";
import { AppControls } from "./components/AppControls.tsx";
import { participantColor } from "./components/Monogram.tsx";
import { ParticipantBar } from "./components/ParticipantBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { RolesDialog } from "./components/RolesLibrary.tsx";
import { ProvidersSection } from "./components/Providers.tsx";
import { PairingPanel } from "./components/StatusStrip.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { useToast } from "./components/Toast.tsx";
import { RoomContext, type FollowUpPrefill, type RoomContextValue } from "./context.tsx";
import { useTheme } from "./theme.ts";
import { MOBILE_QUERY, mediaMatches, useMediaQuery } from "./useMediaQuery.ts";
import type { CommandResult, RoomCommand, RoomListItem, RoomSnapshot, StatusResponse } from "./types.ts";

const ROOM_KEY = "t3rooms.selectedRoom";

export function App() {
  const { toast } = useToast();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => localStorage.getItem(ROOM_KEY));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
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
          setSelectedRoomId(null);
          localStorage.removeItem(ROOM_KEY);
          setSnapshot(null);
          return;
        }
        report(error);
      });
  }, [selectedRoomId, report]);

  useEffect(() => {
    loadStatus();
    loadRooms();
    // The room list carries live activity (working, background, needs you) for the sidebar; the connection
    // status asks T3 itself, so it stays slow.
    const rooms = setInterval(loadRooms, 8000);
    const status = setInterval(loadStatus, 30000);
    return () => {
      clearInterval(rooms);
      clearInterval(status);
    };
  }, [loadStatus, loadRooms]);

  useEffect(() => {
    if (selectedRoomId) localStorage.setItem(ROOM_KEY, selectedRoomId);
    loadSnapshot();
  }, [selectedRoomId, loadSnapshot]);

  // Pick the first room automatically when nothing is selected.
  useEffect(() => {
    if (!selectedRoomId && rooms.length > 0) {
      const first = rooms[0];
      if (first) setSelectedRoomId(first.id);
    }
  }, [rooms, selectedRoomId]);

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
            setSelectedRoomId(next ? next.id : null);
          }
          loadRooms();
        } else if (command.type.startsWith("room.")) loadRooms();
        else onRoomChanged();
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
    [loadRooms, onRoomChanged, report, toast, selectedRoomId, rooms],
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

  // Phones: the room list is a drawer opened from the header.
  const roomsButton = (
    <button type="button" className="small ghost icon-only mobile-only rooms-toggle" aria-label="Rooms" title="Rooms" onClick={() => setSidebarOpen(true)}>
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
        selectedRoomId={selectedRoomId}
        onSelect={(roomId) => {
          setSelectedRoomId(roomId);
          setSidebarOpen(false);
        }}
        onCommand={runCommand}
        disabled={needsPairing}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
        {contextValue ? (
          <RoomContext.Provider value={contextValue}>
            <div className="room-header">
              {roomsButton}
              <h1 className="room-title">{contextValue.snapshot.room.title}</h1>
              <span className="room-project mono" title="T3 project id">
                {contextValue.snapshot.room.projectId}
              </span>
              <span className="spacer" />
              <RoomBrowserButton />
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
            {needsPairing ? null : rooms.length === 0 ? (
              <>
                <p className="serif">Open a room to start handing out work orders.</p>
                <p className="mono muted">New room → pick a T3 project → add a participant → @alias do the thing</p>
              </>
            ) : (
              <p className="serif muted">Loading room…</p>
            )}
          </div>
          </>
        )}
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
