/**
 * One browser from the list: what it is for, its process (start, stop, watch, tabs), the rooms using it as their
 * default, and its profile (size, reset, delete). The profile holds logins; any agent using the browser can use them.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import type { BrowserListItem, CommandResult, RoomCommand } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { BrowserPowerButton, BrowserStatusPanel, useBrowserPower } from "./RoomBrowser.tsx";

type RunCommand = (command: RoomCommand) => Promise<CommandResult | null>;

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Browser names are what agents type: lowercase letters, digits and dashes. */
export const browserNameFrom = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40);

interface BrowserViewProps {
  browserId: string;
  runCommand: RunCommand;
  /** The browser was deleted (here or elsewhere). */
  onGone: () => void;
  /** The list in the sidebar should refresh (renamed, started, stopped). */
  onChanged: () => void;
  onOpenRoom: (roomId: string) => void;
  headerStart: ReactNode;
}

export function BrowserView({ browserId, runCommand, onGone, onChanged, onOpenRoom, headerStart }: BrowserViewProps) {
  const [item, setItem] = useState<BrowserListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"edit" | "reset" | "delete" | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const data = await api.browser(browserId);
        if (cancelled) return;
        setItem(data);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 404) {
          gone.current();
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!cancelled) timer = setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [browserId, nonce]);

  const changed = () => {
    refresh();
    onChanged();
  };
  const power = useBrowserPower(browserId, changed);

  return (
    <>
      <div className="room-header">
        {headerStart}
        <h1 className="room-title mono">{item?.name ?? "Browser"}</h1>
        <span className="spacer" />
        {item ? (
          <>
            <BrowserPowerButton status={item.status} power={power} small />
            <button type="button" className="small ghost" onClick={() => setDialog("edit")}>
              Edit
            </button>
            <button type="button" className="small ghost" onClick={() => setDialog("reset")} title="Wipe logins, history and saved tabs">
              Reset profile…
            </button>
            <button type="button" className="small ghost danger" onClick={() => setDialog("delete")}>
              Delete…
            </button>
          </>
        ) : null}
      </div>
      <div className="browser-view">
        {!item ? (
          <p className="muted">{error ? `Could not read the browser: ${error}` : "Loading…"}</p>
        ) : (
          <>
            <section>
              <h2 className="browser-section-title">What it is for</h2>
              {item.description ? (
                <p className="browser-description">{item.description}</p>
              ) : (
                <p className="muted">
                  No description. Agents choose browsers by what they are for;{" "}
                  <button type="button" className="link-button" onClick={() => setDialog("edit")}>
                    add one
                  </button>
                  .
                </p>
              )}
            </section>
            <section className="browser-panel-inline">
              <BrowserStatusPanel status={item.status} error={power.error} />
            </section>
            <section>
              <h2 className="browser-section-title">Rooms using it by default</h2>
              {item.usedBy.length === 0 ? (
                <p className="muted">None. A room picks its default browser with the Browser button in its header.</p>
              ) : (
                <ul className="browser-used-by">
                  {item.usedBy.map((room) => (
                    <li key={room.roomId}>
                      <button type="button" className="link-button" onClick={() => onOpenRoom(room.roomId)}>
                        {room.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h2 className="browser-section-title">Profile</h2>
              <p className="muted">
                {typeof item.profileBytes === "number" ? `${formatBytes(item.profileBytes)} on disk. ` : ""}
                Logins, history and open tabs are kept across stops and restarts. Anyone using this browser, agents included, can use its logins.
              </p>
            </section>
          </>
        )}
      </div>
      {dialog === "edit" && item ? (
        <BrowserFormDialog
          title="Edit browser"
          submitLabel="Save"
          initial={item}
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            const result = await runCommand({ type: "browser.update", browserId: item.id, ...values });
            if (result) {
              setDialog(null);
              changed();
            }
          }}
        />
      ) : null}
      {dialog === "reset" && item ? (
        <Dialog title="Reset profile" onClose={() => setDialog(null)}>
          <p className="remove-lede">
            Wipe <strong className="mono">{item.name}</strong>&rsquo;s logins, history and saved tabs? It stops first, and starts fresh next time. Its name, purpose and address stay.
          </p>
          <ConfirmActions
            label="Reset profile"
            onCancel={() => setDialog(null)}
            onConfirm={async () => {
              await api.browserReset(item.id);
              setDialog(null);
              changed();
            }}
          />
        </Dialog>
      ) : null}
      {dialog === "delete" && item ? (
        <Dialog title="Delete browser" onClose={() => setDialog(null)}>
          {item.usedBy.length > 0 ? (
            <>
              <p className="remove-lede">
                <strong className="mono">{item.name}</strong> is the default browser of {item.usedBy.map((r) => r.title).join(", ")}. Pick another default in those rooms first.
              </p>
              <div className="dialog-actions">
                <button type="button" onClick={() => setDialog(null)}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="remove-lede">
                Delete <strong className="mono">{item.name}</strong>? It stops, and its profile (logins, history, tabs) is removed for good.
              </p>
              <ConfirmActions
                label="Delete browser"
                onCancel={() => setDialog(null)}
                onConfirm={async () => {
                  const result = await runCommand({ type: "browser.delete", browserId: item.id });
                  setDialog(null);
                  if (result) onGone();
                }}
              />
            </>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

function ConfirmActions({ label, onCancel, onConfirm }: { label: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-actions">
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className="primary destructive"
        data-autofocus
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </button>
    </div>
  );
}

/** Name and purpose of a browser; used to create one and to edit one. */
export function BrowserFormDialog({
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string };
  onClose: () => void;
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const cleanName = name.replace(/-+$/, "");
  const valid = NAME_PATTERN.test(cleanName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await onSubmit({ name: cleanName, description: description.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input
            type="text"
            className="mono"
            value={name}
            onChange={(e) => setName(browserNameFrom(e.target.value))}
            placeholder="t3-rooms-testing"
            spellCheck={false}
            autoCapitalize="off"
            data-autofocus
          />
          <span className="hint">What agents call it: lowercase letters, digits and dashes.</span>
        </label>
        <label>
          What it is for
          <textarea
            rows={3}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Logged into staging T3 Rooms as the test user; use for integration tests."
          />
          <span className="hint">Shown to agents with the list of browsers, so they pick the right one. Mention the logins it holds.</span>
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
