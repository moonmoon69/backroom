/**
 * Poteto mode (board #141, #158, #180): pstack, Lauren Tan's skills for rigorous agent work (MIT, in cursor/plugins),
 * kept by Backroom in its own data folder and reached by every seat, with poteto-mode, its entry point, used as it is.
 * Nothing of pstack is edited: Backroom only clones it, keeps it up to date with git, and points at it, by one line in
 * the agents file ({poteto}, src/app/agentsFile.ts) and by the briefing's Skills section (src/briefing/assemble.ts).
 *
 * The clone is `<data folder's real path>/skills/cursor-plugins`, sparse to pstack/ (Cursor's tree) and harness/pstack/
 * (the generated copy with the Claude Code adapter), on main only, blobs fetched as the sparse checkout needs them. The
 * folder layout is kept as cloned: poteto-mode indexes the other skills by relative path.
 *
 * - Settings → Poteto mode (poteto.enabled in kv, "off" when off; on by default). Off: nothing is cloned or fetched, by
 *   the timer, the settings route or Update now; the clone stays.
 * - Prepared in the background (at service start, when the settings are read, and each hour while it is missing),
 *   never holding up a room or a seat; one git operation at a time (a serial queue). A clone goes into a temporary
 *   sibling folder and is renamed into place only once it validates (plugin.json readable, poteto-mode's SKILL.md in both
 *   trees). Ready means the final folder validates, read from the checkout each time it is used (a folder deleted or
 *   broken is not ready, and the next clone makes it again), with pstack's version from its files and the commit from
 *   git; while a clone or an update runs, the checkout as it was before it moved anything, never one half way through.
 * - Updated once a day (an hourly check of when it last checked; a failure is tried again the next hour) and on Update
 *   now: a fetch of origin's main, then a fast-forward. poteto.pin (a commit or a tag) pins it: the update fetches and
 *   keeps the pin checked out, and says "pinned at X, latest is Y". Local changes in the clone stop any move. A queued
 *   clone or update reads the setting and the pin when it starts: off by then, it does nothing.
 * - Refused, with the reason recorded and nothing deleted, moved or repaired: a link in the path from the data folder
 *   to the clone, a .git that is not a folder of its own, a folder whose git top level is elsewhere (the data folder
 *   lives inside Backroom's own checkout), a folder that is there but is no pstack clone.
 * - ROOMS_PSTACK_REPO (config.pstackRepo) is the source: GitHub's cursor/plugins unless a test or the rehearsal gives a
 *   local bare repository.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Repos } from "../db/repos.ts";
import { runGit } from "../git/reader.ts";

/** Settings → Poteto mode: "off" when the user turned it off; on (absent) by default. */
export const POTETO_SETTING_KEY = "poteto.enabled";
/** The commit or tag the clone is pinned at; absent: it follows origin's main. */
export const POTETO_PIN_KEY = "poteto.pin";
/** What the last clone or update found (PackRecord). */
export const POTETO_RECORD_KEY = "poteto.pack";

