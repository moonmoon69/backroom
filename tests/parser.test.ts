import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExplicit, type Draft, type DraftAssignment } from "../src/parser/explicit.ts";
import type { Task } from "../src/domain/types.ts";

const participants = [
  { id: "p1", alias: "sol1" },
  { id: "p2", alias: "sol2" },
  { id: "p3", alias: "claude" },
];

function task(number: number, participantId: string, state: Task["state"], revision = 1): Task {
  return {
    id: `t${number}`, roomId: "r", number, revision, sourceEventId: "e", participantId, instruction: `work ${number}`, sourceText: null, attachmentIds: [], delivery: "queue", slashCommand: false,
    scheduleMode: "now", prerequisites: [], state, stateReason: null, currentRunId: null, userOutcome: null, createdAt: "", updatedAt: "",
  };
}

const only = (draft: Draft): DraftAssignment => {
  assert.equal(draft.assignments.length, 1, `expected one assignment, got ${draft.assignments.length}`);
  return draft.assignments[0] as DraftAssignment;
};
const shape = (draft: Draft) => draft.assignments.map((a) => ({ to: a.recipients, text: a.instruction, after: a.after.map((d) => d.index) }));

test("@alias sends now with verbatim instruction", () => {
  const draft = parseExplicit("@sol2 review the current diff", participants, []);
  assert.equal(draft.kind, "task");
  const a = only(draft);
  assert.deepEqual(a.recipients, ["p2"]);
  assert.equal(a.instruction, "review the current diff");
  assert.deepEqual(a.schedule, { mode: "now" });
  assert.deepEqual(draft.unresolved, []);
});

test("multiple leading mentions share one assignment", () => {
  const a = only(parseExplicit("@sol1 @sol2 independently investigate the timeout", participants, []));
  assert.deepEqual(a.recipients, ["p1", "p2"]);
  assert.equal(a.instruction, "independently investigate the timeout");
  assert.deepEqual(only(parseExplicit("@sol1 and @sol2, investigate it", participants, [])).recipients, ["p1", "p2"]);
});

test("a later mention starts a separate assignment", () => {
  assert.deepEqual(shape(parseExplicit("@sol1 please do this @sol2 please do that", participants, [])), [
    { to: ["p1"], text: "please do this", after: [] },
    { to: ["p2"], text: "please do that", after: [] },
  ]);
  assert.deepEqual(shape(parseExplicit("@sol1 fix the parser.\n@sol2 update the docs", participants, [])), [
    { to: ["p1"], text: "fix the parser.", after: [] },
    { to: ["p2"], text: "update the docs", after: [] },
  ]);
});

test("naming an earlier recipient, or 'then', makes an assignment wait for it", () => {
  const review = parseExplicit("@sol1 go do this. @sol2 check sol1's work", participants, []);
  assert.deepEqual(shape(review), [
    { to: ["p1"], text: "go do this.", after: [] },
    { to: ["p2"], text: "check sol1's work", after: [0] },
  ]);
  assert.equal(review.assignments[1]?.after[0]?.because, "mention");
  const then = parseExplicit("@sol1 implement X, then @sol2 review it", participants, []);
  assert.deepEqual(shape(then), [
    { to: ["p1"], text: "implement X", after: [] },
    { to: ["p2"], text: "review it", after: [0] },
  ]);
  assert.equal(then.assignments[1]?.after[0]?.because, "then");
  assert.deepEqual(shape(parseExplicit("@sol1 build it. Then @sol2 deploy it", participants, []))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("@sol1 build it @sol2 review @sol1's diff", participants, []))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("Sol one, build it. Sol two, test what sol one built", participants, [])), [
    { to: ["p1"], text: "build it.", after: [] },
    { to: ["p2"], text: "test what sol one built", after: [0] },
  ]);
});

