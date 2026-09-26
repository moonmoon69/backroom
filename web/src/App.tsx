import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, useDesk, useGit, useRoomStream } from "./api.ts";
import { BackgroundBar } from "./components/BackgroundBar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { BrowserView } from "./components/BrowserView.tsx";
import { Composer } from "./components/Composer.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { Inspector, PanelButtons, type InspectorTab } from "./components/Inspector.tsx";
import { PageTitle } from "./components/PageTitle.tsx";
import { MenuIcon } from "./components/icons.tsx";
import { AppControls } from "./components/AppControls.tsx";
import { participantColor } from "./components/Monogram.tsx";
import { RoomHeaderMenu } from "./components/RoomActions.tsx";
import { rememberProject, Sidebar, SidebarRail, type Selection } from "./components/Sidebar.tsx";
import { ArchivedThreadView, NewThreadView, ThreadView } from "./components/ThreadView.tsx";
import { RolesDialog } from "./components/RolesLibrary.tsx";
import { ProvidersSection } from "./components/Providers.tsx";
import { ConnectionChip, PairingPanel } from "./components/StatusStrip.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { useToast } from "./components/Toast.tsx";
import { RoomContext, type FollowUpPrefill, type RoomContextValue } from "./context.tsx";
import { useTheme } from "./theme.ts";
import { MOBILE_QUERY, mediaMatches, useMediaQuery } from "./useMediaQuery.ts";
import type { BrowserListItem, CommandResult, RoomCommand, RoomListItem, RoomSnapshot, StatusResponse, T3Project, T3ThreadShell } from "./types.ts";

const SELECTION_KEY = "t3rooms.selection";
/** The room side panel's last tab and whether it was open, so a reload keeps the layout. */
const PANEL_KEY = "t3rooms.panel";
const PANEL_TABS: InspectorTab[] = ["people", "browser", "tasks", "git"];
/** Whether the sidebar is hidden on a desktop (phones always have it as a drawer instead). */
const SIDEBAR_COLLAPSED_KEY = "t3rooms.sidebarCollapsed";

