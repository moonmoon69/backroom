/**
 * RoomService: the single command handler shared by direct controls, explicit syntax,
 * and any later interpreter (PRD 3 "Action contract", 4.5). Validates references and state,
 * persists transactionally, and appends room events. The scheduler runs separately.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { Repos } from "../db/repos.ts";
import type { T3Adapter, ThreadLifecycleAction } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable } from "../adapter/types.ts";
import type { Assignment, RoomCommand, Schedule } from "../domain/commands.ts";
import { RoomError, invalidTransition, notFound, stale } from "../domain/errors.ts";
import { dependentsOf, validatePrerequisites } from "../domain/graph.ts";
import { DirectThreads, isDirectCommand, type DirectResult } from "./direct.ts";
import { effectiveBrowser, roomsUsingBrowser } from "../browser/catalog.ts";
import {
  PENDING_TASK_STATES,
  type Browser,
  type Participant,
  type PrerequisiteRef,
  type Role,
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
  | { type: "room.deleted"; roomId: string; threads: Array<{ participantId: string; alias: string; threadId: string; action: string; result: "done" | "kept" | "failed"; detail?: string }> }
  | { type: "role.saved"; roleId: string }
  | { type: "role.deleted"; roleId: string }
  | { type: "participant.created"; participantId: string; threadId: string }
  | {
      type: "participant.updated";
      participantId: string;
      /** After participant.retire: what happened to its T3 thread (kept when the choice was keep, it has no binding, or it is seated elsewhere). */
      thread?: { threadId: string; action: ThreadLifecycleAction | "keep"; result: "done" | "kept" | "failed"; detail?: string };
    }
  | { type: "tasks.created"; taskIds: string[]; eventId: string }
  | { type: "note.created"; eventId: string }
  | { type: "task.updated"; taskId: string; revision: number }
  | { type: "task.interrupt.requested"; taskId: string; runId: string }
  | { type: "native.responded"; requestId: string }
  | { type: "browser.created"; browserId: string }
  | { type: "browser.updated"; browserId: string }
  | { type: "browser.deleted"; browserId: string }
  | DirectResult;

export const now = (): string => new Date().toISOString();

export class RoomService {
  private readonly db: Database;
  private readonly repos: Repos;
  private readonly adapter: T3Adapter;
  private readonly notify: (roomId: string) => void;
  /** Projects and threads used outside any room. */
  private readonly direct: DirectThreads;