test("/now opts out of waiting and /after @name waits for that name's assignment in the message", () => {
  const now = parseExplicit("@sol1 go do this. @sol2 /now read sol1's notes", participants, []);
  assert.deepEqual(now.assignments[1]?.after, []);
  assert.deepEqual(now.assignments[1]?.schedule, { mode: "now" });
  const explicit = parseExplicit("@sol1 build it. @sol2 draft docs. @claude /after @sol1 test it", participants, []);
  assert.deepEqual(explicit.assignments[2]?.after, [{ index: 0, because: "after" }]);
});

test("mentions that read as references stay inside the instruction", () => {
  const cases = [
    "@sol2 review @sol1's changes",
    "@sol2 pair with @sol1 on the parser",
    "@sol2 check what @sol1 did",
    "@sol2 when finished tell @sol1",
  ];
  for (const text of cases) {
    const a = only(parseExplicit(text, participants, []));
    assert.deepEqual(a.recipients, ["p2"], text);
    assert.ok(a.instruction.includes("@sol1"), text);
  }
  const draft = parseExplicit("@sol2 pair with @sol1 on the parser", participants, []);
  assert.deepEqual(draft.mentions.map((m) => [m.alias, m.role]), [["sol2", "address"], ["sol1", "reference"]]);
});

test("text before the first address is a preamble, not an assignment", () => {
  const draft = parseExplicit("The build is red. @sol1 fix it. @sol2 find the cause", participants, []);
  assert.equal(draft.preamble, "The build is red.");
  assert.equal(draft.assignments.length, 2);
  const greeting = parseExplicit("hey @sol1 can you fix X", participants, []);
  assert.deepEqual(shape(greeting), [{ to: ["p1"], text: "can you fix X", after: [] }]);
});

test("unfinished drafts are incomplete, not errors", () => {
  const bare = parseExplicit("@sol2", participants, []);
  assert.deepEqual(bare.unresolved.map((u) => [u.field, u.severity]), [["instruction", "incomplete"]]);
  const nobody = parseExplicit("review the diff", participants, []);
  assert.ok(nobody.unresolved.every((u) => u.severity === "incomplete"));
  const unknown = parseExplicit("@sol10 do it", participants, []);
  assert.ok(unknown.unresolved.some((u) => u.severity === "error" && u.message.includes("sol10")));
});

test("/after task41 resolves a revision-pinned prerequisite", () => {
  const tasks = [task(41, "p1", "running", 2)];
  const a = only(parseExplicit("/after task41 @sol2 review the implementation", participants, tasks));
  assert.deepEqual(a.schedule, { mode: "after_all", prerequisites: [{ taskId: "t41", revision: 2 }] });
  assert.deepEqual(a.recipients, ["p2"]);
  assert.equal(a.instruction, "review the implementation");
});

test("/after @alias picks the single open task or asks to choose", () => {
  const single = only(parseExplicit("@sol2 /after @sol1 review it", participants, [task(41, "p1", "running")]));
  assert.deepEqual(single.schedule, { mode: "after_all", prerequisites: [{ taskId: "t41", revision: 1 }] });
  const ambiguous = only(parseExplicit("@sol2 /after @sol1 review it", participants, [task(41, "p1", "running"), task(42, "p1", "queued")]));
  assert.equal(ambiguous.schedule, null);
  const issue = ambiguous.unresolved.find((u) => u.field === "prerequisites");
  assert.ok(issue?.candidates && issue.candidates.length === 2);
});

test("/after both tasks builds a fan-in", () => {
  const tasks = [task(41, "p1", "running"), task(43, "p3", "running")];
  const a = only(parseExplicit("/after task41, task43 @claude compare their findings", participants, tasks));
  assert.deepEqual(a.schedule?.mode, "after_all");
  assert.equal((a.schedule as { prerequisites: unknown[] }).prerequisites.length, 2);
});

