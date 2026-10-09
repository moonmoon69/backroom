#!/usr/bin/env node
/**
 * Z5, the cutover to the engine (stage 4/5 plan; D3: fresh logs, D5: the Consigliere restarts the service). The engine
 * needs no migration and imports nothing: at its first start it seats every active member from its binding and makes
 * the Consigliere's mark the orchestrator (src/app/engineSeats.ts reconcile). What is left for a script:
 *
 *   node scripts/engine-cutover.ts check [--as <key>] [--skip-t3]    is every room idle? exit 1 when not
 *   node scripts/engine-cutover.ts backup [--as <key>] [--skip-t3]   the same check, then a consistent copy of the
 *                                                                     databases into data/before-engine-<time>/
 *   node scripts/engine-cutover.ts copy <dir>                        a consistent copy of the databases, no check (dry runs)
 *   node scripts/engine-cutover.ts restore [--from <dir>]            the rollback, with the service stopped: the newest
 *                                                                     backup back in place, what ran since put aside
 *   node scripts/engine-cutover.ts verify [--url <url>] [--from <dir>]  after a start: every room of the backup opens, and
 *                                                                     on the engine its active members are seated and the
 *                                                                     Consigliere is the orchestrator
 *   node scripts/engine-cutover.ts roundtrip --project <id> [--model <json>] [--url <url>]
 *                                                                     a test room with one member, a message to it and
 *                                                                     its answer, then the room and its thread deleted
 *
 * The data folder is ROOMS_DATA_DIR (data/ by default), as for the service; the service's URL is read from its
 * browser-api.json. Idle means: no old task or run that has not ended, no approval or question waiting, no reseat in
 * progress, no conversation with the Consigliere still being started, no journal yet (data/board.sqlite), and no active
 * member's thread in a turn in T3. Old work in flight has
 * no successor on the engine, so it would be dropped. `--as <alias>.<room>` is the caller's own agent key: its running
 * turn is excused, since it is the one running the cutover (the restart drops its old task). The copies are SQLite
 * online backups, consistent while the service writes; only the databases are copied, never data/browsers, whose
 * state files name the live Chrome processes a service on the copy would adopt.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import type { T3ThreadShell } from "../src/adapter/types.ts";
import { loadConfig } from "../src/config.ts";
import { threadFree } from "../src/runtime/t3.ts";

/** The databases of a data folder, in the order they are copied. */
export const DATABASES = ["rooms.sqlite", "board.sqlite"] as const;
const TERMINAL_TASK = ["succeeded", "failed", "interrupted", "cancelled"];
const TERMINAL_RUN = ["succeeded", "failed", "interrupted"];
/** The caller's own turn: an old task in one of these states, with its run not ended, is the turn running the cutover. */
const LIVE_TASK = ["dispatching", "running"];

export interface Counts {
  rooms: number;
  /** Active members (not retired). */
  members: number;
  /** Active members' current bindings, the engine's seats. */
  seats: number;
  events: number;
  tasks: number;
  runs: number;
  kv: number;
}

export interface RoomRecord {
  id: string;
  title: string;
  members: Array<{ id: string; alias: string; bindingId: string | null; threadId: string | null }>;
  consigliereId: string | null;
}

export interface Manifest {
  at: string;
  dataDir: string;
  files: Array<{ name: string; pages: number; bytes: number }>;
  counts: Counts;
  rooms: RoomRecord[];
}

export interface Self {
  roomId: string;
  participantId: string;
  alias: string;
  threadId: string | null;
}

export interface IdleReport {
  open: string[];
  excused: string[];
}

