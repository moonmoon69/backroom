import { useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { BrowserListItem, RoomBrowserStatus } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { CopyButton } from "./pickers.tsx";

/** The noVNC link, completed with this page's host when the service does not know which host you reach it by. */
export function watchUrl(status: RoomBrowserStatus): string | null {
  if (!status.watchPort || !status.watchPath) return null;
  const host = status.watchHost ?? window.location.hostname;
  return `http://${host}:${status.watchPort}${status.watchPath}`;
}

export const BROWSER_STATE_LABEL: Record<RoomBrowserStatus["state"], string> = {
  stopped: "off",
  starting: "starting…",
  running: "running",
  error: "failed",
};

/**
 * A browser's process: state with Start / Stop, the watch link, the DevTools address agents attach to, and the open
 * tabs. Shared by the room's Browser panel and the browser view. `onChanged` runs after Start or Stop.
 */
export function BrowserStatusPanel({ browserId, status, onChanged }: { browserId: string; status: RoomBrowserStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = status.state === "running";
  const unavailable = status.mode === null;
  const link = running ? watchUrl(status) : null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="browser-status">
        <span className="label">Status</span>
        <span>
          {unavailable ? "unavailable" : BROWSER_STATE_LABEL[status.state]}
          {running ? ` · ${status.mode === "vnc" ? "virtual screen" : status.mode === "window" ? "Chrome window" : "headless"}` : ""}
        </span>
        <span className="spacer" />
        {running ? (
          <button type="button" className="small ghost" disabled={busy} onClick={() => void act(() => api.browserStop(browserId))}>
            Stop
          </button>
        ) : (
          <button type="button" className="small" disabled={busy || unavailable} onClick={() => void act(() => api.browserStart(browserId))}>
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
      {running && status.mode === "window" ? <p className="hint">It is a Chrome window on this computer with the browser&rsquo;s own profile; use it directly.</p> : null}
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
        <p className="hint">Stops by itself after a while with no activity and no work in flight; its profile, logins and tabs are kept.</p>
      ) : null}
    </>
  );
}

/**
 * The room's browser settings, from the room header's ⋯ menu: whether its agents get browsers, which browser is the
 * room's default, which browsers they may use, and the default browser's process. The browsers themselves are
 * managed in the sidebar's Browsers section.
 */
export function RoomBrowserDialog({ onClose, onManage }: { onClose: () => void; onManage: (browserId: string | null) => void }) {
  const { snapshot, runCommand, refetch } = useRoom();
  const info = snapshot.browser;
  const enabled = snapshot.room.browserEnabled;
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<BrowserListItem[] | null>(null);
  useEffect(() => {
    api.browsers().then(setList, () => setList([]));
  }, []);

  const unavailable = !info || info.status.mode === null;
  const allowedIds = snapshot.room.allowedBrowserIds;
  const allowedList = list ? (allowedIds ? list.filter((b) => allowedIds.includes(b.id)) : list) : null;
  const setBrowser = async (next: { enabled: boolean; browserId?: string | null; allowed?: string[] | null }) => {
    setBusy(true);
    try {
      await runCommand({ type: "room.browser", roomId: snapshot.room.id, ...next });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Browser for this room" onClose={onClose}>
      <div className="browser-panel">
        <label className="browser-toggle">
          <input type="checkbox" checked={enabled} disabled={busy || (unavailable && !enabled)} onChange={() => void setBrowser({ enabled: !enabled })} />
          <span>
            Give this room&rsquo;s agents a browser
            <span className="hint">Its default browser starts for each task and is named in the briefing. Agents attach over DevTools and share tabs and logins with anyone else using it.</span>
          </span>
        </label>

        <label className="browser-default">
          <span className="label">Default</span>
          <select
            value={snapshot.room.defaultBrowserId ?? info?.browser.id ?? ""}
            disabled={busy || !list}
            onChange={(e) => void setBrowser({ enabled, browserId: e.target.value || null })}
          >
            {!allowedList ? <option value="">Loading…</option> : null}
            {allowedList?.map((browser) => (
              <option key={browser.id} value={browser.id}>
                {browser.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              onClose();
              onManage(info?.browser.id ?? null);
            }}
          >
            Manage…
          </button>
        </label>
        {info?.browser.description ? <p className="hint browser-purpose">{info.browser.description}</p> : null}

        {list && list.length > 1 ? (
          <fieldset className="browser-allowed">
            <legend className="label">Agents here may use</legend>
            <div className="browser-allowed-choice">
              <label className="radio">
                <input type="radio" checked={allowedIds === null} disabled={busy} onChange={() => void setBrowser({ enabled, allowed: null })} />
                every browser
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={allowedIds !== null}
                  disabled={busy}
                  onChange={() => void setBrowser({ enabled, allowed: [info?.browser.id ?? list[0]?.id].filter((id): id is string => Boolean(id)) })}
                />
                only these:
              </label>
            </div>
            {allowedIds !== null ? (
              <div className="browser-allowed-list">
                {list.map((browser) => {
                  const checked = allowedIds.includes(browser.id);
                  const isDefault = browser.id === info?.browser.id;
                  return (
                    <label key={browser.id} className="checkbox" title={isDefault ? "The room's default must stay allowed" : browser.description}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy || (checked && isDefault)}
                        onChange={() => void setBrowser({ enabled, allowed: checked ? allowedIds.filter((id) => id !== browser.id) : [...allowedIds, browser.id] })}
                      />
                      <span className="mono">{browser.name}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {info ? <BrowserStatusPanel browserId={info.browser.id} status={info.status} onChanged={refetch} /> : <p className="hint">No browser yet: create one under Browsers in the sidebar.</p>}
      </div>
    </Dialog>
  );
}
