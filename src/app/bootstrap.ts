/** Wires the persistence, service, engine host, and change-notification hub. Used by the server and by tests. */
import { dirname, join } from "node:path";
import type { T3Adapter, T3PullRequestChecks, T3ThreadShell } from "../adapter/types.ts";
import { Database } from "../db/database.ts";
import { Repos } from "../db/repos.ts";
import type { RoomBrowsers } from "../browser/roomBrowsers.ts";
import { EngineStore } from "../engine/index.ts";
import { EngineHost, KEEP_ALIVE_MS, bindingSource, nativeRequestMirror } from "../runtime/index.ts";
import type { EngineSeats } from "./engineSeats.ts";
import { engineMessages, messageImages } from "./engineMessages.ts";
import { keepAliveSetting } from "./keepAlive.ts";
import { AgentsFiles, type AgentsFilesOptions } from "./agentsFile.ts";
import { PageChanges, type PageChangesOptions } from "./changes.ts";
import { Packs, type PacksOptions } from "./packs.ts";
import { RoomService } from "./service.ts";
import { startSeen } from "./seen.ts";
import { LimitRecovery } from "./limitRecovery.ts";
import { storedLimitIntents } from "./limitIntent.ts";
import { T3Presence } from "./t3Presence.ts";
import { BackroomUpdate, busyMembers, type BackroomUpdateOptions } from "./backroomUpdate.ts";
import { T3Updates, type ReleaseLookup } from "./t3Updates.ts";
import { memberFacts, subagentRequests } from "./threadView.ts";
import { checksReader } from "./pullRequestWatch.ts";
import { memberState, type MemberState } from "../domain/memberState.ts";

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
  hub: ChangeHub;
  /** What open pages are told over GET /api/events: rooms changed, T3's shell changed, T3 reachable or not. */
  changes: PageChanges;
  /** Room browsers, when this service may start them (the server; not the tests). */
  browsers: RoomBrowsers | null;
  /** Backroom's, T3's and its harnesses' updates, started only when asked for. */
  updates: T3Updates;
  /** Backroom in place of T3's window: keeps T3 checking plan usage and harnesses while a page is open. */
  presence: T3Presence;
  /** Threads stopped on a usage limit, armed in T3 to continue at the reset (src/app/limitRecovery.ts); started by the server. */
  limitRecovery: LimitRecovery;
  /** The engine runtime: the host over the rooms' journal, data/board.sqlite. It dispatches to and imports from the members' threads. */
  engine: EngineHost;
  /** The seat lifecycle on the journal (seat, Consigliere, retire, reseat). */
  seats: EngineSeats;
  /** A member's state from its thread and its subagents' as T3 shows them now (src/domain/memberState.ts), as the page's label reads it; `ownRun`: a room run is on it. */
  memberState(threadId: string, ownRun: boolean): Promise<MemberState>;
  /** T3's checks read for a thread's watched pull requests, by watch task id: one cache for the page and the host. */
  watchedChecks(shell: Pick<T3ThreadShell, "projectId" | "pendingBackgroundTasks" | "pullRequests">): Promise<Map<string, T3PullRequestChecks | null>>;
  /** The skill packs (src/app/packs.ts), when this service keeps them; started by the server. */
  packs: Packs | null;
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
  /**
   * Backroom's own row (src/app/backroomUpdate.ts): this checkout, its origin's tags and its install.sh by default (tests
   * pass their own); the agents with a tab open in a room browser, named in its confirmation; and its stop once installed.
   */
  backroom?: Omit<BackroomUpdateOptions, "busy" | "log"> & { agentsWithTabs?: () => Promise<string[]> };
  /** Per-call limit on the T3 thread actions room deletion sends (src/app/service.ts THREAD_ACTION_TIMEOUT_MS). */
  threadActionTimeoutMs?: number;
  /** The engine's keep-alive interval where a room sets none (ROOMS_KEEPALIVE_MS; H6): 55 minutes by default, 0 for off. */
  keepAliveMs?: number;
  /**
   * Whether this Backroom may write the default agents file in a project's folder when a room is created there without
   * one (src/app/agentsFile.ts; the user's switch is Settings → Agents file). The server says yes; tests only when they
   * say so, so they write in no folder of the machine.
   */
  agentsFile?: boolean | Pick<AgentsFilesOptions, "onlyUnder">;
  /**
   * The skill packs (src/app/packs.ts): where the data folder and the skill folders' home are, and where pstack comes
   * from. The server gives it; tests only when they say so, with local repositories and a home of their own.
   */
  packs?: PacksOptions | null;
  /** How often the page-push source checks T3's shell and the journal's heads (tests make them short). */
  changes?: Pick<PageChangesOptions, "shellMs" | "headsMs" | "heartbeatMs">;
}): AppStack {
  const db = new Database(input.dbPath);
  const repos = new Repos(db);
  startSeen(repos);
  const hub = new ChangeHub();
  const notify = (roomId: string) => hub.notify(roomId);
  const packs = input.packs ? new Packs(repos, { ...input.packs, ...(input.log ? { log: input.log } : {}) }) : null;
  const service = new RoomService(db, repos, input.adapter, notify, {
    ...(input.threadActionTimeoutMs !== undefined ? { threadActionTimeoutMs: input.threadActionTimeoutMs } : {}),
    agentsFiles: input.agentsFile
      ? new AgentsFiles(repos, { ...(typeof input.agentsFile === "object" ? input.agentsFile : {}), ...(input.log ? { log: input.log } : {}), skills: () => packs?.agentsLines() ?? [] })
      : null,
    packs,
    ...(input.log ? { log: input.log } : {}),
  });
  const browsers = input.browsers ? input.browsers({ repos, notify }) : null;
  const presence = new T3Presence(input.adapter, input.log ? { log: input.log } : {});
  const limitRecovery = new LimitRecovery(input.adapter, { intents: storedLimitIntents(repos), ...(input.log ? { log: input.log } : {}) });
  // The rooms' journal, data/board.sqlite next to rooms.sqlite.
  const engineStore = new EngineStore(input.dbPath === ":memory:" ? ":memory:" : join(dirname(input.dbPath), "board.sqlite"));
  // Each tick, per seat: approvals and questions mirrored, then the seat lifecycle's part (thread title and settings, reseats).
  const mirror = nativeRequestMirror(repos, notify);
  const watchedChecks = checksReader(input.adapter.pullRequestChecks?.bind(input.adapter));
  // One briefing source: what the host renders and what `rooms-board rules` prints.
  const briefing = bindingSource(repos, {
    adapter: input.adapter,
    browsers,
    images: messageImages(repos),
    packs,
    ...(input.boardCommand ? { boardCommand: input.boardCommand } : {}),
    ...(input.browserCommand ? { browserCommand: input.browserCommand } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  const engine = new EngineHost({
    store: engineStore,
    adapter: input.adapter,
    rooms: () => repos.listRooms().map((room) => room.id),
    briefing,
    budgetChars: input.briefingBudgetChars,
    keepAlive: keepAliveSetting(repos, input.keepAliveMs ?? KEEP_ALIVE_MS),
    watchedChecks,
    watch: async (at, shell, detail, subagents) => {
      await mirror(at, shell, detail, subagents);
      await seats.watch(at, shell, detail);
    },
    notify,
    ...(input.log ? { log: input.log } : {}),
  });
  // Every announced room change, and every append to the journal (an unannounced one too), reaches open pages.
  // With the HTTP adapter T3's shell and reach come from its feed; the fake has no stream (its outages and edits are seen
  // only by reading it), so for it the pages' check stays.
  const changes = new PageChanges(input.adapter, {
    ...input.changes,
    heads: () => engine.heads(),
    ...(input.adapter.kind === "http" ? { feed: input.adapter } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  hub.subscribeAll((roomId) => changes.roomChanged(roomId));
  const seats: EngineSeats = service.useEngineSeats(engine, briefing, input.log);
  // Seat, reseat, retire and the Consigliere's mark go on the journal (L4b), through the service's handler hook.
  service.useEngine(seats.handler());
  seats.reconcile();
  // The user's messages, notes and controls go on the journal (L4a).
  service.useEngine(engineMessages({ repos, host: engine, adapter: input.adapter }));
  return {
    db,
    repos,
    adapter: input.adapter,
    service,
    hub,
    changes,
    browsers,
    updates: new T3Updates(
      input.adapter,
      new BackroomUpdate({
        ...input.backroom,
        busy: () => busyMembers(repos, (roomId) => engine.view(roomId), input.backroom?.agentsWithTabs ?? (async () => [])),
        ...(input.log ? { log: input.log } : {}),
      }),
      input.latestRelease,
    ),
    presence,
    limitRecovery,
    engine,
    seats,
    memberState: async (threadId, ownRun) => {
      const detail = await input.adapter.getThreadDetail(threadId, { bounded: true });
      const subagents = await subagentRequests(await input.adapter.listThreads(), threadId, (id) => input.adapter.getThreadDetail(id, { bounded: true }));
      return memberState(memberFacts(detail, ownRun, Date.now(), subagents ?? []));
    },
    watchedChecks,
    packs,
    close() {
      packs?.stop();
      changes.close();
      engine.close();
      engineStore.close();
      presence.stop();
      limitRecovery.stop();
      browsers?.detach();
      db.close();
    },
  };
}
