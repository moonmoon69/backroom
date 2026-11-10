import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { reloadAgentsFiles, useAgentsFiles } from "../agentsFiles.ts";
import { templateSaved, type TemplateDraft } from "../agentsTemplate.ts";
import type { AgentsFileDiff, AgentsFileEntry } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { DiffView } from "./GitTab.tsx";
import { useToast } from "./Toast.tsx";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const folderName = (folder: string): string => folder.split("/").filter(Boolean).at(-1) ?? folder;

/** What Apply does, said wherever it is offered. */
const APPLY_SAYS = "Apply replaces the whole file, the project's own wording included, with the saved template rendered for it.";

const STATE_LABEL: Record<AgentsFileEntry["state"], string> = { same: "same as the template", differs: "differs", none: "no AGENTS.md", blocked: "blocked" };
const STATE_TITLE: Record<AgentsFileEntry["state"], string> = {
  same: "The project's AGENTS.md is the saved template rendered for it.",
  differs: "The project's AGENTS.md differs from the saved template rendered for it: written by hand, edited in the project, or written from an earlier template.",
  none: "The project's folder holds no AGENTS.md; Apply makes none.",
  blocked: "Backroom leaves this file alone.",
};

/**
 * Settings → Agents file. Instructions (src/app/agentsFile.ts): the switch for new rooms, the template they
 * write with Save and Reset to default, and every one of T3's projects with its AGENTS.md's state against the saved
 * template, whoever wrote it, and for the ones that differ the diff dialog, the one Apply is in (Show diff and Apply… both open it, as the
 * overview's mark does). Diff and Apply use the saved template, never the draft in the textarea. The packs' standing
 * lines that {skills} becomes are Settings → Skills' (SkillsDialog.tsx).
 */