const hasTable = (db: DatabaseSync, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
const placeholders = (values: readonly string[]): string => values.map(() => "?").join(", ");
const timestamp = (at = new Date()): string => at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function counts(db: DatabaseSync): Counts {
  const or0 = (table: string, sql: string) => (hasTable(db, table) ? count(db, sql) : 0);
  return {
    rooms: count(db, "SELECT count(*) n FROM rooms"),
    members: count(db, "SELECT count(*) n FROM participants WHERE retired_at IS NULL"),
    seats: count(db, "SELECT count(*) n FROM bindings b JOIN participants p ON p.id = b.participant_id WHERE b.retired_at IS NULL AND p.retired_at IS NULL"),
    events: or0("events", "SELECT count(*) n FROM events"),
    tasks: or0("tasks", "SELECT count(*) n FROM tasks"),
    runs: or0("runs", "SELECT count(*) n FROM runs"),
    kv: count(db, "SELECT count(*) n FROM kv"),
  };
}

/** Every room with its active members, their current binding, and the Consigliere's mark. */
export function rooms(db: DatabaseSync): RoomRecord[] {
  const list = db.prepare("SELECT id, title, consigliere_participant_id AS consigliereId FROM rooms ORDER BY sort_order, created_at").all() as Array<{ id: string; title: string; consigliereId: string | null }>;
  const members = db.prepare(
    `SELECT p.id, p.alias, b.id AS bindingId, b.thread_id AS threadId FROM participants p
     LEFT JOIN bindings b ON b.participant_id = p.id AND b.retired_at IS NULL
     WHERE p.room_id = ? AND p.retired_at IS NULL ORDER BY p.created_at`,
  );
  // Plain objects (SQLite's rows have no prototype), so a manifest read back from its JSON equals the one built.
  return list.map((room) => ({ id: room.id, title: room.title, members: (members.all(room.id) as RoomRecord["members"]).map((m) => ({ ...m })), consigliereId: room.consigliereId }));
}

/** The member an agent key names (`<alias>.<first 8 of the room id>`), or an error. */
export function resolveSelf(db: DatabaseSync, key: string): Self {
  const dot = key.lastIndexOf(".");
  const alias = key.slice(0, dot);
  const prefix = key.slice(dot + 1);
  if (dot <= 0 || prefix.length < 8) throw new Error(`--as takes an agent key like Opus.7adc1145 (got "${key}")`);
  const room = rooms(db).find((r) => r.id.startsWith(prefix));
  const member = room?.members.find((m) => m.alias.toLowerCase() === alias.toLowerCase());
  if (!room || !member) throw new Error(`no active member ${alias} in a room ${prefix}…`);
  return { roomId: room.id, participantId: member.id, alias: member.alias, threadId: member.threadId };
}

/** What Backroom's records hold in flight: old tasks and runs that have not ended, waiting approvals, reseats. */
export function openWork(db: DatabaseSync, self: Self | null): IdleReport {
  const report: IdleReport = { open: [], excused: [] };
  const title = new Map(rooms(db).map((r) => [r.id, r.title]));
  if (hasTable(db, "tasks")) {
    const tasks = db.prepare(
      `SELECT t.id, t.room_id AS roomId, t.number, t.revision, t.state, t.participant_id AS participantId, p.alias FROM tasks t
       JOIN participants p ON p.id = t.participant_id WHERE t.state NOT IN (${placeholders(TERMINAL_TASK)}) ORDER BY t.room_id, t.number`,
    ).all(...TERMINAL_TASK) as Array<{ id: string; roomId: string; number: number; revision: number; state: string; participantId: string; alias: string }>;
    for (const t of tasks) {
      // A task that waits can be cancelled through the old service: {"type":"task.cancel","taskId":…,"revision":…}.
      const waiting = !LIVE_TASK.includes(t.state) ? ` (taskId ${t.id}, revision ${t.revision})` : "";
      const line = `${title.get(t.roomId) ?? t.roomId}: task #${t.number} for @${t.alias} is ${t.state}${waiting}`;
      (self?.participantId === t.participantId && LIVE_TASK.includes(t.state) ? report.excused : report.open).push(line);
    }
  }
  if (hasTable(db, "runs")) {
    const runs = db.prepare(
      `SELECT r.id, r.status, t.room_id AS roomId, t.number, t.state AS taskState, t.participant_id AS participantId, p.alias FROM runs r
       JOIN tasks t ON t.id = r.task_id JOIN participants p ON p.id = t.participant_id
       WHERE r.status NOT IN (${placeholders(TERMINAL_RUN)}) ORDER BY t.room_id, t.number`,
    ).all(...TERMINAL_RUN) as Array<{ id: string; status: string; roomId: string; number: number; taskState: string; participantId: string; alias: string }>;
    for (const r of runs) {
      const line = `${title.get(r.roomId) ?? r.roomId}: run ${r.id.slice(0, 8)} of task #${r.number} for @${r.alias} is ${r.status}`;
      (self?.participantId === r.participantId && LIVE_TASK.includes(r.taskState) ? report.excused : report.open).push(line);
    }
  }
  if (hasTable(db, "native_requests")) {
    for (const n of db.prepare("SELECT n.kind, n.request_id AS requestId, p.alias, p.room_id AS roomId FROM native_requests n JOIN participants p ON p.id = n.participant_id WHERE n.resolved_at IS NULL").all() as Array<{ kind: string; requestId: string; alias: string; roomId: string }>) {
      report.open.push(`${title.get(n.roomId) ?? n.roomId}: @${n.alias} waits for an answer to ${n.kind} ${n.requestId}`);
    }
  }
  for (const k of db.prepare("SELECT key FROM kv WHERE key LIKE 'reseat:%' OR key LIKE 'engine.reseat:%'").all() as Array<{ key: string }>) {
    report.open.push(`a reseat is in progress (${k.key})`);
  }
  // A conversation the user started with the Consigliere whose first message has not reached him yet.
  for (const k of db.prepare("SELECT key, value FROM kv WHERE key LIKE 'consigliere.start:%'").all() as Array<{ key: string; value: string }>) {
    let attempt: { roomId?: string; delivered?: boolean } | null = null;
    try {
      attempt = JSON.parse(k.value) as { roomId?: string; delivered?: boolean };
    } catch {
      // Not an attempt.
    }
    if (attempt && attempt.delivered === false) report.open.push(`${title.get(attempt.roomId ?? "") ?? "a new room"}: the user's first message to its Consigliere is not delivered yet (${k.key})`);
  }
  return report;
}

/** Active members whose thread T3 shows in a turn, or waiting for an approval or an answer. */
export function t3Turns(db: DatabaseSync, threads: readonly T3ThreadShell[], self: Self | null): IdleReport {
  const report: IdleReport = { open: [], excused: [] };
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const room of rooms(db)) {
    for (const member of room.members) {
      const shell = member.threadId ? byId.get(member.threadId) : undefined;
      if (!shell || threadFree(shell)) continue;
      const what = shell.pendingRequest ? "waits for an approval or an answer in T3" : `is in a turn in T3 (${shell.status})`;
      (self?.participantId === member.id ? report.excused : report.open).push(`${room.title}: @${member.alias} ${what}`);
    }
  }
  return report;
}

