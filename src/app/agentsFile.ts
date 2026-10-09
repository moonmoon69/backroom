/**
 * The agents file (A1): the habits every agent working in a project keeps whoever assigned the work (review its own
 * diff before reporting ready, turn review findings into tests, run the project's checks, end with a Handoff), in the
 * project's folder, where every harness reads it. Codex, Cursor and Antigravity read AGENTS.md; Claude Code reads
 * CLAUDE.md (AGENTS.md only where no CLAUDE.md is), and follows a line `@AGENTS.md` in it as an import. So one AGENTS.md
 * and a one-line CLAUDE.md importing it reach all four; a copy of the text would drift, and Cursor, which reads both
 * files, would load it twice. README.md ("The agents file") has the table and its evidence.
 *
 * When a room is created in a project (room.create, and consigliere.start, which creates its room the same way), the
 * setting is on (Settings → Agents file; on by default), and Backroom has not written in that folder before:
 *
 *   AGENTS.md    CLAUDE.md    Backroom writes
 *   missing      missing      AGENTS.md, and CLAUDE.md importing it
 *   there        missing      CLAUDE.md importing it, so Claude reads the project's own AGENTS.md too
 *   missing      there        nothing: the project has its own instructions
 *   there        there        nothing
 *
 * CLAUDE.md is there in any capitals, as .claude/CLAUDE.md (Claude reads it as CLAUDE.md), as a link (even one to
 * nowhere), or tracked by git and deleted in the folder (a change in progress). AGENTS.md is there when a file of that
 * very name is, which the import reaches; anything else of the kind (agents.md in other capitals, which is the same
 * file on macOS and Windows; AGENTS.override.md, which Codex reads instead; a link to nowhere; a tracked file deleted
 * in the folder) and Backroom writes nothing. In a project folder below its repository's top, any of these files in a
 * folder between them (the top included) is the project's own instructions, which Codex and Claude read from there:
 * nothing is written. Files are created exclusively ("wx"): a file that appears meanwhile is kept as it is, and no
 * link is followed. A folder that is not on this machine, a path that is not absolute, and, when git cannot be run at
 * all, any folder, are left alone; no folder is ever created.
 *
 * Members work in git worktrees, and a new worktree holds only committed files, so in a git repository the user is
 * asked once per project whether to commit what Backroom wrote (committing is the suggested answer), and the answer is
 * remembered. The commit holds those files alone, on the branch checked out in the folder, with the user's configured
 * identity, hooks and signing; nothing is pushed. Backroom writes once per folder: a file the user removes afterwards
 * is not written again (it would come back with every new room). What it wrote and the answer are kept in the kv
 * table, one record per project folder, so a project removed from T3 and added again keeps its record.
 */
import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Repos } from "../db/repos.ts";
import { RoomError } from "../domain/errors.ts";
import { canonicalPath, runGit } from "../git/reader.ts";

export const AGENTS_FILE = "AGENTS.md";
/** Other names a harness reads in AGENTS.md's place (Codex reads AGENTS.override.md instead). */
const AGENTS_ALTERNATIVES = ["AGENTS.override.md"];
/** Claude Code's own file, written as the one line importing AGENTS.md (never a copy of it). */
export const CLAUDE_FILE = "CLAUDE.md";
export const CLAUDE_TEXT = "@AGENTS.md\n";
/** Where else Claude Code reads it: one of them there counts as CLAUDE.md being there. */
const CLAUDE_ALTERNATIVES = [".claude/CLAUDE.md"];
/** Every file that is a project's own instructions to an agent, for the folders above a project inside its repository. */
const INSTRUCTION_FILES = [AGENTS_FILE, ...AGENTS_ALTERNATIVES, CLAUDE_FILE, ...CLAUDE_ALTERNATIVES];

/** Settings → Agents file: "off" when the user turned it off; on (absent) by default. */
export const AGENTS_FILE_SETTING_KEY = "agentsFile.enabled";
const KEY_PREFIX = "agentsFile:";
/** A commit runs the user's hooks, which may take a while; reads keep the git reader's own limit. */
const COMMIT_TIMEOUT_MS = 120_000;
/** The open questions are read for every page's poll: one reading serves them all for this long. */
const QUESTIONS_CACHE_MS = 2_000;
/** AGENTS.md's text in the question is cut here; the file itself is whatever size it is. */
const MAX_TEXT = 8_000;

