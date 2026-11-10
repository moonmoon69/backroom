/**
 * Backroom's own update, its row in the Updates popup. A release is a tag v<version> on the repository; the newest is
 * read from the tags of this copy's origin remote (a prerelease only for a copy that runs one), at most once an hour and
 * on Check now. When the user asks, the service runs the copy's own install.sh on the copy's own folder, nothing a
 * request names: the script is the one owner of whether the copy may move (it refuses one with work of its own) and of
 * putting it back when a step fails. Once the script has succeeded, the service reads the version now in the copy's
 * package.json, says so, and stops; a service manager that restarts it brings it back on that version, and a copy
 * started by hand is started again by the user. The same command, to run by hand, is on the row.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Repos } from "../db/repos.ts";
import { roomForKey } from "../browser/catalog.ts";
import { COPY_ROOT, COPY_VERSION } from "../config.ts";
import type { Projection } from "../engine/types.ts";
import { RoomError } from "../domain/errors.ts";
import { runGit } from "../git/reader.ts";
import { seatsWithLiveRuns } from "../runtime/index.ts";
import { ReleaseCache, compareVersions, messageOf } from "./t3Updates.ts";

export interface BackroomUpdateJob {
  targetVersion: string;
  /** installing: the script is at work; restarting: installed, and this copy stops; failed: the script says why. */
  state: "installing" | "restarting" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface BackroomUpdateView {
  version: string;
  /** The copy's folder, which its update moves. */
  folder: string;
  latest: string | null;
  newer: boolean;
  /** The update, to run on this machine by hand. */
  command: string;
  /** While a newer release is offered: who works now, named in the confirmation (a running turn, a browser tab open). */
  busy: string[];
  releaseCheckedAt: string | null;
  releaseError: string | null;
  job: BackroomUpdateJob | null;
}

const RELEASE_TAG = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const isPrerelease = (version: string) => version.split("+")[0]!.includes("-");

/**
 * The newest release on the origin remote of the checkout at `root`: its highest tag v<version>, a prerelease only when
 * `running` is one; null when it has none. git asks for no credential, and a remote that does not answer in time fails.
 */
export async function originRelease(root: string, running: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    await runGit(root, ["remote", "get-url", "origin"]);
  } catch {
    throw new Error("this copy has no origin remote");
  }
  const started = Date.now();
  let refs: string;
  try {
    refs = await runGit(root, ["ls-remote", "--tags", "--refs", "origin"], { timeoutMs });
  } catch (caught) {
    throw new Error(Date.now() - started >= timeoutMs ? `origin did not answer within ${Math.round(timeoutMs / 1000)} s` : `origin did not answer: ${messageOf(caught)}`);
  }
  let newest: string | null = null;
  for (const line of refs.split("\n")) {
    const version = RELEASE_TAG.exec(line.split("\t")[1] ?? "")?.[1];
    if (!version || (isPrerelease(version) && !isPrerelease(running))) continue;
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/** Runs the install script on the copy's folder; rejects with the script's last lines when it fails or is stopped. */
export type ScriptRunner = () => Promise<void>;

const SCRIPT_TIMEOUT_MS = 20 * 60_000;
const KEPT_LINES = 40;

/**
 * The copy's own install.sh on its own folder, with the node that runs this copy first on PATH (npm ci and the build
 * use it). It runs in a process group of its own: at the timeout the whole group gets TERM, npm included, and the
 * script puts the copy back before it exits.
 */
export function copyScript(root: string, timeoutMs = SCRIPT_TIMEOUT_MS): ScriptRunner {
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn("sh", [join(root, "install.sh"), root], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "0" },
      });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-64 * 1024);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {}
      }, timeoutMs);
      const last = () => output.trim().split("\n").slice(-KEPT_LINES).join("\n");
      child.on("error", (error) => (clearTimeout(timer), reject(error)));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) return resolve();
        const why = timedOut ? `install.sh did not finish within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)} s`}` : `install.sh ${signal ? `was stopped by ${signal}` : `exited with ${code}`}`;
        reject(new Error(last() ? `${why}:\n${last()}` : why));
      });
    });
}

/** How long an installed copy keeps answering before it stops, so a page polling while the update runs reads that it is installed. */
const STOP_DELAY_MS = 3000;

export interface BackroomUpdateOptions {
  /** The copy: its folder and the version it runs (this checkout's by default). */
  root?: string;
  version?: string;
  /** Its newest release; by default its origin's tags. */
  lookup?: () => Promise<string | null>;
  /** Its update; by default its own install.sh on its folder. */
  run?: ScriptRunner;
  /** Who works now, for the confirmation. */
  busy?: () => Promise<string[]>;
  /** The update is installed: stop this copy. */
  installed?: (version: string) => void;
  stopDelayMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

const quote = (path: string) => (/^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`);

