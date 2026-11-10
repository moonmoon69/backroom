/**
 * Backroom's own update, its row in the Updates popup. The newest release of its package (package.json's name) on its
 * channel comes from the same lookup as T3's. Only a copy in npm's global folder updates itself (src/app/install.ts):
 * when the user asks, it runs the npm that came with its node to install its own package at the version the lookup
 * returned (nothing a request names) into the global folder that holds it, then stops, and a service manager that restarts it brings it back on the new
 * version. A failed install leaves the copy as it was (npm puts a package's folder back when it cannot finish) and says
 * why. A checkout is updated with git and a copy elsewhere by the user: their rows say how.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repos } from "../db/repos.ts";
import { roomForKey } from "../browser/catalog.ts";
import type { Projection } from "../engine/types.ts";
import { RoomError } from "../domain/errors.ts";
import { seatsWithLiveRuns } from "../runtime/index.ts";
import type { Install, InstallKind } from "./install.ts";
import { ReleaseCache, compareVersions, messageOf, releaseChannel, type ReleaseLookup } from "./t3Updates.ts";

export interface BackroomUpdateJob {
  targetVersion: string;
  /** installing: npm is at work; restarting: installed, and this copy stops; failed: the copy is as it was. */
  state: "installing" | "restarting" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface BackroomUpdateView {
  version: string;
  install: InstallKind;
  channel: string;
  latest: string | null;
  newer: boolean;
  /** Backroom can install the newer version itself, from here. */
  canUpdate: boolean;
  /** When it cannot: what to do instead. */
  manual: string | null;
  /** While it can: who works now, named in the confirmation (members with a running turn or a browser tab open). */
  busy: string[];
  releaseCheckedAt: string | null;
  releaseError: string | null;
  job: BackroomUpdateJob | null;
}

/** Runs npm with these arguments; rejects with what npm said when it fails. */
export type NpmRunner = (args: string[]) => Promise<void>;

/** The npm that came with the node running this copy (Install.npmCli), run by that node, its output kept for a failure. */
export function nodeNpm(npmCli: string): NpmRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [npmCli, ...args], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve();
        const said = `${stderr}\n${stdout}`.trim().split("\n").slice(-12).join("\n");
        reject(new Error(said || error.message));
      });
    });
}

/** A version npm could name: digits and dots, with prerelease and build parts of letters, digits, dots and dashes. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** How long an installed copy keeps answering before it stops, so a page polling while the update runs reads that it is installed. */
const STOP_DELAY_MS = 3000;

export interface BackroomUpdateOptions {
  install: Install;
  lookup: ReleaseLookup;
  /** npm for the install; by default the one beside this copy's node. */
  npm?: NpmRunner;
  /** Who works now, for the confirmation. */
  busy?: () => Promise<string[]>;
  /** The new version is installed: stop this copy. */
  installed?: (version: string) => void;
  stopDelayMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export class BackroomUpdate {
  private readonly releases: ReleaseCache;
  private job: BackroomUpdateJob | null = null;
  /** An Update request is between its first check and its job: the release lookup is awaited. */
  private claimed = false;
  private readonly options: BackroomUpdateOptions;

  constructor(options: BackroomUpdateOptions) {
    this.options = options;
    this.releases = new ReleaseCache(options.install.name, options.lookup);
  }

  /** The row. `force` asks npm again instead of the copy from the last hour. */
  async view(force: boolean): Promise<BackroomUpdateView> {
    const { kind, name, version } = this.options.install;
    const channel = releaseChannel(version);
    const release = await this.releases.latest(channel, force);
    const newer = Boolean(release.version && compareVersions(release.version, version) > 0);
    const canUpdate = newer && kind === "global";
    const manual =
      kind === "checkout"
        ? "A git checkout: Backroom does not update it. Update it with git, then npm install, npm run build:web and a restart."
        : newer && !canUpdate
          ? `Backroom updates itself only in npm's global folder. Start ${release.version} with npx ${name}@${release.version}, or install it with npm install --global ${name}.`
          : null;
    return {
      version,
      install: kind,
      channel,
      latest: release.version,
      newer,
      canUpdate,
      manual,
      busy: canUpdate && !this.running() && this.options.busy ? await this.options.busy() : [],
      releaseCheckedAt: new Date(release.at).toISOString(),
      releaseError: release.error,
      job: this.job,
    };
  }

  /** An update is under way: a request checking the release, npm installing, or the copy about to stop on the new version. */
  running(): boolean {
    return this.claimed || this.job?.state === "installing" || this.job?.state === "restarting";
  }

  /**
   * Install the newest release, which must be `targetVersion`, the one the popup showed. The version installed is the
   * lookup's; the request's is only compared with it.
   */
  async update(targetVersion: string): Promise<BackroomUpdateView> {
    const { kind, name, version, root, npmCli, prefix } = this.options.install;
    if (this.running()) throw new RoomError("update_running", `Backroom is already being updated${this.claimed ? "" : ` to ${this.job!.targetVersion}`}`, 409);
    if (kind !== "global" || !npmCli || !prefix) throw new RoomError("not_updatable", "Backroom updates itself only when installed in npm's global folder", 409);
    // Claimed before the lookup is awaited, so a second request meanwhile is refused; given back by every refusal below.
    this.claimed = true;
    let job: BackroomUpdateJob;
    let latest: string;
    try {
      const release = await this.releases.latest(releaseChannel(version), false);
      if (!release.version || !VERSION.test(release.version)) throw new RoomError("no_release", `No newer Backroom is known${release.error ? `: ${release.error}` : ""}`, 409);
      latest = release.version;
      if (latest !== targetVersion) throw new RoomError("stale_release", `The newest Backroom is now ${latest}; check the popup again`, 409);
      if (compareVersions(latest, version) <= 0) throw new RoomError("up_to_date", `Backroom already runs ${version}`, 409);
      job = { targetVersion: latest, state: "installing", startedAt: new Date().toISOString(), finishedAt: null, error: null };
      this.job = job;
    } finally {
      this.claimed = false;
    }
    this.options.log?.(`updating Backroom ${version} → ${latest}`);
    const npm = this.options.npm ?? nodeNpm(npmCli);
    const fail = (error: string) => {
      if (this.job === job) this.job = { ...job, state: "failed", finishedAt: new Date().toISOString(), error };
      this.options.log?.(`Backroom's update to ${latest} failed; still on ${version}`, error);
    };
    void npm(["install", "--global", "--prefix", prefix, "--no-fund", "--no-audit", `${name}@${latest}`]).then(() => {
      let now: unknown = null;
      try {
        now = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
      } catch (caught) {
        now = messageOf(caught);
      }
      if (now !== latest) return fail(`npm finished, but ${root} holds ${String(now)}, not ${latest}`);
      if (this.job === job) this.job = { ...job, state: "restarting", finishedAt: new Date().toISOString() };
      setTimeout(() => this.options.installed?.(latest), this.options.stopDelayMs ?? STOP_DELAY_MS);
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