/** What Backroom wrote in a project's folder, and the user's answer to the commit question. */
export interface AgentsFileRecord {
  /** The T3 project it was written for; a project added again for the same folder takes the record over. */
  projectId: string;
  /** The project's folder when Backroom wrote in it (symlinks resolved): the record's key. */
  folder: string;
  /** The files Backroom wrote, relative to the folder: AGENTS.md and CLAUDE.md, or CLAUDE.md alone. */
  written: string[];
  writtenAt: string;
  /** The folder was in a git repository: only then is there anything to commit, and a question. */
  repo: boolean;
  answer: "commit" | "leave" | null;
  answeredAt: string | null;
  /** The commit Backroom made on the answer "commit"; null when there was nothing left to commit. */
  commit: string | null;
  /** Why the last attempt to commit failed; the question stays open. */
  error: string | null;
}

/** The commit question for one project, as the page shows it. */
export interface AgentsFileQuestion {
  projectId: string;
  folder: string;
  /** The files Backroom wrote that are still uncommitted there, as they are now. */
  files: string[];
  /** The branch checked out in the folder, where the commit would go; null when none is (a detached HEAD). */
  branch: string | null;
  /** Of those, the ones git ignores (.gitignore): Backroom never forces them in, so they stay out of the commit. */
  ignored: string[];
  /** Why no commit can be made now (a detached HEAD, a merge in progress, every file ignored); null when one can. */
  blocked: string | null;
  /** AGENTS.md as it is now (cut at 8,000 characters): Backroom's, or the project's own that CLAUDE.md imports. */
  text: string;
  /** Why the last attempt to commit failed. */
  error: string | null;
}

export interface AgentsFilesOptions {
  log?: (message: string, detail?: unknown) => void;
  /**
   * Write only in folders inside one of these (a throwaway service on the fake T3: its data folder and
   * ROOMS_FAKE_PROJECT_DIR), so a real folder added to it as a project is never written in. Absent: any folder.
   */
  onlyUnder?: string[];
  /** How long one reading of the open questions serves the pages' polls (QUESTIONS_CACHE_MS); tests read afresh. */
  questionsCacheMs?: number;
  /** Tests only: runs between the look at the folder and each write, where another writer could get in. */
  beforeWrite?: (folder: string, file: string) => void;
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * `name` as the folder lists it: under that very name, else in other capitals, as a file, a folder or a link (even one
 * to nowhere); null when it is not there. Read from the folder's listing, so a filesystem that ignores capitals does
 * not pass agents.md off as AGENTS.md.
 */
function found(folder: string, name: string): string | null {
  const slash = name.lastIndexOf("/");
  const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  let entries: string[];
  try {
    entries = readdirSync(join(folder, dir));
  } catch {
    return null;
  }
  const entry = entries.find((candidate) => candidate === base) ?? entries.find((candidate) => candidate.toLowerCase() === base.toLowerCase());
  return entry === undefined ? null : dir + entry;
}

const present = (folder: string, name: string): boolean => found(folder, name) !== null;

/**
 * AGENTS.md in the folder: "missing" (in no capitals, nor AGENTS.override.md, nor tracked by git), "there" (a file of
 * this very name, or a link to one, which an import reaches), or "other" (anything else of the kind).
 */
function agentsState(folder: string, tracked: Set<string>): "missing" | "there" | "other" {
  const name = found(folder, AGENTS_FILE);
  if (name === AGENTS_FILE && isFile(join(folder, AGENTS_FILE))) return "there";
  if (name !== null || tracked.has(AGENTS_FILE) || AGENTS_ALTERNATIVES.some((alternative) => present(folder, alternative))) return "other";
  return "missing";
}

/**
 * The project's own checks, from its package scripts: `check` when there is one (it usually runs the rest), else
 * `typecheck`, `lint` and `test`; with the package manager its lockfile names. And its Makefile's targets: `check`, else
 * `lint` and `test`.
 */
export function projectChecks(folder: string): string[] {
  const checks: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const runner = present(folder, "pnpm-lock.yaml") ? "pnpm" : present(folder, "yarn.lock") ? "yarn" : present(folder, "bun.lockb") || present(folder, "bun.lock") ? "bun" : "npm";
    const names = typeof scripts.check === "string" ? ["check"] : ["typecheck", "lint", "test"].filter((name) => typeof scripts[name] === "string");
    for (const name of names) checks.push(`${runner} run ${name}`);
  } catch {
    // no package.json, or one that does not parse
  }
  for (const file of ["GNUmakefile", "makefile", "Makefile"]) {
    let text: string;
    try {
      text = readFileSync(join(folder, file), "utf8");
    } catch {
      continue;
    }
    const has = (target: string) => new RegExp(`^${target}\\s*:(?!=)`, "m").test(text);
    for (const target of has("check") ? ["check"] : ["lint", "test"].filter(has)) checks.push(`make ${target}`);
    break;
  }
  return checks;
}