export class BackroomUpdate {
  readonly root: string;
  readonly version: string;
  private readonly releases: ReleaseCache;
  private readonly run: ScriptRunner;
  private job: BackroomUpdateJob | null = null;
  /** An Update request is between its first check and its job: the release lookup is awaited. */
  private claimed = false;
  private readonly options: BackroomUpdateOptions;

  constructor(options: BackroomUpdateOptions = {}) {
    this.options = options;
    this.root = options.root ?? COPY_ROOT;
    this.version = options.version ?? COPY_VERSION;
    const lookup = options.lookup ?? (() => originRelease(this.root, this.version));
    this.releases = new ReleaseCache(() => lookup(), "git");
    this.run = options.run ?? copyScript(this.root);
  }

  /** The command the row shows, and the one Update runs. */
  get command(): string {
    return `sh ${quote(join(this.root, "install.sh"))} ${quote(this.root)}`;
  }

  /** The row. `force` asks the origin again instead of the copy from the last hour. */
  async view(force: boolean): Promise<BackroomUpdateView> {
    const release = await this.releases.latest("", force);
    const newer = Boolean(release.version && compareVersions(release.version, this.version) > 0);
    return {
      version: this.version,
      folder: this.root,
      latest: release.version,
      newer,
      command: this.command,
      busy: newer && !this.running() && this.options.busy ? await this.options.busy() : [],
      releaseCheckedAt: new Date(release.at).toISOString(),
      releaseError: release.error,
      job: this.job,
    };
  }

  /** An update is under way: a request checking the release, the script at work, or the copy about to stop on the new version. */
  running(): boolean {
    return this.claimed || this.job?.state === "installing" || this.job?.state === "restarting";
  }

  /** Run the update when the newest release is `targetVersion`, the one the popup showed; the request only names it to compare. */
  async update(targetVersion: string): Promise<BackroomUpdateView> {
    if (this.running()) throw new RoomError("update_running", `Backroom is already being updated${this.claimed ? "" : ` to ${this.job!.targetVersion}`}`, 409);
    // Claimed before the lookup is awaited, so a second request meanwhile is refused; given back by every refusal below.
    this.claimed = true;
    let job: BackroomUpdateJob;
    try {
      const release = await this.releases.latest("", false);
      if (!release.version) throw new RoomError("no_release", `No newer Backroom is known${release.error ? `: ${release.error}` : ""}`, 409);
      if (release.version !== targetVersion) throw new RoomError("stale_release", `The newest Backroom is now ${release.version}; check the popup again`, 409);
      if (compareVersions(release.version, this.version) <= 0) throw new RoomError("up_to_date", `Backroom already runs ${this.version}`, 409);
      job = { targetVersion: release.version, state: "installing", startedAt: new Date().toISOString(), finishedAt: null, error: null };
      this.job = job;
    } finally {
      this.claimed = false;
    }
    this.options.log?.(`updating Backroom ${this.version} → ${job.targetVersion}: ${this.command}`);
    const fail = (error: string) => {
      if (this.job === job) this.job = { ...job, state: "failed", finishedAt: new Date().toISOString(), error };
      this.options.log?.(`Backroom's update to ${job.targetVersion} failed; still on ${this.version}`, error);
    };
    void this.run().then(() => {
      let now: string;
      try {
        now = String((JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { version?: unknown }).version);
      } catch (caught) {
        return fail(`install.sh finished, but ${join(this.root, "package.json")} could not be read: ${messageOf(caught)}`);
      }
      if (compareVersions(now, this.version) <= 0) return fail(`install.sh finished, but ${this.root} holds ${now}`);
      if (this.job === job) this.job = { ...job, targetVersion: now, state: "restarting", finishedAt: new Date().toISOString() };
      setTimeout(() => this.options.installed?.(now), this.options.stopDelayMs ?? STOP_DELAY_MS);
    }, (caught) => fail(messageOf(caught)));
    return this.view(false);
  }
}

/** The members who work now: a running turn in a room, or a tab of their own open in a room browser (`agentsWithTabs`' keys). */
export async function busyMembers(repos: Repos, view: (roomId: string) => Projection, agentsWithTabs: () => Promise<string[]>): Promise<string[]> {
  const found = new Map<string, Set<string>>();
  const add = (who: string, what: string) => found.set(who, (found.get(who) ?? new Set()).add(what));
  for (const room of repos.listRooms()) {
    for (const seatId of seatsWithLiveRuns(view(room.id))) {
      const binding = repos.getBinding(seatId);
      const alias = (binding ? repos.getParticipant(binding.participantId)?.alias : null) ?? seatId;
      add(`${alias} in ${room.title}`, "a turn");
    }
  }
  for (const key of await agentsWithTabs()) {
    const room = roomForKey(repos, key);
    add(room ? `${key.slice(0, key.lastIndexOf("."))} in ${room.title}` : "an agent outside rooms", "a browser tab");
  }
  return [...found].map(([who, what]) => `${who} (${[...what].join(", ")})`);
}
