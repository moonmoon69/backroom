/** Wires the persistence, service, scheduler, and change-notification hub. Used by the server and by tests. */
import type { T3Adapter } from "../adapter/types.ts";
import { Database } from "../db/database.ts";
import { Repos } from "../db/repos.ts";
import type { RoomBrowsers } from "../browser/roomBrowsers.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { RoomService } from "./service.ts";

export class ChangeHub {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<(roomId: string) => void>();

  subscribe(roomId: string, listener: () => void): () => void {
    let set = this.listeners.get(roomId);
    if (!set) {
      set = new Set();
      this.listeners.set(roomId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  subscribeAll(listener: (roomId: string) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  notify(roomId: string): void {
    for (const listener of this.listeners.get(roomId) ?? []) listener();
    for (const listener of this.globalListeners) listener(roomId);
  }
}

export interface AppStack {
  db: Database;
  repos: Repos;
  adapter: T3Adapter;
  service: RoomService;
  scheduler: Scheduler;
  hub: ChangeHub;
  /** Room browsers, when this service may start them (the server; not the tests). */
  browsers: RoomBrowsers | null;
  close(): void;
}

export function createStack(input: {
  dbPath: string;
  adapter: T3Adapter;
  briefingBudgetChars: number;
  log?: (message: string, detail?: unknown) => void;
  /** Builds the room browser manager once the repos and change hub exist. */
  browsers?: (deps: { repos: Repos; notify: (roomId: string) => void }) => RoomBrowsers;
}): AppStack {
  const db = new Database(input.dbPath);
  const repos = new Repos(db);
  const hub = new ChangeHub();
  const notify = (roomId: string) => hub.notify(roomId);
  const service = new RoomService(db, repos, input.adapter, notify);
  const browsers = input.browsers ? input.browsers({ repos, notify }) : null;
  const scheduler = new Scheduler(
    db,
    repos,
    input.adapter,
    service,
    { briefingBudgetChars: input.briefingBudgetChars, ...(input.log ? { log: input.log } : {}), ...(browsers ? { browsers } : {}) },
    notify,
  );
  return {
    db,
    repos,
    adapter: input.adapter,
    service,
    scheduler,
    hub,
    browsers,
    close() {
      scheduler.stop();
      browsers?.detach();
      db.close();
    },
  };
}
