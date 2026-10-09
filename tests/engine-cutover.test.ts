/**
 * Z5's cutover script (scripts/engine-cutover.ts): the idle check over the old tables and T3, the consistent backup,
 * the restore of the rollback, the checks after a start, and the test room's round trip.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { T3ThreadShell } from "../src/adapter/types.ts";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { createHttpApp } from "../src/server/http.ts";
import { backups, check, copyDatabases, readManifest, restore, roundtrip, verify } from "../scripts/engine-cutover.ts";

/** The old runtime's work tables, as main's database still has them (only the columns the check reads). */
const OLD_TABLES = `
  CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, number INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, participant_id TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL);
`;

interface Fixture {
  dir: string;
  stack: AppStack;
  fake: FakeT3Adapter;
  roomId: string;
  key(alias: string): string;
  member(alias: string): string;
  run(command: RoomCommandInput): Promise<unknown>;
  /** The data folder as the old service leaves it: the stack closed, no journal, the old tables beside. */
  asOldDataFolder(): void;
  done(): void;
}

async function fixture(options: { autoCompleteMs?: number | null } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "rooms-cutover-"));
  const fake = new FakeT3Adapter({ autoCompleteMs: options.autoCompleteMs ?? null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null });
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const { roomId } = (await run({ type: "room.create", projectId: "project_demo", title: "payments" })) as { roomId: string };
  const members: Record<string, string> = {};
  for (const alias of ["boss", "sol1", "sol2"]) {
    members[alias] = ((await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } })) as { participantId: string }).participantId;
  }
  await run({ type: "room.consigliere.set", roomId, participantId: members.boss! });
  let closed = false;
  return {
    dir,
    stack,
    fake,
    roomId,
    key: (alias) => `${alias}.${roomId.slice(0, 8)}`,
    member: (alias) => members[alias]!,
    run,
    asOldDataFolder() {
      stack.close();
      closed = true;
      for (const name of readdirSync(dir)) if (name.startsWith("board.sqlite")) rmSync(join(dir, name));
      const db = new DatabaseSync(join(dir, "rooms.sqlite"));
      db.exec(OLD_TABLES);
      db.close();
    },
    done() {
      if (!closed) stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const writeDb = (dir: string, sql: string, ...params: Array<string | number>) => {
  const db = new DatabaseSync(join(dir, "rooms.sqlite"));
  db.prepare(sql).run(...params);
  db.close();
};

test("the idle check lists old work in flight, waiting approvals, reseats and an undelivered Consigliere start, and excuses only the caller's running turn", async () => {
  const f = await fixture();
  try {
    f.asOldDataFolder();
    const idle = await check({ dataDir: f.dir, as: null, threads: null });
    assert.equal(idle.idle, true);
    assert.deepEqual(idle.open, []);

    writeDb(f.dir, "INSERT INTO tasks VALUES ('t1', ?, 1, 1, ?, 'succeeded')", f.roomId, f.member("sol1"));
    writeDb(f.dir, "INSERT INTO tasks VALUES ('t2', ?, 2, 3, ?, 'queued')", f.roomId, f.member("sol2"));
    writeDb(f.dir, "INSERT INTO tasks VALUES ('t3', ?, 3, 1, ?, 'running')", f.roomId, f.member("boss"));
    writeDb(f.dir, "INSERT INTO runs VALUES ('r3', 't3', 'running')");
    writeDb(f.dir, "INSERT INTO runs VALUES ('r1', 't1', 'succeeded')");
    writeDb(f.dir, "INSERT INTO native_requests (participant_id, thread_id, request_id, kind, payload_json, created_at) VALUES (?, 'th', 'q1', 'approval', '{}', 'now')", f.member("sol2"));
    writeDb(f.dir, "INSERT INTO kv VALUES (?, '[]')", `engine.reseat:${f.roomId}`);
    writeDb(f.dir, "INSERT INTO kv VALUES ('consigliere.start:r1', ?)", JSON.stringify({ roomId: f.roomId, participantId: "p", threadId: "t", threadCommandId: "c", seated: true, delivered: false }));
    writeDb(f.dir, "INSERT INTO kv VALUES ('consigliere.start:r2', ?)", JSON.stringify({ roomId: f.roomId, participantId: "p", threadId: "t", threadCommandId: "c", seated: true, delivered: true }));

    const anyone = await check({ dataDir: f.dir, as: null, threads: null });
    assert.equal(anyone.idle, false);
    assert.deepEqual(anyone.excused, []);
    assert.deepEqual(anyone.open, [
      "payments: task #2 for @sol2 is queued (taskId t2, revision 3)",
      "payments: task #3 for @boss is running",
      "payments: run r3 of task #3 for @boss is running",
      "payments: @sol2 waits for an answer to approval q1",
      `a reseat is in progress (engine.reseat:${f.roomId})`,
      "payments: the user's first message to its Consigliere is not delivered yet (consigliere.start:r1)",
    ]);

    const asBoss = await check({ dataDir: f.dir, as: f.key("boss"), threads: null });
    assert.deepEqual(asBoss.excused, ["payments: task #3 for @boss is running", "payments: run r3 of task #3 for @boss is running"]);
    assert.equal(asBoss.open.length, 4);

    // The caller's own work that waits (a wake queued for him) is not his running turn: it would be dropped.
    writeDb(f.dir, "INSERT INTO tasks VALUES ('t4', ?, 4, 1, ?, 'queued')", f.roomId, f.member("boss"));
    assert.ok((await check({ dataDir: f.dir, as: f.key("boss"), threads: null })).open.includes("payments: task #4 for @boss is queued (taskId t4, revision 1)"));

    await assert.rejects(check({ dataDir: f.dir, as: "nobody.12345678", threads: null }), /no active member nobody/);
    await assert.rejects(check({ dataDir: f.dir, as: "boss", threads: null }), /agent key like/);
  } finally {
    f.done();
  }
});

test("the idle check refuses a data folder the engine has run on, and asks T3 which members are in a turn", async () => {
  const f = await fixture();
  try {
    const shells = await f.fake.listThreads();
    const threads = Object.fromEntries(["boss", "sol1", "sol2"].map((alias) => [alias, f.stack.repos.currentBinding(f.member(alias))!.threadId]));
    const thread = (alias: string) => threads[alias];
    f.asOldDataFolder();
    writeFileSync(join(f.dir, "board.sqlite"), "");
    const ran = await check({ dataDir: f.dir, as: null, threads: null });
    assert.equal(ran.idle, false);
    assert.match(ran.open[0]!, /board\.sqlite exists: the engine has run on this data folder/);
    rmSync(join(f.dir, "board.sqlite"));

    const busy = (shell: T3ThreadShell): T3ThreadShell => ({ ...shell, status: "running", activeRunId: "run-1" });
    const listed = shells.map((s) => (s.id === thread("boss") || s.id === thread("sol1") ? busy(s) : s.id === thread("sol2") ? { ...s, pendingRequest: { id: "q1", kind: "approval", createdAt: "now" } as unknown as T3ThreadShell["pendingRequest"] } : s));
    listed.push(busy({ ...shells[0]!, id: "a-thread-outside-the-room" }));
    const report = await check({ dataDir: f.dir, as: f.key("boss"), threads: async () => listed });
    assert.deepEqual(report.excused, ["payments: @boss is in a turn in T3 (running)"]);
    assert.deepEqual(report.open, ["payments: @sol1 is in a turn in T3 (running)", "payments: @sol2 waits for an approval or an answer in T3"]);
    await assert.rejects(check({ dataDir: f.dir, as: null, threads: async () => Promise.reject(new Error("T3 is down")) }), /T3 is down/);
  } finally {
    f.done();
  }
});

test("the backup is consistent while a writer commits, and never goes over an earlier one", async () => {
  const f = await fixture();
  try {
    f.asOldDataFolder();
    writeDb(f.dir, "CREATE TABLE pairs (side TEXT NOT NULL)");
    // A writer in another process commits two rows at a time, as the running service would write, while the copy is taken.
    const writer = spawn(process.execPath, ["--no-warnings", "-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(join(f.dir, "rooms.sqlite"))});
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
      const insert = db.prepare("INSERT INTO pairs VALUES (?)");
      console.log("writing");
      const end = Date.now() + 3000;
      while (Date.now() < end) { db.exec("BEGIN"); insert.run("left"); insert.run("right"); db.exec("COMMIT"); }
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => writer.stdout.once("data", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const to = join(f.dir, "before-engine-20261009T080000Z");
    const manifest = await copyDatabases(f.dir, to);
    await new Promise((resolve) => writer.once("exit", resolve));

    const copy = new DatabaseSync(join(to, "rooms.sqlite"), { readOnly: true });
    const sides = copy.prepare("SELECT side, count(*) n FROM pairs GROUP BY side ORDER BY side").all() as Array<{ side: string; n: number }>;
    copy.close();
    assert.equal(sides.length, 2);
    assert.ok(sides[0]!.n > 0);
    assert.equal(sides[0]!.n, sides[1]!.n, "every pair committed together is in the copy whole");
    assert.deepEqual(manifest.files.map((x) => x.name), ["rooms.sqlite"]);
    assert.deepEqual(manifest.counts, { rooms: 1, members: 3, seats: 3, events: manifest.counts.events, tasks: 0, runs: 0, kv: manifest.counts.kv });
    assert.deepEqual(manifest.rooms.map((r) => [r.title, r.members.map((m) => m.alias), r.consigliereId]), [["payments", ["boss", "sol1", "sol2"], f.member("boss")]]);
    assert.deepEqual(readManifest(to), manifest);
    assert.deepEqual(backups(f.dir), [to]);
    await assert.rejects(copyDatabases(f.dir, to), /exists already/);
  } finally {
    f.done();
  }
});

test("restore waits for the service to stop, puts what ran since aside, and brings back the backup's counts", async () => {
  const f = await fixture();
  try {
    f.asOldDataFolder();
    const from = join(f.dir, "before-engine-20261009T080000Z");
    const manifest = await copyDatabases(f.dir, from);
    // The engine ran: a journal, and rooms.sqlite changed.
    const journal = new DatabaseSync(join(f.dir, "board.sqlite"));
    journal.exec("CREATE TABLE journal (x)");
    journal.close();
    writeDb(f.dir, "INSERT INTO kv VALUES ('written.after.the.cutover', '1')");
    writeFileSync(join(f.dir, "browser-api.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "t" }));

    const answering = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await assert.rejects(restore(f.dir, from, answering), /a service answers at http:\/\/127\.0\.0\.1:1 on this data folder: stop it first/);
    assert.ok(existsSync(join(f.dir, "board.sqlite")), "nothing moved while the service answers");

    const stopped = (async () => Promise.reject(new Error("connection refused"))) as typeof fetch;
    const result = await restore(f.dir, from, stopped);
    assert.deepEqual(result.counts, manifest.counts);
    assert.ok(existsSync(join(result.aside, "board.sqlite")) && existsSync(join(result.aside, "rooms.sqlite")));
    assert.ok(!existsSync(join(f.dir, "board.sqlite")));
    const db = new DatabaseSync(join(f.dir, "rooms.sqlite"), { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) n FROM kv WHERE key = 'written.after.the.cutover'").get()!.n, 0);
    db.close();
    assert.equal((await check({ dataDir: f.dir, as: null, threads: null })).idle, true, "a second cutover can start from here");
  } finally {
    f.done();
  }
});

const served = (stack: AppStack, dir: string): typeof fetch => {
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dir, ROOMS_PORT: "0" }), "/nonexistent/dist");
  return (async (input: string | URL | Request, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
};

test("verify: every room of the backup opens on the engine, its active members seated and the Consigliere the orchestrator", async () => {
  const f = await fixture();
  try {
    const manifest = await copyDatabases(f.dir, join(f.dir, "before-engine-20261009T080000Z"));
    const fetchImpl = served(f.stack, f.dir);
    const report = await verify("http://backroom.test", manifest, fetchImpl);
    assert.equal(report.ok, true, report.lines.join("\n"));
    assert.equal(report.engine, true);
    assert.match(report.lines.join("\n"), /ok {3}payments: opens, 3 active seat\(s\) for 3 active member\(s\), @boss is the orchestrator/);

    const gone = { ...manifest, rooms: [...manifest.rooms, { id: "room-gone", title: "gone", members: [], consigliereId: null }] };
    assert.match((await verify("http://backroom.test", gone, fetchImpl)).lines.join("\n"), /FAIL gone: not in the room list/);
    const room = manifest.rooms[0]!;
    const moreMembers = { ...manifest, rooms: [{ ...room, members: [...room.members, { id: "p-x", alias: "ghost", bindingId: "b-x", threadId: "t-x" }] }] };
    const failed = await verify("http://backroom.test", moreMembers, fetchImpl);
    assert.equal(failed.ok, false);
    assert.match(failed.lines.join("\n"), /FAIL payments: members not seated any more: @ghost/);
    assert.match(failed.lines.join("\n"), /FAIL payments: no active seat on the board for @ghost/);

    // The mark moved off the board's orchestrator: both are reported.
    await f.run({ type: "room.consigliere.set", roomId: f.roomId, participantId: null });
    const unmarked = await verify("http://backroom.test", manifest, fetchImpl);
    assert.match(unmarked.lines.join("\n"), /FAIL payments: the Consigliere's mark is none, was /);
    assert.match(unmarked.lines.join("\n"), /FAIL payments: the orchestrator is nobody, expected @boss's seat/);
  } finally {
    f.done();
  }
});

test("roundtrip: a test room's member answers the message, then the room goes with its thread", async () => {
  const f = await fixture({ autoCompleteMs: 5 });
  try {
    f.stack.engine.start(20);
    const fetchImpl = served(f.stack, f.dir);
    const lines: string[] = [];
    const result = await roundtrip({ url: "http://backroom.test", projectId: "project_demo", fetchImpl, pollMs: 20, timeoutMs: 15_000, log: (line) => lines.push(line) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.reply && result.reply.length > 0);
    assert.deepEqual(f.stack.repos.listRooms().map((r) => r.title), ["payments"], "the test room is deleted");
    const deleted = /; its thread (\S+): delete done$/.exec(lines.at(-1) ?? "")?.[1];
    assert.ok(deleted, lines.join("\n"));
    assert.equal(f.fake.threads.has(deleted), false, "and its T3 thread");
    assert.equal(f.stack.repos.getRoom(f.roomId)?.consigliereId, f.member("boss"), "the other room is untouched");
  } finally {
    f.done();
  }
});

test("roundtrip reports a member that does not answer in time, and still deletes the room", async () => {
  const f = await fixture({ autoCompleteMs: null });
  try {
    f.stack.engine.start(20);
    const result = await roundtrip({ url: "http://backroom.test", projectId: "project_demo", fetchImpl: served(f.stack, f.dir), pollMs: 20, timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.equal(result.reply, null);
    assert.deepEqual(f.stack.repos.listRooms().map((r) => r.title), ["payments"]);
  } finally {
    f.done();
  }
});
