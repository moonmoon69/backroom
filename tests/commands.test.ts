import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandValidationError, parseCommand } from "../src/domain/commands.ts";

test("unknown action names are rejected before execution", () => {
  assert.throws(() => parseCommand({ type: "task.explode", roomId: "r" }), CommandValidationError);
});

test("unsupported fields and invalid enums fail validation", () => {
  assert.throws(() => parseCommand({ type: "room.update", roomId: "r", title: "x", extra: true }), CommandValidationError);
  assert.throws(() => parseCommand({ type: "native.approval.respond", participantId: "p", requestId: "r", decision: "maybe" }), CommandValidationError);
});

test("validation errors carry field paths", () => {
  const paths = (command: unknown) => {
    try {
      parseCommand(command);
    } catch (error) {
      assert.ok(error instanceof CommandValidationError);
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    return assert.fail("expected an error");
  };
  assert.ok(paths({ type: "message.create", roomId: "r", assignments: [{ recipients: [], instruction: "x" }] }).some((p) => p.startsWith("assignments.0.recipients")));
  assert.deepEqual(paths({ type: "message.create", roomId: "r", assignments: [{ recipients: ["p"], instruction: "" }] }), ["assignments.0.instruction: instruction is empty"]);
});
