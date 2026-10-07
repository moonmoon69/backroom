import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { useConsigliereSetting } from "../consigliere.ts";
import type { FolderListing, T3Project } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { FolderIcon, UpFolderIcon } from "./icons.tsx";
import { usePresets } from "./presets.tsx";
import { useToast } from "./Toast.tsx";

/** The dialogs that add a room or a project, from the overview's New menu and from the street. */

export function NewRoomDialog({
  initialProjectId,
  onClose,
  onCreate,
}: {
  initialProjectId: string | null;
  onClose: () => void;
  onCreate: (projectId: string, title: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const { presets } = usePresets();
  const consigliereSetting = useConsigliereSetting();
  const consigliere = presets.find((p) => p.id === consigliereSetting) ?? null;

  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const first = list.find((p) => p.id === initialProjectId) ?? list[0];
        if (first) {
          setProjectId(first.id);
          setTitle((t) => t || first.title);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProjects([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toast, initialProjectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !title.trim()) return;
    setBusy(true);
    try {
      await onCreate(projectId, title.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New room" onClose={onClose}>
      <form onSubmit={submit} className="form" id="new-room-form">
        <label>
          T3 project
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              const project = projects?.find((p) => p.id === event.target.value);
              if (project && !title) setTitle(project.title);
            }}
            disabled={!projects}
          >
            {!projects ? <option value="">Loading projects…</option> : null}
            {projects && projects.length === 0 ? <option value="">No projects available</option> : null}
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title} — {project.workspaceRoot}
              </option>
            ))}
          </select>
        </label>
        <label>
          Room title
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required data-autofocus />
        </label>
        <span className="hint">
          {consigliere
            ? `${consigliere.name} is seated as the room's Consigliere: the one you talk to there. He brings in the others.`
            : "No Consigliere is chosen (Settings → Consigliere…), so the room opens empty; add members from Members."}
        </span>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !projectId || !title.trim()}>
            Create room
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The folder most existing projects sit in ("/home/me/Projects"), as a starting point for a new one. */
function commonParent(projects: T3Project[]): string | null {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const parent = project.workspaceRoot.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Whether a typed path is a full one on the T3 machine (T3 resolves a relative path against its own folder). */
const isFullPath = (path: string): boolean => /^(~|\/|[A-Za-z]:[\\/])/.test(path);
const parentOf = (path: string): string => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
const trimSlashes = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * T3's folders for the path as it is typed, a moment after each keystroke. `path` is the one the listing is for, so a
 * listing of an older path is told apart from the current one's.
 */
function useFolderListing(typed: string): { path: string; listing: FolderListing | null } {
  const [state, setState] = useState<{ path: string; listing: FolderListing | null }>({ path: "", listing: null });
  useEffect(() => {
    if (!isFullPath(typed)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.folders(typed).then(
        (listing) => !cancelled && setState({ path: typed, listing }),
        (error) => !cancelled && setState({ path: typed, listing: { parentPath: null, entries: [], unreadable: error instanceof Error ? error.message : String(error) } }),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typed]);
  return state;
}

/**
 * New project: the folder is typed or browsed, as in T3 Code's own picker. The list under the field shows the
 * folders T3 finds for what is typed (a path ending in "/" lists that folder; otherwise the folders whose names start
 * with the last part); clicking one goes into it, ".." goes up. The folder the path names is the one added, whether
 * or not the path ends in "/", so browsing into a folder and pressing Add adds it. Only T3's own picker clones from a
 * Git URL or GitHub; add such a project in T3 Code and it shows here.
 */
export function NewProjectDialog({
  projects,
  onClose,
  onCreate,
}: {
  projects: T3Project[];
  onClose: () => void;
  onCreate: (input: { workspaceRoot: string; title?: string; createIfMissing: boolean }) => Promise<void>;
}) {
  const parent = useMemo(() => commonParent(projects), [projects]);
  const [path, setPath] = useState(parent ? `${parent}/` : "~/");
  const [title, setTitle] = useState("");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const typed = path.trim();
  const folder = trimSlashes(typed);
  const folderName = folder.split("/").pop() ?? "";
  const { path: listedFor, listing } = useFolderListing(typed);
  const current = listedFor === typed ? listing : null;
  const projectAt = (fullPath: string): T3Project | null => projects.find((p) => trimSlashes(p.workspaceRoot) === trimSlashes(fullPath)) ?? null;

  // What T3 says about the folder named: found (with its full path), not there, or nothing yet.
  const found = current?.parentPath ? (typed.endsWith("/") ? current.parentPath : (current.entries.find((e) => e.name === folderName)?.fullPath ?? null)) : null;
  const missing = current !== null && current.unreadable === null && found === null;
  const existing = found ? projectAt(found) : null;
  const ready = isFullPath(typed) && folderName.length > 0 && folderName !== "~" && !existing;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await onCreate({ workspaceRoot: folder, ...(title.trim() ? { title: title.trim() } : {}), createIfMissing: create });
    } finally {
      setBusy(false);
    }
  };

  // ".." lists the parent of the folder listed now (a trailing "/" lists rather than filters).
  const upFrom = current?.parentPath && current.parentPath !== "/" ? parentOf(current.parentPath) : null;
  const up = upFrom === null ? null : upFrom === "/" ? "/" : `${upFrom}/`;

  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="muted">Adds a project to T3 Code for a folder on the machine T3 runs on. Rooms and threads in it work in that folder.</p>
        <label>
          Folder
          <input type="text" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Projects/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-autofocus />
          <span className="hint">
            {!isFullPath(typed)
              ? "Type the full path on the T3 machine (~ works), or pick from the list."
              : existing
                ? `Already the project “${existing.title}”.`
                : found
                  ? `Adds ${found}.`
                  : missing
                    ? `${folder} does not exist on the T3 machine yet.`
                    : "Pick a folder below, or type the path."}
          </span>
        </label>
        <div className="folder-browse" role="group" aria-label="Folders on the T3 machine">
          {up ? (
            <button type="button" className="folder-row folder-up" onClick={() => setPath(up)} title={`Up to ${upFrom}`}>
              <UpFolderIcon />
              <span className="folder-name mono">..</span>
              <span className="folder-meta">{current!.parentPath}</span>
            </button>
          ) : null}
          {current?.entries.map((entry) => {
            const project = projectAt(entry.fullPath);
            return (
              <button type="button" key={entry.fullPath} className="folder-row" onClick={() => setPath(`${entry.fullPath}/`)} title={entry.fullPath}>
                <FolderIcon />
                <span className="folder-name">{entry.name}</span>
                {project ? <span className="folder-meta">project · {project.title}</span> : null}
              </button>
            );
          })}
          {current && current.unreadable === null && current.entries.length === 0 ? <span className="hint">{typed.endsWith("/") ? "No subfolders." : "No folder here starts with that."}</span> : null}
          {current?.unreadable ? <span className="hint">{current.unreadable}</span> : null}
          {!current && isFullPath(typed) ? <span className="hint">Looking…</span> : null}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
          Create the folder if it does not exist
        </label>
        <label>
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={folderName && folderName !== "~" ? folderName : "folder name"} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            Add project
          </button>
        </div>
      </form>
    </Dialog>
  );
}
