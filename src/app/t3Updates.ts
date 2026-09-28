/**
 * Updates for T3 and its harnesses, for the sidebar's Updates popup. Nothing updates by itself: an update starts only
 * when the user asks for that one. The harnesses' versions are T3's own checks. T3's newest release comes from npm,
 * on the channel the running T3 is on (nightly, preview or latest), looked up at most once an hour.
 */
import type { T3Adapter, T3HarnessVersion } from "../adapter/types.ts";
import { T3Unavailable } from "../adapter/types.ts";
import { RoomError } from "../domain/errors.ts";

/** The version published under a dist-tag of the `t3` package, or null when the tag does not exist. */
export type ReleaseLookup = (channel: string) => Promise<string | null>;

export const npmLatestT3: ReleaseLookup = async (channel) => {
  const response = await fetch("https://registry.npmjs.org/-/package/t3/dist-tags", { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  const version = ((await response.json()) as Record<string, unknown>)[channel];
  return typeof version === "string" ? version : null;
};

/** The dist-tag a version is published under: its prerelease name when it has one (nightly, preview), else latest. */
export function releaseChannel(version: string): string {
  const name = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return name && !/^\d+$/.test(name) ? name : "latest";
}

/** Semver order: the core numbers, then the prerelease identifiers; a release is above its prereleases. 0 when either does not parse. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const plain = version.split("+")[0]!;
    const dash = plain.indexOf("-");
    const core = (dash < 0 ? plain : plain.slice(0, dash)).split(".").map(Number);
    return { core, pre: dash < 0 ? [] : plain.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  if ([...x.core, ...y.core].some((n) => !Number.isInteger(n)) || x.core.length !== 3 || y.core.length !== 3) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNumber = /^\d+$/.test(p);
    const qNumber = /^\d+$/.test(q);
    if (pNumber && qNumber && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pNumber !== qNumber) return pNumber ? -1 : 1;
    if (!pNumber && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** A T3 update asked for from here: installing (T3 downloads and stages it), restarting into it, then done or failed. */
export interface ServerUpdateJob {
  targetVersion: string;
  state: "installing" | "restarting" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface UpdatesView {
  /** False while T3 does not answer: restarting into an update, or down. */
  reachable: boolean;
  error: string | null;
  server: {
    version: string | null;
    channel: string | null;
    latest: string | null;
    newer: boolean;
    /** T3 can install the newer version itself, from here. */
    canUpdate: boolean;
    /** When it cannot: what to do instead. */
    manual: string | null;
    /** Turns that are running carry on after T3 restarts into the update. */
    keepsTurns: boolean;
    releaseCheckedAt: string | null;
    releaseError: string | null;
    job: ServerUpdateJob | null;
  };
  /** The enabled harnesses. `pending`: asked for, T3 not finished yet. `error`: T3 refused the request itself. */
  harnesses: Array<T3HarnessVersion & { pending: boolean; error: string | null }>;
  /** Updates the popup can start: the count on the sidebar's button. */
  available: number;
}

const RELEASE_TTL_MS = 60 * 60_000;
const RELEASE_RETRY_MS = 10 * 60_000;
/** After the handover, how long T3 may take to come back on the new version before the update is called failed. */
const RESTART_TIMEOUT_MS = 5 * 60_000;

const messageOf = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

export class T3Updates {
  private release: { channel: string; version: string | null; at: number; error: string | null } | null = null;
  private serverJob: (ServerUpdateJob & { handedOverAt: number | null }) | null = null;
  private readonly harnessJobs = new Map<string, { pending: boolean; error: string | null }>();
  private readonly adapter: T3Adapter;
  private readonly lookup: ReleaseLookup;

  constructor(adapter: T3Adapter, lookup: ReleaseLookup = npmLatestT3) {
    this.adapter = adapter;
    this.lookup = lookup;
  }

  /** Versions and what can be updated. `fresh` reads T3 again instead of its copy from the last 20 seconds. */
  async view(fresh = false): Promise<UpdatesView> {
    let versions = null;
    let error: string | null = null;
    try {
      versions = await this.adapter.versions(fresh);
    } catch (caught) {
      error = messageOf(caught);
    }
    const version = versions?.serverVersion ?? null;
    this.settleServerJob(version);
    const channel = version ? releaseChannel(version) : null;
    const release = channel ? await this.latest(channel, false) : null;
    const newer = Boolean(version && release?.version && compareVersions(release.version, version) > 0);
    const selfUpdate = versions?.selfUpdate ?? null;
    const canUpdate = newer && (selfUpdate === "boot-service" || (selfUpdate === "desktop-managed" && Boolean(versions?.desktopAppUpdate)));
    const manual = !newer || canUpdate ? null : selfUpdate === "desktop-managed" ? "Update the T3 Code desktop app on T3's machine." : `On T3's machine, run: npx t3@${release!.version}`;
    const running = this.serverJob?.state === "installing" || this.serverJob?.state === "restarting";
    const harnesses = (versions?.harnesses ?? [])
      .filter((harness) => harness.enabled)
      .map((harness) => ({ ...harness, pending: this.harnessJobs.get(harness.instanceId)?.pending ?? false, error: this.harnessJobs.get(harness.instanceId)?.error ?? null }));
    const busy = (harness: (typeof harnesses)[number]) => harness.pending || harness.update?.status === "queued" || harness.update?.status === "running";
    return {
      reachable: versions !== null,
      error,
      server: {
        version,
        channel,
        latest: release?.version ?? null,
        newer,
        canUpdate,
        manual,
        keepsTurns: Boolean(versions?.threadContinuation),
        releaseCheckedAt: release ? new Date(release.at).toISOString() : null,
        releaseError: release?.error ?? null,
        job: this.serverJob ? { targetVersion: this.serverJob.targetVersion, state: this.serverJob.state, startedAt: this.serverJob.startedAt, finishedAt: this.serverJob.finishedAt, error: this.serverJob.error } : null,
      },
      harnesses,
      available: (canUpdate && !running ? 1 : 0) + harnesses.filter((harness) => harness.updatable && !busy(harness)).length,
    };
  }

  /** Check again now: T3 re-checks its harnesses, and npm is asked for T3's newest release. */
  async check(): Promise<UpdatesView> {
    await this.adapter.refreshProviders();
    const version = (await this.adapter.versions(true)).serverVersion;
    if (version) await this.latest(releaseChannel(version), true);
    return this.view(true);
  }

  /** Start one harness's update through T3. Answers at once; the popup follows T3's progress. */
  async updateHarness(instanceId: string): Promise<UpdatesView> {
    const harness = (await this.adapter.versions(true)).harnesses.find((candidate) => candidate.instanceId === instanceId);
    if (!harness) throw new RoomError("not_found", `T3 has no harness ${instanceId}`, 404);
    const running = this.harnessJobs.get(instanceId)?.pending || harness.update?.status === "queued" || harness.update?.status === "running";
    if (running) throw new RoomError("update_running", `${harness.displayName} is already being updated`, 409);
    if (!harness.updatable) throw new RoomError("not_updatable", harness.note ?? `${harness.displayName} has no update to install`, 409);
    this.harnessJobs.set(instanceId, { pending: true, error: null });
    void this.adapter.updateHarness({ instanceId, driver: harness.driver }).then(
      () => this.harnessJobs.delete(instanceId),
      (caught) => this.harnessJobs.set(instanceId, { pending: false, error: messageOf(caught) }),
    );
    return this.view(true);
  }

  /**
   * Start T3's update to `targetVersion`, which must be the newest release the popup showed. T3 installs it and
   * restarts; turns that are running carry on when T3 can do that.
   */
  async updateServer(targetVersion: string): Promise<UpdatesView> {
    if (this.serverJob?.state === "installing" || this.serverJob?.state === "restarting") throw new RoomError("update_running", `T3 is already being updated to ${this.serverJob.targetVersion}`, 409);
    const versions = await this.adapter.versions(true);
    const current = versions.serverVersion;
    if (!current) throw new RoomError("unknown_version", "T3 did not say which version it runs", 409);
    const release = await this.latest(releaseChannel(current), false);
    if (!release.version) throw new RoomError("no_release", `No newer T3 is known${release.error ? `: ${release.error}` : ""}`, 409);
    if (release.version !== targetVersion) throw new RoomError("stale_release", `The newest T3 is now ${release.version}; check the popup again`, 409);
    if (compareVersions(targetVersion, current) <= 0) throw new RoomError("up_to_date", `T3 already runs ${current}`, 409);
    const selfUpdate = versions.selfUpdate === "boot-service" || (versions.selfUpdate === "desktop-managed" && versions.desktopAppUpdate);
    if (!selfUpdate) throw new RoomError("not_updatable", "This T3 cannot update itself; update it on its machine", 409);
    const job = { targetVersion, state: "installing" as const, startedAt: new Date().toISOString(), finishedAt: null, error: null, handedOverAt: null };
    this.serverJob = job;
    const handedOver = () => {
      if (this.serverJob === job) this.serverJob = { ...job, state: "restarting", handedOverAt: Date.now() };
    };
    void this.adapter.updateServer({ targetVersion, continueRunningThreads: versions.threadContinuation }).then(handedOver, (caught) => {
      // The connection can drop at the handover itself; whether T3 comes back on the new version decides.
      if (caught instanceof T3Unavailable) return handedOver();
      if (this.serverJob === job) this.serverJob = { ...job, state: "failed", finishedAt: new Date().toISOString(), error: messageOf(caught) };
    });
    return this.view(false);
  }

  /** A T3 update ends when T3 answers on the new version; one that stays on the old version too long has failed. */
  private settleServerJob(version: string | null): void {
    const job = this.serverJob;
    if (!job || job.state !== "restarting" || job.handedOverAt === null) return;
    if (version === job.targetVersion) {
      this.serverJob = { ...job, state: "done", finishedAt: new Date().toISOString() };
    } else if (Date.now() - job.handedOverAt > RESTART_TIMEOUT_MS) {
      const error = version
        ? `T3 is still on ${version}; its launcher may have rolled the update back. Check the T3 service's log.`
        : `T3 has not come back since the update to ${job.targetVersion}. Check the T3 service.`;
      this.serverJob = { ...job, state: "failed", finishedAt: new Date().toISOString(), error };
    }
  }

  private async latest(channel: string, force: boolean): Promise<{ version: string | null; at: number; error: string | null }> {
    const cached = this.release;
    const fresh = cached && cached.channel === channel && Date.now() - cached.at < (cached.error ? RELEASE_RETRY_MS : RELEASE_TTL_MS);
    if (cached && fresh && !force) return cached;
    try {
      this.release = { channel, version: await this.lookup(channel), at: Date.now(), error: null };
    } catch (caught) {
      // Keep the last version known on this channel, and say why it could not be checked.
      this.release = { channel, version: cached?.channel === channel ? cached.version : null, at: Date.now(), error: `npm: ${messageOf(caught)}` };
    }
    return this.release;
  }
}
