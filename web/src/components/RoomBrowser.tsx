import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { BrowserListItem, RoomBrowserStatus } from "../types.ts";
import { BrowserFormDialog } from "./BrowserForm.tsx";
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

/**
 * A globe, the browser buttons' icon. A green check marks browsers in use: turned on for a room's agents, or attached
 * to a thread's next message. A red dot marks a browser that failed to start.
 */
export function GlobeIcon({ checked, failed }: { checked: boolean; failed: boolean }) {
  return (
    <span className="globe" aria-hidden="true">
      <svg className="globe-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6.25" />
        <path d="M1.75 8h12.5" />
        <path d="M8 1.75c1.7 1.75 2.55 3.85 2.55 6.25S9.7 12.5 8 14.25C6.3 12.5 5.45 10.4 5.45 8S6.3 3.5 8 1.75z" />
      </svg>
      {failed ? (
        <span className="globe-badge globe-failed" />
      ) : checked ? (
        <span className="globe-badge globe-check">
          <svg viewBox="0 0 8 8">
            <path d="M1.9 4.2 3.4 5.6 6.2 2.6" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The room header's Browser switch, beside People, Tasks and Changes: a globe, checked while the room's agents may
 * use browsers, with the open tab count while its default browser runs. Opens the side panel on the room's browser.
 */
export function RoomBrowserButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { snapshot } = useRoom();
  const info = snapshot.browser;
  const enabled = snapshot.room.browserEnabled;
  const running = info?.status.state === "running";
  const tabs = running ? info.status.tabs.length : 0;
  const state = info ? `default "${info.browser.name}" ${BROWSER_STATE_LABEL[info.status.state]}${tabs > 0 ? `, ${tabs} tab${tabs === 1 ? "" : "s"}` : ""}` : "no browser yet";
  const title = `Browser: ${enabled ? "on" : "off"} for this room's agents · ${state}`;
  return (
    <button type="button" className={`small room-browser-button${active ? " active" : ""}`} aria-pressed={active} aria-label={title} title={title} onClick={onClick}>
      <GlobeIcon checked={enabled} failed={info?.status.state === "error"} />
      {tabs > 0 ? <span className="panel-count mono">{tabs}</span> : null}
    </button>
  );
}

/**
 * The Browser tab of the room's side panel, in the order it matters to agents: first whether they are told about
 * browsers at all, then which browsers they may use, each with the name and description they read (editable here),
 * one of them the default that starts for each task; then that default's process, with Start or Stop at the bottom.
 * The browsers themselves are managed in the sidebar's Browsers section.
 */
export function RoomBrowserPanel({ onManage }: { onManage: (browserId: string) => void }) {
  const { snapshot, runCommand, refetch } = useRoom();
  const info = snapshot.browser;
  const power = useBrowserPower(info?.browser.id ?? "", refetch);
  const enabled = snapshot.room.browserEnabled;
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<BrowserListItem[] | null>(null);
  const [editing, setEditing] = useState<BrowserListItem | null>(null);
  const loadList = useCallback(() => {
    api.browsers().then(setList, () => setList([]));
  }, []);
  useEffect(loadList, [loadList]);

  const unavailable = !info || info.status.mode === null;
  const allowedIds = snapshot.room.allowedBrowserIds;
  const isAllowed = (browserId: string) => allowedIds === null || allowedIds.includes(browserId);
  const setBrowser = async (next: { enabled: boolean; browserId?: string | null; allowed?: string[] | null }) => {
    setBusy(true);
    try {
      await runCommand({ type: "room.browser", roomId: snapshot.room.id, ...next });
    } finally {
      setBusy(false);
    }
  };
  const tickedCount = list ? list.filter((b) => isAllowed(b.id)).length : 0;
  const toggleAllowed = (browserId: string) => {
    if (!list) return;
    const current = allowedIds ?? list.map((b) => b.id);
    const unticking = isAllowed(browserId);
    const next = unticking ? current.filter((id) => id !== browserId) : [...current, browserId];
    if (next.length === 0) return;
    // Every browser ticked is stored as "every browser", which also takes in browsers added later.
    const allowed = list.every((b) => next.includes(b.id)) ? null : next;
    // Unticking the default hands the default to the first browser still ticked, in the same change.
    const successor = unticking && browserId === info?.browser.id ? list.find((b) => next.includes(b.id))?.id : undefined;
    void setBrowser({ enabled, allowed, ...(successor ? { browserId: successor } : {}) });
  };

  return (
    <div className="browser-panel">
      <label className="browser-toggle">
        <input type="checkbox" checked={enabled} disabled={busy || (unavailable && !enabled)} onChange={() => void setBrowser({ enabled: !enabled })} />
        <span>
          Let this room&rsquo;s agents use browsers
          <span className="hint">
            Each task&rsquo;s instructions then list the browsers ticked below, with what each is for, and how to drive them; the default starts
            before the task is sent. While this is off, agents are not told about browsers and the browser tool refuses this room.
          </span>
        </span>
      </label>

      <div className={`browser-choices${enabled ? "" : " is-off"}`} role="group" aria-labelledby="browser-choices-label">
        <span className="label" id="browser-choices-label">
          Browsers they can use
        </span>
        {!list ? <p className="hint">Loading…</p> : null}
        {list?.map((browser) => {
          const allowed = isAllowed(browser.id);
          const isDefault = browser.id === info?.browser.id;
          return (
            <div key={browser.id} className={`browser-choice${allowed ? "" : " unticked"}`}>
              <div className="browser-choice-head">
                <label className="checkbox" title={allowed && tickedCount === 1 ? "One browser stays ticked; to give this room none, turn browsers off above" : isDefault ? "Unticking the default makes the next ticked browser the default" : undefined}>
                  <input type="checkbox" checked={allowed} disabled={busy || (allowed && tickedCount === 1)} onChange={() => toggleAllowed(browser.id)} />
                  <span className="mono">{browser.name}</span>
                </label>
                {isDefault ? (
                  <span className="pill pill-muted">default</span>
                ) : allowed ? (
                  <button type="button" className="link-button" disabled={busy} onClick={() => void setBrowser({ enabled, browserId: browser.id })}>
                    make default
                  </button>
                ) : null}
                <span className="spacer" />
                <button type="button" className="link-button" onClick={() => setEditing(browser)} title="Edit the name and description agents read">
                  Edit
                </button>
              </div>
              <p className="browser-choice-purpose">{browser.description || <span className="muted">No description; agents see only the name.</span>}</p>
            </div>
          );
        })}
        {list && list.length > 1 ? (
          <p className="hint">{allowedIds === null ? "All ticked: browsers you add later are included too." : "Browsers you add later start unticked here."}</p>
        ) : null}
      </div>

      {info ? (
        <>
          <div className="browser-row">
            <span className="label">Default</span>
            <button type="button" className="link-button mono" onClick={() => onManage(info.browser.id)} title="Open this browser's page">
              {info.browser.name}
            </button>
          </div>
          <BrowserStatusPanel status={info.status} error={power.error} />
          <div className="panel-actions">
            <BrowserPowerButton status={info.status} power={power} />
          </div>
        </>
      ) : (
        <p className="hint">No browser yet: create one under Browsers in the sidebar.</p>
      )}

      {editing ? (
        <BrowserFormDialog
          title="Edit browser"
          submitLabel="Save"
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const result = await runCommand({ type: "browser.update", browserId: editing.id, ...values });
            if (result) {
              setEditing(null);
              loadList();
              refetch();
            }
          }}
        />
      ) : null}
    </div>
  );
}