export interface CheckOptions {
  dataDir: string;
  as: string | null;
  /** The threads T3 lists, or null to check Backroom's records only. */
  threads: (() => Promise<T3ThreadShell[]>) | null;
}

/** The idle check: what is open, what is excused as the caller's own turn, and whether the cutover may go ahead. */
export async function check(options: CheckOptions): Promise<IdleReport & { idle: boolean; self: Self | null }> {
  const path = join(options.dataDir, "rooms.sqlite");
  if (!existsSync(path)) throw new Error(`no ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const self = options.as ? resolveSelf(db, options.as) : null;
    const report = openWork(db, self);
    if (existsSync(join(options.dataDir, "board.sqlite"))) {
      report.open.push(`${join(options.dataDir, "board.sqlite")} exists: the engine has run on this data folder (after a rollback, \`restore\` puts it aside)`);
    }
    if (options.threads) {
      const t3 = t3Turns(db, await options.threads(), self);
      report.open.push(...t3.open);
      report.excused.push(...t3.excused);
    }
    return { ...report, idle: report.open.length === 0, self };
  } finally {
    db.close();
  }
}

/** One database copied by SQLite's online backup (in one step, so a writer cannot interleave), then checked. */
async function copyDatabase(from: string, to: string): Promise<{ pages: number; bytes: number }> {
  const source = new DatabaseSync(from, { readOnly: true });
  let pages: number;
  try {
    pages = await backup(source, to, { rate: 2_147_483_647 });
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(to, { readOnly: true });
  try {
    const result = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (result !== "ok") throw new Error(`the copy ${to} fails SQLite's integrity check: ${result}`);
  } finally {
    copy.close();
  }
  return { pages, bytes: readFileSync(to).byteLength };
}

/** A consistent copy of the data folder's databases into `toDir` (which must not exist yet), with its manifest. */
export async function copyDatabases(dataDir: string, toDir: string): Promise<Manifest> {
  if (existsSync(toDir)) throw new Error(`${toDir} exists already: nothing is copied over an earlier copy`);
  if (!existsSync(join(dataDir, "rooms.sqlite"))) throw new Error(`no ${join(dataDir, "rooms.sqlite")}`);
  mkdirSync(toDir, { recursive: true });
  const files: Manifest["files"] = [];
  for (const name of DATABASES) {
    if (!existsSync(join(dataDir, name))) continue;
    files.push({ name, ...(await copyDatabase(join(dataDir, name), join(toDir, name))) });
  }
  const db = new DatabaseSync(join(toDir, "rooms.sqlite"), { readOnly: true });
  let manifest: Manifest;
  try {
    manifest = { at: new Date().toISOString(), dataDir: resolve(dataDir), files, counts: counts(db), rooms: rooms(db) };
  } finally {
    db.close();
  }
  writeFileSync(join(toDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The data folder's backups, newest last. */
export function backups(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((name) => /^before-engine-\d{8}T\d{6}Z$/.test(name) && existsSync(join(dataDir, name, "manifest.json"))).sort().map((name) => join(dataDir, name));
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

/** The URL of the service on this data folder, from the browser-api.json it writes at every start. */
export function serviceUrl(dataDir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dataDir, "browser-api.json"), "utf8")) as { url?: string }).url ?? null;
  } catch {
    return null;
  }
}

