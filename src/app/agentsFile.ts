/**
 * The agents file (A1): the habits every agent working in a project keeps whoever assigned the work (the approach to a
 * change: measured by the system it leaves, said before building, two or three shapes for a decision, fixed at the owner,
 * one authoritative definition; the assignment: how far to go without the user, a branch and worktree of its own, what a
 * writer, a reviewer and a plan deliver; validation: the project's checks, tests of behaviour; documentation: present
 * tense, a detail once, comments for the why, and every answer ending with decisions, changes, verification and a
 * Handoff), in the project's folder, where every harness reads it. Codex, Cursor and Antigravity read AGENTS.md; Claude Code reads
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
 * folder is created in the project's working tree (git's own info and hooks folders, inside .git, are made when
 * missing).
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
 * A project's own instruction file (INSTRUCTION_FILES, in its folder) that git ignores is in the same state: a new
 * worktree lacks it, so in every row of the table a plain file git ignores is listed in the same block, and the hook
 * goes in on the same conditions (the user's #8). With nothing written that is the log's to say, not the room's, and the
 * record's written is empty, so Settings → Agents file does not list the folder. Files git tracks are in every worktree
 * already. Files untracked and not ignored stay as they are: listing them would hide them from git status while the
 * project may be about to commit them. Nothing to add to the block and no hook to install leaves no record.
 *
 * Backroom writes once per folder: a file the user removes afterwards is not written again (it would come back with
 * every new room). What it wrote is kept in the kv table, one record per project folder, so a project removed from T3
 * and added again keeps its record.
 *
 * The text is a template, Backroom's (DEFAULT_AGENTS_TEMPLATE) or the user's (Settings → Agents file, agentsFile.text in
 * kv), with {checks} filled per project and {skills} with the packs' standing lines (src/app/packs.ts; a change of a
 * standing text, or a pack turning ready, changes the rendered template, so written projects then differ). A saved
 * template reaches only folders written afterwards: Backroom never changes a file by itself. Settings → Agents file
 * lists each folder where it wrote AGENTS.md with its state against the saved template rendered for it (same, differs,
 * removed, blocked), shows the diff, and on the user's Apply writes the rendered template over the file: bound to the
 * digests of the diff the user saw, only through a handle on a plain file of its own (no link followed, nothing
 * created), never CLAUDE.md, git, the exclude file, the hook or worktrees' copies. The on/off setting governs the
 * automatic writing only.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** The files Backroom wrote, relative to the folder: AGENTS.md and CLAUDE.md, CLAUDE.md alone, or none (it only listed the project's own ignored files). */
  written: string[];
  writtenAt: string;
  /** When the user last applied the saved template over the AGENTS.md Backroom wrote (agentsFile.apply). */
  appliedAt?: string;
  /** The folder was in a git repository. */
  repo: boolean;
  /** The entries it listed in the repository's exclude file (`/web/AGENTS.md`); none outside git, or when that failed. */
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

/**
 * A Backroom-written AGENTS.md against the saved template rendered for its project: the same, different, removed (gone
 * from the folder: Backroom does not write it again), or blocked (its folder is not on this machine, or it is no longer a
 * plain file of its own: a link, a folder, a file with another name linked to it, or unreadable). Apply is refused but
 * for same and differs.
 */
export type AgentsFileState = "same" | "differs" | "removed" | "blocked";

/** One project folder where Backroom wrote AGENTS.md, as GET /api/agents-files lists it. */
export interface AgentsFileEntry {
  projectId: string;
  folder: string;
  state: AgentsFileState;
  /** Why the state is blocked. */
  reason?: string;
  /** The project's title in T3 when T3 still has it; null when it does not (or did not answer). */
  title: string | null;
  writtenAt: string;
  appliedAt: string | null;
}

/**
 * The project's AGENTS.md against the saved template rendered for it (GET /api/agents-files/diff), with the digests of
 * both as read: agentsFile.apply takes them back, and refuses when either side changed since.
 */
export interface AgentsFileDiff {
  projectId: string;
  folder: string;
  state: "same" | "differs";
  /** git diff --no-index from the project's file to the rendered template; empty when they are the same. */
  diff: string;
  fileDigest: string;
  templateDigest: string;
}

