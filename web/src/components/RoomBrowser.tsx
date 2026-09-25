import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { RoomBrowserStatus } from "../types.ts";
import { CopyButton } from "./pickers.tsx";

/** The noVNC link, completed with this page's host when the service does not know which host you reach it by. */
export function watchUrl(status: RoomBrowserStatus): string | null {
  if (!status.watchPort || !status.watchPath) return null;
  const host = status.watchHost ?? window.location.hostname;
  return `http://${host}:${status.watchPort}${status.watchPath}`;
}

const STATE_LABEL: Record<RoomBrowserStatus["state"], string> = {
  stopped: "off",
  starting: "starting…",
  running: "running",
  error: "failed",
};

/**
 * Room header control for the room's shared browser: whether tasks here get one, start/stop, the watch link, and
 * the open tabs. The browser is a process on the room service's machine; agents attach over DevTools.
 */
export function RoomBrowserButton() {
  const { snapshot, runCommand } = useRoom();
  const status = snapshot.browser;
  const enabled = snapshot.room.browserEnabled;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!status) return null;
  const running = status.state === "running";
  const unavailable = status.mode === null;
  const link = running ? watchUrl(status) : null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () =>
    act(async () => {
      const next = !enabled;
      await runCommand({ type: "room.browser", roomId: snapshot.room.id, enabled: next });
      if (next && !running) await api.browserStart(snapshot.room.id);
    });

  return (
    <span className="room-browser" ref={wrapper}>
      <button
        type="button"
        className={`small${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={enabled ? `Shared browser: ${STATE_LABEL[status.state]}` : "Shared browser for this room's agents"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`dot ${running ? "dot-working" : status.state === "error" ? "dot-err" : ""}`} aria-hidden="true" />
        <span className="room-browser-label">Browser</span>
        {running && status.tabs.length > 0 ? <span className="muted"> {status.tabs.length}</span> : null}
      </button>
      {open ? (
        <div className="menu browser-panel" role="dialog" aria-label="Shared browser">
          <label className="browser-toggle">
            <input type="checkbox" checked={enabled} disabled={busy || (unavailable && !enabled)} onChange={() => void toggle()} />
            <span>
              Give this room&rsquo;s agents a shared browser
              <span className="hint">
                Started for each task and named in its briefing. Agents attach over DevTools (for example{" "}
                <code>agent-browser connect</code>) and share tabs and logins.
              </span>
            </span>
          </label>

          <div className="browser-status">
            <span className="label">Status</span>
            <span>
              {unavailable ? "unavailable" : STATE_LABEL[status.state]}
              {running ? ` · ${status.mode === "vnc" ? "virtual screen" : status.mode === "window" ? "Chrome window" : "headless"}` : ""}
            </span>
            <span className="spacer" />
            {running ? (
              <button type="button" className="small ghost" disabled={busy} onClick={() => void act(() => api.browserStop(snapshot.room.id))}>
                Stop
              </button>
            ) : (
              <button type="button" className="small" disabled={busy || unavailable} onClick={() => void act(() => api.browserStart(snapshot.room.id))}>
                {status.state === "starting" || busy ? "Starting…" : "Start"}
              </button>
            )}
          </div>

          {status.error || error ? <p className="status-error browser-error">{error ?? status.error}</p> : null}

          {running && status.mode === "vnc" && link ? (
            <div className="browser-row">
              <span className="label">Watch</span>
              <a href={link} target="_blank" rel="noreferrer noopener">
                Open the browser screen
              </a>
              <CopyButton text={link} label="Copy watch link" />
              <span className="hint">Mouse and keyboard work: close tabs, type a password. The link holds the viewer password.</span>
            </div>
          ) : null}
          {running && status.mode === "window" ? (
            <p className="hint">It is the Chrome window on this computer with the room&rsquo;s own profile; use it directly.</p>
          ) : null}
          {running && status.mode === "headless" ? (
            <p className="hint">Headless: no screen to watch; agents use it over DevTools. On Linux, installing Xvfb, x11vnc and noVNC makes it watchable.</p>
          ) : null}
          {running && status.cdpUrl ? (
            <div className="browser-row">
              <span className="label">Agents</span>
              <code>{status.cdpUrl}</code>
            </div>
          ) : null}

          {running ? (
            <div className="browser-tabs">
              <span className="label">Tabs</span>
              {status.tabs.length === 0 ? <span className="muted">none open</span> : null}
              <ul>
                {status.tabs.slice(0, 10).map((tab) => (
                  <li key={tab.id} title={tab.url}>
                    <span className="tab-title">{tab.title || tab.url}</span>
                    {tab.title && tab.title !== tab.url ? <span className="muted tab-url">{tab.url}</span> : null}
                  </li>
                ))}
              </ul>
              {status.tabs.length > 10 ? <span className="muted">and {status.tabs.length - 10} more</span> : null}
            </div>
          ) : null}
          {!running && !unavailable ? (
            <p className="hint">Stops by itself after a while with no activity and no work in flight; the profile and its logins are kept.</p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
