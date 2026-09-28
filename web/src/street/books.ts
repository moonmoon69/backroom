/**
 * The street's books: what each business (project) has spent, the sum of its threads' estimated spend at list price
 * (rooms' threads and threads on their own alike), and what the whole machine spent today. Read a few threads at a
 * time and kept a while: a thread at work is read again after a minute, a settled or archived one after half an hour.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import type { T3ThreadShell } from "../types.ts";

interface Entry {
  cost: number;
  /** False when the thread has spend we cannot read (a harness without readable usage). */
  complete: boolean;
  at: number;
}

const cache = new Map<string, Entry>();

function ttl(thread: T3ThreadShell): number {
  const busy = thread.session?.status === "running" || thread.session?.status === "starting" || Boolean(thread.backgroundLiveness);
  if (busy) return 60_000;
  if (thread.settledAt || thread.archivedAt) return 30 * 60_000;
  return 5 * 60_000;
}

export interface Books {
  /** Estimated spend per project id, in dollars. */
  byProject: Map<string, number>;
  /** Some threads have no estimate (a harness without readable usage) or are still being read. */
  partial: boolean;
  /** What every thread on this machine spent today (T3's own usage); null before the first read or when T3 has none. */
  today: number | null;
  total: number;
}

export function useBooks(threads: T3ThreadShell[], enabled: boolean): Books {
  const [version, setVersion] = useState(0);
  const [today, setToday] = useState<number | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || running.current) return;
    const now = Date.now();
    const stale = threads.filter((t) => !t.deletedAt && (!cache.has(t.id) || now - cache.get(t.id)!.at > ttl(t)));
    if (stale.length === 0) return;
    // One read at a time per page: the threads list is polled every few seconds, a read of many threads takes longer.
    running.current = true;
    const queue = [...stale];
    const worker = async () => {
      while (queue.length > 0 && mounted.current) {
        const thread = queue.shift()!;
        try {
          const { cost } = await api.threadCost(thread.id);
          cache.set(thread.id, { cost: cost.available ? cost.total.costUsd : 0, complete: cost.available || cost.reason === "no_session", at: Date.now() });
        } catch {
          cache.set(thread.id, { cost: 0, complete: false, at: Date.now() });
        }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]).finally(() => {
      running.current = false;
      if (mounted.current) setVersion((v) => v + 1);
    });
  }, [threads, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const read = () =>
      api.usageToday().then(
        (usage) => setToday(usage.available ? usage.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0) : null),
        () => undefined,
      );
    void read();
    const timer = window.setInterval(read, 120_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return useMemo(() => {
    const byProject = new Map<string, number>();
    let partial = false;
    let total = 0;
    for (const thread of threads) {
      if (thread.deletedAt) continue;
      const entry = cache.get(thread.id);
      if (!entry?.complete) partial = true;
      const cost = entry?.cost ?? 0;
      byProject.set(thread.projectId, (byProject.get(thread.projectId) ?? 0) + cost);
      total += cost;
    }
    return { byProject, partial, today, total };
    // version: a read finished.
  }, [version, threads, today]);
}

export function money(value: number): string {
  if (value >= 1000) return `$${Math.round(value).toLocaleString()}`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}
