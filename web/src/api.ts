/** Typed fetch helpers for the Backroom HTTP API plus the page's stream of changes. */
import { useEffect, useRef, useState } from "react";
import { DetailLoader, FALLBACK_MS, PagePush, PageStream, withPush, type EventSourceLike, type LoaderTimers, type PageStreamDeps, type PageStreamHandlers } from "./pageStream.ts";
import type {
  FilePreviewResponse,
  UpdatesView,
  ApiErrorBody,
  RoomBrowserStatus,
  Attachment,
  BrowserListItem,
  CatalogEntry,
  CommandResult,
  DeskResponse,
  Draft,
  GitDiff,
  ProjectRefs,
  FolderListing,
  GitResponse,
  ModelSelection,
  LiveView,
  ProviderInfo,
  UsageToday,
  Preset,
  RoomCosts,
  SpeechStatus,
  ThreadCost,
  ThreadCosts,
  RoomCommand,
  RoomListItem,
  RoomSnapshot,
  EngineBoardPage,
  EngineNoticeMarks,
  EngineRunDetail,
  StatusResponse,
  T3Project,
  T3ThreadShell,
  ThreadView,
  OverviewRoom,
  OverviewThread,
  ThreadLifecycleChoice,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Array<{ path: string; message: string }> | undefined;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error;
    this.issues = body.issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: "bad_response", message: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const errorBody = (body ?? { error: "http_error", message: response.statusText }) as ApiErrorBody;
    // The page is newer than the service: the UI is served fresh on each load, the server only after a restart.
    if (response.status === 404 && typeof errorBody.message === "string" && errorBody.message.startsWith("no route for ")) {
      throw new ApiError(404, { error: "no_route", message: "Backroom's service is older than this page and doesn't have this yet. Restart it (systemctl --user restart backroom)." });
    }
    throw new ApiError(response.status, errorBody);
  }
  // A page where data was expected: an older service that does not know this route answered with the app shell.
  if (body && typeof body === "object" && (body as ApiErrorBody).error === "bad_response") {
    throw new ApiError(502, { error: "bad_response", message: "Backroom's service answered with a page instead of data; it may be running an older version. Restart it." });
  }
  return body as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, payload: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(payload) });

