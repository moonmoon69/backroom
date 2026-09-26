/** Repositories: typed row mapping over the SQLite tables. All writes assume the caller manages transactions. */
import type { Database } from "./database.ts";
import type {
  Browser,
  NativeRequest,
  Participant,
  Role,
  Room,
  RoomEvent,
  Run,
  SessionBinding,
  Task,
  Attachment,
} from "../domain/types.ts";

type Row = Record<string, unknown>;

const s = (value: unknown): string => value as string;
const n = (value: unknown): number => value as number;
const ns = (value: unknown): string | null => (value === null || value === undefined ? null : (value as string));

function rowToRoom(row: Row): Room {
  return {
    id: s(row.id),
    projectId: s(row.project_id),
    environmentId: ns(row.environment_id),
    title: s(row.title),
    nextSequence: n(row.next_sequence),
    nextTaskNumber: n(row.next_task_number),
    browserEnabled: n(row.browser_enabled) === 1,
    defaultBrowserId: ns(row.default_browser_id),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

function rowToBrowser(row: Row): Browser {
  return { id: s(row.id), name: s(row.name), description: s(row.description), createdAt: s(row.created_at), updatedAt: s(row.updated_at) };
}

function rowToParticipant(row: Row): Participant {
  return {
    id: s(row.id),
    roomId: s(row.room_id),
    alias: s(row.alias),
    roleId: ns(row.role_id),
    modelSelection: JSON.parse(s(row.model_selection_json)),
    runtimeMode: s(row.runtime_mode) as Participant["runtimeMode"],
    interactionMode: s(row.interaction_mode) as Participant["interactionMode"],
    bindingGeneration: n(row.binding_generation),
    retiredAt: ns(row.retired_at),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

function rowToBinding(row: Row): SessionBinding {
  return {
    id: s(row.id),
    participantId: s(row.participant_id),
    generation: n(row.generation),
    threadId: s(row.thread_id),
    deliveredCursor: n(row.delivered_cursor),
    bootstrapDeliveredAt: ns(row.bootstrap_delivered_at),
    createdAt: s(row.created_at),
    retiredAt: ns(row.retired_at),
  };
}

function rowToEvent(row: Row): RoomEvent {
  const sourceMessageId = ns(row.source_message_id);
  return {
    id: s(row.id),
    roomId: s(row.room_id),
    sequence: n(row.sequence),
    kind: s(row.kind) as RoomEvent["kind"],
    speaker: JSON.parse(s(row.speaker_json)),
    text: s(row.text),
    taskId: ns(row.task_id),
    runId: ns(row.run_id),
    artifacts: JSON.parse(s(row.artifacts_json)),
    attachmentIds: JSON.parse(s(row.attachment_ids_json)),
    progress: JSON.parse(s(row.progress_json)),
    prompt: ns(row.prompt),
    sourceRef: sourceMessageId
      ? { threadId: s(row.source_thread_id), messageId: sourceMessageId, turnId: ns(row.source_turn_id) }
      : null,
    createdAt: s(row.created_at),
  };
}

function rowToTask(row: Row): Task {
  return {
    id: s(row.id),
    roomId: s(row.room_id),
    number: n(row.number),
    revision: n(row.revision),
    sourceEventId: s(row.source_event_id),
    participantId: s(row.participant_id),
    instruction: s(row.instruction),
    sourceText: ns(row.source_text),
    attachmentIds: JSON.parse(s(row.attachment_ids_json)),
    delivery: s(row.delivery) === "steer" ? "steer" : "queue",
    slashCommand: n(row.slash_command) === 1,
    scheduleMode: s(row.schedule_mode) as Task["scheduleMode"],
    prerequisites: JSON.parse(s(row.prerequisites_json)),
    state: s(row.state) as Task["state"],
    stateReason: ns(row.state_reason),
    currentRunId: ns(row.current_run_id),
    userOutcome: ns(row.user_outcome) as Task["userOutcome"],
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

function rowToRun(row: Row): Run {
  return {
    id: s(row.id),
    taskId: s(row.task_id),
    taskRevision: n(row.task_revision),
    attempt: n(row.attempt),
    bindingId: s(row.binding_id),
    threadId: s(row.thread_id),
    commandId: s(row.command_id),
    messageId: s(row.message_id),
    turnId: ns(row.turn_id),
    steered: n(row.steered) === 1,
    status: s(row.status) as Run["status"],
    briefing: s(row.briefing),
    includedFromSequence: n(row.included_from_sequence),
    includedToSequence: n(row.included_to_sequence),
    interruptRequestedAt: ns(row.interrupt_requested_at),
    acceptedAt: ns(row.accepted_at),
    startedAt: ns(row.started_at),
    completedAt: ns(row.completed_at),
    resultEventId: ns(row.result_event_id),
    error: ns(row.error),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

function rowToNativeRequest(row: Row): NativeRequest {
  return {
    participantId: s(row.participant_id),
    threadId: s(row.thread_id),
    requestId: s(row.request_id),
    kind: s(row.kind) as NativeRequest["kind"],
    payload: JSON.parse(s(row.payload_json)),
    createdAt: s(row.created_at),
  };
}

export class Repos {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  private get raw() {
    return this.db.raw;
  }

  // ---- rooms ----
  insertRoom(room: Room): void {
    this.raw
      .prepare(
        `INSERT INTO rooms (id, project_id, environment_id, title, next_sequence, next_task_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room.id, room.projectId, room.environmentId, room.title, room.nextSequence, room.nextTaskNumber, room.createdAt, room.updatedAt);
  }

  getRoom(id: string): Room | null {
    const row = this.raw.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRoom(row) : null;
  }

  listRooms(): Room[] {
    return (this.raw.prepare("SELECT * FROM rooms ORDER BY sort_order, created_at").all() as Row[]).map(rowToRoom);
  }

  updateRoomTitle(roomId: string, title: string, at: string): void {
    this.raw.prepare("UPDATE rooms SET title = ?, updated_at = ? WHERE id = ?").run(title, at, roomId);
  }

  setRoomBrowser(roomId: string, enabled: boolean, defaultBrowserId: string | null, at: string): void {
    this.raw.prepare("UPDATE rooms SET browser_enabled = ?, default_browser_id = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, defaultBrowserId, at, roomId);
  }

  // ---- browsers ----

  insertBrowser(browser: Browser): void {
    this.raw
      .prepare("INSERT INTO browsers (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(browser.id, browser.name, browser.description, browser.createdAt, browser.updatedAt);
  }

  getBrowser(id: string): Browser | null {
    const row = this.raw.prepare("SELECT * FROM browsers WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToBrowser(row) : null;
  }

  getBrowserByName(name: string): Browser | null {
    const row = this.raw.prepare("SELECT * FROM browsers WHERE name = ?").get(name) as Row | undefined;
    return row ? rowToBrowser(row) : null;
  }

  /** "general" first, then by name. */
  listBrowsers(): Browser[] {
    return (this.raw.prepare("SELECT * FROM browsers ORDER BY name = 'general' DESC, name").all() as Row[]).map(rowToBrowser);
  }

  updateBrowser(browser: Browser): void {
    this.raw.prepare("UPDATE browsers SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(browser.name, browser.description, browser.updatedAt, browser.id);
  }

  deleteBrowser(id: string): void {
    this.raw.prepare("DELETE FROM browsers WHERE id = ?").run(id);
  }

  setRoomOrder(roomIds: string[]): void {
    const update = this.raw.prepare("UPDATE rooms SET sort_order = ? WHERE id = ?");
    roomIds.forEach((id, index) => update.run(index + 1, id));
  }

  /** Remove a room and everything stored for it, children first (foreign keys are enforced). Caller wraps in a transaction. */
  deleteRoomCascade(roomId: string): void {
    const participants = "SELECT id FROM participants WHERE room_id = ?";
    const tasks = "SELECT id FROM tasks WHERE room_id = ?";
    this.raw.prepare(`DELETE FROM native_requests WHERE participant_id IN (${participants})`).run(roomId);
    this.raw.prepare(`DELETE FROM runs WHERE task_id IN (${tasks})`).run(roomId);
    this.raw.prepare(`DELETE FROM task_revisions WHERE task_id IN (${tasks})`).run(roomId);
    this.raw.prepare("DELETE FROM tasks WHERE room_id = ?").run(roomId);
    this.raw.prepare("DELETE FROM attachments WHERE room_id = ?").run(roomId);
    this.raw.prepare("DELETE FROM events WHERE room_id = ?").run(roomId);
    this.raw.prepare(`DELETE FROM bindings WHERE participant_id IN (${participants})`).run(roomId);
    this.raw.prepare("DELETE FROM participants WHERE room_id = ?").run(roomId);
    this.raw.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  }

  /** Reserve the next event sequence for a room. Caller must be inside a transaction. */
  nextSequence(roomId: string): number {
    const row = this.raw.prepare("SELECT next_sequence FROM rooms WHERE id = ?").get(roomId) as Row;
    const sequence = n(row.next_sequence);
    this.raw
      .prepare("UPDATE rooms SET next_sequence = ?, updated_at = ? WHERE id = ?")
      .run(sequence + 1, new Date().toISOString(), roomId);
    return sequence;
  }

  nextTaskNumber(roomId: string): number {
    const row = this.raw.prepare("SELECT next_task_number FROM rooms WHERE id = ?").get(roomId) as Row;
    const number = n(row.next_task_number);
    this.raw.prepare("UPDATE rooms SET next_task_number = ? WHERE id = ?").run(number + 1, roomId);
    return number;
  }

  // ---- participants ----
  insertParticipant(p: Participant): void {
    this.raw
      .prepare(
        `INSERT INTO participants (id, room_id, alias, alias_key, role_id, model_selection_json,
           runtime_mode, interaction_mode, binding_generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id, p.roomId, p.alias, p.alias.toLowerCase(), p.roleId,
        JSON.stringify(p.modelSelection), p.runtimeMode, p.interactionMode, p.bindingGeneration, p.createdAt, p.updatedAt,
      );
    if (p.retiredAt) this.updateParticipant(p);
  }

  updateParticipant(p: Participant): void {
    this.raw
      .prepare(
        `UPDATE participants SET alias = ?, alias_key = ?, role_id = ?, model_selection_json = ?,
           runtime_mode = ?, interaction_mode = ?, binding_generation = ?, retired_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        // A retired participant releases its alias for reuse; the unique key is suffixed with its id.
        p.alias, p.retiredAt ? `${p.alias.toLowerCase()}#retired:${p.id}` : p.alias.toLowerCase(), p.roleId, JSON.stringify(p.modelSelection),
        p.runtimeMode, p.interactionMode, p.bindingGeneration, p.retiredAt, p.updatedAt, p.id,
      );
  }

  /** Participants still in the room (not retired). */
  listActiveParticipants(roomId: string): Participant[] {
    return this.listParticipants(roomId).filter((p) => p.retiredAt === null);
  }

  getParticipant(id: string): Participant | null {
    const row = this.raw.prepare("SELECT * FROM participants WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToParticipant(row) : null;
  }

  listParticipants(roomId: string): Participant[] {
    return (this.raw.prepare("SELECT * FROM participants WHERE room_id = ? ORDER BY created_at").all(roomId) as Row[]).map(
      rowToParticipant,
    );
  }

  listAllParticipants(): Participant[] {
    return (this.raw.prepare("SELECT * FROM participants ORDER BY created_at").all() as Row[]).map(rowToParticipant);
  }

  // ---- bindings ----
  insertBinding(b: SessionBinding): void {
    this.raw
      .prepare(
        `INSERT INTO bindings (id, participant_id, generation, thread_id, delivered_cursor, bootstrap_delivered_at, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.participantId, b.generation, b.threadId, b.deliveredCursor, b.bootstrapDeliveredAt, b.createdAt, b.retiredAt);
  }

  updateBinding(b: SessionBinding): void {
    this.raw
      .prepare("UPDATE bindings SET delivered_cursor = ?, bootstrap_delivered_at = ?, retired_at = ? WHERE id = ?")
      .run(b.deliveredCursor, b.bootstrapDeliveredAt, b.retiredAt, b.id);
  }

  getBinding(id: string): SessionBinding | null {
    const row = this.raw.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToBinding(row) : null;
  }

  currentBinding(participantId: string): SessionBinding | null {
    const row = this.raw
      .prepare("SELECT * FROM bindings WHERE participant_id = ? AND retired_at IS NULL ORDER BY generation DESC LIMIT 1")
      .get(participantId) as Row | undefined;
    return row ? rowToBinding(row) : null;
  }

  listBindings(participantIds: string[]): SessionBinding[] {
    if (participantIds.length === 0) return [];
    const placeholders = participantIds.map(() => "?").join(",");
    return (
      this.raw
        .prepare(`SELECT * FROM bindings WHERE participant_id IN (${placeholders}) ORDER BY generation`)
        .all(...participantIds) as Row[]
    ).map(rowToBinding);
  }

  listActiveBindings(): SessionBinding[] {
    return (this.raw.prepare("SELECT * FROM bindings WHERE retired_at IS NULL").all() as Row[]).map(rowToBinding);
  }

  // ---- events ----
  insertEvent(e: RoomEvent): void {
    this.raw
      .prepare(
        `INSERT INTO events (id, room_id, sequence, kind, speaker_json, text, task_id, run_id, artifacts_json, attachment_ids_json, progress_json, prompt,
           source_thread_id, source_message_id, source_turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.roomId, e.sequence, e.kind, JSON.stringify(e.speaker), e.text, e.taskId, e.runId, JSON.stringify(e.artifacts), JSON.stringify(e.attachmentIds), JSON.stringify(e.progress), e.prompt,
        e.sourceRef?.threadId ?? null, e.sourceRef?.messageId ?? null, e.sourceRef?.turnId ?? null, e.createdAt,
      );
  }

  getEvent(id: string): RoomEvent | null {
    const row = this.raw.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  hasEventForTurn(threadId: string, turnId: string): boolean {
    return this.raw.prepare("SELECT 1 AS present FROM events WHERE source_thread_id = ? AND source_turn_id = ?").get(threadId, turnId) !== undefined;
  }

  /** Whether a room run owns this T3 turn (so its reply arrives as assistant.reply, not as a direct T3 turn). */
  isRunTurn(threadId: string, turnId: string): boolean {
    return this.raw.prepare("SELECT 1 AS present FROM runs WHERE thread_id = ? AND turn_id = ?").get(threadId, turnId) !== undefined;
  }

  /** Whether a room run sent this T3 user message (the room's own prompt or steer, not a note typed in T3). */
  isRunMessage(threadId: string, messageId: string): boolean {
    return this.raw.prepare("SELECT 1 AS present FROM runs WHERE thread_id = ? AND message_id = ?").get(threadId, messageId) !== undefined;
  }

  findEventIdForSource(threadId: string, messageId: string): string | null {
    const row = this.raw.prepare("SELECT id FROM events WHERE source_thread_id = ? AND source_message_id = ?").get(threadId, messageId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  hasEventForSource(threadId: string, messageId: string): boolean {
    const row = this.raw
      .prepare("SELECT 1 AS present FROM events WHERE source_thread_id = ? AND source_message_id = ?")
      .get(threadId, messageId);
    return row !== undefined;
  }

  listEvents(roomId: string, fromSequence = 1, toSequence = Number.MAX_SAFE_INTEGER, limit = 5000): RoomEvent[] {
    return (
      this.raw
        .prepare("SELECT * FROM events WHERE room_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence LIMIT ?")
        .all(roomId, fromSequence, toSequence, limit) as Row[]
    ).map(rowToEvent);
  }

  listRecentEvents(roomId: string, limit: number): RoomEvent[] {
    const rows = this.raw
      .prepare("SELECT * FROM events WHERE room_id = ? ORDER BY sequence DESC LIMIT ?")
      .all(roomId, limit) as Row[];
    return rows.map(rowToEvent).reverse();
  }

  // ---- attachments ----
  insertAttachment(a: Attachment, data: Uint8Array): void {
    this.raw
      .prepare("INSERT INTO attachments (id, room_id, name, mime_type, size_bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.roomId, a.name, a.mimeType, a.sizeBytes, data, a.createdAt);
  }

  getAttachment(id: string): Attachment | null {
    const row = this.raw.prepare("SELECT id, room_id, name, mime_type, size_bytes, created_at FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return row
      ? { id: s(row.id), roomId: s(row.room_id), name: s(row.name), mimeType: s(row.mime_type), sizeBytes: n(row.size_bytes), createdAt: s(row.created_at) }
      : null;
  }

  getAttachmentData(id: string): Uint8Array | null {
    const row = this.raw.prepare("SELECT data FROM attachments WHERE id = ?").get(id) as { data: Uint8Array } | undefined;
    return row ? row.data : null;
  }

  // ---- tasks ----
  insertTask(t: Task): void {
    this.raw
      .prepare(
        `INSERT INTO tasks (id, room_id, number, revision, source_event_id, participant_id, instruction, source_text, attachment_ids_json,
           delivery, slash_command, schedule_mode, prerequisites_json, state, state_reason, current_run_id, user_outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.roomId, t.number, t.revision, t.sourceEventId, t.participantId, t.instruction, t.sourceText, JSON.stringify(t.attachmentIds), t.delivery, t.slashCommand ? 1 : 0, t.scheduleMode,
        JSON.stringify(t.prerequisites), t.state, t.stateReason, t.currentRunId, t.userOutcome, t.createdAt, t.updatedAt,
      );
    this.snapshotRevision(t);
  }

  updateTask(t: Task): void {
    this.raw
      .prepare(
        `UPDATE tasks SET revision = ?, participant_id = ?, instruction = ?, source_text = ?, schedule_mode = ?, prerequisites_json = ?,
           state = ?, state_reason = ?, current_run_id = ?, user_outcome = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        t.revision, t.participantId, t.instruction, t.sourceText, t.scheduleMode, JSON.stringify(t.prerequisites), t.state,
        t.stateReason, t.currentRunId, t.userOutcome, t.updatedAt, t.id,
      );
  }

  snapshotRevision(t: Task): void {
    this.raw
      .prepare("INSERT OR REPLACE INTO task_revisions (task_id, revision, snapshot_json, created_at) VALUES (?, ?, ?, ?)")
      .run(t.id, t.revision, JSON.stringify(t), new Date().toISOString());
  }

  getTask(id: string): Task | null {
    const row = this.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(roomId: string): Task[] {
    return (this.raw.prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY number").all(roomId) as Row[]).map(rowToTask);
  }

  listTasksByState(states: string[]): Task[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return (this.raw.prepare(`SELECT * FROM tasks WHERE state IN (${placeholders}) ORDER BY created_at`).all(...states) as Row[]).map(
      rowToTask,
    );
  }

  // ---- runs ----
  insertRun(r: Run): void {
    this.raw
      .prepare(
        `INSERT INTO runs (id, task_id, task_revision, attempt, binding_id, thread_id, command_id, message_id, turn_id, status, steered, briefing,
           included_from_sequence, included_to_sequence, interrupt_requested_at, accepted_at, started_at, completed_at, result_event_id,
           error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.taskId, r.taskRevision, r.attempt, r.bindingId, r.threadId, r.commandId, r.messageId, r.turnId, r.status, r.steered ? 1 : 0, r.briefing,
        r.includedFromSequence, r.includedToSequence, r.interruptRequestedAt, r.acceptedAt, r.startedAt, r.completedAt,
        r.resultEventId, r.error, r.createdAt, r.updatedAt,
      );
  }

  updateRun(r: Run): void {
    this.raw
      .prepare(
        `UPDATE runs SET turn_id = ?, status = ?, interrupt_requested_at = ?, accepted_at = ?, started_at = ?, completed_at = ?,
           result_event_id = ?, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        r.turnId, r.status, r.interruptRequestedAt, r.acceptedAt, r.startedAt, r.completedAt, r.resultEventId, r.error,
        r.updatedAt, r.id,
      );
  }

  getRun(id: string): Run | null {
    const row = this.raw.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  listRunsForTask(taskId: string): Run[] {
    return (this.raw.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt").all(taskId) as Row[]).map(rowToRun);
  }

  listRunsForRoom(roomId: string): Run[] {
    return (
      this.raw
        .prepare("SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.room_id = ? ORDER BY r.created_at")
        .all(roomId) as Row[]
    ).map(rowToRun);
  }

  listRunsByStatus(statuses: string[]): Run[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.raw.prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statuses) as Row[]).map(
      rowToRun,
    );
  }

  // ---- native requests ----
  upsertNativeRequest(r: NativeRequest): boolean {
    const result = this.raw
      .prepare(
        `INSERT OR IGNORE INTO native_requests (participant_id, thread_id, request_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.participantId, r.threadId, r.requestId, r.kind, JSON.stringify(r.payload), r.createdAt);
    return result.changes > 0;
  }

  resolveNativeRequest(threadId: string, requestId: string): void {
    this.raw
      .prepare("UPDATE native_requests SET resolved_at = ? WHERE thread_id = ? AND request_id = ? AND resolved_at IS NULL")
      .run(new Date().toISOString(), threadId, requestId);
  }

  listOpenNativeRequests(participantIds: string[]): NativeRequest[] {
    if (participantIds.length === 0) return [];
    const placeholders = participantIds.map(() => "?").join(",");
    return (
      this.raw
        .prepare(`SELECT * FROM native_requests WHERE participant_id IN (${placeholders}) AND resolved_at IS NULL ORDER BY created_at`)
        .all(...participantIds) as Row[]
    ).map(rowToNativeRequest);
  }

  getOpenNativeRequest(threadId: string, requestId: string): NativeRequest | null {
    const row = this.raw
      .prepare("SELECT * FROM native_requests WHERE thread_id = ? AND request_id = ? AND resolved_at IS NULL")
      .get(threadId, requestId) as Row | undefined;
    return row ? rowToNativeRequest(row) : null;
  }

  // ---- T3 command log (outbox bookkeeping for non-run commands) ----
  logCommand(commandId: string, kind: string, threadId: string | null, status: "pending" | "accepted" | "failed", error: string | null): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO t3_command_log (command_id, kind, thread_id, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(command_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(commandId, kind, threadId, status, error, now, now);
  }

  // ---- roles (named rule sets) ----
  private rowToRole(row: Row): Role {
    return { id: s(row.id), name: s(row.name), rules: s(row.rules), createdAt: s(row.created_at), updatedAt: s(row.updated_at) };
  }

  upsertRole(r: Role): void {
    this.raw
      .prepare(
        `INSERT INTO roles (id, name, name_key, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, rules = excluded.rules, updated_at = excluded.updated_at`,
      )
      .run(r.id, r.name, r.name.toLowerCase(), r.rules, r.createdAt, r.updatedAt);
  }

  getRole(id: string): Role | null {
    const row = this.raw.prepare("SELECT * FROM roles WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToRole(row) : null;
  }

  findRoleByName(name: string): Role | null {
    const row = this.raw.prepare("SELECT * FROM roles WHERE name_key = ?").get(name.toLowerCase()) as Row | undefined;
    return row ? this.rowToRole(row) : null;
  }

  listRoles(): Role[] {
    return (this.raw.prepare("SELECT * FROM roles ORDER BY name_key").all() as Row[]).map((row) => this.rowToRole(row));
  }

  deleteRole(id: string): boolean {
    this.raw.prepare("UPDATE participants SET role_id = NULL WHERE role_id = ?").run(id);
    return this.raw.prepare("DELETE FROM roles WHERE id = ?").run(id).changes > 0;
  }

  // ---- kv ----
  getKv(key: string): string | null {
    const row = this.raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? s(row.value) : null;
  }

  setKv(key: string, value: string): void {
    this.raw.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
