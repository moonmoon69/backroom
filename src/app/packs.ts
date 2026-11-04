/**
 * Skill packs (board #141, #199, #218): git repositories of skills that Backroom keeps in its data folder, at
 * `<data folder's real path>/skills/<folder>`, one row each in the packs table. pstack is the first, in the clone Poteto
 * mode made (data/skills/cursor-plugins, sparse to its two trees); Add pack makes others from a URL. Nothing of a pack is
 * edited and no script of one is ever run: Backroom clones, fetches and checks out, reads its SKILL.md files, and places
 * links to the skills the user chooses.
 *
 * - Pinned. A pack is installed at a commit (the commit cloned, or for a folder already there its checkout, or the pin it
 *   had) and stays there. The daily check (an hourly look at when it last checked; a failure is tried again the next hour)
 *   only fetches: the page then says "update available" with the upstream commit, and the stat, files, description
 *   changes and full diff on demand. Take update checks out exactly the commit the user looked at.
 * - Local changes. Only tracked modifications stop a checkout; untracked files are left as they are, and a checkout that
 *   would overwrite one is refused, naming it.
 * - One git operation at a time (a serial queue, links and removals too). Readers take a pack's commit from git's HEAD,
 *   which a checkout moves last, so while one runs they read the pack as it was before it moved anything.
 * - Refused, with the reason and nothing changed: a link in the path from the data folder to a pack, a .git that is not a
 *   folder of its own, a folder whose git top level is elsewhere (the data folder lives inside Backroom's own checkout).
 *   A clone goes into a temporary sibling folder and is renamed into place only once it holds a tracked SKILL.md.
 * - Candidates. A pack's skills are its tracked SKILL.md files present in its checkout, each named by its frontmatter.
 *   Discovery enables nothing: a skill reaches a harness only by a link the user placed.
 * - Links (SKILL_FOLDERS in src/domain/skills.ts): per skill and folder, a symlink named after the skill's folder,
 *   pointing at the skill's folder by its real path. Every harness that reads a folder sees what is linked there, so a
 *   link is never per harness. Refused, with nothing changed: an entry of that name that is not Backroom's link to that
 *   skill, and the name Claude's sync owns. Unlinking removes only Backroom's link to that skill.
 * - Standing text. A pack may have one line every seat is given, in the agents file ({skills}) and the briefing's Skills
 *   section, with {folder} for its folder; pstack's two presets are POTETO_WORDS.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Repos } from "../db/repos.ts";
import { RoomError } from "../domain/errors.ts";
import { FOLDER_PLACEHOLDER, POTETO_WORDS, PSTACK_PACK, PSTACK_TREES, SKILL_FOLDERS, SYNCED_NAME, DRIVER_NAMES } from "../domain/skills.ts";
import type { Pack, PackError } from "../domain/types.ts";
import { runGit } from "../git/reader.ts";

/** The packs' place under the data folder. */
export const SKILLS_FOLDER = "skills";
export const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the timer looks whether a pack is due a check (or missing, or its last attempt failed). */
export const TICK_MS = 60 * 60 * 1000;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
/** The most of a diff the page is given. */
export const DIFF_MAX_CHARS = 2_000_000;
/** The refs an upstream commit is read from, the first that exists. */
const UPSTREAM_REFS = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"];
/** Git as Backroom runs it on a pack: no hook of anyone's and no ext:: transport, so nothing but git runs. */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];

/** A folder harnesses discover skills in, as the page shows it. */
export interface LinkFolder {
  id: string;
  path: string;
  /** "~/.claude/skills" when it is under the home folder Backroom was given. */
  label: string;
  /** The harnesses that read it, by name. */
  readBy: string[];
  /** T3's drivers that read it. */
  drivers: string[];
}

/** One of a pack's skills: a tracked SKILL.md in its checkout. */
export interface PackSkill {
  /** Its folder's path in the pack ("." for the pack's root). */
  path: string;
  /** The frontmatter's name, else the folder's name. */
  name: string;
  /** What a link to it is called: its folder's name. */
  linkName: string;
  /** The author's, from the frontmatter; null when it has none. */
  description: string | null;
  /** Its folder's real path: what a link points at, and what a harness's report of it resolves to. */
  realPath: string;
  /** The folders it may be linked into (pstack's two trees each keep to theirs). */
  folders: string[];
  /** The folders Backroom's link to it is in now. */
  linked: string[];
}

/** An upstream commit that differs from the pin. */
export interface PackUpdate {
  commit: string;
  subject: string;
}