/**
 * The default AGENTS.md, the one source of its text: the worker's habits in words that fit any project and any
 * harness, the project's checks named when they could be read.
 */
export function defaultAgentsText(checks: string[]): string {
  const run =
    checks.length > 0
      ? `Run the project's checks before you report ready: ${checks.map((check) => `\`${check}\``).join(", ")}, and whatever else its README asks for.`
      : "Run the project's checks before you report ready: the ones its README or package scripts name.";
  return [
    "# Working in this project",
    "",
    "The habits of every agent working here, whoever assigned the work.",
    "",
    "- Before you report ready, review your own diff (with a subagent or a review workflow, if your harness has one) and fix what it finds.",
    "- Turn every review finding into a test that fails without the fix.",
    `- ${run} Say what you ran and what it printed, and name any check you skipped.`,
    "- End every answer with a Handoff: the paths, the branch and the commit where your work is, and anything left unintegrated.",
    "",
    "Backroom wrote this file when the first room was made for this project. It is the project's to edit; Backroom never changes it.",
    "",
  ].join("\n");
}

/** The commit's message, naming the files it holds. */
function commitMessage(files: string[]): string {
  const lines = files.map((file) =>
    file === AGENTS_FILE ? "AGENTS.md: the habits every agent working here keeps, whoever assigned the work." : `${file}: one line importing AGENTS.md, so Claude Code reads it too.`,
  );
  return `Add ${files.join(" and ")}, written by Backroom\n\n${lines.join("\n")}\nCommitted at the user's answer, so that new worktrees have ${files.length > 1 ? "them" : "it"}.\n`;
}

/** A git operation in progress, by the file git keeps while it lasts. */
const IN_PROGRESS: Array<[string, string]> = [
  ["MERGE_HEAD", "A merge"],
  ["rebase-merge", "A rebase"],
  ["rebase-apply", "A rebase"],
  ["CHERRY_PICK_HEAD", "A cherry-pick"],
  ["REVERT_HEAD", "A revert"],
  ["BISECT_LOG", "A bisect"],
];

/** What git says of the files Backroom wrote in a folder, and whether a commit can be made there now. */
interface FolderState {
  /** Untracked, added or changed: what a commit would hold, git's ignored ones aside. */
  uncommitted: string[];
  ignored: string[];
  branch: string | null;
  blocked: string | null;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class AgentsFiles {
  private readonly repos: Repos;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly onlyUnder: string[] | null;
  private readonly beforeWrite: (folder: string, file: string) => void;
  /** One thing at a time per folder: two rooms created at once, or a double click on Commit, do not race. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly questionsCacheMs: number;
  private cached: { at: number; questions: Promise<AgentsFileQuestion[]> } | null = null;

  constructor(repos: Repos, options: AgentsFilesOptions = {}) {
    this.repos = repos;
    this.log = options.log ?? (() => {});
    this.onlyUnder = options.onlyUnder ? options.onlyUnder.map((root) => canonicalPath(root)) : null;
    this.beforeWrite = options.beforeWrite ?? (() => {});
    this.questionsCacheMs = options.questionsCacheMs ?? QUESTIONS_CACHE_MS;
  }

  private records(): AgentsFileRecord[] {
    return [...this.repos.listKv(KEY_PREFIX).values()].flatMap((raw) => {
      try {
        return [JSON.parse(raw) as AgentsFileRecord];
      } catch {
        return [];
      }
    });
  }

  /** The record for a project, the one still waiting on an answer first: written for it, or for its folder under an earlier project. */
  record(projectId: string): AgentsFileRecord | null {
    const mine = this.records().filter((record) => record.projectId === projectId);
    return mine.find((record) => record.repo && record.answer === null) ?? mine[0] ?? null;
  }

  private recordAt(folder: string): AgentsFileRecord | null {
    const raw = this.repos.getKv(KEY_PREFIX + folder);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AgentsFileRecord;
    } catch {
      return null;
    }
  }

