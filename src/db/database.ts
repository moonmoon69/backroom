/** SQLite persistence using Node's built-in driver. WAL mode; migrations applied at open. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Members seated before seats recorded their preset are matched to one where that is safe: their alias is the preset's
 * name, or the name with a number after it (sol, sol2), and they run on its harness. Exported for its test.
 */
export const LINK_SEATS_TO_PRESETS = `
  UPDATE participants SET preset_id = (
    SELECT p.id FROM presets p
    WHERE p.name_key = rtrim(lower(participants.alias), '0123456789')
      AND json_extract(p.model_selection_json, '$.instanceId') = json_extract(participants.model_selection_json, '$.instanceId')
  ) WHERE preset_id IS NULL;
`;

/** Posts made before posts had numbers of their own keep the one they had: their sequence (a migration of the events table). */
const NUMBER_EXISTING_POSTS = `
  UPDATE events SET post_number = sequence
  WHERE post_number IS NULL AND kind IN ('user.message', 'note', 'assistant.reply', 't3.turn', 't3.message', 'member.message');
`;

/**
 * The schema, one migration per entry, applied in order and recorded by number, so an entry never moves. The old
 * runtime's queue (its tasks, their revisions and its runs) is no longer created: a database from before the engine
 * runtime keeps those tables, which nothing reads or writes, and the entries that only changed them do nothing now.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment_id TEXT,
    title TEXT NOT NULL,
    next_sequence INTEGER NOT NULL DEFAULT 1,
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
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    source_thread_id TEXT,
    source_message_id TEXT,
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, sequence)
  );
  CREATE UNIQUE INDEX idx_events_source ON events(source_thread_id, source_message_id) WHERE source_message_id IS NOT NULL;
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
  ALTER TABLE events ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE events ADD COLUMN progress_json TEXT NOT NULL DEFAULT '[]';
  `,
  // Turns started directly in T3 on a participant's thread are mirrored into the timeline with their prompt.
  `ALTER TABLE events ADD COLUMN prompt TEXT;`,
  // Mid-turn delivery (steering) on the old runtime's queue.
  ``,
  // Sidebar order of rooms (drag to reorder); ties fall back to creation time.
  `ALTER TABLE rooms ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;`,
  // Slash commands on the old runtime's queue.
  ``,
  // Rooms with a shared browser for their agents.
  `ALTER TABLE rooms ADD COLUMN browser_enabled INTEGER NOT NULL DEFAULT 0;`,
  // Browsers are a list named by purpose ("general", "backroom-testing"); a room picks its default. Profiles and ports
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
  // Browsers a room may use; NULL means all of them.
  `ALTER TABLE rooms ADD COLUMN browser_ids_json TEXT;`,
  // Presets: a participant's settings under a name (model and its options, permission mode, role, where it works),
  // seated in a room or used to start a thread without choosing them again. Unlike the names library dropped above,
  // a preset is a starting point: the participant it seats is the room's own and can be renamed or changed.
  `
  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    model_selection_json TEXT NOT NULL,
    runtime_mode TEXT NOT NULL,
    role_id TEXT,
    workspace_mode TEXT NOT NULL DEFAULT 'local',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // The harness sessions a T3 thread has had. T3 keeps only a thread's current session; a thread's cost counts all.
  `
  CREATE TABLE thread_sessions (
    thread_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, session_id)
  );
  `,
  // Browsers for a thread outside rooms, chosen as a room chooses them: on or off, the default, the ones it may use.
  `
  CREATE TABLE thread_browsers (
    thread_id TEXT PRIMARY KEY,
    browser_enabled INTEGER NOT NULL DEFAULT 0,
    default_browser_id TEXT,
    browser_ids_json TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // T3's Orchestrator V2: a run's work in T3 is a run (it was a turn in V1), and its id is what Backroom keeps.
  `ALTER TABLE events RENAME COLUMN source_turn_id TO source_t3_run_id;`,
  // The board: who a member's message was sent to, and how a turn the room did not start ended.
  `
  ALTER TABLE events ADD COLUMN to_participant_id TEXT;
  ALTER TABLE events ADD COLUMN outcome TEXT;
  `,
  // The Consigliere: a mark on one member of a room.
  `ALTER TABLE rooms ADD COLUMN consigliere_participant_id TEXT;`,
  // Dismissing a failed task, on the old runtime's queue.
  ``,
  // Roles (named rule sets) are gone: the Consigliere's rules are an app setting, and what a member is to do travels
  // in the assignment itself.
  `
  DROP TABLE roles;
  ALTER TABLE participants DROP COLUMN role_id;
  ALTER TABLE presets DROP COLUMN role_id;
  `,
  // A crew member's pixel look (named parts, JSON; NULL for the defaults), and the preset a member was seated as, so
  // every seat of a crew member wears its look. Members seated before are matched to a preset where that is safe:
  // their alias is the preset's name, or the name with a number after it (sol, sol2), and they run on its harness.
  `
  ALTER TABLE presets ADD COLUMN look_json TEXT;
  ALTER TABLE participants ADD COLUMN preset_id TEXT;
  ${LINK_SEATS_TO_PRESETS}
  `,
  // Posts get a number of their own, which only posts take, so the board counts without the gaps that status lines
  // and system notes left. Posts made before keep the number they had (their sequence), since replies cite them; the
  // next post in a room takes its highest post number plus one. Unique per room, as the guard against two at once.
  `
  ALTER TABLE events ADD COLUMN post_number INTEGER;
  ${NUMBER_EXISTING_POSTS}
  CREATE UNIQUE INDEX events_post_number ON events(room_id, post_number) WHERE post_number IS NOT NULL;
  `,
  // A crew member's one-sentence description, read by the Consigliere when he seats; empty for the ones saved before.
  `ALTER TABLE presets ADD COLUMN description TEXT NOT NULL DEFAULT '';`,
  // What a project's new rooms start with, chosen as a room's browsers are: on or off, the default, the ones they may use.
  `
  CREATE TABLE IF NOT EXISTS project_browsers (
    project_id TEXT PRIMARY KEY,
    browser_enabled INTEGER NOT NULL DEFAULT 0,
    default_browser_id TEXT,
    browser_ids_json TEXT,
    updated_at TEXT NOT NULL
  );
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