export function AgentsFileDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [template, setTemplate] = useState<TemplateDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [diffFor, setDiffFor] = useState<AgentsFileEntry | null>(null);
  const { entries, error: listError } = useAgentsFiles();
  useEffect(() => {
    reloadAgentsFiles();
    api.settings().then(
      (settings) => {
        setEnabled(settings.agentsFile ?? true);
        if (settings.agentsFileText) setTemplate({ ...settings.agentsFileText, saved: settings.agentsFileText.text });
        else setLoadError("This service has no agents file template.");
      },
      (error: unknown) => setLoadError(message(error)),
    );
  }, []);
  const close = () => {
    reloadAgentsFiles();
    onClose();
  };
  const dirty = template !== null && template.text.trim() !== template.saved.trim();
  const toggle = async () => {
    if (enabled === null) return;
    try {
      await api.command({ type: "agentsFile.enabled.set", enabled: !enabled });
      setEnabled(!enabled);
    } catch (error) {
      toast(message(error));
    }
  };
  const save = async (next: string | null) => {
    if (!template) return;
    // What the textarea held when Save (or Reset) was clicked: typing done while the command runs is kept.
    const submitted = template.text;
    setSaving(true);
    try {
      await api.command({ type: "agentsFile.text.set", text: next });
      const text = next ?? template.defaultText;
      setTemplate((current) => current && templateSaved(current, submitted, text, next !== null));
      reloadAgentsFiles();
    } catch (error) {
      // The draft stays in the textarea.
      toast(message(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="Agents file" onClose={close} wide>
      <section className="agents-file-part" aria-label="Instructions">
        <h3>Instructions</h3>
        <p className="muted">
          The habits every agent in a project keeps, whoever assigned the work, in the project&rsquo;s AGENTS.md (with a CLAUDE.md importing it), where every harness reads it. It says nothing of models or routing: those belong to the
          crew and the Consigliere. Backroom&rsquo;s docs/agents-file-and-skills.md says where it is written and what is never touched.
        </p>
        {loadError ? <p className="status-error">{loadError}</p> : null}
        {enabled !== null ? (
          <label className="checkbox agents-file-switch">
            <input type="checkbox" checked={enabled} onChange={() => void toggle()} />
            <span>
              Write it when a project gets its first room
              <span className="hint">
                Once per project, where it has no instructions for agents yet, kept out of git, with a git hook that copies it into new worktrees. This switch governs that automatic writing only: Apply below is a click of
                yours and works with it off.
              </span>
            </span>
          </label>
        ) : null}
        {template ? (
          <label className="consigliere-rules agents-file-template">
            The template
            <textarea
              className="mono"
              rows={10}
              value={template.text}
              spellCheck={false}
              onChange={(e) => {
                const text = e.target.value;
                setTemplate((current) => current && { ...current, text });
              }}
            />
            <span className="hint">
              {template.custom ? "This is your template." : "This is Backroom's template; change it to your liking."} <code>{"{checks}"}</code> is filled per project with the checks its package scripts or Makefile name; <code>{"{skills}"}</code>, on a line of its own, is
              one line per skill pack with a standing line (Settings → Skills), and goes when none has one, so a change there shows the projects written from it as differing. The file is written
              once, when a project&rsquo;s first room is made, so a change reaches only projects written afterwards; every project is listed below with its own AGENTS.md&rsquo;s state.
            </span>
            <span className="task-actions">
              <button type="button" className="small primary" disabled={saving || template.text.trim().length === 0 || !dirty} onClick={() => void save(template.text.trim())}>
                Save template
              </button>
              <button type="button" className="small ghost" disabled={saving || (!template.custom && template.text === template.saved)} title="Go back to Backroom's template" onClick={() => void save(null)}>
                Reset to default
              </button>
            </span>
          </label>
        ) : null}
        <section className="agents-file-projects" aria-label="Every project's AGENTS.md">
          <h4 className="agents-file-heading">Projects</h4>
          <p className="hint">
            {APPLY_SAYS} Nothing applies without your click; CLAUDE.md, git and the worktrees that already hold a copy keep theirs.
            {dirty ? " Save the template first: Show diff and Apply use the saved one." : ""}
          </p>
          {listError ? <p className="status-error">{listError}</p> : null}
          {entries === null && !listError ? <p className="mono muted">reading the projects…</p> : null}
          {entries?.length === 0 ? <p className="muted">T3 has no projects yet.</p> : null}
          {entries && entries.length > 0 ? (
            <ul className="agents-file-list">
              {entries.map((entry) => (
                <li key={entry.projectId} className="agents-file-row" data-state={entry.state}>
                  <span className="agents-file-name">{entry.title || folderName(entry.folder)}</span>
                  <span className="agents-file-folder mono muted" title={entry.folder}>
                    {entry.folder}
                  </span>
                  <span className={`tag agents-file-state agents-file-${entry.state}`} title={entry.reason ?? STATE_TITLE[entry.state]}>
                    {STATE_LABEL[entry.state]}
                  </span>
                  {entry.state === "differs" ? (
                    <span className="agents-file-actions">
                      <button type="button" className="small ghost" disabled={dirty} title={dirty ? "Save the template first" : "The project's file against the saved template"} onClick={() => setDiffFor(entry)}>
                        Show diff
                      </button>
                      <button type="button" className="small" disabled={dirty} title={dirty ? "Save the template first" : "Opens the diff, with Apply at its end: you apply what you see"} onClick={() => setDiffFor(entry)}>
                        Apply…
                      </button>
                    </span>
                  ) : null}
                  {entry.state === "blocked" && entry.reason ? <span className="agents-file-reason hint">{entry.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </section>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
      {diffFor ? <AgentsFileDiffDialog entry={diffFor} onClose={() => setDiffFor(null)} /> : null}
    </Dialog>
  );
}

/**
 * One project's AGENTS.md against the saved template rendered for it, drawn as the Git tab draws a diff, with Apply at
 * its end. Apply sends the digests of what this dialog showed: the service refuses it when either side changed since.
 */
export function AgentsFileDiffDialog({ entry, onClose }: { entry: Pick<AgentsFileEntry, "projectId" | "folder" | "title">; onClose: () => void }) {
  const { toast } = useToast();
  const [result, setResult] = useState<AgentsFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.agentsFileDiff(entry.projectId).then(
      (value) => !cancelled && setResult(value),
      (caught: unknown) => !cancelled && setError(message(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [entry.projectId]);
  const close = () => {
    reloadAgentsFiles();
    onClose();
  };
  const apply = async () => {
    if (!result) return;
    setApplying(true);
    setError(null);
    try {
      await api.command({ type: "agentsFile.apply", projectId: result.projectId, fileDigest: result.fileDigest, templateDigest: result.templateDigest });
      toast(`AGENTS.md in ${result.folder} now holds the saved template`, "success");
      close();
    } catch (caught) {
      setError(message(caught));
      setApplying(false);
    }
  };
  return (
    <Dialog title={`AGENTS.md in ${entry.title || folderName(entry.folder)}`} onClose={close} wide>
      <p className="git-diff-source mono muted">{entry.folder} · − the project&rsquo;s file, + the saved template rendered for it</p>
      {!result && !error ? <p className="mono muted">reading the diff…</p> : null}
      {result && result.state === "same" ? <p className="muted">The project&rsquo;s file is the saved template rendered for it: nothing to apply.</p> : null}
      {result ? <DiffView diff={result.diff} label={`Diff of AGENTS.md in ${result.folder}`} /> : null}
      {error ? <p className="status-error">{error}</p> : null}
      {result?.state === "differs" ? (
        <p className="hint">
          {APPLY_SAYS} CLAUDE.md, git and the worktrees that already hold a copy keep theirs; the project is never committed to.
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={close}>
          Close
        </button>
        {result?.state === "differs" ? (
          <button type="button" className="primary" disabled={applying} onClick={() => void apply()}>
            Apply the template
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The overview's quiet mark on a project heading whose AGENTS.md differs from the saved template. */
export function AgentsFileMark({ entry, onOpen }: { entry: AgentsFileEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="tag ov-agents-mark"
      title="This project's AGENTS.md differs from the saved template (Settings → Agents file). Click for the diff; nothing changes unless you apply it."
      aria-label={`AGENTS.md differs from the template in ${entry.title || folderName(entry.folder)}: show the diff`}
      onClick={onOpen}
      data-nav="ov"
      data-nav-key={`head:agents:${entry.projectId}`}
    >
      AGENTS.md differs
    </button>
  );
}
