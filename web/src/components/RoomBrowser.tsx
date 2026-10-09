import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { BrowserListItem, RoomBrowserStatus } from "../types.ts";
import { BrowserFormDialog } from "./BrowserForm.tsx";
import { CopyButton } from "./pickers.tsx";
import { GlobeGlyph } from "./icons.tsx";

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

/**
 * "Start browser" (the primary action while it is off) or "Stop browser", for a dialog's action row or a header. Named
 * `name`, as one of several browsers in a panel, it says only "Start" or "Stop" and keeps the browser in its label.
 */
export function BrowserPowerButton({ status, power, small, name }: { status: RoomBrowserStatus; power: BrowserPower; small?: boolean; name?: string }) {
  const noun = name ? "" : " browser";
  if (status.state === "running") {
    return (
      <button type="button" className={small ? "small" : undefined} disabled={power.busy} aria-label={name ? `Stop ${name}` : undefined} onClick={power.stop}>
        {power.busy ? "Stopping…" : `Stop${noun}`}
      </button>
    );
  }
  const starting = status.state === "starting" || power.busy;
  return (
    <button type="button" className={small ? "small primary" : "primary"} disabled={starting || status.mode === null} aria-label={name ? `Start ${name}` : undefined} onClick={power.start}>
      {starting ? "Starting…" : `Start${noun}`}
    </button>
  );
}

/** Tabs listed under a browser: the browser's own page lists ten; one of several in the room's side panel, five. */
const TABS_SHOWN = 10;
const TABS_SHOWN_COMPACT = 5;

/**
 * A browser's process as it is: state, the watch link, the DevTools address agents attach to, and the open tabs.
 * Shared by the room's Browser panel and the browser view; Start and Stop sit with each one's other actions, or in the
 * status row as `action`. `compact` is one of several in the room's side panel: it drops the hints the panel says once
 * (RoomBrowserHints), and `name` then tells apart the links of one browser from another's.
 */
export function BrowserStatusPanel({
  status,
  error,
  action,
  compact,
  name,
}: {
  status: RoomBrowserStatus;
  error: string | null;
  action?: ReactNode;
  compact?: boolean;
  name?: string;
}) {
  const running = status.state === "running";
  const unavailable = status.mode === null;
  const link = running ? watchUrl(status) : null;
  const shown = compact ? TABS_SHOWN_COMPACT : TABS_SHOWN;
  return (
    <>
      <div className="browser-status">
        <span className="label">Status</span>
        <span className={`browser-state is-${unavailable ? "unavailable" : status.state}`}>
          {unavailable ? "unavailable" : BROWSER_STATE_LABEL[status.state]}
          {running ? ` · ${status.mode === "vnc" ? "virtual screen" : status.mode === "window" ? "Chrome window" : "headless"}` : ""}
        </span>
        {action ? <span className="spacer" /> : null}
        {action}
      </div>

      {status.error || error ? <p className="status-error browser-error">{error ?? status.error}</p> : null}

      {running && status.mode === "vnc" && link ? (
        <div className="browser-row">
          <span className="label">Watch</span>
          <a href={link} target="_blank" rel="noreferrer noopener" aria-label={name ? `Open the screen of ${name}` : undefined}>
            Open the browser screen
          </a>
          <CopyButton text={link} label={name ? `Copy the watch link of ${name}` : "Copy watch link"} />
          {compact ? null : <span className="hint">Mouse and keyboard work: close tabs, type a password. The link holds the viewer password.</span>}
        </div>
      ) : null}
      {!compact && running && status.mode === "window" ? <p className="hint">It is a Chrome window on this computer with the browser&rsquo;s own profile; use it directly.</p> : null}
      {!compact && running && status.mode === "headless" ? (
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
            {status.tabs.slice(0, shown).map((tab) => (
              <li key={tab.id} title={tab.url}>
                <span className="tab-title">{tab.title || tab.url}</span>
                {tab.title && tab.title !== tab.url ? <span className="muted tab-url">{tab.url}</span> : null}
              </li>
            ))}
          </ul>
          {status.tabs.length > shown ? <span className="muted">and {status.tabs.length - shown} more</span> : null}
        </div>
      ) : null}
      {!compact && !running && !unavailable ? (
        <p className="hint">Stops by itself after a while with no activity and no work in flight; its profile, logins and tabs are kept.</p>
      ) : null}
    </>
  );
}

