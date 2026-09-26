/** SQLite persistence using Node's built-in driver. WAL mode; migrations applied at open. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment_id TEXT,
    title TEXT NOT NULL,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    next_task_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    alias TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    spoken_aliases_json TEXT NOT NULL DEFAULT '[]',
    role TEXT,
    brief TEXT,
    model_selection_json TEXT NOT NULL,
    runtime_mode TEXT NOT NULL,
    interaction_mode TEXT NOT NULL DEFAULT 'default',
    binding_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (room_id, alias_key)
  );
  CREATE TABLE bindings (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    generation INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    delivered_cursor INTEGER NOT NULL DEFAULT 0,
    bootstrap_delivered_at TEXT,
    created_at TEXT NOT NULL,
    retired_at TEXT,
    UNIQUE (participant_id, generation)
  );
  CREATE INDEX idx_bindings_thread ON bindings(thread_id);
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    speaker_json TEXT NOT NULL,
    text TEXT NOT NULL,
    task_id TEXT,
    run_id TEXT,
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    source_thread_id TEXT,
    source_message_id TEXT,
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, sequence)
  );
  CREATE UNIQUE INDEX idx_events_source ON events(source_thread_id, source_message_id) WHERE source_message_id IS NOT NULL;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    number INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    source_event_id TEXT NOT NULL,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    instruction TEXT NOT NULL,
    source_text TEXT,
    schedule_mode TEXT NOT NULL,
    prerequisites_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    state_reason TEXT,
    current_run_id TEXT,
    user_outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (room_id, number)
  );
  CREATE INDEX idx_tasks_room_state ON tasks(room_id, state);
  CREATE TABLE task_revisions (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, revision)
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    task_revision INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    binding_id TEXT NOT NULL REFERENCES bindings(id),
    thread_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL UNIQUE,
    turn_id TEXT,
    status TEXT NOT NULL,
    briefing TEXT NOT NULL,
    included_from_sequence INTEGER NOT NULL,
    included_to_sequence INTEGER NOT NULL,
    interrupt_requested_at TEXT,
    accepted_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    result_event_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_runs_task ON runs(task_id, attempt);
  CREATE INDEX idx_runs_status ON runs(status);
  CREATE TABLE native_requests (
    participant_id TEXT NOT NULL REFERENCES participants(id),
    thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY (thread_id, request_id)
  );
  CREATE TABLE t3_command_log (
    command_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    thread_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `ALTER TABLE participants ADD COLUMN retired_at TEXT;`,
  `
  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    spoken_aliases_json TEXT NOT NULL DEFAULT '[]',
    role TEXT,
    brief TEXT,
    model_selection_json TEXT NOT NULL,
    runtime_mode TEXT NOT NULL,
    interaction_mode TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // Names stand for model configurations; roles are named rule sets assigned in the room.
  `
  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    rules TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE participants ADD COLUMN role_id TEXT;
  ALTER TABLE participants DROP COLUMN spoken_aliases_json;
  ALTER TABLE participants DROP COLUMN role;
  ALTER TABLE participants DROP COLUMN brief;
  ALTER TABLE presets DROP COLUMN spoken_aliases_json;
  ALTER TABLE presets DROP COLUMN role;
  ALTER TABLE presets DROP COLUMN brief;
  `,
  // Aliases are room-local handles for T3 threads; a global names library made no sense. Roles stay.
  `DROP TABLE IF EXISTS presets;`,
  // Image attachments: stored by the room so identical resends and retries deliver the same bytes.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_room ON attachments(room_id);
  ALTER TABLE tasks ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE events ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE events ADD COLUMN progress_json TEXT NOT NULL DEFAULT '[]';
  `,
  // Turns started directly in T3 on a participant's thread are mirrored into the timeline with their prompt.
  `ALTER TABLE events ADD COLUMN prompt TEXT;`,
  // Mid-turn delivery (steering): per task, and recorded on the run that was sent into a running turn.
  `
  ALTER TABLE tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'queue';
  ALTER TABLE runs ADD COLUMN steered INTEGER NOT NULL DEFAULT 0;
  `,
  // Sidebar order of rooms (drag to reorder); ties fall back to creation time.
  `ALTER TABLE rooms ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;`,
  // Tasks that run one of the harness's slash commands verbatim ("@claude /compact").
  `ALTER TABLE tasks ADD COLUMN slash_command INTEGER NOT NULL DEFAULT 0;`,
  // Rooms with a shared browser for their agents.
  `ALTER TABLE rooms ADD COLUMN browser_enabled INTEGER NOT NULL DEFAULT 0;`,
  // Browsers are a list named by purpose ("general", "t3-rooms-testing"); a room picks its default. Profiles and ports
  // live under data/browsers/<id>. "general" is the fallback default.
  `
  CREATE TABLE browsers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX browsers_name ON browsers(name);
  INSERT INTO browsers (id, name, description, created_at, updated_at)
    VALUES ('general', 'general', 'General browsing with no special logins. Use it unless the task calls for another browser.',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  ALTER TABLE rooms ADD COLUMN default_browser_id TEXT;
  `,
];

export class Database {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.raw.prepare("SELECT id FROM migrations").all() as Array<{ id: number }>).map((row) => row.id),
    );
    MIGRATIONS.forEach((sql, index) => {
      const id = index + 1;
      if (applied.has(id)) return;
      this.transaction(() => {
        this.raw.exec(sql);
        this.raw.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
      });
    });
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private inTransaction = false;

  close(): void {
    this.raw.close();
  }
}
