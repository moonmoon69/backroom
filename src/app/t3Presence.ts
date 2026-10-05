/**
 * Backroom standing in for T3's own window. T3 does its background checks (plan usage, harness status, the model
 * manifest) only while a client in view holds a lease on a live connection, and its window asks for a full check when
 * it opens. Used without that window, T3 did neither: the usage bars kept the last turn's reading for hours, past their
 * reset. So each Backroom page says whether it is in view; while any page is open Backroom holds the lease for them
 * (renewed every 25s, as T3's window does). While someone is looking it also asks T3 for the checks the bars need: all
 * providers when someone comes back, and a provider's usage once its reading is a minute old or its window has reset.
 */
import type { ClientActivity, T3Adapter } from "../adapter/types.ts";

/** What one open Backroom page says about itself. */
export interface PageActivity {
  pageId: string;
  visible: boolean;
  focused: boolean;
  /** When the page was last used (ms since the epoch); null when not since it opened. */
  interactedAt: number | null;
}

/** T3's lease: 45s, renewed every 25s. A page that has not reported for two minutes is taken as closed. */
const LEASE_MS = 45_000;
const REPORT_MS = 25_000;
const PAGE_MS = 120_000;
/** T3's own provider check interval, and so the least time between two full checks Backroom asks for. */
const FULL_CHECK_MS = 5 * 60_000;
/** How old a plan-usage reading may get while someone looks: T3's fastest preset ("performance") checks every minute. */
const USAGE_MS = 60_000;
/** A provider whose check brought no new usage reading (T3 reads Cursor's only from turns) is left alone this long. */
const QUIET_MS = 30 * 60_000;

export class T3Presence {
  private readonly adapter: T3Adapter;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly pages = new Map<string, PageActivity & { at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beating: Promise<void> | null = null;
  private again = false;
  private leaseHeld = false;
  private inView = false;
  private failing = false;
  private lastFullCheck = Number.NEGATIVE_INFINITY;
  /** Per provider: when Backroom last asked T3 to check it, and the reading it had then. */
  private readonly usageChecks = new Map<string, { at: number; readingBefore: string | null }>();
  private checking: Promise<void> | null = null;
  private stopped = false;

  constructor(adapter: T3Adapter, options: { now?: () => number; log?: (message: string, detail?: unknown) => void } = {}) {
    this.adapter = adapter;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** A page reports in: when it opens, is shown, hidden, focused or left, is used after a pause, and every 25s. */
  page(activity: PageActivity & { closed?: boolean }): Promise<void> {
    if (activity.closed) this.pages.delete(activity.pageId);
    else this.pages.set(activity.pageId, { pageId: activity.pageId, visible: activity.visible, focused: activity.focused, interactedAt: activity.interactedAt, at: this.now() });
    return this.beat();
  }

  /** Resolves once the checks asked for so far have finished (for tests). */
  async idle(): Promise<void> {
    while (this.beating || this.checking) await (this.beating ?? this.checking);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.leaseHeld) void this.adapter.reportActivity(null).catch(() => {});
    this.leaseHeld = false;
  }

  /** One report at a time; a page reporting during one gets another straight after. */
  private beat(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.beating) {
      this.again = true;
      return this.beating;
    }
    this.beating = (async () => {
      do {
        this.again = false;
        await this.report();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.beating = null;
    });
    return this.beating;
  }

  private async report(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const activity = this.activity(now);
    try {
      if (activity) await this.adapter.reportActivity(activity);
      else if (this.leaseHeld) await this.adapter.reportActivity(null);
      this.leaseHeld = activity !== null;
      if (this.failing) this.log("T3 presence restored");
      this.failing = false;
    } catch (error) {
      if (!this.failing) this.log("T3 presence could not be reported", (error as Error).message);
      this.failing = true;
    }
    const inView = activity !== null && activity.visible && (activity.focused || activity.recentlyInteracted);
    if (inView && !this.checking) {
      this.checking = this.check(now, !this.inView).finally(() => {
        this.checking = null;
      });
    }
    this.inView = inView;
    if (activity && !this.stopped) {
      this.timer = setTimeout(() => void this.beat(), REPORT_MS);
      this.timer.unref?.();
    }
  }

  /** The pages' state as one client, as T3 weighs it; null when no page is open. */
  private activity(now: number): ClientActivity | null {
    for (const [pageId, page] of this.pages) if (now - page.at > PAGE_MS) this.pages.delete(pageId);
    if (this.pages.size === 0) return null;
    const pages = [...this.pages.values()];
    return {
      visible: pages.some((page) => page.visible),
      focused: pages.some((page) => page.visible && page.focused),
      recentlyInteracted: pages.some((page) => page.interactedAt !== null && now - page.interactedAt <= LEASE_MS),
      ttlMs: LEASE_MS,
    };
  }

  /**
   * A full check when someone arrives (at most every five minutes), as T3's window asks for when it opens; then, for
   * each provider with usage bars, a check once its reading is a minute old, or at once when a window reset after it.
   */
  private async check(now: number, arriving: boolean): Promise<void> {
    try {
      if (arriving && now - this.lastFullCheck >= FULL_CHECK_MS) {
        this.lastFullCheck = now;
        await this.adapter.refreshProviders();
        return;
      }
      // Checks happen on the 25s beat, so a reading that would pass a minute before the next beat is checked now.
      const byNextBeat = now + REPORT_MS;
      for (const provider of await this.adapter.listProviders()) {
        if (!provider.enabled || provider.usageWindows.length === 0) continue;
        const asked = this.usageChecks.get(provider.instanceId);
        if (asked && byNextBeat - asked.at < USAGE_MS) continue;
        // The last check brought no new reading: this provider's check does not read usage.
        if (asked && provider.usageCheckedAt === asked.readingBefore && now - asked.at < QUIET_MS) continue;
        const checkedAt = Date.parse(provider.usageCheckedAt ?? "") || 0;
        const reset = provider.usageWindows.some((window) => {
          const at = Date.parse(window.resetsAt ?? "");
          return at <= now && at > checkedAt;
        });
        if (!reset && byNextBeat - checkedAt < USAGE_MS) continue;
        this.usageChecks.set(provider.instanceId, { at: now, readingBefore: provider.usageCheckedAt });
        await this.adapter.refreshProviders({ instanceId: provider.instanceId });
      }
    } catch (error) {
      this.log("T3 provider check failed", (error as Error).message);
    }
  }
}