export interface PackState {
  name: string;
  url: string;
  /** The folder's absolute path. */
  folder: string;
  pinned: string | null;
  /** The pinned commit's subject. */
  pinnedSubject: string | null;
  /** The commit checked out, when it is not the pin (moved by hand). */
  checkedOut: string | null;
  standing: string | null;
  /** The standing texts it offers as presets (pstack's two). */
  presets: Array<{ label: string; text: string }>;
  checkedAt: string | null;
  error: PackError | null;
  ready: boolean;
  /** A git operation of Backroom's on it is running or queued. */
  busy: boolean;
  update: PackUpdate | null;
  skills: PackSkill[];
}

/** What an update brings, read when the page opens it. */
export interface PackUpdateDetail {
  from: string;
  commit: string;
  stat: string;
  files: Array<{ status: string; path: string }>;
  /** Each SKILL.md whose frontmatter description changes, before and after (null where the file is not there). */
  descriptions: Array<{ path: string; before: string | null; after: string | null }>;
  diff: string;
  truncated: boolean;
}

/** A pack's standing line as seats are given it. */
export interface PackStanding {
  name: string;
  folder: string;
  /** The commit checked out, short. */
  commit: string | null;
  /** The standing text with its folder filled in. */
  line: string;
}

export interface PackClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PackClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface PacksOptions {
  /** The configured data folder: packs go under its real path. */
  dataDir: string;
  /** The home folder the skill folders are under (ROOMS_SKILLS_HOME; the user's by default). */
  home?: string;
  /** Where pstack comes from instead of its row's URL (ROOMS_PSTACK_REPO: the tests' and the rehearsal's fixture). */
  pstackSource?: string | null;
  clock?: PackClock;
  log?: (message: string, detail?: unknown) => void;
}

interface Snapshot {
  ready: boolean;
  commit: string | null;
}

const NOT_READY: Snapshot = { ready: false, commit: null };
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const refused = (message: string): RoomError => new RoomError("pack_refused", message, 409);
const isFullSha = (text: string): boolean => /^[0-9a-f]{40}$/.test(text);
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const realpathOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The first bytes of a file, enough for a SKILL.md's frontmatter. */
function head(path: string, bytes = 16384): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A SKILL.md's frontmatter name and description: plain, quoted, folded or indented-continued values, on one line. */
export function frontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: null, description: null };
  const lines = (match[1] ?? "").split(/\r?\n/);
  const value = (key: string): string | null => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return null;
    let first = (lines[index] ?? "").slice(key.length + 1).trim();
    const more: string[] = [];
    for (let i = index + 1; i < lines.length && /^(\s|$)/.test(lines[i] ?? ""); i += 1) more.push((lines[i] ?? "").trim());
    if (/^[>|][-+]?$/.test(first)) first = "";
    let text = [first, ...more].filter(Boolean).join(" ");
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text) ?? /^'((?:[^']|'')*)'$/.exec(text);
    if (quoted) text = text.startsWith('"') ? (quoted[1] ?? "").replace(/\\(.)/g, "$1") : (quoted[1] ?? "").replace(/''/g, "'");
    return text.replace(/\s+/g, " ").trim() || null;
  };
  return { name: value("name"), description: value("description") };
}

/** A pack's name from its URL: the repository's name, lower case, letters, digits and . _ -. */
export function packName(url: string): string {
  const last = url.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
}

/** A URL a pack may come from: https, http, ssh, git or file URLs, scp-like ssh, or an absolute local path. */
export function packUrlOk(url: string): boolean {
  return /^(https?|ssh|git|file):\/\/[^\s]+$/i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url) || /^\/[^\s]*$/.test(url);
}

export class Packs {
  private readonly repos: Pick<Repos, "listPacks" | "getPack" | "savePack" | "deletePack">;
  private readonly dataDir: string;
  private readonly home: string;
  private readonly clock: PackClock;
  private readonly log: (message: string, detail?: unknown) => void;
  /** Why the last look with git refused a pack's folder; absent when it did not. */
  private readonly refusals = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  /** The packs an operation is queued or running for, and how many. */
  private readonly working = new Map<string, number>();
  /** The background installs and checks queued, by pack, so the timer and the page never queue one twice. */
  private readonly pending = new Map<string, Promise<void>>();
  private timer: unknown = null;

  constructor(repos: Pick<Repos, "listPacks" | "getPack" | "savePack" | "deletePack">, options: PacksOptions) {
    this.repos = repos;
    this.dataDir = options.dataDir;
    this.home = options.home ?? homedir();
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
    const pstack = repos.getPack(PSTACK_PACK);
    if (options.pstackSource && pstack && pstack.url !== options.pstackSource) repos.savePack({ ...pstack, url: options.pstackSource });
  }