test("spoken alias at the start resolves the recipient", () => {
  const a = only(parseExplicit("Sol two, review once sol one finishes the parser", participants, []));
  assert.deepEqual(a.recipients, ["p2"]);
  assert.equal(a.instruction, "review once sol one finishes the parser");
  assert.deepEqual(a.schedule, { mode: "now" }, "sol one has no assignment in this message, so nothing to wait for");
});

test("/hold creates a manually held draft; /hold with /after is inconsistent", () => {
  assert.deepEqual(only(parseExplicit("/hold @sol2 save this for later", participants, [])).schedule, { mode: "manual" });
  const mixed = only(parseExplicit("/hold /after task41 @sol2 x", participants, [task(41, "p1", "running")]));
  assert.equal(mixed.schedule, null);
  assert.ok(mixed.unresolved.some((u) => u.field === "schedule"));
});

test("/note produces a room note", () => {
  const draft = parseExplicit("/note For context, preserve the public API. No action needed.", participants, []);
  assert.equal(draft.kind, "note");
  assert.equal(draft.instruction, "For context, preserve the public API. No action needed.");
});

test("missing task references stay unresolved without a model", () => {
  const missingTask = only(parseExplicit("/after task99 @sol2 review", participants, []));
  assert.equal(missingTask.schedule, null);
  assert.ok(missingTask.unresolved.some((u) => u.field === "prerequisites"));
});

test("alias pool @sol picks an available member or asks to choose", () => {
  const pooled = [
    { id: "p1", alias: "sol1", busy: true },
    { id: "p2", alias: "sol2", busy: false },
    { id: "p3", alias: "claude" },
  ];
  const picked = parseExplicit("@sol review the diff", pooled, []);
  assert.deepEqual(only(picked).recipients, ["p2"]);
  assert.ok(picked.consumed.includes("@sol→@sol2"));
  const none = only(parseExplicit("@sol review the diff", pooled.map((p) => ({ ...p, busy: true })), []));
  assert.deepEqual(none.recipients, []);
  const issue = none.unresolved.find((u) => u.field === "recipients");
  assert.equal(issue?.participantCandidates?.length, 2);
});

test("/add seats a new name in the room and /remove retires one, both over bounded choices", () => {
  const add = parseExplicit("/add alice", participants, []);
  assert.equal(add.kind, "participant.add");
  assert.deepEqual(add.add, { alias: "alice" });
  assert.deepEqual(add.unresolved, []);
  const taken = parseExplicit("/add sol1", participants, []);
  assert.ok(taken.unresolved.some((u) => u.message.includes("already in this room")));
  const invalid = parseExplicit("/add bad name!", participants, []);
  assert.ok(invalid.unresolved.length > 0);
  const remove = parseExplicit("/remove @sol2", participants, []);
  assert.equal(remove.kind, "participant.remove");
  assert.deepEqual(remove.participant, { participantId: "p2", alias: "sol2" });
  const removeSpoken = parseExplicit("/remove sol two", participants, []);
  assert.deepEqual(removeSpoken.participant, { participantId: "p2", alias: "sol2" }, "spoken alias resolves exactly");
  assert.ok(parseExplicit("/remove sol nine", participants, []).unresolved.length > 0);
});

test("spoken forms are derived from the alias, so no spoken aliases need configuring", () => {
  const bare = [
    { id: "p1", alias: "sol1" },
    { id: "p2", alias: "sol2" },
    { id: "p3", alias: "code-reviewer" },
  ];
  assert.deepEqual(only(parseExplicit("Sol two, review the parser", bare, [])).recipients, ["p2"]);
  assert.deepEqual(only(parseExplicit("sol 1: implement it", bare, [])).recipients, ["p1"]);
  assert.deepEqual(only(parseExplicit("Code reviewer, look at the diff", bare, [])).recipients, ["p3"]);
  assert.deepEqual(parseExplicit("/remove sol two", bare, []).participant, { participantId: "p2", alias: "sol2" });
});

