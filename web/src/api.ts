/** Typed fetch helpers for the T3 Rooms HTTP API plus the SSE room-stream hook. */
import { useEffect, useRef, useState } from "react";
import type {
  ApiErrorBody,
  RoomBrowserStatus,
  Attachment,
  CatalogEntry,
  CommandResult,
  DeskResponse,
  Draft,
  ModelSelection,
  LiveView,
  ProviderInfo,
  UsageToday,
  Role,
  RoomCommand,
  RoomListItem,
  RoomSnapshot,
  Run,
  StatusResponse,
  T3Project,
  T3ThreadShell,
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
    throw new ApiError(response.status, errorBody);
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
  rooms: (): Promise<RoomListItem[]> => get("/api/rooms"),
  room: (roomId: string): Promise<RoomSnapshot> => get(`/api/rooms/${encodeURIComponent(roomId)}`),
  run: (roomId: string, runId: string): Promise<Run> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`),
  parse: (roomId: string, text: string): Promise<Draft> =>
    post(`/api/rooms/${encodeURIComponent(roomId)}/parse`, { text }),
  command: (command: RoomCommand): Promise<CommandResult> => post("/api/commands", command),
  live: (roomId: string, participantId: string): Promise<LiveView> =>
    get(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(participantId)}/live`),
  desk: (roomId: string): Promise<DeskResponse> => get(`/api/rooms/${encodeURIComponent(roomId)}/desk`),
  providers: (): Promise<ProviderInfo[]> => get("/api/t3/providers"),
  usageToday: (): Promise<UsageToday> => get(`/api/t3/usage/today?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  /** T3's default model for a project; null when T3 has none configured. */
  defaultModel: (projectId: string): Promise<{ modelSelection: ModelSelection | null }> => get(`/api/t3/projects/${encodeURIComponent(projectId)}/default-model`),
  roles: (): Promise<Role[]> => get("/api/roles"),
  browserStart: (roomId: string): Promise<RoomBrowserStatus> => post(`/api/rooms/${encodeURIComponent(roomId)}/browser/start`, {}),
  browserStop: (roomId: string): Promise<RoomBrowserStatus | null> => post(`/api/rooms/${encodeURIComponent(roomId)}/browser/stop`, {}),
  /** Upload one image as raw bytes; the returned id is referenced from message.create / task.create. */
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
 * Room desk (every participant's T3 thread view). One polling loop per room: `intervalMs` is 10s while
 * a room is open (crew tiles need it on every tab) and 3s while the Changes tab is visible.
 */
export function useDesk(roomId: string | null, intervalMs: number): { desk: DeskResponse | null; error: string | null } {
  const [desk, setDesk] = useState<DeskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDesk(null);
    setError(null);
  }, [roomId]);
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const data = await api.desk(roomId);
        if (!cancelled) {
          setDesk(data);
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
  }, [roomId, intervalMs]);
  return { desk, error };
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
 * Subscribe to a room's SSE stream. `onChange` runs (debounced) whenever the server reports
 * `room.changed`. Reconnects automatically through the browser's EventSource behaviour.
 */
export function useRoomStream(roomId: string | null, onChange: () => void, debounceMs = 150): void {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!roomId) return;
    const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/stream`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        callback.current();
      }, debounceMs);
    };
    source.addEventListener("room.changed", schedule);
    source.addEventListener("hello", () => callback.current());
    source.onerror = () => {
      // EventSource retries on its own; refetch once reconnected via the next "hello".
    };
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [roomId, debounceMs]);
}