  // ---------------- where things are ----------------

  private dataReal(): string {
    try {
      return realpathSync(this.dataDir);
    } catch {
      return resolve(this.dataDir);
    }
  }

  /** A pack's folder, under the data folder's real path (resolved as given while the data folder is missing). */
  folderOf(pack: Pick<Pack, "folder">): string {
    return join(this.dataReal(), SKILLS_FOLDER, pack.folder);
  }

  folders(): LinkFolder[] {
    return SKILL_FOLDERS.map((spec) => ({
      id: spec.id,
      path: join(this.home, spec.relative),
      label: this.home === homedir() ? `~/${spec.relative}` : join(this.home, spec.relative),
      readBy: spec.drivers.map((driver) => DRIVER_NAMES[driver] ?? driver),
      drivers: spec.drivers,
    }));
  }

  list(): Pack[] {
    return this.repos.listPacks();
  }

  // ---------------- reading ----------------

  /** git in a folder, waited for (a few milliseconds: the briefing and the page read with it); null on failure. */
  private gitNow(folder: string, args: string[], maxBuffer?: number): string | null {
    try {
      const text = execFileSync("git", ["-C", folder, "-c", "core.quotePath=false", ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: maxBuffer ?? 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      });
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Why a pack's folder may not be touched, from what can be seen without git: a link between the data folder and it, a
   * component that is no folder, a .git that is no folder of its own, a folder that is no clone. Null when none (a folder
   * that is not there is not refused).
   */
  private refusedOnSight(pack: Pick<Pack, "folder">): string | null {
    let data: string;
    try {
      data = realpathSync(this.dataDir);
    } catch (error) {
      return `the data folder ${this.dataDir} cannot be resolved: ${errorText(error)}`;
    }
    const folder = join(data, SKILLS_FOLDER, pack.folder);
    for (const path of [join(data, SKILLS_FOLDER), folder]) {
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) return `${path} is a link: Backroom keeps packs only in folders of its own`;
        if (!stats.isDirectory()) return `${path} is not a folder`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return `${path} cannot be looked at: ${errorText(error)}`;
      }
    }
    try {
      const dotGit = lstatSync(join(folder, ".git"));
      if (dotGit.isSymbolicLink()) return `${folder}/.git is a link: its repository is elsewhere`;
      if (!dotGit.isDirectory()) return `${folder}/.git is a file: its repository is elsewhere`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${folder} is there but is no git clone; Backroom leaves it as it is`;
      return `${folder}/.git cannot be looked at: ${errorText(error)}`;
    }
    return null;
  }

  /** refusedOnSight, and git's top level in the folder the folder itself; kept for readers until the next look. */
  private async refusedWithGit(pack: Pack): Promise<string | null> {
    const seen = this.refusedOnSight(pack);
    let reason = seen;
    if (!reason) {
      const folder = this.folderOf(pack);
      let there = true;
      try {
        lstatSync(folder);
      } catch {
        there = false;
      }
      if (there) {
        try {
          const top = (await runGit(folder, ["rev-parse", "--show-toplevel"])).trim();
          if (realpathSync(top) !== folder) reason = `git's top level in ${folder} is ${top}, not the folder itself`;
        } catch (error) {
          reason = `git cannot read ${folder}: ${errorText(error)}`;
        }
      }
    }
    if (reason) this.refusals.set(pack.name, reason);
    else this.refusals.delete(pack.name);
    return reason;
  }

  /** A pack's checkout now: ready when nothing refuses its folder and git names its commit. */
  private read(pack: Pack): Snapshot {
    if (this.refusals.has(pack.name) || this.refusedOnSight(pack)) return NOT_READY;
    const folder = this.folderOf(pack);
    try {
      if (!lstatSync(folder).isDirectory()) return NOT_READY;
    } catch {
      return NOT_READY;
    }
    const commit = this.gitNow(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return commit ? { ready: true, commit } : NOT_READY;
  }


  /** The folders a pack's skill may be linked into: pstack's two trees keep to theirs. */
  private allowedFolders(pack: Pack, path: string): string[] {
    if (pack.name === PSTACK_PACK) {
      const tree = PSTACK_TREES.find((t) => `${path}/`.startsWith(t.prefix));
      if (tree) return tree.folders;
    }
    return SKILL_FOLDERS.map((spec) => spec.id);
  }

  /** A pack's skills in its checkout as it is now: tracked SKILL.md files present in it (a sparse clone's others are not). */
  private skillsNow(pack: Pack): Array<Omit<PackSkill, "linked">> {
    const folder = this.folderOf(pack);
    const tracked = (this.gitNow(folder, ["ls-files", "-z"], 64 * 1024 * 1024) ?? "").split("\0");
    const skills = tracked
      .filter((file) => file === "SKILL.md" || file.endsWith("/SKILL.md"))
      .filter((file) => isFile(join(folder, file)))
      .map((file) => {
        const path = file === "SKILL.md" ? "." : file.slice(0, -"/SKILL.md".length);
        const at = join(folder, path);
        let meta: { name: string | null; description: string | null } = { name: null, description: null };
        try {
          meta = frontmatter(head(join(at, "SKILL.md")));
        } catch {
          // unreadable: named by its folder
        }
        const linkName = path === "." ? pack.name : basename(path);
        let realPath = at;
        try {
          realPath = realpathSync(at);
        } catch {
          // read just above
        }
        return { path, name: meta.name ?? linkName, linkName, description: meta.description, realPath, folders: this.allowedFolders(pack, path) };
      })
      // A skill folder that leads out of the pack (a link of the pack's own) is not offered: a link would reach elsewhere.
      .filter((skill) => inside(skill.realPath, realpathOr(folder)))
      .sort((a, b) => a.path.localeCompare(b.path));
    return skills;
  }

  /** Whether `entry` is Backroom's link to `target`: a symlink whose text is that very path. */
  private linksTo(entry: string, target: string): boolean {
    try {
      return lstatSync(entry).isSymbolicLink() && readlinkSync(entry) === target;
    } catch {
      return false;
    }
  }

  /** A pack's skills with the folders each is linked in; none while it is not ready. */
  skills(pack: Pack): PackSkill[] {
    if (!this.read(pack).ready) return [];
    const folders = this.folders();
    return this.skillsNow(pack).map((skill) => ({
      ...skill,
      linked: folders.filter((folder) => this.linksTo(join(folder.path, skill.linkName), skill.realPath)).map((folder) => folder.id),
    }));
  }

  private upstream(folder: string): string | null {
    for (const ref of UPSTREAM_REFS) {
      const commit = this.gitNow(folder, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (commit) return commit;
    }
    return null;
  }

  /** The paths a sparse clone holds (its diffs keep to them); none for a full one. */
  private sparsePaths(folder: string): string[] {
    if (this.gitNow(folder, ["config", "--get", "core.sparseCheckout"]) !== "true") return [];
    return (this.gitNow(folder, ["sparse-checkout", "list"]) ?? "").split("\n").filter(Boolean);
  }

  state(pack: Pack): PackState {
    const snap = this.read(pack);
    const folder = this.folderOf(pack);
    const upstream = snap.ready && pack.pinned ? this.upstream(folder) : null;
    const update = upstream && pack.pinned && upstream !== pack.pinned ? { commit: upstream, subject: this.gitNow(folder, ["log", "-1", "--format=%s", upstream]) ?? "" } : null;
    return {
      name: pack.name,
      url: pack.url,
      folder,
      pinned: pack.pinned,
      pinnedSubject: snap.ready && pack.pinned ? this.gitNow(folder, ["log", "-1", "--format=%s", pack.pinned]) : null,
      checkedOut: snap.ready && snap.commit && pack.pinned && snap.commit !== pack.pinned ? snap.commit : null,
      standing: pack.standing,
      presets: pack.name === PSTACK_PACK ? [POTETO_WORDS.principles, POTETO_WORDS.full].map(({ label, text }) => ({ label, text })) : [],
      checkedAt: pack.checkedAt,
      error: pack.error ?? (this.refusals.get(pack.name) ? { reason: this.refusals.get(pack.name)!, at: pack.checkedAt ?? "", during: "check" } : null),
      ready: snap.ready,
      busy: (this.working.get(pack.name) ?? 0) > 0,
      update,
      skills: this.skills(pack),
    };
  }

  states(): PackState[] {
    return this.list().map((pack) => this.state(pack));
  }

  /** Each ready pack with a standing text, its line filled in: the agents file's {skills} and the briefing's Skills section. */
  standing(): PackStanding[] {
    return this.list().flatMap((pack) => {
      if (pack.standing === null) return [];
      const snap = this.read(pack);
      if (!snap.ready) return [];
      const folder = this.folderOf(pack);
      return [{ name: pack.name, folder, commit: snap.commit ? snap.commit.slice(0, 7) : null, line: pack.standing.split(FOLDER_PLACEHOLDER).join(folder) }];
    });
  }

  /** The agents file's {skills} lines: one per pack with a standing text. */
  agentsLines(): string[] {
    return this.standing().map((s) => `- ${s.line}`);
  }

  /** What an update brings: its stat, files, description changes and diff (a sparse clone's within its paths). */
  async updateDetail(name: string, commit: string): Promise<PackUpdateDetail> {
    const pack = this.repos.getPack(name);
    if (!pack) throw new RoomError("not_found", `no pack named ${name}`, 404);
    if (!pack.pinned || !this.read(pack).ready) throw refused(`${name} is not installed`);
    const folder = this.folderOf(pack);
    const target = this.gitNow(folder, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    if (!target || target !== commit) throw refused(`${commit} is not a commit ${name} has fetched`);
    const paths = this.sparsePaths(folder);
    const range = [pack.pinned, commit, "--", ...paths];
    const stat = (await runGit(folder, ["diff", "--stat", ...range], { timeoutMs: FETCH_TIMEOUT_MS })).trimEnd();
    const files = (await runGit(folder, ["diff", "--name-status", "-z", ...range], { timeoutMs: FETCH_TIMEOUT_MS }))
      .split("\0")
      .filter(Boolean)
      .reduce<Array<{ status: string; path: string }>>((out, part, index, parts) => {
        // -z name-status: a status, then one path (two for a rename or copy).
        if (/^[ACDMRTUX][0-9]*$/.test(part) && index + 1 < parts.length) {
          const two = /^[RC]/.test(part);
          out.push({ status: part[0] ?? part, path: two ? `${parts[index + 1]} → ${parts[index + 2]}` : (parts[index + 1] ?? "") });
        }
        return out;
      }, []);
    const show = async (rev: string, path: string): Promise<string | null> => {
      try {
        return frontmatter(await runGit(folder, ["show", `${rev}:${path}`], { timeoutMs: FETCH_TIMEOUT_MS })).description;
      } catch {
        return null;
      }
    };
    const descriptions: PackUpdateDetail["descriptions"] = [];
    for (const file of files) {
      const paths2 = file.path.split(" → ");
      const before = paths2[0] ?? file.path;
      const after = paths2[1] ?? file.path;
      if (!after.endsWith("SKILL.md") && !before.endsWith("SKILL.md")) continue;
      const was = file.status === "A" ? null : await show(pack.pinned, before);
      const now = file.status === "D" ? null : await show(commit, after);
      if (was !== now) descriptions.push({ path: after, before: was, after: now });
    }
    const full = await runGit(folder, ["diff", ...range], { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 64 * 1024 * 1024 });
    return { from: pack.pinned, commit, stat, files, descriptions, diff: full.slice(0, DIFF_MAX_CHARS), truncated: full.length > DIFF_MAX_CHARS };
  }

  // ---------------- the timer ----------------

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    this.clock.clearInterval(this.timer);
    this.timer = null;
  }

  /** Each pack: installed when it is missing or has no pin yet, checked when a day has passed or the last attempt failed. */
  tick(): Promise<void> {
    return Promise.all(
      this.list().map((pack) => {
        if (!pack.pinned || !isFullSha(pack.pinned) || !this.read(pack).ready) return this.background(pack.name, () => this.install(pack.name));
        const due = pack.error !== null || pack.checkedAt === null || this.clock.now() - Date.parse(pack.checkedAt) >= DAY_MS;
        return due ? this.background(pack.name, () => this.check(pack.name)) : Promise.resolve();
      }),
    ).then(() => undefined);
  }

  /** A background install or check, never queued twice for one pack, never rejecting. */
  private background(name: string, fn: () => Promise<void>): Promise<void> {
    const queued = this.pending.get(name);
    if (queued) return queued;
    const run = this.serial([name], fn)
      .catch((error: unknown) => this.log(`skills: ${name}: ${errorText(error)}`))
      .finally(() => {
        if (this.pending.get(name) === run) this.pending.delete(name);
      });
    this.pending.set(name, run);
    return run;
  }

  /** When what is queued now has run; starts nothing. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** One git operation at a time; `names` are the packs it is for, busy until it ends. */
  private serial<T>(names: string[], fn: () => Promise<T>): Promise<T> {
    for (const name of names) this.working.set(name, (this.working.get(name) ?? 0) + 1);
    const next = this.queue.then(fn, fn).finally(() => {
      for (const name of names) {
        const left = (this.working.get(name) ?? 1) - 1;
        if (left > 0) this.working.set(name, left);
        else this.working.delete(name);
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private record(name: string, during: PackError["during"], reason: string | null): void {
    const pack = this.repos.getPack(name);
    if (!pack) return;
    const at = this.now();
    this.repos.savePack({ ...pack, checkedAt: at, error: reason ? { reason, at, during } : null });
    if (reason) this.log(`skills: the ${during} of ${name} failed: ${reason}`);
  }

  /** A commit a pin names (a commit or a tag), in the clone or fetched from its origin. */
  private async resolvePin(folder: string, pin: string): Promise<string> {
    const local = await runGit(folder, ["rev-parse", "--verify", "--quiet", `${pin}^{commit}`]).catch(() => "");
    if (local.trim()) return local.trim();
    await runGit(folder, [...SAFE, "fetch", "--quiet", "origin", pin], { timeoutMs: FETCH_TIMEOUT_MS }).catch((error: unknown) => {
      throw new Error(`the pin ${pin} is not in its origin: ${errorText(error)}`);
    });
    return (await runGit(folder, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
  }

  /** Tracked files with local modifications, git's short status lines; untracked files are not counted. */
  private async trackedChanges(folder: string): Promise<string[]> {
    return (await runGit(folder, ["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean);
  }

  /** Untracked files (ignored ones too) that checking out `commit` would put a file of its own over. */
  private async untrackedInTheWay(folder: string, commit: string): Promise<string[]> {
    const untracked = (await runGit(folder, ["ls-files", "--others", "-z"])).split("\0").filter(Boolean);
    if (untracked.length === 0) return [];
    const incoming = new Set((await runGit(folder, ["ls-tree", "-r", "--name-only", "-z", commit], { maxBytes: 64 * 1024 * 1024 })).split("\0").filter(Boolean));
    const dirs = new Set([...incoming].flatMap((file) => file.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
    return untracked.filter((file) => incoming.has(file) || dirs.has(file) || file.split("/").slice(0, -1).some((_, i, parts) => incoming.has(parts.slice(0, i + 1).join("/"))));
  }

  /** A move of the checkout to `commit`, refused (nothing changed) for tracked changes or an untracked file in its way. */
  private async checkout(pack: Pack, folder: string, commit: string): Promise<void> {
    const changed = await this.trackedChanges(folder);
    if (changed.length > 0) throw refused(`local changes to tracked files in ${folder} (${changed.slice(0, 5).map((line) => line.slice(3)).join(", ")}): Backroom moves nothing while they are there`);
    const inTheWay = await this.untrackedInTheWay(folder, commit);
    if (inTheWay.length > 0) throw refused(`untracked ${inTheWay.slice(0, 5).join(", ")}${inTheWay.length > 5 ? ` and ${inTheWay.length - 5} more` : ""} in ${folder} would be overwritten by ${commit.slice(0, 7)}: move ${inTheWay.length === 1 ? "it" : "them"} away first`);
    try {
      await runGit(folder, [...SAFE, "checkout", "--quiet", "--detach", commit], { timeoutMs: CLONE_TIMEOUT_MS });
    } catch (error) {
      throw refused(`git refused to check out ${commit.slice(0, 7)} in ${pack.name}: ${errorText(error)}`);
    }
  }

  /** Whether a commit holds a SKILL.md (within a sparse clone's paths). */
  private async holdsSkill(folder: string, commit: string, paths: string[]): Promise<boolean> {
    const files = (await runGit(folder, ["ls-tree", "-r", "--name-only", "-z", commit, "--", ...paths], { maxBytes: 64 * 1024 * 1024 })).split("\0");
    return files.some((file) => file === "SKILL.md" || file.endsWith("/SKILL.md"));
  }

  /**
   * A pack installed: a folder that is there and a clone is taken as it is (its pin, else its checkout), one that is not
   * is cloned whole into a temporary sibling, checked out at the pin (else what it cloned) and renamed into place.
   */
  private async install(name: string): Promise<void> {
    const pack = this.repos.getPack(name);
    if (!pack) return;
    const refusal = await this.refusedWithGit(pack);
    if (refusal) return this.record(name, "install", refusal);
    const folder = this.folderOf(pack);
    let there = true;
    try {
      lstatSync(folder);
    } catch {
      there = false;
    }
    try {
      let pinned: string;
      if (there) {
        pinned = pack.pinned ? await this.resolvePin(folder, pack.pinned) : (await runGit(folder, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
        const head = (await runGit(folder, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
        if (head !== pinned) await this.checkout(pack, folder, pinned);
      } else {
        pinned = await this.cloneInto(folder, pack.url, pack.pinned);
      }
      this.repos.savePack({ ...this.repos.getPack(name)!, pinned });
      this.record(name, "install", null);
      this.log(`skills: ${name} installed at ${pinned.slice(0, 7)} in ${folder}`);
    } catch (error) {
      this.record(name, "install", errorText(error));
    }
  }

  /** A whole clone of `url` made beside `folder` and renamed into place once it holds a tracked SKILL.md; its pinned commit. */
  private async cloneInto(folder: string, url: string, pin: string | null): Promise<string> {
    const parent = dirname(folder);
    mkdirSync(parent, { recursive: true });
    const partial = mkdtempSync(join(parent, `.${basename(folder)}-`));
    try {
      await runGit(parent, [...SAFE, "clone", "--quiet", "--no-checkout", "--", url, partial], { timeoutMs: CLONE_TIMEOUT_MS });
      const commit = pin ? await this.resolvePin(partial, pin) : (await runGit(partial, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      await runGit(partial, [...SAFE, "checkout", "--quiet", "--detach", commit], { timeoutMs: CLONE_TIMEOUT_MS });
      if (!(await this.holdsSkill(partial, commit, []))) throw new Error(`${url} holds no SKILL.md at ${commit.slice(0, 7)}: no skill to keep`);
      renameSync(partial, folder);
      return commit;
    } catch (error) {
      // Only this clone's temporary folder is removed.
      rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  }

  /** The daily check: a fetch, nothing moved. */
  private async check(name: string): Promise<void> {
    const pack = this.repos.getPack(name);
    if (!pack) return;
    const refusal = await this.refusedWithGit(pack);
    if (refusal) return this.record(name, "check", refusal);
    try {
      await runGit(this.folderOf(pack), [...SAFE, "fetch", "--quiet", "--prune", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
      this.record(name, "check", null);
    } catch (error) {
      this.record(name, "check", `could not fetch from ${pack.url}: ${errorText(error)}`);
    }
  }

  // ---------------- the user's operations ----------------

  private known(name: string): Pack {
    const pack = this.repos.getPack(name);
    if (!pack) throw new RoomError("not_found", `no pack named ${name}`, 404);
    return pack;
  }

  /** Add pack: cloned whole from the URL, pinned at the commit cloned, nothing linked. */
  async add(url: string): Promise<PackState> {
    const source = url.trim();
    if (!packUrlOk(source)) throw refused(`${source} is not a repository URL Backroom clones (https, ssh, git or file, or an absolute path)`);
    const name = packName(source);
    if (!name) throw refused(`no pack name can be made from ${source}`);
    if (this.repos.getPack(name)) throw refused(`a pack named ${name} is kept already`);
    if (this.list().some((pack) => pack.folder === name)) throw refused(`a pack keeps the folder ${name} already`);
    return this.serial([name], async () => {
      if (this.repos.getPack(name)) throw refused(`a pack named ${name} is kept already`);
      const pack: Pack = { name, url: source, folder: name, pinned: null, standing: null, checkedAt: null, error: null, createdAt: this.now() };
      const sight = this.refusedOnSight(pack);
      if (sight) throw refused(sight);
      const folder = this.folderOf(pack);
      try {
        lstatSync(folder);
        throw refused(`${folder} is there already: Backroom leaves it as it is`);
      } catch (error) {
        if (error instanceof RoomError) throw error;
      }
      let pinned: string;
      try {
        pinned = await this.cloneInto(folder, source, null);
      } catch (error) {
        throw refused(`the clone of ${source} failed: ${errorText(error)}`);
      }
      const at = this.now();
      this.repos.savePack({ ...pack, pinned, checkedAt: at, createdAt: at });
      this.log(`skills: ${name} added from ${source} at ${pinned.slice(0, 7)}`);
      return pack;
    }).then((pack) => this.state(this.known(pack.name)));
  }

  /** Check now: the daily check at once. */
  async checkNow(name: string): Promise<PackState> {
    this.known(name);
    await this.serial([name], () => this.check(name));
    return this.state(this.known(name));
  }

  /**
   * Take update: exactly the commit the user looked at checked out and pinned, refused with nothing changed for tracked
   * changes, an untracked file in its way, or no skill in it. Backroom's links to skills it no longer has go.
   */
  async takeUpdate(name: string, commit: string): Promise<{ state: PackState; unlinked: string[] }> {
    this.known(name);
    const unlinked = await this.serial([name], async () => {
      const pack = this.known(name);
      const refusal = await this.refusedWithGit(pack);
      if (refusal) throw refused(refusal);
      if (!pack.pinned || !this.read(pack).ready) throw refused(`${name} is not installed`);
      const folder = this.folderOf(pack);
      const target = (await runGit(folder, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).catch(() => "")).trim();
      if (target !== commit) throw refused(`${commit} is not a commit ${name} has fetched`);
      if (!(await this.holdsSkill(folder, commit, this.sparsePaths(folder)))) throw refused(`${commit.slice(0, 7)} holds no SKILL.md: Backroom keeps ${name} where it is`);
      await this.checkout(pack, folder, commit);
      this.repos.savePack({ ...this.known(name), pinned: commit, error: null });
      this.log(`skills: ${name} moved to ${commit.slice(0, 7)}`);
      return this.unlinkWhere((target) => inside(target, folder) && !this.exists(target));
    });
    return { state: this.state(this.known(name)), unlinked };
  }

  private exists(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Backroom's links whose target matches, removed from every folder; what was removed, as folder/name. */
  private unlinkWhere(match: (target: string) => boolean): string[] {
    const removed: string[] = [];
    for (const folder of this.folders()) {
      let names: string[] = [];
      try {
        names = readdirSync(folder.path);
      } catch {
        continue;
      }
      for (const entry of names) {
        const path = join(folder.path, entry);
        try {
          if (!lstatSync(path).isSymbolicLink()) continue;
          if (!match(readlinkSync(path))) continue;
          unlinkSync(path);
          removed.push(`${folder.label}/${entry}`);
        } catch {
          // gone meanwhile
        }
      }
    }
    return removed;
  }

  /** Remove: refused for a folder not its own; else its links out first, then its folder, then its row. */
  async remove(name: string): Promise<{ unlinked: string[] }> {
    this.known(name);
    return this.serial([name], async () => {
      const pack = this.known(name);
      const refusal = await this.refusedWithGit(pack);
      if (refusal) throw refused(`${name} is not removed: ${refusal}`);
      const folder = this.folderOf(pack);
      const unlinked = this.unlinkWhere((target) => inside(target, folder));
      rmSync(folder, { recursive: true, force: true });
      this.repos.deletePack(name);
      this.refusals.delete(name);
      this.log(`skills: ${name} removed (${unlinked.length} link(s) taken out first)`);
      return { unlinked };
    });
  }

  setStanding(name: string, text: string | null): PackState {
    const pack = this.known(name);
    this.repos.savePack({ ...pack, standing: text });
    return this.state(this.known(name));
  }

  /** The skill at `path` of a pack, as it is now. */
  private skillOf(pack: Pack, path: string): PackSkill {
    const skill = this.skills(pack).find((s) => s.path === path);
    if (!skill) throw refused(`${pack.name} has no skill at ${path}`);
    return skill;
  }

  private folderById(id: string): LinkFolder {
    const folder = this.folders().find((f) => f.id === id);
    if (!folder) throw refused(`no skill folder ${id}`);
    return folder;
  }

  /** A link to a pack's skill placed in a folder, the folder made when missing; refused with nothing changed where taken. */
  link(name: string, path: string, folderId: string): Promise<PackState> {
    this.known(name);
    return this.serial([name], async () => {
      const pack = this.known(name);
      const skill = this.skillOf(pack, path);
      const folder = this.folderById(folderId);
      if (!skill.folders.includes(folder.id)) throw refused(`${pack.name}'s ${path} goes only to ${skill.folders.map((id) => this.folderById(id).label).join(" and ")}`);
      if (skill.linkName === SYNCED_NAME) throw refused(`"${SYNCED_NAME}" is Claude's synced skills: Backroom places no link of that name`);
      const entry = join(folder.path, skill.linkName);
      if (this.linksTo(entry, skill.realPath)) return;
      let taken: string | null = null;
      try {
        const stats = lstatSync(entry);
        taken = stats.isSymbolicLink() ? `a link to ${readlinkSync(entry)}` : stats.isDirectory() ? "a folder" : "a file";
      } catch {
        // free
      }
      if (taken) throw refused(`${folder.label}/${skill.linkName} is ${taken}, not Backroom's link to ${pack.name}'s ${path}: nothing changed`);
      mkdirSync(folder.path, { recursive: true });
      symlinkSync(skill.realPath, entry, "dir");
      this.log(`skills: ${folder.label}/${skill.linkName} → ${skill.realPath}`);
    }).then(() => this.state(this.known(name)));
  }

  /** Backroom's link to a pack's skill taken out of a folder; refused for anything else of that name. */
  unlink(name: string, path: string, folderId: string): Promise<PackState> {
    this.known(name);
    return this.serial([name], async () => {
      const pack = this.known(name);
      const skill = this.skillOf(pack, path);
      const folder = this.folderById(folderId);
      const entry = join(folder.path, skill.linkName);
      if (!this.linksTo(entry, skill.realPath)) throw refused(`${folder.label}/${skill.linkName} is not Backroom's link to ${pack.name}'s ${path}: nothing changed`);
      unlinkSync(entry);
    }).then(() => this.state(this.known(name)));
  }
}