export const api = {
  status: (): Promise<StatusResponse> => get("/api/status"),
  pair: (pairingUrl: string): Promise<{ paired: boolean; scope: string; expiresAt: string | null }> =>
    post("/api/t3/pair", { pairingUrl }),
  projects: (): Promise<T3Project[]> => get("/api/t3/projects"),
  catalog: (): Promise<CatalogEntry[]> => get("/api/t3/catalog"),
  threads: (projectId: string): Promise<T3ThreadShell[]> =>
    get(`/api/t3/threads?projectId=${encodeURIComponent(projectId)}`),
  /** Every thread in every project, archived ones included, each marked with whether a room participant holds it. */
  allThreads: (): Promise<T3ThreadShell[]> => get("/api/t3/threads?includeArchived=1"),
  /** A thread used directly (outside any room). */
  thread: (threadId: string): Promise<ThreadView> => get(`/api/threads/${encodeURIComponent(threadId)}`),
  rooms: (): Promise<RoomListItem[]> => get("/api/rooms"),
  /** A room ("room:<id>") was on screen up to journal sequence `seq`, its newest finish. */
  markRoomSeen: (roomId: string, seq: number): Promise<{ key: string; seq: number }> => post("/api/seen", { key: `room:${roomId}`, seq }),
  /** A thread outside rooms ("thread:<id>") was on screen up to `at`, its newest finish. */
  markThreadSeen: (threadId: string, at: string): Promise<{ key: string; at: string }> => post("/api/seen", { key: `thread:${threadId}`, at }),
  room: (roomId: string): Promise<RoomSnapshot> => get(`/api/rooms/${encodeURIComponent(roomId)}`),
  /** Older posts of a room's board: those before journal sequence `before`, newest last. */
  board: (roomId: string, before: number, limit = 100): Promise<EngineBoardPage> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/board?before=${before}&limit=${limit}`),
  /** A run with the exact briefing T3 received. */
  run: (roomId: string, runId: string): Promise<EngineRunDetail> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`),
  /** Take notices off "needs you" without acting on them: by ID, or every one up to a journal sequence. */
  dismissNotices: (roomId: string, marks: { ids: string[] } | { through: number }): Promise<EngineNoticeMarks> =>
    post(`/api/rooms/${encodeURIComponent(roomId)}/notices/dismiss`, marks),
  parse: (roomId: string, text: string): Promise<Draft> =>
    post(`/api/rooms/${encodeURIComponent(roomId)}/parse`, { text }),
  command: (command: RoomCommand): Promise<CommandResult> => post("/api/commands", command),
  live: (roomId: string, participantId: string): Promise<LiveView> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participantId)}/live`),
  desk: (roomId: string): Promise<DeskResponse> => get(`/api/rooms/${encodeURIComponent(roomId)}/desk`),
  roomCosts: (roomId: string): Promise<RoomCosts> => get(`/api/rooms/${encodeURIComponent(roomId)}/costs`),
  threadCost: (threadId: string): Promise<{ readAt: string; pricesFetchedAt: string | null; cost: ThreadCost }> => get(`/api/t3/threads/${encodeURIComponent(threadId)}/cost`),
  /** Whether the service reads aloud with its own voice, how it is doing, and its voices. Asking starts the model loading. */
  speechStatus: (): Promise<SpeechStatus> => get("/api/speech/status"),
  /** A piece of text as WAV in the service's voice. */
  speechAudio: async (text: string, voice: string | null, speed: number, signal?: AbortSignal): Promise<Blob> => {
    const response = await fetch("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, speed }), signal: signal ?? null });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({ error: "http_error", message: response.statusText }))) as ApiErrorBody;
      throw new ApiError(response.status, body);
    }
    return response.blob();
  },
  /** A thread's spend as a room shows a member's: the total, a figure per reply, and the turn in progress. */
  threadCosts: (threadId: string): Promise<ThreadCosts> => get(`/api/t3/threads/${encodeURIComponent(threadId)}/costs`),
  /** The room's working folders in brief, and (unless `summary`) the full git view of `path` (else the first folder). */
  git: (roomId: string, options: { path?: string | null; commits?: number; summary?: boolean } = {}): Promise<GitResponse> => {
    const query = new URLSearchParams();
    if (options.summary) query.set("summary", "1");
    if (options.path) query.set("path", options.path);
    if (options.commits) query.set("commits", String(options.commits));
    return get(`/api/rooms/${encodeURIComponent(roomId)}/git?${query}`);
  },
  /** One file's diff in a room folder: uncommitted against HEAD, or its change in `commit`. */
  gitDiff: (roomId: string, folder: string, file: { path: string; origPath?: string | null; commit?: string | null; untracked?: boolean }): Promise<GitDiff> => {
    const query = new URLSearchParams({ path: folder, file: file.path });
    if (file.origPath) query.set("from", file.origPath);
    if (file.commit) query.set("commit", file.commit);
    if (file.untracked) query.set("untracked", "1");
    return get(`/api/rooms/${encodeURIComponent(roomId)}/git/diff?${query}`);
  },
  providers: (): Promise<ProviderInfo[]> => get("/api/t3/providers"),
  /** Ask T3 to check its providers again now (one, or all); with `models` it also looks for new models. */
  refreshProviders: (input: { instanceId?: string; models?: boolean } = {}): Promise<ProviderInfo[]> => post("/api/t3/providers/refresh", input),
  /** This page's state, so Backroom can hold T3's client lease while someone is using it. */
  presence: (input: { pageId: string; visible: boolean; focused: boolean; interactedAt: number | null }): Promise<{ ok: true }> => post("/api/t3/presence", input),
  filePreview: (path: string, base: string | null): Promise<FilePreviewResponse> => get(`/api/file-preview?${new URLSearchParams({ path, ...(base ? { base } : {}) })}`),
  updates: (fresh = false): Promise<UpdatesView> => get(`/api/t3/updates${fresh ? "?fresh=1" : ""}`),
  checkUpdates: (): Promise<UpdatesView> => post("/api/t3/updates/check", {}),
  updateHarness: (instanceId: string): Promise<UpdatesView> => post("/api/t3/updates/harness", { instanceId }),
  updateT3: (targetVersion: string): Promise<UpdatesView> => post("/api/t3/updates/server", { targetVersion }),
  usageToday: (): Promise<UsageToday> => get(`/api/t3/usage/today?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  /** T3's default model for a project; null when T3 has none configured. */
  defaultModel: (projectId: string): Promise<{ modelSelection: ModelSelection | null }> => get(`/api/t3/projects/${encodeURIComponent(projectId)}/default-model`),
  /** The project's branches and worktrees, for choosing where a new thread works. */
  projectRefs: (projectId: string): Promise<ProjectRefs> => get(`/api/t3/projects/${encodeURIComponent(projectId)}/refs`),
  /** The folders T3 lists for a path being typed: "/a/b/" lists b's subfolders, "/a/b" those of a whose names start with b. */
  folders: (path: string): Promise<FolderListing> => get(`/api/t3/folders?path=${encodeURIComponent(path)}`),
  presets: (): Promise<Preset[]> => get("/api/presets"),
  overview: (): Promise<{ rooms: OverviewRoom[]; threads: OverviewThread[]; readAt: string }> => get("/api/overview"),
  /** App-wide settings: which saved crew member is the Consigliere of new rooms, his rules, and what his retiring does to a thread (absent from an older service). */
  settings: (): Promise<{ consiglierePresetId: string | null; consigliereRules: { text: string; custom: boolean; defaultText: string }; retireThread?: ThreadLifecycleChoice; agentsFile?: boolean }> => get("/api/settings"),
  /** Reasons designating this member may not work (plan mode, approvals, an untried harness); it is allowed anyway. */
  consigliereWarnings: (roomId: string, participantId: string): Promise<{ warnings: string[] }> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participantId)}/consigliere-warnings`),
  browsers: (): Promise<BrowserListItem[]> => get("/api/browsers"),
  /** One browser, with its profile size. */
  browser: (browserId: string): Promise<BrowserListItem> => get(`/api/browsers/${encodeURIComponent(browserId)}`),
  browserStart: (browserId: string): Promise<RoomBrowserStatus> => post(`/api/browsers/${encodeURIComponent(browserId)}/start`, {}),
  browserStop: (browserId: string): Promise<RoomBrowserStatus> => post(`/api/browsers/${encodeURIComponent(browserId)}/stop`, {}),
  /** The browsers section for a thread outside any room, with browserId as its default (started now). */
  /** A thread's browser instructions (its browsers, its default started, its key), for the user's next message. */
  threadBrowserBriefing: (threadId: string): Promise<{ text: string }> => get(`/api/threads/${encodeURIComponent(threadId)}/browser-briefing`),
  /** Wipe logins, history and saved tabs; the browser keeps its name, purpose and address. */
  browserReset: (browserId: string): Promise<RoomBrowserStatus> => post(`/api/browsers/${encodeURIComponent(browserId)}/reset`, {}),
  /** Upload one image as raw bytes; the returned id is referenced from message.create. */
  uploadAttachment: (roomId: string, file: File): Promise<Attachment> =>
    request(`/api/rooms/${encodeURIComponent(roomId)}/attachments`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "image") },
    }),
};

/** URL serving an attachment's bytes (immutable, cacheable). */
export const attachmentUrl = (id: string): string => `/api/attachments/${encodeURIComponent(id)}`;

/** Provider status/usage, polled every `intervalMs` while `enabled` (a model picker or the connection dialog is open). */
export function useProviders(enabled: boolean, intervalMs = 60000): { providers: ProviderInfo[] | null; error: string | null } {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const list = await api.providers();
        if (!cancelled) {
          setProviders(list);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
  return { providers, error };
}

/**
 * What the page's stream tells the thread detail loaders (pageStream.ts PagePush): usePageStream feeds it, the thread
 * view and the desk follow it.
 */
export const pagePush = new PagePush();

/** The browser's timers, for the loaders. */
export const browserTimers: LoaderTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
};

/**
 * Room desk (every participant's T3 thread view, each member's live turn among it). Read again at once when one of
 * its members' threads changes (a `thread` event) and on each re-read of everything; its timer is a 60 s fallback while
 * the stream is open and every member's thread is pushed, else `intervalMs` (2.5 s while a turn runs, 10 s otherwise).
 */
export function useDesk(roomId: string | null, intervalMs: number): { desk: DeskResponse | null; error: string | null } {
  const [desk, setDesk] = useState<DeskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const interval = useRef(intervalMs);
  interval.current = intervalMs;
  const loaderRef = useRef<DetailLoader<DeskResponse> | null>(null);
  useEffect(() => {
    setDesk(null);
    setError(null);
  }, [roomId]);
  useEffect(() => {
    if (!roomId) return;
    // The members' threads, as the latest answer names them: an event for one of them reads the desk again.
    let threads = new Set<string>();
    const loader = new DetailLoader<DeskResponse>(
      {
        read: () => api.desk(roomId),
        apply: (data) => {
          threads = new Set(Object.values(data.participants).map((desk) => desk.threadId).filter((id): id is string => typeof id === "string"));
          setDesk(data);
          setError(null);
        },
        fail: (caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        },
        delay: (data) => (pagePush.open && data?.pushed === true ? FALLBACK_MS : interval.current),
      },
      browserTimers,
    );
    loaderRef.current = loader;
    const unfollow = pagePush.subscribe({
      thread: (threadId) => {
        if (threads.has(threadId)) loader.now();
      },
      all: () => loader.now(),
      open: () => loader.reschedule(),
    });
    loader.start();
    return () => {
      unfollow();
      loader.stop();
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [roomId]);
  // A new cadence (a turn started or ended) times the next read from now, without reading at once.
  useEffect(() => {
    loaderRef.current?.reschedule();
  }, [intervalMs]);
  return { desk, error };
}

/**
 * Poll a value while `key` is set: the room's costs every half minute, a thread's too. Null until the first
 * read. A change of `nonce` reads again at once (a reply just arrived: its figure should not wait for the timer).
 */
function usePolled<T>(key: string | null, intervalMs: number, read: (key: string) => Promise<T>, nonce = 0): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!key) {
      setValue(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await read(key);
        if (!cancelled) setValue(next);
      } catch {
        // Costs are a courtesy: a failed read leaves the last figures, or none.
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, nonce]);
  return value;
}

/** The room's costs; `replies` changes when the room has a new reply, so it is priced at once. */
export const useRoomCosts = (roomId: string | null, replies = 0): RoomCosts | null => usePolled(roomId, 30_000, api.roomCosts, replies);
/** A thread's costs; `replies` is how many replies its view holds, so a new one is priced at once. */
export const useThreadCosts = (threadId: string | null, replies = 0): ThreadCosts | null => usePolled(threadId, 30_000, api.threadCosts, replies);

/**
 * The room's git state. While the Git tab is open (`detail`), the full view of the chosen folder every 4s;
 * otherwise only the folders in brief (the header's count) every 15s. A new folder or commit count reads at once.
 */
export function useGit(
  roomId: string | null,
  options: { detail: boolean; path: string | null; commits: number },
): { git: GitResponse | null; error: string | null } {
  const { detail, path, commits } = options;
  const [git, setGit] = useState<GitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setGit(null);
    setError(null);
  }, [roomId]);
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const data = await api.git(roomId, detail ? { path, commits } : { summary: true });
        if (!cancelled) {
          // A brief read keeps the last full view, so reopening the tab shows it while the next read runs.
          setGit((previous) => (detail || !previous ? data : { ...data, view: previous.view, compares: previous.compares ?? [], overlaps: previous.overlaps ?? [] }));
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) timer = setTimeout(tick, detail ? 4000 : 15000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomId, detail, path, commits]);
  return { git, error };
}

/**
 * Poll the participant's live view (streaming text + T3 activities) every `intervalMs` while `enabled`.
 * The next request is scheduled only after the previous one settles, so slow responses never pile up.
 */
export function useLive(
  roomId: string,
  participantId: string,
  enabled: boolean,
  intervalMs: number,
): { live: LiveView | null; error: string | null } {
  const [live, setLive] = useState<LiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const data = await api.live(roomId, participantId);
        if (!cancelled) {
          setLive(data);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [roomId, participantId, enabled, intervalMs]);
  return { live, error };
}

/**
 * The page's one stream of what changed on the service (pageStream.ts): the handlers run on each event, and `all` on
 * each (re)open and each return into view. Returns whether the stream is open, so the timers can slow down.
 */
export function usePageStream(handlers: Omit<PageStreamHandlers, "open" | "thread">): boolean {
  const current = useRef(handlers);
  current.current = handlers;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const stream = new PageStream(
      withPush(
        {
          all: () => current.current.all(),
          rooms: () => current.current.rooms(),
          room: (roomId) => current.current.room(roomId),
          shell: () => current.current.shell(),
          status: (reach) => current.current.status(reach),
        },
        pagePush,
        setOpen,
      ),
      browserDeps(),
    );
    stream.start();
    return () => stream.stop();
  }, []);
  return open;
}

/** The browser's own pieces, for the page. */
function browserDeps(): PageStreamDeps {
  return {
    connect: (url) => new EventSource(url) as unknown as EventSourceLike,
    hidden: () => document.visibilityState === "hidden",
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
  };
}
