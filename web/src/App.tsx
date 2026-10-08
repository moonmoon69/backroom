import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

/** How long the overview's drawer takes to slide in (styles.css, ov-slide). */
const SLIDE_MS = 160;
import { api, ApiError, useDesk, useGit, useRoomCosts, useRoomStream } from "./api.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { BrowserView } from "./components/BrowserView.tsx";
import { Dialog } from "./components/Dialog.tsx";
import type { InspectorTab } from "./components/Inspector.tsx";
import { AppControls } from "./components/AppControls.tsx";
import { MEMBER_ACCENT } from "./components/Monogram.tsx";
import { ArchivedThreadView, ThreadView } from "./components/ThreadView.tsx";
import { PresetsContext } from "./components/presets.tsx";
import { ProvidersSection } from "./components/Providers.tsx";
import { PairingPanel } from "./components/StatusStrip.tsx";
import { FilePreviewHost } from "./components/FilePreview.tsx";
import { useToast } from "./components/Toast.tsx";
import { RoomContext, seatLookups, type RoomContextValue } from "./context.tsx";
import { Overview } from "./components/Overview.tsx";
import { OverviewRoom } from "./components/OverviewRoom.tsx";
import { CloseIcon } from "./components/icons.tsx";
import { useTheme } from "./theme.ts";
import { useFinishNotifications, useLooking } from "./news.ts";
import { usePresence } from "./presence.ts";
import type { Selection } from "./selection.ts";
import { isRunActive, type BrowserListItem, type CommandResult, type Preset, type RoomCommand, type RoomListItem, type RoomSnapshot, type StatusResponse, type T3Project, type T3ThreadShell } from "./types.ts";

const SELECTION_KEY = "backroom.selection";
/** Where the selected room was kept before threads could be selected too. */
const LEGACY_ROOM_KEY = "backroom.selectedRoom";