async function answers(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    return (await fetchImpl(`${url}/api/status`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/**
 * The rollback: with no service answering on the data folder, what it holds now (rooms.sqlite, the journal, their
 * -wal and -shm) moves to after-engine-<time>/, and the backup's databases are copied back in place.
 */
export async function restore(dataDir: string, fromDir: string, fetchImpl: typeof fetch = fetch): Promise<{ aside: string; manifest: Manifest; counts: Counts }> {
  const url = serviceUrl(dataDir);
  if (url && (await answers(url, fetchImpl))) throw new Error(`a service answers at ${url} on this data folder: stop it first`);
  const manifest = readManifest(fromDir);
  const aside = join(dataDir, `after-engine-${timestamp()}`);
  mkdirSync(aside);
  for (const name of DATABASES) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(join(dataDir, `${name}${suffix}`))) renameSync(join(dataDir, `${name}${suffix}`), join(aside, `${name}${suffix}`));
    }
  }
  for (const file of manifest.files) await copyDatabase(join(fromDir, file.name), join(dataDir, file.name));
  const db = new DatabaseSync(join(dataDir, "rooms.sqlite"), { readOnly: true });
  try {
    return { aside, manifest, counts: counts(db) };
  } finally {
    db.close();
  }
}

export interface VerifyReport {
  ok: boolean;
  engine: boolean;
  lines: string[];
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<{ status: number; body: any }> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Left as text.
  }
  return { status: response.status, body };
}

