import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import type { HarnessUpdate, UpdatesView } from "../types.ts";
import { showUpdates, updateRunning, useUpdates, watchUpdates } from "../updates.ts";
import { Dialog } from "./Dialog.tsx";
import { timeOf } from "./deskFormat.ts";
import { UpdateIcon } from "./icons.tsx";
import { useToast } from "./Toast.tsx";

/**
 * The Updates button at the foot of the sidebar: a count when T3 or a harness can be updated, a spinner while an
 * update runs. It opens the Updates popup. `compact` (the collapsed rail) shows it only when there is something.
 */
export function UpdatesButton({ compact = false }: { compact?: boolean }) {
  const { view } = useUpdates();
  const [open, setOpen] = useState(false);
  const count = view?.available ?? 0;
  const running = view ? updateRunning(view) : false;
  if (compact && count === 0 && !running) return null;
  const label = running ? "Updates: one is running" : count > 0 ? `Updates: ${count} available` : "Updates: T3 and its harnesses";
  return (
    <>
      <button type="button" className={`small ghost icon-only updates-button${count > 0 ? " has-updates" : ""}`} aria-label={label} title={label} onClick={() => setOpen(true)}>
        {running ? <span className="spinner" aria-hidden="true" /> : <UpdateIcon />}
        {count > 0 && !running ? (
          <span className="updates-count" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>
      {open ? <UpdatesDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const messageOf = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const { view, error } = useUpdates();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => watchUpdates(), []);
  const start = async (key: string, action: () => Promise<UpdatesView>) => {
    setStarting(key);
    try {
      showUpdates(await action());
    } catch (caught) {
      toast(messageOf(caught));
    } finally {
      setStarting(null);
    }
  };
  const checkedAt = view?.harnesses.map((h) => h.checkedAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
  return (
    <Dialog title="Updates" onClose={onClose}>
      <div className="form updates">
        <p className="muted">Nothing here updates by itself: each update runs only when you click its button.</p>
        {view ? (
          <ul className="update-list">
            <T3Row view={view} starting={starting === "t3"} onUpdate={(version) => start("t3", () => api.updateT3(version))} />
            {view.harnesses.map((harness) => (
              <HarnessRow key={harness.instanceId} harness={harness} starting={starting === harness.instanceId} onUpdate={() => start(harness.instanceId, () => api.updateHarness(harness.instanceId))} />
            ))}
          </ul>
        ) : (
          <p className={error ? "status-error" : "muted mono"}>{error ?? "Checking…"}</p>
        )}
        {view && !view.reachable && view.server.job?.state !== "restarting" ? <p className="status-error">T3 does not answer: {view.error}</p> : null}
        <div className="dialog-actions">
          <span className="muted update-checked">{checkedAt ? `T3 checked the harnesses at ${timeOf(checkedAt)}` : ""}</span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await start("check", () => api.checkUpdates());
              setChecking(false);
            }}
          >
            {checking ? <span className="spinner" aria-hidden="true" /> : null} Check now
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ name, tag, versions, action, children }: { name: string; tag?: string | null; versions: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <li className="update-row">
      <div className="update-head">
        <span className="update-name">{name}</span>
        {tag ? <span className="tag mono">{tag}</span> : null}
        <span className="spacer" />
        {action}
      </div>
      <div className="update-versions mono">{versions}</div>
      {children}
    </li>
  );
}

const Working = ({ children }: { children: ReactNode }) => (
  <div className="update-status">
    <span className="spinner" aria-hidden="true" /> {children}
  </div>
);

/** T3 itself: its version, the newest on its channel, and the update with a confirmation (it restarts T3). */
function T3Row({ view, starting, onUpdate }: { view: UpdatesView; starting: boolean; onUpdate: (version: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const { version, latest, newer, canUpdate, manual, keepsTurns, releaseError, channel, job } = view.server;
  const running = job?.state === "installing" || job?.state === "restarting";
  const offer = newer && canUpdate && latest && !running;
  const versions = (
    <>
      {version ?? "unknown"}
      {newer && latest ? (
        <>
          {" → "}
          <strong>{latest}</strong>
        </>
      ) : null}
    </>
  );
  const action = offer && !confirming ? (
    <button type="button" className="small" disabled={starting} onClick={() => setConfirming(true)}>
      Update
    </button>
  ) : null;
  return (
    <Row name="T3" tag={channel} versions={versions} action={action}>
      {job?.state === "installing" ? <Working>Downloading and installing {job.targetVersion}…</Working> : null}
      {job?.state === "restarting" ? <Working>Restarting T3 on {job.targetVersion}…</Working> : null}
      {job?.state === "done" && version === job.targetVersion ? <div className="update-status update-ok">Updated to {job.targetVersion} at {timeOf(job.finishedAt)}</div> : null}
      {job?.state === "failed" ? <div className="update-status status-error">{job.error}</div> : null}
      {offer && confirming ? (
        <div className="update-confirm">
          <span>
            T3 installs {latest} and restarts. {keepsTurns ? "Turns that are running carry on after it." : "Turns that are running stop."}
          </span>
          <span className="update-confirm-actions">
            <button type="button" className="small ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="small primary"
              disabled={starting}
              onClick={() => {
                setConfirming(false);
                onUpdate(latest);
              }}
            >
              Update T3
            </button>
          </span>
        </div>
      ) : null}
      {newer && !canUpdate && manual ? <div className="update-status muted">{manual}</div> : null}
      {!newer && !running && !job ? <div className="update-status muted">{releaseError ? `Could not check for a newer T3 (${releaseError})` : "Up to date"}</div> : null}
    </Row>
  );
}

/** One harness: installed and newest version as T3 checked them, and T3's progress on its update. */
function HarnessRow({ harness, starting, onUpdate }: { harness: HarnessUpdate; starting: boolean; onUpdate: () => void }) {
  const state = harness.update;
  const busy = harness.pending || state?.status === "queued" || state?.status === "running";
  const versions =
    harness.status === "behind_latest" && harness.latestVersion ? (
      <>
        {harness.version ?? "unknown"}
        {" → "}
        <strong>{harness.latestVersion}</strong>
      </>
    ) : (
      <>
        {harness.version ?? "version unknown"}
        <span className="muted">{harness.status === "current" ? " · up to date" : " · newest unknown"}</span>
      </>
    );
  const action =
    harness.updatable && !busy ? (
      <button type="button" className="small" disabled={starting} onClick={onUpdate}>
        Update
      </button>
    ) : null;
  return (
    <Row name={harness.displayName} versions={versions} action={action}>
      {busy ? <Working>{state?.status === "queued" ? "Waiting for another update to finish…" : "Updating…"}</Working> : null}
      {!busy && state?.status === "succeeded" ? <div className="update-status update-ok">{(state.message ?? "Updated").replace(/\.$/, "")}{state.finishedAt ? ` at ${timeOf(state.finishedAt)}` : ""}</div> : null}
      {!busy && state?.status === "unchanged" ? <div className="update-status muted">{state.message ?? "The updater ran; the version did not change."}</div> : null}
      {!busy && state?.status === "failed" ? (
        <div className="update-status status-error">
          {state.message ?? "The update failed."}
          {state.output ? (
            <details className="update-output">
              <summary>Output</summary>
              <pre>{state.output}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {harness.error ? <div className="update-status status-error">{harness.error}</div> : null}
      {harness.note ? <div className="update-status muted">{harness.note}</div> : null}
    </Row>
  );
}