test("/add with a role and /role assign over finite lists", () => {
  const roles = [{ id: "r1", name: "accountant" }];
  const add = parseExplicit("/add alice role accountant", participants, [], roles);
  assert.equal(add.kind, "participant.add");
  assert.deepEqual(add.add, { alias: "alice", roleId: "r1", roleName: "accountant" });
  const badRole = parseExplicit("/add alice role wizard", participants, [], roles);
  assert.ok(badRole.unresolved.some((u) => u.message.includes("available: accountant")));
  const assign = parseExplicit("/role @sol1 accountant", participants, [], roles);
  assert.equal(assign.kind, "participant.role");
  assert.deepEqual(assign.participant, { participantId: "p1", alias: "sol1" });
  assert.deepEqual(assign.role, { roleId: "r1", name: "accountant" });
  const clear = parseExplicit("/role sol one none", participants, [], roles);
  assert.deepEqual(clear.role, { roleId: "", name: "none" });
  const which = parseExplicit("/role @sol1", participants, [], roles);
  assert.ok(which.unresolved.some((u) => u.message.includes("which role")));
});

test("conditions: 'when X finishes, @Y …', trailing 'when X finishes', and pronouns make an assignment wait", () => {
  const people = [{ id: "f", alias: "fable" }, { id: "g", alias: "grok" }];
  const draft = parseExplicit("hey @fable please blah blah and @grok please do that. when @grok finishes @fable please check the work", people, []);
  assert.equal(draft.preamble, "hey");
  assert.deepEqual(shape(draft), [
    { to: ["f"], text: "please blah blah", after: [] },
    { to: ["g"], text: "please do that.", after: [] },
    { to: ["f"], text: "please check the work", after: [1] },
  ]);
  assert.equal(draft.assignments[2]?.after[0]?.because, "condition");
  assert.deepEqual(draft.mentions.filter((m) => m.assignment === 2).map((m) => [m.alias, m.role]), [["grok", "reference"], ["fable", "address"]]);

  assert.deepEqual(shape(parseExplicit("@sol1 build it @sol2 deploy it when sol1 finishes", participants, []))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("@sol1 fix the bug and once she's done @sol2 write a test", participants, [])), [
    { to: ["p1"], text: "fix the bug", after: [] },
    { to: ["p2"], text: "write a test", after: [0] },
  ]);
  assert.deepEqual(shape(parseExplicit("@sol1 build the API, @sol2 build the UI, and @claude review both once they're finished", participants, []))[2]?.after, [0, 1]);
  assert.deepEqual(shape(parseExplicit("@sol1 and @sol2, estimate it; @claude then pick the lower one", participants, []))[1]?.after, [0]);

  const unknownCondition = parseExplicit("when the tests pass, @sol2 deploy", participants, []);
  assert.equal(unknownCondition.assignments[0]?.instruction, "when the tests pass, deploy");
  assert.deepEqual(unknownCondition.assignments[0]?.after, []);
  assert.ok(unknownCondition.hints.some((h) => h.includes("cannot wait")));

  const external = only(parseExplicit("@sol2 review it when sol1 finishes", participants, [task(41, "p1", "running")]));
  assert.deepEqual(external.schedule, { mode: "after_all", prerequisites: [{ taskId: "t41", revision: 1 }] }, "no in-message assignment: wait for sol1's open task");
  assert.deepEqual(only(parseExplicit("@sol2 review the code when you have time", participants, [])).schedule, { mode: "now" });
});

test("a leading condition the room waits for is taken out of the instruction; trailing ones stay", () => {
  const people = [{ id: "f", alias: "fable" }, { id: "g", alias: "grok" }];
  const draft = parseExplicit("@fable pretend to send a message @grok please tell me when @fable finishes. @fable when @grok finishes please send a message", people, []);
  assert.deepEqual(shape(draft), [
    { to: ["f"], text: "pretend to send a message", after: [] },
    { to: ["g"], text: "please tell me when @fable finishes.", after: [0] },
    { to: ["f"], text: "please send a message", after: [1] },
  ]);
  assert.equal(only(parseExplicit("@grok when the tests pass, deploy", people, [])).instruction, "when the tests pass, deploy", "an unobservable condition stays");
});

