import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EntryOverlay, journalHistory, projectionMaps, ProjectionOverlay } from "./incremental.ts";
import { applyEvent, fold } from "./fold.ts";
import { decideProjection } from "./transitions.ts";
import { operationKey, parseActivity, parseOperation, validateCapability } from "./operations.ts";
import { handleOwnershipKey, validateScopedHandleHistory } from "./declared.ts";
import { canonicalJSON } from "./result.ts";
import type { ActivityPacket, ActivityReceipt, LocalOperationPacket, OperationReceipt } from "./operation-types.ts";
import type { Command, Decision, Projection, RoomEvent } from "./types.ts";

/** Fault hooks are synchronous, optional test instrumentation; they do no dispatch. */
export type StoreBoundary = "before_begin" | "after_begin" | "after_read" | "after_decide"
  | "after_event" | "after_events" | "after_index_delete" | "after_projection"
  | "after_indices" | "before_commit" | "after_commit" | "after_suffix_load"
  | "after_affected_first" | "after_affected_last" | "after_head" | "before_cache_publish" | "after_cache_publish";
export interface StoreOptions {
  busyTimeoutMs?: number;
  onBoundary?: (boundary: StoreBoundary, eventIndex?: number) => void;
}
export interface CommitReceipt extends Decision {
  /** Current committed head; a replay returns the original batch and expectedSeq. */
  head: number;
  replayed: boolean;
}

