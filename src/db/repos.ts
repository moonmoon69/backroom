/** Repositories: typed row mapping over the SQLite tables. All writes assume the caller manages transactions. */
import { resolveLook, type Look } from "../domain/look.ts";
import type { Database } from "./database.ts";
import type {
  Browser,
  NativeRequest,
  Participant,
  Preset,
  Room,
  RoomEvent,
  SessionBinding,
  ThreadBrowsers,
  Attachment,
} from "../domain/types.ts";

type Row = Record<string, unknown>;

const s = (value: unknown): string => value as string;
const n = (value: unknown): number => value as number;
const ns = (value: unknown): string | null => (value === null || value === undefined ? null : (value as string));

function rowToThreadBrowsers(row: Row): ThreadBrowsers {
  return {
    threadId: s(row.thread_id),
    browserEnabled: n(row.browser_enabled) === 1,
    defaultBrowserId: ns(row.default_browser_id),
    allowedBrowserIds: row.browser_ids_json ? (JSON.parse(s(row.browser_ids_json)) as string[]) : null,
    updatedAt: s(row.updated_at),
  };
}

function rowToRoom(row: Row): Room {
  return {
    id: s(row.id),
    projectId: s(row.project_id),
    environmentId: ns(row.environment_id),
    title: s(row.title),
    nextSequence: n(row.next_sequence),
    browserEnabled: n(row.browser_enabled) === 1,
    defaultBrowserId: ns(row.default_browser_id),
    allowedBrowserIds: row.browser_ids_json ? (JSON.parse(s(row.browser_ids_json)) as string[]) : null,
    consigliereId: ns(row.consigliere_participant_id),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

function rowToBrowser(row: Row): Browser {
  return { id: s(row.id), name: s(row.name), description: s(row.description), createdAt: s(row.created_at), updatedAt: s(row.updated_at) };
}

/** A stored look's parts; anything unreadable is no parts (the defaults). */
function parseLook(value: unknown): Look | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return null;
  }
}