/** What each browser's status in the side panel would repeat, said once under the list, for the modes the browsers are in. */
function RoomBrowserHints({ statuses }: { statuses: RoomBrowserStatus[] }) {
  const running = statuses.filter((status) => status.state === "running");
  const hints = [
    running.some((status) => status.mode === "vnc") ? "Watch opens the browser's screen; mouse and keyboard work, so you can close tabs or type a password. The link holds the viewer password." : null,
    running.some((status) => status.mode === "window") ? "A Chrome window is on this computer with the browser's own profile; use it directly." : null,
    running.some((status) => status.mode === "headless") ? "Headless: no screen to watch; agents use it over DevTools. On Linux, installing Xvfb, x11vnc and noVNC makes it watchable." : null,
    statuses.some((status) => status.state !== "running" && status.mode !== null) ? "A browser stops by itself after a while with no activity and no work in flight; its profile, logins and tabs are kept." : null,
  ].filter((hint): hint is string => hint !== null);
  return hints.length > 0 ? <p className="hint">{hints.join(" ")}</p> : null;
}

/**
 * A globe, the browser buttons' icon. A green check marks browsers in use: turned on for a room's agents, or attached
 * to a thread's next message. A red dot marks a browser that failed to start.
 */
export function GlobeIcon({ checked, failed }: { checked: boolean; failed: boolean }) {
  return (
    <span className="globe" aria-hidden="true">
      <GlobeGlyph />
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
 * The room header's Browser switch, beside Members and Git: a globe, checked while the room's agents may
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
 * Which browsers the agents of a room, or of a thread outside rooms, may use: a box per browser with the name and
 * description they read, one of them the default. Every browser ticked is stored as "every browser" (null), which
 * takes in browsers added later; one stays ticked (none at all is browsers off). Unticking the default hands the
 * default to the first browser still ticked, in the same change.
 */
export function BrowserChoices({
  list,
  enabled,
  allowedIds,
  defaultId,
  busy,
  subject,
  onChange,
  onEdit,
  onOpen,
  statusOf,
}: {
  list: BrowserListItem[] | null;
  enabled: boolean;
  allowedIds: string[] | null;
  /** The default in use (the effective one). */
  defaultId: string | null;
  busy: boolean;
  subject: "room" | "thread";
  onChange: (next: { browserId?: string | null; allowed?: string[] | null }) => void;
  /** Edit a browser's name and description; without it there is no Edit link. */
  onEdit?: (browser: BrowserListItem) => void;
  /** Open a ticked browser's own page; without it there is no Page link. */
  onOpen?: (browser: BrowserListItem) => void;
  /** What to show under a ticked browser's description (its process); unticked browsers stay a plain line. */
  statusOf?: (browser: BrowserListItem) => ReactNode;
}) {
  const isAllowed = (browserId: string) => allowedIds === null || allowedIds.includes(browserId);
  const tickedCount = list ? list.filter((b) => isAllowed(b.id)).length : 0;
  const toggleAllowed = (browserId: string) => {
    if (!list) return;
    const current = allowedIds ?? list.map((b) => b.id);
    const unticking = isAllowed(browserId);
    const next = unticking ? current.filter((id) => id !== browserId) : [...current, browserId];
    if (next.length === 0) return;
    const allowed = list.every((b) => next.includes(b.id)) ? null : next;
    const successor = unticking && browserId === defaultId ? list.find((b) => next.includes(b.id))?.id : undefined;
    onChange({ allowed, ...(successor ? { browserId: successor } : {}) });
  };
  const labelId = `browser-choices-label-${subject}`;
  return (
    <div className={`browser-choices${enabled ? "" : " is-off"}`} role="group" aria-labelledby={labelId}>
      <span className="label" id={labelId}>
        {subject === "room" ? "Browsers they can use" : "Browsers it can use"}
      </span>
      {!list ? <p className="hint">Loading…</p> : null}
      {list?.map((browser) => {
        const allowed = isAllowed(browser.id);
        const isDefault = browser.id === defaultId;
        return (
          <div key={browser.id} className={`browser-choice${allowed ? "" : " unticked"}`}>
            <div className="browser-choice-head">
              <label className="checkbox" title={allowed && tickedCount === 1 ? `One browser stays ticked; to give this ${subject} none, turn browsers off above` : isDefault ? "Unticking the default makes the next ticked browser the default" : undefined}>
                <input type="checkbox" checked={allowed} disabled={busy || (allowed && tickedCount === 1)} onChange={() => toggleAllowed(browser.id)} />
                <span className="mono">{browser.name}</span>
              </label>
              {isDefault ? (
                <span className="pill pill-muted">default</span>
              ) : allowed ? (
                <button type="button" className="link-button" disabled={busy} onClick={() => onChange({ browserId: browser.id })}>
                  make default
                </button>
              ) : null}
              <span className="spacer" />
              {onEdit ? (
                <button type="button" className="link-button" onClick={() => onEdit(browser)} title="Edit the name and description agents read">
                  Edit
                </button>
              ) : null}
              {onOpen && allowed ? (
                <button type="button" className="link-button" onClick={() => onOpen(browser)} title="Open this browser's page: the rooms using it, its profile">
                  Page
                </button>
              ) : null}
            </div>
            <p className="browser-choice-purpose">{browser.description || <span className="muted">No description; agents see only the name.</span>}</p>
            {statusOf && allowed ? (
              <div className="browser-choice-status" role="group" aria-label={`${browser.name}: process`}>
                {statusOf(browser)}
              </div>
            ) : null}
          </div>
        );
      })}
      {list && list.length > 1 ? (
        <p className="hint">{allowedIds === null ? "All ticked: browsers you add later are included too." : "Browsers you add later start unticked here."}</p>
      ) : null}
    </div>
  );
}

/** One ticked browser's process in the side panel: status with Start or Stop, the watch link, the DevTools address and the tabs. */
function BrowserCardStatus({ browser, onChanged }: { browser: BrowserListItem; onChanged: () => void }) {
  const power = useBrowserPower(browser.id, onChanged);
  return (
    <BrowserStatusPanel status={browser.status} error={power.error} compact name={browser.name} action={<BrowserPowerButton status={browser.status} power={power} small name={browser.name} />} />
  );
}

/** How often the panel reads the browsers again; the service itself looks at their tabs every five seconds. */
const LIST_POLL_MS = 4000;

/**
 * The Browser tab of the room's side panel, in the order it matters to agents: first whether they are told about
 * browsers at all, then which browsers they may use. Each is a box with the name and description agents read
 * (editable here); the ones ticked also show their process, with Start or Stop, the watch link, the DevTools address
 * and the open tabs, the default marked as such, so any of them can be started, watched or logged into from here.
 * Unticked browsers stay a plain line. The browsers themselves are managed on their own pages (Page).
 */
export function RoomBrowserPanel({ onManage }: { onManage: (browserId: string) => void }) {
  const { snapshot, runCommand, refetch } = useRoom();
  const info = snapshot.browser;
  const enabled = snapshot.room.browserEnabled;
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<BrowserListItem[] | null>(null);
  const [editing, setEditing] = useState<BrowserListItem | null>(null);
  const loadList = useCallback(() => {
    api.browsers().then(
      (next) => setList((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
      // A read that fails keeps what the panel shows; before the first read there is nothing to keep.
      () => setList((prev) => prev ?? []),
    );
  }, []);
  // The room's snapshot changes at once when its default browser does (the service tells the room), so the list is read
  // again then; the others are read every few seconds.
  const defaultStatus = info ? JSON.stringify(info.status) : "";
  useEffect(loadList, [loadList, defaultStatus]);
  useEffect(() => {
    const timer = setInterval(loadList, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [loadList]);
  const changed = useCallback(() => {
    loadList();
    refetch();
  }, [loadList, refetch]);

  const unavailable = !info || info.status.mode === null;
  const setBrowser = async (next: { enabled: boolean; browserId?: string | null; allowed?: string[] | null }) => {
    setBusy(true);
    try {
      await runCommand({ type: "room.browser", roomId: snapshot.room.id, ...next });
    } finally {
      setBusy(false);
    }
  };
  const ticked = list?.filter((browser) => snapshot.room.allowedBrowserIds === null || snapshot.room.allowedBrowserIds.includes(browser.id)) ?? [];

  return (
    <div className="browser-panel">
      <label className="browser-toggle">
        <input type="checkbox" checked={enabled} disabled={busy || (unavailable && !enabled)} onChange={() => void setBrowser({ enabled: !enabled })} />
        <span>
          Let this room&rsquo;s agents use browsers
          <span className="hint">
            Each turn&rsquo;s briefing then lists the browsers ticked below, with what each is for, and how to drive them; the default starts
            before the turn is sent. While this is off, agents are not told about browsers and the browser tool refuses this room.
          </span>
        </span>
      </label>

      <BrowserChoices
        list={list}
        enabled={enabled}
        allowedIds={snapshot.room.allowedBrowserIds}
        defaultId={info?.browser.id ?? null}
        busy={busy}
        subject="room"
        onChange={(next) => void setBrowser({ enabled, ...next })}
        onEdit={setEditing}
        onOpen={(browser) => onManage(browser.id)}
        statusOf={(browser) => <BrowserCardStatus browser={browser} onChanged={changed} />}
      />

      {info ? <RoomBrowserHints statuses={ticked.map((browser) => browser.status)} /> : <p className="hint">No browser yet: create one under Browsers on the overview.</p>}

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