function storedSelection(): Selection | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Selection | null;
    if (parsed && (parsed.kind === "room" || parsed.kind === "thread" || parsed.kind === "browser") && typeof parsed.id === "string") return parsed;
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
  // T3's projects and threads, for the overview. Kept at the last good reading while T3 does not answer.
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [threads, setThreads] = useState<T3ThreadShell[]>([]);
  const [t3Error, setT3Error] = useState<string | null>(null);
  // Archive and unarchive switch the view before the next thread-list read confirms them.
  const markThread = useCallback((threadId: string, patch: Partial<T3ThreadShell>) => {
    setThreads((list) => list.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)));
  }, []);
  // T3 serves an archived thread's conversation only after it is unarchived; such a selection gets its own panel.
  const selectedArchived = selection?.kind === "thread" ? threads.find((t) => t.id === selection.id && t.archivedAt) ?? null : null;
  // The open room's side panel (Members, Browser, Git); the Git tab reads in full only while it shows.
  const [roomPanel, setRoomPanel] = useState<InspectorTab | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  // On the overview page the room last opened stays open but is not the one being looked at. The page opens on its
  // cards; a room opened from there covers it, and Esc (outside a dialog) goes back.
  const [outside, setOutside] = useState(true);
  useEffect(() => {
    if (outside) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open], .dialog")) setOutside(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [outside]);
  // The browser's back goes back too: opening the drawer adds a history entry, and closing it (×, Esc) takes it away.
  const open = !outside && selection !== null;
  useEffect(() => {
    const marked = (history.state as { backroomDrawer?: boolean } | null)?.backroomDrawer === true;
    if (open && !marked) history.pushState({ backroomDrawer: true }, "");
    else if (!open && marked) history.back();
  }, [open]);
  useEffect(() => {
    const onPop = () => setOutside((history.state as { backroomDrawer?: boolean } | null)?.backroomDrawer !== true);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
    // The same list stays the same object, so the marks drawn from it are not redrawn every poll.
    api
      .presets()
      .then((next) => setPresets((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)))
      .catch(() => undefined);
  }, []);
  const presetsValue = useMemo(() => ({ presets, reload: loadPresets }), [presets, loadPresets]);

  // Polled with the room list; failures are shown once on the overview, not as a toast every poll.
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
    // The room list and thread list carry live activity (working, background, needs you) for the overview; the crew
    // comes along, so a look changed on another device shows here too; the connection status asks T3 itself, so it
    // stays slow.
    const rooms = setInterval(() => {
      loadRooms();
      loadT3();
      loadBrowsers();
      loadPresets();
    }, 8000);
    const status = setInterval(loadStatus, 30000);
    return () => {
      clearInterval(rooms);
      clearInterval(status);
    };
  }, [loadStatus, loadRooms, loadT3, loadBrowsers, loadPresets]);

  /** Open something in the drawer over the overview. */
  const openInDrawer = useCallback((next: Selection) => {
    setSelection(next);
    setOutside(false);
  }, []);

  useEffect(() => {
    if (selection) localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    else localStorage.removeItem(SELECTION_KEY);
    localStorage.removeItem(LEGACY_ROOM_KEY);
  }, [selection]);

  useEffect(() => {
    loadSnapshot();
  }, [selectedRoomId, loadSnapshot]);

  const onRoomChanged = useCallback(() => {
    loadSnapshot();
    loadRooms();
  }, [loadSnapshot, loadRooms]);
  useRoomStream(selectedRoomId, onRoomChanged);
  // Backroom in place of T3's window: keeps T3 checking plan usage and harnesses while this page is in use.
  usePresence();

  // ---- news: what finished while you were not looking (see news.ts) ----
  const looking = useLooking();
  const lookingHere = looking && !outside;
  // The open room is seen up to its newest finish (a journal sequence), a thread outside rooms up to its newest
  // finish's time, while you look at it, on every device.
  const openRoomId = selection?.kind === "room" ? selection.id : null;
  const openThreadId = selection?.kind === "thread" ? selection.id : null;
  const openRoomSeq = openRoomId ? rooms.find((r) => r.id === openRoomId)?.news.latest?.seq : undefined;
  const openThreadAt = openThreadId ? threads.find((t) => t.id === openThreadId)?.news?.at : undefined;
  useEffect(() => {
    if (!openRoomId || openRoomSeq === undefined || !lookingHere) return;
    api.markRoomSeen(openRoomId, openRoomSeq).then(
      () => setRooms((list) => list.map((room) => (room.id === openRoomId && room.news.latest?.seq === openRoomSeq ? { ...room, news: { ...room.news, seenSeq: openRoomSeq, unseen: 0, latest: null } } : room))),
      () => undefined,
    );
  }, [openRoomId, openRoomSeq, lookingHere]);
  useEffect(() => {
    if (!openThreadId || !openThreadAt || !lookingHere) return;
    api.markThreadSeen(openThreadId, openThreadAt).then(
      () => setThreads((list) => list.map((thread) => (thread.id === openThreadId && thread.news?.at === openThreadAt ? { ...thread, news: null } : thread))),
      () => undefined,
    );
  }, [openThreadId, openThreadAt, lookingHere]);
  // The overview leaves out the news of what you are looking at, so it does not flash before the mark lands.
  const sideRooms = useMemo(
    () => (lookingHere && selection?.kind === "room" ? rooms.map((room) => (room.id === selection.id && room.news.unseen ? { ...room, news: { ...room.news, unseen: 0, latest: null } } : room)) : rooms),
    [rooms, lookingHere, selection],
  );
  const sideThreads = useMemo(
    () => (lookingHere && selection?.kind === "thread" ? threads.map((thread) => (thread.id === selection.id && thread.news ? { ...thread, news: null } : thread)) : threads),
    [threads, lookingHere, selection],
  );
  // The tab's title counts what is new, so a background tab shows it: "(3) Backroom".
  const newCount = sideRooms.reduce((sum, room) => sum + room.news.unseen, 0) + sideThreads.filter((thread) => thread.news).length;
  useEffect(() => {
    document.title = newCount > 0 ? `(${newCount}) Backroom` : "Backroom";
  }, [newCount]);
  useFinishNotifications(rooms, threads, looking, (key) => {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (kind !== "room" && kind !== "thread") return;
    setSelection({ kind, id });
    setOutside(false);
  });

  // Desk data: crew tiles show context on every tab, so poll every 10s while a room is open; every 2.5s while
  // Changes is visible or any participant's thread is running a turn (the timeline shows turns typed in T3 live).
  const [deskRunning, setDeskRunning] = useState(false);
  const snapshotRunning = snapshot
    ? Object.values(snapshot.participantStatus).some((s) => isRunActive(s.status) || s.externalActivity)
    : false;
  const deskInterval = deskRunning || snapshotRunning ? 2500 : 10000;
  const { desk, error: deskError } = useDesk(snapshot ? snapshot.room.id : null, deskInterval);
  // A new reply (an output, or a turn's note) is priced at once: the nonce is the seq of the newest one.
  const lastReplySeq = snapshot ? snapshot.posts.reduce((seq, post) => (post.kind === "output" || post.note?.source === "t3-turn" ? post.seq : seq), 0) : 0;
  const costs = useRoomCosts(snapshot ? snapshot.room.id : null, lastReplySeq);

  // Git: the folder and commit count the Git tab shows start over in each room.
  const [gitPath, setGitPath] = useState<string | null>(null);
  const [gitCommits, setGitCommits] = useState(30);
  useEffect(() => {
    setGitPath(null);
    setGitCommits(30);
  }, [snapshot?.room.id]);
  const gitRead = useGit(snapshot ? snapshot.room.id : null, { detail: roomPanel === "git", path: gitPath, commits: gitCommits });
  useEffect(() => {
    setDeskRunning(desk ? Object.values(desk.participants).some((d) => Boolean(d.runningRun)) : false);
  }, [desk]);

  const runCommand = useCallback(
    async (command: RoomCommand): Promise<CommandResult | null> => {
      try {
        const result = await api.command(command);
        if (command.type === "room.delete") {
          // Leave the deleted room: back to the page of cards.
          if (selectedRoomId === command.roomId) setSelection(null);
          setOutside(true);
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
          // Seating or removing a participant moves a thread into or out of the overview's loose threads.
          if (command.type === "participant.create" || command.type === "participant.fromPreset" || command.type === "participant.retire" || command.type === "participant.rebind") loadT3();
          // A preset may be seated in a room other than the open one: its count in the list changes.
          if (command.type === "participant.fromPreset") loadRooms();
          // A deleted role is cleared from the presets that had it.
        }
        return result;
      } catch (error) {
        if (error instanceof ApiError && error.issues && error.issues.length > 0) {
          toast(`${error.message}`);
          return null;
        }
        report(error);
        return null;
      }
    },
    [loadRooms, loadT3, loadBrowsers, loadPresets, onRoomChanged, report, toast, selectedRoomId],
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
    const participantById = (id: string) => byId.get(id);
    return {
      snapshot,
      runCommand,
      refetch: onRoomChanged,
      participantById,
      aliasOf: (id) => byId.get(id)?.alias ?? id,
      colorOf: () => MEMBER_ACCENT,
      ...seatLookups(snapshot, participantById),
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

  // A room, thread or browser opens over the page of cards, and this closes it.
  const overviewButton = (
    <button type="button" className="small ghost icon-only overview-back" aria-label="Back to the overview" title="Back to the overview (Esc)" onClick={() => setOutside(true)}>
      <CloseIcon />
    </button>
  );

  // The drawer's page for what is selected besides a room: a thread or a browser.
  const mainBlock = (
    <div className="main">
      {needsPairing ? <PairingPanel status={status} onPaired={onPaired} /> : null}
      <ErrorBoundary
        key={selection ? `${selection.kind}:${selection.id}` : "none"}
        onReset={() => setSelection(null)}
        header={<div className="room-header app-header-only">{overviewButton}</div>}
      >
        {needsPairing ? null : selection?.kind === "thread" && selectedArchived ? (
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
            headerStart={overviewButton}
          />
        ) : selection?.kind === "thread" ? (
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
            headerStart={overviewButton}
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
            headerStart={overviewButton}
          />
        ) : null}
      </ErrorBoundary>
    </div>
  );

  const connectionDialog = pairingOpen ? (
    <Dialog title="T3 connection" onClose={() => setPairingOpen(false)} wide>
      <PairingPanel status={status} onPaired={onPaired} embedded />
      <ProvidersSection />
    </Dialog>
  ) : null;

  // The overview: one page of every project, room, thread, crew member and browser; what is opened from it covers the
  // page.
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
          t3Error={t3Error}
          browsers={browsers}
          controls={appControls}
          onOpenRoom={(roomId) => openInDrawer({ kind: "room", id: roomId })}
          onOpenThread={(threadId) => openInDrawer({ kind: "thread", id: threadId })}
          onOpenBrowser={(browserId) => openInDrawer({ kind: "browser", id: browserId })}
          onSeatPreset={seatPreset}
          onCommand={runCommand}
          onT3Changed={loadT3}
          onBrowsersChanged={loadBrowsers}
        />
        {open ? (
          // The whole window; ×, Esc and the browser's back close it.
          <div className="ov-layer">
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
                          panel={roomPanel}
                          onPanel={setRoomPanel}
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
        {connectionDialog}
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
