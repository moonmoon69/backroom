/**
 * RoomService: the single command handler shared by direct controls, explicit syntax,
 * and any later interpreter. Validates references and state and persists transactionally. What goes on a room's
 * journal (messages, requests, seats) is the engine's: its handlers take those commands (bootstrap.ts).
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { Repos } from "../db/repos.ts";
import type { T3Adapter, ThreadLifecycleAction } from "../adapter/types.ts";
import { T3CommandRejected, T3OutcomeUnknown, T3Unavailable } from "../adapter/types.ts";
import type { RoomCommand, WorkspaceChoice } from "../domain/commands.ts";
import { RoomError, notFound } from "../domain/errors.ts";
import { DirectThreads, isDirectCommand, type DirectResult } from "./direct.ts";
import { resolveWorkspace } from "./workspaceChoice.ts";
import { SecretRequestStale, answerSecret } from "./secretAnswer.ts";
import { controlThread, type ControlOutcome } from "./threadControl.ts";
import { requireOffered } from "./approvalChoice.ts";
import { AGENTS_FILE_SETTING_KEY, AGENTS_TEXT_KEY, type AgentsFileEntry, type AgentsFileWritten, type AgentsFiles } from "./agentsFile.ts";
import { POTETO_PIN_KEY, POTETO_SETTING_KEY, type PotetoPack, type PotetoState } from "./poteto.ts";
import { CONSIGLIERE_PRESET_KEY, CONSIGLIERE_RULES_KEY, RETIRE_THREAD_KEY, conversationTitle, startAttemptKey } from "./consigliere.ts";
import type { EngineReseat } from "./reseat.ts";
import { EngineSeats } from "./engineSeats.ts";
import type { EngineHost } from "../runtime/host.ts";
import type { BriefingSource } from "../runtime/render.ts";
import { effectiveBrowser, roomsMayUseBrowser, roomsUsingBrowser, withoutGoneBrowsers } from "../browser/catalog.ts";
import {
  POST_KINDS,
  type Browser,
  type Participant,
  type Preset,
  type Room,
  type RoomEvent,
  type Attachment,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_TYPES,
  type SessionBinding,
  type Speaker,
} from "../domain/types.ts";

export type CommandResult =
  /** agentsFile: Backroom wrote the default agents file in the project's folder just now (the page says so). */
  | { type: "room.created"; roomId: string; agentsFile?: AgentsFileWritten }
  | { type: "room.updated"; roomId: string }
  /** agentsFile.apply: the project's AGENTS.md now holds the saved template rendered for it. */
  | { type: "agentsFile.applied"; file: AgentsFileEntry }
  /** poteto.update, and poteto.pin.set while Poteto mode is on: what the clone holds now (an error in it when that failed). */
  | { type: "poteto.updated"; poteto: PotetoState }
  | { type: "rooms.reordered" }
  | { type: "projects.reordered" }
  | { type: "project.updated"; projectId: string }
  /**
   * timeout: the action was sent and T3 has not confirmed it, within the limit or before its connection went; it may
   * still apply it (the late outcome is logged).
   */
  | { type: "room.deleted"; roomId: string; threads: Array<{ participantId: string; alias: string; threadId: string; action: string; result: "done" | "kept" | "failed" | "timeout"; detail?: string }> }
  | { type: "preset.saved"; presetId: string }
  | { type: "preset.deleted"; presetId: string }
  | { type: "settings.updated" }
  | { type: "consigliere.started"; roomId: string; participantId: string }
  | { type: "participant.created"; participantId: string; threadId: string; alias: string }
  | {
      type: "participant.updated";
      participantId: string;
      /** After participant.retire: what happened to its T3 thread (kept when the choice was keep, it has no binding, or it is seated elsewhere). */
      thread?: { threadId: string; action: ThreadLifecycleAction | "keep"; result: "done" | "kept" | "failed" | "timeout"; detail?: string };
    }
  /** After participant.reseat: the checkpoint request the member was sent (src/app/engineSeats.ts). */
  | { type: "participant.reseating"; participantId: string; eventId: string }
  /** The engine's message path: one request per recipient per assignment, sharing the message's ID. */
  | { type: "requests.created"; messageId: string; requestIds: string[]; noteIds: string[] }
  | { type: "request.updated"; requestId: string; applied: boolean }
  | { type: "run.retried"; runId: string; eventId: string }
  | { type: "run.stopped"; participantId: string }
  | { type: "native.responded"; requestId: string }
  /** A control went to T3 ("sent"), or found the turn already continued ("already"). */
  | { type: "member.controlled"; participantId: string; outcome: ControlOutcome }
  | { type: "browser.created"; browserId: string }
  | { type: "browser.updated"; browserId: string }
  | { type: "browser.deleted"; browserId: string }
  | DirectResult;

export const now = (): string => new Date().toISOString();

/**
 * The engine's handlers take the commands that go on a room's journal: the first handler that returns a result has
 * taken the command (src/app/engineMessages.ts for the user's messages, src/app/engineSeats.ts for the seats).
 */
export type EngineHandler = (command: RoomCommand) => Promise<CommandResult> | null;

/** A member's thread is named after its room and alias, so T3's list and Backroom's agree. */
export const threadTitleFor = (room: Pick<Room, "title">, participant: Pick<Participant, "alias">): string => `${room.title} · ${participant.alias}`;

const PROJECT_ORDER_KEY = "sidebar.projectOrder";

/** T3's projects in the sidebar's order (project.reorder); ones never placed keep T3's order, after the placed ones. */
export function orderProjects<T extends { id: string }>(repos: Repos, projects: T[]): T[] {
  let order: string[] = [];
  try {
    order = JSON.parse(repos.getKv(PROJECT_ORDER_KEY) ?? "[]") as string[];
  } catch {
    order = [];
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => (rank.get(a.project.id) ?? order.length + a.index) - (rank.get(b.project.id) ?? order.length + b.index))
    .map(({ project }) => project);
}

/**
 * How long room deletion waits for T3 to answer each thread action (ROOMS_THREAD_ACTION_TIMEOUT_MS). Well under the
 * 60 s an HTTP adapter dispatch may itself wait (twice its 30 s request limit): the page answers within a few seconds,
 * and an action T3 answers later still goes through, its outcome logged. A limit of 60 s or more never fires.
 */
export const THREAD_ACTION_TIMEOUT_MS = 5000;

/**
 * How long creating a room waits for the agents file to be written (src/app/agentsFile.ts). Past it the room is
 * answered without saying what was written; the writing goes on.
 */
export const AGENTS_FILE_WAIT_MS = 5000;

export interface RoomServiceOptions {
  /** Per-call limit on the T3 thread actions room deletion sends (they run concurrently). */
  threadActionTimeoutMs?: number;
  /** Writes the default agents file when a room is created in a project without one (src/app/agentsFile.ts); null: never. */
  agentsFiles?: AgentsFiles | null;
  /** How long room creation waits for it (AGENTS_FILE_WAIT_MS). */
  agentsFileWaitMs?: number;
  /** Poteto mode's pstack clone (src/app/poteto.ts); null: this service keeps none. */
  poteto?: PotetoPack | null;
  log?: (message: string, detail?: unknown) => void;
}