export const PSTACK_REPO = "https://github.com/cursor/plugins";
/** The clone's place under the data folder. */
export const SKILLS_FOLDER = "skills";
export const CLONE_FOLDER = "cursor-plugins";
/** The two trees the clone holds: Cursor's, and the generated Claude Code copy. */
export const SPARSE_PATHS = ["pstack", "harness/pstack"] as const;
const BRANCH = "main";
const UPSTREAM = `refs/remotes/origin/${BRANCH}`;
export const PSTACK_SKILLS = "pstack/skills";
export const CLAUDE_SKILLS = "harness/pstack/claude-code/skills";
const PLUGIN_JSON = "pstack/plugin.json";
/** pstack's own note mapping its Cursor names to Claude Code's: the model for a harness it has no adapter for. */
export const ADAPTER_NOTE = "pstack/docs/harness/claude-code.md";
const MODE_SKILL = "poteto-mode/SKILL.md";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the timer looks whether the clone is due a check (or is missing, or the last attempt failed). */
export const TICK_MS = 60 * 60 * 1000;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What of poteto-mode applies by default (the user's #74 and #89 in the agents.md room, after shop's AGENTS.md narrowed
 * the mode the same way): its principles, reply and comment rules. Its triggers and playbooks, the process half, are the
 * room's to call for: the Consigliere routes work, seats the reviewer and names the playbook a job needs, so a member
 * running them on its own duplicates the room or conflicts with it (a pull request against the Handoff, its own
 * subagents and model routing against the crew's). One scope sentence, in the agents file's line and in the briefing's
 * Skills section; the briefing adds the room's ways.
 */
export const POTETO_FOLLOW = "Follow poteto-mode's principles, reply and comment rules";
export const POTETO_SCOPE =
  "Its triggers and playbooks apply only when your assignment names them: no how, architect, arena, interrogate or swarm fan-out, no mandatory subagent delegation, no data-shape-first or lever-building rule, no plan template and no pull request otherwise.";
export const POTETO_ROOM =
  "In a room, the Consigliere hands parallel work to the room's members and names in the assignment the playbook and skills a job needs; a member uses subagents only within its own outcome and delivers the change committed on its branch with a Handoff. Where the mode conflicts with the project's instructions or this briefing, those win.";

/**
 * The agents file's {poteto} line for a clone: what to follow at the mode's two paths, the scope sentence, and that the
 * file wins where the mode conflicts with it. Read by every session in the project, subagents too (the user's #387); the
 * briefing's Skills section carries the longer form, with the adapter note and the room's ways.
 */
export function potetoLine(clone: string): string {
  return `- ${POTETO_FOLLOW} at ${clone}/${PSTACK_SKILLS}/${MODE_SKILL} (Claude Code: the copy at ${clone}/${CLAUDE_SKILLS}/${MODE_SKILL}); skip setup-pstack. ${POTETO_SCOPE} Where the mode conflicts with this file, this file wins.`;
}

/** Why the last clone or update did not do what it was for. */
export interface PackError {
  reason: string;
  at: string;
  during: "clone" | "update";
}

/**
 * What the last clone or update found that the checkout cannot say, kept in kv: the version and the commit are read from
 * the checkout itself whenever they are used, so they always describe the same checkout.
 */
export interface PackRecord {
  /** When Backroom last tried to clone or update. */
  checkedAt: string | null;
  /** The last commit that changed pstack, as git's one-line log (`<short> <subject>`). */
  lastChange: string | null;
  error: PackError | null;
}

/** Poteto mode as the settings route reports it and poteto.update answers. */
export interface PotetoState {
  enabled: boolean;
  /** The commit or tag it is pinned at; null: it follows origin's main. */
  pin: string | null;
  /** Where the clone is, or will be. */
  folder: string;
  source: string;
  /** The folder validates: the agents file's line and the Skills section point at it. */
  ready: boolean;
  /** A clone or an update is running or waiting. */
  busy: boolean;
  version: string | null;
  commit: string | null;
  checkedAt: string | null;
  lastChange: string | null;
  /** "pinned at <pin>, latest is <short>" while pinned. */
  pinned: string | null;
  error: PackError | null;
}

/** What the briefing's Skills section is made of, while Poteto mode is on and ready. */
export interface PotetoBriefing {
  clone: string;
  version: string | null;
  /** The commit checked out, short. */
  commit: string | null;
  /** The skills in pstack/skills (each a folder with a SKILL.md), sorted. */
  names: string[];
}

export interface PotetoClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PotetoClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface PotetoOptions {
  /** The configured data folder: the clone goes under its real path. */
  dataDir: string;
  /** Where pstack is cloned from (ROOMS_PSTACK_REPO); cursor/plugins on GitHub by default. */
  source?: string;
  clock?: PotetoClock;
  log?: (message: string, detail?: unknown) => void;
}

interface Snapshot {
  ready: boolean;
  version: string | null;
  commit: string | null;
  names: string[];
}

const NOT_READY: Snapshot = { ready: false, version: null, commit: null, names: [] };
const EMPTY_RECORD: PackRecord = { checkedAt: null, lastChange: null, error: null };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A folder as a pstack clone: plugin.json readable, poteto-mode in both trees; its version and skills. */
function inspect(folder: string): { ok: true; version: string | null; names: string[] } | { ok: false; reason: string } {
  let version: string | null;
  try {
    const plugin = JSON.parse(readFileSync(join(folder, PLUGIN_JSON), "utf8")) as { version?: unknown };
    version = typeof plugin.version === "string" ? plugin.version : null;
  } catch (error) {
    return { ok: false, reason: `${PLUGIN_JSON} cannot be read: ${errorText(error)}` };
  }
  for (const tree of [PSTACK_SKILLS, CLAUDE_SKILLS]) {
    if (!isFile(join(folder, tree, MODE_SKILL))) return { ok: false, reason: `${tree}/${MODE_SKILL} is missing` };
  }
  let names: string[] = [];
  try {
    names = readdirSync(join(folder, PSTACK_SKILLS))
      .filter((name) => !name.startsWith(".") && isFile(join(folder, PSTACK_SKILLS, name, "SKILL.md")))
      .sort();
  } catch {
    // validated above: the folder is there
  }
  return { ok: true, version, names };
}

export class PotetoPack {
  readonly source: string;
  private readonly dataDir: string;
  private readonly repos: Pick<Repos, "getKv" | "setKv" | "deleteKv">;
  private readonly clock: PotetoClock;
  private readonly log: (message: string, detail?: unknown) => void;
  /**
   * While clones or updates of Backroom's are queued or running: the checkout as it was before the first of them could
   * move a file (taken when it was queued, on a new instance too), and as each left it for the next. Readers get it
   * instead of a checkout half way through a move. Null when nothing runs: readers then read the checkout itself.
   */
  private held: Snapshot | null = null;
  /** Why the last look with git refused the folder (refused()); null when it did not. */
  private refusal: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private preparing: Promise<void> | null = null;
  private running = 0;
  private timer: unknown = null;

  constructor(repos: Pick<Repos, "getKv" | "setKv" | "deleteKv">, options: PotetoOptions) {
    this.repos = repos;
    this.dataDir = options.dataDir;
    this.source = options.source ?? PSTACK_REPO;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
  }

  enabled(): boolean {
    return this.repos.getKv(POTETO_SETTING_KEY) !== "off";
  }

  pin(): string | null {
    return this.repos.getKv(POTETO_PIN_KEY) ?? null;
  }

  /** The clone's folder, under the data folder's real path (resolved as given while the data folder is missing). */
  folder(): string {
    let data: string;
    try {
      data = realpathSync(this.dataDir);
    } catch {
      data = resolve(this.dataDir);
    }
    return join(data, SKILLS_FOLDER, CLONE_FOLDER);
  }

  private record(): PackRecord {
    try {
      const saved = JSON.parse(this.repos.getKv(POTETO_RECORD_KEY) ?? "{}") as Partial<PackRecord>;
      return { checkedAt: saved.checkedAt ?? null, lastChange: saved.lastChange ?? null, error: saved.error ?? null };
    } catch {
      return { ...EMPTY_RECORD };
    }
  }

  private save(record: PackRecord): void {
    this.repos.setKv(POTETO_RECORD_KEY, JSON.stringify(record));
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * The checkout's files as they are now: ready when nothing refuses the folder and it validates (plugin.json readable,
   * poteto-mode's SKILL.md in both trees), with pstack's version and skills. No commit: that is git's (read()).
   */
  private onDisk(): Snapshot {
    if (this.refusal !== null || this.refusedOnSight()) return NOT_READY;
    const inspected = inspect(this.folder());
    return inspected.ok ? { ready: true, version: inspected.version, commit: null, names: inspected.names } : NOT_READY;
  }

  /** git in the clone, waited for (a few milliseconds: the briefing and the settings read it as they are); null on failure. */
  private gitNow(args: string[]): string | null {
    try {
      const text = execFileSync("git", ["-C", this.folder(), ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      });
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * The checkout now: its files, then its commit from git (`rev-parse HEAD`), read together each time, so the version and
   * the commit describe the same checkout (Backroom's own clones and updates never run in between: snapshot()).
   */
  private read(): Snapshot {
    const files = this.onDisk();
    return files.ready ? { ...files, commit: this.gitNow(["rev-parse", "HEAD"]) } : NOT_READY;
  }

  /** The checkout now, or while a clone or an update of Backroom's runs, as it was before it moved anything (held). */
  private snapshot(): Snapshot {
    return this.held ?? this.read();
  }

  /** Whether the clone is ready now, as snapshot() says it, without git. */
  private readyNow(): boolean {
    return this.held ? this.held.ready : this.onDisk().ready;
  }

  /** The agents file's {poteto} line while Poteto mode is on and the clone is ready; null otherwise. */
  pointerLine(): string | null {
    return this.enabled() && this.readyNow() ? potetoLine(this.folder()) : null;
  }

  /** The Skills section's makings while Poteto mode is on and the clone is ready; null otherwise. */
  briefing(): PotetoBriefing | null {
    if (!this.enabled()) return null;
    const snap = this.snapshot();
    if (!snap.ready) return null;
    return { clone: this.folder(), version: snap.version, commit: snap.commit ? snap.commit.slice(0, 7) : null, names: snap.names };
  }

  state(): PotetoState {
    const snap = this.snapshot();
    const record = this.record();
    const pin = this.pin();
    const latest = pin && snap.ready ? this.gitNow(["rev-parse", "--short", UPSTREAM]) : null;
    return {
      enabled: this.enabled(),
      pin,
      folder: this.folder(),
      source: this.source,
      ready: snap.ready,
      busy: this.running > 0,
      version: snap.version,
      commit: snap.commit,
      checkedAt: record.checkedAt,
      lastChange: record.lastChange,
      pinned: pin ? `pinned at ${pin}, latest is ${latest ?? "not known yet"}` : null,
      error: record.error,
    };
  }

  /** The hourly look, and one at once. */
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

  /**
   * The timer's look: while on, clone when missing, update when a day has passed since the last check or it failed. The
   * queued update looks again when it starts: off by then, it does nothing (and the pin is read then too).
   */
  tick(): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    if (!this.onDisk().ready) return this.prepare();
    const record = this.record();
    const due = record.error !== null || record.checkedAt === null || this.clock.now() - Date.parse(record.checkedAt) >= DAY_MS;
    return due ? this.serial(() => this.cloneOrUpdate()) : Promise.resolve();
  }

  /** In the background: the clone made when Poteto mode is on and it is missing; one at a time. Never rejects. */
  prepare(): Promise<void> {
    if (!this.enabled() || this.onDisk().ready) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const preparing = this.serial(async () => {
      if (this.enabled() && !this.onDisk().ready) await this.cloneNow();
    }).finally(() => {
      if (this.preparing === preparing) this.preparing = null;
    });
    this.preparing = preparing;
    return preparing;
  }

  /** Update now (and a pin set): the clone made, or fetched and moved; what it found. Off: nothing is done. */
  update(): Promise<PotetoState> {
    return this.serial(() => this.cloneOrUpdate()).then(() => this.state());
  }

  /** A queued clone or update as it starts: nothing while off; the clone made when the checkout is missing or invalid. */
  private async cloneOrUpdate(): Promise<void> {
    if (!this.enabled()) return;
    if (this.onDisk().ready) await this.updateNow();
    else await this.cloneNow();
  }

  /** When what is queued now has run; starts nothing. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /**
   * One clone or update at a time. The first queued while nothing runs takes the checkout as it is (held) before any git
   * command of its can move a file; each that ends leaves the checkout as it is now for the next, and the last drops it.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running === 0) this.held = this.read();
    this.running += 1;
    const next = this.queue.then(fn, fn).finally(() => {
      this.running -= 1;
      this.held = this.running > 0 ? this.read() : null;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Why the folder may not be touched, from what can be seen without git: a link between the data folder and the
   * clone, a component that is no folder, a .git that is no folder of its own. Null when none.
   */
  private refusedOnSight(): string | null {
    let data: string;
    try {
      data = realpathSync(this.dataDir);
    } catch (error) {
      return `the data folder ${this.dataDir} cannot be resolved: ${errorText(error)}`;
    }
    const folder = join(data, SKILLS_FOLDER, CLONE_FOLDER);
    for (const path of [join(data, SKILLS_FOLDER), folder]) {
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) return `${path} is a link: Backroom keeps pstack only in a folder of its own`;
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

  /**
   * refusedOnSight, and git's top level in the clone the folder itself (not an enclosing repository). Kept until the next
   * look: a refused folder is not ready.
   */
  private async refused(): Promise<string | null> {
    this.refusal = await this.refusedWithGit();
    return this.refusal;
  }

  private async refusedWithGit(): Promise<string | null> {
    const seen = this.refusedOnSight();
    if (seen) return seen;
    const folder = this.folder();
    try {
      lstatSync(folder);
    } catch {
      return null;
    }
    try {
      const top = (await runGit(folder, ["rev-parse", "--show-toplevel"])).trim();
      if (realpathSync(top) !== folder) return `git's top level in ${folder} is ${top}, not the folder itself`;
    } catch (error) {
      return `git cannot read ${folder}: ${errorText(error)}`;
    }
    return null;
  }

  private fail(during: PackError["during"], reason: string): void {
    const at = this.now();
    this.save({ ...this.record(), checkedAt: at, error: { reason, at, during } });
    this.log(`poteto mode: the ${during} of pstack failed: ${reason}`);
  }

  /** The commit a pin names, fetched from origin when the clone does not have it. */
  private async pinned(folder: string, pin: string): Promise<string> {
    const local = await runGit(folder, ["rev-parse", "--verify", "--quiet", `${pin}^{commit}`]).catch(() => "");
    if (local.trim()) return local.trim();
    await runGit(folder, ["fetch", "--quiet", "origin", pin], { timeoutMs: FETCH_TIMEOUT_MS }).catch((error: unknown) => {
      throw new Error(`the pin ${pin} is not in ${this.source}: ${errorText(error)}`);
    });
    return (await runGit(folder, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
  }

  private async cloneNow(): Promise<void> {
    const refusal = await this.refused();
    if (refusal) return this.fail("clone", refusal);
    const folder = this.folder();
    const skills = join(folder, "..");
    let there = true;
    try {
      lstatSync(folder);
    } catch {
      there = false;
    }
    if (there) {
      // A clone made by hand, or one that stopped validating: taken as it is when it validates, else left alone.
      const inspected = inspect(folder);
      if (!inspected.ok) return this.fail("clone", `${folder} is there but is no usable pstack clone (${inspected.reason}); Backroom leaves it as it is`);
      return this.settle(folder, "clone", null);
    }
    mkdirSync(skills, { recursive: true });
    const partial = mkdtempSync(join(skills, `.${CLONE_FOLDER}-`));
    try {
      await runGit(skills, ["clone", "--quiet", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", BRANCH, "--", this.source, partial], { timeoutMs: CLONE_TIMEOUT_MS });
      await runGit(partial, ["sparse-checkout", "set", "--cone", ...SPARSE_PATHS]);
      await runGit(partial, ["checkout", "--quiet", BRANCH], { timeoutMs: CLONE_TIMEOUT_MS });
      const pin = this.pin();
      if (pin) await runGit(partial, ["checkout", "--quiet", "--detach", await this.pinned(partial, pin)], { timeoutMs: CLONE_TIMEOUT_MS });
      const inspected = inspect(partial);
      if (!inspected.ok) throw new Error(`what ${this.source} holds is not pstack as Backroom reads it: ${inspected.reason}`);
      renameSync(partial, folder);
    } catch (error) {
      // Only the temporary folder of this clone is removed.
      rmSync(partial, { recursive: true, force: true });
      return this.fail("clone", errorText(error));
    }
    this.log(`poteto mode: pstack cloned from ${this.source} into ${folder}`);
    return this.settle(folder, "clone", null);
  }

  private async updateNow(): Promise<void> {
    const refusal = await this.refused();
    if (refusal) {
      // Not pointed at once this ends (refused() keeps the refusal): no longer a folder Backroom can vouch for.
      return this.fail("update", refusal);
    }
    const folder = this.folder();
    const dirty = await runGit(folder, ["status", "--porcelain"]).then(
      (text) => text.trim() !== "",
      () => true,
    );
    if (dirty) return this.fail("update", `local changes in ${folder}: Backroom moves nothing while they are there`);
    let error: string | null = null;
    try {
      await runGit(folder, ["fetch", "--quiet", "--prune", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
    } catch (fetchError) {
      error = `could not fetch from ${this.source}: ${errorText(fetchError)}`;
    }
    try {
      const pin = this.pin();
      if (pin) {
        const commit = await this.pinned(folder, pin);
        const head = (await runGit(folder, ["rev-parse", "HEAD"])).trim();
        if (head !== commit) await runGit(folder, ["checkout", "--quiet", "--detach", commit], { timeoutMs: FETCH_TIMEOUT_MS });
      } else {
        const branch = (await runGit(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
        if (branch !== BRANCH) await runGit(folder, ["checkout", "--quiet", BRANCH], { timeoutMs: FETCH_TIMEOUT_MS });
        await runGit(folder, ["merge", "--ff-only", "--quiet", UPSTREAM], { timeoutMs: FETCH_TIMEOUT_MS });
      }
    } catch (moveError) {
      error ??= errorText(moveError);
    }
    return this.settle(folder, "update", error);
  }

  /** After a clone or an update: the record (readers read the checkout itself once nothing runs: serial()). */
  private async settle(folder: string, during: PackError["during"], error: string | null): Promise<void> {
    const at = this.now();
    const inspected = inspect(folder);
    const lastChange = (await runGit(folder, ["log", "-1", "--format=%h %s", "--", ...SPARSE_PATHS]).catch(() => "")).trim() || null;
    const reason = error ?? (inspected.ok ? null : `${folder} is no usable pstack clone now: ${inspected.reason}`);
    this.save({ checkedAt: at, lastChange, error: reason ? { reason, at, during } : null });
    if (reason) this.log(`poteto mode: the ${during} of pstack: ${reason}`);
  }
}