/** A project by its id or its folder, as the diff route and agentsFile.apply name it. */
export type AgentsFileTarget = { projectId?: string | undefined; folder?: string | undefined };

/** Why there is no diff or nothing was applied: the page shows the message. */
const refused = (message: string): RoomError => new RoomError("agents_file_refused", message, 409);
/** Apply's refusal when the file or the rendered template is not what the diff showed. */
export const STALE = "the file changed since you looked at it: open the diff again";
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface AgentsFilesOptions {
  log?: (message: string, detail?: unknown) => void;
  /**
   * Write only in folders inside one of these (a throwaway service on the fake T3: its data folder and
   * ROOMS_FAKE_PROJECT_DIR), so a real folder added to it as a project is never written in. Absent: any folder.
   */
  onlyUnder?: string[];
  /** Tests only: runs between the look at the folder and each write (apply's too), where another writer could get in. */
  beforeWrite?: (folder: string, file: string) => void;
  /** The packs' standing lines for {skills} (src/app/packs.ts), read at each rendering; absent: none. */
  skills?: () => string[];
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

const isPlainFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
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
 * What the header's table says to write in this folder; none when the project has instructions of its own. `top` is its
 * repository's top, null outside git.
 */
function filesToWrite(folder: string, top: string | null, tracked: Set<string>): string[] {
  // A CLAUDE.md of the project's own: it has its own instructions, and nothing is written.
  if ([CLAUDE_FILE, ...CLAUDE_ALTERNATIVES].some((name) => present(folder, name) || tracked.has(name))) return [];
  // Instructions in a folder above, up to the repository's top: the project's own too (and an import here would miss them).
  if (top !== null) {
    const root = canonicalPath(top);
    for (let above = dirname(folder); above !== folder && !relative(root, above).startsWith(".."); above = dirname(above)) {
      if (INSTRUCTION_FILES.some((name) => present(above, name))) return [];
      if (above === root) break;
    }
  }
  const agents = agentsState(folder, tracked);
  if (agents === "other") return [];
  return agents === "missing" ? [AGENTS_FILE, CLAUDE_FILE] : [CLAUDE_FILE];
}

/**
 * The project's own instruction files a worktree cannot get from git: plain files in the folder that git ignores, which
 * a tracked file never is. One question per file: git refuses a whole list over one path beyond a link.
 */
async function ignoredInstructions(folder: string): Promise<string[]> {
  const plain = INSTRUCTION_FILES.filter((name) => found(folder, name) === name && isPlainFile(join(folder, name)));
  const ignored = await Promise.all(
    plain.map((name) =>
      runGit(folder, ["check-ignore", "--", name], { okCodes: [0, 1] }).then(
        (out) => out.trim() !== "",
        () => false,
      ),
    ),
  );
  return plain.filter((_, index) => ignored[index]);
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

/** The placeholder a template holds for the project's checks, filled when the file is written for a project. */
export const CHECKS_PLACEHOLDER = "{checks}";

/**
 * The placeholder for the skill packs' standing lines (src/app/packs.ts): on a line of its own, one line per ready pack
 * with a standing text, and the line goes when there is none.
 */
export const SKILLS_PLACEHOLDER = "{skills}";

/** The checks phrase {checks} stands for: the project's checks named when they could be read. */
export function checksPhrase(checks: string[]): string {
  return checks.length > 0 ? `${checks.map((check) => `\`${check}\``).join(", ")}, and whatever else its README asks for` : "the ones its README or package scripts name";
}

/**
 * The default template, the one source of the default AGENTS.md: the worker's habits in words that fit any project and
 * any harness, with {checks} where the project's checks go and {skills} where the skill packs' standing lines go.
 */
export const DEFAULT_AGENTS_TEMPLATE = [
  "# Working in this project",
  "",
  "The habits of every agent working here, whoever assigned the work. What the project is and how it is built is in its own documents; this file holds only how to work.",
  "",
  "## Approach",
  "",
  "- Measure a change by the system it leaves behind, not by the size of its diff: count the concepts, owners, paths, settings and special cases after it against those before. A patch that adds a special case loses to a wider change that removes one. Add no shim, compatibility path, setting or table unless the data is new; reuse what exists first.",
  "- Say what the change adds and removes before building, with the files. When it grows past that by adding, stop and report the excess as the user's decision; when it grows by removing, continue and report what it removed.",
  "- For a design or product decision, offer two or three shapes with the simplest result first, each with what it adds and removes and the one case it cannot handle, and recommend the one that leaves the simplest system. When the user has proposed a shape, build it unless you can name the case it fails. A routine change gets no alternatives: make it.",
  "- Read the code that owns a behaviour and its tests before you change it, trace the callers and update every consumer. Fix a problem at its owner; when the owner's shape is the problem, change the owner rather than patch around it. Keep the change to the task.",
  "- Each rule, format and state transition has one authoritative definition. Regenerate every derived view from it, and update the docs a change makes untrue, in the same change.",
  SKILLS_PLACEHOLDER,
  "",
  "## Working on an assignment",
  "",
  "- Keep going while a step needs no decision from the user: resolve routine choices yourself, and raise decisions that change scope, product behaviour or shared contracts. Stop and ask before anything hard to undo: rewriting published history, deleting runtime state, merging into the default branch when it is not the branch you were given, tagging or releasing. The user releases.",
  "- Commit on a branch of your own, in a worktree of your own when another agent works in the same checkout. Integrate into the branch you were given and remove the worktrees you no longer need; merge into the default branch only when it is the branch you were given or you were asked.",
  "- A writer delivers the change committed on the assigned branch, with its tests and the checks it ran, after reviewing its own diff and fixing what that found.",
  "- A reviewer reads the diff, runs the checks and answers pass or fail. A fail is a reproducible defect, an addition the task did not ask for, or a result more complex than one that meets the same words, named by file, line and reason, with how to show it fails or what it exceeds; an unproven concern is a note. One round by default; then whoever assigned the work rules. A reproducible behavioural finding gets a regression check that fails without the fix.",
  "- A plan is for work that needs coordination across several slices. It names each slice's files, behaviour, contracts and verification, gives concurrent edits disjoint ownership (slices that edit the same files are one slice) and ends with an integration check on the merged tree, so anyone can start a slice from the plan alone.",
  "",
  "## Validation",
  "",
  `- Run the project's checks before you report ready: ${CHECKS_PLACEHOLDER}. Say what you ran and what it printed, and name every check you skipped and every prerequisite you lacked.`,
  "- Test observable behaviour and failure handling, not implementation. A test that alters shared state restores it; a check on a shared resource asserts on what the test itself made.",
  "",
  "## Documentation",
  "",
  "- Describe the current system in concise present-tense prose. A detail lives once, with its owner, and everything else points to it. Change history belongs in commit messages, not in comments or docs.",
  "- Comments explain only non-obvious invariants, ordering, security, concurrency and data-integrity constraints. Write no separate status or report files unless asked.",
  "- End every answer with what needs a decision, what changed, what was verified and any limits, then a Handoff: the paths, the branch and the commit where your work is, and anything left unintegrated.",
  "",
  "Backroom wrote this file when the first room was made for this project. It is the project's to edit; Backroom changes it only when you apply the current default from Settings → Agents file.",
  "",
].join("\n");