/**
 * After a start: the service answers, every room in the backup opens with its active members, and on the engine each
 * of them has an active seat on its current binding and the Consigliere's binding is the journal's orchestrator.
 */
export async function verify(url: string, manifest: Manifest, fetchImpl: typeof fetch = fetch): Promise<VerifyReport> {
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string) => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };
  const status = await getJson(`${url}/api/status`, fetchImpl);
  if (status.status !== 200) {
    fail(`GET /api/status answered ${status.status}`);
    return { ok, engine: false, lines };
  }
  lines.push(`ok   the service answers (adapter ${status.body.adapter}, UI ${status.body.uiBuild ?? "not built"}${status.body.t3?.error ? `; T3 says: ${status.body.t3.error}` : ""})`);
  const list = await getJson(`${url}/api/rooms`, fetchImpl);
  if (list.status !== 200 || !Array.isArray(list.body)) {
    fail(`GET /api/rooms answered ${list.status}`);
    return { ok, engine: false, lines };
  }
  const listed = new Set((list.body as Array<{ id: string }>).map((r) => r.id));
  let engine = false;
  for (const room of manifest.rooms) {
    if (!listed.has(room.id)) {
      fail(`${room.title}: not in the room list`);
      continue;
    }
    const got = await getJson(`${url}/api/rooms/${room.id}`, fetchImpl);
    if (got.status !== 200) {
      fail(`${room.title}: GET /api/rooms/${room.id} answered ${got.status}`);
      continue;
    }
    const snapshot = got.body as { engine?: boolean; participants: Array<{ id: string; alias: string; retiredAt: string | null }>; seats?: Array<{ seatId: string; participantId: string | null; status: string; orchestrator: boolean }>; room: { consigliereId: string | null } };
    engine = snapshot.engine === true;
    const active = new Set(snapshot.participants.filter((p) => !p.retiredAt).map((p) => p.id));
    const missing = room.members.filter((m) => !active.has(m.id)).map((m) => `@${m.alias}`);
    if (missing.length) fail(`${room.title}: members not seated any more: ${missing.join(", ")}`);
    if (snapshot.room.consigliereId !== room.consigliereId) fail(`${room.title}: the Consigliere's mark is ${snapshot.room.consigliereId ?? "none"}, was ${room.consigliereId ?? "none"}`);
    if (!engine) {
      if (!missing.length) lines.push(`ok   ${room.title}: opens, ${room.members.length} active member(s) as before (not the engine: no seats to check)`);
      continue;
    }
    const seats = new Map((snapshot.seats ?? []).filter((s) => s.status === "active").map((s) => [s.seatId, s]));
    const unseated = room.members.filter((m) => !m.bindingId || !seats.has(m.bindingId)).map((m) => `@${m.alias}`);
    if (unseated.length) fail(`${room.title}: no active seat on the board for ${unseated.join(", ")}`);
    const orchestrators = [...seats.values()].filter((s) => s.orchestrator).map((s) => s.seatId);
    const consigliere = room.members.find((m) => m.id === room.consigliereId) ?? null;
    const expected = consigliere?.bindingId ? [consigliere.bindingId] : [];
    if (orchestrators.join() !== expected.join()) fail(`${room.title}: the orchestrator is ${orchestrators.join(", ") || "nobody"}, expected ${consigliere ? `@${consigliere.alias}'s seat ${expected.join()}` : "nobody"}`);
    if (!missing.length && !unseated.length && orchestrators.join() === expected.join()) {
      lines.push(`ok   ${room.title}: opens, ${seats.size} active seat(s) for ${room.members.length} active member(s)${consigliere ? `, @${consigliere.alias} is the orchestrator` : ", no Consigliere"}`);
    }
  }
  const extra = [...listed].filter((id) => !manifest.rooms.some((r) => r.id === id));
  if (extra.length) lines.push(`note ${extra.length} room(s) not in the backup: ${extra.join(", ")}`);
  return { ok, engine, lines };
}