  private save(record: AgentsFileRecord): void {
    this.repos.setKv(KEY_PREFIX + record.folder, JSON.stringify(record));
    this.cached = null;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  /** A folder already written in: the record goes to this project (one added again for the same folder) and nothing more happens. */
  private known(folder: string, projectId: string): boolean {
    const earlier = this.recordAt(folder);
    if (!earlier) return false;
    if (earlier.projectId !== projectId) this.save({ ...earlier, projectId });
    return true;
  }

  /**
   * A room was created in this project: write the default when the table above says so, the setting is on and Backroom
   * has not written in its folder before. Answers the question to ask now, if this write raised one (a folder in a git
   * repository). A folder written in before answers at once, without waiting on a commit in progress there.
   */
  async roomCreated(project: { id: string; workspaceRoot: string }): Promise<AgentsFileQuestion | null> {
    // T3 gives absolute folders; anything else would be resolved against Backroom's own folder, which is never meant.
    if (typeof project.workspaceRoot !== "string" || !isAbsolute(project.workspaceRoot)) return null;
    const folder = canonicalPath(project.workspaceRoot);
    if (this.known(folder, project.id)) return null;
    if (this.repos.getKv(AGENTS_FILE_SETTING_KEY) === "off") return null;
    if (this.onlyUnder && !this.onlyUnder.some((root) => folder === root || !relative(root, folder).startsWith(".."))) return null;
    return this.serial(folder, async () => {
      if (this.known(folder, project.id)) return null;
      if (!isDirectory(folder)) return null;
      let top: string | null = null;
      try {
        top = (await runGit(folder, ["rev-parse", "--show-toplevel"])).trim();
      } catch (error) {
        // No git to run: whether the folder is a repository is unknown, and so is what a commit would need.
        if (/ENOENT/.test(errorText(error))) {
          this.log(`git could not be run; no agents file written in ${folder}`, errorText(error));
          return null;
        }
      }
      const repo = top !== null;
      const names = [AGENTS_FILE, CLAUDE_FILE, ...CLAUDE_ALTERNATIVES];
      const tracked = repo ? new Set((await runGit(folder, ["ls-files", "-z", "--", ...names]).catch(() => "")).split("\0").filter(Boolean)) : new Set<string>();
      // A CLAUDE.md of the project's own: it has its own instructions, and nothing is written.
      if ([CLAUDE_FILE, ...CLAUDE_ALTERNATIVES].some((name) => present(folder, name) || tracked.has(name))) return null;
      // Instructions in a folder above, up to the repository's top: the project's own too (and an import here would miss them).
      if (top) {
        const root = canonicalPath(top);
        for (let above = dirname(folder); above !== folder && !relative(root, above).startsWith(".."); above = dirname(above)) {
          if (INSTRUCTION_FILES.some((name) => present(above, name))) return null;
          if (above === root) break;
        }
      }
      const agents = agentsState(folder, tracked);
      if (agents === "other") return null;
      const written: string[] = [];
      for (const name of agents === "missing" ? [AGENTS_FILE, CLAUDE_FILE] : [CLAUDE_FILE]) {
        try {
          this.beforeWrite(folder, name);
          // "wx": never over a file (or a link) that appeared since the look above.
          writeFileSync(join(folder, name), name === AGENTS_FILE ? defaultAgentsText(projectChecks(folder)) : CLAUDE_TEXT, { flag: "wx" });
          written.push(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") this.log(`could not write ${name} in ${folder}`, errorText(error));
          // CLAUDE.md imports AGENTS.md: without Backroom's AGENTS.md written, it writes nothing more.
          break;
        }
      }
      if (written.length === 0) return null;
      const record: AgentsFileRecord = { projectId: project.id, folder, written, writtenAt: new Date().toISOString(), repo, answer: null, answeredAt: null, commit: null, error: null };
      this.save(record);
      this.log(`wrote ${written.join(" and ")} in ${folder}${repo ? "; the user is asked whether to commit them" : " (not a git repository: nothing to commit)"}`);
      return repo ? this.question(record).catch(() => null) : null;
    });
  }

  /** The state of the files Backroom wrote in the record's folder, read with five git calls; throws when git cannot read it. */
  private async inspect(record: AgentsFileRecord): Promise<FolderState> {
    const folder = record.folder;
    const [status, ignoredOut, paths, head, unmerged] = await Promise.all([
      runGit(folder, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...record.written]),
      // A file git ignores, by a pattern or because a folder it is in is ignored (status shows only that folder then).
      runGit(folder, ["check-ignore", "--", ...record.written], { okCodes: [0, 1] }),
      runGit(folder, ["rev-parse", "--show-prefix", ...IN_PROGRESS.flatMap(([name]) => ["--git-path", name])]),
      runGit(folder, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] }),
      runGit(folder, ["ls-files", "--unmerged"]),
    ]);
    const [prefix = "", ...gitPaths] = paths.split("\n");
    // Porcelain paths are the repository's; a project folder inside a repository has a prefix ("web/").
    const changed = new Set(
      status
        .split("\0")
        .filter((entry) => entry.length > 3 && !entry.slice(0, 2).includes("D"))
        .map((entry) => entry.slice(3))
        .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)),
    );
    const ignored = record.written.filter((file) => ignoredOut.split("\n").includes(file));
    const uncommitted = record.written.filter((file) => changed.has(file) && !ignored.includes(file));
    const branch = head.trim() || null;
    let blocked: string | null = null;
    if (uncommitted.length === 0 && ignored.length > 0) {
      blocked = `${ignored.join(" and ")} ${ignored.length > 1 ? "are" : "is"} ignored by git here (.gitignore), and Backroom does not force ${ignored.length > 1 ? "them" : "it"} in: there is nothing to commit.`;
    } else {
      // An operation in progress first: a rebase also leaves HEAD detached, and its name says more.
      const busy = IN_PROGRESS.find((_, index) => {
        const path = gitPaths[index]?.trim();
        return path ? exists(isAbsolute(path) ? path : join(folder, path)) : false;
      });
      if (busy) blocked = `${busy[1]} is in progress in ${folder}: finish or abort it first.`;
      else if (!branch) blocked = `${folder} has no branch checked out (a detached HEAD): check one out first.`;
      else if (unmerged.trim()) blocked = `${folder} has files with merge conflicts: resolve them first.`;
    }
    return { uncommitted, ignored, branch, blocked };
  }

  /** The question for a record still waiting on its answer; null when nothing it wrote is uncommitted any more. */
  private async question(record: AgentsFileRecord): Promise<AgentsFileQuestion | null> {
    if (!record.repo || record.answer !== null || !isDirectory(record.folder)) return null;
    const state = await this.inspect(record);
    const files = record.written.filter((file) => state.uncommitted.includes(file) || state.ignored.includes(file));
    if (files.length === 0) return null;
    let text = "";
    try {
      text = readFileSync(join(record.folder, AGENTS_FILE), "utf8");
    } catch {
      // removed since: the files list says what is left
    }
    return {
      projectId: record.projectId,
      folder: record.folder,
      files,
      branch: state.branch,
      ignored: state.ignored,
      blocked: state.blocked,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text,
      error: record.error,
    };
  }

  /**
   * Every commit question still open, one per project. A folder git cannot read now is left out of this reading. One
   * reading serves every page polling within two seconds.
   */
  async questions(): Promise<AgentsFileQuestion[]> {
    if (!this.cached || Date.now() - this.cached.at >= this.questionsCacheMs) {
      const open = this.records().filter((record) => record.repo && record.answer === null);
      this.cached = { at: Date.now(), questions: Promise.all(open.map((record) => this.question(record).catch(() => null))).then((all) => all.filter((question): question is AgentsFileQuestion => question !== null)) };
    }
    return this.cached.questions;
  }

  /**
   * The user's answer, remembered for the project. "commit" commits the files Backroom wrote as they are now, those
   * still uncommitted and only those (whatever else is staged stays staged), on the branch checked out in the folder,
   * with the user's configured git identity, hooks and signing; nothing is pushed. When no commit can be made (see
   * inspect), git cannot read the folder, or git refuses, nothing is committed, the index is as it was, the reason
   * stays with the question, and the question stays open.
   */
  answer(projectId: string, commit: boolean): Promise<AgentsFileRecord> {
    const found = this.record(projectId);
    if (!found || !found.repo) return Promise.reject(new RoomError("no_question", "Backroom wrote no agents file in this project's repository", 404));
    return this.serial(found.folder, async () => {
      const record = this.recordAt(found.folder) ?? found;
      if (record.answer !== null) return record;
      const answered = (next: Partial<AgentsFileRecord>): AgentsFileRecord => {
        const done = { ...record, ...next, answeredAt: new Date().toISOString(), error: null };
        this.save(done);
        return done;
      };
      if (!commit) return answered({ answer: "leave" });
      const failed = (message: string): never => {
        this.save({ ...record, error: message });
        throw new RoomError("commit_failed", message, 422);
      };
      // Removed with its folder: nothing left to commit.
      if (!isDirectory(record.folder)) return answered({ answer: "commit", commit: null });
      let state: FolderState;
      try {
        state = await this.inspect(record);
      } catch (error) {
        return failed(`git could not read ${record.folder}: ${errorText(error)}`);
      }
      if (state.blocked) failed(state.blocked);
      // Committed by hand, or removed, before the answer: nothing left to commit, and no empty commit.
      if (state.uncommitted.length === 0) return answered({ answer: "commit", commit: null });
      const files = state.uncommitted;
      const headOf = async () => (await runGit(record.folder, ["rev-parse", "-q", "--verify", "HEAD"], { okCodes: [0, 1] })).trim();
      const before = await headOf();
      const untracked = (await runGit(record.folder, ["ls-files", "-z", "--others", "--", ...files])).split("\0").filter(Boolean);
      try {
        // Only marked as to be added (intent-to-add): a version the user staged stays staged, and a refused commit leaves the index as it was.
        if (untracked.length > 0) await runGit(record.folder, ["add", "--intent-to-add", "--", ...untracked]);
        await runGit(record.folder, ["-c", "user.useConfigOnly=true", "commit", "--quiet", "-m", commitMessage(files), "--only", "--", ...files], { timeoutMs: COMMIT_TIMEOUT_MS });
      } catch (error) {
        // Cut off after the commit was made (a slow hook after it): it is made, when the new HEAD is that commit.
        const after = await headOf().catch(() => before);
        const subject = after && after !== before ? (await runGit(record.folder, ["log", "-1", "--format=%s", after]).catch(() => "")).trim() : "";
        if (subject === commitMessage(files).split("\n")[0]) {
          this.log(`committed ${files.join(" and ")} in ${record.folder} on ${state.branch} (${after.slice(0, 7)}), then git did not finish`, errorText(error));
          return answered({ answer: "commit", commit: after });
        }
        if (untracked.length > 0) await runGit(record.folder, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...untracked]).catch(() => undefined);
        const reason = errorText(error);
        failed(reason.includes("index.lock") ? `another git command is running in ${record.folder} (its index.lock is there): try again when it has finished` : `git could not commit on ${state.branch}: ${reason}`);
      }
      const sha = await headOf();
      this.log(`committed ${files.join(" and ")} in ${record.folder} on ${state.branch} (${sha.slice(0, 7)})`);
      return answered({ answer: "commit", commit: sha });
    });
  }
}