function rowToParticipant(row: Row): Participant {
  return {
    id: s(row.id),
    roomId: s(row.room_id),
    alias: s(row.alias),
    modelSelection: JSON.parse(s(row.model_selection_json)),
    runtimeMode: s(row.runtime_mode) as Participant["runtimeMode"],
    interactionMode: s(row.interaction_mode) as Participant["interactionMode"],
    bindingGeneration: n(row.binding_generation),
    retiredAt: ns(row.retired_at),
    presetId: ns(row.preset_id),
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
    postNumber: row.post_number === null || row.post_number === undefined ? null : n(row.post_number),
    kind: s(row.kind) as RoomEvent["kind"],
    speaker: JSON.parse(s(row.speaker_json)),
    text: s(row.text),
    artifacts: JSON.parse(s(row.artifacts_json)),
    attachmentIds: JSON.parse(s(row.attachment_ids_json)),
    progress: JSON.parse(s(row.progress_json)),
    prompt: ns(row.prompt),
    to: ns(row.to_participant_id),
    outcome: ns(row.outcome) as RoomEvent["outcome"],
    sourceRef: sourceMessageId
      ? { threadId: s(row.source_thread_id), messageId: sourceMessageId, t3RunId: ns(row.source_t3_run_id) }
      : null,
    createdAt: s(row.created_at),
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
        `INSERT INTO rooms (id, project_id, environment_id, title, next_sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room.id, room.projectId, room.environmentId, room.title, room.nextSequence, room.createdAt, room.updatedAt);
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

  setRoomConsigliere(roomId: string, participantId: string | null, at: string): void {
    this.raw.prepare("UPDATE rooms SET consigliere_participant_id = ?, updated_at = ? WHERE id = ?").run(participantId, at, roomId);
  }

  setRoomBrowser(roomId: string, enabled: boolean, defaultBrowserId: string | null, at: string, allowedBrowserIds?: string[] | null): void {
    this.raw.prepare("UPDATE rooms SET browser_enabled = ?, default_browser_id = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, defaultBrowserId, at, roomId);
    if (allowedBrowserIds !== undefined) {
      this.raw.prepare("UPDATE rooms SET browser_ids_json = ? WHERE id = ?").run(allowedBrowserIds === null ? null : JSON.stringify(allowedBrowserIds), roomId);
    }
  }

  // ---- a thread's browsers ----

  getThreadBrowsers(threadId: string): ThreadBrowsers | null {
    const row = this.raw.prepare("SELECT * FROM thread_browsers WHERE thread_id = ?").get(threadId) as Row | undefined;
    return row ? rowToThreadBrowsers(row) : null;
  }

  /** The record of the thread whose id starts with `prefix` (a thread's browser key carries 8 characters of it). */
  findThreadBrowsers(prefix: string): ThreadBrowsers | null {
    const row = this.raw.prepare("SELECT * FROM thread_browsers WHERE substr(thread_id, 1, ?) = ? ORDER BY updated_at DESC LIMIT 1").get(prefix.length, prefix) as Row | undefined;
    return row ? rowToThreadBrowsers(row) : null;
  }

  setThreadBrowsers(record: ThreadBrowsers): void {
    this.raw
      .prepare(
        `INSERT INTO thread_browsers (thread_id, browser_enabled, default_browser_id, browser_ids_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET browser_enabled = excluded.browser_enabled, default_browser_id = excluded.default_browser_id,
           browser_ids_json = excluded.browser_ids_json, updated_at = excluded.updated_at`,
      )
      .run(record.threadId, record.browserEnabled ? 1 : 0, record.defaultBrowserId, record.allowedBrowserIds === null ? null : JSON.stringify(record.allowedBrowserIds), record.updatedAt);
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

  /**
   * Remove a room and everything stored for it, children first (foreign keys are enforced). Caller wraps in a
   * transaction. The rows to remove are found through the schema's foreign keys, so a database from before the engine
   * runtime, which keeps the old runtime's tables for a release (their rows point at the room, its members and their
   * bindings), loses those rows with the room, though nothing here names those tables.
   */
  deleteRoomCascade(roomId: string): void {
    this.deleteReferencing("rooms", "id = ?", [roomId], 0);
    this.raw.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  }

  /** Delete every row that references the rows of `table` matching `where`, deepest first, along the foreign keys. */
  private deleteReferencing(table: string, where: string, params: string[], depth: number): void {
    if (depth > 8) throw new Error(`deleteRoomCascade: foreign keys nest deeper than 8 under ${table}`);
    const references = this.raw
      .prepare(`SELECT m.name AS child, f."from" AS col, f."to" AS parent_col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f."table" = ?`)
      .all(table) as Array<{ child: string; col: string; parent_col: string | null }>;
    for (const { child, col, parent_col } of references) {
      // A key declared without its column references the parent's primary key.
      const key = parent_col ?? (this.raw.prepare("SELECT name FROM pragma_table_info(?) WHERE pk = 1").get(table) as { name: string } | undefined)?.name ?? "rowid";
      const match = `"${col}" IN (SELECT "${key}" FROM "${table}" WHERE ${where})`;
      this.deleteReferencing(child, match, params, depth + 1);
      this.raw.prepare(`DELETE FROM "${child}" WHERE ${match}`).run(...params);
    }
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

  /**
   * The number the room's next post takes: one more than its highest. Caller must be inside the transaction that
   * inserts the post (the write lock makes it the only writer; a unique index on room and number guards it besides).
   */
  nextPostNumber(roomId: string): number {
    const row = this.raw.prepare("SELECT COALESCE(MAX(post_number), 0) AS highest FROM events WHERE room_id = ?").get(roomId) as Row;
    return n(row.highest) + 1;
  }

  // ---- participants ----
  insertParticipant(p: Participant): void {
    this.raw
      .prepare(
        `INSERT INTO participants (id, room_id, alias, alias_key, model_selection_json,
           runtime_mode, interaction_mode, binding_generation, preset_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id, p.roomId, p.alias, p.alias.toLowerCase(),
        JSON.stringify(p.modelSelection), p.runtimeMode, p.interactionMode, p.bindingGeneration, p.presetId, p.createdAt, p.updatedAt,
      );
    if (p.retiredAt) this.updateParticipant(p);
  }

  updateParticipant(p: Participant): void {
    this.raw
      .prepare(
        `UPDATE participants SET alias = ?, alias_key = ?, model_selection_json = ?,
           runtime_mode = ?, interaction_mode = ?, binding_generation = ?, retired_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        // A retired participant releases its alias for reuse; the unique key is suffixed with its id.
        p.alias, p.retiredAt ? `${p.alias.toLowerCase()}#retired:${p.id}` : p.alias.toLowerCase(), JSON.stringify(p.modelSelection),
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

  /** In the order they were seated: members seated in the same millisecond by insertion (the room's alias index would give alias order). */
  listParticipants(roomId: string): Participant[] {
    return (this.raw.prepare("SELECT * FROM participants WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as Row[]).map(
      rowToParticipant,
    );
  }

  listAllParticipants(): Participant[] {
    return (this.raw.prepare("SELECT * FROM participants ORDER BY created_at, rowid").all() as Row[]).map(rowToParticipant);
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
        `INSERT INTO events (id, room_id, sequence, post_number, kind, speaker_json, text, artifacts_json, attachment_ids_json, progress_json, prompt,
           to_participant_id, outcome, source_thread_id, source_message_id, source_t3_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.roomId, e.sequence, e.postNumber, e.kind, JSON.stringify(e.speaker), e.text, JSON.stringify(e.artifacts), JSON.stringify(e.attachmentIds), JSON.stringify(e.progress), e.prompt, e.to, e.outcome,
        e.sourceRef?.threadId ?? null, e.sourceRef?.messageId ?? null, e.sourceRef?.t3RunId ?? null, e.createdAt,
      );
  }

  listEvents(roomId: string, fromSequence = 1, toSequence = Number.MAX_SAFE_INTEGER, limit = 5000): RoomEvent[] {
    return (
      this.raw
        .prepare("SELECT * FROM events WHERE room_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence LIMIT ?")
        .all(roomId, fromSequence, toSequence, limit) as Row[]
    ).map(rowToEvent);
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

  // ---- presets (participant settings under a name) ----
  private rowToPreset(row: Row): Preset {
    return {
      id: s(row.id),
      name: s(row.name),
      modelSelection: JSON.parse(s(row.model_selection_json)) as Preset["modelSelection"],
      runtimeMode: s(row.runtime_mode) as Preset["runtimeMode"],
      workspaceMode: s(row.workspace_mode) === "worktree" ? "worktree" : "local",
      look: resolveLook(s(row.id), parseLook(row.look_json)),
      description: s(row.description),
      createdAt: s(row.created_at),
      updatedAt: s(row.updated_at),
    };
  }

  /**
   * New presets go to the end of the list; an update keeps its place. `look` is the parts chosen, stored as given:
   * omitted, a new preset keeps the defaults and an update keeps the look it had.
   */
  upsertPreset(p: Preset, look?: Look): void {
    this.raw
      .prepare(
        `INSERT INTO presets (id, name, name_key, model_selection_json, runtime_mode, workspace_mode, look_json, description, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM presets), ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, model_selection_json = excluded.model_selection_json,
           runtime_mode = excluded.runtime_mode, workspace_mode = excluded.workspace_mode, look_json = COALESCE(excluded.look_json, presets.look_json),
           description = excluded.description, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.name, p.name.toLowerCase(), JSON.stringify(p.modelSelection), p.runtimeMode, p.workspaceMode, look ? JSON.stringify(look) : null, p.description, p.createdAt, p.updatedAt);
  }

  getPreset(id: string): Preset | null {
    const row = this.raw.prepare("SELECT * FROM presets WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToPreset(row) : null;
  }

  findPresetByName(name: string): Preset | null {
    const row = this.raw.prepare("SELECT * FROM presets WHERE name_key = ?").get(name.toLowerCase()) as Row | undefined;
    return row ? this.rowToPreset(row) : null;
  }

  listPresets(): Preset[] {
    return (this.raw.prepare("SELECT * FROM presets ORDER BY sort_order, created_at").all() as Row[]).map((row) => this.rowToPreset(row));
  }

  deleteKv(key: string): void {
    this.raw.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  deletePreset(id: string): boolean {
    return this.raw.prepare("DELETE FROM presets WHERE id = ?").run(id).changes > 0;
  }

  // ---- the harness sessions a thread has had ----
  rememberThreadSession(threadId: string, provider: string, sessionId: string): void {
    this.raw.prepare("INSERT OR IGNORE INTO thread_sessions (thread_id, provider, session_id, seen_at) VALUES (?, ?, ?, ?)").run(threadId, provider, sessionId, new Date().toISOString());
  }

  listThreadSessions(threadId: string): Array<{ provider: string; sessionId: string }> {
    return (this.raw.prepare("SELECT provider, session_id FROM thread_sessions WHERE thread_id = ? ORDER BY seen_at").all(threadId) as Row[]).map((row) => ({
      provider: s(row.provider),
      sessionId: s(row.session_id),
    }));
  }

  // ---- kv ----
  getKv(key: string): string | null {
    const row = this.raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? s(row.value) : null;
  }

  setKv(key: string, value: string): void {
    this.raw.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Every kv entry whose key starts with `prefix`. */
  listKv(prefix: string): Map<string, string> {
    const rows = this.raw.prepare("SELECT key, value FROM kv WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as Row[];
    return new Map(rows.map((row) => [s(row.key), s(row.value)]));
  }
}
