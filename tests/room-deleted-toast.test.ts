/** The toast after a room is deleted (web/src/roomDeleted.ts): neutral unless T3 refused an action or had not answered it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { roomDeletedToast } from "../web/src/roomDeleted.ts";

const thread = (alias: string, action: string, result: "done" | "kept" | "failed" | "timeout", detail?: string) => ({
  participantId: `p-${alias}`,
  alias,
  threadId: `t-${alias}`,
  action,
  result,
  ...(detail ? { detail } : {}),
});

test("a clean delete is neutral and names each thread's result", () => {
  assert.deepEqual(roomDeletedToast("Finishup", [thread("w1", "settle", "done"), thread("w2", "delete", "done"), thread("w3", "keep", "kept")]), {
    message: 'Deleted "Finishup". Threads: @w1 settled, @w2 deleted, @w3 kept.',
    kind: "info",
  });
  assert.deepEqual(roomDeletedToast("Finishup", [thread("w1", "keep", "kept"), thread("w2", "keep", "kept")]), { message: 'Deleted "Finishup". Threads kept in T3.', kind: "info" });
  assert.deepEqual(roomDeletedToast("Empty", []), { message: 'Deleted "Empty".', kind: "info" });
  assert.deepEqual(roomDeletedToast("Shared", [thread("w1", "delete", "kept", "also used in another room")]), {
    message: 'Deleted "Shared". Threads: @w1 kept (also used in another room).',
    kind: "info",
  });
});

test("a refused or unanswered action makes it an error, with the other threads' results still shown", () => {
  assert.deepEqual(
    roomDeletedToast("Finishup", [thread("w1", "settle", "done"), thread("w2", "settle", "timeout", "T3 had not answered after 5 s"), thread("w3", "archive", "failed", "T3 refused thread.archive")]),
    {
      message: 'Deleted "Finishup". Threads: @w1 settled. Sent to T3, not confirmed in time (may still go through): @w2 settle. Not changed in T3: @w3: T3 refused thread.archive.',
      kind: "error",
    },
  );
  assert.equal(roomDeletedToast("Finishup", [thread("w1", "settle", "timeout")]).kind, "error");
  assert.equal(roomDeletedToast("Finishup", [thread("w1", "settle", "failed")]).kind, "error");
});
