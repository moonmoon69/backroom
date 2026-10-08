/**
 * RoomService: the single command handler shared by direct controls, explicit syntax,
 * and any later interpreter. Validates references and state,
 * persists transactionally, and appends room events. The scheduler runs separately.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { Repos } from "../db/repos.ts";
import type { T3Adapter, ThreadLifecycleAction } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable } from "../adapter/types.ts";
import type { Assignment, RoomCommand, Schedule, WorkspaceChoice } from "../domain/commands.ts";
import { RoomError, invalidTransition, notFound, stale } from "../domain/errors.ts";
import { dependentsOf, validatePrerequisites } from "../domain/graph.ts";
import { DirectThreads, isDirectCommand, type DirectResult } from "./direct.ts";
import { resolveWorkspace } from "./workspaceChoice.ts";
import { CONSIGLIERE_PRESET_KEY, CONSIGLIERE_RULES_KEY, RETIRE_THREAD_KEY, conversationTitle, movedInstruction, retireThreadChoice, seatInstruction, startAttemptKey } from "./consigliere.ts";
import { RESEAT_KEY_PREFIX, checkpointInstruction, readReseats, takeoverInstruction, writeReseats, type Reseat } from "./reseat.ts";
import { EngineSeats } from "./engineSeats.ts";
import type { EngineHost } from "../runtime/host.ts";
import type { BriefingSource } from "../runtime/render.ts";
import { effectiveBrowser, roomsUsingBrowser } from "../browser/catalog.ts";
import {
  PENDING_TASK_STATES,
  POST_KINDS,
  type Browser,
  type Participant,
  type PrerequisiteRef,
  type Preset,
  type Room,
  type RoomEvent,
  type Attachment,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MIME_TYPES,
  type SessionBinding,
  type Speaker,
  type Task,
  type TaskState,
  taskLabel,
} from "../domain/types.ts";

export type CommandResult =
  | { type: "room.created"; roomId: string }
  | { type: "room.updated"; roomId: string }
  | { type: "rooms.reordered" }
  | { type: "projects.reordered" }
  /** timeout: the action was sent but T3 had not answered within the limit; it may still apply it (the late outcome is logged). */
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
      thread?: { threadId: string; action: ThreadLifecycleAction | "keep"; result: "done" | "kept" | "failed"; detail?: string };
    }
  | { type: "tasks.created"; taskIds: string[]; eventId: string }
  /** After participant.reseat: the checkpoint task the member was sent, and the post that asked for it. */
  | { type: "participant.reseating"; participantId: string; taskId: string; eventId: string }
  | { type: "note.created"; eventId: string }
  /** The engine's message path (ROOMS_ENGINE=1): one request per recipient per assignment, sharing the message's ID. */
  | { type: "requests.created"; messageId: string; requestIds: string[]; noteIds: string[] }
  | { type: "request.updated"; requestId: string; applied: boolean }
  | { type: "run.retried"; runId: string; eventId: string }
  | { type: "run.stopped"; participantId: string }
  | { type: "task.updated"; taskId: string; revision: number }
  | { type: "task.interrupt.requested"; taskId: string; runId: string }
  | { type: "native.responded"; requestId: string }
  | { type: "browser.created"; browserId: string }
  | { type: "browser.updated"; browserId: string }
  | { type: "browser.deleted"; browserId: string }
  | DirectResult;

export const now = (): string => new Date().toISOString();

/**
 * With ROOMS_ENGINE=1 the engine handles some commands instead of the old runtime: the first handler that returns a
 * result has taken the command (src/app/engineMessages.ts for the user's messages; seat lifecycle the same way).
 */
export type EngineHandler = (command: RoomCommand) => Promise<CommandResult> | null;

/** The first words of an instruction, for a note that points at it. */
const headOf = (text: string, max = 80): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

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

/** How long room deletion waits for T3 to answer each thread action (ROOMS_THREAD_ACTION_TIMEOUT_MS). */
export const THREAD_ACTION_TIMEOUT_MS = 5000;

export interface RoomServiceOptions {
  /** Per-call limit on the T3 thread actions room deletion sends (they run concurrently). */
  threadActionTimeoutMs?: number;
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
  private readonly log: (message: string, detail?: unknown) => void;

