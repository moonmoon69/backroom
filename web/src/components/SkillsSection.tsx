import { useEffect, useState } from "react";
import { reloadAgentsFiles } from "../agentsFiles.ts";
import { api } from "../api.ts";
import { potetoMove, potetoPosition, potetoStatus, type PotetoPosition } from "../potetoStatus.ts";
import type { PotetoState, RoomCommand } from "../types.ts";
import { useToast } from "./Toast.tsx";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const when = (at: string | null): string => (at ? new Date(at).toLocaleString() : "never");

const POSITIONS: Array<{ key: PotetoPosition; label: string; hint: string }> = [
  { key: "off", label: "Off", hint: "No seat is pointed at pstack and nothing is fetched; the clone stays. Seats already told get a short note that it is off." },
  {
    key: "principles",
    label: "Principles and reply rules",
    hint: "Seats follow poteto-mode's principles, reply and comment rules. Its triggers and playbooks (fan-outs, subagent delegation, plan templates, pull requests) apply only when an assignment names them.",
  },
  { key: "full", label: "The whole mode", hint: "Triggers and playbooks included: for any non-trivial job a seat reads and follows poteto-mode." },
];

/**
 * Settings → Agents file, Skills (src/app/poteto.ts): how far seats follow pstack's poteto-mode (three positions, on the
 * service's two keys), what Backroom's clone holds (version, commit, last check, last change, folder), Update now, the pin
 * (Pin this version, Follow latest) and the last error. The settings are read again each second while a clone or an update
 * runs. A command, or the clone turning ready or no longer ready, reads the projects written again: both change what the
 * template renders for them. The radios stay enabled while a save runs, since disabling the focused one drops the focus
 * out of the group: a change meanwhile is ignored.
 */
export function SkillsSection() {
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
  const ready = state?.ready;
  useEffect(() => {
    if (ready !== undefined) reloadAgentsFiles();
  }, [ready]);
  const run = async (...commands: RoomCommand[]) => {
    setActing(true);
    try {
      let answer: PotetoState | null = null;
      for (const command of commands) {
        const result = await api.command(command);
        answer = "poteto" in result && result.poteto ? (result.poteto as PotetoState) : null;
      }
      if (answer) setState(answer);
      else await read();
      reloadAgentsFiles();
    } catch (error) {
      toast(message(error));
    } finally {
      setActing(false);
    }
  };
  const short = state?.commit ? state.commit.slice(0, 7) : null;
  return (
    <section className="agents-file-part" aria-label="Skills">
      <h3>Skills</h3>
      <p className="muted">
        pstack, Lauren Tan&rsquo;s skills for rigorous agent work (MIT, from cursor/plugins), kept up to date by Backroom and used as it is. Every seat is pointed at its entry point, poteto-mode: by a line in the agents file (
        <code>{"{poteto}"}</code> in the template) and by a Skills section in its briefing. README, &ldquo;Poteto mode&rdquo;, says more.
      </p>
      {loadError ? <p className="status-error">{loadError}</p> : null}
      {state ? (
        <>
          <fieldset aria-label="How far seats follow poteto-mode" aria-busy={acting}>
            {POSITIONS.map((option) => (
              <label key={option.key} className="radio">
                <input type="radio" name="poteto-position" checked={potetoPosition(state) === option.key} onChange={() => acting || void run(...potetoMove(state, option.key))} />
                <span>
                  <strong>{option.label}</strong>
                  <span className="hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="hint">AGENTS.md files already written keep their line until you apply the template to them: a change here shows them as differing under Projects written, and Apply pushes the new line.</p>
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
    </section>
  );
}
