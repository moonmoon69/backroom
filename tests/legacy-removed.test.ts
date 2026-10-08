/**
 * Z4: the old runtime's queue is gone. A fresh database has none of its tables, its commands are refused before anything
 * runs, and deleting a room still works on a database from before the engine, whose old tables keep rows that point at
 * the room, its members and their bindings (found through the schema's foreign keys; the code names none of them).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandValidationError, parseCommand } from "../src/domain/commands.ts";
import { createTestStack } from "./helpers.ts";

test("a fresh database has no tables of the old runtime's queue", async () => {
  const stack = await createTestStack();
  try {
    const tables = (stack.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(tables.filter((name) => name === "runs" || name.startsWith("task")), []);
    assert.ok(tables.includes("rooms") && tables.includes("events") && tables.includes("kv"));
    const rooms = (stack.db.raw.prepare("SELECT name FROM pragma_table_info('rooms')").all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(rooms.includes("next_task_number"), false);
  } finally {
    stack.close();
  }
});

test("the old runtime's commands, and a message's waits, are refused by the command contract", () => {
  const refused = (command: unknown) => assert.throws(() => parseCommand(command), CommandValidationError, JSON.stringify(command).slice(0, 80));
  for (const type of ["task.create", "task.update", "task.release", "task.cancel", "task.interrupt", "task.retry", "task.markBlocked", "task.unblock", "task.dismiss"]) {
    refused({ type, taskId: "t", revision: 1, roomId: "r", recipients: ["p"], instruction: "x", schedule: { mode: "now" } });
  }
  refused({ type: "member.post", roomId: "r", participantId: "p", sourceText: "@q go", assignments: [{ recipients: ["q"], instruction: "go" }] });
  refused({ type: "participant.rebind", participantId: "p", thread: { mode: "create" }, outstandingTasks: "carry" });
  refused({ type: "participant.retire", participantId: "p", pendingTasks: "cancel" });
  refused({ type: "message.create", roomId: "r", assignments: [{ recipients: ["p"], instruction: "x", schedule: { mode: "manual" } }] });
  refused({ type: "message.create", roomId: "r", assignments: [{ recipients: ["p"], instruction: "x" }, { recipients: ["q"], instruction: "y", after: [0] }] });
  assert.equal(parseCommand({ type: "message.create", roomId: "r", assignments: [{ recipients: ["p"], instruction: "x" }] }).type, "message.create");
  assert.equal(parseCommand({ type: "participant.retire", participantId: "p" }).type, "participant.retire");
});

test("deleting a room clears the rows old tables keep for it, through their foreign keys, and leaves other rooms' rows", async () => {
  const stack = await createTestStack();
  try {
    const other = (await stack.run({ type: "room.create", projectId: "project_demo", title: "other" })) as { roomId: string };
    const { participantId: otherMember } = (await stack.run({ type: "participant.create", roomId: other.roomId, alias: "sol", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create" } })) as { participantId: string };
    // Tables shaped as a database from before the engine has them: work for a room's member, its runs on the member's
    // binding, and records under the work.
    stack.db.raw.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), participant_id TEXT NOT NULL REFERENCES participants(id));
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), binding_id TEXT NOT NULL REFERENCES bindings(id));
      CREATE TABLE revisions (task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, PRIMARY KEY (task_id, revision));
    `);
    const rows = (roomId: string, memberId: string, n: string) => {
      const binding = stack.repos.currentBinding(memberId)!;
      stack.db.raw.prepare("INSERT INTO tasks VALUES (?, ?, ?)").run(`t${n}`, roomId, memberId);
      stack.db.raw.prepare("INSERT INTO runs VALUES (?, ?, ?)").run(`r${n}`, `t${n}`, binding.id);
      stack.db.raw.prepare("INSERT INTO revisions VALUES (?, 1)").run(`t${n}`);
    };
    rows(stack.roomId, stack.participants.sol1!, "1");
    rows(stack.roomId, stack.participants.claude!, "2");
    rows(other.roomId, otherMember, "3");
    const count = (table: string) => (stack.db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    await stack.run({ type: "room.delete", roomId: stack.roomId });
    assert.equal(stack.repos.getRoom(stack.roomId), null);
    assert.deepEqual([count("tasks"), count("runs"), count("revisions")], [1, 1, 1], "the other room's rows stay");
    assert.deepEqual(stack.repos.listParticipants(stack.roomId), []);
    await stack.run({ type: "room.delete", roomId: other.roomId });
    assert.deepEqual([count("tasks"), count("runs"), count("revisions"), count("rooms")], [0, 0, 0, 0]);
  } finally {
    stack.close();
  }
});
