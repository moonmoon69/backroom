import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandValidationError, parseCommand } from "../src/domain/commands.ts";

test("unknown action names are rejected before execution", () => {
  assert.throws(() => parseCommand({ type: "task.explode", roomId: "r" }), CommandValidationError);
});

test("now and manual schedules do not accept prerequisites", () => {
  assert.throws(
    () => parseCommand({ type: "task.create", roomId: "r", recipients: ["p"], instruction: "x", schedule: { mode: "now", prerequisites: [] } }),
    CommandValidationError,
  );
  assert.throws(
    () => parseCommand({ type: "task.create", roomId: "r", recipients: ["p"], instruction: "x", schedule: { mode: "manual", prerequisites: [{ taskId: "t", revision: 1 }] } }),
    CommandValidationError,
  );
});

test("after_all requires a nonempty prerequisite list", () => {
  assert.throws(
    () => parseCommand({ type: "task.create", roomId: "r", recipients: ["p"], instruction: "x", schedule: { mode: "after_all", prerequisites: [] } }),
    CommandValidationError,
  );
  const ok = parseCommand({ type: "task.create", roomId: "r", recipients: ["p"], instruction: "x", schedule: { mode: "after_all", prerequisites: [{ taskId: "t", revision: 1 }] } });
  assert.equal(ok.type, "task.create");
});

test("unsupported fields and invalid enums fail validation", () => {
  assert.throws(() => parseCommand({ type: "task.release", taskId: "t", revision: 1, extra: true }), CommandValidationError);
  assert.throws(() => parseCommand({ type: "native.approval.respond", participantId: "p", requestId: "r", decision: "maybe" }), CommandValidationError);
  assert.throws(() => parseCommand({ type: "task.retry", taskId: "t", revision: 1 }), CommandValidationError, "retry requires explicit dependent handling");
});

test("validation errors carry field paths", () => {
  try {
    parseCommand({ type: "task.create", roomId: "r", recipients: [], instruction: "", schedule: { mode: "now" } });
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(error instanceof CommandValidationError);
    const paths = error.issues.map((issue) => issue.path);
    assert.ok(paths.includes("recipients"));
    assert.ok(paths.includes("instruction"));
  }
});
