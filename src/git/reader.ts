/**
 * The room's git view, read with the git CLI on this machine: for a working folder the room's threads use (a
 * participant's worktree, or the project's folder), its branch and upstream, the uncommitted changes, recent commits,
 * and the repository's other worktrees; and single-file diffs from those.
 *
 * T3 keeps no commit history of its own, so this reads the folders directly. That needs the room service to run on
 * the machine where T3 keeps its checkouts; a folder that is not here is reported as missing, not as an error.
 * Reads never take git's optional locks, so they cannot get in the way of an agent's own git commands.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_TIMEOUT_MS = 10_000;
/** A diff larger than this is cut, and says so. */
export const MAX_DIFF_BYTES = 400 * 1024;
/** Untracked files are line-counted up to this size; larger ones show no count. */
const MAX_COUNTED_BYTES = 512 * 1024;
const MAX_COMMIT_FILES = 300;

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflict";

export interface GitWorkingFile {
  path: string;
  /** The path before a rename or copy. */
  origPath: string | null;
  status: GitFileStatus;
  /** How much of the change is staged: all of it, part of it, or none. */
  staged: "all" | "part" | "none";
  /** Line counts against HEAD; null for binary files and very large untracked ones. */
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitFile {
  path: string;
  origPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  committedAt: string;
  isMerge: boolean;
  /** Whether the commit is on the upstream branch; null when the branch has no upstream. */
  pushed: boolean | null;
  additions: number;
  deletions: number;
  fileCount: number;
  /** The files, capped at 300 (fileCount is the full number). */
  files: GitCommitFile[];
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

/** One folder's state in brief: what the room header's count and the checkout switcher show. */
export interface GitCheckoutSummary {
  path: string;
  exists: boolean;
  isRepo: boolean;
  /** Repository root of the folder (the worktree's top level); null when not a repository. */
  root: string | null;
  branch: string | null;
  detached: boolean;
  /** The checked-out commit (full sha); null before the first commit. */
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  error: string | null;
}

export interface GitView extends GitCheckoutSummary {
  /** The folder's path inside the repository ("" at the top level, "web/" for a subfolder). */
  prefix: string;
  /** Name of the repository: the main worktree's folder name. */
  repoName: string | null;
  /** Whether this folder is a linked worktree rather than the repository's main checkout. */
  isLinkedWorktree: boolean;
  head: { sha: string; shortSha: string; subject: string; committedAt: string } | null;
  files: GitWorkingFile[];
  commits: GitCommit[];
  /** Whether older commits exist beyond the ones listed. */
  moreCommits: boolean;
  worktrees: GitWorktree[];
}


/** Run git in `cwd`. Exit codes in `okCodes` count as success (git diff --no-index exits 1 when files differ). */
function git(cwd: string, args: string[], options: { okCodes?: number[]; maxBytes?: number } = {}): Promise<string> {
  const okCodes = options.okCodes ?? [0];
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, "-c", "core.quotePath=false", "-c", "color.ui=never", ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: Math.max(options.maxBytes ?? 0, 16 * 1024 * 1024),
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
        if (!error || (code !== null && okCodes.includes(code))) resolvePromise(stdout);
        else reject(new Error((stderr || error.message).trim().split("\n")[0] || "git failed"));
      },
    );
  });
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A folder path as compared and reported: symlinks resolved, no trailing slash. */
export function canonicalPath(path: string): string {
  const real = realpathOrSelf(resolve(path));
  return real.length > 1 ? real.replace(/\/+$/, "") : real;
}

const isInside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

interface StatusRead {
  oid: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitWorkingFile[];
}

function kindOf(xy: string): GitFileStatus {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  if (xy.includes("T")) return "typechange";
  return "modified";
}

function stagedOf(xy: string): GitWorkingFile["staged"] {
  const [index, tree] = [xy[0] ?? ".", xy[1] ?? "."];
  if (index === ".") return "none";
  return tree === "." ? "all" : "part";
}