export class RoomService {
  private readonly db: Database;
  private readonly repos: Repos;
  private readonly adapter: T3Adapter;
  private readonly notify: (roomId: string) => void;
  /** Projects and threads used outside any room. */
  private readonly direct: DirectThreads;
  private readonly engineHandlers: EngineHandler[] = [];
  private readonly threadActionTimeoutMs: number;
  readonly agentsFiles: AgentsFiles | null;
  private readonly agentsFileWaitMs: number;
  readonly poteto: PotetoPack | null;
  private readonly log: (message: string, detail?: unknown) => void;

  constructor(db: Database, repos: Repos, adapter: T3Adapter, notify: (roomId: string) => void = () => {}, options: RoomServiceOptions = {}) {
    this.db = db;
    this.repos = repos;
    this.adapter = adapter;
    this.notify = notify;
    this.direct = new DirectThreads(repos, adapter);
    const limit = options.threadActionTimeoutMs;
    // Node fires a timer longer than 2^31-1 ms (about 24.8 days) after 1 ms: a huge limit is held at that.
    this.threadActionTimeoutMs = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2 ** 31 - 1) : THREAD_ACTION_TIMEOUT_MS;
    this.agentsFiles = options.agentsFiles ?? null;
    this.agentsFileWaitMs = options.agentsFileWaitMs ?? AGENTS_FILE_WAIT_MS;
    this.poteto = options.poteto ?? null;
    this.log = options.log ?? (() => {});
  }

  /** The seat lifecycle on the room's journal (src/app/engineSeats.ts), wired by bootstrap.ts once the host exists. */
  private engineSeats: EngineSeats | null = null;

  private seats(): EngineSeats {
    if (!this.engineSeats) throw new RoomError("engine_missing", "the engine's seat lifecycle is not wired (bootstrap.ts)", 500);
    return this.engineSeats;
  }

  useEngineSeats(host: EngineHost, briefing: BriefingSource, log?: (message: string, detail?: unknown) => void): EngineSeats {
    this.engineSeats = new EngineSeats({
      repos: this.repos,
      adapter: this.adapter,
      host,
      briefing,
      notify: this.notify,
      transaction: (fn) => this.db.transaction(fn),
      seatFresh: (room, old, ids) => this.seatFresh(room, old, ids),
      mirror: (participant, shell) => this.syncParticipantFromThread(participant, shell),
      title: threadTitleFor,
      threadAction: (what, entry, action) => this.threadActionWithin(what, entry, action),
      ...(log ? { log } : {}),
    });
    return this.engineSeats;
  }

  // ---------- shared helpers ----------

  appendEvent(input: {
    roomId: string;
    kind: RoomEvent["kind"];
    speaker: Speaker;
    text: string;
    artifacts?: RoomEvent["artifacts"];
    attachmentIds?: string[];
    progress?: RoomEvent["progress"];
    prompt?: string | null;
    to?: string | null;
    outcome?: RoomEvent["outcome"];
    sourceRef?: RoomEvent["sourceRef"];
    createdAt?: string;
  }): RoomEvent {
    return this.db.transaction(() => {
      const sequence = this.repos.nextSequence(input.roomId);
      const event: RoomEvent = {
        id: randomUUID(),
        roomId: input.roomId,
        sequence,
        // Only posts take a number; inside this transaction nothing else can take the same one.
        postNumber: POST_KINDS.has(input.kind) ? this.repos.nextPostNumber(input.roomId) : null,
        kind: input.kind,
        speaker: input.speaker,
        text: input.text,
        artifacts: input.artifacts ?? [],
        attachmentIds: input.attachmentIds ?? [],
        progress: input.progress ?? [],
        prompt: input.prompt ?? null,
        to: input.to ?? null,
        outcome: input.outcome ?? null,
        sourceRef: input.sourceRef ?? null,
        createdAt: input.createdAt ?? now(),
      };
      this.repos.insertEvent(event);
      return event;
    });
  }

  // ---------- command entry point ----------

  /** The engine takes the commands this handler accepts (bootstrap.ts). */
  useEngine(handler: EngineHandler): void {
    this.engineHandlers.push(handler);
  }

  async execute(command: RoomCommand): Promise<CommandResult> {
    if (isDirectCommand(command)) return this.direct.execute(command);
    for (const handler of this.engineHandlers) {
      const taken = handler(command);
      if (taken) return taken;
    }
    switch (command.type) {
      case "room.create":
        return this.createRoom(command);
      case "room.update": {
        const room = this.requireRoom(command.roomId);
        this.db.transaction(() => {
          this.repos.updateRoomTitle(room.id, command.title.trim(), now());
          this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `Room renamed to "${command.title.trim()}"` });
        });
        this.notify(room.id);
        return { type: "room.updated", roomId: room.id };
      }
      case "room.browser":
        return this.setRoomBrowser(command);
      case "thread.browser":
        return this.setThreadBrowser(command);
      case "project.browser":
        return this.setProjectBrowser(command);
      case "browser.create":
        return this.createBrowser(command);
      case "browser.update":
        return this.updateBrowser(command);
      case "browser.delete":
        return this.deleteBrowser(command);
      case "room.reorder": {
        const known = new Set(this.repos.listRooms().map((r) => r.id));
        const unknown = command.roomIds.filter((id) => !known.has(id));
        if (unknown.length > 0) throw new RoomError("unknown_room", `unknown room ${unknown[0]}`);
        this.db.transaction(() => this.repos.setRoomOrder(command.roomIds));
        return { type: "rooms.reordered" };
      }
      case "project.reorder":
        this.repos.setKv(PROJECT_ORDER_KEY, JSON.stringify([...new Set(command.projectIds)]));
        return { type: "projects.reordered" };
      case "agentsFile.enabled.set":
        if (command.enabled) this.repos.deleteKv(AGENTS_FILE_SETTING_KEY);
        else this.repos.setKv(AGENTS_FILE_SETTING_KEY, "off");
        return { type: "settings.updated" };
      case "agentsFile.text.set":
        if (command.text === null) this.repos.deleteKv(AGENTS_TEXT_KEY);
        else this.repos.setKv(AGENTS_TEXT_KEY, command.text);
        return { type: "settings.updated" };
      case "agentsFile.apply": {
        if ((command.projectId === undefined) === (command.folder === undefined)) throw new RoomError("bad_request", "agentsFile.apply takes a projectId or a folder");
        if (!this.agentsFiles) throw new RoomError("agents_file_refused", "this service writes no agents files", 409);
        return { type: "agentsFile.applied", file: await this.agentsFiles.apply(command) };
      }
      case "poteto.enabled.set":
        if (command.enabled) {
          this.repos.deleteKv(POTETO_SETTING_KEY);
          // In the background, nothing waiting on it: the clone made if it is missing, else updated (a pin set while off
          // checked out, the fetch skipped while it was off made).
          void this.poteto?.update().catch(() => undefined);
        } else this.repos.setKv(POTETO_SETTING_KEY, "off");
        return { type: "settings.updated" };
      case "poteto.update":
        if (!this.poteto) throw new RoomError("poteto_refused", "this service keeps no pstack clone", 409);
        if (this.repos.getKv(POTETO_SETTING_KEY) === "off") throw new RoomError("poteto_refused", "Poteto mode is off: turn it on to update pstack", 409);
        return { type: "poteto.updated", poteto: await this.poteto.update() };
      case "poteto.pin.set":
        if (command.pin === null) this.repos.deleteKv(POTETO_PIN_KEY);
        else this.repos.setKv(POTETO_PIN_KEY, command.pin);
        // Moved to the pin (or back to origin's main) at once while on; off, the next update after it is turned on does.
        if (!this.poteto || this.repos.getKv(POTETO_SETTING_KEY) === "off") return { type: "settings.updated" };
        return { type: "poteto.updated", poteto: await this.poteto.update() };
      case "room.delete":
        return this.deleteRoom(command);
      case "participant.create":
        return this.createParticipant(command);
      case "participant.update":
        return this.updateParticipant(command);
      case "preset.create":
        return this.createPreset(command);
      case "preset.update":
        return this.updatePreset(command);
      case "preset.delete": {
        const removed = this.db.transaction(() => {
          // The Consigliere setting follows its saved crew member out; members already seated from it stay as they are.
          if (this.repos.getKv(CONSIGLIERE_PRESET_KEY) === command.presetId) this.repos.deleteKv(CONSIGLIERE_PRESET_KEY);
          return this.repos.deletePreset(command.presetId);
        });
        if (!removed) throw notFound("preset", command.presetId);
        return { type: "preset.deleted", presetId: command.presetId };
      }
      case "participant.fromPreset":
        return this.seatPreset(command);
      case "consigliere.preset.set": {
        if (command.presetId !== null && !this.repos.getPreset(command.presetId)) throw notFound("preset", command.presetId);
        if (command.presetId === null) this.repos.deleteKv(CONSIGLIERE_PRESET_KEY);
        else this.repos.setKv(CONSIGLIERE_PRESET_KEY, command.presetId);
        return { type: "settings.updated" };
      }
      case "consigliere.rules.set":
        if (command.rules === null) this.repos.deleteKv(CONSIGLIERE_RULES_KEY);
        else this.repos.setKv(CONSIGLIERE_RULES_KEY, command.rules);
        return { type: "settings.updated" };
      case "consigliere.retireThread.set":
        if (command.thread === "keep") this.repos.deleteKv(RETIRE_THREAD_KEY);
        else this.repos.setKv(RETIRE_THREAD_KEY, command.thread);
        return { type: "settings.updated" };
      case "consigliere.start":
        return this.startConversation(command);
      case "participant.model.set":
        return this.setParticipantModel(command);
      case "participant.runtimeMode.set":
        return this.setParticipantRuntimeMode(command);
      // The journal's commands: the engine's handlers above take them (bootstrap.ts registers both).
      case "message.create":
      case "request.cancel":
      case "request.correct":
      case "run.retry":
      case "run.stop":
      case "participant.retire":
      case "participant.reseat":
      case "room.consigliere.set":
        throw new RoomError("engine_missing", `${command.type} goes on the room's journal, and no engine handler took it`, 500);
      case "native.userInput.dismiss":
        return this.dismissUserInput(command);
      case "native.approval.respond":
        return this.respondApproval(command);
      case "native.userInput.respond":
        return this.respondUserInput(command);
      case "native.secret.respond":
        return this.respondSecret(command);
      case "member.control": {
        const participant = this.requireParticipant(command.participantId);
        if (participant.roomId !== command.roomId) throw notFound("participant", command.participantId);
        const binding = this.repos.currentBinding(participant.id);
        if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
        // A member's Stop everything goes on the room's journal (run.stop), so nothing more goes into the turn it stops.
        if (command.control.type === "stop.all") throw new RoomError("bad_request", "A member's Stop everything is run.stop with everything set.", 400);
        const outcome = await controlThread(this.adapter, binding.threadId, command.control);
        this.notify(participant.roomId);
        return { type: "member.controlled", participantId: participant.id, outcome };
      }
    }
  }

  // ---------- rooms & participants ----------

  /**
   * Delete a room. Its stored data is removed in one transaction first; then the T3 thread actions (settle/archive/
   * delete as chosen per participant; a thread also bound in another room, or a retired member's, is left as it is) are
   * all sent at once, and the answer waits at most the per-call limit. A failed action leaves that thread as it was; an
   * action T3 has not answered by then is reported as a timeout, and its late outcome is logged.
   */
  private async deleteRoom(command: Extract<RoomCommand, { type: "room.delete" }>): Promise<CommandResult> {
    type ThreadResult = Extract<CommandResult, { type: "room.deleted" }>["threads"][number];
    const room = this.requireRoom(command.roomId);
    const results: Array<ThreadResult | (() => Promise<ThreadResult>)> = [];
    for (const participant of this.repos.listParticipants(room.id)) {
      const binding = this.repos.currentBinding(participant.id);
      if (!binding) continue;
      const action = command.threads[participant.id] ?? "keep";
      const elsewhere = this.repos
        .listActiveBindings()
        .some((b) => b.threadId === binding.threadId && this.repos.getParticipant(b.participantId)?.roomId !== room.id);
      const entry = { participantId: participant.id, alias: participant.alias, threadId: binding.threadId, action };
      if (action === "keep" || participant.retiredAt || elsewhere) {
        results.push({ ...entry, result: "kept", ...(elsewhere && action !== "keep" ? { detail: "also used in another room" } : {}) });
        continue;
      }
      results.push(() => this.threadActionWithin(`room "${room.title}" deleted`, entry, action));
    }
    this.db.transaction(() => this.repos.deleteRoomCascade(room.id));
    this.notify(room.id);
    // Sent only once the room is gone: a delete that fails changes no thread, and a second delete finds no room.
    return { type: "room.deleted", roomId: room.id, threads: await Promise.all(results.map((result) => (typeof result === "function" ? result() : result))) };
  }

  /**
   * Sends one thread action now and answers within the limit: done, failed, or timeout. Timeout also when T3 was sent the
   * action and never answered it (T3OutcomeUnknown: the adapter's own limit, or the connection went): T3 may have
   * applied it, so it is not reported as failed. The late outcome is logged under `what` (room deletion, a member's
   * removal or reseat). EngineSeats gets it as a dependency.
   */
  private threadActionWithin<T extends { alias: string; threadId: string }>(
    what: string,
    entry: T,
    action: ThreadLifecycleAction,
  ): Promise<T & { result: "done" | "failed" | "timeout"; detail?: string }> {
    const limit = this.threadActionTimeoutMs;
    const sent = (async () => this.adapter.setThreadLifecycle({ commandId: randomUUID(), threadId: entry.threadId, action }))();
    return new Promise((resolve) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        resolve({ ...entry, result: "timeout", detail: `T3 had not answered after ${limit / 1000} s; the ${action} may still go through` });
      }, limit);
      sent.then(
        () => {
          clearTimeout(timer);
          if (late) this.log(`${what}: @${entry.alias}'s thread ${entry.threadId} ${action} finished late in T3`);
          else resolve({ ...entry, result: "done" });
        },
        (error: unknown) => {
          clearTimeout(timer);
          const detail = error instanceof Error ? error.message : String(error);
          if (error instanceof T3OutcomeUnknown) {
            if (late) this.log(`${what}: @${entry.alias}'s thread ${entry.threadId} ${action}: T3 never answered; outcome unknown, it may have been applied`, detail);
            else resolve({ ...entry, result: "timeout", detail: `T3 did not answer (${detail}); the ${action} may still go through` });
          } else if (late) this.log(`${what}: @${entry.alias}'s thread ${entry.threadId} ${action} failed late in T3`, detail);
          else resolve({ ...entry, result: "failed", detail });
        },
      );
    });
  }

  private async createRoom(command: Extract<RoomCommand, { type: "room.create" }>): Promise<CommandResult> {
    let environmentId: string | null = null;
    let project: { id: string; workspaceRoot: string } | null = null;
    // T3's other projects: an agents file is never written in a folder that holds one of them (src/app/agentsFile.ts).
    let others: Array<{ workspaceRoot: string }> = [];
    try {
      const projects = await this.adapter.listProjects();
      project = projects.find((candidate) => candidate.id === command.projectId) ?? null;
      others = projects.filter((candidate) => candidate.id !== command.projectId);
      if (!project) {
        throw new RoomError("unknown_project", `T3 project ${command.projectId} was not found on the connected server`);
      }
      environmentId = (await this.adapter.describe()).environmentId;
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw error;
    }
    const browsers = this.newRoomBrowsers(command.projectId);
    const room: Room = {
      id: randomUUID(),
      projectId: command.projectId,
      environmentId,
      title: command.title,
      nextSequence: 1,
      ...browsers,
      consigliereId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.transaction(() => this.repos.insertRoom(room));
    this.notify(room.id);
    // Before anyone is seated: a member seated in the project folder reads it from its first turn. A failure here is
    // logged and never fails the room, and the room waits for it a few seconds at most.
    let agentsFile: AgentsFileWritten | null = null;
    if (this.agentsFiles) {
      const writing = this.agentsFiles.roomCreated(project, others).catch((error: unknown) => {
        this.log(`the agents file for project ${project.id}`, error instanceof Error ? error.message : String(error));
        return null;
      });
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), this.agentsFileWaitMs);
      });
      agentsFile = await Promise.race([writing, limit]);
      clearTimeout(timer);
    }
    // A room opens with the Consigliere seated, when one is chosen in Settings: he is the one you talk to in it.
    if (command.consigliere) await this.seatConsigliere(room);
    return { type: "room.created", roomId: room.id, ...(agentsFile ? { agentsFile } : {}) };
  }

  // ---------- browsers ----------

  /** The browser a room's agents use by default: its own choice when that still exists, else "general" (when it exists). */
  effectiveBrowser(room: Room): Browser | null {
    return effectiveBrowser(this.repos, room);
  }

  roomsUsingBrowser(browserId: string): Room[] {
    return roomsUsingBrowser(this.repos, browserId);
  }

  private requireBrowser(browserId: string): Browser {
    const browser = this.repos.getBrowser(browserId);
    if (!browser) throw notFound("browser", browserId);
    return browser;
  }

  private assertBrowserNameFree(name: string, exceptId: string | null): void {
    const existing = this.repos.getBrowserByName(name);
    if (existing && existing.id !== exceptId) throw new RoomError("browser_name_taken", `a browser named "${name}" already exists`, 409);
  }

  /**
   * The default and the list a room.browser or thread.browser command leaves: omitted keeps the current one, null
   * falls back ("general" for the default, every browser for the list). The default must be one the list allows.
   */
  private browserChoice(
    current: Pick<Room, "defaultBrowserId" | "allowedBrowserIds">,
    command: { browserId?: string | null | undefined; allowed?: string[] | null | undefined },
    subject: string,
  ): { defaultBrowserId: string | null; allowed: string[] | null } {
    const defaultBrowserId = command.browserId === undefined ? current.defaultBrowserId : command.browserId;
    const allowed = command.allowed === undefined ? current.allowedBrowserIds : command.allowed === null ? null : [...new Set(command.allowed)];
    if (defaultBrowserId) this.requireBrowser(defaultBrowserId);
    for (const id of allowed ?? []) this.requireBrowser(id);
    if (allowed && defaultBrowserId && !allowed.includes(defaultBrowserId)) {
      throw new RoomError("default_not_allowed", `the ${subject}'s default browser must be one of the browsers it may use`);
    }
    return { defaultBrowserId, allowed };
  }

  private async setRoomBrowser(command: Extract<RoomCommand, { type: "room.browser" }>): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    const { defaultBrowserId, allowed } = this.browserChoice(room, command, "room");
    const sameList = JSON.stringify(allowed) === JSON.stringify(room.allowedBrowserIds);
    if (room.browserEnabled === command.enabled && room.defaultBrowserId === defaultBrowserId && sameList) return { type: "room.updated", roomId: room.id };
    const next = { ...room, defaultBrowserId, allowedBrowserIds: allowed };
    const browser = this.effectiveBrowser(next);
    // The default the room actually uses: dropping "general" from the list moves it even while no default is set.
    const defaultMoved = this.effectiveBrowser(room)?.id !== browser?.id;
    const names = (ids: string[]) => ids.map((id) => this.repos.getBrowser(id)?.name ?? id).join(", ");
    const text = !command.enabled
      ? "Browsers turned off for this room"
      : !room.browserEnabled
        ? `Browsers turned on: this room's agents get "${browser?.name ?? "a browser"}" by default`
        : !sameList
          ? `${allowed ? `This room may use these browsers: ${names(allowed)}` : "This room may use every browser"}${defaultMoved ? `; its default is now "${browser?.name ?? "none"}"` : ""}`
          : `Default browser set to "${browser?.name ?? "none"}"`;
    this.db.transaction(() => {
      this.repos.setRoomBrowser(room.id, command.enabled, defaultBrowserId, now(), allowed);
      this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text });
    });
    this.notify(room.id);
    return { type: "room.updated", roomId: room.id };
  }

  /**
   * What a new room in the project starts with: a copy of the project's setting, without any browser it names that is
   * gone; browsers off, no default and every browser without one.
   */
  private newRoomBrowsers(projectId: string): Pick<Room, "browserEnabled" | "defaultBrowserId" | "allowedBrowserIds"> {
    const record = this.repos.getProjectBrowsers(projectId);
    if (!record) return { browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null };
    const { browserEnabled, defaultBrowserId, allowedBrowserIds } = withoutGoneBrowsers(record, (id) => this.repos.getBrowser(id) !== null);
    return { browserEnabled, defaultBrowserId, allowedBrowserIds };
  }

  /** A project's setting for its new rooms, with a room's rules; null removes it. Rooms that exist keep theirs. */
  private async setProjectBrowser(command: Extract<RoomCommand, { type: "project.browser" }>): Promise<CommandResult> {
    if (command.enabled === null) {
      this.db.transaction(() => this.repos.deleteProjectBrowsers(command.projectId));
      return { type: "project.updated", projectId: command.projectId };
    }
    try {
      if (!(await this.adapter.listProjects()).some((project) => project.id === command.projectId)) {
        throw new RoomError("unknown_project", `T3 project ${command.projectId} was not found on the connected server`);
      }
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw error;
    }
    const current = this.repos.getProjectBrowsers(command.projectId) ?? { projectId: command.projectId, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, updatedAt: now() };
    const { defaultBrowserId, allowed } = this.browserChoice(current, command, "project");
    this.db.transaction(() => this.repos.setProjectBrowsers({ ...current, browserEnabled: command.enabled as boolean, defaultBrowserId, allowedBrowserIds: allowed, updatedAt: now() }));
    return { type: "project.updated", projectId: command.projectId };
  }

  /** A thread outside rooms gets browsers as a room does; a thread without a record has them off. */
  private async setThreadBrowser(command: Extract<RoomCommand, { type: "thread.browser" }>): Promise<CommandResult> {
    const current = this.repos.getThreadBrowsers(command.threadId) ?? { threadId: command.threadId, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, updatedAt: now() };
    const { defaultBrowserId, allowed } = this.browserChoice(current, command, "thread");
    this.db.transaction(() => this.repos.setThreadBrowsers({ ...current, browserEnabled: command.enabled, defaultBrowserId, allowedBrowserIds: allowed, updatedAt: now() }));
    return { type: "thread.updated", threadId: command.threadId };
  }

  private async createBrowser(command: Extract<RoomCommand, { type: "browser.create" }>): Promise<CommandResult> {
    this.assertBrowserNameFree(command.name, null);
    const browser: Browser = { id: randomUUID(), name: command.name, description: command.description, createdAt: now(), updatedAt: now() };
    this.db.transaction(() => this.repos.insertBrowser(browser));
    return { type: "browser.created", browserId: browser.id };
  }

  private async updateBrowser(command: Extract<RoomCommand, { type: "browser.update" }>): Promise<CommandResult> {
    const browser = this.requireBrowser(command.browserId);
    if (command.name !== undefined) this.assertBrowserNameFree(command.name, browser.id);
    this.db.transaction(() =>
      this.repos.updateBrowser({ ...browser, name: command.name ?? browser.name, description: command.description ?? browser.description, updatedAt: now() }),
    );
    // A rename or a new description shows in every room that may use the browser, not only where it is the default.
    for (const room of roomsMayUseBrowser(this.repos, browser.id)) this.notify(room.id);
    return { type: "browser.updated", browserId: browser.id };
  }

  /** Deletes the record; the caller stops the process and removes the profile directory. */
  private async deleteBrowser(command: Extract<RoomCommand, { type: "browser.delete" }>): Promise<CommandResult> {
    const browser = this.requireBrowser(command.browserId);
    const users = this.roomsUsingBrowser(browser.id);
    if (users.length > 0) {
      throw new RoomError("browser_in_use", `"${browser.name}" is the default browser of ${users.map((r) => `"${r.title}"`).join(", ")}; pick another default there first`, 409);
    }
    this.db.transaction(() => {
      // A room or a project pointing at it falls back to "general"; one whose allowed list had only this browser has
      // browsers off (src/browser/catalog.ts).
      const names = (choice: Pick<Room, "defaultBrowserId" | "allowedBrowserIds">) => choice.defaultBrowserId === browser.id || (choice.allowedBrowserIds?.includes(browser.id) ?? false);
      const exists = (id: string) => id !== browser.id;
      for (const room of this.repos.listRooms()) {
        if (!names(room)) continue;
        const next = withoutGoneBrowsers(room, exists);
        this.repos.setRoomBrowser(room.id, next.browserEnabled, next.defaultBrowserId, now(), next.allowedBrowserIds);
      }
      for (const record of this.repos.listProjectBrowsers()) {
        if (names(record)) this.repos.setProjectBrowsers({ ...withoutGoneBrowsers(record, exists), updatedAt: now() });
      }
      this.repos.deleteBrowser(browser.id);
    });
    return { type: "browser.deleted", browserId: browser.id };
  }

  private requireRoom(roomId: string): Room {
    const room = this.repos.getRoom(roomId);
    if (!room) throw notFound("room", roomId);
    return room;
  }

  private requireParticipant(participantId: string): Participant {
    const participant = this.repos.getParticipant(participantId);
    if (!participant) throw notFound("participant", participantId);
    if (participant.retiredAt) throw new RoomError("participant_retired", `@${participant.alias} was removed from the room`, 409);
    return participant;
  }

  private assertAliasFree(roomId: string, alias: string, exceptId: string | null): void {
    const key = alias.toLowerCase();
    for (const participant of this.repos.listActiveParticipants(roomId)) {
      if (participant.id === exceptId) continue;
      if (participant.alias.toLowerCase() === key) {
        throw new RoomError("alias_taken", `alias "${alias}" is already used in this room`, 409);
      }
    }
  }

  private async bindThread(
    room: Room,
    participant: Pick<Participant, "alias" | "modelSelection" | "runtimeMode" | "interactionMode">,
    thread: { mode: "create"; workspace?: WorkspaceChoice | undefined } | { mode: "attach"; threadId: string },
    /** Ids chosen ahead for a new thread, so an attempt that is retried asks T3 for the same thread again. */
    ids?: { threadId: string; commandId: string },
  ): Promise<{ threadId: string; runtimeMode: Participant["runtimeMode"]; modelSelection: Participant["modelSelection"]; interactionMode: Participant["interactionMode"] }> {
    try {
      if (thread.mode === "attach") {
        const shell = await this.adapter.getThreadShell(thread.threadId);
        if (!shell) throw new RoomError("unknown_thread", `T3 thread ${thread.threadId} was not found`);
        if (shell.projectId !== room.projectId) {
          throw new RoomError("thread_project_mismatch", `thread ${thread.threadId} belongs to a different T3 project`);
        }
        const inUse = this.repos.listActiveBindings().find((binding) => binding.threadId === thread.threadId);
        if (inUse) throw new RoomError("thread_in_use", `thread ${thread.threadId} is already bound to another member`, 409);
        // An attached thread keeps what T3 has for it: model, options, permission mode, interaction mode.
        return { threadId: shell.id, runtimeMode: shell.runtimeMode, modelSelection: shell.modelSelection, interactionMode: shell.interactionMode };
      }
      const threadId = ids?.threadId ?? randomUUID();
      const commandId = ids?.commandId ?? randomUUID();
      // T3 makes the thread with its folder (a new worktree is checked out now), so the agent starts in it.
      const workspace = await resolveWorkspace(this.adapter, room.projectId, thread.workspace, { roomTitle: room.title, alias: participant.alias });
      this.repos.logCommand(commandId, "thread.create", threadId, "pending", null);
      await this.adapter.launchThread({
        commandId,
        threadId,
        projectId: room.projectId,
        title: threadTitleFor(room, participant),
        modelSelection: participant.modelSelection,
        runtimeMode: participant.runtimeMode,
        interactionMode: participant.interactionMode,
        workspace,
      });
      this.repos.logCommand(commandId, "thread.create", threadId, "accepted", null);
      return { threadId, runtimeMode: participant.runtimeMode, modelSelection: participant.modelSelection, interactionMode: participant.interactionMode };
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
  }

  private async createParticipant(command: Extract<RoomCommand, { type: "participant.create" }>): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    let modelSelection = command.modelSelection ?? null;
    if (command.thread.mode === "create" && !modelSelection) {
      try {
        modelSelection = await this.adapter.defaultModelSelection(room.projectId);
      } catch (error) {
        if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
        throw error;
      }
      if (!modelSelection) throw new RoomError("no_default_model", "T3 has no default model for this project; choose a model explicitly");
    }
    return this.seatParticipant(
      command.roomId,
      {
        alias: command.alias,
        // Placeholder for attach; bindThread replaces it with the thread's own selection.
        modelSelection: modelSelection ?? { instanceId: "inherited", model: "inherited" },
        runtimeMode: command.runtimeMode ?? "full-access",
        interactionMode: command.interactionMode,
      },
      command.thread,
    );
  }

  /** Change the bound thread's model or options through T3. The provider stays: a thread belongs to one harness. */
  private async setParticipantModel(command: Extract<RoomCommand, { type: "participant.model.set" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    if (command.modelSelection.instanceId !== participant.modelSelection.instanceId) {
      throw new RoomError(
        "provider_fixed",
        `@${participant.alias}'s thread runs on ${participant.modelSelection.instanceId}; a thread cannot switch provider. Seat a member on a new thread of that provider instead.`,
        409,
      );
    }
    const commandId = randomUUID();
    try {
      await this.adapter.setThreadModel({ commandId, threadId: binding.threadId, modelSelection: command.modelSelection });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    // Mirror immediately; the seat lifecycle's watch keeps it in sync with T3 afterwards (src/app/engineSeats.ts).
    this.db.transaction(() => this.repos.updateParticipant({ ...participant, modelSelection: command.modelSelection, updatedAt: now() }));
    this.appendEvent({ roomId: participant.roomId, kind: "system", speaker: { type: "system" }, text: `@${participant.alias} model set to ${command.modelSelection.model} in T3` });
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id };
  }

  /** Keep the participant's mirror of the thread configuration equal to what T3 reports. Used by the seat lifecycle's watch. */
  syncParticipantFromThread(participant: Participant, shell: { modelSelection: Participant["modelSelection"]; runtimeMode: Participant["runtimeMode"]; interactionMode: Participant["interactionMode"] }): boolean {
    const same =
      JSON.stringify(participant.modelSelection) === JSON.stringify(shell.modelSelection) &&
      participant.runtimeMode === shell.runtimeMode &&
      participant.interactionMode === shell.interactionMode;
    if (same) return false;
    this.db.transaction(() =>
      this.repos.updateParticipant({ ...participant, modelSelection: shell.modelSelection, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, updatedAt: now() }),
    );
    return true;
  }

  /**
   * The crew member a seat is, when it was not seated from one: the preset whose name is its alias, or its alias with a
   * number after it (sol, sol2), on the same harness. The same rule matched the members seated before seats recorded it.
   */
  private matchPreset(alias: string, modelSelection: Participant["modelSelection"]): string | null {
    const preset = this.repos.findPresetByName(alias.replace(/\d+$/, ""));
    return preset && preset.modelSelection.instanceId === modelSelection.instanceId ? preset.id : null;
  }

  private async seatParticipant(
    roomId: string,
    spec: Pick<Participant, "alias" | "modelSelection" | "runtimeMode" | "interactionMode"> & { presetId?: string; seatBriefing?: boolean },
    thread: { mode: "create"; workspace?: WorkspaceChoice | undefined } | { mode: "attach"; threadId: string },
    ids?: { participantId: string; threadId: string; commandId: string },
  ): Promise<CommandResult> {
    const room = this.requireRoom(roomId);
    this.assertAliasFree(room.id, spec.alias, null);
    if (thread.mode === "attach") this.seats().refuseSeatedThread(room.id, thread.threadId);
    const bound = await this.bindThread(room, spec, thread, ids);
    const participant: Participant = {
      id: ids?.participantId ?? randomUUID(),
      roomId: room.id,
      alias: spec.alias,
      modelSelection: bound.modelSelection,
      runtimeMode: bound.runtimeMode,
      interactionMode: bound.interactionMode,
      bindingGeneration: 1,
      retiredAt: null,
      presetId: spec.presetId ?? this.matchPreset(spec.alias, bound.modelSelection),
      createdAt: now(),
      updatedAt: now(),
    };
    const command = { thread };
    const binding: SessionBinding = {
      id: randomUUID(),
      participantId: participant.id,
      generation: 1,
      threadId: bound.threadId,
      deliveredCursor: 0,
      bootstrapDeliveredAt: null,
      createdAt: now(),
      retiredAt: null,
    };
    this.db.transaction(() => {
      this.repos.insertParticipant(participant);
      this.repos.insertBinding(binding);
    });
    this.appendEvent({
      roomId: room.id,
      kind: "system",
      speaker: { type: "system" },
      text: `@${participant.alias} joined (${participant.modelSelection.model}, ${command.thread.mode === "create" ? "new thread" : "attached thread"})`,
    });
    // The seat on the room's journal; in a room that has a Consigliere it is told the standing facts first.
    this.seats().seated(room, participant, binding, { briefing: spec.seatBriefing !== false });
    this.notify(room.id);
    return { type: "participant.created", participantId: participant.id, threadId: bound.threadId, alias: participant.alias };
  }

  private async updateParticipant(command: Extract<RoomCommand, { type: "participant.update" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    if (command.alias !== undefined) this.assertAliasFree(participant.roomId, command.alias, participant.id);
    const updated: Participant = { ...participant, alias: command.alias ?? participant.alias, updatedAt: now() };
    this.db.transaction(() => this.repos.updateParticipant(updated));
    if (participant.alias !== updated.alias) {
      this.appendEvent({ roomId: participant.roomId, kind: "system", speaker: { type: "system" }, text: `@${participant.alias} renamed to @${updated.alias}` });
    }
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id };
  }

  // ---------- presets (participant settings under a name) ----------

  private assertPresetNameFree(name: string, exceptId: string | null): void {
    const existing = this.repos.findPresetByName(name);
    if (existing && existing.id !== exceptId) throw new RoomError("preset_name_taken", `a preset named "${name}" already exists`, 409);
  }

  private async createPreset(command: Extract<RoomCommand, { type: "preset.create" }>): Promise<CommandResult> {
    this.assertPresetNameFree(command.name, null);
    const preset: Preset = {
      id: randomUUID(),
      name: command.name,
      modelSelection: command.modelSelection,
      runtimeMode: command.runtimeMode,
      workspaceMode: command.workspaceMode,
      look: {},
      goodAt: command.goodAt,
      avoid: command.avoid,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.transaction(() => this.repos.upsertPreset(preset, command.look));
    return { type: "preset.saved", presetId: preset.id };
  }

  private async updatePreset(command: Extract<RoomCommand, { type: "preset.update" }>): Promise<CommandResult> {
    const preset = this.repos.getPreset(command.presetId);
    if (!preset) throw notFound("preset", command.presetId);
    if (command.name) this.assertPresetNameFree(command.name, preset.id);
    const updated: Preset = {
      ...preset,
      name: command.name ?? preset.name,
      modelSelection: command.modelSelection ?? preset.modelSelection,
      runtimeMode: command.runtimeMode ?? preset.runtimeMode,
      workspaceMode: command.workspaceMode ?? preset.workspaceMode,
      goodAt: command.goodAt ?? preset.goodAt,
      avoid: command.avoid ?? preset.avoid,
      updatedAt: now(),
    };
    this.db.transaction(() => this.repos.upsertPreset(updated, command.look));
    return { type: "preset.saved", presetId: preset.id };
  }

  /** The preset's name, or the first of name2, name3, … that no active participant of the room has. */
  private freeAlias(roomId: string, name: string): string {
    const taken = new Set(this.repos.listParticipants(roomId).filter((p) => !p.retiredAt).map((p) => p.alias.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 1000; n += 1) {
      const suffix = String(n);
      const alias = `${name.slice(0, 32 - suffix.length)}${suffix}`;
      if (!taken.has(alias.toLowerCase())) return alias;
    }
    throw new RoomError("alias_taken", `every alias from ${name} is taken in this room`, 409);
  }

  /** A new worktree for a preset starts from the project's default branch (else the one checked out, else the first). */
  private async presetWorkspace(projectId: string, preset: Preset): Promise<WorkspaceChoice | undefined> {
    if (preset.workspaceMode !== "worktree") return undefined;
    try {
      const project = (await this.adapter.listProjects()).find((p) => p.id === projectId);
      if (!project) throw new RoomError("unknown_project", `T3 project ${projectId} was not found`);
      const { isRepo, refs } = await this.adapter.listRefs(project.workspaceRoot);
      const local = refs.filter((r) => !r.isRemote);
      const base = local.find((r) => r.isDefault) ?? local.find((r) => r.current) ?? local[0];
      // A folder that is not a repository has no worktrees: the preset works in the project folder there.
      if (!isRepo || !base) return undefined;
      return { mode: "worktree", baseBranch: base.name };
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw error;
    }
  }

  private async seatPreset(command: Extract<RoomCommand, { type: "participant.fromPreset" }>, ids?: { participantId: string; threadId: string; commandId: string }): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    const preset = this.repos.getPreset(command.presetId);
    if (!preset) throw notFound("preset", command.presetId);
    const workspace = await this.presetWorkspace(room.projectId, preset);
    return this.seatParticipant(
      room.id,
      {
        alias: command.alias ?? this.freeAlias(room.id, preset.name),
        modelSelection: preset.modelSelection,
        runtimeMode: preset.runtimeMode,
        interactionMode: "default",
        presetId: preset.id,
      },
      { mode: "create", ...(workspace ? { workspace } : {}) },
      ids,
    );
  }

  // ---------- the Consigliere ----------

  /** Designate a member as the room's Consigliere, move the mark, or clear it: on the journal (src/app/engineSeats.ts). */
  private setConsigliere(command: Extract<RoomCommand, { type: "room.consigliere.set" }>): Promise<CommandResult> {
    return this.seats().designate(command);
  }

  /**
   * Seat the Consigliere chosen in Settings in a new room and designate him. Nothing happens without a choice. When T3
   * cannot seat him the room stays, with a note saying so, and Members can seat him later.
   */
  private async seatConsigliere(room: Room): Promise<void> {
    const presetId = this.repos.getKv(CONSIGLIERE_PRESET_KEY);
    const preset = presetId ? this.repos.getPreset(presetId) : null;
    if (!preset) return;
    try {
      const seated = (await this.seatPreset({ type: "participant.fromPreset", roomId: room.id, presetId: preset.id })) as { participantId: string };
      await this.setConsigliere({ type: "room.consigliere.set", roomId: room.id, participantId: seated.participantId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `${preset.name} could not be seated as the Consigliere: ${reason}. Seat him from Members and make him the Consigliere.` });
      this.notify(room.id);
    }
  }

  /**
   * Start a conversation with the Consigliere: a room in the project, the saved crew member the setting names seated
   * and designated, and the user's message delivered to him. What the attempt intends (the room, the member, the
   * thread and its T3 command) is written down before T3 is called, so the same request sent again, after an error or
   * a restart, carries on with them and makes nothing twice.
   */
  private async startConversation(command: Extract<RoomCommand, { type: "consigliere.start" }>): Promise<CommandResult> {
    const key = startAttemptKey(command.requestId);
    type Attempt = { roomId: string; participantId: string; threadId: string; threadCommandId: string; seated: boolean; delivered: boolean };
    let attempt = JSON.parse(this.repos.getKv(key) ?? "null") as Attempt | null;
    const save = (next: Attempt) => {
      attempt = next;
      this.repos.setKv(key, JSON.stringify(next));
    };
    if (attempt?.delivered) return { type: "consigliere.started", roomId: attempt.roomId, participantId: attempt.participantId };
    const presetId = this.repos.getKv(CONSIGLIERE_PRESET_KEY);
    const preset = presetId ? this.repos.getPreset(presetId) : null;
    if (!preset) throw new RoomError("no_consigliere", "No Consigliere is chosen: pick one of your saved crew in Settings first", 409);
    if (!attempt) {
      const created = (await this.createRoom({ type: "room.create", projectId: command.projectId, title: conversationTitle(command.text), consigliere: false })) as { roomId: string };
      save({ roomId: created.roomId, participantId: randomUUID(), threadId: randomUUID(), threadCommandId: randomUUID(), seated: false, delivered: false });
    }
    let current = attempt as unknown as Attempt;
    if (!current.seated) {
      // The member may be seated already: the attempt stopped after seating him and before saying so.
      if (!this.repos.getParticipant(current.participantId)) {
        await this.seatPreset({ type: "participant.fromPreset", roomId: current.roomId, presetId: preset.id }, { participantId: current.participantId, threadId: current.threadId, commandId: current.threadCommandId });
      }
      save({ ...current, seated: true });
      current = { ...current, seated: true };
    }
    await this.setConsigliere({ type: "room.consigliere.set", roomId: current.roomId, participantId: current.participantId });
    // The message goes the composer's way, through execute: his request on the board, under the attempt's ID as the
    // message's client ID, so the engine records it once however often it is sent.
    await this.execute({
      type: "message.create",
      roomId: current.roomId,
      sourceText: command.text,
      preamble: "",
      clientMessageId: command.requestId,
      attachmentIds: [],
      assignments: [{ recipients: [current.participantId], instruction: command.text.trim(), slashCommand: false }],
    });
    save({ ...current, delivered: true });
    return { type: "consigliere.started", roomId: current.roomId, participantId: current.participantId };
  }

  private async setParticipantRuntimeMode(command: Extract<RoomCommand, { type: "participant.runtimeMode.set" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const commandId = randomUUID();
    try {
      await this.adapter.setRuntimeMode({ commandId, threadId: binding.threadId, runtimeMode: command.runtimeMode });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    this.db.transaction(() => this.repos.updateParticipant({ ...participant, runtimeMode: command.runtimeMode, updatedAt: now() }));
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id };
  }

  /**
   * The fresh seat: the same saved crew member (or, for a seat made without one, the same settings), in the old seat's
   * folder: its worktree, or the project folder. The checkpoint and the work handed over assume that folder, so when T3
   * cannot say where the old seat worked the reseat is called off rather than seated elsewhere; T3 being away is retried.
   */
  private async seatFresh(room: Room, old: Participant, ids: EngineReseat["fresh"]): Promise<void> {
    const preset = old.presetId ? this.repos.getPreset(old.presetId) : null;
    const binding = this.repos.currentBinding(old.id);
    const shell = await (binding ? this.adapter.getThreadShell(binding.threadId) : Promise.resolve(null)).catch((error: unknown) => {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw new RoomError("workspace_unknown", `where @${old.alias} worked could not be read (${(error as Error).message})`, 409);
    });
    if (!shell) throw new RoomError("workspace_unknown", `T3 no longer has @${old.alias}'s thread, so where it worked is unknown`, 409);
    const workspace: WorkspaceChoice = shell.worktreePath ? { mode: "existing", worktreePath: shell.worktreePath } : { mode: "local" };
    await this.seatParticipant(
      room.id,
      {
        alias: this.freeAlias(room.id, preset?.name ?? old.alias.replace(/\d+$/, "")),
        modelSelection: preset?.modelSelection ?? old.modelSelection,
        runtimeMode: preset?.runtimeMode ?? old.runtimeMode,
        interactionMode: "default",
        ...(preset ? { presetId: preset.id } : {}),
        // A fresh Consigliere learns the rules from his first briefing, not from a member's seat briefing.
        seatBriefing: room.consigliereId !== old.id,
      },
      { mode: "create", workspace },
      ids,
    );
  }

  // ---------- images ----------

  /** Store an uploaded image for later delivery. Validated against T3's per-turn limits. */
  storeAttachment(input: { roomId: string; name: string; mimeType: string; data: Uint8Array }): Attachment {
    this.requireRoom(input.roomId);
    const mimeType = input.mimeType.toLowerCase();
    if (!ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new RoomError("unsupported_attachment", `T3 accepts PNG, JPEG, GIF, or WebP images; got ${input.mimeType || "an unknown type"}`, 415);
    }
    if (input.data.byteLength === 0) throw new RoomError("empty_attachment", "the image is empty");
    if (input.data.byteLength > ATTACHMENT_MAX_BYTES) throw new RoomError("attachment_too_large", "images can be up to 10 MB each", 413);
    const attachment: Attachment = {
      id: randomUUID(),
      roomId: input.roomId,
      name: input.name.trim().slice(0, 255) || "image",
      mimeType,
      sizeBytes: input.data.byteLength,
      createdAt: now(),
    };
    this.repos.insertAttachment(attachment, input.data);
    return attachment;
  }

  // ---------- native requests ----------

  private async respondApproval(command: Extract<RoomCommand, { type: "native.approval.respond" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const request = this.repos.getOpenNativeRequest(binding.threadId, command.requestId);
    if (!request || request.kind !== "approval") throw notFound("approval request", command.requestId);
    requireOffered((request.payload as { options?: unknown } | null)?.options, command.decision);
    const commandId = randomUUID();
    try {
      await this.adapter.respondApproval({ commandId, threadId: binding.threadId, requestId: command.requestId, decision: command.decision });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    this.db.transaction(() => this.repos.resolveNativeRequest(binding.threadId, command.requestId));
    this.notify(participant.roomId);
    return { type: "native.responded", requestId: command.requestId };
  }

  private async dismissUserInput(command: Extract<RoomCommand, { type: "native.userInput.dismiss" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const request = this.repos.getOpenNativeRequest(binding.threadId, command.requestId);
    if (!request || request.kind !== "user-input") throw notFound("user-input request", command.requestId);
    try {
      await this.adapter.dismissUserInput({ commandId: randomUUID(), threadId: binding.threadId, requestId: command.requestId });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    this.db.transaction(() => this.repos.resolveNativeRequest(binding.threadId, command.requestId));
    this.notify(participant.roomId);
    return { type: "native.responded", requestId: command.requestId };
  }

  private async respondUserInput(command: Extract<RoomCommand, { type: "native.userInput.respond" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const request = this.repos.getOpenNativeRequest(binding.threadId, command.requestId);
    if (!request || request.kind !== "user-input") throw notFound("user-input request", command.requestId);
    const commandId = randomUUID();
    try {
      await this.adapter.respondUserInput({ commandId, threadId: binding.threadId, requestId: command.requestId, answers: command.answers });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    this.db.transaction(() => this.repos.resolveNativeRequest(binding.threadId, command.requestId));
    this.notify(participant.roomId);
    return { type: "native.responded", requestId: command.requestId };
  }

  /**
   * Save or decline a secret the member's thread asks for. Its row goes once T3 has taken the answer, or once T3 says
   * nothing waits for it any more (answered elsewhere, gone, its agent stopped); any other failure leaves it waiting.
   */
  private async respondSecret(command: Extract<RoomCommand, { type: "native.secret.respond" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const request = this.repos.getOpenNativeRequest(binding.threadId, command.requestId);
    if (!request || request.kind !== "secret") throw notFound("secret request", command.requestId);
    try {
      await answerSecret(this.adapter, binding.threadId, command.requestId, command.answer);
    } catch (error) {
      if (error instanceof SecretRequestStale) {
        this.db.transaction(() => this.repos.resolveNativeRequest(binding.threadId, command.requestId));
        this.notify(participant.roomId);
      }
      throw error;
    }
    this.db.transaction(() => this.repos.resolveNativeRequest(binding.threadId, command.requestId));
    this.notify(participant.roomId);
    return { type: "native.responded", requestId: command.requestId };
  }
}
