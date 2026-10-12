import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How long the overview's drawer takes to slide in (styles.css, ov-slide). */
const SLIDE_MS = 160;
import { api, ApiError, useDesk, useGit, usePageStream, useRoomCosts } from "./api.ts";
import { Latest, afterRoomGone, shownSnapshot, type T3Reach } from "./pageStream.ts";
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
import { KeyBar } from "./components/KeyBar.tsx";
import { KeyHelp } from "./components/KeyHelp.tsx";
import { byKey, focusWhen, inFront, isTextField, itemOf, keyOf, trackFocus } from "./keys.ts";
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
  const [roomRead, setSnapshot] = useState<RoomSnapshot | null>(null);
  // Only the selected room's snapshot is ever shown: a late answer for the room left a moment ago is not.
  const snapshot = shownSnapshot(roomRead, selectedRoomId);
  // T3's projects and threads, for the overview. Kept at the last good reading while T3 does not answer.
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [threads, setThreads] = useState<T3ThreadShell[]>([]);
  /** The finish time each thread outside rooms was marked seen up to on this page (see the news effects below). */
  const [seenThreads, setSeenThreads] = useState<ReadonlyMap<string, string>>(new Map());
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
  // cards; a room opened from there covers it, and Backspace goes back.
  const [outside, setOutside] = useState(true);
  // A member's thread, looked at over its room (Enter on a member, or its menu's Open thread); Backspace goes back to the
  // room.
  const [memberThread, setMemberThread] = useState<{ roomId: string; participantId: string } | null>(null);
  // The overview item the focus goes back to when the drawer closes: where it was when the drawer opened.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [keyHelp, setKeyHelp] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  // The browser's back goes back too: opening the drawer adds a history entry, and closing it (×, Backspace) takes it away.
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

  // Each loader applies an answer only if no newer read of it has been applied (pageStream.ts, Latest): a read that hung
  // on T3 for 30 s does not put back what a newer one replaced.
  const order = useRef({ status: new Latest(), rooms: new Latest(), t3: new Latest(), snapshot: new Latest(), browsers: new Latest(), presets: new Latest() }).current;
  const loadStatus = useCallback(() => {
    const ticket = order.status.start();
    api.status().then(
      (next) => order.status.take(ticket) && setStatus(next),
      (error) => order.status.take(ticket) && report(error),
    );
  }, [report, order]);

  const loadRooms = useCallback(() => {
    const ticket = order.rooms.start();
    api.rooms().then(
      (next) => order.rooms.take(ticket) && setRooms(next),
      (error) => order.rooms.take(ticket) && report(error),
    );
  }, [report, order]);

  // Presets change only from this UI (or another tab of it), so they are read at the start and after a change.
  const [presets, setPresets] = useState<Preset[]>([]);
  const loadPresets = useCallback(() => {
    // The same list stays the same object, so the marks drawn from it are not redrawn every poll.
    const ticket = order.presets.start();
    api
      .presets()
      .then((next) => order.presets.take(ticket) && setPresets((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)))
      .catch(() => undefined);
  }, [order]);
  const presetsValue = useMemo(() => ({ presets, reload: loadPresets }), [presets, loadPresets]);

  // Polled with the room list; failures are shown once on the overview, not as a toast every poll.
  // Browsers are local processes: cheap to read, polled with the room list. Null when the service cannot run them.
  const [browsers, setBrowsers] = useState<BrowserListItem[] | null>(null);
  const loadBrowsers = useCallback(() => {
    const ticket = order.browsers.start();
    api.browsers().then(
      (list) => order.browsers.take(ticket) && setBrowsers(list.length > 0 ? list : null),
      () => undefined,
    );
  }, [order]);

  const loadT3 = useCallback(() => {
    const ticket = order.t3.start();
    Promise.all([api.projects(), api.allThreads()]).then(
      ([projectList, threadList]) => {
        if (!order.t3.take(ticket)) return;
        setProjects(projectList);
        setThreads(threadList);
        setT3Error(null);
      },
      (error: unknown) => order.t3.take(ticket) && setT3Error(error instanceof Error ? error.message : String(error)),
    );
  }, [order]);

  const loadSnapshot = useCallback(() => {
    if (!selectedRoomId) {
      setSnapshot(null);
      return;
    }
    const roomId = selectedRoomId;
    const ticket = order.snapshot.start();
    api.room(roomId).then(
      (next) => order.snapshot.take(ticket) && setSnapshot(next),
      (error) => {
        if (!order.snapshot.take(ticket)) return;
        if (error instanceof ApiError && error.status === 404) {
          // Gone: closed if it is still the one open, never another room opened since.
          setSelection((current) => afterRoomGone(current, roomId));
          setSnapshot((current) => (current?.room.id === roomId ? null : current));
          return;
        }
        report(error);
      },
    );
  }, [selectedRoomId, report, order]);

  // The overview's own read (Overview.tsx) goes again when this changes.
  const [overviewChanged, setOverviewChanged] = useState(0);
  const loadAll = useCallback(() => {
    loadStatus();
    loadRooms();
    loadT3();
    loadBrowsers();
    loadPresets();
    loadSnapshot();
    setOverviewChanged((n) => n + 1);
  }, [loadStatus, loadRooms, loadT3, loadBrowsers, loadPresets, loadSnapshot]);
  // What the service pushes (GET /api/events): each event reads again what it names; the stream's every (re)open and the
  // page's every return into view read it all.
  const streaming = usePageStream({
    all: loadAll,
    rooms: () => {
      loadRooms();
      // A browser's change is told to the rooms that may use it.
      loadBrowsers();
      setOverviewChanged((n) => n + 1);
    },
    room: (roomId) => {
      if (roomId === selectedRoomId) loadSnapshot();
    },
    shell: () => {
      // T3's threads: the overview's, and the members' status in the room list and the open room.
      loadT3();
      loadRooms();
      loadSnapshot();
      setOverviewChanged((n) => n + 1);
    },
    status: (reach: T3Reach) => {
      if (reach.up) {
        // The banner goes with the next read that succeeds.
        loadAll();
        return;
      }
      // Newer than any read of T3's lists still in flight: none of their answers is applied after it.
      order.t3.supersede();
      setT3Error(reach.error ?? "T3 is not answering");
      loadStatus();
    },
  });

  useEffect(() => {
    loadStatus();
    loadRooms();
    loadT3();
    loadBrowsers();
    loadPresets();
  }, [loadStatus, loadRooms, loadT3, loadBrowsers, loadPresets]);
  useEffect(() => {
    // The room list and thread list carry live activity (working, background, needs you) for the overview, and the
    // connection status asks T3 itself. The stream tells their changes as they happen, so while it is open the timers
    // only back it up; while it is not they run at their own pace. Browsers and presets are not told by the stream (a
    // browser no room may use, a preset changed on another device): read every 8 s, from the service only.
    const covered = setInterval(
      () => {
        loadRooms();
        loadT3();
      },
      streaming ? 60000 : 8000,
    );
    const local = setInterval(() => {
      loadBrowsers();
      loadPresets();
    }, 8000);
    const status = setInterval(loadStatus, streaming ? 60000 : 30000);
    return () => {
      clearInterval(covered);
      clearInterval(local);
      clearInterval(status);
    };
  }, [streaming, loadStatus, loadRooms, loadT3, loadBrowsers, loadPresets]);

  /** Open something in the drawer over the overview; the focus comes back to the item it was opened from. */
  const openInDrawer = useCallback((next: Selection) => {
    setReturnTo(keyOf(document.activeElement) ?? `${next.kind}:${next.id}`);
    setSelection(next);
    setMemberThread(null);
    setOutside(false);
  }, []);
  /** Back from a member's thread to its room: the Members panel open, the focus on the member. */
  const closeMember = useCallback(() => {
    const participantId = memberThread?.participantId;
    setMemberThread(null);
    setRoomPanel("people");
    if (participantId) focusWhen(() => (drawer.current ? byKey(drawer.current, `member:${participantId}`) : null));
  }, [memberThread]);
  // Whatever closes the drawer (Backspace, ×, the browser's back) closes the member's thread on it too.
  useEffect(() => {
    if (!open) setMemberThread(null);
  }, [open]);
  // The drawer takes the focus as it opens (until what it shows is drawn and takes it in turn); a member's thread
  // takes it from the room under it.
  useEffect(() => {
    if (open) drawer.current?.focus({ preventScroll: true });
  }, [open, selection]);

  // ---- the keys (keys.ts): Esc closes what is in front; Backspace goes back one step; ? shows the keys ----
  // Whether something in front (keys.ts, inFront) was there when Esc went down: by the time the drawer's listener runs,
  // that thing may have closed itself already.
  const escapeTaken = useRef(false);
  // Backspace's steps once nothing is in front, as they stand now: a member's thread, the room's side panel, the drawer.
  const back = useRef<() => boolean>(() => false);
  back.current = () => {
    if (!open) return false;
    if (memberThread) closeMember();
    else if (selection?.kind === "room" && roomPanel) setRoomPanel(null);
    else setOutside(true);
    return true;
  };
  useEffect(() => {
    trackFocus();
    // A Backspace held down in a text field (clearing a draft) stays the field's until it is let go: should the field go
    // away under it, its repeats do not go on to leave the room. (The composer itself stays open under a held Backspace,
    // composerOverlay.tsx.)
    let heldInField = false;
    const onCapture = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === "Escape") escapeTaken.current = inFront(target);
      if (event.key === "Backspace" && !event.repeat) heldInField = isTextField(target);
      // Backspace outside a text field is back. With something in front it is Esc, sent where the focus is, so whatever
      // closes on Esc closes and the two keys agree; else one step out. In a text field it is the field's.
      if (event.key === "Backspace" && !heldInField && !event.defaultPrevented && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !isTextField(target)) {
        if (inFront(target)) {
          event.preventDefault();
          (target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        } else if (back.current()) event.preventDefault();
      }
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !isTextField(target)) {
        const help = Boolean(document.querySelector(".key-help"));
        if (!help && target?.closest(".dialog, .menu")) return;
        // Taken before the composer's "start typing to write" sees it.
        event.preventDefault();
        setKeyHelp(!help);
      }
    };
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  }, []);
  // Esc with nothing in front: a text field gives up the focus, to the post or member it is in, else the drawer. It
  // closes nothing else: the room, a member's thread and the side panel are left with Backspace.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || escapeTaken.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!isTextField(target)) return;
      event.preventDefault();
      (itemOf(target) ?? drawer.current)?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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
      () => {
        setThreads((list) => list.map((thread) => (thread.id === openThreadId && thread.news?.at === openThreadAt ? { ...thread, news: null } : thread)));
        // The overview's own read may still carry it: it leaves out what is marked here (seenNews.ts).
        setSeenThreads((seen) => (seen.get(openThreadId) === openThreadAt ? seen : new Map(seen).set(openThreadId, openThreadAt)));
      },
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
    openInDrawer({ kind, id });
  });

  // Desk data: crew tiles show context on every tab, so poll every 10s while a room is open; every 2.5s while
  // Changes is visible or any participant's thread is running a turn (the timeline shows turns typed in T3 live).
  const [deskRunning, setDeskRunning] = useState(false);
  const snapshotRunning = snapshot
    ? Object.values(snapshot.participantStatus).some((s) => isRunActive(s.status) || s.externalActivity)
    : false;
  const deskInterval = deskRunning || snapshotRunning ? 2500 : 10000;
  // The stream tells the room's changes and T3's (a turn starts or ends there), so while it is open the timer only backs
  // it up; while it is not, the open room is read often while anything runs, seldom when all is quiet.
  const roomBusy = snapshot ? snapshotRunning || snapshot.runs.some((run) => run.phase !== "terminal") : false;
  useEffect(() => {
    if (!selectedRoomId) return;
    const timer = setInterval(loadSnapshot, streaming ? 60000 : roomBusy ? 4000 : 15000);
    return () => clearInterval(timer);
  }, [selectedRoomId, loadSnapshot, roomBusy, streaming]);
  const { desk, error: deskError } = useDesk(snapshot ? snapshot.room.id : null, deskInterval);
  // A new reply is priced at once: the nonce is the seq of the newest post that stands for a turn (spend is keyed by those).
  const lastReplySeq = snapshot ? snapshot.posts.reduce((seq, post) => (post.turn ? post.seq : seq), 0) : 0;
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
          if (command.type === "participant.create" || command.type === "participant.fromPreset" || command.type === "participant.retire") loadT3();
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
      openMember: (participantId) => setMemberThread({ roomId: snapshot.room.id, participantId }),
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
  // The member whose thread is looked at over the room, once the room is read.
  const memberParticipant = memberThread && snapshot?.room.id === memberThread.roomId ? (snapshot.participants.find((p) => p.id === memberThread.participantId) ?? null) : null;
  // Its thread: the member's current binding (the newest generation not retired).
  const memberThreadId = memberParticipant
    ? (snapshot!.bindings.filter((b) => b.participantId === memberParticipant.id && !b.retiredAt).sort((a, b) => b.generation - a.generation)[0]?.threadId ?? null)
    : null;

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
    <button type="button" className="small ghost icon-only overview-back" aria-label="Back to the overview" title="Back to the overview (Backspace)" onClick={() => setOutside(true)}>
      <CloseIcon />
    </button>
  );

  const backToRoomButton = (
    <button type="button" className="small ghost icon-only overview-back" aria-label="Back to the room" title="Back to the room (Backspace)" onClick={closeMember}>
      <CloseIcon />
    </button>
  );
  // What the drawer is, as assistive technology names it when the focus goes into it.
  const drawerLabel =
    selection?.kind === "room"
      ? `Room ${rooms.find((room) => room.id === selection.id)?.title ?? ""}`.trim()
      : selection?.kind === "thread"
        ? `Thread ${threads.find((thread) => thread.id === selection.id)?.title ?? ""}`.trim()
        : `Browser ${browsers?.find((browser) => browser.id === selection?.id)?.name ?? ""}`.trim();

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
          seenThreads={seenThreads}
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
          changed={overviewChanged}
          streaming={streaming}
          active={!open}
          returnTo={returnTo}
        />
        {open ? (
          // The whole window; ×, Backspace and the browser's back close it. A member's thread over it makes it inert.
          <div className="ov-layer" inert={memberThreadId !== null}>
            <div
              className="ov-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={drawerLabel}
              tabIndex={-1}
              ref={drawer}
              data-view={selection?.kind}
              data-id={selection?.id}
            >
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
        {open && memberParticipant && memberThreadId ? (
          // A member's thread over its room: the room stays as it was under it, and Backspace or its × goes back to it.
          <div className="ov-layer ov-layer-member">
            <div className="ov-drawer" role="dialog" aria-modal="true" aria-label={`@${memberParticipant.alias}'s thread`} data-view="member" data-id={memberThreadId}>
              <div className="main">
                <ErrorBoundary key={`member:${memberParticipant.id}`} onReset={closeMember} header={<div className="room-header app-header-only">{backToRoomButton}</div>}>
                  <ThreadView
                    threadId={memberThreadId}
                    rooms={rooms}
                    browsers={browsers}
                    runCommand={runCommand}
                    onGone={closeMember}
                    onChanged={loadT3}
                    onArchived={closeMember}
                    onOpenRoom={closeMember}
                    headerStart={backToRoomButton}
                    autoFocusTranscript
                  />
                </ErrorBoundary>
              </div>
            </div>
          </div>
        ) : null}
        {keyHelp ? <KeyHelp onClose={() => setKeyHelp(false)} /> : null}
        {connectionDialog}
        <KeyBar />
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
