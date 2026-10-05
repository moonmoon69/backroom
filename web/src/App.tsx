import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How long the overview's drawer takes to slide in (styles.css, ov-slide). */
const SLIDE_MS = 160;
import { api, ApiError, useDesk, useGit, useRoomCosts, useRoomStream } from "./api.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { BrowserView } from "./components/BrowserView.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { Inspector, PanelButtons, type InspectorTab } from "./components/Inspector.tsx";
import { PageTitle } from "./components/PageTitle.tsx";
import { StreetMode } from "./components/street/StreetMode.tsx";
import { MenuIcon } from "./components/icons.tsx";
import { AppControls } from "./components/AppControls.tsx";
import { MEMBER_ACCENT } from "./components/Monogram.tsx";
import { RoomHeaderMenu } from "./components/RoomActions.tsx";
import { rememberProject, Sidebar, SidebarRail, type Selection } from "./components/Sidebar.tsx";
import { ArchivedThreadView, NewThreadView, ThreadView } from "./components/ThreadView.tsx";
import { PresetDropZone, PresetsContext } from "./components/presets.tsx";
import { ProvidersSection } from "./components/Providers.tsx";
import { ConnectionChip, PairingPanel } from "./components/StatusStrip.tsx";
import { UpdatesButton } from "./components/Updates.tsx";
import { FilePreviewHost } from "./components/FilePreview.tsx";
import { RoomCentre } from "./components/RoomCentre.tsx";
import { ConsigliereStart } from "./components/ConsigliereStart.tsx";
import { useToast } from "./components/Toast.tsx";
import { RoomContext, type FollowUpPrefill, type RoomContextValue } from "./context.tsx";
import { useSkin } from "./skin.ts";
import { Overview } from "./components/Overview.tsx";
import { OverviewRoom } from "./components/OverviewRoom.tsx";
import { CloseIcon } from "./components/icons.tsx";
import { useTheme } from "./theme.ts";
import { MOBILE_QUERY, mediaMatches, useMediaQuery } from "./useMediaQuery.ts";
import { roomKey, threadKey, useFinishNotifications, useLooking } from "./news.ts";
import { usePresence } from "./presence.ts";
import { isRunActive, type BrowserListItem, type CommandResult, type Preset, type RoomCommand, type RoomListItem, type RoomSnapshot, type StatusResponse, type T3Project, type T3ThreadShell } from "./types.ts";

const SELECTION_KEY = "backroom.selection";
/** The room side panel's last tab and whether it was open, so a reload keeps the layout. */
const PANEL_KEY = "backroom.panel";
const PANEL_TABS: InspectorTab[] = ["people", "browser", "tasks", "git"];
/** Whether the sidebar is hidden on a desktop (phones always have it as a drawer instead). */
const SIDEBAR_COLLAPSED_KEY = "backroom.sidebarCollapsed";

function storedPanel(): { open: boolean; tab: InspectorTab } {
  // Phones start with the panel closed: it covers the timeline there.
  const fallback = { open: !mediaMatches(MOBILE_QUERY), tab: "people" as InspectorTab };
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null") as { open?: unknown; tab?: unknown } | null;
    if (!parsed) return fallback;
    // Tabs since renamed: Board is Tasks, Changes is Git.
    // Tasks has no header button any more (the status bar above the conversation took its place): Members opens instead.
    const renamed = parsed.tab === "board" || parsed.tab === "tasks" ? "people" : parsed.tab === "changes" ? "git" : parsed.tab;
    const tab = PANEL_TABS.includes(renamed as InspectorTab) ? (renamed as InspectorTab) : fallback.tab;
    return { open: mediaMatches(MOBILE_QUERY) ? false : parsed.open !== false, tab };
  } catch {
    return fallback;
  }
}
/** Where the selected room was kept before threads could be selected too. */
const LEGACY_ROOM_KEY = "backroom.selectedRoom";

