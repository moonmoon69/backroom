import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useRoom } from "../context.tsx";
import type { GitCommit, GitCommitFile, GitDiff, GitFolder, GitView, GitWorkingFile, GitWorktree, Participant } from "../types.ts";
import { ageOf } from "./deskFormat.ts";
import { Dialog } from "./Dialog.tsx";
import { BranchIcon, ChevronIcon } from "./icons.tsx";
import { Monogram } from "./Monogram.tsx";

/** ~/… for paths under the service machine's home folder. */
const homePath = (path: string, home: string): string => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const STATUS: Record<GitWorkingFile["status"], { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "A", label: "Copied" },
  typechange: { letter: "T", label: "Type changed" },
  untracked: { letter: "U", label: "Untracked (new, not added)" },
  conflict: { letter: "C", label: "Conflict" },
};

const STAGED: Record<GitWorkingFile["staged"], string> = { all: "staged", part: "partly staged", none: "" };

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null && deletions === null) return <span className="muted">binary</span>;
  return (
    <span className="git-counts">
      {additions ? <span className="add">+{additions}</span> : null}
      {deletions ? <span className="del">−{deletions}</span> : null}
    </span>
  );
}

/** What a diff dialog shows: a file's uncommitted change, or its change in one commit. */
interface DiffTarget {
  folder: string;
  path: string;
  origPath: string | null;
  commit: GitCommit | null;
  untracked: boolean;
}

/**
 * The Git tab: the room's working folders (each participant's worktree, or the project's folder), and for the one
 * shown its branch and upstream, uncommitted files, recent commits and the repository's worktrees. Files open their
 * diff. Read from git on the machine the room service runs on.
 */
export function GitTab() {
  const { git, snapshot } = useRoom();
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const data = git.data;
  const participants = snapshot.participants;

  if (!data) {
    return <div className="inspector-empty">{git.error ? <p className="status-error">{git.error}</p> : <p className="mono muted">reading git…</p>}</div>;
  }
  if (data.folders.length === 0) {
    return (
      <div className="inspector-empty">
        <p className="serif">T3 has no folder for this room's project.</p>
      </div>
    );
  }
  const selected = data.folders.find((folder) => folder.path === git.path)?.path ?? git.path ?? data.folders[0]!.path;
  const view = data.view && data.view.path === selected ? data.view : null;
  const folder = data.folders.find((f) => f.path === selected) ?? null;
  const here = (folder?.participantIds ?? []).map((id) => participants.find((p) => p.id === id)).filter(Boolean) as Participant[];

  return (
    <>
      {data.folders.length > 1 ? <FolderSwitch folders={data.folders} selected={selected} home={data.home} onSelect={git.setPath} /> : null}
      {view ? (
        <>
          <CheckoutHead view={view} home={data.home} here={here} />
          {view.exists && view.isRepo && !view.error ? (
            <>
              <WorkingFiles view={view} here={here} onOpen={(file) => setDiff({ folder: view.path, path: file.path, origPath: file.origPath, commit: null, untracked: file.status === "untracked" })} />
              <WorktreeList view={view} folders={data.folders} home={data.home} onSelect={git.setPath} />
              <CommitList view={view} onMore={git.showMoreCommits} onOpen={(commit, file) => setDiff({ folder: view.path, path: file.path, origPath: file.origPath, commit, untracked: false })} />
            </>
          ) : null}
        </>
      ) : (
        <p className="mono muted">reading {homePath(selected, data.home)}…</p>
      )}
      {diff ? <GitDiffDialog target={diff} onClose={() => setDiff(null)} /> : null}
    </>
  );
}