/** Parse `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatus(output: string): StatusRead {
  const read: StatusRead = { oid: null, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const [key, ...rest] = entry.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") read.oid = value === "(initial)" ? null : value;
      if (key === "branch.head") {
        read.detached = value === "(detached)";
        read.branch = read.detached ? null : value;
      }
      if (key === "branch.upstream") read.upstream = value;
      if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          read.ahead = Number(match[1]);
          read.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = entry[0];
    if (type === "?") {
      read.files.push({ path: entry.slice(2), origPath: null, status: "untracked", staged: "none", additions: null, deletions: null });
    } else if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = entry.split(" ");
      const xy = parts[1]!;
      read.files.push({ path: parts.slice(8).join(" "), origPath: null, status: kindOf(xy), staged: stagedOf(xy), additions: null, deletions: null });
    } else if (type === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next field
      const parts = entry.split(" ");
      const xy = parts[1]!;
      const origPath = fields[i + 1] ?? null;
      i += 1;
      read.files.push({ path: parts.slice(9).join(" "), origPath, status: kindOf(xy), staged: stagedOf(xy), additions: null, deletions: null });
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = entry.split(" ");
      read.files.push({ path: parts.slice(10).join(" "), origPath: null, status: "conflict", staged: "none", additions: null, deletions: null });
    }
  }
  return read;
}

/** Parse `git diff --numstat -z`: counts keyed by the new path ("-" counts mean binary, reported as null). */
export function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (!entry) continue;
    const [adds, dels, path] = entry.split("\t");
    let target = path ?? "";
    // A rename or copy: an empty path field, then the old and new paths as their own fields.
    if (target === "") {
      target = fields[i + 2] ?? "";
      i += 2;
    }
    counts.set(target, { additions: adds === "-" ? null : Number(adds), deletions: dels === "-" ? null : Number(dels) });
  }
  return counts;
}

/** Split a --numstat path that records a rename ("a => b" or "dir/{a => b}/f") into the old and new paths. */
export function splitRenamedPath(path: string): { path: string; origPath: string | null } {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  const tidy = (value: string) => value.replace(/\/{2,}/g, "/").replace(/^\//, "");
  if (braced) {
    const [, head, before, after, tail] = braced;
    return { path: tidy(`${head}${after}${tail}`), origPath: tidy(`${head}${before}${tail}`) };
  }
  const plain = path.split(" => ");
  if (plain.length === 2) return { path: plain[1]!, origPath: plain[0]! };
  return { path, origPath: null };
}

const RECORD = "\x1e";
const UNIT = "\x1f";

/** The --format of the log parseLog reads: one record per commit, its fields split by UNIT, the subject last. */
export const LOG_FORMAT = `${RECORD}%H${UNIT}%h${UNIT}%an${UNIT}%aI${UNIT}%cI${UNIT}%P${UNIT}%s`;

/** Parse `git log --format=LOG_FORMAT --numstat`. */
export function parseLog(output: string): Array<Omit<GitCommit, "pushed">> {
  const commits: Array<Omit<GitCommit, "pushed">> = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const [header, ...lines] = record.split("\n");
    const [sha, shortSha, author, authoredAt, committedAt, parents, ...subjectParts] = (header ?? "").split(UNIT);
    if (!sha) continue;
    const commit: Omit<GitCommit, "pushed"> = {
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: subjectParts.join(UNIT),
      author: author ?? "",
      authoredAt: authoredAt ?? "",
      committedAt: committedAt ?? "",
      isMerge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
      additions: 0,
      deletions: 0,
      fileCount: 0,
      files: [],
    };
    for (const line of lines) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      const additions = match[1] === "-" ? null : Number(match[1]);
      const deletions = match[2] === "-" ? null : Number(match[2]);
      commit.additions += additions ?? 0;
      commit.deletions += deletions ?? 0;
      commit.fileCount += 1;
      if (commit.files.length < MAX_COMMIT_FILES) commit.files.push({ ...splitRenamedPath(match[3]!), additions, deletions });
    }
    commits.push(commit);
  }
  return commits;
}

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktrees(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value, branch: null, head: null, detached: false, isMain: worktrees.length === 0, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    if (key === "detached") current.detached = true;
    if (key === "locked") current.locked = true;
    if (key === "prunable") current.prunable = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/** Lines in a small text file; null for binary or large files. */
function countLines(path: string): number | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return null;
    const content = readFileSync(path);
    if (content.includes(0)) return null;
    if (content.length === 0) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 10) lines += 1;
    return content[content.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return null;
  }
}

