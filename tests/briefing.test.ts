import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBriefing } from "../src/briefing/assemble.ts";
import type { Participant, Room, RoomEvent, Task } from "../src/domain/types.ts";

const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 10, nextTaskNumber: 3, browserEnabled: false,
  defaultBrowserId: null,
  allowedBrowserIds: null, createdAt: "", updatedAt: "" };
const sol1: Participant = { id: "p1", roomId: "r", alias: "sol1", roleId: null, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, createdAt: "", updatedAt: "" };
const sol2: Participant = { ...sol1, id: "p2", alias: "sol2", roleId: "role-reviewer" };
const reviewer = { id: "role-reviewer", name: "reviewer", rules: "Review carefully.", createdAt: "", updatedAt: "" };
const participantsById = new Map([[sol1.id, sol1], [sol2.id, sol2]]);
const task: Task = { id: "t2", roomId: "r", number: 2, revision: 1, sourceEventId: "e", participantId: "p2", instruction: "Review the implementation", sourceText: null, attachmentIds: [], delivery: "queue", slashCommand: false, scheduleMode: "after_all", prerequisites: [{ taskId: "t1", revision: 1 }], state: "queued", stateReason: null, currentRunId: null, userOutcome: null, createdAt: "", updatedAt: "" };

function event(sequence: number, text: string, kind: RoomEvent["kind"] = "user.message"): RoomEvent {
  return { id: `e${sequence}`, roomId: "r", sequence, kind, speaker: { type: "user" }, text, taskId: null, runId: null, artifacts: [], attachmentIds: [], progress: [], prompt: null, sourceRef: null, createdAt: "" };
}

test("briefing keeps unseen messages, prerequisite results, and the assignment separately", () => {
  const prerequisiteTask: Task = { ...task, id: "t1", number: 1, participantId: "p1", instruction: "Implement the parser", scheduleMode: "now", prerequisites: [], state: "succeeded" };
  const result: RoomEvent = { ...event(5, "Parser implemented in src/parser.ts", "assistant.reply"), speaker: { type: "participant", participantId: "p1", bindingId: "b1" }, artifacts: [{ path: "src/parser.ts", kind: "modified", additions: 40, deletions: 2 }] };
  const briefing = assembleBriefing({
    room, participant: sol2, role: reviewer, participantsById, task,
    unseenEvents: [event(3, "Preserve the public API.", "note"), result],
    prerequisiteResults: [{ task: prerequisiteTask, assigneeAlias: "sol1", resultEvent: result }],
    bootstrap: true, budgetChars: 60000,
  });
  assert.match(briefing.text, /with the role "reviewer"/);
  assert.match(briefing.text, /Rules for the role "reviewer":\nReview carefully\./);
  assert.match(briefing.text, /\[#3 note\]\nPreserve the public API\./);
  assert.match(briefing.text, /== Completed prerequisites ==\ntask1 by @sol1: Implement the parser/);
  assert.match(briefing.text, /modified src\/parser\.ts \(\+40 -2\)/);
  assert.match(briefing.text, /== Your assignment \(task2\) ==\nReview the implementation/);
  assert.equal(briefing.condensed, false);
  // The prerequisite result is not duplicated in the unseen-messages section.
  assert.equal(briefing.text.split("Parser implemented in src/parser.ts").length, 2);
});

test("older messages are condensed when the budget is exceeded and the condensation is visible", () => {
  const events = Array.from({ length: 6 }, (_, index) => event(index + 1, `message ${index + 1} ` + "x".repeat(400)));
  const briefing = assembleBriefing({ room, participant: sol2, role: null, participantsById, task, unseenEvents: events, prerequisiteResults: [], bootstrap: false, budgetChars: 2200 });
  assert.equal(briefing.condensed, true);
  assert.ok(briefing.condensedEventIds.includes("e1"), "oldest event condensed first");
  assert.ok(!briefing.condensedEventIds.includes("e6"), "newest event kept in full");
  assert.match(briefing.text, /were condensed to fit the delivery budget/);
  assert.match(briefing.text, /message 6 x{400}/);
});