/** The room's folders, when its threads work in more than one: pick the one the tab shows. */
function FolderSwitch({ folders, selected, home, onSelect }: { folders: GitFolder[]; selected: string; home: string; onSelect: (path: string) => void }) {
  const { participantById } = useRoom();
  return (
    <div className="git-folders" role="group" aria-label="Working folders">
      {folders.map((folder) => {
        const people = folder.participantIds.map(participantById).filter(Boolean) as Participant[];
        const on = folder.path === selected;
        return (
          <button
            key={folder.path}
            type="button"
            className={`git-folder small${on ? " active" : ""}`}
            aria-pressed={on}
            title={`${homePath(folder.path, home)}${people.length > 0 ? ` · ${people.map((p) => p.alias).join(", ")}` : " · nobody works here"}`}
            onClick={() => onSelect(folder.path)}
          >
            <BranchIcon />
            <span className="git-folder-name mono">{folder.branch ?? (folder.exists ? (folder.isRepo ? "detached" : "no git") : "not here")}</span>
            {people.length > 0 ? (
              <span className="git-people">
                {people.map((p) => (
                  <Monogram key={p.id} participant={p} size="xs" />
                ))}
              </span>
            ) : null}
            {folder.changed > 0 ? <span className="panel-count mono">{folder.changed}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Branch, where it stands against its upstream, the folder and who works in it. */
function CheckoutHead({ view, home, here }: { view: GitView; home: string; here: Participant[] }) {
  const sync = view.upstream
    ? view.ahead === 0 && view.behind === 0
      ? `up to date with ${view.upstream}`
      : [view.ahead > 0 ? `${view.ahead} to push` : "", view.behind > 0 ? `${view.behind} to pull` : ""].filter(Boolean).join(" · ") + ` · ${view.upstream}`
    : view.isRepo && !view.detached
      ? "no upstream: not pushed anywhere"
      : "";
  return (
    <section className="git-head" aria-label="Checkout">
      <div className="git-branch">
        <BranchIcon />
        <span className="mono">{view.branch ?? (view.head ? `detached at ${view.head.shortSha}` : view.isRepo ? "no commits yet" : "—")}</span>
        {view.isRepo ? <span className="tag">{view.isLinkedWorktree ? "worktree" : "main checkout"}</span> : null}
      </div>
      {sync ? <div className={`git-sync mono${view.ahead > 0 || view.behind > 0 ? " pending" : ""}`}>{sync}</div> : null}
      <div className="git-path mono muted" title={view.path}>
        {homePath(view.path, home)}
        {view.repoName && view.isLinkedWorktree ? <span> · of {view.repoName}</span> : null}
      </div>
      {here.length > 0 ? (
        <div className="git-here">
          {here.map((p) => (
            <span key={p.id} className="git-here-one">
              <Monogram participant={p} size="xs" />
              <span className="mono identity">{p.alias}</span>
            </span>
          ))}
          <span className="muted">work{here.length === 1 ? "s" : ""} here</span>
        </div>
      ) : null}
      {!view.exists ? (
        <p className="git-note">
          This folder isn't on the machine the room service runs on, so its git can't be read here. T3 keeps it where the T3 server runs.
        </p>
      ) : !view.isRepo ? (
        <p className="git-note">Not a git repository.</p>
      ) : view.error ? (
        <p className="git-note status-error">{view.error}</p>
      ) : null}
    </section>
  );
}

/** Uncommitted files, with who in the room changed each since the last commit. */
function WorkingFiles({ view, here, onOpen }: { view: GitView; here: Participant[]; onOpen: (file: GitWorkingFile) => void }) {
  const { desk } = useRoom();
  const totals = view.files.reduce((sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), { additions: 0, deletions: 0 });
  // A participant working here changed a file if one of their turns touched it after the last commit.
  const since = view.head ? Date.parse(view.head.committedAt) : 0;
  const changedBy = useMemo(() => {
    const byPath = new Map<string, Participant[]>();
    for (const participant of here) {
      for (const file of desk?.participants[participant.id]?.changedFiles ?? []) {
        if (!file.lastAt || Date.parse(file.lastAt) <= since) continue;
        const path = view.prefix + file.path;
        byPath.set(path, [...(byPath.get(path) ?? []), participant]);
      }
    }
    return byPath;
  }, [desk, here, since, view.prefix]);
  return (
    <section className="lane git-section" aria-label="Uncommitted">
      <h3>
        <span className="lane-title">Uncommitted</span>
        <span className="lane-count mono">{view.files.length}</span>
        <span className="spacer" />
        {view.files.length > 0 ? (
          <span className="lane-count mono">
            <Counts {...totals} />
          </span>
        ) : null}
      </h3>
      {view.files.length === 0 ? (
        <p className="lane-hint mono muted">clean: nothing since {view.head ? view.head.shortSha : "the first commit"}</p>
      ) : (
        <ul className="git-list">
          {view.files.map((file) => {
            const status = STATUS[file.status];
            const { dir, name } = splitPath(file.path);
            const who = changedBy.get(file.path) ?? [];
            const stage = STAGED[file.staged];
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="git-row"
                  title={`${status.label}${stage ? `, ${stage}` : ""}${file.origPath ? ` from ${file.origPath}` : ""}${who.length > 0 ? ` · changed by ${who.map((p) => p.alias).join(", ")}` : ""}\nShow the diff`}
                  onClick={() => onOpen(file)}
                >
                  <span className={`git-status mono status-${file.status}`}>{status.letter}</span>
                  <span className="git-file mono">
                    <span className="git-name">{name}</span>
                    {dir ? <span className="git-dir">{dir}</span> : null}
                  </span>
                  {who.length > 0 ? (
                    <span className="git-people">
                      {who.map((p) => (
                        <Monogram key={p.id} participant={p} size="xs" />
                      ))}
                    </span>
                  ) : null}
                  {stage ? <span className="git-staged mono">{file.staged === "all" ? "staged" : "part staged"}</span> : null}
                  <span className="git-meta mono">
                    <Counts additions={file.additions} deletions={file.deletions} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Recent commits on the branch; each opens to its files. */
function CommitList({ view, onMore, onOpen }: { view: GitView; onMore: () => void; onOpen: (commit: GitCommit, file: GitCommitFile) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (sha: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  const unpushed = view.commits.filter((c) => c.pushed === false).length;
  return (
    <section className="lane git-section" aria-label="Commits">
      <h3>
        <span className="lane-title">Commits</span>
        <span className="lane-count mono">{view.commits.length}{view.moreCommits ? "+" : ""}</span>
        <span className="spacer" />
        {unpushed > 0 ? <span className="lane-count mono">{unpushed} not pushed</span> : null}
      </h3>
      {view.commits.length === 0 ? <p className="lane-hint mono muted">no commits yet</p> : null}
      <ul className="git-list">
        {view.commits.map((commit) => {
          const expanded = open.has(commit.sha);
          return (
            <li key={commit.sha} className={commit.pushed === false ? "unpushed" : ""}>
              <button type="button" className="git-row git-commit" aria-expanded={expanded} title={`${commit.sha}\n${commit.author}, ${new Date(commit.authoredAt).toLocaleString()}`} onClick={() => toggle(commit.sha)}>
                <ChevronIcon dir={expanded ? "down" : "right"} />
                <span className="git-commit-text">
                  <span className="git-subject">{commit.subject}</span>
                  <span className="git-commit-meta mono">
                    <span className="git-sha">{commit.shortSha}</span>
                    <span>{commit.author}</span>
                    <span>{ageOf(commit.authoredAt)}</span>
                    <span>
                      {commit.fileCount} file{commit.fileCount === 1 ? "" : "s"}
                    </span>
                    <Counts additions={commit.additions} deletions={commit.deletions} />
                    {commit.pushed === false ? <span className="pill pill-waiting">not pushed</span> : null}
                    {commit.isMerge ? <span className="tag">merge</span> : null}
                  </span>
                </span>
              </button>
              {expanded ? (
                <ul className="git-list git-commit-files">
                  {commit.files.map((file) => {
                    const { dir, name } = splitPath(file.path);
                    return (
                      <li key={file.path}>
                        <button type="button" className="git-row" title={`${file.origPath ? `Renamed from ${file.origPath}\n` : ""}Show the diff`} onClick={() => onOpen(commit, file)}>
                          <span className="git-file mono">
                            <span className="git-name">{name}</span>
                            {dir ? <span className="git-dir">{dir}</span> : null}
                          </span>
                          <span className="git-meta mono">
                            <Counts additions={file.additions} deletions={file.deletions} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {commit.fileCount > commit.files.length ? <li className="lane-hint mono muted">and {commit.fileCount - commit.files.length} more</li> : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {view.moreCommits ? (
        <button type="button" className="small ghost git-more" onClick={onMore}>
          Show older commits
        </button>
      ) : null}
    </section>
  );
}

/**
 * The repository's worktrees, with who in the room works in each; any of them can be shown. Hidden while the
 * repository has only its main checkout (the head already says so).
 */
function WorktreeList({ view, folders, home, onSelect }: { view: GitView; folders: GitFolder[]; home: string; onSelect: (path: string) => void }) {
  const { participantById } = useRoom();
  if (view.worktrees.length < 2) return null;
  return (
    <section className="lane git-section" aria-label="Worktrees">
      <h3>
        <span className="lane-title">Worktrees</span>
        <span className="lane-count mono">{view.worktrees.length}</span>
      </h3>
      <ul className="git-list">
        {view.worktrees.map((worktree: GitWorktree) => {
          const people = (folders.find((f) => f.path === worktree.path)?.participantIds ?? []).map(participantById).filter(Boolean) as Participant[];
          const current = worktree.path === view.path;
          return (
            <li key={worktree.path}>
              <button
                type="button"
                className={`git-row git-worktree${current ? " current" : ""}`}
                aria-current={current ? "true" : undefined}
                title={`${worktree.path}${current ? "\nShown above" : "\nShow this worktree"}`}
                onClick={() => onSelect(worktree.path)}
              >
                <span className="git-worktree-text">
                  <span className="mono git-name">{worktree.branch ?? (worktree.head ? `detached ${worktree.head.slice(0, 7)}` : "—")}</span>
                  <span className="mono git-dir">{homePath(worktree.path, home)}</span>
                </span>
                {people.length > 0 ? (
                  <span className="git-people">
                    {people.map((p) => (
                      <Monogram key={p.id} participant={p} size="xs" />
                    ))}
                  </span>
                ) : null}
                {worktree.isMain ? <span className="tag">main</span> : null}
                {worktree.locked ? <span className="tag">locked</span> : null}
                {worktree.prunable ? <span className="tag">gone</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** A unified diff as lines with old and new line numbers. The file header lines are dropped (the dialog names the file). */
function diffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text, oldNo: null, newNo: null });
    } else if (!inHunk || text.startsWith("diff --git")) {
      inHunk = false;
      if (/^(diff --git|index |--- |\+\+\+ )/.test(text) || text === "") continue;
      lines.push({ kind: "meta", text, oldNo: null, newNo: null });
    } else if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), oldNo: null, newNo: newNo++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), oldNo: oldNo++, newNo: null });
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "meta", text, oldNo: null, newNo: null });
    } else if (text !== "" || lines.length > 0) {
      lines.push({ kind: "ctx", text: text.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  while (lines.length > 0 && lines[lines.length - 1]!.kind === "ctx" && lines[lines.length - 1]!.text === "") lines.pop();
  return lines;
}

function GitDiffDialog({ target, onClose }: { target: DiffTarget; onClose: () => void }) {
  const { snapshot } = useRoom();
  const [result, setResult] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .gitDiff(snapshot.room.id, target.folder, { path: target.path, origPath: target.origPath, commit: target.commit?.sha ?? null, untracked: target.untracked })
      .then((value) => !cancelled && setResult(value))
      .catch((caught) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      cancelled = true;
    };
  }, [snapshot.room.id, target]);
  const lines = useMemo(() => (result ? diffLines(result.diff) : []), [result]);
  return (
    <Dialog title={target.path} onClose={onClose} wide>
      <p className="git-diff-source mono muted">
        {target.commit ? (
          <>
            {target.commit.shortSha} · {target.commit.subject}
          </>
        ) : target.untracked ? (
          "new file, not yet added to git"
        ) : (
          "uncommitted change, against the last commit"
        )}
        {target.origPath ? ` · renamed from ${target.origPath}` : ""}
      </p>
      {error ? <p className="status-error">{error}</p> : null}
      {!result && !error ? <p className="mono muted">reading the diff…</p> : null}
      {result && lines.length === 0 ? <p className="mono muted">No line changes (a rename, a mode change, or an empty file).</p> : null}
      {lines.length > 0 ? (
        <div className="diff-view mono" role="table" aria-label={`Diff of ${target.path}`}>
          {lines.map((line, index) => (
            <div key={index} className={`diff-line diff-${line.kind}`} role="row">
              <span className="diff-no" aria-hidden="true">
                {line.oldNo ?? ""}
              </span>
              <span className="diff-no" aria-hidden="true">
                {line.newNo ?? ""}
              </span>
              <span className="diff-text">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {result?.truncated ? <p className="mono muted">The diff is cut here: it is larger than 400 KB.</p> : null}
    </Dialog>
  );
}