test("/steer marks an assignment for delivery into a running turn; it cannot be held", () => {
  const steer = only(parseExplicit("@sol1 /steer also add tests", participants, []));
  assert.equal(steer.delivery, "steer");
  assert.equal(steer.instruction, "also add tests");
  assert.deepEqual(steer.schedule, { mode: "now" });
  assert.equal(only(parseExplicit("@sol1 add tests", participants, [])).delivery, "queue");
  const held = only(parseExplicit("@sol1 /hold /steer x", participants, []));
  assert.equal(held.schedule, null);
  assert.ok(held.unresolved.some((u) => u.message.includes("/steer")));
});

test("quoted text addresses nobody: code blocks, inline code, > quotes, and \\@name", () => {
  const pasted = parseExplicit("@sol1 i'm seeing this in t3:\n```\n[briefing for @sol2]\n@sol2 /hold do it\n```\nwhy?", participants, []);
  assert.equal(pasted.assignments.length, 1);
  assert.deepEqual(pasted.assignments[0]?.recipients, ["p1"]);
  assert.match(pasted.assignments[0]?.instruction ?? "", /@sol2 \/hold do it/, "restored verbatim");
  assert.deepEqual(only(parseExplicit("@sol1 why does `@sol2 /hold` fail?", participants, [])).recipients, ["p1"]);
  assert.deepEqual(only(parseExplicit("@sol1 look:\n> @sol2 said hi\nthoughts?", participants, [])).recipients, ["p1"]);
  assert.equal(only(parseExplicit("@sol1 keep \\@sol2 literal", participants, [])).instruction, "keep \\@sol2 literal");
});

test("@all addresses every participant; the alias is reserved", () => {
  const all = only(parseExplicit("@all review the release notes", participants, []));
  assert.deepEqual(all.recipients, ["p1", "p2", "p3"]);
  assert.equal(all.instruction, "review the release notes");
  const split = parseExplicit("@sol1 draft the notes. @all review sol1's draft", participants, []);
  assert.deepEqual(split.assignments[1]?.recipients, ["p1", "p2", "p3"]);
  assert.deepEqual(split.assignments[1]?.after.map((d) => d.index), [0], "waits for sol1's draft");
  assert.ok(parseExplicit("/add all", participants, []).unresolved.some((u) => u.message.includes("reserved")));
});

test("with one participant, a message that addresses nobody is for them", () => {
  const solo = [{ id: "p3", alias: "claude" }];
  const plain = only(parseExplicit("review the current diff", solo, []));
  assert.deepEqual(plain.recipients, ["p3"]);
  assert.equal(plain.instruction, "review the current diff");
  assert.deepEqual(plain.schedule, { mode: "now" });
  assert.deepEqual(parseExplicit("review the current diff", solo, []).unresolved, []);
  assert.equal(only(parseExplicit("/compact", solo, [])).slashCommand, "compact");
  const held = only(parseExplicit("/hold save this for later", solo, []));
  assert.deepEqual([held.recipients, held.schedule], [["p3"], { mode: "manual" }]);
  assert.deepEqual(only(parseExplicit("@claude do it", solo, [])).recipients, ["p3"], "a mention still works");
  assert.ok(parseExplicit("@bob do it", solo, []).unresolved.some((u) => u.message.includes("unknown participant @bob")), "a wrong name is not redirected");
  assert.ok(parseExplicit("review the diff", participants, []).unresolved.some((u) => u.field === "recipients"), "several participants: still ask who");
  assert.ok(parseExplicit("review the diff", [], []).unresolved.some((u) => u.field === "recipients"), "nobody seated: still ask who");
});
