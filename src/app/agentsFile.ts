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
 * link is followed. A folder that is not on this machine, a path that is not absolute, and a folder git cannot say is a
 * repository or not (git missing, a timeout, an ownership refusal: tried again with the next room) are left alone; no
 * folder is created in the project (git's own info and hooks folders, inside .git, are made when missing).
 *
 * Claude Code and Cursor read these files from every folder above the one they work in, so a folder that holds others
 * gets nothing: the home folder or one above it, a folder with another of T3's projects below it, and a folder outside
 * git with a repository below it (directly or one folder further down). Written there, the file would reach every
 * session in the folders below.
 *
 * In a git repository the files stay out of git, and nothing is committed (the user's #1119): Backroom lists them in
 * the repository's own exclude file (`.git/info/exclude`, which its worktrees share; never the tracked .gitignore),
 * between two marker lines. A new worktree holds only what is committed, so Backroom installs a small post-checkout
 * hook in the repository's hooks folder (its worktrees share it) that, on `git worktree add`, copies the files listed
 * there from the main checkout into the new worktree when they are missing there; it never writes over a file or a
 * link. It installs the hook only when the repository has no post-checkout hook, core.hooksPath is unset and the project
 * is the main checkout; otherwise it installs nothing, and README says how to add the copy line by hand (COPY_LINE, the
 * hook's own line). What could not be written (the exclude entries, the hook) is said once and not tried again.
 *
 * Backroom writes once per folder: a file the user removes afterwards is not written again (it would come back with
 * every new room). What it wrote is kept in the kv table, one record per project folder, so a project removed from T3
 * and added again keeps its record.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Repos } from "../db/repos.ts";
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

/** The marker lines around Backroom's entries in `.git/info/exclude`: the hook copies the paths between them. */
export const EXCLUDE_START = "# >>> Backroom agents file: kept out of git, copied into new worktrees by the post-checkout hook";
export const EXCLUDE_END = "# <<< Backroom agents file";

/**
 * The copy line, run by git as a post-checkout hook at the top of the checkout with the previous HEAD first: on `git
 * worktree add` (a previous HEAD of zeros), every path after Backroom's start marker in the exclude file, up to the first
 * line that is no path, is copied from the main checkout (the first in `git worktree list`) when it is missing here,
 * never over a file or a link. Its status is always 0, so it never fails a `git worktree add` (a folder the new
 * worktree lacks is skipped). README gives it to add by hand to a post-checkout hook of the repository's own.
 */
export const COPY_LINE =
  `case "$1" in *[!0]*) ;; *) m=$(git worktree list --porcelain | sed -n '1s/^worktree //p'); ` +
  `sed -n '/^# >>> Backroom agents file/,/^[^/]/s|^/||p' "$(git rev-parse --git-path info/exclude)" | tr -d '\\r' | ` +
  `while IFS= read -r f; do [ -e "./$f" ] || [ -L "./$f" ] || [ ! -f "$m/$f" ] || cp -- "$m/$f" "./$f" 2>/dev/null || :; done ;; esac`;

/** The marker that says a post-checkout hook is Backroom's own (installed already: nothing more to do). */
export const HOOK_MARKER = "Installed by Backroom (A1)";
export const HOOK_TEXT = `#!/bin/sh
# ${HOOK_MARKER}. On git worktree add, copies into the new worktree the agents files the main checkout keeps out of
# git: the paths in .git/info/exclude between Backroom's marker lines. Never over a file or a link that is there; other
# checkouts (a branch switch) do nothing. Backroom's README, "The agents file", says more.
${COPY_LINE}
exit 0
`;

/** Characters a project's place in its repository may hold for its paths to be written in the exclude file as they are. */
const PLAIN_PATH = /^[A-Za-z0-9._@+/ -]*$/;

/**
 * What happened to the worktree hook: installed now, Backroom's own (or its copy line) there already, or left out
 * because the repository has a post-checkout hook of its own, sets core.hooksPath, has the project somewhere other than
 * its main checkout (a linked worktree, a submodule: the hook copies from the main checkout, where nothing was
 * written), could not take the exclude entries the hook reads, or could not take the hook.
 */
export type HookState = "installed" | "ours" | "own-hook" | "hooks-path" | "not-main" | "no-exclude" | "failed";

/** What Backroom wrote in a project's folder. */
export interface AgentsFileRecord {
  /** The T3 project it was written for; a project added again for the same folder takes the record over. */
  projectId: string;
  /** The project's folder when Backroom wrote in it (symlinks resolved): the record's key. */
  folder: string;
  /** The files Backroom wrote, relative to the folder: AGENTS.md and CLAUDE.md, or CLAUDE.md alone. */
  written: string[];
  writtenAt: string;
  /** The folder was in a git repository. */
  repo: boolean;
  /** The entries added to the repository's exclude file (`/web/AGENTS.md`); none outside git, or when that failed. */
  excluded: string[];
  /** The worktree hook; null outside git. */
  hook: HookState | null;
}

/** What creating a room wrote, for the page to say so (room.created's agentsFile). */
export interface AgentsFileWritten {
  projectId: string;
  folder: string;
  written: string[];
  /** Kept out of git in `.git/info/exclude`: false outside git, or when the exclude file could not be written. */
  excluded: boolean;
  hook: HookState | null;
}

export interface AgentsFilesOptions {
  log?: (message: string, detail?: unknown) => void;
  /**
   * Write only in folders inside one of these (a throwaway service on the fake T3: its data folder and
   * ROOMS_FAKE_PROJECT_DIR), so a real folder added to it as a project is never written in. Absent: any folder.
   */
  onlyUnder?: string[];
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

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `path` strictly inside `folder` (a folder named `..old` in it is inside too). */
const isInside = (path: string, folder: string): boolean => {
  const rel = relative(folder, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The account's home folder; the system's record of it when HOME is empty or not absolute. */
export const home = (): string => {
  const fromEnv = homedir();
  return canonicalPath(isAbsolute(fromEnv) ? fromEnv : userInfo().homedir);
};

/**
 * Why a folder holds others and so gets no agents file, before git is asked: it is the home folder or one above it,
 * or another of T3's projects is below it. Null when neither.
 */
function holdsOthers(folder: string, others: string[]): string | null {
  const account = home();
  if (folder === account || isInside(account, folder)) return "it is the home folder or a folder above it";
  const below = others.find((other) => isInside(other, folder));
  return below ? `another project's folder is below it (${below})` : null;
}

/**
 * A repository below the folder, directly or one folder further down (`clients/acme`): a folder with a .git of its own.
 * Hidden folders and node_modules are not looked into.
 */
function repositoryBelow(folder: string, depth = 2): string | null {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || !isDirectory(join(folder, entry))) continue;
    if (exists(join(folder, entry, ".git"))) return entry;
    const deeper = depth > 1 ? repositoryBelow(join(folder, entry), depth - 1) : null;
    if (deeper) return `${entry}/${deeper}`;
  }
  return null;
}

/**
 * The exclude file with Backroom's entries for `patterns` in it: added inside its marked block (made at the end when
 * there is none, its end marker put back when it was removed), each once; every other line as it was, CRLF or not.
 */
export function withExcluded(text: string, patterns: string[]): string {
  const lines = text.length > 0 ? text.replace(/\n$/, "").split("\n") : [];
  const bare = lines.map((line) => line.replace(/\r$/, ""));
  const start = bare.indexOf(EXCLUDE_START);
  if (start >= 0) {
    // The block runs to its end marker, or (when that was removed) to the first line that is no path, where the end
    // marker goes back.
    let end = start + 1;
    while (end < bare.length && bare[end] !== EXCLUDE_END && bare[end]!.startsWith("/")) end += 1;
    if (bare[end] !== EXCLUDE_END) lines.splice(end, 0, EXCLUDE_END);
    const missing = patterns.filter((pattern) => !bare.slice(start + 1, end).includes(pattern));
    lines.splice(end, 0, ...missing);
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(EXCLUDE_START, ...patterns, EXCLUDE_END);
  }
  return `${lines.join("\n")}\n`;
}

export class AgentsFiles {
  private readonly repos: Repos;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly onlyUnder: string[] | null;
  private readonly beforeWrite: (folder: string, file: string) => void;
  /** One room at a time per folder: two rooms created at once write once. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(repos: Repos, options: AgentsFilesOptions = {}) {
    this.repos = repos;
    this.log = options.log ?? (() => {});
    this.onlyUnder = options.onlyUnder ? options.onlyUnder.map((root) => canonicalPath(root)) : null;
    this.beforeWrite = options.beforeWrite ?? (() => {});
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

  /** The record for a project: written for it, or for its folder under an earlier project. */
  record(projectId: string): AgentsFileRecord | null {
    return this.records().find((record) => record.projectId === projectId) ?? null;
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
   * has not written in its folder before; in a git repository keep the files out of git and see to the worktree hook.
   * `others` are T3's other projects (a folder holding one gets nothing). Answers what was written, or null.
   */
  async roomCreated(project: { id: string; workspaceRoot: string }, others: ReadonlyArray<{ workspaceRoot: string }> = []): Promise<AgentsFileWritten | null> {
    // T3 gives absolute folders; anything else would be resolved against Backroom's own folder, which is never meant.
    if (typeof project.workspaceRoot !== "string" || !isAbsolute(project.workspaceRoot)) return null;
    const folder = canonicalPath(project.workspaceRoot);
    if (this.known(folder, project.id)) return null;
    if (this.repos.getKv(AGENTS_FILE_SETTING_KEY) === "off") return null;
    if (this.onlyUnder && !this.onlyUnder.some((root) => folder === root || isInside(folder, root))) return null;
    const otherRoots = others.flatMap((other) => (typeof other.workspaceRoot === "string" && isAbsolute(other.workspaceRoot) ? [canonicalPath(other.workspaceRoot)] : []));
    const holds = holdsOthers(folder, otherRoots);
    if (holds) {
      this.log(`no agents file written in ${folder}: ${holds}, and Claude and Cursor read it from every folder below`);
      return null;
    }
    return this.serial(folder, async () => {
      if (this.known(folder, project.id)) return null;
      if (!isDirectory(folder)) return null;
      // The repository's top, the project's place in it, its exclude file and its hooks folder (both shared by its worktrees).
      let git: { top: string; prefix: string; exclude: string; hooks: string; common: string } | null = null;
      try {
        const [top = "", prefix = "", exclude = "", hooks = "", common = ""] = (
          await runGit(folder, ["rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "info/exclude", "--git-path", "hooks", "--git-common-dir"])
        ).split("\n");
        git = { top: top.trim(), prefix, exclude: resolve(folder, exclude), hooks: resolve(folder, hooks), common: resolve(folder, common.trim()) };
      } catch (error) {
        // Only git's own answer says the folder is no repository. Anything else (git missing, a timeout, an ownership
        // refusal) leaves it unknown, and so where the files would be kept out of git: nothing is written, and the next
        // room tries again.
        // (git's "not a git repository: <gitdir>" is a .git that points nowhere, a worktree whose repository moved: unknown.)
        if (!/not a git repository \(or any (of the parent directories|parent up to mount point)/i.test(errorText(error))) {
          this.log(`git could not say whether ${folder} is a repository; no agents file written`, errorText(error));
          return null;
        }
        const below = repositoryBelow(folder);
        if (below) {
          this.log(`no agents file written in ${folder}: the repository ${below} is directly below it, and Claude and Cursor read it from there`);
          return null;
        }
      }
      if (git && !PLAIN_PATH.test(git.prefix)) {
        this.log(`no agents file written in ${folder}: its place in the repository (${git.prefix}) cannot be written in the exclude file as it is`);
        return null;
      }
      const names = [AGENTS_FILE, CLAUDE_FILE, ...CLAUDE_ALTERNATIVES];
      const tracked = git ? new Set((await runGit(folder, ["ls-files", "-z", "--", ...names]).catch(() => "")).split("\0").filter(Boolean)) : new Set<string>();
      // A CLAUDE.md of the project's own: it has its own instructions, and nothing is written.
      if ([CLAUDE_FILE, ...CLAUDE_ALTERNATIVES].some((name) => present(folder, name) || tracked.has(name))) return null;
      // Instructions in a folder above, up to the repository's top: the project's own too (and an import here would miss them).
      if (git) {
        const root = canonicalPath(git.top);
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
      const excluded = git ? this.exclude(git.exclude, written.map((file) => `/${git.prefix}${file}`)) : [];
      // The hook reads the exclude block: without it there is nothing to copy.
      const hook = git ? (excluded.length > 0 ? await this.hook(folder, git) : "no-exclude") : null;
      const record: AgentsFileRecord = { projectId: project.id, folder, written, writtenAt: new Date().toISOString(), repo: git !== null, excluded, hook };
      this.save(record);
      this.log(`wrote ${written.join(" and ")} in ${folder}${git ? `; kept out of git: ${excluded.length > 0 ? "yes" : "no"}; worktree hook: ${hook}` : " (not a git repository)"}`);
      return { projectId: project.id, folder, written, excluded: excluded.length > 0, hook };
    });
  }

  /** Backroom's entries in the repository's exclude file; the ones it holds now, none when it could not be written. */
  private exclude(file: string, patterns: string[]): string[] {
    try {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // git's own info folder, inside .git: made when a repository came without one.
        mkdirSync(dirname(file), { recursive: true });
      }
      writeFileSync(file, withExcluded(text, patterns));
      return patterns;
    } catch (error) {
      this.log(`could not keep ${patterns.join(" and ")} out of git in ${file}`, errorText(error));
      return [];
    }
  }

  /** The worktree hook: installed only where the repository has no post-checkout hook and sets no core.hooksPath. */
  private async hook(folder: string, git: { top: string; hooks: string; common: string }): Promise<HookState> {
    // core.hooksPath set to anything (an empty value included, which points git's hooks at the checkout itself).
    const hooksPath = await runGit(folder, ["config", "--get", "core.hooksPath"]).then(
      () => true,
      () => false,
    );
    const common = canonicalPath(git.common);
    const hooks = canonicalPath(git.hooks);
    if (hooksPath || !isInside(hooks, common)) return "hooks-path";
    // The hook copies from the main checkout: a project elsewhere (a linked worktree, a submodule) has nothing there.
    const main = /^worktree (.*)$/m.exec(await runGit(folder, ["worktree", "list", "--porcelain"]).catch(() => ""))?.[1];
    if (!main || canonicalPath(main) !== canonicalPath(git.top)) return "not-main";
    const file = join(hooks, "post-checkout");
    if (exists(file)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // a link to nowhere, or unreadable: the repository's own all the same
      }
      return text.includes(HOOK_MARKER) || text.includes(COPY_LINE) ? "ours" : "own-hook";
    }
    try {
      mkdirSync(hooks, { recursive: true });
      writeFileSync(file, HOOK_TEXT, { flag: "wx", mode: 0o755 });
      return "installed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "own-hook";
      this.log(`could not install the worktree hook ${file}`, errorText(error));
      return "failed";
    }
  }
}