  constructor(db: Database, repos: Repos, adapter: T3Adapter, notify: (roomId: string) => void = () => {}, options: RoomServiceOptions = {}) {
    this.db = db;
    this.repos = repos;
    this.adapter = adapter;
    this.notify = notify;
    this.direct = new DirectThreads(repos, adapter);
    const limit = options.threadActionTimeoutMs;
    this.threadActionTimeoutMs = limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : THREAD_ACTION_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  /** Stage 4/5 (L4b): with ROOMS_ENGINE=1 the seat lifecycle runs on the engine journal (src/app/engineSeats.ts). */
  private engineSeats: EngineSeats | null = null;

  useEngineSeats(host: EngineHost, briefing: BriefingSource, log?: (message: string, detail?: unknown) => void): EngineSeats {
    this.engineSeats = new EngineSeats({
      repos: this.repos,
      adapter: this.adapter,
      host,
      briefing,
      notify: this.notify,
      transaction: (fn) => this.db.transaction(fn),
      seatFresh: (room, old, ids) => this.seatFresh(room, old, { seat: ids }),
      mirror: (participant, shell) => this.syncParticipantFromThread(participant, shell),
      title: threadTitleFor,
      ...(log ? { log } : {}),
    });
    return this.engineSeats;
  }

  // ---------- shared helpers (also used by the scheduler) ----------

  appendEvent(input: {
    roomId: string;
    kind: RoomEvent["kind"];
    speaker: Speaker;
    text: string;
    taskId?: string | null;
    runId?: string | null;
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
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
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

  statusEvent(task: Task, text: string, runId: string | null = null): RoomEvent {
    return this.appendEvent({ roomId: task.roomId, kind: "task.status", speaker: { type: "system" }, text, taskId: task.id, runId });
  }

  setTaskState(task: Task, state: TaskState, reason: string | null, extra: Partial<Task> = {}): Task {
    const updated: Task = { ...task, ...extra, state, stateReason: reason, updatedAt: now() };
    this.repos.updateTask(updated);
    return updated;
  }

  /**
   * A "wake" task: Backroom's own task for a member, run when something they are waiting for has happened. After a
   * task, it waits on it and carries its answer; without one it runs at once and its instruction says what happened.
   */
  createWake(roomId: string, poster: Participant, sourceEventId: string, instruction: string, after: Task | null): Task {
    const wake: Task = {
      id: randomUUID(),
      roomId,
      number: this.repos.nextTaskNumber(roomId),
      revision: 1,
      sourceEventId,
      participantId: poster.id,
      instruction,
      sourceText: null,
      attachmentIds: [],
      delivery: "queue",
      slashCommand: false,
      kind: "wake",
      scheduleMode: after ? "after_all" : "now",
      prerequisites: after ? [{ taskId: after.id, revision: after.revision }] : [],
      state: "queued",
      stateReason: after ? `after ${taskLabel(after)}` : null,
      currentRunId: null,
      userOutcome: null,
      dismissedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.repos.insertTask(wake);
    this.statusEvent(wake, after ? `${taskLabel(wake)} → @${poster.alias}: wakes him when ${taskLabel(after)} ends` : `${taskLabel(wake)} → @${poster.alias}: wakes him now`);
    return wake;
  }

  /** Block pending dependents of a task with a visible reason. Returns the tasks that were blocked. A "wake" task is
   *  not blocked by its work ending badly: that is what it is for, and the scheduler runs it with the outcome. */
  blockPendingDependents(task: Task, reason: string): Task[] {
    const blocked: Task[] = [];
    for (const dependent of dependentsOf(task.id, this.repos.listTasks(task.roomId))) {
      if (!PENDING_TASK_STATES.has(dependent.state) || dependent.state === "blocked" || dependent.kind === "wake") continue;
      blocked.push(this.setTaskState(dependent, "blocked", reason));
      this.statusEvent(dependent, `${taskLabel(dependent)} blocked: ${reason}`);
    }
    return blocked;
  }

  private participantsById(roomId: string): Map<string, Participant> {
    return new Map(this.repos.listParticipants(roomId).map((p) => [p.id, p]));
  }

  // ---------- command entry point ----------

  /** The engine runtime takes the commands this handler accepts (bootstrap.ts, with ROOMS_ENGINE=1 only). */
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
      case "room.delete":
        return this.deleteRoom(command);
      case "member.post":
        return this.createMemberPost(command);
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
      case "room.consigliere.set":
        return this.setConsigliere(command);
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
      case "participant.rebind":
        return this.rebindParticipant(command);
      case "participant.retire":
        return this.retireParticipant(command);
      case "participant.reseat":
        return this.reseatParticipant(command);
      case "participant.model.set":
        return this.setParticipantModel(command);
      case "participant.runtimeMode.set":
        return this.setParticipantRuntimeMode(command);
      case "task.create":
        return this.createMessage({
          roomId: command.roomId,
          sourceText: command.sourceText ?? command.instruction,
          attachmentIds: command.attachmentIds,
          assignments: [{ recipients: command.recipients, instruction: command.instruction, schedule: command.schedule, after: [], delivery: command.delivery, slashCommand: false }],
        });
      case "message.create":
        return this.createMessage({
          roomId: command.roomId,
          sourceText: command.sourceText ?? command.assignments.map((a) => a.instruction).join("\n"),
          attachmentIds: command.attachmentIds,
          assignments: command.assignments,
        });
      case "room.note.create":
        return this.createNote(command);
      case "request.cancel":
      case "request.correct":
      case "run.retry":
      case "run.stop":
        throw new RoomError("engine_only", `${command.type} acts on the engine's board; this service runs without it (ROOMS_ENGINE=1)`, 409);
      case "task.update":
        return this.updateTask(command);
      case "task.release":
        return this.releaseTask(command);
      case "task.cancel":
        return this.cancelTask(command);
      case "task.interrupt":
        return this.interruptTask(command);
      case "task.retry":
        return this.retryTask(command);
      case "task.markBlocked":
        return this.markBlocked(command);
      case "task.unblock":
        return this.unblockTask(command);
      case "task.dismiss": {
        const task = this.repos.getTask(command.taskId);
        if (!task) throw notFound("task", command.taskId);
        if (task.state !== "failed") throw invalidTransition(taskLabel(task), task.state, "dismiss; only a failed task can be taken off your list");
        this.db.transaction(() => {
          this.repos.updateTask({ ...task, dismissedAt: now(), updatedAt: now() });
          this.statusEvent(task, `${taskLabel(task)}: failure dismissed by user`);
        });
        this.notify(task.roomId);
        return { type: "task.updated", taskId: task.id, revision: task.revision };
      }
      case "native.userInput.dismiss":
        return this.dismissUserInput(command);
      case "native.approval.respond":
        return this.respondApproval(command);
      case "native.userInput.respond":
        return this.respondUserInput(command);
    }
  }

  // ---------- rooms & participants ----------

  /**
   * Delete a room. The T3 thread actions (settle/archive/delete as chosen per participant; a thread also bound in
   * another room, or a retired member's, is left as it is) are all sent at once; the room's stored data is removed in one
   * transaction without waiting for them, and the answer waits at most the per-call limit. A failed action leaves that
   * thread as it was; an action T3 has not answered by then is reported as a timeout, and its late outcome is logged.
   */
  private async deleteRoom(command: Extract<RoomCommand, { type: "room.delete" }>): Promise<CommandResult> {
    type ThreadResult = Extract<CommandResult, { type: "room.deleted" }>["threads"][number];
    const room = this.requireRoom(command.roomId);
    const results: Array<ThreadResult | Promise<ThreadResult>> = [];
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
      results.push(this.threadActionWithin(room, entry, action));
    }
    this.db.transaction(() => this.repos.deleteRoomCascade(room.id));
    this.notify(room.id);
    return { type: "room.deleted", roomId: room.id, threads: await Promise.all(results) };
  }

  /** Sends one thread action now and answers within the limit: done, failed, or timeout (the late outcome is logged). */
  private threadActionWithin<T extends { alias: string; threadId: string }>(
    room: Room,
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
          if (late) this.log(`room "${room.title}" deleted: @${entry.alias}'s thread ${entry.threadId} ${action} finished late in T3`);
          else resolve({ ...entry, result: "done" });
        },
        (error: unknown) => {
          clearTimeout(timer);
          const detail = error instanceof Error ? error.message : String(error);
          if (late) this.log(`room "${room.title}" deleted: @${entry.alias}'s thread ${entry.threadId} ${action} failed late in T3`, detail);
          else resolve({ ...entry, result: "failed", detail });
        },
      );
    });
  }

  private async createRoom(command: Extract<RoomCommand, { type: "room.create" }>): Promise<CommandResult> {
    let environmentId: string | null = null;
    try {
      const projects = await this.adapter.listProjects();
      if (!projects.some((project) => project.id === command.projectId)) {
        throw new RoomError("unknown_project", `T3 project ${command.projectId} was not found on the connected server`);
      }
      environmentId = (await this.adapter.describe()).environmentId;
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw error;
    }
    const room: Room = {
      id: randomUUID(),
      projectId: command.projectId,
      environmentId,
      title: command.title,
      nextSequence: 1,
      nextTaskNumber: 1,
      browserEnabled: false,
      defaultBrowserId: null,
      allowedBrowserIds: null,
      consigliereId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.transaction(() => this.repos.insertRoom(room));
    this.notify(room.id);
    // A room opens with the Consigliere seated, when one is chosen in Settings: he is the one you talk to in it.
    if (command.consigliere) await this.seatConsigliere(room);
    return { type: "room.created", roomId: room.id };
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
        ? `Browsers turned on: tasks in this room get "${browser?.name ?? "a browser"}" by default`
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
    for (const room of this.roomsUsingBrowser(browser.id)) this.notify(room.id);
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
      for (const room of this.repos.listRooms()) {
        const pointsAt = room.defaultBrowserId === browser.id;
        const listed = room.allowedBrowserIds?.includes(browser.id) ?? false;
        if (!pointsAt && !listed) continue;
        // A room pointing at it falls back to "general"; a room whose allowed list had only this browser has no browser left.
        const allowed = room.allowedBrowserIds?.filter((id) => id !== browser.id) ?? null;
        const emptied = allowed !== null && allowed.length === 0;
        this.repos.setRoomBrowser(room.id, emptied ? false : room.browserEnabled, pointsAt ? null : room.defaultBrowserId, now(), emptied ? null : allowed);
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
        `@${participant.alias}'s thread runs on ${participant.modelSelection.instanceId}; a thread cannot switch provider. Rebind to a new thread instead.`,
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
    // Mirror immediately; the scheduler keeps it in sync with T3 afterwards.
    this.db.transaction(() => this.repos.updateParticipant({ ...participant, modelSelection: command.modelSelection, updatedAt: now() }));
    this.appendEvent({ roomId: participant.roomId, kind: "system", speaker: { type: "system" }, text: `@${participant.alias} model set to ${command.modelSelection.model} in T3` });
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id };
  }

  /** Keep the participant's mirror of the thread configuration equal to what T3 reports. Used by the scheduler. */
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
    if (this.engineSeats && thread.mode === "attach") this.engineSeats.refuseSeatedThread(room.id, thread.threadId);
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
    // In a room that has a Consigliere his messages arrive bare, so a new member is told the standing facts first.
    const consigliere = room.consigliereId ? this.repos.getParticipant(room.consigliereId) : null;
    if (this.engineSeats) this.engineSeats.seated(room, participant, binding, { briefing: spec.seatBriefing !== false });
    else if (consigliere && !consigliere.retiredAt && spec.seatBriefing !== false) this.sendSeatBriefing(room, participant, seatInstruction(consigliere, this.repos.currentBinding(consigliere.id)?.threadId ?? null), "Seat briefing");
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

  /**
   * A task Backroom writes itself for one member: the seat briefing, or the line that names a new Consigliere. It is
   * delivered like any assignment (so it is retried, shown and answered on the board) but carries no room messages.
   */
  private sendSeatBriefing(room: Room, participant: Participant, instruction: string, label: string): Task {
    return this.db.transaction(() => {
      const source = this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `${label} sent to @${participant.alias}` });
      const task: Task = {
        id: randomUUID(),
        roomId: room.id,
        number: this.repos.nextTaskNumber(room.id),
        revision: 1,
        sourceEventId: source.id,
        participantId: participant.id,
        instruction,
        sourceText: null,
        attachmentIds: [],
        delivery: "queue",
        slashCommand: false,
        kind: "seat",
        scheduleMode: "now",
        prerequisites: [],
        state: "queued",
        stateReason: "ready",
        currentRunId: null,
        userOutcome: null,
        dismissedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.repos.insertTask(task);
      this.statusEvent(task, `${taskLabel(task)} → @${participant.alias}: ${label.toLowerCase()}`);
      return task;
    });
  }

  /**
   * Designate a member as the room's Consigliere, move the mark, or clear it. A room's first Consigliere means every
   * other member gets the seat briefing; a move tells every member, in one line, who he is now.
   */
  private async setConsigliere(command: Extract<RoomCommand, { type: "room.consigliere.set" }>, except: string | null = null): Promise<CommandResult> {
    // Also reached from inside the service (a room's first Consigliere, a conversation's start), not only by execute.
    if (this.engineSeats) return this.engineSeats.designate(command);
    const room = this.requireRoom(command.roomId);
    const previous = room.consigliereId ? this.repos.getParticipant(room.consigliereId) : null;
    if (command.participantId === null) {
      if (room.consigliereId === null) return { type: "room.updated", roomId: room.id };
      this.db.transaction(() => {
        this.repos.setRoomConsigliere(room.id, null, now());
        this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `${previous ? `@${previous.alias} is no longer the Consigliere; this` : "This"} room has no Consigliere` });
      });
      this.notify(room.id);
      return { type: "room.updated", roomId: room.id };
    }
    const participant = this.requireParticipant(command.participantId);
    if (participant.roomId !== room.id) throw new RoomError("unknown_participant", `member ${command.participantId} is not in this room`);
    if (room.consigliereId === participant.id) return { type: "room.updated", roomId: room.id };
    const threadId = this.repos.currentBinding(participant.id)?.threadId ?? null;
    const moved = previous !== null && !previous.retiredAt;
    this.db.transaction(() => {
      this.repos.setRoomConsigliere(room.id, participant.id, now());
      this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `@${participant.alias} is now the Consigliere of this room` });
      for (const other of this.repos.listActiveParticipants(room.id)) {
        // except: a reseated Consigliere, who leaves the room as the mark moves.
        if (other.id === participant.id || other.id === except) continue;
        if (moved) this.sendSeatBriefing(room, other, movedInstruction(participant, threadId), "New Consigliere");
        else this.sendSeatBriefing(room, other, seatInstruction(participant, threadId), "Seat briefing");
      }
    });
    this.notify(room.id);
    return { type: "room.updated", roomId: room.id };
  }

  /**
   * Start a conversation with the Consigliere: a room in the project, the saved crew member the setting names seated
   * and designated, and the user's message delivered to him. What the attempt intends (the room, the member, the
   * thread and its T3 command) is written down before T3 is called, so the same request sent again, after an error or
   * a restart, carries on with them and makes nothing twice.
   */
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
    // Delivered already when the room has the message: the attempt stopped before saying so.
    if (!this.repos.listEvents(current.roomId).some((event) => event.kind === "user.message")) await this.createMessage({
      roomId: current.roomId,
      sourceText: command.text,
      attachmentIds: [],
      assignments: [{ recipients: [current.participantId], instruction: command.text.trim(), schedule: { mode: "now" }, after: [], delivery: "queue", slashCommand: false }],
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

  private async rebindParticipant(command: Extract<RoomCommand, { type: "participant.rebind" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const room = this.requireRoom(participant.roomId);
    const runningTasks = this.repos
      .listTasks(room.id)
      .filter((task) => task.participantId === participant.id && (task.state === "dispatching" || task.state === "running" || task.state === "needs_input"));
    if (runningTasks.length > 0) {
      throw new RoomError(
        "participant_busy",
        `@${participant.alias} has work in progress (${runningTasks.map(taskLabel).join(", ")}); interrupt it or wait before rebinding`,
        409,
      );
    }
    const bound = await this.bindThread(room, participant, command.thread);
    const generation = participant.bindingGeneration + 1;
    const pending = this.repos.listTasks(room.id).filter((task) => task.participantId === participant.id && PENDING_TASK_STATES.has(task.state));
    this.db.transaction(() => {
      const old = this.repos.currentBinding(participant.id);
      if (old) this.repos.updateBinding({ ...old, retiredAt: now() });
      this.repos.insertBinding({
        id: randomUUID(),
        participantId: participant.id,
        generation,
        threadId: bound.threadId,
        deliveredCursor: 0,
        bootstrapDeliveredAt: null,
        createdAt: now(),
        retiredAt: null,
      });
      this.repos.updateParticipant({ ...participant, bindingGeneration: generation, runtimeMode: bound.runtimeMode, modelSelection: bound.modelSelection, interactionMode: bound.interactionMode, updatedAt: now() });
      if (command.outstandingTasks === "block") {
        for (const task of pending) {
          if (task.state === "blocked") continue;
          this.setTaskState(task, "blocked", `@${participant.alias} was rebound to a new session; confirm or edit before it runs`);
        }
      }
    });
    this.appendEvent({
      roomId: room.id,
      kind: "system",
      speaker: { type: "system" },
      text: `@${participant.alias} rebound to a ${command.thread.mode === "create" ? "new" : "different"} thread (generation ${generation}); ` +
        `${pending.length} pending task(s) ${command.outstandingTasks === "carry" ? "carried over" : "blocked for confirmation"}`,
    });
    this.notify(room.id);
    return { type: "participant.updated", participantId: participant.id };
  }

  /**
   * Retire a participant. Its room data stays for attribution; its T3 thread is kept, settled, archived, or deleted
   * as chosen (a thread also seated in another room is always kept). The T3 action runs after the room bookkeeping
   * commits; a failure is reported in the result and leaves the thread as it was.
   */
  private async retireParticipant(command: Extract<RoomCommand, { type: "participant.retire" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const tasks = this.repos.listTasks(participant.roomId).filter((task) => task.participantId === participant.id);
    const inFlight = tasks.filter((task) => task.state === "dispatching" || task.state === "running" || task.state === "needs_input");
    if (inFlight.length > 0) {
      throw new RoomError(
        "participant_busy",
        `@${participant.alias} has work in progress (${inFlight.map(taskLabel).join(", ")}); interrupt it or wait before removing`,
        409,
      );
    }
    const pending = tasks.filter((task) => PENDING_TASK_STATES.has(task.state));
    const binding = this.repos.currentBinding(participant.id);
    const elsewhere = binding
      ? this.repos
          .listActiveBindings()
          .some((b) => b.threadId === binding.threadId && b.participantId !== participant.id && this.repos.getParticipant(b.participantId)?.roomId !== participant.roomId)
      : false;
    this.db.transaction(() => {
      if (binding) this.repos.updateBinding({ ...binding, retiredAt: now() });
      this.repos.updateParticipant({ ...participant, retiredAt: now(), updatedAt: now() });
      // A room's Consigliere who leaves takes the mark with him: the room has none until the user names another.
      if (this.repos.getRoom(participant.roomId)?.consigliereId === participant.id) this.repos.setRoomConsigliere(participant.roomId, null, now());
      for (const task of pending) {
        if (command.pendingTasks === "cancel") {
          const cancelled = this.setTaskState(task, "cancelled", `cancelled: @${participant.alias} was removed from the room`);
          this.statusEvent(cancelled, `${taskLabel(cancelled)} cancelled (@${participant.alias} removed)`);
          this.blockPendingDependents(cancelled, `prerequisite ${taskLabel(cancelled)} was cancelled`);
        } else if (task.state !== "blocked") {
          const blocked = this.setTaskState(task, "blocked", `@${participant.alias} was removed; edit the task to reassign it`);
          this.statusEvent(blocked, `${taskLabel(blocked)} blocked: assignee removed`);
        }
      }
    });
    let thread: NonNullable<Extract<CommandResult, { type: "participant.updated" }>["thread"]> | undefined;
    if (binding) {
      const action = command.thread;
      if (action === "keep") thread = { threadId: binding.threadId, action, result: "kept" };
      else if (elsewhere) thread = { threadId: binding.threadId, action, result: "kept", detail: "also used in another room" };
      else {
        try {
          await this.adapter.setThreadLifecycle({ commandId: randomUUID(), threadId: binding.threadId, action });
          thread = { threadId: binding.threadId, action, result: "done" };
        } catch (error) {
          thread = { threadId: binding.threadId, action, result: "failed", detail: (error as Error).message };
        }
      }
    }
    const threadNote =
      thread && thread.action !== "keep"
        ? thread.result === "done"
          ? `; its T3 thread was ${thread.action === "delete" ? "deleted" : `${thread.action}d`}`
          : thread.result === "kept"
            ? `; its T3 thread was kept (${thread.detail ?? "kept"})`
            : `; T3 could not ${thread.action} its thread (${thread.detail ?? "failed"})`
        : "";
    this.appendEvent({
      roomId: participant.roomId,
      kind: "system",
      speaker: { type: "system" },
      text: `@${participant.alias} removed from the room; ${pending.length} pending task(s) ${command.pendingTasks === "cancel" ? "cancelled" : "kept blocked for reassignment"}${threadNote}`,
    });
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id, ...(thread ? { thread } : {}) };
  }

  // ---------- reseating (see reseat.ts) ----------

  /**
   * Ask a member for its checkpoint post, the first step of a reseat. The task is queued like any other, so it runs
   * when the work in hand is done; advanceReseats does the rest when the post has landed. Nobody is woken for it.
   */
  private async reseatParticipant(command: Extract<RoomCommand, { type: "participant.reseat" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const by = this.requireParticipant(command.by);
    if (by.roomId !== participant.roomId) throw new RoomError("unknown_participant", `member ${command.by} is not in this room`);
    const room = this.requireRoom(participant.roomId);
    const pending = readReseats(this.repos, room.id);
    const already = pending.find((reseat) => reseat.participantId === participant.id || reseat.seat.participantId === participant.id);
    if (already) {
      const checkpoint = this.repos.getTask(already.checkpointTaskId);
      throw new RoomError("reseat_pending", `@${participant.alias} is being reseated already${checkpoint ? ` (checkpoint ${taskLabel(checkpoint)}: ${checkpoint.state})` : ""}`, 409);
    }
    if (!this.repos.currentBinding(participant.id)) throw new RoomError("no_binding", `@${participant.alias} has no thread to write a checkpoint on`);
    const byBinding = this.repos.currentBinding(by.id);
    const plan = command.plan?.trim() || null;
    const result = this.db.transaction(() => {
      const event = this.appendEvent({
        roomId: room.id,
        kind: "member.message",
        speaker: byBinding ? { type: "participant", participantId: by.id, bindingId: byBinding.id } : { type: "system" },
        text: `@${participant.alias} reseat: write your checkpoint post; a fresh seat takes over from it.${plan ? ` It carries on with: ${plan}` : ""}`,
        to: participant.id,
      });
      const task: Task = {
        id: randomUUID(),
        roomId: room.id,
        number: this.repos.nextTaskNumber(room.id),
        revision: 1,
        sourceEventId: event.id,
        participantId: participant.id,
        instruction: checkpointInstruction({ consigliere: room.consigliereId === participant.id, plan }),
        sourceText: event.text,
        attachmentIds: [],
        delivery: "queue",
        slashCommand: false,
        kind: "assignment",
        scheduleMode: "now",
        prerequisites: [],
        state: "queued",
        stateReason: "ready",
        currentRunId: null,
        userOutcome: null,
        dismissedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.repos.insertTask(task);
      this.statusEvent(task, `${taskLabel(task)} → @${participant.alias}: checkpoint for a reseat`);
      const reseat: Reseat = {
        participantId: participant.id,
        by: by.id,
        plan,
        requestEventId: event.id,
        checkpointTaskId: task.id,
        seat: { participantId: randomUUID(), threadId: randomUUID(), commandId: randomUUID() },
        stage: "checkpoint",
        requestedAt: now(),
      };
      writeReseats(this.repos, room.id, [...pending, reseat]);
      return { type: "participant.reseating" as const, participantId: participant.id, taskId: task.id, eventId: event.id };
    });
    this.notify(room.id);
    return result;
  }

  /**
   * Carry every reseat in progress a step on. Scheduler.runTick calls it after reading the threads and before sending
   * work, so a fresh seat's first task goes out in the same tick its member's checkpoint landed. Rooms it changed are
   * added to touched.
   */
  async advanceReseats(touched: Set<string>): Promise<void> {
    for (const key of this.repos.listKv(RESEAT_KEY_PREFIX).keys()) {
      const roomId = key.slice(RESEAT_KEY_PREFIX.length);
      for (const reseat of readReseats(this.repos, roomId)) {
        if (await this.advanceReseat(roomId, reseat)) touched.add(roomId);
      }
    }
  }

  /**
   * One reseat, as far as it can go now: once the checkpoint has succeeded and its member is idle, seat the fresh
   * member where the old one worked; hand it the checkpoint and the member's pending tasks; move the Consigliere's mark;
   * retire the old seat. Each step is recorded, so a crash or T3 outage resumes where it stopped. True when it changed
   * anything.
   */
  private async advanceReseat(roomId: string, start: Reseat): Promise<boolean> {
    let reseat = start;
    const save = (next: Reseat | null) =>
      writeReseats(this.repos, roomId, [...readReseats(this.repos, roomId).filter((r) => r.participantId !== reseat.participantId), ...(next ? [next] : [])]);
    const room = this.repos.getRoom(roomId);
    const old = this.repos.getParticipant(reseat.participantId);
    const checkpoint = this.repos.getTask(reseat.checkpointTaskId);
    if (!room || !old || !checkpoint) {
      save(null);
      return true;
    }
    if (reseat.stage === "checkpoint") {
      if (old.retiredAt) return this.callOffReseat(room, reseat, old, `@${old.alias} was removed from the room`);
      // Blocked: its thread is gone from T3, or it was removed; nothing would ever run it.
      if (checkpoint.state === "failed" || checkpoint.state === "interrupted" || checkpoint.state === "cancelled" || checkpoint.state === "blocked") {
        return this.callOffReseat(room, reseat, old, `its checkpoint ${taskLabel(checkpoint)} ${checkpoint.state}${checkpoint.stateReason && checkpoint.stateReason !== checkpoint.state ? ` (${checkpoint.stateReason})` : ""}`);
      }
      if (checkpoint.state !== "succeeded") return false;
      // Whatever the member is still running (a steer that came after the checkpoint) ends first.
      const busy = this.repos.listTasks(roomId).some((t) => t.participantId === old.id && (t.state === "dispatching" || t.state === "running" || t.state === "needs_input"));
      if (busy) return false;
      try {
        if (!this.repos.getParticipant(reseat.seat.participantId)) await this.seatFresh(room, old, reseat);
      } catch (error) {
        // T3 away: the next tick tries again with the same ids. Anything else calls the reseat off.
        if (error instanceof RoomError && error.status === 503) return false;
        return this.callOffReseat(room, reseat, old, `the fresh seat could not be made: ${(error as Error).message}`);
      }
      reseat = { ...reseat, stage: "seated" };
      save(reseat);
    }
    const fresh = this.repos.getParticipant(reseat.seat.participantId);
    if (!fresh) return this.callOffReseat(room, reseat, old, "the fresh seat is gone");
    const consigliere = room.consigliereId === old.id || room.consigliereId === fresh.id;
    if (reseat.stage === "seated") {
      this.db.transaction(() => {
        this.handOver(room, reseat, old, fresh, checkpoint, consigliere);
        reseat = { ...reseat, stage: "handed" };
        save(reseat);
      });
    }
    if (room.consigliereId === old.id) await this.setConsigliere({ type: "room.consigliere.set", roomId, participantId: fresh.id }, old.id);
    // The old seat's thread goes as the user's retire setting says (kept unless they chose otherwise).
    if (!this.repos.getParticipant(old.id)?.retiredAt) await this.retireParticipant({ type: "participant.retire", participantId: old.id, pendingTasks: "cancel", thread: retireThreadChoice(this.repos) });
    save(null);
    this.notify(roomId);
    return true;
  }

  /**
   * The fresh seat: the same saved crew member (or, for a seat made without one, the same settings), in the old seat's
   * folder: its worktree, or the project folder. The checkpoint and the moved tasks assume that folder, so when T3 cannot
   * say where the old seat worked the reseat is called off rather than seated elsewhere; T3 being away is retried.
   */
  private async seatFresh(room: Room, old: Participant, reseat: Pick<Reseat, "seat">): Promise<void> {
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
        // A fresh Consigliere learns the rules from his first task, not from a member's seat briefing.
        seatBriefing: room.consigliereId !== old.id,
      },
      { mode: "create", workspace },
      reseat.seat,
    );
  }

  /**
   * The fresh seat's first task (it waits on the checkpoint, so the briefing carries the post in full), a wake for the
   * Consigliere when it ends, and the old seat's pending tasks moved over, after the takeover, at the same revision (so
   * whatever waits on them still does). Runs inside a transaction.
   */
  private handOver(room: Room, reseat: Reseat, old: Participant, fresh: Participant, checkpoint: Task, consigliere: boolean): void {
    const resultId = checkpoint.currentRunId ? this.repos.getRun(checkpoint.currentRunId)?.resultEventId : null;
    const result = resultId ? this.repos.getEvent(resultId) : null;
    const post = result ? `#${result.postNumber ?? result.sequence}` : `(${taskLabel(checkpoint)}'s answer)`;
    const by = this.repos.getParticipant(reseat.by);
    const byBinding = by && !by.retiredAt ? this.repos.currentBinding(by.id) : null;
    // A member's answer goes to the Consigliere who asked; a fresh Consigliere's goes to the user, like his were.
    const reportTo = !consigliere && by && byBinding && by.id !== old.id ? by : null;
    const binding = this.repos.currentBinding(fresh.id);
    // Without a seat briefing (a fresh Consigliere) the first delivery would carry the room's whole history.
    if (binding && binding.bootstrapDeliveredAt === null && binding.deliveredCursor === 0) {
      this.repos.updateBinding({ ...binding, deliveredCursor: (this.repos.getRoom(room.id)?.nextSequence ?? 1) - 1 });
    }
    const source = this.appendEvent(
      reportTo && byBinding
        ? {
            roomId: room.id,
            kind: "member.message",
            speaker: { type: "participant", participantId: reportTo.id, bindingId: byBinding.id },
            text: `@${fresh.alias} you take over from @${old.alias}: its checkpoint is ${post}.${reseat.plan ? ` Carry on with: ${reseat.plan}` : ""}`,
            to: fresh.id,
          }
        : { roomId: room.id, kind: "system", speaker: { type: "system" }, text: `@${fresh.alias} takes over from @${old.alias} as the Consigliere, from its checkpoint ${post}` },
    );
    const task: Task = {
      id: randomUUID(),
      roomId: room.id,
      number: this.repos.nextTaskNumber(room.id),
      revision: 1,
      sourceEventId: source.id,
      participantId: fresh.id,
      instruction: takeoverInstruction({ from: old.alias, consigliere, checkpointPost: post, plan: reseat.plan, reportTo: reportTo?.alias ?? null }),
      sourceText: source.text,
      attachmentIds: [],
      delivery: "queue",
      slashCommand: false,
      kind: "assignment",
      scheduleMode: "after_all",
      prerequisites: [{ taskId: checkpoint.id, revision: checkpoint.revision }],
      state: "queued",
      stateReason: `after ${taskLabel(checkpoint)}`,
      currentRunId: null,
      userOutcome: null,
      dismissedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.repos.insertTask(task);
    this.statusEvent(task, `${taskLabel(task)} → @${fresh.alias}: takes over from @${old.alias}`);
    if (reportTo) {
      this.createWake(room.id, reportTo, source.id, `${taskLabel(task)} (@${fresh.alias}: takes over from @${old.alias}) has ended. Its answer is above, among the results; carry on with what you asked it for. If it failed or was stopped, decide what to do about that.`, task);
    }
    // Older tasks would be sent first (the queue goes by age): each moved task also waits for the takeover.
    for (const pending of this.repos.listTasks(room.id)) {
      if (pending.participantId !== old.id || !PENDING_TASK_STATES.has(pending.state)) continue;
      const prerequisites = [...pending.prerequisites, { taskId: task.id, revision: task.revision }];
      this.repos.updateTask({ ...pending, participantId: fresh.id, prerequisites, scheduleMode: pending.scheduleMode === "now" ? "after_all" : pending.scheduleMode, updatedAt: now() });
      this.statusEvent(pending, `${taskLabel(pending)} moved from @${old.alias} to @${fresh.alias} (reseat); it runs after ${taskLabel(task)}`);
    }
    this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `@${old.alias} reseated: @${fresh.alias} takes over from its checkpoint ${post}` });
  }

  /** A reseat that cannot go on: the member stays seated, and whoever asked is woken to decide. */
  private callOffReseat(room: Room, reseat: Reseat, old: Participant, why: string): true {
    this.db.transaction(() => {
      writeReseats(this.repos, room.id, readReseats(this.repos, room.id).filter((r) => r.participantId !== reseat.participantId));
      // A checkpoint still waiting (blocked, say) would otherwise run for a reseat that is no longer coming.
      const checkpoint = this.repos.getTask(reseat.checkpointTaskId);
      if (checkpoint && PENDING_TASK_STATES.has(checkpoint.state)) {
        const cancelled = this.setTaskState(checkpoint, "cancelled", "cancelled: the reseat was called off");
        this.statusEvent(cancelled, `${taskLabel(cancelled)} cancelled (reseat called off)`);
      }
      const event = this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text: `Reseat of @${old.alias} called off: ${why}` });
      const by = this.repos.getParticipant(reseat.by);
      if (by && !by.retiredAt) {
        this.createWake(room.id, by, event.id, `The reseat of @${old.alias} was called off: ${why}. ${old.retiredAt ? "" : `@${old.alias} stays seated as it was. `}Decide what to do about that.`, null);
      }
    });
    this.notify(room.id);
    return true;
  }

  // ---------- tasks ----------

  private describeSchedule(schedule: Schedule, tasksById: Map<string, Task>): string {
    if (schedule.mode === "now") return "ready";
    if (schedule.mode === "manual") return "held until released";
    const labels = schedule.prerequisites.map((ref) => {
      const task = tasksById.get(ref.taskId);
      return task ? taskLabel(task) : ref.taskId;
    });
    return `waiting for ${labels.join(", ")}`;
  }

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

  /** A slash command must be one the recipient's provider offers (T3 lists them per provider). */
  private async requireSlashCommands(assignments: Assignment[], participants: Map<string, Participant>): Promise<void> {
    const wanted = assignments.filter((a) => a.slashCommand);
    if (wanted.length === 0) return;
    const providers = await this.adapter.listProviders();
    for (const assignment of wanted) {
      const name = /^\/([^\s]+)/.exec(assignment.instruction)?.[1] ?? "";
      for (const recipient of assignment.recipients) {
        const participant = participants.get(recipient);
        const offered = providers.find((p) => p.instanceId === participant?.modelSelection.instanceId)?.slashCommands ?? [];
        if (!offered.some((c) => c.name === name)) {
          throw new RoomError("unknown_slash_command", `@${participant?.alias ?? recipient}'s provider has no /${name} command`);
        }
      }
    }
  }

  private requireAttachments(roomId: string, ids: string[]): Attachment[] {
    const attachments = ids.map((id) => {
      const attachment = this.repos.getAttachment(id);
      if (!attachment || attachment.roomId !== roomId) throw new RoomError("unknown_attachment", `attachment ${id} is not in this room`);
      return attachment;
    });
    const total = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new RoomError("attachment_too_large", "images can total up to 80 MB per message", 413);
    return attachments;
  }

  /**
   * One user message: a single room event and one task per recipient per assignment. An assignment's "after"
   * indices become prerequisites on every task created for those earlier assignments, pinned at revision 1.
   */
  /**
   * A member's post on the board: work for other members, from one of them. The post is a member.message on the
   * board (from, to, text); each recipient gets a task as from the user, and the poster gets a "wake" task after each
   * of them: Backroom runs it with the answer when the work ends, so the poster hands out and goes idle.
   */
  private async createMemberPost(command: Extract<RoomCommand, { type: "member.post" }>): Promise<CommandResult> {
    const poster = this.requireParticipant(command.participantId);
    if (poster.roomId !== command.roomId) throw new RoomError("unknown_participant", `member ${command.participantId} is not in this room`);
    if (poster.retiredAt) throw new RoomError("participant_retired", `@${poster.alias} was removed from the room`, 409);
    if (command.assignments.some((assignment) => assignment.recipients.includes(poster.id))) throw new RoomError("self_addressed", "a post is for other members, not for its poster");
    return this.createMessage({ roomId: command.roomId, sourceText: command.sourceText, attachmentIds: [], assignments: command.assignments, from: poster });
  }

  private async createMessage(input: { roomId: string; sourceText: string; attachmentIds: string[]; assignments: Assignment[]; from?: Participant }): Promise<CommandResult> {
    const room = this.requireRoom(input.roomId);
    const participants = this.participantsById(room.id);
    for (const assignment of input.assignments) {
      for (const recipient of assignment.recipients) {
        const participant = participants.get(recipient);
        if (!participant) throw new RoomError("unknown_participant", `member ${recipient} is not in this room`);
        if (participant.retiredAt) throw new RoomError("participant_retired", `@${participant.alias} was removed from the room`, 409);
      }
    }
    const from = input.from ?? null;
    const fromBinding = from ? this.repos.currentBinding(from.id) : null;
    this.requireAttachments(room.id, input.attachmentIds);
    await this.requireSlashCommands(input.assignments, participants);
    const tasksById = new Map(this.repos.listTasks(room.id).map((task) => [task.id, task]));
    for (const assignment of input.assignments) {
      if (assignment.schedule.mode === "after_all") {
        const issues = validatePrerequisites(null, assignment.schedule.prerequisites, tasksById);
        if (issues.length > 0) throw new RoomError("invalid_prerequisites", issues.map((issue) => issue.message).join("; "));
      }
    }
    const created: Task[] = [];
    const event = this.db.transaction(() => {
      const sourceEvent = this.appendEvent({
        roomId: room.id,
        kind: from ? "member.message" : "user.message",
        speaker: from && fromBinding ? { type: "participant", participantId: from.id, bindingId: fromBinding.id } : { type: "user" },
        text: input.sourceText,
        attachmentIds: input.attachmentIds,
        to: from ? (input.assignments[0]?.recipients[0] ?? null) : null,
      });
      const tasksByAssignment: Task[][] = [];
      for (const assignment of input.assignments) {
        const external: PrerequisiteRef[] = assignment.schedule.mode === "after_all" ? assignment.schedule.prerequisites : [];
        const internal: PrerequisiteRef[] = assignment.after.flatMap((index) =>
          (tasksByAssignment[index] ?? []).map((task) => ({ taskId: task.id, revision: task.revision })),
        );
        const prerequisites = [...external, ...internal];
        const schedule: Schedule =
          assignment.schedule.mode === "manual" ? { mode: "manual" } : prerequisites.length > 0 ? { mode: "after_all", prerequisites } : { mode: "now" };
        const group: Task[] = [];
        for (const recipient of assignment.recipients) {
          const task: Task = {
            id: randomUUID(),
            roomId: room.id,
            number: this.repos.nextTaskNumber(room.id),
            revision: 1,
            sourceEventId: sourceEvent.id,
            participantId: recipient,
            instruction: assignment.instruction || "(See the attached image.)",
            sourceText: input.sourceText,
            attachmentIds: input.attachmentIds,
            delivery: assignment.delivery,
            slashCommand: assignment.slashCommand,
            kind: "assignment",
            scheduleMode: schedule.mode,
            prerequisites,
            state: schedule.mode === "manual" ? "held" : "queued",
            stateReason: this.describeSchedule(schedule, tasksById),
            currentRunId: null,
            userOutcome: null,
            dismissedAt: null,
            createdAt: now(),
            updatedAt: now(),
          };
          this.repos.insertTask(task);
          tasksById.set(task.id, task);
          group.push(task);
          created.push(task);
          const alias = participants.get(recipient)?.alias ?? recipient;
          this.statusEvent(task, `${taskLabel(task)} → @${alias}: ${task.state} (${task.stateReason})`);
          // The poster is woken with the answer when the work ends, however it ends (see Scheduler.prerequisiteReadiness).
          if (from) {
            this.createWake(room.id, from, sourceEvent.id, `${taskLabel(task)} (@${alias}: ${headOf(task.instruction)}) has ended. Its answer is above, among the results; carry on with what you asked it for. If it failed or was stopped, decide what to do about that.`, task);
          }
        }
        tasksByAssignment.push(group);
      }
      return sourceEvent;
    });
    this.notify(room.id);
    return { type: "tasks.created", taskIds: created.map((task) => task.id), eventId: event.id };
  }

  private async createNote(command: Extract<RoomCommand, { type: "room.note.create" }>): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    const event = this.appendEvent({ roomId: room.id, kind: "note", speaker: { type: "user" }, text: command.text });
    this.notify(room.id);
    return { type: "note.created", eventId: event.id };
  }

  private requireTaskRevision(taskId: string, revision: number): Task {
    const task = this.repos.getTask(taskId);
    if (!task) throw notFound("task", taskId);
    if (task.revision !== revision) throw stale(taskLabel(task), revision, task.revision);
    return task;
  }

  private async updateTask(command: Extract<RoomCommand, { type: "task.update" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (!PENDING_TASK_STATES.has(task.state)) throw invalidTransition(taskLabel(task), task.state, "edit; only pending work can change");
    const participants = this.participantsById(task.roomId);
    const participantId = command.participantId ?? task.participantId;
    const assignee = participants.get(participantId);
    if (!assignee) throw new RoomError("unknown_participant", `member ${participantId} is not in this room`);
    if (assignee.retiredAt) throw new RoomError("participant_retired", `@${assignee.alias} was removed from the room; pick another assignee`, 409);
    const tasksById = new Map(this.repos.listTasks(task.roomId).map((t) => [t.id, t]));
    const schedule: Schedule = command.schedule ?? (task.scheduleMode === "after_all" ? { mode: "after_all", prerequisites: task.prerequisites } : { mode: task.scheduleMode });
    if (schedule.mode === "after_all") {
      const issues = validatePrerequisites(task.id, schedule.prerequisites, tasksById);
      if (issues.length > 0) throw new RoomError("invalid_prerequisites", issues.map((issue) => issue.message).join("; "));
    }
    const revision = task.revision + 1;
    const updated: Task = {
      ...task,
      revision,
      participantId,
      instruction: command.instruction ?? task.instruction,
      scheduleMode: schedule.mode,
      prerequisites: schedule.mode === "after_all" ? schedule.prerequisites : [],
      state: schedule.mode === "manual" ? "held" : "queued",
      stateReason: this.describeSchedule(schedule, tasksById),
      updatedAt: now(),
    };
    this.db.transaction(() => {
      this.repos.updateTask(updated);
      this.repos.snapshotRevision(updated);
      for (const dependent of dependentsOf(task.id, tasksById.values())) {
        // Every existing reference to this task is now stale (all point at revisions < the new one).
        if (!PENDING_TASK_STATES.has(dependent.state)) continue; // already accepted by T3; cannot be retargeted
        if (command.carryDependents) {
          const carried: Task = {
            ...dependent,
            revision: dependent.revision + 1,
            prerequisites: dependent.prerequisites.map((ref) => (ref.taskId === task.id ? { taskId: task.id, revision } : ref)),
            // A dependent blocked only by the stale reference becomes eligible again; the scheduler re-checks.
            state: dependent.state === "blocked" ? "queued" : dependent.state,
            stateReason: dependent.state === "blocked" ? `waiting for ${taskLabel(task)} (revision ${revision})` : dependent.stateReason,
            updatedAt: now(),
          };
          this.repos.updateTask(carried);
          this.repos.snapshotRevision(carried);
          this.statusEvent(carried, `${taskLabel(carried)} now waits for ${taskLabel(task)} revision ${revision}`);
        } else if (dependent.state !== "blocked") {
          const reason = `prerequisite ${taskLabel(task)} was edited (now revision ${revision}); re-point or carry the dependency`;
          this.setTaskState(dependent, "blocked", reason);
          this.statusEvent(dependent, `${taskLabel(dependent)} blocked: ${reason}`);
        }
      }
      this.statusEvent(updated, `${taskLabel(updated)} edited (revision ${revision}): ${updated.state} (${updated.stateReason})`);
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision };
  }

  private async releaseTask(command: Extract<RoomCommand, { type: "task.release" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (task.state !== "held") throw invalidTransition(taskLabel(task), task.state, "release; only held work can be released");
    this.db.transaction(() => {
      const updated = this.setTaskState(task, "queued", "released; ready");
      this.statusEvent(updated, `${taskLabel(updated)} released to the queue`);
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision: task.revision };
  }

  private async cancelTask(command: Extract<RoomCommand, { type: "task.cancel" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (!PENDING_TASK_STATES.has(task.state)) {
      throw invalidTransition(taskLabel(task), task.state, "cancel; work already accepted by T3 must be interrupted instead");
    }
    this.db.transaction(() => {
      const updated = this.setTaskState(task, "cancelled", "cancelled by user");
      this.statusEvent(updated, `${taskLabel(updated)} cancelled`);
      this.blockPendingDependents(updated, `prerequisite ${taskLabel(updated)} was cancelled`);
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision: task.revision };
  }

  private async interruptTask(command: Extract<RoomCommand, { type: "task.interrupt" }>): Promise<CommandResult> {
    const task = this.repos.getTask(command.taskId);
    if (!task) throw notFound("task", command.taskId);
    const run = this.repos.getRun(command.runId);
    if (!run || run.taskId !== task.id) throw notFound("run", command.runId);
    if (task.currentRunId !== run.id || !(run.status === "running" || run.status === "needs_input" || run.status === "accepted")) {
      throw invalidTransition(taskLabel(task), task.state, "interrupt; no running turn");
    }
    const commandId = randomUUID();
    try {
      await this.adapter.interruptRun({ commandId, threadId: run.threadId, runId: run.t3RunId });
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      if (error instanceof T3CommandRejected) throw new RoomError("t3_rejected", error.message, 502);
      throw error;
    }
    this.db.transaction(() => {
      this.repos.updateRun({ ...run, interruptRequestedAt: now(), updatedAt: now() });
      this.statusEvent(task, `${taskLabel(task)}: interrupt requested; waiting for T3 to report the outcome`, run.id);
    });
    this.notify(task.roomId);
    return { type: "task.interrupt.requested", taskId: task.id, runId: run.id };
  }

  private async retryTask(command: Extract<RoomCommand, { type: "task.retry" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (!(task.state === "failed" || task.state === "interrupted")) {
      throw invalidTransition(taskLabel(task), task.state, "retry; only failed or interrupted work can be retried");
    }
    this.db.transaction(() => {
      const updated = this.setTaskState(task, "queued", "retry requested; ready", { currentRunId: null, userOutcome: null, dismissedAt: null });
      const dependents = dependentsOf(task.id, this.repos.listTasks(task.roomId)).filter((d) => d.state === "blocked");
      for (const dependent of dependents) {
        if (command.reattachDependents) {
          this.setTaskState(dependent, "queued", `waiting for ${taskLabel(task)} (new attempt)`);
          this.statusEvent(dependent, `${taskLabel(dependent)} reattached to the new attempt of ${taskLabel(task)}`);
        } else {
          this.setTaskState(dependent, "blocked", `prerequisite ${taskLabel(task)} is being retried; not reattached`);
        }
      }
      this.statusEvent(
        updated,
        `${taskLabel(updated)} retry queued (attempt ${this.repos.listRunsForTask(task.id).length + 1}); ` +
          `${dependents.length} dependent(s) ${command.reattachDependents ? "will follow this attempt" : "stay blocked"}`,
      );
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision: task.revision };
  }

  private async markBlocked(command: Extract<RoomCommand, { type: "task.markBlocked" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (task.state !== "succeeded") throw invalidTransition(taskLabel(task), task.state, "mark blocked; only a completed task can be overridden");
    this.db.transaction(() => {
      const updated = this.setTaskState(task, "failed", `marked blocked by user: ${command.reason}`, { userOutcome: "blocked" });
      this.statusEvent(updated, `${taskLabel(updated)} marked blocked by user: ${command.reason}`);
      const blocked = this.blockPendingDependents(updated, `prerequisite ${taskLabel(updated)} was marked blocked by the user`);
      const delivered = dependentsOf(updated.id, this.repos.listTasks(updated.roomId)).filter((d) => !PENDING_TASK_STATES.has(d.state));
      if (delivered.length > 0) {
        this.statusEvent(updated, `note: ${delivered.map(taskLabel).join(", ")} already received ${taskLabel(updated)}'s output and were not retracted`);
      }
      void blocked;
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision: task.revision };
  }

  private async unblockTask(command: Extract<RoomCommand, { type: "task.unblock" }>): Promise<CommandResult> {
    const task = this.requireTaskRevision(command.taskId, command.revision);
    if (task.state !== "blocked") throw invalidTransition(taskLabel(task), task.state, "unblock");
    this.db.transaction(() => {
      const updated = this.setTaskState(task, "queued", "unblocked by user; re-evaluating prerequisites");
      this.statusEvent(updated, `${taskLabel(updated)} unblocked by user`);
    });
    this.notify(task.roomId);
    return { type: "task.updated", taskId: task.id, revision: task.revision };
  }

  // ---------- native requests ----------

  private async respondApproval(command: Extract<RoomCommand, { type: "native.approval.respond" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    const binding = this.repos.currentBinding(participant.id);
    if (!binding) throw new RoomError("no_binding", `@${participant.alias} has no active thread`);
    const request = this.repos.getOpenNativeRequest(binding.threadId, command.requestId);
    if (!request || request.kind !== "approval") throw notFound("approval request", command.requestId);
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
}