const TABLES = ["engine_event", "engine_head", "engine_command", "engine_projection", "engine_key"];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_event (
  room TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), id TEXT NOT NULL,
  command_key TEXT NOT NULL, command_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('appended','blocked')),
  batch_start INTEGER NOT NULL, batch_size INTEGER NOT NULL CHECK(batch_size > 0),
  source_digest TEXT, data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(room,seq), UNIQUE(room,id)
) STRICT;
CREATE INDEX IF NOT EXISTS engine_event_command ON engine_event(room,command_key);
CREATE TRIGGER IF NOT EXISTS engine_event_no_update BEFORE UPDATE ON engine_event
BEGIN SELECT RAISE(ABORT,'engine log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS engine_event_no_delete BEFORE DELETE ON engine_event
BEGIN SELECT RAISE(ABORT,'engine log is append-only'); END;
CREATE TABLE IF NOT EXISTS engine_head (room TEXT PRIMARY KEY, seq INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE IF NOT EXISTS engine_command (
  room TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, expected_seq INTEGER NOT NULL,
  outcome TEXT NOT NULL, first_seq INTEGER NOT NULL, event_count INTEGER NOT NULL,
  PRIMARY KEY(room,key)
) STRICT;
CREATE TABLE IF NOT EXISTS engine_projection (
  room TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
  PRIMARY KEY(room,kind,id)
) STRICT;
CREATE TABLE IF NOT EXISTS engine_key (
  room TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT,
  PRIMARY KEY(room,kind,key)
) STRICT;
`;

/** Canonical JSON preserves array order, ignores object property order and rejects lossy values. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("store boundary requires lossless JSON values");
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function sourceDigest(command: Command): string | null {
  if (command.type !== "output") return null;
  // Receipt exposure / turn-end observations can arrive later for this same emission.
  // Its content, association, explicit disposition and activity completion remain immutable.
  return digest({ author: command.author, association: command.association, body: command.body,
    disposition: command.disposition, activityCompletion: command.activityCompletion ?? null });
}

interface StoredRow {
  seq: number; id: string; command_key: string; command_digest: string;
  outcome: "appended" | "blocked"; batch_start: number; batch_size: number;
  source_digest: string | null; data: string;
}
interface CommandRow {
  key: string; digest: string; expected_seq: number; outcome: "appended" | "blocked";
  first_seq: number; event_count: number;
}
interface ProjectionRow { kind: string; id: string; value: string }
interface KeyRow { kind: string; key: string; owner: string; digest: string | null }
interface Derived {
  log: RoomEvent[]; p: Projection; commands: CommandRow[]; projections: ProjectionRow[]; keys: KeyRow[];
}

function derive(rows: StoredRow[]): Derived {
  const log = rows.map((r) => ({ id: r.id, seq: r.seq, commandKey: r.command_key, data: JSON.parse(r.data) })) as RoomEvent[];
  const p = fold(log);
  const commands: CommandRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length;) {
    const first = rows[i]!;
    if (first.batch_start !== first.seq || seen.has(first.command_key) || !/^[a-f0-9]{64}$/.test(first.command_digest)) {
      throw new Error("invalid log batch provenance");
    }
    const batch = rows.slice(i, i + first.batch_size);
    if (batch.length !== first.batch_size || batch.some((r) => r.command_key !== first.command_key
      || r.command_digest !== first.command_digest || r.outcome !== first.outcome
      || r.batch_start !== first.batch_start || r.batch_size !== first.batch_size)) throw new Error("incomplete log batch");
    seen.add(first.command_key);
    commands.push({ key: first.command_key, digest: first.command_digest, expected_seq: first.seq - 1,
      outcome: first.outcome, first_seq: first.seq, event_count: first.batch_size });
    i += first.batch_size;
  }
  const projections: ProjectionRow[] = [];
  const addProjection = (kind: string, id: string, value: unknown) => projections.push({ kind, id, value: canonical(value) });
  for (const kind of ["seats", "requests", "runs", "activities", "controls", "blocked", "providerHolds", "providerObservations", "capabilities", "activityReceipts", "operationReceipts", "operationBindings", "toolResults", "toolClosures"] as const) {
    for (const [id, value] of p[kind]) addProjection(kind, id, value);
  }
  for (const s of p.subscriptions) addProjection("subscriptions", JSON.stringify([s.seatId, s.requestId]), s);
  if (log.length) addProjection("room", "metadata", { orchestrator: p.orchestrator });
  const keys: KeyRow[] = [];
  const keySet = new Set<string>();
  const addKey = (kind: string, key: string, owner: string, fingerprint: string | null = null) => {
    const identity = JSON.stringify([kind, key]);
    if (keySet.has(identity)) throw new Error(`duplicate ${kind} identity`);
    keySet.add(identity); keys.push({ kind, key, owner, digest: fingerprint });
  };
  for (const s of p.seats.values()) addKey("thread", s.threadId, s.id);
  for (const r of p.runs.values()) {
    if (r.providerRunId) addKey("provider-run", r.providerRunId, r.id);
    addKey("provider-command", r.dispatchCommandId, r.id);
    addKey("dispatch-message", r.dispatchMessageId, r.id);
    if (r.phase !== "terminal") addKey("reservation", r.seatId, r.id);
    for (const receipt of r.receipts) addKey("sync-receipt", receipt.id, r.id);
  }
  for (const r of p.operationReceipts.values()) addKey("operation-receipt", r.key, r.clientId);
  for (const r of p.activityReceipts.values()) addKey("activity-receipt", r.key, r.packet.intent.clientId);
  for (const a of p.activities.values()) if (a.declaration?.binding)
    addKey("declared-handle", a.declaration.binding.ownershipKey, a.id, digest(a.declaration.registration));
  for (const c of p.capabilities.values()) addKey("capability", c.id, c.runId);
  for (const c of p.controls.values()) addKey("provider-command", c.commandId, c.id);
  for (const r of p.requests.values()) if (r.answerId !== null) addKey("claim", r.id, r.answerId);
  for (const [source, id] of p.sourceKeys) {
    const index = log.findIndex((e) => e.id === id);
    addKey("source", source, id, rows[index]!.source_digest);
  }
  return { log, p, commands, projections, keys };
}

const PROJECTION_VERSION = 1;
interface Cache {
  room: string; connection: symbol; version: number; head: number; dataVersion: number; audited: boolean;
  p: Projection; rows: StoredRow[]; commands: Map<string, CommandRow>; projections: Map<string, ProjectionRow>; keys: Map<string, KeyRow>;
}
interface Working {
  base: Cache; overlay: ProjectionOverlay; rows: StoredRow[]; dataVersion: number; audited: boolean; indexBaseP: Projection;
  commands: EntryOverlay<string, CommandRow>; projections: EntryOverlay<string, ProjectionRow>; keys: EntryOverlay<string, KeyRow>;
}
function projectionIdentity(r: Pick<ProjectionRow, "kind" | "id">): string { return JSON.stringify([r.kind, r.id]); }
function keyIdentity(r: Pick<KeyRow, "kind" | "key">): string { return JSON.stringify([r.kind, r.key]); }
function commandRow(r: StoredRow): CommandRow {
  return { key: r.command_key, digest: r.command_digest, expected_seq: r.seq - 1, outcome: r.outcome, first_seq: r.seq, event_count: r.batch_size };
}
function eventFrom(r: StoredRow): RoomEvent { return { id: r.id, seq: r.seq, commandKey: r.command_key, data: JSON.parse(r.data) }; }
function validateBatch(batch: StoredRow[], expected: number, commands: Map<string, CommandRow>): void {
  const first = batch[0];
  if (!first || first.batch_start !== expected || first.seq !== expected || commands.has(first.command_key)
    || !Number.isSafeInteger(first.batch_size) || first.batch_size < 1 || batch.length !== first.batch_size
    || !/^[a-f0-9]{64}$/.test(first.command_digest)) throw new Error("invalid log batch provenance");
  if (batch.some((r, i) => r.seq !== expected + i || r.command_key !== first.command_key
    || r.command_digest !== first.command_digest || r.outcome !== first.outcome || r.batch_start !== first.batch_start
    || r.batch_size !== first.batch_size || !["appended", "blocked"].includes(r.outcome))) throw new Error("incomplete log batch");
}
function cacheFrom(room: string, connection: symbol, dataVersion: number, d: Derived): Cache {
  return { room, connection, version: PROJECTION_VERSION, head: d.log.length, dataVersion, audited: false, p: d.p,
    rows: [], commands: new Map(d.commands.map((r) => [r.key, r])), projections: new Map(d.projections.map((r) => [projectionIdentity(r), r])), keys: new Map(d.keys.map((r) => [keyIdentity(r), r])) };
}
function publishEntries<K, V>(overlay: EntryOverlay<K, V>): void {
  let map: Map<K, V> = overlay;
  while (map instanceof EntryOverlay) { map.publish(); map = map.base; }
}
function entryKeys(kind: typeof projectionMaps[number], id: string, value: unknown, source: (id: string) => string | null): KeyRow[] {
  if (value === undefined) return [];
  const rows: KeyRow[] = [], add = (kind: string, key: string, owner: string, digest: string | null = null) => rows.push({ kind, key, owner, digest });
  if (kind === "seats") { const s = value as import("./types.ts").Seat; add("thread", s.threadId, s.id); }
  if (kind === "runs") {
    const r = value as import("./types.ts").Run;
    if (r.providerRunId) add("provider-run", r.providerRunId, r.id);
    add("provider-command", r.dispatchCommandId, r.id); add("dispatch-message", r.dispatchMessageId, r.id);
    if (r.phase !== "terminal") add("reservation", r.seatId, r.id);
    for (const receipt of r.receipts) add("sync-receipt", receipt.id, r.id);
  }
  if (kind === "activities") {
    const a = value as import("./types.ts").Activity;
    if (a.declaration?.binding) add("declared-handle", a.declaration.binding.ownershipKey, a.id, digest(a.declaration.registration));
  }
  if (kind === "operationReceipts") { const r = value as OperationReceipt; add("operation-receipt", r.key, r.clientId); }
  if (kind === "activityReceipts") { const r = value as ActivityReceipt; add("activity-receipt", r.key, r.packet.intent.clientId); }
  if (kind === "capabilities") { const c = value as import("./operation-types.ts").RunCapability; add("capability", c.id, c.runId); }
  if (kind === "controls") { const c = value as import("./types.ts").Control; add("provider-command", c.commandId, c.id); }
  if (kind === "requests") { const r = value as import("./types.ts").Request; if (r.answerId !== null) add("claim", r.id, r.answerId); }
  if (kind === "sourceKeys") add("source", id, value as string, source(value as string));
  return rows;
}

/**
 * Dedicated SQLite event store. No imports/callers in the active application.
 * Only log records (including immutable batch provenance) are authoritative.
 * The four other tables can be deleted and rebuilt from engine_event alone.
 */
export class EngineStore {
  private readonly db: DatabaseSync;
  private readonly options: StoreOptions;
  private readonly connection = Symbol("engine connection");
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private readonly caches = new Map<string, Cache>();
  private staged = new Map<string, Working>();
  private inTransaction = false;
  private expectedChanges = 0;
  private activeExpected = 0;

  constructor(path: string, options: StoreOptions = {}) {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) throw new Error("invalid SQLite busy timeout");
    this.options = options;
    this.db = new DatabaseSync(path);
    try {
      const existing = this.sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (existing.some((r) => !TABLES.includes(r.name))) throw new Error("engine store requires a dedicated database");
      this.db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(SCHEMA);
        const columns = this.sql("PRAGMA table_info(engine_head)").all() as { name: string }[];
        if (!columns.some((c) => c.name === "version")) this.db.exec(`ALTER TABLE engine_head ADD COLUMN version INTEGER NOT NULL DEFAULT ${PROJECTION_VERSION}`);
        this.db.exec("COMMIT");
      } catch (e) { this.db.exec("ROLLBACK"); throw e; }
      this.expectedChanges = this.totalChanges();
    } catch (error) { this.db.close(); throw error; }
  }
  private sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }
  private totalChanges(): number { return (this.sql("SELECT total_changes() AS n").get() as { n: number }).n; }
  private dataVersion(): number { return (this.sql("PRAGMA data_version").get() as { data_version: number }).data_version; }
  private checkWrites(): void { if (this.totalChanges() !== this.activeExpected) throw new Error("unexplained connection writes; journal audit required"); }
  private write(sql: string, ...values: (string | number | null)[]): void {
    this.checkWrites();
    const result = this.sql(sql).run(...values);
    this.activeExpected += Number(result.changes);
    this.checkWrites();
  }
  private boundary(point: StoreBoundary, index?: number): void {
    const before = this.totalChanges();
    this.options.onBoundary?.(point, index);
    if (this.totalChanges() !== before) throw new Error("unexplained fault-hook writes; journal audit required");
    if (this.inTransaction) this.checkWrites();
  }
  /** An unexplained private-connection write is audited, never silently adopted as expected work. */
  private recoverOwnChanges(allowHeadRepair?: string): void {
    const actual = this.totalChanges();
    this.activeExpected = actual;
    if (actual === this.expectedChanges) return;
    const rooms = this.sql("SELECT room FROM engine_event UNION SELECT room FROM engine_head UNION SELECT room FROM engine_command UNION SELECT room FROM engine_projection UNION SELECT room FROM engine_key").all() as { room: string }[];
    for (const { room } of rooms) {
      // Keep independently verified history: an unchanged prefix needs comparison,
      // not another fold. Uncached rooms still require cold authoritative replay.
      this.working(room, true, true, allowHeadRepair);
    }
    // Rebase only after every stored room has passed authoritative replay and derived-row audit.
    this.checkWrites(); this.expectedChanges = this.activeExpected;
  }
  private transaction<T>(mode: "IMMEDIATE" | "DEFERRED", body: () => T, instrument = false, allowHeadRepair?: string): T {
    if (this.inTransaction) throw new Error("store transaction reentry is not supported");
    if (instrument) this.boundary("before_begin");
    this.db.exec(`BEGIN ${mode}`); this.inTransaction = true; this.staged = new Map();
    let committed = false, recovered = false;
    const initialExpected = this.expectedChanges, initialActual = this.totalChanges();
    this.activeExpected = initialActual;
    try {
      if (mode === "IMMEDIATE") this.recoverOwnChanges(allowHeadRepair);
      recovered = true;
      if (instrument) this.boundary("after_begin");
      const result = body();
      if (instrument) this.boundary("before_commit");
      this.checkWrites(); this.db.exec("COMMIT"); committed = true;
      if (mode === "IMMEDIATE") this.expectedChanges = this.activeExpected;
      if (instrument) { this.boundary("after_commit"); this.boundary("before_cache_publish"); }
      // No shared maps, event arrays or canonical row caches are published before durable commit.
      for (const [room, w] of this.staged) {
        w.overlay.publish(); publishEntries(w.commands); publishEntries(w.projections); publishEntries(w.keys);
        w.base.rows.push(...w.rows); w.base.head = w.base.p.events.length;
        w.base.dataVersion = w.dataVersion; w.base.audited = w.audited;
        this.caches.set(room, w.base);
      }
      if (instrument) this.boundary("after_cache_publish");
      return structuredClone(result);
    } catch (error) {
      this.caches.clear();
      if (!committed) {
        // COMMIT may have succeeded before reporting an error. Keep the original
        // uncertainty and discard RAM even if SQLite has already ended the transaction.
        try { this.db.exec("ROLLBACK"); } catch { /* reopen/replay resolves an ambiguous commit */ }
        // SQLite total_changes includes rolled-back writes. Count only writes we actually planned.
        if (mode === "IMMEDIATE") this.expectedChanges = recovered ? this.activeExpected : initialExpected + this.activeExpected - initialActual;
      }
      throw error;
    } finally { this.inTransaction = false; this.staged.clear(); }
  }
  private rows(room: string, after = 0): StoredRow[] {
    return this.sql("SELECT seq,id,command_key,command_digest,outcome,batch_start,batch_size,source_digest,data FROM engine_event WHERE room=? AND seq>? ORDER BY seq").all(room, after) as unknown as StoredRow[];
  }
  private headInfo(room: string): { seq: number; version: number } | undefined {
    return this.sql("SELECT seq,version FROM engine_head WHERE room=?").get(room) as { seq: number; version: number } | undefined;
  }
  private journalHead(room: string): number {
    return (this.sql("SELECT seq FROM engine_event WHERE room=? ORDER BY seq DESC LIMIT 1").get(room) as { seq: number } | undefined)?.seq ?? 0;
  }
  private coldCache(room: string, dataVersion: number): Cache {
    const rows = this.rows(room), cache = cacheFrom(room, this.connection, dataVersion, derive(rows));
    cache.rows = rows; return cache;
  }
  private compareIndices(room: string, d: Pick<Cache, "head" | "commands" | "projections" | "keys">): string[] {
    const mismatches: string[] = [], head = this.headInfo(room);
    if ((head?.seq ?? 0) !== d.head) mismatches.push("head");
    if (head && head.version !== PROJECTION_VERSION) mismatches.push("version");
    const compare = <T>(name: string, sql: string, expected: Map<string, T>, identity: (row: T) => string) => {
      const actual = this.sql(sql).all(room) as unknown as T[];
      if (actual.length !== expected.size || actual.some((r) => canonical(r) !== canonical(expected.get(identity(r)) ?? null))) mismatches.push(name);
    };
    compare("commands", "SELECT key,digest,expected_seq,outcome,first_seq,event_count FROM engine_command WHERE room=?", d.commands, (r) => r.key);
    compare("projections", "SELECT kind,id,value FROM engine_projection WHERE room=?", d.projections, projectionIdentity);
    compare("constraints", "SELECT kind,key,owner,digest FROM engine_key WHERE room=?", d.keys, keyIdentity);
    return mismatches;
  }
  private replaceIndices(room: string, d: Derived, instrument: boolean): void {
    for (const table of TABLES.slice(1)) this.write(`DELETE FROM ${table} WHERE room=?`, room);
    if (instrument) this.boundary("after_index_delete");
    this.write("INSERT INTO engine_head(room,seq,version) VALUES (?,?,?)", room, d.log.length, PROJECTION_VERSION);
    for (const r of d.commands) this.write("INSERT INTO engine_command VALUES (?,?,?,?,?,?,?)", room, r.key, r.digest, r.expected_seq, r.outcome, r.first_seq, r.event_count);
    for (const r of d.projections) {
      this.write("INSERT INTO engine_projection VALUES (?,?,?,?)", room, r.kind, r.id, r.value);
      if (instrument) this.boundary("after_projection");
    }
    for (const r of d.keys) this.write("INSERT INTO engine_key VALUES (?,?,?,?,?)", room, r.kind, r.key, r.owner, r.digest);
    if (instrument) this.boundary("after_indices");
  }
  private working(room: string, repair = true, forceAudit = false, allowHeadRepair?: string): Working {
    const prior = this.staged.get(room); if (prior) return prior;
    const version = this.dataVersion(), actualHead = this.journalHead(room), head = this.headInfo(room);
    if (repair && head && head.seq !== actualHead && room !== allowHeadRepair) throw new Error("room head index mismatch; rebuild required");
    if (repair && head && head.version !== PROJECTION_VERSION && room !== allowHeadRepair) throw new Error("incompatible projection version");
    let base = this.caches.get(room), cold = false;
    if (!base || base.connection !== this.connection || base.room !== room || base.version !== PROJECTION_VERSION || base.head > actualHead) {
      if (base && base.head > actualHead) throw new Error("authoritative journal moved backwards");
      base = this.coldCache(room, version); cold = true;
    }
    const w: Working = { base, overlay: new ProjectionOverlay(base.p), commands: new EntryOverlay(base.commands), projections: new EntryOverlay(base.projections),
      keys: new EntryOverlay(base.keys), rows: [], dataVersion: version, audited: base.audited, indexBaseP: base.p };
    this.staged.set(room, w);
    const foreign = base.dataVersion !== version;
    if (!cold && (foreign || forceAudit)) {
      // An append-only trigger cannot hide schema tampering or edits to a previously verified prefix.
      const prefix = this.sql("SELECT seq,id,command_key,command_digest,outcome,batch_start,batch_size,source_digest,data FROM engine_event WHERE room=? AND seq<=? ORDER BY seq").all(room, base.head) as unknown as StoredRow[];
      if (prefix.length !== base.rows.length || prefix.some((r, i) => canonical(r) !== canonical(base!.rows[i]))) throw new Error("authoritative journal prefix changed");
    }
    if (base.head < actualHead) {
      const suffix = this.rows(room, base.head); this.replaySuffix(w, suffix);
      this.boundary("after_suffix_load");
      if (w.overlay.p.events.length !== actualHead) throw new Error("incomplete authoritative suffix");
    }
    if (cold || foreign || forceAudit || !base.audited || !head && actualHead > 0) {
      const expected = { head: actualHead, commands: w.commands, projections: w.projections, keys: w.keys };
      const mismatches = this.compareIndices(room, expected);
      if (repair && mismatches.length) {
        // Full replacement is deliberately exceptional: cold recovery, corruption or explicit rebuild.
        this.replaceIndices(room, { log: Array.from(w.overlay.p.events), p: w.overlay.p,
          commands: [...w.commands.values()], projections: [...w.projections.values()], keys: [...w.keys.values()] }, false);
      }
      w.audited = !mismatches.length || repair;
    }
    // Freeze the SQL baseline at the verified winning head. Subsequent effects have their own row overlays.
    w.indexBaseP = w.overlay.p;
    w.commands = new EntryOverlay(w.commands); w.projections = new EntryOverlay(w.projections); w.keys = new EntryOverlay(w.keys);
    return w;
  }
  private replaySuffix(w: Working, rows: StoredRow[]): void {
    const start = w.overlay.p.events.length;
    for (let i = 0; i < rows.length;) {
      const first = rows[i]!, batch = rows.slice(i, i + first.batch_size);
      validateBatch(batch, start + i + 1, w.commands);
      const receipt = commandRow(first); w.commands.set(receipt.key, receipt);
      for (const row of batch) {
        const event = eventFrom(row); w.rows.push(row); w.overlay.events.push(event); applyEvent(w.overlay.p, event);
      }
      i += batch.length;
    }
    this.updateDerived(w);
  }
  private updateDerived(w: Working): void {
    const p = w.overlay.p;
    const previousKeys: KeyRow[] = [], nextKeys: KeyRow[] = [];
    w.keys.discardChanges();
    const sourceRow = (id: string) => {
      const event = journalHistory(p).events.get(id)!;
      return event.seq <= w.base.head ? w.base.rows[event.seq - 1]! : w.rows[event.seq - w.base.head - 1]!;
    };
    for (const kind of projectionMaps) for (const id of w.overlay.affected(kind)) {
      const before = w.indexBaseP[kind].get(id), after = p[kind].get(id);
      if (kind !== "sourceKeys") {
        const identity = projectionIdentity({ kind, id });
        if (after === undefined) w.projections.delete(identity);
        else w.projections.set(identity, { kind, id, value: canonical(after) });
      }
      previousKeys.push(...entryKeys(kind, id, before, (eventId) => sourceRow(eventId).source_digest));
      nextKeys.push(...entryKeys(kind, id, after, (eventId) => sourceRow(eventId).source_digest));
    }
    for (const r of previousKeys) w.keys.delete(keyIdentity(r));
    for (const r of nextKeys) {
      const identity = keyIdentity(r);
      if (w.keys.has(identity)) throw new Error(`duplicate ${r.kind} identity`);
      w.keys.set(identity, r);
    }
    if (p.subscriptions !== w.indexBaseP.subscriptions) {
      for (const s of w.indexBaseP.subscriptions) w.projections.delete(projectionIdentity({ kind: "subscriptions", id: JSON.stringify([s.seatId, s.requestId]) }));
      for (const s of p.subscriptions) { const id = JSON.stringify([s.seatId, s.requestId]); w.projections.set(projectionIdentity({ kind: "subscriptions", id }), { kind: "subscriptions", id, value: canonical(s) }); }
    }
    if (p.events.length) w.projections.set(projectionIdentity({ kind: "room", id: "metadata" }), { kind: "room", id: "metadata", value: canonical({ orchestrator: p.orchestrator }) });
  }
  private affectedIndices(room: string, w: Working): void {
    let affected = 0;
    const mark = () => { if (++affected === 1) this.boundary("after_affected_first"); };
    const changed = <T>(map: EntryOverlay<string, T>) => [...map.changes.keys()].filter((k) => canonical(map.base.get(k) ?? null) !== canonical(map.get(k) ?? null));
    const commandKeys = changed(w.commands), projectionKeys = changed(w.projections), constraintKeys = changed(w.keys);
    for (const k of constraintKeys) if (!w.keys.has(k)) { const old = w.keys.base.get(k)!; this.write("DELETE FROM engine_key WHERE room=? AND kind=? AND key=?", room, old.kind, old.key); mark(); }
    // Retain original fault labels at the equivalent affected-removal/projection phases.
    this.boundary("after_index_delete");
    for (const k of commandKeys) {
      const r = w.commands.get(k)!;
      this.write("INSERT INTO engine_command VALUES (?,?,?,?,?,?,?)", room, r.key, r.digest, r.expected_seq, r.outcome, r.first_seq, r.event_count); mark();
    }
    for (const k of projectionKeys) {
      const r = w.projections.get(k);
      if (!r) { const old = w.projections.base.get(k)!; this.write("DELETE FROM engine_projection WHERE room=? AND kind=? AND id=?", room, old.kind, old.id); }
      else this.write("INSERT INTO engine_projection VALUES (?,?,?,?) ON CONFLICT(room,kind,id) DO UPDATE SET value=excluded.value", room, r.kind, r.id, r.value);
      mark(); this.boundary("after_projection");
    }
    if (!projectionKeys.length) this.boundary("after_projection");
    for (const k of constraintKeys) if (w.keys.has(k)) {
      const r = w.keys.get(k)!;
      this.write("INSERT INTO engine_key VALUES (?,?,?,?,?) ON CONFLICT(room,kind,key) DO UPDATE SET owner=excluded.owner,digest=excluded.digest", room, r.kind, r.key, r.owner, r.digest); mark();
    }
    if (affected) this.boundary("after_affected_last");
    this.boundary("after_indices");
    this.write("INSERT INTO engine_head(room,seq,version) VALUES (?,?,?) ON CONFLICT(room) DO UPDATE SET seq=excluded.seq,version=excluded.version", room, w.overlay.p.events.length, PROJECTION_VERSION);
    this.boundary("after_head");
  }

  execute(room: string, command: Command): CommitReceipt {
    if (!room.length) throw new Error("room identity required");
    const frozen = JSON.parse(canonical(command)) as Command;
    const fingerprint = digest(frozen);
    return this.transaction("IMMEDIATE", () => this.executeLocked(room, frozen, fingerprint), true);
  }
  private executeLocked(room: string, frozen: Command, fingerprint = digest(frozen)): CommitReceipt {
    const w = this.working(room), p = w.overlay.p;
    this.boundary("after_read");
    // Committed exact commands recover their original batch before constraints
    // on NEW ownership/transport effects inspect the command's own tombstones.
    const key = JSON.stringify([frozen.actor, frozen.id]), prior = w.commands.get(key);
    if (prior) {
      if (prior.digest !== fingerprint) throw new Error("conflicting command identity reuse");
      return { expectedSeq: prior.expected_seq, events: p.events.slice(prior.first_seq - 1, prior.first_seq - 1 + prior.event_count), outcome: prior.outcome, head: p.events.length, replayed: true };
    }
    this.validateActivityOwnership(room, p, frozen);
    if (frozen.type === "freeze_transport") {
      const wire = JSON.parse(frozen.transport.wireJSON) as { commandId: string; messageId?: string };
      for (const { room: other } of this.sql("SELECT DISTINCT room FROM engine_event WHERE room<>?").all(room) as { room: string }[]) {
        const otherProjection = this.working(other).overlay.p;
        const transports = [...otherProjection.runs.values(), ...otherProjection.controls.values()].flatMap((r) => r.transport ? [r.transport] : []);
        if (transports.some((t) => t.environmentId === frozen.transport.environmentId && (() => {
          const previous = JSON.parse(t.wireJSON) as { commandId: string; messageId?: string };
          return previous.commandId === wire.commandId || wire.messageId !== undefined && previous.messageId === wire.messageId;
        })())) throw new Error("provider command/message identity reused across rooms");
      }
    }
    if (frozen.type === "output") {
      const source = w.keys.get(keyIdentity({ kind: "source", key: frozen.sourceKey }));
      if (source && source.digest !== sourceDigest(frozen)) throw new Error("conflicting provider source identity reuse");
    }
    let registrationHistory: Record<string, number> | undefined;
    if (frozen.type === "activity_operation" && frozen.packet.intent.schema === "backroom.activity.v2"
      && frozen.packet.intent.operation === "register_activity") {
      registrationHistory = Object.fromEntries((this.sql("SELECT DISTINCT room FROM engine_event WHERE room<>?").all(room) as { room: string }[])
        .map(({ room: knownRoom }) => [knownRoom, this.working(knownRoom).overlay.p.events.length]));
    }
    const decision = decideProjection(w.overlay, frozen, undefined, registrationHistory);
    if (decision.expectedSeq !== p.events.length) throw new Error("decision head mismatch");
    this.boundary("after_decide");
    for (const [index, event] of decision.events.entries()) {
      const row: StoredRow = { seq: event.seq, id: event.id, command_key: event.commandKey, command_digest: fingerprint,
        outcome: decision.outcome as "appended" | "blocked", batch_start: decision.expectedSeq + 1, batch_size: decision.events.length,
        source_digest: event.data.kind === "output" ? sourceDigest(frozen) : null, data: JSON.stringify(event.data) };
      this.write("INSERT INTO engine_event VALUES (?,?,?,?,?,?,?,?,?,?)", room, row.seq, row.id, row.command_key, row.command_digest, row.outcome, row.batch_start, row.batch_size, row.source_digest, row.data);
      w.rows.push(row); this.boundary("after_event", index);
    }
    this.boundary("after_events");
    if (decision.events.length) {
      w.commands.set(key, { key, digest: fingerprint, expected_seq: decision.expectedSeq, outcome: decision.outcome as "appended" | "blocked", first_seq: decision.expectedSeq + 1, event_count: decision.events.length });
      this.updateDerived(w); this.affectedIndices(room, w);
    }
    return { ...decision, head: decision.expectedSeq + decision.events.length, replayed: false };
  }

  /** Rare store-wide check, serialized with all ownership writers. The journal is
   * the authority for both retained observations and settled ownership tombstones. */
  private validateActivityOwnership(room: string, p: Projection, command: Command): void {
    const requestIds = command.type === "local_operation" && command.packet.intent.operation === "finish"
      && command.packet.intent.disposition.kind === "answer" ? command.packet.intent.disposition.requestIds
      : command.type === "output" && command.disposition.kind === "answer" ? command.disposition.requestIds : null;
    if (requestIds) {
      const declared = [...p.activities.values()].filter((a) => a.declaration?.binding && a.requestIds.some((id) => requestIds.includes(id)));
      // Local conflicts already produce the established pending_activity receipt.
      // Foreign known history must fence a fresh claim before committing effects.
      if (declared.length) for (const { room: knownRoom } of this.sql("SELECT DISTINCT room FROM engine_event WHERE room<>?").all(room) as { room: string }[]) {
        const other = this.working(knownRoom).overlay.p;
        for (const a of declared) validateScopedHandleHistory(other, a.declaration!.registration, a.declaration!.binding!.nativeHandle,
          a.declaration!.binding!.originalSource, knownRoom, room);
      }
      return;
    }
    let scope: { environmentId: string; providerThreadId: string } | undefined;
    let handle: import("./operation-types.ts").NativeHandle | undefined;
    let registration: import("./operation-types.ts").DeclaredRegistration | undefined;
    let original: import("./provider.ts").NativeToolSource | null = null;
    let newOwner = true;
    if (command.type === "activity_operation") {
      const packet = command.packet, intent = packet.intent;
      if (intent.schema === "backroom.activity.v2" && intent.operation === "bind_activity") {
        registration = p.activities.get(intent.activityId)?.declaration?.registration;
        scope = registration; handle = intent.nativeHandle; original = packet.originalSource ?? null;
      } else if (intent.schema === "backroom.activity.v2" && intent.operation === "record_activity_result") {
        const declaration = p.activities.get(intent.activityId)?.declaration;
        registration = declaration?.registration; scope = registration;
        handle = declaration?.binding?.nativeHandle; original = declaration?.binding?.originalSource ?? null; newOwner = false;
      } else if (intent.schema === "backroom.activity.v1" && intent.operation === "register_activity" && intent.nativeId !== null) {
        const cap = p.capabilities.get(packet.capabilityId);
        if (cap && packet.source.providerThreadId) scope = { environmentId: cap.environmentId, providerThreadId: packet.source.providerThreadId };
        handle = { namespace: "provider_item", value: intent.nativeId };
      }
    } else if (command.type === "activity_bind") {
      const a = p.activities.get(command.activityId), r = a && p.runs.get(a.runId);
      const receipt = [...p.activityReceipts.values()].find((entry) => entry.packet.intent.schema === "backroom.activity.v1"
        && entry.packet.intent.operation === "register_activity" && entry.packet.intent.activityId === command.activityId);
      if (r?.transport && receipt?.packet.source.providerThreadId)
        scope = { environmentId: r.transport.environmentId, providerThreadId: receipt.packet.source.providerThreadId };
      handle = { namespace: "provider_item", value: command.nativeId };
    }
    if (!scope || !handle) return;
    const ownershipKey = handleOwnershipKey(scope, handle);
    const rooms = [{ room }, ...this.sql("SELECT DISTINCT room FROM engine_event WHERE room<>?").all(room) as { room: string }[]];
    for (const { room: ownerRoom } of rooms) {
      const other = this.working(ownerRoom).overlay.p;
      if (registration && (newOwner || ownerRoom !== room)) validateScopedHandleHistory(other, registration, handle, original, ownerRoom, room);
      if (!newOwner) continue;
      for (const existing of other.activities.values()) {
        if (existing.declaration?.binding?.ownershipKey === ownershipKey) throw new Error("native handle already owned across rooms/generations");
        if (handle.namespace !== "provider_item" || existing.nativeSource?.nativeId !== handle.value) continue;
        const run = other.runs.get(existing.runId);
        const receipt = [...other.activityReceipts.values()].find((entry) => entry.packet.intent.schema === "backroom.activity.v1"
          && entry.packet.intent.activityId === existing.id && entry.packet.intent.operation === "register_activity");
        if (run?.transport?.environmentId === scope.environmentId && receipt?.packet.source.providerThreadId === scope.providerThreadId)
          throw new Error("native handle belongs to strict v1 activity tombstone");
      }
    }
  }

  lookupOperation(room: string, capabilityId: string, intentJSON: string): OperationReceipt | null {
    return this.transaction("IMMEDIATE", () => this.rawReceipt(room, capabilityId, intentJSON), true);
  }
  reserveNative(room: string, seatId: string, maxBytes: number): CommitReceipt {
    return this.execute(room, { type: "reserve", actor: "$system", id: `reserve:${randomUUID()}`, seatId, runId: randomUUID(), dispatchCommandId: randomUUID(), dispatchMessageId: randomUUID(), maxBytes });
  }
  private rawReceipt(room: string, capabilityId: string, intentJSON: string): OperationReceipt | null {
    const p = this.working(room).overlay.p, cap = p.capabilities.get(capabilityId);
    if (!cap) throw new Error("unknown run capability");
    validateCapability(p, cap);
    const intent = parseOperation(JSON.parse(intentJSON));
    if (intentJSON !== canonicalJSON(intent) || intent.originRunId !== cap.runId) throw new Error("raw intent scope conflict");
    const key = operationKey(capabilityId, intent.clientId);
    if (p.activityReceipts.has(key)) throw new Error("client identity reused by another operation");
    const receipt = p.operationReceipts.get(key);
    if (receipt && receipt.intentJSON !== intentJSON) throw new Error("conflicting raw client intent");
    return receipt ?? null;
  }
  commitOperation(room: string, packet: LocalOperationPacket): { receipt: OperationReceipt; replayed: boolean } {
    const frozen = JSON.parse(canonicalJSON(packet)) as LocalOperationPacket;
    return this.transaction("IMMEDIATE", () => {
      const prior = this.rawReceipt(room, frozen.capabilityId, frozen.intentJSON);
      if (prior) return { receipt: prior, replayed: true };
      const key = operationKey(frozen.capabilityId, frozen.intent.clientId);
      this.executeLocked(room, { type: "local_operation", actor: "$system", id: `operation:${digest(key)}`, packet: frozen });
      const receipt = this.working(room).overlay.p.operationReceipts.get(key);
      if (!receipt) throw new Error("operation transaction did not commit receipt");
      return { receipt, replayed: false };
    }, true);
  }
  lookupActivity(room: string, capabilityId: string, intentJSON: string): ActivityReceipt | null {
    return this.transaction("IMMEDIATE", () => this.rawActivityReceipt(room, capabilityId, intentJSON), true);
  }
  private rawActivityReceipt(room: string, capabilityId: string, intentJSON: string): ActivityReceipt | null {
    const p = this.working(room).overlay.p, cap = p.capabilities.get(capabilityId);
    if (!cap) throw new Error("unknown run capability");
    validateCapability(p, cap);
    const intent = parseActivity(JSON.parse(intentJSON));
    if (intentJSON !== canonicalJSON(intent) || intent.originRunId !== cap.runId || cap.activityId && cap.activityId !== intent.activityId) throw new Error("original activity intent scope conflict");
    const key = operationKey(capabilityId, intent.clientId);
    if (p.operationReceipts.has(key)) throw new Error("client identity reused by another operation");
    const receipt = p.activityReceipts.get(key);
    if (receipt && receipt.intentJSON !== intentJSON) throw new Error("conflicting raw activity intent");
    return receipt ?? null;
  }
  commitActivity(room: string, packet: ActivityPacket): { receipt: ActivityReceipt; replayed: boolean } {
    const frozen = JSON.parse(canonicalJSON(packet)) as ActivityPacket;
    return this.transaction("IMMEDIATE", () => {
      const prior = this.rawActivityReceipt(room, frozen.capabilityId, frozen.intentJSON);
      if (prior) return { receipt: prior, replayed: true };
      const key = operationKey(frozen.capabilityId, frozen.intent.clientId);
      this.executeLocked(room, { type: "activity_operation", actor: "$system", id: `activity-operation:${digest(key)}`, packet: frozen });
      const receipt = this.working(room).overlay.p.activityReceipts.get(key);
      if (!receipt) throw new Error("activity transaction did not commit receipt");
      return { receipt, replayed: false };
    }, true);
  }
  load(room: string): RoomEvent[] { return this.transaction("IMMEDIATE", () => Array.from(this.working(room, false).overlay.p.events)); }
  project(room: string): Projection {
    return this.transaction("IMMEDIATE", () => {
      const p = this.working(room, false).overlay.p, detached = { ...p, events: Array.from(p.events), commandKeys: new Set(p.commandKeys) };
      for (const name of projectionMaps) (detached[name] as Map<string, unknown>) = new Map(p[name] as Map<string, unknown>);
      return detached;
    });
  }
  recovery(room: string) {
    const p = this.project(room);
    return { runs: [...p.runs.values()].filter((r) => r.phase !== "terminal"), controls: [...p.controls.values()].filter((c) => c.phase !== "accepted" && c.phase !== "obsolete"),
      activities: [...p.activities.values()].filter((a) => a.status === "pending" || a.status === "uncertain") };
  }
  audit(room: string): { ok: boolean; mismatches: string[]; head: number } {
    return this.transaction("DEFERRED", () => {
      const d = cacheFrom(room, this.connection, this.dataVersion(), derive(this.rows(room))), mismatches = this.compareIndices(room, d);
      return { ok: !mismatches.length, mismatches, head: d.head };
    });
  }
  rebuild(room: string): void {
    this.transaction("IMMEDIATE", () => {
      const rows = this.rows(room), d = derive(rows); this.replaceIndices(room, d, true);
      const base = cacheFrom(room, this.connection, this.dataVersion(), d); base.rows = rows;
      this.staged.set(room, { base, overlay: new ProjectionOverlay(base.p), commands: new EntryOverlay(base.commands), projections: new EntryOverlay(base.projections), keys: new EntryOverlay(base.keys), rows: [], dataVersion: base.dataVersion, audited: true, indexBaseP: base.p });
    }, true, room);
  }
  close(): void { this.caches.clear(); this.db.close(); }
}
