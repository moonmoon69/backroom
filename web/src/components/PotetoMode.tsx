import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { potetoStatus } from "../potetoStatus.ts";
import type { PotetoState } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { useToast } from "./Toast.tsx";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const when = (at: string | null): string => (at ? new Date(at).toLocaleString() : "never");

/**
 * Settings → Poteto mode (src/app/poteto.ts): the switch, what Backroom's pstack clone holds (version, commit, last check,
 * last change, folder), Update now, the pin (Pin this version, Follow latest) and the last error. The settings are read
 * again each second while a clone or an update runs.
 */
export function PotetoDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [state, setState] = useState<PotetoState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const read = () =>
    api.settings().then(
      (settings) => {
        if (settings.poteto) setState(settings.poteto);
        else setLoadError("This service keeps no pstack clone.");
      },
      (error: unknown) => setLoadError(message(error)),
    );
  useEffect(() => {
    void read();
  }, []);
  const busy = state?.busy ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const run = async (command: Parameters<typeof api.command>[0]) => {
    setActing(true);
    try {
      const result = await api.command(command);
      if ("poteto" in result && result.poteto) setState(result.poteto as PotetoState);
      else await read();
    } catch (error) {
      toast(message(error));
    } finally {
      setActing(false);
    }
  };
  const short = state?.commit ? state.commit.slice(0, 7) : null;
  return (
    <Dialog title="Poteto mode" onClose={onClose} wide>
      <p className="muted">
        pstack, Lauren Tan&rsquo;s skills for rigorous agent work (MIT, from cursor/plugins), kept up to date by Backroom and used as it is. Every seat is pointed at its entry point, poteto-mode: by a line in the agents file (
        <code>{"{poteto}"}</code> in the template) and by a Skills section in its briefing, with Backroom&rsquo;s three differences (a Handoff instead of a pull request, parallel work through the room&rsquo;s members, routing by the
        crew). README, &ldquo;Poteto mode&rdquo;, says more.
      </p>
      {loadError ? <p className="status-error">{loadError}</p> : null}
      {state ? (
        <>
          <label className="checkbox agents-file-switch">
            <input type="checkbox" checked={state.enabled} disabled={acting} onChange={() => void run({ type: "poteto.enabled.set", enabled: !state.enabled })} />
            <span>
              Point every seat at poteto-mode
              <span className="hint">
                On by default. Off, nothing is fetched and the clone stays; seats already told get a short note that it is off. AGENTS.md files already written keep their poteto-mode line until you apply the template to them: Settings
                → Agents file shows them as differing. Turning it on again shows them as differing the other way.
              </span>
            </span>
          </label>
          <dl className="poteto-facts">
            <dt>Version</dt>
            <dd className="mono">{state.version ?? "—"}</dd>
            <dt>Commit</dt>
            <dd className="mono" title={state.commit ?? undefined}>
              {short ?? "—"}
              {state.pinned ? <span className="tag poteto-pin">{state.pinned}</span> : null}
            </dd>
            <dt>Last check</dt>
            <dd>{when(state.checkedAt)}</dd>
            <dt>Last change</dt>
            <dd className="mono">{state.lastChange ?? "—"}</dd>
            <dt>Folder</dt>
            <dd className="mono" title={state.source}>
              {state.folder}
            </dd>
          </dl>
          <p className="hint" aria-live="polite">
            {potetoStatus(state)}
          </p>
          {state.error ? (
            <p className="status-error poteto-error">
              The last {state.error.during} failed ({when(state.error.at)}): {state.error.reason}. It is tried again next time.
            </p>
          ) : null}
          <span className="task-actions">
            <button type="button" className="small primary" disabled={acting || state.busy || !state.enabled} title={state.enabled ? "Fetch pstack now and fast-forward, or keep the pin" : "Poteto mode is off"} onClick={() => void run({ type: "poteto.update" })}>
              Update now
            </button>
            {state.pin ? (
              <button type="button" className="small ghost" disabled={acting || state.busy} title="Follow origin's main again: the next update fast-forwards" onClick={() => void run({ type: "poteto.pin.set", pin: null })}>
                Follow latest
              </button>
            ) : (
              <button type="button" className="small ghost" disabled={acting || state.busy || !state.commit} title="Keep this commit: updates fetch but do not move it (to roll back, pin an older commit)" onClick={() => void run({ type: "poteto.pin.set", pin: state.commit })}>
                Pin this version
              </button>
            )}
          </span>
        </>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