/** Settings → Agents file: the user's template, when they saved one; absent, the default. */
export const AGENTS_TEXT_KEY = "agentsFile.text";
/** The longest template the editor saves (agentsFile.text.set). */
export const AGENTS_TEXT_MAX = 20000;

/**
 * A template written for a project: every {checks} filled with its checks phrase, every {skills} with the packs' standing
 * lines (`skills`; none: a line that holds only {skills} goes, and any other is emptied), LF line endings, one final newline.
 */
export function renderAgentsText(template: string, checks: string[], skills: string[] = []): string {
  const lines = template.replace(/\r\n?/g, "\n").split("\n");
  const kept = skills.length === 0 ? lines.filter((line) => line.trim() !== SKILLS_PLACEHOLDER) : lines;
  return `${kept.join("\n").split(CHECKS_PLACEHOLDER).join(checksPhrase(checks)).split(SKILLS_PLACEHOLDER).join(skills.join("\n")).trimEnd()}\n`;
}

/** The default AGENTS.md for a project with these checks (and the packs' standing lines): the default template rendered. */
export function defaultAgentsText(checks: string[], skills: string[] = []): string {
  return renderAgentsText(DEFAULT_AGENTS_TEMPLATE, checks, skills);
}

/** The template new rooms write: the user's (Settings → Agents file) when they saved one, else the default. */
export function agentsTemplate(repos: Pick<Repos, "getKv">): { text: string; custom: boolean; defaultText: string } {
  const saved = repos.getKv(AGENTS_TEXT_KEY)?.trim();
  return { text: saved ? saved : DEFAULT_AGENTS_TEMPLATE, custom: Boolean(saved), defaultText: DEFAULT_AGENTS_TEMPLATE };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Why a recorded folder is not itself any more: its real path (links resolved) is elsewhere, a link put in its place or
 * in a folder above it. Null when it is the recorded one.
 */
function movedAway(folder: string): string | null {
  let real: string;
  try {
    real = realpathSync(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? `${folder} is not on this machine` : `${folder} cannot be resolved: ${errorText(error)}`;
  }
  return real === folder ? null : `${folder} leads elsewhere now (${real}), not to the folder Backroom wrote in`;
}

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
  private readonly skills: () => string[];
  /** One room at a time per folder: two rooms created at once write once. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(repos: Repos, options: AgentsFilesOptions = {}) {
    this.repos = repos;
    this.log = options.log ?? (() => {});
    this.onlyUnder = options.onlyUnder ? options.onlyUnder.map((root) => canonicalPath(root)) : null;
    this.beforeWrite = options.beforeWrite ?? (() => {});
    this.skills = options.skills ?? (() => []);
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
   * has not written in its folder before; in a git repository keep the files, and the project's own ignored ones, out of
   * git and see to the worktree hook. `others` are T3's other projects (a folder holding one gets nothing). Answers what
   * was written, or null when nothing was.
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
      const carried = git ? await ignoredInstructions(folder) : [];
      const wanted = filesToWrite(folder, git?.top ?? null, tracked);
      const written: string[] = [];
      for (const name of wanted) {
        try {
          this.beforeWrite(folder, name);
          // "wx": never over a file (or a link) that appeared since the look above.
          writeFileSync(join(folder, name), name === AGENTS_FILE ? renderAgentsText(agentsTemplate(this.repos).text, projectChecks(folder), this.skills()) : CLAUDE_TEXT, { flag: "wx" });
          written.push(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") this.log(`could not write ${name} in ${folder}`, errorText(error));
          // CLAUDE.md imports AGENTS.md: without Backroom's AGENTS.md written, it writes nothing more.
          break;
        }
      }
      // Nothing to carry, or a file the table asked for that could not be written: the next room looks again.
      if (written.length === 0 && (wanted.length > 0 || carried.length === 0)) return null;
      const listed = git ? this.exclude(git.exclude, [...carried, ...written].map((file) => `/${git.prefix}${file}`)) : { held: [], added: false };
      const excluded = listed.held;
      // The hook reads the exclude block: without it there is nothing to copy.
      const hook = git ? (excluded.length > 0 ? await this.hook(folder, git) : "no-exclude") : null;
      // Carried already (listed by hand, or by another project's room): nothing was done here to remember.
      if (written.length === 0 && excluded.length > 0 && !listed.added && hook !== "installed") return null;
      const record: AgentsFileRecord = { projectId: project.id, folder, written, writtenAt: new Date().toISOString(), repo: git !== null, excluded, hook };
      this.save(record);
      const did = `${written.length > 0 ? `wrote ${written.join(" and ")}` : "wrote nothing"}${carried.length > 0 ? `, carried ${carried.join(" and ")}` : ""}`;
      this.log(`${did} in ${folder}${git ? `; kept out of git: ${excluded.length > 0 ? "yes" : "no"}; worktree hook: ${hook}` : " (not a git repository)"}`);
      return written.length > 0 ? { projectId: project.id, folder, written, excluded: excluded.length > 0, hook } : null;
    });
  }

  /** The records where Backroom wrote AGENTS.md (CLAUDE.md alone is never compared: it is the one import line). */
  private agentsRecords(): AgentsFileRecord[] {
    return this.records().filter((record) => Array.isArray(record.written) && record.written.includes(AGENTS_FILE));
  }

  /** The record for a project id or a folder, with AGENTS.md among what Backroom wrote; null when there is none. */
  private agentsRecord(target: AgentsFileTarget): AgentsFileRecord | null {
    if (target.folder !== undefined) {
      if (!isAbsolute(target.folder)) return null;
      const record = this.recordAt(canonicalPath(target.folder));
      return record && record.written.includes(AGENTS_FILE) ? record : null;
    }
    return this.agentsRecords().find((record) => record.projectId === target.projectId) ?? null;
  }

  /**
   * The project's AGENTS.md as it is today, and the saved template rendered for it. Read without following a link (the
   * name is looked at with lstat, then opened with O_NOFOLLOW and its handle checked), and a read that fails is
   * blocked, never removed.
   */
  private compare(record: AgentsFileRecord): { state: "same" | "differs"; text: string; rendered: string } | { state: "removed" } | { state: "blocked"; reason: string } {
    const folder = record.folder;
    // Not on this machine, or not the recorded folder any more (a link put in its place or above it).
    const moved = movedAway(folder);
    if (moved) return { state: "blocked", reason: moved };
    const path = join(folder, AGENTS_FILE);
    let kind: Stats;
    try {
      kind = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "removed" };
      return { state: "blocked", reason: `AGENTS.md cannot be looked at: ${errorText(error)}` };
    }
    const plain = (stats: Stats): string | null =>
      stats.isSymbolicLink() ? "AGENTS.md is a link now" : !stats.isFile() ? "AGENTS.md is no longer a plain file" : stats.nlink !== 1 ? "AGENTS.md shares its contents with another name (a hard link)" : null;
    const before = plain(kind);
    if (before) return { state: "blocked", reason: before };
    let text: string;
    let fd: number | null = null;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const now = plain(fstatSync(fd));
      if (now) return { state: "blocked", reason: now };
      text = readFileSync(fd, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { state: "blocked", reason: code === "ELOOP" ? "AGENTS.md is a link now" : `AGENTS.md cannot be read: ${errorText(error)}` };
    } finally {
      if (fd !== null) closeSync(fd);
    }
    const rendered = renderAgentsText(agentsTemplate(this.repos).text, projectChecks(folder), this.skills());
    return { state: text === rendered ? "same" : "differs", text, rendered };
  }

  /**
   * Every project folder where Backroom wrote AGENTS.md, with its file's state against the saved template rendered for
   * it; `projects` are T3's (for the titles), null when T3 did not answer.
   */
  list(projects: ReadonlyArray<{ id: string; title: string }> | null = null): AgentsFileEntry[] {
    return this.agentsRecords()
      .sort((a, b) => a.folder.localeCompare(b.folder))
      .map((record) => {
        const compared = this.compare(record);
        return {
          projectId: record.projectId,
          folder: record.folder,
          state: compared.state,
          ...(compared.state === "blocked" ? { reason: compared.reason } : {}),
          title: projects?.find((project) => project.id === record.projectId)?.title ?? null,
          writtenAt: record.writtenAt,
          appliedAt: record.appliedAt ?? null,
        };
      });
  }

  /** The project's AGENTS.md against the saved template rendered for it, as git's line diff, with the digests of both. */
  async diff(target: AgentsFileTarget): Promise<AgentsFileDiff> {
    const record = this.agentsRecord(target);
    if (!record) throw refused("Backroom wrote no AGENTS.md there");
    const compared = this.compare(record);
    if (compared.state === "removed") throw refused(`AGENTS.md is gone from ${record.folder}, and Backroom does not write it again`);
    if (compared.state === "blocked") throw refused(compared.reason);
    let diff = "";
    if (compared.state === "differs") {
      // Two copies in a folder of its own, so nothing of the project's (its git config, attributes or links) is in play.
      const scratch = mkdtempSync(join(tmpdir(), "backroom-agents-diff-"));
      try {
        mkdirSync(join(scratch, "project"));
        mkdirSync(join(scratch, "template"));
        writeFileSync(join(scratch, "project", AGENTS_FILE), compared.text);
        writeFileSync(join(scratch, "template", AGENTS_FILE), compared.rendered);
        diff = await runGit(scratch, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", `project/${AGENTS_FILE}`, `template/${AGENTS_FILE}`], { okCodes: [0, 1] });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    return { projectId: record.projectId, folder: record.folder, state: compared.state, diff, fileDigest: digest(compared.text), templateDigest: digest(compared.rendered) };
  }

  /**
   * The user's Apply: the saved template rendered for the project, written over the whole AGENTS.md Backroom wrote
   * there, bound to the diff the user looked at (its two digests). Only in a folder Backroom has a record for, on this
   * machine and under onlyUnder, and only through a handle on a plain file of its own (opened with O_NOFOLLOW and no
   * O_CREAT, checked with fstat): never through a link, never a file that is missing. CLAUDE.md, the exclude file, the
   * hook and git are never touched, and worktrees keep their copies. The setting governs automatic writing only.
   */
  apply(target: AgentsFileTarget & { fileDigest: string; templateDigest: string }): Promise<AgentsFileEntry> {
    const record = this.agentsRecord(target);
    if (!record) return Promise.reject(refused("Backroom wrote no AGENTS.md there, so it applies nothing"));
    return this.serial(record.folder, async () => {
      const folder = record.folder;
      // The recorded folder under onlyUnder; compare() below refuses it when its real path (links resolved) is elsewhere now.
      if (this.onlyUnder && !this.onlyUnder.some((root) => folder === root || isInside(folder, root))) throw refused(`${folder} is outside the folders this service writes in`);
      const compared = this.compare(record);
      if (compared.state === "removed") throw refused(`AGENTS.md is gone from ${folder}, and Backroom does not write it again`);
      if (compared.state === "blocked") throw refused(compared.reason);
      if (digest(compared.text) !== target.fileDigest || digest(compared.rendered) !== target.templateDigest) throw refused(STALE);
      const path = join(folder, AGENTS_FILE);
      this.beforeWrite(folder, AGENTS_FILE);
      // No O_CREAT: a file removed meanwhile is not made again. O_NOFOLLOW: a link put there meanwhile is not followed.
      let fd: number;
      try {
        fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw refused(code === "ENOENT" ? `AGENTS.md is gone from ${folder}, and Backroom does not write it again` : code === "ELOOP" ? "AGENTS.md is a link now" : `could not write AGENTS.md in ${folder}: ${errorText(error)}`);
      }
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile() || stats.nlink !== 1) throw refused("AGENTS.md is no longer a plain file of its own");
        // O_NOFOLLOW guards the file's own name only: the folder could have been swapped for a link before the open. So
        // the folder is still the recorded one, and the handle is the file its path names now.
        const movedSince = movedAway(folder);
        if (movedSince) throw refused(movedSince);
        let named: Stats | null = null;
        try {
          named = lstatSync(path);
        } catch {
          // gone meanwhile: not the handle's file
        }
        if (!named || named.dev !== stats.dev || named.ino !== stats.ino) throw refused("AGENTS.md was replaced while it was being applied");
        // The instant between these checks and the write stays open to a second swap; on a single-user machine only the
        // user could make it.
        // What the handle holds is what the user looked at, read through the handle itself.
        if (digest(readFileSync(fd, "utf8")) !== target.fileDigest) throw refused(STALE);
        ftruncateSync(fd, 0);
        const bytes = Buffer.from(compared.rendered, "utf8");
        for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done, done);
      } finally {
        closeSync(fd);
      }
      this.save({ ...(this.recordAt(folder) ?? record), appliedAt: new Date().toISOString() });
      this.log(`applied the saved agents template to ${path}`);
      return this.list().find((entry) => entry.folder === folder)!;
    });
  }

  /** Backroom's entries in the repository's exclude file: the ones it holds now (none when it could not be written), and whether that took a write. */
  private exclude(file: string, patterns: string[]): { held: string[]; added: boolean } {
    try {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // git's own info folder, inside .git: made when a repository came without one.
        mkdirSync(dirname(file), { recursive: true });
      }
      const next = withExcluded(text, patterns);
      if (next !== text) writeFileSync(file, next);
      return { held: patterns, added: next !== text };
    } catch (error) {
      this.log(`could not keep ${patterns.join(" and ")} out of git in ${file}`, errorText(error));
      return { held: [], added: false };
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