function storedPanel(): { open: boolean; tab: InspectorTab } {
  // Phones start with the panel closed: it covers the timeline there.
  const fallback = { open: !mediaMatches(MOBILE_QUERY), tab: "tasks" as InspectorTab };
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null") as { open?: unknown; tab?: unknown } | null;
    if (!parsed) return fallback;
    // Tabs since renamed: Board is Tasks, Changes is Git.
    const renamed = parsed.tab === "board" ? "tasks" : parsed.tab === "changes" ? "git" : parsed.tab;
    const tab = PANEL_TABS.includes(renamed as InspectorTab) ? (renamed as InspectorTab) : fallback.tab;
    return { open: mediaMatches(MOBILE_QUERY) ? false : parsed.open !== false, tab };
  } catch {
    return fallback;
  }
}
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
  const [inspectorOpen, setInspectorOpen] = useState(() => storedPanel().open);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  useEffect(() => {
    if (sidebarCollapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  }, [sidebarCollapsed]);
  const collapsed = sidebarCollapsed && !isMobile;
  // ⌘B / Ctrl+B hides and shows the sidebar on a desktop.
  useEffect(() => {
    if (isMobile) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isMobile]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => storedPanel().tab);
  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ open: inspectorOpen, tab: inspectorTab }));
  }, [inspectorOpen, inspectorTab]);
  // A header switch opens the panel on its tab; the switch of the tab already showing closes it.
  const togglePanel = useCallback(
    (tab: InspectorTab) => {
      if (inspectorOpen && inspectorTab === tab) setInspectorOpen(false);
      else {
        setInspectorTab(tab);
        setInspectorOpen(true);
      }
    },
    [inspectorOpen, inspectorTab],
  );
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

  // The page you were on before "New thread", so cancelling it goes back there.
  const lastPage = useRef<Selection | null>(null);
  useEffect(() => {
    if (selection && selection.kind !== "new-thread") lastPage.current = selection;
  }, [selection]);
  const cancelNewThread = useCallback(() => {
    const back = lastPage.current;
    // Back to the page before, if it still exists; otherwise no selection (the first room opens by itself).
    const exists =
      back &&
      (back.kind === "room" ? rooms.some((r) => r.id === back.id) : back.kind === "thread" ? threads.some((t) => t.id === back.id) : back.kind === "browser" ? Boolean(browsers?.some((b) => b.id === back.id)) : false);
    setSelection(exists ? back : null);
  }, [rooms, threads, browsers]);

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
  const deskInterval = deskRunning || snapshotRunning ? 2500 : 10000;
  const { desk, error: deskError } = useDesk(snapshot ? snapshot.room.id : null, deskInterval);

  // Git: the folder and commit count the Git tab shows start over in each room.
  const [gitPath, setGitPath] = useState<string | null>(null);
  const [gitCommits, setGitCommits] = useState(30);
  useEffect(() => {
    setGitPath(null);
    setGitCommits(30);
  }, [snapshot?.room.id]);
  const gitRead = useGit(snapshot ? snapshot.room.id : null, { detail: inspectorOpen && inspectorTab === "git", path: gitPath, commits: gitCommits });
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
      git: {
        data: gitRead.git,
        error: gitRead.error,
        path: gitPath,
        setPath: (path) => {
          setGitPath(path);
          setGitCommits(30);
        },
        commits: gitCommits,
        showMoreCommits: () => setGitCommits((n) => n + 50),
      },
    };
  }, [snapshot, runCommand, onRoomChanged, desk, deskError, gitRead.git, gitRead.error, gitPath, gitCommits]);

  const needsPairing = status !== null && status.adapter === "http" && !status.t3.paired;

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

  // The app-wide controls sit at the foot of the sidebar; on phones, the ☰ that opens it carries a red dot when T3 has
  // a problem (the collapsed rail shows the connection itself).
  const t3Problem = status !== null && status.adapter === "http" && (Boolean(status.t3.error) || !status.t3.paired);
  const alert = t3Problem ? <span className="dot dot-err toggle-alert" aria-label="T3 connection problem" /> : null;
  // Phones: the sidebar is a drawer opened from the header. Desktops: collapsed, it is a rail beside the page.
  const roomsButton = isMobile ? (
    <button type="button" className="small ghost icon-only rooms-toggle" aria-label="Rooms and threads" title="Rooms and threads" onClick={() => setSidebarOpen(true)}>
      <MenuIcon />
      {alert}
    </button>
  ) : null;

  return (
    <div className={`app${isMobile ? " app-mobile" : ""}${collapsed ? " sidebar-collapsed" : ""}`}>
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
        onCancelNewThread={selection?.kind === "new-thread" ? cancelNewThread : undefined}
        footer={appControls}
        onCollapse={isMobile ? undefined : () => setSidebarCollapsed(true)}
        disabled={needsPairing}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {collapsed ? (
        <SidebarRail
          rooms={rooms}
          projects={projects}
          selection={selection}
          onSelect={setSelection}
          onExpand={() => setSidebarCollapsed(false)}
          connection={<ConnectionChip status={status} onOpen={() => setPairingOpen(true)} compact />}
        />
      ) : null}
      <div className="main">
        {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
        <ErrorBoundary
          key={selection ? `${selection.kind}:${selection.kind === "new-thread" ? selection.projectId : selection.id}` : "none"}
          onReset={() => setSelection(null)}
          header={
            <div className="room-header app-header-only">{roomsButton}</div>
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
            onCancel={cancelNewThread}
            headerStart={roomsButton}
          />
        ) : contextValue ? (
          <RoomContext.Provider value={contextValue}>
            <div className="room-header">
              {roomsButton}
              <PageTitle
                context={projects?.find((p) => p.id === contextValue.snapshot.room.projectId)?.title ?? null}
                contextTitle={projects?.find((p) => p.id === contextValue.snapshot.room.projectId)?.workspaceRoot}
                name={contextValue.snapshot.room.title}
              />
              <span className="spacer" />
              <PanelButtons open={inspectorOpen} tab={inspectorTab} onToggle={togglePanel} />
              <RoomHeaderMenu projectTitle={projects?.find((p) => p.id === contextValue.snapshot.room.projectId)?.title ?? null} />
            </div>
            {/* Everything under the header: on phones the side panel covers exactly this area. */}
            <div className="room-under">
              <div className="room-body">
                <div className="room-centre">
                  <Timeline />
                  <BackgroundBar />
                  <Composer followUp={followUp} />
                </div>
                {inspectorOpen ? (
                  <Inspector
                    tab={inspectorTab}
                    onClose={() => setInspectorOpen(false)}
                    onManageBrowser={(browserId) => {
                      const target = browserId ?? browsers?.[0]?.id;
                      if (target) setSelection({ kind: "browser", id: target });
                    }}
                  />
                ) : null}
              </div>
            </div>
          </RoomContext.Provider>
        ) : (
          <>
          <div className="room-header app-header-only">{roomsButton}</div>
          <div className="empty-state">
            {needsPairing ? null : selection?.kind === "room" ? (
              <p className="serif muted">Loading room…</p>
            ) : (
              <>
                <p className="serif">Start a thread on its own, or open a room to hand out work orders to a crew.</p>
                <p className="mono muted">New → New thread · New → New room → add a participant → @alias do the thing</p>
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