async function repoPaths(cwd: string): Promise<{ root: string; prefix: string; gitDir: string; commonDir: string } | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix", "--absolute-git-dir", "--git-common-dir"]);
    const [root, prefix, gitDir, commonDir] = out.split("\n");
    if (!root || !gitDir || !commonDir) return null;
    return { root, prefix: prefix ?? "", gitDir, commonDir: isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir) };
  } catch {
    return null;
  }
}

function missing(path: string, exists: boolean, error: string | null = null): GitCheckoutSummary {
  return { path, exists, isRepo: false, root: null, branch: null, detached: false, headSha: null, upstream: null, ahead: 0, behind: 0, changed: 0, error };
}

/** The brief state of one folder: branch, upstream, and how many files are uncommitted. */
export async function readCheckoutSummary(path: string): Promise<GitCheckoutSummary> {
  if (!isDirectory(path)) return missing(path, false);
  const paths = await repoPaths(path);
  if (!paths) return missing(path, true);
  try {
    const status = parseStatus(await git(paths.root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
    return {
      path,
      exists: true,
      isRepo: true,
      root: paths.root,
      branch: status.branch,
      detached: status.detached,
      headSha: status.oid,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      changed: status.files.length,
      error: null,
    };
  } catch (error) {
    return { ...missing(path, true, errorText(error)), isRepo: true, root: paths.root };
  }
}

/** Everything the Git tab shows for one folder. */
export async function readGitView(path: string, options: { commitLimit?: number } = {}): Promise<GitView> {
  const commitLimit = Math.min(Math.max(options.commitLimit ?? 30, 1), 500);
  const empty = (summary: GitCheckoutSummary): GitView => ({
    ...summary,
    prefix: "",
    repoName: null,
    isLinkedWorktree: false,
    head: null,
    files: [],
    commits: [],
    moreCommits: false,
    worktrees: [],
  });
  if (!isDirectory(path)) return empty(missing(path, false));
  const paths = await repoPaths(path);
  if (!paths) return empty(missing(path, true));
  const { root } = paths;
  try {
    const status = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
    const base = status.oid ?? EMPTY_TREE;
    const [numstat, log, worktreeList, unpushed] = await Promise.all([
      status.files.some((file) => file.status !== "untracked") ? git(root, ["diff", "--numstat", "-z", "-M", base, "--"]) : Promise.resolve(""),
      status.oid ? git(root, ["log", `-n${commitLimit + 1}`, `--format=${LOG_FORMAT}`, "--numstat", "-M", "HEAD", "--"]) : Promise.resolve(""),
      git(root, ["worktree", "list", "--porcelain", "-z"]).catch(() => ""),
      status.oid && status.upstream ? git(root, ["rev-list", "-n1000", "@{upstream}..HEAD"]).catch(() => null) : Promise.resolve(null),
    ]);
    const counts = parseNumstatZ(numstat);
    const files = status.files.map((file) => {
      if (file.status === "untracked") {
        const lines = countLines(resolve(root, file.path));
        return { ...file, additions: lines, deletions: lines === null ? null : 0 };
      }
      const count = counts.get(file.path);
      return count ? { ...file, ...count } : { ...file, additions: 0, deletions: 0 };
    });
    const unpushedSet = unpushed === null ? null : new Set(unpushed.split("\n").filter(Boolean));
    const parsed = parseLog(log);
    const commits = parsed.slice(0, commitLimit).map((commit) => ({ ...commit, pushed: unpushedSet === null ? null : !unpushedSet.has(commit.sha) }));
    const worktrees = parseWorktrees(worktreeList);
    const mainPath = worktrees.find((w) => w.isMain)?.path ?? dirname(paths.commonDir);
    const headCommit = commits[0] ?? null;
    return {
      path,
      exists: true,
      isRepo: true,
      root,
      branch: status.branch,
      detached: status.detached,
      headSha: status.oid,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      changed: files.length,
      error: null,
      prefix: paths.prefix,
      repoName: basename(mainPath),
      isLinkedWorktree: realpathOrSelf(paths.gitDir) !== realpathOrSelf(paths.commonDir),
      head: status.oid && headCommit ? { sha: status.oid, shortSha: headCommit.shortSha, subject: headCommit.subject, committedAt: headCommit.committedAt } : null,
      files,
      commits,
      moreCommits: parsed.length > commitLimit,
      worktrees,
    };
  } catch (error) {
    return empty({ ...missing(path, true, errorText(error)), isRepo: true, root });
  }
}

/** The worktree paths of the repository a folder belongs to (for deciding which folders the room may read). */
export async function worktreePathsOf(path: string): Promise<string[]> {
  if (!isDirectory(path)) return [];
  try {
    return parseWorktrees(await git(path, ["worktree", "list", "--porcelain", "-z"])).map((w) => w.path);
  } catch {
    return [];
  }
}

export interface DiffRequest {
  /** The file, relative to the repository root. */
  path: string;
  /** The file's previous path, for renames. */
  origPath?: string | null;
  /** A commit: the file's change in that commit. Absent: the uncommitted change against HEAD. */
  commit?: string | null;
  /** The file is untracked (new, never added). */
  untracked?: boolean;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
}

const SHA = /^[0-9a-f]{4,64}$/i;

/** A repository-relative path that stays inside the repository and out of its .git folder. */
export function safeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  return !path.split(/[\\/]/).some((segment) => segment === ".." || segment.toLowerCase() === ".git");
}

/** The diff of one file: its uncommitted change against HEAD, or its change in one commit. */
export async function readFileDiff(folder: string, request: DiffRequest): Promise<DiffResult> {
  if (!safeRelativePath(request.path) || (request.origPath && !safeRelativePath(request.origPath))) throw new Error("bad path");
  if (request.commit && !SHA.test(request.commit)) throw new Error("bad commit");
  const paths = await repoPaths(folder);
  if (!paths) throw new Error("not a git repository");
  const root = paths.root;
  const literal = (p: string) => `:(literal)${p}`;
  const pathspec = [literal(request.path), ...(request.origPath ? [literal(request.origPath)] : [])];
  let diff: string;
  if (request.commit) {
    diff = await git(root, ["show", "--format=", "--patch", "-M", "--diff-merges=first-parent", request.commit, "--", ...pathspec], { maxBytes: MAX_DIFF_BYTES * 4 });
  } else if (request.untracked) {
    const target = realpathOrSelf(resolve(root, request.path));
    if (!isInside(target, realpathOrSelf(root)) || !existsSync(target)) throw new Error("no such file");
    // Only files git lists as untracked: an ignored file (.env, build output) is not shown this way.
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", literal(request.path)]);
    if (!untracked.split("\0").includes(request.path)) throw new Error("not an untracked file");
    diff = await git(root, ["diff", "--no-index", "--", "/dev/null", request.path], { okCodes: [0, 1], maxBytes: MAX_DIFF_BYTES * 4 });
  } else {
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((out) => out.trim(), () => EMPTY_TREE);
    diff = await git(root, ["diff", "-M", head || EMPTY_TREE, "--", ...pathspec], { maxBytes: MAX_DIFF_BYTES * 4 });
  }
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return { diff, truncated: false };
  const cut = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return { diff: cut.slice(0, cut.lastIndexOf("\n") + 1), truncated: true };
}
