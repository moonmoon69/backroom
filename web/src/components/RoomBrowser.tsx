import { useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { BrowserListItem, RoomBrowserStatus } from "../types.ts";
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

export interface BrowserPower {
  busy: boolean;
  /** Why the last Start or Stop failed, until the next one. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

/** Start and stop a browser's process. `onChanged` runs after either succeeds. */
export function useBrowserPower(browserId: string, onChanged: () => void): BrowserPower {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return { busy, error, start: () => void act(() => api.browserStart(browserId)), stop: () => void act(() => api.browserStop(browserId)) };
}

/** "Start browser" (the primary action while it is off) or "Stop browser", for a dialog's action row or a header. */
export function BrowserPowerButton({ status, power, small }: { status: RoomBrowserStatus; power: BrowserPower; small?: boolean }) {
  if (status.state === "running") {
    return (
      <button type="button" className={small ? "small" : undefined} disabled={power.busy} onClick={power.stop}>
        {power.busy ? "Stopping…" : "Stop browser"}
      </button>
    );
  }
  const starting = status.state === "starting" || power.busy;
  return (
    <button type="button" className={small ? "small primary" : "primary"} disabled={starting || status.mode === null} onClick={power.start}>
      {starting ? "Starting…" : "Start browser"}
    </button>
  );
}

/**
 * A browser's process as it is: state, the watch link, the DevTools address agents attach to, and the open tabs.
 * Shared by the room's Browser dialog and the browser view; Start and Stop sit with each one's other actions.
 */
export function BrowserStatusPanel({ status, error }: { status: RoomBrowserStatus; error: string | null }) {
  const running = status.state === "running";
  const unavailable = status.mode === null;
  const link = running ? watchUrl(status) : null;
  return (
    <>
      <div className="browser-status">
        <span className="label">Status</span>
        <span>
          {unavailable ? "unavailable" : BROWSER_STATE_LABEL[status.state]}
          {running ? ` · ${status.mode === "vnc" ? "virtual screen" : status.mode === "window" ? "Chrome window" : "headless"}` : ""}
        </span>
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

/** A browser window: the Browser switch's icon on phones, where its word does not fit. */
function BrowserIcon() {
  return (
    <svg className="browser-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M1.75 6h12.5" />
    </svg>
  );
}

/**
 * The room header's Browser switch, beside People, Board and Changes: opens the side panel on the room's browser.
 * The dot is green while the room's default browser runs (with its tab count), red when it failed.
 */
export function RoomBrowserButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { snapshot } = useRoom();
  const info = snapshot.browser;
  const enabled = snapshot.room.browserEnabled;
  const running = info?.status.state === "running";
  const tabs = running ? info.status.tabs.length : 0;
  const tone = info?.status.state === "error" ? " dot-err" : running ? " dot-working" : "";
  const title = !enabled ? "Browser: off for this room's agents" : info ? `Browser "${info.browser.name}": ${BROWSER_STATE_LABEL[info.status.state]}` : "Browser";
  return (
    <button type="button" className={`small room-browser-button${active ? " active" : ""}`} aria-pressed={active} aria-label={title} title={title} onClick={onClick}>
      <span className={`dot${tone}`} aria-hidden="true" />
      <BrowserIcon />
      <span className="room-browser-label">Browser</span>
      {tabs > 0 ? <span className="panel-count mono">{tabs}</span> : null}
    </button>
  );
}

/**
 * The Browser tab of the room's side panel: whether its agents get browsers, which browser is the room's default,
 * which browsers they may use, and the default browser's process (status, watch link, tabs; Start or Stop at the
 * bottom). The browsers themselves are managed in the sidebar's Browsers section.
 */
export function RoomBrowserPanel({ onManage }: { onManage: (browserId: string | null) => void }) {
  const { snapshot, runCommand, refetch } = useRoom();
  const info = snapshot.browser;
  const power = useBrowserPower(info?.browser.id ?? "", refetch);
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
        <button type="button" className="small ghost" onClick={() => onManage(info?.browser.id ?? null)}>
          Manage…
        </button>
      </label>
      {info?.browser.description ? <p className="hint browser-purpose">{info.browser.description}</p> : null}

      {list && list.length > 1 ? (
        <div className="browser-allowed" role="group" aria-labelledby="browser-allowed-label">
          <span className="label" id="browser-allowed-label">
            Agents here may use
          </span>
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
        </div>
      ) : null}

      {info ? <BrowserStatusPanel status={info.status} error={power.error} /> : <p className="hint">No browser yet: create one under Browsers in the sidebar.</p>}

      {info ? (
        <div className="panel-actions">
          <BrowserPowerButton status={info.status} power={power} />
        </div>
      ) : null}
    </div>
  );
}
