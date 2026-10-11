/**
 * A project's setting for the browsers of its new rooms, on its section of the overview: the globe beside its +, and
 * the dialog it opens with a room's choices (browsers on or off, the ones they may use, the default). A room made in
 * the project starts with a copy; its own Browser panel then decides for it, and rooms that exist keep theirs.
 */
import { useState } from "react";
import type { BrowserListItem, CommandResult, ProjectBrowsersView, RoomCommand, T3Project } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { BrowserChoices, GlobeIcon } from "./RoomBrowser.tsx";

type RunCommand = (command: RoomCommand) => Promise<CommandResult | null>;

/** The button's name and title: what the project's new rooms start with. */
export function projectBrowsersTitle(project: Pick<T3Project, "title">, setting: ProjectBrowsersView | null | undefined, browsers: BrowserListItem[]): string {
  if (!setting) return `Browsers for new rooms in ${project.title}: off (no setting)`;
  if (!setting.enabled) return `Browsers for new rooms in ${project.title}: off`;
  const name = browsers.find((b) => b.id === setting.defaultBrowserId)?.name ?? "none";
  return `Browsers for new rooms in ${project.title}: on · default "${name}"`;
}

/** The globe on a project's head: checked while its new rooms start with browsers on. Opens the project's dialog. */
export function ProjectBrowsersButton({ project, browsers, runCommand, onChanged }: { project: T3Project; browsers: BrowserListItem[]; runCommand: RunCommand; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const title = projectBrowsersTitle(project, project.browsers, browsers);
  return (
    <>
      <button
        type="button"
        className="small ghost icon-only ov-project-new ov-project-browsers"
        aria-haspopup="dialog"
        aria-label={title}
        title={title}
        onClick={() => setOpen(true)}
        data-nav="ov"
        data-nav-key={`head:project-browsers:${project.id}`}
      >
        <GlobeIcon checked={project.browsers?.enabled ?? false} failed={false} />
      </button>
      {open ? <ProjectBrowsersDialog project={project} browsers={browsers} runCommand={runCommand} onChanged={onChanged} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ProjectBrowsersDialog({ project, browsers, runCommand, onChanged, onClose }: { project: T3Project; browsers: BrowserListItem[]; runCommand: RunCommand; onChanged: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const setting = project.browsers ?? null;
  // Without a setting, what a new room gets today: off, every browser, general (else the first) as its default.
  const enabled = setting?.enabled ?? false;
  const allowedIds = setting?.allowedBrowserIds ?? null;
  const defaultId = setting ? setting.defaultBrowserId : (browsers.find((b) => b.id === "general") ?? browsers[0])?.id ?? null;
  const set = async (next: { enabled: boolean | null; browserId?: string | null; allowed?: string[] | null }) => {
    setBusy(true);
    try {
      if (await runCommand({ type: "project.browser", projectId: project.id, ...next })) onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Browsers for new rooms in ${project.title}`} onClose={onClose}>
      <div className="browser-panel project-browsers-panel">
        <label className="browser-toggle">
          <input type="checkbox" checked={enabled} disabled={busy || browsers.length === 0} onChange={() => void set({ enabled: !enabled })} data-autofocus />
          <span>
            New rooms start with browsers on
            <span className="hint">
              A room made in this project (with + or by a conversation with the Consigliere) starts with these choices; its own Browser panel then
              decides for it. Rooms that exist keep theirs.
            </span>
          </span>
        </label>
        <BrowserChoices list={browsers} enabled={enabled} allowedIds={allowedIds} defaultId={defaultId} busy={busy} subject="project" onChange={(next) => void set({ enabled, ...next })} />
        <p className="hint">
          {setting ? "Clear the setting and new rooms start with browsers off, as without one." : "No setting yet: new rooms start with browsers off. Any change here saves one."}
        </p>
        <div className="dialog-actions">
          {setting ? (
            <button type="button" disabled={busy} onClick={() => void set({ enabled: null })}>
              Clear setting
            </button>
          ) : null}
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