async function command(url: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<any> {
  const response = await fetchImpl(`${url}/api/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${String(body.type)} answered ${response.status}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

export interface RoundtripOptions {
  url: string;
  projectId: string;
  modelSelection?: unknown;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * A test room in the project with one member on a fresh thread, a message to it, and its answer on the board; then
 * the room is deleted with its thread. The room never has a Consigliere (Settings' choice would seat one).
 */
export async function roundtrip(options: RoundtripOptions): Promise<{ ok: boolean; reply: string | null; ms: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const { roomId } = (await command(options.url, { type: "room.create", projectId: options.projectId, title: `Z5 check ${timestamp()}`, consigliere: false }, fetchImpl)) as { roomId: string };
  log(`test room ${roomId} made`);
  let participantId: string | null = null;
  try {
    participantId = ((await command(options.url, { type: "participant.create", roomId, alias: "check", ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}), thread: { mode: "create" } }, fetchImpl)) as { participantId: string }).participantId;
    const instruction = "Reply with the single word OK and nothing else.";
    await command(options.url, { type: "message.create", roomId, sourceText: `@check ${instruction}`, clientMessageId: randomUUID(), attachmentIds: [], assignments: [{ recipients: [participantId], instruction }] }, fetchImpl);
    log("message sent to @check");
    const deadline = started + (options.timeoutMs ?? 5 * 60_000);
    for (;;) {
      const { body } = await getJson(`${options.url}/api/rooms/${roomId}`, fetchImpl);
      const snapshot = body as { posts: Array<{ number: number; body: string; request?: { answer: { number: number } | null }; output?: { disposition: string } }> };
      const request = snapshot.posts.find((p) => p.request);
      const answer = request?.request?.answer ? snapshot.posts.find((p) => p.number === request.request!.answer!.number) : undefined;
      if (answer) return { ok: answer.output?.disposition === "answer", reply: answer.body, ms: Date.now() - started };
      const failed = snapshot.posts.find((p) => p.output?.disposition === "error");
      if (failed) return { ok: false, reply: failed.body, ms: Date.now() - started };
      if (Date.now() > deadline) return { ok: false, reply: null, ms: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2000));
    }
  } finally {
    // Thread choices are keyed by member: the check member's thread is deleted with the room.
    await command(options.url, { type: "room.delete", roomId, threads: participantId ? { [participantId]: "delete" } : {} }, fetchImpl).then(
      (result: { threads?: Array<{ threadId: string; action: string; result: string }> }) => {
        const thread = result.threads?.[0];
        log(`test room deleted${thread ? `; its thread ${thread.threadId}: ${thread.action} ${thread.result}` : ""}`);
      },
      (error: unknown) => log(`the test room ${roomId} could not be deleted: ${(error as Error).message}; delete it on the page`),
    );
  }
}

// ---------------- the command line ----------------

const flag = (args: string[], name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

async function main(args: string[]): Promise<number> {
  const config = loadConfig();
  const dataDir = config.dataDir;
  const say = (line: string) => console.log(line);
  const sub = args[0];
  const t3Threads = (): (() => Promise<T3ThreadShell[]>) | null => {
    if (args.includes("--skip-t3")) return null;
    const stored = readStoredAuth(dataDir);
    const adapter = new HttpT3Adapter({ baseUrl: config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773", accessToken: config.t3AccessToken ?? stored?.accessToken ?? null, userDataDir: config.t3UserDataDir });
    return async () => {
      try {
        return await adapter.listThreads();
      } catch (error) {
        throw new Error(`T3's threads could not be read (${(error as Error).message}); pass --skip-t3 to check Backroom's records only`);
      }
    };
  };
  const idle = async (): Promise<boolean> => {
    const report = await check({ dataDir, as: flag(args, "--as"), threads: t3Threads() });
    say(`data folder ${dataDir}${args.includes("--skip-t3") ? " (T3 not asked: --skip-t3)" : ""}`);
    for (const line of report.excused) say(`excused  ${line} (the caller's own turn)`);
    for (const line of report.open) say(`OPEN     ${line}`);
    say(report.idle ? "IDLE: every room is idle" : `NOT IDLE: ${report.open.length} thing(s) in flight; wait for them to end, or stop them, and check again`);
    return report.idle;
  };
  const printManifest = (dir: string, manifest: Manifest) => {
    for (const file of manifest.files) say(`copied   ${file.name}: ${file.pages} pages, ${file.bytes} bytes, integrity ok`);
    say(`counts   ${JSON.stringify(manifest.counts)}`);
    for (const room of manifest.rooms) say(`room     ${room.title}: ${room.members.map((m) => `@${m.alias}${m.id === room.consigliereId ? " (Consigliere)" : ""}`).join(", ") || "no members"}`);
    say(`manifest ${join(dir, "manifest.json")}`);
  };
  switch (sub) {
    case "check":
      return (await idle()) ? 0 : 1;
    case "backup": {
      if (!(await idle())) return 1;
      const dir = join(dataDir, `before-engine-${timestamp()}`);
      printManifest(dir, await copyDatabases(dataDir, dir));
      say(`BACKUP ${dir}`);
      return 0;
    }
    case "copy": {
      const dir = args[1];
      if (!dir || dir.startsWith("--")) throw new Error("copy takes the folder to copy into");
      printManifest(resolve(dir), await copyDatabases(dataDir, resolve(dir)));
      return 0;
    }
    case "restore": {
      const from = flag(args, "--from") ?? backups(dataDir).at(-1);
      if (!from) throw new Error(`no backup in ${dataDir} (before-engine-<time>/)`);
      const result = await restore(dataDir, resolve(from));
      say(`put aside ${result.aside}`);
      say(`restored from ${from}`);
      const same = JSON.stringify(result.counts) === JSON.stringify(result.manifest.counts);
      say(`counts   ${JSON.stringify(result.counts)} ${same ? "= the backup's" : `!= the backup's ${JSON.stringify(result.manifest.counts)}`}`);
      return same ? 0 : 1;
    }
    case "verify": {
      const from = flag(args, "--from") ?? backups(dataDir).at(-1);
      if (!from) throw new Error(`no backup in ${dataDir} to compare with (pass --from <dir>)`);
      const url = flag(args, "--url") ?? serviceUrl(dataDir);
      if (!url) throw new Error("no service URL: pass --url");
      const report = await verify(url, readManifest(resolve(from)));
      for (const line of report.lines) say(line);
      say(report.ok ? `VERIFIED against ${from}${report.engine ? " (engine)" : " (not the engine)"}` : "NOT VERIFIED");
      return report.ok ? 0 : 1;
    }
    case "roundtrip": {
      const projectId = flag(args, "--project");
      if (!projectId) throw new Error("roundtrip takes --project <T3 project id>");
      const url = flag(args, "--url") ?? serviceUrl(dataDir);
      if (!url) throw new Error("no service URL: pass --url");
      const model = flag(args, "--model");
      const result = await roundtrip({ url, projectId, ...(model ? { modelSelection: JSON.parse(model) } : {}), log: say });
      say(result.ok ? `ROUND TRIP in ${Math.round(result.ms / 1000)} s: ${JSON.stringify(result.reply)}` : `NO ROUND TRIP after ${Math.round(result.ms / 1000)} s: ${JSON.stringify(result.reply)}`);
      return result.ok ? 0 : 1;
    }
    default:
      say("usage: node scripts/engine-cutover.ts check|backup|copy <dir>|restore|verify|roundtrip --project <id> (see the head of the file)");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`STOPPED: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