function storedSelection(): Selection | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
    if (parsed && (parsed.kind === "room" || parsed.kind === "thread" || parsed.kind === "browser") && typeof parsed.id === "string") return parsed;
    if (parsed && (parsed.kind === "new-thread" || parsed.kind === "consigliere") && typeof parsed.projectId === "string") return parsed;
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
  const [followUp, setFollowUp] = useState<FollowUpPrefill | null>(null);
  const followUpNonce = useRef(0);
  const [theme, setTheme] = useTheme();
  const [skin] = useSkin();
  // Out on the street (Look → Street) or on the overview page (Look → Overview), the room last opened stays open but
  // is not the one being looked at.
  const [outside, setOutside] = useState(false);
  // Look → Overview opens on the overview page; a room opened from there shows without the sidebar, with a way back.
  useEffect(() => {
    if (skin === "overview") setOutside(true);
  }, [skin]);
  useEffect(() => {
    if (skin !== "overview" || outside) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open], .dialog")) setOutside(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [skin, outside]);

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

  // Presets change only from this UI (or another tab of it), so they are read at the start and after a change.
  const [presets, setPresets] = useState<Preset[]>([]);
  const loadPresets = useCallback(() => {
    api.presets().then(setPresets).catch(() => undefined);
  }, []);
  const presetsValue = useMemo(() => ({ presets, reload: loadPresets }), [presets, loadPresets]);

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
    loadPresets();
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
  }, [loadStatus, loadRooms, loadT3, loadBrowsers, loadPresets]);

  // The page you were on before "New thread", so cancelling it goes back there.
  const lastPage = useRef<Selection | null>(null);
  useEffect(() => {
    if (selection && selection.kind !== "new-thread" && selection.kind !== "consigliere") lastPage.current = selection;
  }, [selection]);
  const cancelNewThread = useCallback(() => {
    // From the overview, leaving the new-thread page is closing the drawer.
    if (skin === "overview") {
      setOutside(true);
      return;
    }
    const back = lastPage.current;
    // Back to the page before, if it still exists; otherwise no selection (the first room opens by itself).
    const exists =
      back &&
      (back.kind === "room" ? rooms.some((r) => r.id === back.id) : back.kind === "thread" ? threads.some((t) => t.id === back.id) : back.kind === "browser" ? Boolean(browsers?.some((b) => b.id === back.id)) : false);
    setSelection(exists ? back : null);
  }, [rooms, threads, browsers, skin]);

  useEffect(() => {
    if (selection) localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    else localStorage.removeItem(SELECTION_KEY);
    localStorage.removeItem(LEGACY_ROOM_KEY);
  }, [selection]);

  useEffect(() => {
    loadSnapshot();
  }, [selectedRoomId, loadSnapshot]);

  // Pick the first room automatically when nothing is selected (the overview starts on its page of cards instead).
  useEffect(() => {
    if (skin === "overview") return;
    if (!selection && rooms.length > 0) {
      const first = rooms[0];
      if (first) setSelection({ kind: "room", id: first.id });
    }
  }, [rooms, selection, skin]);

  const onRoomChanged = useCallback(() => {
    loadSnapshot();
    loadRooms();
  }, [loadSnapshot, loadRooms]);
  useRoomStream(selectedRoomId, onRoomChanged);
  // Backroom in place of T3's window: keeps T3 checking plan usage and harnesses while this page is in use.
  usePresence();

  // ---- news: what finished while you were not looking (see news.ts) ----
  const looking = useLooking();
  const lookingHere = looking && !((skin === "street" || skin === "overview") && outside);
  const openKey = selection?.kind === "room" ? roomKey(selection.id) : selection?.kind === "thread" ? threadKey(selection.id) : null;
  const openNewsAt =
    selection?.kind === "room" ? rooms.find((r) => r.id === selection.id)?.news?.latest?.at : selection?.kind === "thread" ? threads.find((t) => t.id === selection.id)?.news?.at : undefined;
  // The open room or thread is seen up to its newest finish while you look at it, on every device.
  useEffect(() => {
    if (!openKey || !openNewsAt || !lookingHere) return;
    api.markSeen(openKey, openNewsAt).then(
      () => {
        setRooms((list) => list.map((room) => (roomKey(room.id) === openKey && room.news?.latest?.at === openNewsAt ? { ...room, news: { unseen: 0, latest: null } } : room)));
        setThreads((list) => list.map((thread) => (threadKey(thread.id) === openKey && thread.news?.at === openNewsAt ? { ...thread, news: null } : thread)));
      },
      // A service older than marks: its lists carry no news either.
      () => undefined,
    );
  }, [openKey, openNewsAt, lookingHere]);
  // The sidebar leaves out the news of what you are looking at, so it does not flash before the mark lands.
  const sideRooms = useMemo(
    () => (lookingHere && selection?.kind === "room" ? rooms.map((room) => (room.id === selection.id && room.news?.unseen ? { ...room, news: { unseen: 0, latest: null } } : room)) : rooms),
    [rooms, lookingHere, selection],
  );
  const sideThreads = useMemo(
    () => (lookingHere && selection?.kind === "thread" ? threads.map((thread) => (thread.id === selection.id && thread.news ? { ...thread, news: null } : thread)) : threads),
    [threads, lookingHere, selection],
  );
  // The tab's title counts what is new, so a background tab shows it: "(3) Backroom".
  const newCount = sideRooms.reduce((sum, room) => sum + (room.news?.unseen ?? 0), 0) + sideThreads.filter((thread) => thread.news).length;
  useEffect(() => {
    document.title = newCount > 0 ? `(${newCount}) Backroom` : "Backroom";
  }, [newCount]);
  useFinishNotifications(rooms, threads, looking, (key) => {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (kind === "room" || kind === "thread") setSelection({ kind, id });
    setSidebarOpen(false);
  });

  // Desk data: crew tiles show context on every tab, so poll every 10s while a room is open; every 2.5s while
  // Changes is visible or any participant's thread is running a turn (the timeline shows turns typed in T3 live).
  const [deskRunning, setDeskRunning] = useState(false);
  const snapshotRunning = snapshot
    ? Object.values(snapshot.participantStatus).some((s) => isRunActive(s.status) || s.externalActivity)
    : false;
  const deskInterval = deskRunning || snapshotRunning ? 2500 : 10000;
  const { desk, error: deskError } = useDesk(snapshot ? snapshot.room.id : null, deskInterval);
  const costs = useRoomCosts(snapshot ? snapshot.room.id : null, snapshot ? snapshot.events.filter((e) => e.kind === "assistant.reply" || e.kind === "t3.turn").length : 0);

  // Git: the folder and commit count the Git tab shows start over in each room.
  const [gitPath, setGitPath] = useState<string | null>(null);
  const [gitCommits, setGitCommits] = useState(30);
  useEffect(() => {
    setGitPath(null);
    setGitCommits(30);
  }, [snapshot?.room.id]);
  const gitRead = useGit(snapshot ? snapshot.room.id : null, { detail: inspectorOpen && inspectorTab === "git", path: gitPath, commits: gitCommits });
  useEffect(() => {
    setDeskRunning(desk ? Object.values(desk.participants).some((d) => Boolean(d.runningRun)) : false);
  }, [desk]);

  const runCommand = useCallback(
    async (command: RoomCommand): Promise<CommandResult | null> => {
      try {
        const result = await api.command(command);
        if (command.type === "room.delete") {
          // Leave the deleted room: on the desk for the next one in the list (or none); from the overview, back to
          // the page of cards.
          if (skin === "overview") {
            if (selectedRoomId === command.roomId) setSelection(null);
            setOutside(true);
          } else if (selectedRoomId === command.roomId) {
            const next = rooms.find((room) => room.id !== command.roomId);
            setSelection(next ? { kind: "room", id: next.id } : null);
          }
          loadRooms();
          loadT3();
        } else if (command.type.startsWith("room.")) {
          loadRooms();
          if (command.type === "room.browser") loadBrowsers();
        } else if (command.type.startsWith("browser.")) loadBrowsers();
        else if (command.type.startsWith("preset.")) loadPresets();
        else if (command.type === "project.create" || command.type === "project.reorder" || command.type.startsWith("thread.")) loadT3();
        else {
          onRoomChanged();
          // Seating or removing a participant moves a thread into or out of the sidebar's thread list.
          if (command.type === "participant.create" || command.type === "participant.fromPreset" || command.type === "participant.retire" || command.type === "participant.rebind") loadT3();
          // A preset may be seated in a room other than the open one: its count in the list changes.
          if (command.type === "participant.fromPreset") loadRooms();
          // A deleted role is cleared from the presets that had it.
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
    [loadRooms, loadT3, loadBrowsers, loadPresets, onRoomChanged, report, toast, selectedRoomId, rooms, skin],
  );

  const seatPreset = useCallback(
    async (roomId: string, presetId: string) => {
      const result = await runCommand({ type: "participant.fromPreset", roomId, presetId });
      if (!result || !("alias" in result) || !result.alias) return;
      const room = rooms.find((r) => r.id === roomId);
      toast(`@${result.alias} is seated${room ? ` in ${room.title}` : ""}, on a new thread`, "success");
    },
    [runCommand, rooms, toast],
  );

  const contextValue = useMemo<RoomContextValue | null>(() => {
    if (!snapshot) return null;
    const byId = new Map(snapshot.participants.map((p) => [p.id, p]));
    return {
      snapshot,
      runCommand,
      refetch: onRoomChanged,
      participantById: (id) => byId.get(id),
      aliasOf: (id) => byId.get(id)?.alias ?? id,
      colorOf: () => MEMBER_ACCENT,
      addFollowUp: (prerequisites) => {
        followUpNonce.current += 1;
        setFollowUp({ prerequisites, nonce: followUpNonce.current });
      },
      desk,
      deskError,
      costs,
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
  }, [snapshot, runCommand, onRoomChanged, desk, deskError, costs, gitRead.git, gitRead.error, gitPath, gitCommits]);

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

  // Look → Overview: a room opens over the page of cards, and this closes it.
  const overviewButton =
    skin === "overview" ? (
      <button type="button" className="small ghost icon-only overview-back" aria-label="Back to the overview" title="Back to the overview (Esc)" onClick={() => setOutside(true)}>
        <CloseIcon />
      </button>
    ) : null;

  // The page for what is selected: a room, a thread, a browser, a new thread. The desk puts it beside the sidebar;
  // the overview shows it over its cards.
  const mainBlock = (
      <div className="main">
        {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
        <ErrorBoundary
          key={selection ? `${selection.kind}:${selection.kind === "new-thread" || selection.kind === "consigliere" ? selection.projectId : selection.id}` : "none"}
          onReset={() => setSelection(null)}
          header={
            <div className="room-header app-header-only">{overviewButton ?? roomsButton}</div>
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
            headerStart={overviewButton ?? roomsButton}
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
            headerStart={overviewButton ?? roomsButton}
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
            headerStart={overviewButton ?? roomsButton}
          />
        ) : selection?.kind === "consigliere" && !needsPairing ? (
          <ConsigliereStart
            projectId={selection.projectId}
            projects={projects ?? []}
            runCommand={runCommand}
            onStarted={(roomId) => {
              loadRooms();
              loadT3();
              setSelection({ kind: "room", id: roomId });
            }}
            onCancel={cancelNewThread}
            headerStart={overviewButton ?? roomsButton}
          />
        ) : selection?.kind === "new-thread" && !needsPairing ? (
          <NewThreadView
            projectId={selection.projectId}
            presetId={selection.presetId ?? null}
            projects={projects ?? []}
            browsers={browsers}
            runCommand={runCommand}
            onProject={(projectId) => {
              rememberProject(projectId);
              setSelection({ kind: "new-thread", projectId, ...(selection.presetId ? { presetId: selection.presetId } : {}) });
            }}
            onStarted={(threadId) => {
              setSelection({ kind: "thread", id: threadId });
              loadT3();
            }}
            onCancel={cancelNewThread}
            headerStart={overviewButton ?? roomsButton}
          />
        ) : contextValue ? (
          <RoomContext.Provider value={contextValue}>
            <div className="room-header">
              {overviewButton ?? roomsButton}
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
            <PresetDropZone
              className="room-under"
              label={`Drop to seat them in ${contextValue.snapshot.room.title}`}
              onDropPreset={(presetId) => void seatPreset(contextValue.snapshot.room.id, presetId)}
            >
              <div className="room-body">
                <RoomCentre followUp={followUp} />
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
            </PresetDropZone>
          </RoomContext.Provider>
        ) : (
          <>
          <div className="room-header app-header-only">{overviewButton ?? roomsButton}</div>
          <div className="empty-state">
            {needsPairing ? null : selection?.kind === "room" ? (
              <p className="serif muted">Loading room…</p>
            ) : (
              <>
                <p className="serif">Start a thread on its own, or open a room to hand out work orders to a crew.</p>
                <p className="mono muted">New → New thread · New → New room → add a member → @alias do the thing</p>
              </>
            )}
          </div>
          </>
        )}
        </ErrorBoundary>
      </div>
  );

  // Look → Overview: one page of every room and member; a room or thread opened from it slides in over the page.
  if (skin === "overview") {
    const open = !outside && selection !== null;
    return (
      <PresetsContext.Provider value={presetsValue}>
        <FilePreviewHost>
          {staleUi ? (
            <div className="update-banner" role="status">
              <span>Backroom was updated.</span>
              <button type="button" className="primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          ) : null}
          {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
          <Overview
            rooms={sideRooms}
            projects={projects}
            threads={sideThreads}
            controls={appControls}
            onOpenRoom={(roomId) => {
              setSelection({ kind: "room", id: roomId });
              setOutside(false);
            }}
            onOpenThread={(threadId) => {
              setSelection({ kind: "thread", id: threadId });
              setOutside(false);
            }}
            onCommand={runCommand}
            onT3Changed={loadT3}
          />
          {open ? (
            // A click on the dark page outside the drawer closes it; a click inside, or in a dialog it opened, does not.
            <div
              className="ov-scrim"
              onClick={(event) => {
                if (event.target === event.currentTarget) setOutside(true);
              }}
            >
              <div className="ov-drawer" role="dialog" aria-label="Room">
                <AfterSlide
                  placeholder={
                    <div className="sheet sheet-loading">
                      <header className="sheet-head">
                        {overviewButton}
                        <div className="sheet-title">
                          <h1>{selection?.kind === "room" ? rooms.find((room) => room.id === selection.id)?.title ?? "" : ""}</h1>
                        </div>
                      </header>
                    </div>
                  }
                >
                  {selection?.kind === "room" && !needsPairing ? (
                    contextValue ? (
                      <RoomContext.Provider value={contextValue}>
                        <ErrorBoundary key={`sheet:${selection.id}`} onReset={() => setSelection(null)} header={<div className="sheet-head">{overviewButton}</div>}>
                          <OverviewRoom
                            project={projects?.find((p) => p.id === contextValue.snapshot.room.projectId) ?? null}
                            followUp={followUp}
                            onClose={() => setOutside(true)}
                            onManageBrowser={(browserId) => {
                              const target = browserId ?? browsers?.[0]?.id;
                              if (target) setSelection({ kind: "browser", id: target });
                            }}
                          />
                        </ErrorBoundary>
                      </RoomContext.Provider>
                    ) : (
                      <div className="sheet sheet-loading">
                        <header className="sheet-head">
                          {overviewButton}
                          <div className="sheet-title">
                            <h1>{rooms.find((room) => room.id === selection.id)?.title ?? ""}</h1>
                            <span className="sheet-sub muted">opening…</span>
                          </div>
                        </header>
                      </div>
                    )
                  ) : (
                    mainBlock
                  )}
                </AfterSlide>
              </div>
            </div>
          ) : null}
          {pairingOpen ? (
            <Dialog title="T3 connection" onClose={() => setPairingOpen(false)} wide>
              <PairingPanel status={status} onPaired={onPaired} embedded />
              <ProvidersSection />
            </Dialog>
          ) : null}
        </FilePreviewHost>
      </PresetsContext.Provider>
    );
  }
  // Look → Street: the whole page is the street; the same data, rooms and dialogs.
  if (skin === "street") {
    return (
      <PresetsContext.Provider value={presetsValue}>
        <FilePreviewHost>
          <StreetMode
            status={status}
            rooms={sideRooms}
            projects={projects}
            threads={sideThreads}
            t3Error={t3Error}
            selection={selection}
            onSelect={setSelection}
            onOutside={setOutside}
            room={contextValue}
            followUp={followUp}
            panel={inspectorOpen ? inspectorTab : null}
            onPanel={(tab) => {
              if (tab) {
                setInspectorTab(tab);
                setInspectorOpen(true);
              } else setInspectorOpen(false);
            }}
            runCommand={runCommand}
            onSeatPreset={seatPreset}
            onT3Changed={loadT3}
            onThreadChanged={markThread}
            browsers={browsers}
            onBrowsersChanged={loadBrowsers}
            theme={theme}
            onTheme={setTheme}
            onOpenConnection={() => setPairingOpen(true)}
            needsPairing={needsPairing}
            staleUi={staleUi}
          />
          {pairingOpen ? (
            <Dialog title="T3 connection" onClose={() => setPairingOpen(false)} wide>
              <PairingPanel status={status} onPaired={onPaired} embedded />
              <ProvidersSection />
            </Dialog>
          ) : null}
        </FilePreviewHost>
      </PresetsContext.Provider>
    );
  }

  return (
    <PresetsContext.Provider value={presetsValue}>
    <FilePreviewHost>
    <div className={`app${isMobile ? " app-mobile" : ""}${collapsed ? " sidebar-collapsed" : ""}`}>
      {staleUi ? (
        <div className="update-banner" role="status">
          <span>Backroom was updated.</span>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      <Sidebar
        rooms={sideRooms}
        projects={projects}
        threads={sideThreads}
        t3Error={t3Error}
        selection={selection}
        onSelect={(next) => {
          setSelection(next);
          setSidebarOpen(false);
        }}
        onCommand={runCommand}
        onSeatPreset={seatPreset}
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
          rooms={sideRooms}
          projects={projects}
          selection={selection}
          onSelect={setSelection}
          onExpand={() => setSidebarCollapsed(false)}
          connection={
            <>
              <ConnectionChip status={status} onOpen={() => setPairingOpen(true)} compact />
              <UpdatesButton compact />
            </>
          }
        />
      ) : null}
      {mainBlock}
      {pairingOpen ? (
        <Dialog title="T3 connection" onClose={() => setPairingOpen(false)} wide>
          <PairingPanel status={status} onPaired={onPaired} embedded />
          <ProvidersSection />
        </Dialog>
      ) : null}
    </div>
    </FilePreviewHost>
    </PresetsContext.Provider>
  );
}

/** The drawer's content, mounted once its slide-in has played: the room's first draw and the animation do not fight. */
function AfterSlide({ placeholder, children }: { placeholder: ReactNode; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), SLIDE_MS + 30);
    return () => clearTimeout(timer);
  }, []);
  return <>{ready ? children : placeholder}</>;
}