  constructor(db: Database, repos: Repos, adapter: T3Adapter, notify: (roomId: string) => void = () => {}) {
    this.db = db;
    this.repos = repos;
    this.adapter = adapter;
    this.notify = notify;
    this.direct = new DirectThreads(repos, adapter);
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
    sourceRef?: RoomEvent["sourceRef"];
    createdAt?: string;
  }): RoomEvent {
    return this.db.transaction(() => {
      const sequence = this.repos.nextSequence(input.roomId);
      const event: RoomEvent = {
        id: randomUUID(),
        roomId: input.roomId,
        sequence,
        kind: input.kind,
        speaker: input.speaker,
        text: input.text,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
        artifacts: input.artifacts ?? [],
        attachmentIds: input.attachmentIds ?? [],
        progress: input.progress ?? [],
        prompt: input.prompt ?? null,
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

  /** Block pending dependents of a task with a visible reason. Returns the tasks that were blocked. */
  blockPendingDependents(task: Task, reason: string): Task[] {
    const blocked: Task[] = [];
    for (const dependent of dependentsOf(task.id, this.repos.listTasks(task.roomId))) {
      if (!PENDING_TASK_STATES.has(dependent.state) || dependent.state === "blocked") continue;
      blocked.push(this.setTaskState(dependent, "blocked", reason));
      this.statusEvent(dependent, `${taskLabel(dependent)} blocked: ${reason}`);
    }
    return blocked;
  }

  private participantsById(roomId: string): Map<string, Participant> {
    return new Map(this.repos.listParticipants(roomId).map((p) => [p.id, p]));
  }

  // ---------- command entry point ----------

  async execute(command: RoomCommand): Promise<CommandResult> {
    if (isDirectCommand(command)) return this.direct.execute(command);
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
      case "room.delete":
        return this.deleteRoom(command);
      case "participant.create":
        return this.createParticipant(command);
      case "participant.update":
        return this.updateParticipant(command);
      case "role.create":
        return this.createRole(command);
      case "role.update":
        return this.updateRole(command);
      case "role.delete":
        return this.deleteRole(command);
      case "participant.rebind":
        return this.rebindParticipant(command);
      case "participant.retire":
        return this.retireParticipant(command);
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
      case "native.approval.respond":
        return this.respondApproval(command);
      case "native.userInput.respond":
        return this.respondUserInput(command);
    }
  }

  // ---------- rooms & participants ----------

  /**
   * Delete a room. T3 thread actions run first (settle/archive/delete as chosen per participant; a thread also bound in
   * another room is kept), then the room's stored data is removed in one transaction. A failed T3 action is reported
   * and leaves that thread as it was; the room is still deleted.
   */
  private async deleteRoom(command: Extract<RoomCommand, { type: "room.delete" }>): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    const results: Array<{ participantId: string; alias: string; threadId: string; action: string; result: "done" | "kept" | "failed"; detail?: string }> = [];
    for (const participant of this.repos.listParticipants(room.id)) {
      const binding = this.repos.currentBinding(participant.id);
      if (!binding) continue;
      const action = command.threads[participant.id] ?? "keep";
      const elsewhere = this.repos
        .listActiveBindings()
        .some((b) => b.threadId === binding.threadId && this.repos.getParticipant(b.participantId)?.roomId !== room.id);
      if (action === "keep" || participant.retiredAt || elsewhere) {
        results.push({ participantId: participant.id, alias: participant.alias, threadId: binding.threadId, action, result: "kept", ...(elsewhere && action !== "keep" ? { detail: "also used in another room" } : {}) });
        continue;
      }
      try {
        await this.adapter.setThreadLifecycle({ commandId: randomUUID(), threadId: binding.threadId, action });
        results.push({ participantId: participant.id, alias: participant.alias, threadId: binding.threadId, action, result: "done" });
      } catch (error) {
        results.push({ participantId: participant.id, alias: participant.alias, threadId: binding.threadId, action, result: "failed", detail: (error as Error).message });
      }
    }
    this.db.transaction(() => this.repos.deleteRoomCascade(room.id));
    this.notify(room.id);
    return { type: "room.deleted", roomId: room.id, threads: results };
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
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.transaction(() => this.repos.insertRoom(room));
    this.notify(room.id);
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

  private async setRoomBrowser(command: Extract<RoomCommand, { type: "room.browser" }>): Promise<CommandResult> {
    const room = this.requireRoom(command.roomId);
    const defaultBrowserId = command.browserId === undefined ? room.defaultBrowserId : command.browserId;
    if (defaultBrowserId) this.requireBrowser(defaultBrowserId);
    if (room.browserEnabled === command.enabled && room.defaultBrowserId === defaultBrowserId) return { type: "room.updated", roomId: room.id };
    const browser = this.effectiveBrowser({ ...room, defaultBrowserId });
    const text = !command.enabled
      ? "Browsers turned off for this room"
      : !room.browserEnabled
        ? `Browsers turned on: tasks in this room get "${browser?.name ?? "a browser"}" by default`
        : `Default browser set to "${browser?.name ?? "none"}"`;
    this.db.transaction(() => {
      this.repos.setRoomBrowser(room.id, command.enabled, defaultBrowserId, now());
      this.appendEvent({ roomId: room.id, kind: "system", speaker: { type: "system" }, text });
    });
    this.notify(room.id);
    return { type: "room.updated", roomId: room.id };
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
      // Rooms with browsers off may still point at it; they fall back to "general".
      for (const room of this.repos.listRooms().filter((r) => r.defaultBrowserId === browser.id)) this.repos.setRoomBrowser(room.id, room.browserEnabled, null, now());
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

  private requireRoleId(roleId: string | null): string | null {
    if (roleId === null) return null;
    if (!this.repos.getRole(roleId)) throw notFound("role", roleId);
    return roleId;
  }

  private async bindThread(
    room: Room,
    participant: Pick<Participant, "alias" | "modelSelection" | "runtimeMode" | "interactionMode">,
    thread: { mode: "create" } | { mode: "attach"; threadId: string },
  ): Promise<{ threadId: string; runtimeMode: Participant["runtimeMode"]; modelSelection: Participant["modelSelection"]; interactionMode: Participant["interactionMode"] }> {
    try {
      if (thread.mode === "attach") {
        const shell = await this.adapter.getThreadShell(thread.threadId);
        if (!shell) throw new RoomError("unknown_thread", `T3 thread ${thread.threadId} was not found`);
        if (shell.projectId !== room.projectId) {
          throw new RoomError("thread_project_mismatch", `thread ${thread.threadId} belongs to a different T3 project`);
        }
        const inUse = this.repos.listActiveBindings().find((binding) => binding.threadId === thread.threadId);
        if (inUse) throw new RoomError("thread_in_use", `thread ${thread.threadId} is already bound to another participant`, 409);
        // An attached thread keeps what T3 has for it: model, options, permission mode, interaction mode.
        return { threadId: shell.id, runtimeMode: shell.runtimeMode, modelSelection: shell.modelSelection, interactionMode: shell.interactionMode };
      }
      const threadId = randomUUID();
      const commandId = randomUUID();
      this.repos.logCommand(commandId, "thread.create", threadId, "pending", null);
      await this.adapter.createThread({
        commandId,
        threadId,
        projectId: room.projectId,
        title: `${room.title} · ${participant.alias}`,
        modelSelection: participant.modelSelection,
        runtimeMode: participant.runtimeMode,
        interactionMode: participant.interactionMode,
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
        roleId: this.requireRoleId(command.roleId),
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

  private async seatParticipant(
    roomId: string,
    spec: Pick<Participant, "alias" | "roleId" | "modelSelection" | "runtimeMode" | "interactionMode">,
    thread: { mode: "create" } | { mode: "attach"; threadId: string },
  ): Promise<CommandResult> {
    const room = this.requireRoom(roomId);
    this.assertAliasFree(room.id, spec.alias, null);
    const bound = await this.bindThread(room, spec, thread);
    const participant: Participant = {
      id: randomUUID(),
      roomId: room.id,
      alias: spec.alias,
      roleId: spec.roleId,
      modelSelection: bound.modelSelection,
      runtimeMode: bound.runtimeMode,
      interactionMode: bound.interactionMode,
      bindingGeneration: 1,
      retiredAt: null,
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
    this.notify(room.id);
    return { type: "participant.created", participantId: participant.id, threadId: bound.threadId };
  }

  private async updateParticipant(command: Extract<RoomCommand, { type: "participant.update" }>): Promise<CommandResult> {
    const participant = this.requireParticipant(command.participantId);
    if (command.alias !== undefined) this.assertAliasFree(participant.roomId, command.alias, participant.id);
    const roleId = command.roleId === undefined ? participant.roleId : this.requireRoleId(command.roleId);
    const updated: Participant = { ...participant, alias: command.alias ?? participant.alias, roleId, updatedAt: now() };
    this.db.transaction(() => this.repos.updateParticipant(updated));
    if (participant.alias !== updated.alias) {
      this.appendEvent({ roomId: participant.roomId, kind: "system", speaker: { type: "system" }, text: `@${participant.alias} renamed to @${updated.alias}` });
    }
    if (participant.roleId !== updated.roleId) {
      const role = updated.roleId ? this.repos.getRole(updated.roleId) : null;
      this.appendEvent({
        roomId: participant.roomId,
        kind: "system",
        speaker: { type: "system" },
        text: role ? `@${updated.alias} now has the role "${role.name}"` : `@${updated.alias} no longer has a role`,
      });
    }
    this.notify(participant.roomId);
    return { type: "participant.updated", participantId: participant.id };
  }

  // ---------- roles (named rule sets) ----------

  private assertRoleNameFree(name: string, exceptId: string | null): void {
    const existing = this.repos.findRoleByName(name);
    if (existing && existing.id !== exceptId) throw new RoomError("role_name_taken", `a role named "${name}" already exists`, 409);
  }

  private async createRole(command: Extract<RoomCommand, { type: "role.create" }>): Promise<CommandResult> {
    this.assertRoleNameFree(command.name, null);
    const role: Role = { id: randomUUID(), name: command.name, rules: command.rules, createdAt: now(), updatedAt: now() };
    this.db.transaction(() => this.repos.upsertRole(role));
    return { type: "role.saved", roleId: role.id };
  }

  private async updateRole(command: Extract<RoomCommand, { type: "role.update" }>): Promise<CommandResult> {
    const role = this.repos.getRole(command.roleId);
    if (!role) throw notFound("role", command.roleId);
    if (command.name) this.assertRoleNameFree(command.name, role.id);
    const updated: Role = { ...role, name: command.name ?? role.name, rules: command.rules ?? role.rules, updatedAt: now() };
    this.db.transaction(() => this.repos.upsertRole(updated));
    return { type: "role.saved", roleId: role.id };
  }

  private async deleteRole(command: Extract<RoomCommand, { type: "role.delete" }>): Promise<CommandResult> {
    // Participants holding the role keep working without one; the repository clears their role_id.
    const removed = this.db.transaction(() => this.repos.deleteRole(command.roleId));
    if (!removed) throw notFound("role", command.roleId);
    return { type: "role.deleted", roleId: command.roleId };
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
  private async createMessage(input: { roomId: string; sourceText: string; attachmentIds: string[]; assignments: Assignment[] }): Promise<CommandResult> {
    const room = this.requireRoom(input.roomId);
    const participants = this.participantsById(room.id);
    for (const assignment of input.assignments) {
      for (const recipient of assignment.recipients) {
        const participant = participants.get(recipient);
        if (!participant) throw new RoomError("unknown_participant", `participant ${recipient} is not in this room`);
        if (participant.retiredAt) throw new RoomError("participant_retired", `@${participant.alias} was removed from the room`, 409);
      }
    }
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
        kind: "user.message",
        speaker: { type: "user" },
        text: input.sourceText,
        attachmentIds: input.attachmentIds,
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
            scheduleMode: schedule.mode,
            prerequisites,
            state: schedule.mode === "manual" ? "held" : "queued",
            stateReason: this.describeSchedule(schedule, tasksById),
            currentRunId: null,
            userOutcome: null,
            createdAt: now(),
            updatedAt: now(),
          };
          this.repos.insertTask(task);
          tasksById.set(task.id, task);
          group.push(task);
          created.push(task);
          const alias = participants.get(recipient)?.alias ?? recipient;
          this.statusEvent(task, `${taskLabel(task)} → @${alias}: ${task.state} (${task.stateReason})`);
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
    if (!assignee) throw new RoomError("unknown_participant", `participant ${participantId} is not in this room`);
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
      await this.adapter.interruptTurn({ commandId, threadId: run.threadId, turnId: run.turnId });
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
      const updated = this.setTaskState(task, "queued", "retry requested; ready", { currentRunId: null, userOutcome: null });
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
