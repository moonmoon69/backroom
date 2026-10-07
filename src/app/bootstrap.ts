/** Wires the persistence, service, scheduler, and change-notification hub. Used by the server and by tests. */
import { dirname, join } from "node:path";
import type { T3Adapter } from "../adapter/types.ts";
import { Database } from "../db/database.ts";
import { Repos } from "../db/repos.ts";
import type { RoomBrowsers } from "../browser/roomBrowsers.ts";
import { EngineStore } from "../engine/index.ts";
import { EngineHost } from "../runtime/index.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { RoomService } from "./service.ts";
import { startSeen } from "./seen.ts";
import { T3Presence } from "./t3Presence.ts";
import { T3Updates, type ReleaseLookup } from "./t3Updates.ts";

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
  /** T3's and its harnesses' updates, started only when asked for. */
  updates: T3Updates;
  /** Backroom in place of T3's window: keeps T3 checking plan usage and harnesses while a page is open. */
  presence: T3Presence;
  /** The engine runtime over data/board.sqlite, with ROOMS_ENGINE=1 only (stage 4/5; off until cutover). */
  engine: EngineHost | null;
  close(): void;
}

export function createStack(input: {
  dbPath: string;
  adapter: T3Adapter;
  briefingBudgetChars: number;
  log?: (message: string, detail?: unknown) => void;
  /** How agents run rooms-browser; named in briefings. */
  browserCommand?: string;
  /** How agents run rooms-board; named in briefings. */
  boardCommand?: string;
  /** Builds the room browser manager once the repos and change hub exist. */
  browsers?: (deps: { repos: Repos; notify: (roomId: string) => void }) => RoomBrowsers;
  /** Where T3's newest release is looked up (npm by default; tests pass their own). */
  latestRelease?: ReleaseLookup;
  /** Run the engine runtime (src/runtime) beside the old one; defaults to ROOMS_ENGINE=1. */
  engine?: boolean;
}): AppStack {
  const db = new Database(input.dbPath);
  const repos = new Repos(db);
  startSeen(repos);
  const hub = new ChangeHub();
  const notify = (roomId: string) => hub.notify(roomId);
  const service = new RoomService(db, repos, input.adapter, notify);
  const browsers = input.browsers ? input.browsers({ repos, notify }) : null;
  const presence = new T3Presence(input.adapter, input.log ? { log: input.log } : {});
  const scheduler = new Scheduler(
    db,
    repos,
    input.adapter,
    service,
    {
      briefingBudgetChars: input.briefingBudgetChars,
      ...(input.log ? { log: input.log } : {}),
      ...(browsers ? { browsers } : {}),
      ...(input.browserCommand ? { browserCommand: input.browserCommand } : {}),
      ...(input.boardCommand ? { boardCommand: input.boardCommand } : {}),
    },
    notify,
  );
  // ROOMS_ENGINE=1: the engine host over its own journal, data/board.sqlite next to rooms.sqlite. Off by default, so
  // a process without the flag never opens the journal and behaves as before.
  const engineStore = (input.engine ?? process.env.ROOMS_ENGINE === "1")
    ? new EngineStore(input.dbPath === ":memory:" ? ":memory:" : join(dirname(input.dbPath), "board.sqlite"))
    : null;
  const engine = engineStore
    ? new EngineHost({ store: engineStore, adapter: input.adapter, rooms: () => repos.listRooms().map((room) => room.id), notify, ...(input.log ? { log: input.log } : {}) })
    : null;
  engine?.start();
  return {
    db,
    repos,
    adapter: input.adapter,
    service,
    scheduler,
    hub,
    browsers,
    updates: new T3Updates(input.adapter, input.latestRelease),
    presence,
    engine,
    close() {
      engine?.close();
      engineStore?.close();
      scheduler.stop();
      presence.stop();
      browsers?.detach();
      db.close();
    },
  };
}
