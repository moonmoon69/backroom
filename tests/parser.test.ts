import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_GONE, HOLD_GONE, NOTE_GONE, STEER_GONE, parseExplicit, type Draft, type DraftAssignment } from "../src/parser/explicit.ts";

const participants = [
  { id: "p1", alias: "sol1" },
  { id: "p2", alias: "sol2" },
  { id: "p3", alias: "claude" },
];

const only = (draft: Draft): DraftAssignment => {
  assert.equal(draft.assignments.length, 1, `expected one assignment, got ${draft.assignments.length}`);
  return draft.assignments[0] as DraftAssignment;
};
const shape = (draft: Draft) => draft.assignments.map((a) => ({ to: a.recipients, text: a.instruction, after: a.after.map((d) => d.index) }));
const errorsOf = (draft: Draft) => draft.unresolved.filter((u) => u.severity === "error").map((u) => u.message);

test("@alias sends now with verbatim instruction", () => {
  const draft = parseExplicit("@sol2 review the current diff", participants);
  assert.equal(draft.kind, "task");
  const a = only(draft);
  assert.deepEqual(a.recipients, ["p2"]);
  assert.equal(a.instruction, "review the current diff");
  assert.deepEqual([a.timing, a.after], [null, []]);
  assert.deepEqual(draft.unresolved, []);
});

test("multiple leading mentions share one assignment", () => {
  const a = only(parseExplicit("@sol1 @sol2 independently investigate the timeout", participants));
  assert.deepEqual(a.recipients, ["p1", "p2"]);
  assert.equal(a.instruction, "independently investigate the timeout");
  assert.deepEqual(only(parseExplicit("@sol1 and @sol2, investigate it", participants)).recipients, ["p1", "p2"]);
});

test("a later mention starts a separate assignment", () => {
  assert.deepEqual(shape(parseExplicit("@sol1 please do this @sol2 please do that", participants)), [
    { to: ["p1"], text: "please do this", after: [] },
    { to: ["p2"], text: "please do that", after: [] },
  ]);
  assert.deepEqual(shape(parseExplicit("@sol1 fix the parser.\n@sol2 update the docs", participants)), [
    { to: ["p1"], text: "fix the parser.", after: [] },
    { to: ["p2"], text: "update the docs", after: [] },
  ]);
});

test("naming an earlier recipient, or 'then', would make an assignment wait for it, which is refused (D2)", () => {
  const review = parseExplicit("@sol1 go do this. @sol2 check sol1's work", participants);
  assert.deepEqual(shape(review), [
    { to: ["p1"], text: "go do this.", after: [] },
    { to: ["p2"], text: "check sol1's work", after: [0] },
  ]);
  assert.equal(review.assignments[1]?.after[0]?.because, "mention");
  assert.deepEqual(errorsOf(review), ["Waiting for @sol1 is gone: send this once @sol1 is done, have the Consigliere sequence it, or add /now to send it now."]);
  const then = parseExplicit("@sol1 implement X, then @sol2 review it", participants);
  assert.deepEqual(shape(then), [
    { to: ["p1"], text: "implement X", after: [] },
    { to: ["p2"], text: "review it", after: [0] },
  ]);
  assert.equal(then.assignments[1]?.after[0]?.because, "then");
  assert.deepEqual(shape(parseExplicit("@sol1 build it. Then @sol2 deploy it", participants))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("@sol1 build it @sol2 review @sol1's diff", participants))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("Sol one, build it. Sol two, test what sol one built", participants)), [
    { to: ["p1"], text: "build it.", after: [] },
    { to: ["p2"], text: "test what sol one built", after: [0] },
  ]);
});

test("/now opts out of waiting; /after @name names that assignment in the message, and is refused", () => {
  const now = parseExplicit("@sol1 go do this. @sol2 /now read sol1's notes", participants);
  assert.deepEqual(now.assignments[1]?.after, []);
  assert.deepEqual(errorsOf(now), []);
  const explicit = parseExplicit("@sol1 build it. @sol2 draft docs. @claude /after @sol1 test it", participants);
  assert.deepEqual(explicit.assignments[2]?.after, [{ index: 0, because: "after" }]);
  assert.equal(explicit.assignments[2]?.instruction, "test it");
  assert.deepEqual(errorsOf(explicit), [AFTER_GONE]);
});

test("mentions that read as references stay inside the instruction", () => {
  const cases = [
    "@sol2 review @sol1's changes",
    "@sol2 pair with @sol1 on the parser",
    "@sol2 check what @sol1 did",
    "@sol2 when finished tell @sol1",
  ];
  for (const text of cases) {
    const a = only(parseExplicit(text, participants));
    assert.deepEqual(a.recipients, ["p2"], text);
    assert.ok(a.instruction.includes("@sol1"), text);
  }
  const draft = parseExplicit("@sol2 pair with @sol1 on the parser", participants);
  assert.deepEqual(draft.mentions.map((m) => [m.alias, m.role]), [["sol2", "address"], ["sol1", "reference"]]);
});

test("text before the first address is a preamble, not an assignment", () => {
  const draft = parseExplicit("The build is red. @sol1 fix it. @sol2 find the cause", participants);
  assert.equal(draft.preamble, "The build is red.");
  assert.equal(draft.assignments.length, 2);
  const greeting = parseExplicit("hey @sol1 can you fix X", participants);
  assert.deepEqual(shape(greeting), [{ to: ["p1"], text: "can you fix X", after: [] }]);
});

test("unfinished drafts are incomplete, not errors", () => {
  const bare = parseExplicit("@sol2", participants);
  assert.deepEqual(bare.unresolved.map((u) => [u.field, u.severity]), [["instruction", "incomplete"]]);
  const nobody = parseExplicit("review the diff", participants);
  assert.ok(nobody.unresolved.every((u) => u.severity === "incomplete"));
  const unknown = parseExplicit("@sol10 do it", participants);
  assert.ok(unknown.unresolved.some((u) => u.severity === "error" && u.message.includes("sol10")));
});

test("/after and /hold are refused wherever they are written, whatever they name (D2)", () => {
  const after = only(parseExplicit("/after task41 @sol2 review the implementation", participants));
  assert.deepEqual([after.recipients, after.instruction, after.timing], [["p2"], "review the implementation", "after"]);
  assert.deepEqual(after.unresolved.map((u) => u.message), [AFTER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("@sol2 /after @sol1 review it", participants)), [AFTER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("/after task41, task43 @claude compare their findings", participants)), [AFTER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("/after task99 @sol2 review", participants)), [AFTER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("/hold @sol2 save this for later", participants)), [HOLD_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("/hold /after task41 @sol2 x", participants)), [AFTER_GONE, HOLD_GONE]);
});



test("spoken alias at the start resolves the recipient", () => {
  const a = only(parseExplicit("Sol two, review once sol one finishes the parser", participants));
  assert.deepEqual(a.recipients, ["p2"]);
  assert.equal(a.instruction, "review once sol one finishes the parser");
  assert.deepEqual(a.after, [], "sol one has no assignment in this message");
});


test("the note directive is gone (N1): a message that starts with it is refused with one sentence; a T3 command that only begins like it is not", () => {
  for (const text of ["/note For context, preserve the public API. No action needed.", "  /NOTE keep it", "/note"]) {
    const draft = parseExplicit(text, participants);
    assert.deepEqual([draft.kind, draft.assignments, draft.unresolved.map((u) => [u.severity, u.message])], ["task", [], [["error", NOTE_GONE]]], text);
  }
  for (const text of ["/notes-sync", "/note-taker go", "@sol1 review the release notes"]) {
    assert.ok(!parseExplicit(text, participants).unresolved.some((u) => u.message === NOTE_GONE), text);
  }
});


test("alias pool @sol picks an available member or asks to choose", () => {
  const pooled = [
    { id: "p1", alias: "sol1", busy: true },
    { id: "p2", alias: "sol2", busy: false },
    { id: "p3", alias: "claude" },
  ];
  const picked = parseExplicit("@sol review the diff", pooled);
  assert.deepEqual(only(picked).recipients, ["p2"]);
  assert.ok(picked.consumed.includes("@sol→@sol2"));
  const none = only(parseExplicit("@sol review the diff", pooled.map((p) => ({ ...p, busy: true }))));
  assert.deepEqual(none.recipients, []);
  const issue = none.unresolved.find((u) => u.field === "recipients");
  assert.equal(issue?.participantCandidates?.length, 2);
});

test("/add seats a new name in the room and /remove retires one, both over bounded choices", () => {
  const add = parseExplicit("/add alice", participants);
  assert.equal(add.kind, "participant.add");
  assert.deepEqual(add.add, { alias: "alice" });
  assert.deepEqual(add.unresolved, []);
  const taken = parseExplicit("/add sol1", participants);
  assert.ok(taken.unresolved.some((u) => u.message.includes("already in this room")));
  const invalid = parseExplicit("/add bad name!", participants);
  assert.ok(invalid.unresolved.length > 0);
  const remove = parseExplicit("/remove @sol2", participants);
  assert.equal(remove.kind, "participant.remove");
  assert.deepEqual(remove.participant, { participantId: "p2", alias: "sol2" });
  const removeSpoken = parseExplicit("/remove sol two", participants);
  assert.deepEqual(removeSpoken.participant, { participantId: "p2", alias: "sol2" }, "spoken alias resolves exactly");
  assert.ok(parseExplicit("/remove sol nine", participants).unresolved.length > 0);
});

test("spoken forms are derived from the alias, so no spoken aliases need configuring", () => {
  const bare = [
    { id: "p1", alias: "sol1" },
    { id: "p2", alias: "sol2" },
    { id: "p3", alias: "code-reviewer" },
  ];
  assert.deepEqual(only(parseExplicit("Sol two, review the parser", bare)).recipients, ["p2"]);
  assert.deepEqual(only(parseExplicit("sol 1: implement it", bare)).recipients, ["p1"]);
  assert.deepEqual(only(parseExplicit("Code reviewer, look at the diff", bare)).recipients, ["p3"]);
  assert.deepEqual(parseExplicit("/remove sol two", bare).participant, { participantId: "p2", alias: "sol2" });
});

test("/add seats a new member by name", () => {
  const add = parseExplicit("/add alice", participants);
  assert.equal(add.kind, "participant.add");
  assert.deepEqual(add.add, { alias: "alice" });
  const taken = parseExplicit("/add sol1", participants);
  assert.ok(taken.unresolved.some((u) => u.message.includes("already in this room")));
  const none = parseExplicit("/add", participants);
  assert.ok(none.unresolved.some((u) => u.severity === "incomplete"));
});

test("conditions: 'when X finishes, @Y …', trailing 'when X finishes', and pronouns would make an assignment wait", () => {
  const people = [{ id: "f", alias: "fable" }, { id: "g", alias: "grok" }];
  const draft = parseExplicit("hey @fable please blah blah and @grok please do that. when @grok finishes @fable please check the work", people);
  assert.equal(draft.preamble, "hey");
  assert.deepEqual(shape(draft), [
    { to: ["f"], text: "please blah blah", after: [] },
    { to: ["g"], text: "please do that.", after: [] },
    { to: ["f"], text: "please check the work", after: [1] },
  ]);
  assert.equal(draft.assignments[2]?.after[0]?.because, "condition");
  assert.deepEqual(draft.mentions.filter((m) => m.assignment === 2).map((m) => [m.alias, m.role]), [["grok", "reference"], ["fable", "address"]]);

  assert.deepEqual(shape(parseExplicit("@sol1 build it @sol2 deploy it when sol1 finishes", participants))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("@sol1 fix the bug and once she's done @sol2 write a test", participants)), [
    { to: ["p1"], text: "fix the bug", after: [] },
    { to: ["p2"], text: "write a test", after: [0] },
  ]);
  assert.deepEqual(shape(parseExplicit("@sol1 build the API, @sol2 build the UI, and @claude review both once they're finished", participants))[2]?.after, [0, 1]);
  assert.deepEqual(shape(parseExplicit("@sol1 and @sol2, estimate it; @claude then pick the lower one", participants))[1]?.after, [0]);

  const unknownCondition = parseExplicit("when the tests pass, @sol2 deploy", participants);
  assert.equal(unknownCondition.assignments[0]?.instruction, "when the tests pass, deploy");
  assert.deepEqual(unknownCondition.assignments[0]?.after, []);
  assert.ok(unknownCondition.hints.some((h) => h.includes("cannot wait")));

  const external = parseExplicit("@sol2 review it when sol1 finishes", participants);
  assert.deepEqual(errorsOf(external), ["Waiting for other work is gone: send this once it is done, have the Consigliere sequence it, or add /now to send it now."], "no in-message assignment: a wait on sol1's work outside the message, refused");
  assert.deepEqual(errorsOf(parseExplicit("@sol2 review the code when you have time", participants)), []);
});

test("a leading condition the room waits for is taken out of the instruction; trailing ones stay", () => {
  const people = [{ id: "f", alias: "fable" }, { id: "g", alias: "grok" }];
  const draft = parseExplicit("@fable pretend to send a message @grok please tell me when @fable finishes. @fable when @grok finishes please send a message", people);
  assert.deepEqual(shape(draft), [
    { to: ["f"], text: "pretend to send a message", after: [] },
    { to: ["g"], text: "please tell me when @fable finishes.", after: [0] },
    { to: ["f"], text: "please send a message", after: [1] },
  ]);
  assert.equal(only(parseExplicit("@grok when the tests pass, deploy", people)).instruction, "when the tests pass, deploy", "an unobservable condition stays");
});

test("/steer is gone (M1): refused with its hint after an @name and at the start of a message, beside /hold too; in a sentence it is a word", () => {
  const steer = only(parseExplicit("@sol1 /steer also add tests", participants));
  assert.equal(steer.instruction, "also add tests");
  assert.deepEqual(errorsOf(parseExplicit("@sol1 /steer also add tests", participants)), [STEER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("/steer @sol1 also add tests", participants)), [STEER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("@sol1 /hold /steer x", participants)), [HOLD_GONE, STEER_GONE]);
  assert.deepEqual(errorsOf(parseExplicit("@sol1 add tests", participants)), []);
  assert.deepEqual(errorsOf(parseExplicit("@sol1 please /steer clear of the parser", participants)), [], "in the middle of a sentence it is plain text");
  assert.equal("delivery" in only(parseExplicit("@sol1 add tests", participants)), false);
  // A directive ends at the word: a T3 command that starts like one is not it.
  const command = only(parseExplicit("@sol1 /steer-mode on", participants));
  assert.deepEqual([command.slashCommand, errorsOf(parseExplicit("@sol1 /steer-mode on", participants))], ["steer-mode", []]);
});

test("quoted text addresses nobody: code blocks, inline code, > quotes, and \\@name", () => {
  const pasted = parseExplicit("@sol1 i'm seeing this in t3:\n```\n[briefing for @sol2]\n@sol2 /hold do it\n```\nwhy?", participants);
  assert.equal(pasted.assignments.length, 1);
  assert.deepEqual(pasted.assignments[0]?.recipients, ["p1"]);
  assert.match(pasted.assignments[0]?.instruction ?? "", /@sol2 \/hold do it/, "restored verbatim");
  assert.deepEqual(only(parseExplicit("@sol1 why does `@sol2 /hold` fail?", participants)).recipients, ["p1"]);
  assert.deepEqual(only(parseExplicit("@sol1 look:\n> @sol2 said hi\nthoughts?", participants)).recipients, ["p1"]);
  assert.equal(only(parseExplicit("@sol1 keep \\@sol2 literal", participants)).instruction, "keep \\@sol2 literal");
});

test("@all addresses every participant; the alias is reserved", () => {
  const all = only(parseExplicit("@all review the release notes", participants));
  assert.deepEqual(all.recipients, ["p1", "p2", "p3"]);
  assert.equal(all.instruction, "review the release notes");
  const split = parseExplicit("@sol1 draft the notes. @all review sol1's draft", participants);
  assert.deepEqual(split.assignments[1]?.recipients, ["p1", "p2", "p3"]);
  assert.deepEqual(split.assignments[1]?.after.map((d) => d.index), [0], "waits for sol1's draft");
  assert.ok(parseExplicit("/add all", participants).unresolved.some((u) => u.message.includes("reserved")));
});

test("'when @all finished' waits for every earlier assignment, or for everyone else's work, and is refused", () => {
  // Trailing, leading before the address, and leading inside the instruction: all wait for the whole @all assignment.
  const trailing = parseExplicit("@all do something. @sol1 cross check when @all finished", participants);
  assert.deepEqual(shape(trailing), [
    { to: ["p1", "p2", "p3"], text: "do something.", after: [] },
    { to: ["p1"], text: "cross check when @all finished", after: [0] },
  ]);
  assert.equal(trailing.assignments[1]?.after[0]?.because, "condition");
  assert.deepEqual(trailing.unresolved.map((u) => u.field), ["wait"]);
  assert.deepEqual(shape(parseExplicit("@all do something. @sol1 cross check once @all is done", participants))[1]?.after, [0]);
  assert.deepEqual(shape(parseExplicit("@all do something. when @all finished, @sol1 cross check", participants))[1], { to: ["p1"], text: "cross check", after: [0] });
  assert.deepEqual(shape(parseExplicit("@all do something. @sol1 when @all are finished, cross check", participants))[1], { to: ["p1"], text: "cross check", after: [0] });
  // Several earlier assignments: all of them.
  assert.deepEqual(shape(parseExplicit("@sol1 do X. @sol2 do Y. @claude cross check when @all finished", participants))[2]?.after, [0, 1]);

  assert.match(errorsOf(trailing)[0] ?? "", /^Waiting for @sol1 and @sol2 and @claude is gone/);
  // Nothing earlier in the message: a wait for everyone else's work outside it, refused.
  const standalone = parseExplicit("@sol1 cross check when @all finished", participants);
  assert.deepEqual(only(standalone).after, []);
  assert.deepEqual(errorsOf(standalone), ["Waiting for other work is gone: send this once it is done, have the Consigliere sequence it, or add /now to send it now."]);
  assert.match(errorsOf(parseExplicit("when @all finished, @sol1 cross check", participants))[0] ?? "", /^Waiting for other work is gone/);
});

test("with one participant, a message that addresses nobody is for them", () => {
  const solo = [{ id: "p3", alias: "claude" }];
  const plain = only(parseExplicit("review the current diff", solo));
  assert.deepEqual(plain.recipients, ["p3"]);
  assert.equal(plain.instruction, "review the current diff");
  assert.deepEqual(parseExplicit("review the current diff", solo).unresolved, []);
  assert.equal(only(parseExplicit("/compact", solo)).slashCommand, "compact");
  const held = only(parseExplicit("/hold save this for later", solo));
  assert.deepEqual([held.recipients, held.unresolved.map((u) => u.message)], [["p3"], [HOLD_GONE]]);
  assert.deepEqual(only(parseExplicit("@claude do it", solo)).recipients, ["p3"], "a mention still works");
  assert.ok(parseExplicit("@bob do it", solo).unresolved.some((u) => u.message.includes("nobody called @bob")), "a wrong name is not redirected");
  assert.ok(parseExplicit("review the diff", participants).unresolved.some((u) => u.field === "recipients"), "several participants: still ask who");
  assert.ok(parseExplicit("review the diff", []).unresolved.some((u) => u.field === "recipients"), "nobody seated: still ask who");
});

test("/now lifts a leading condition's wait as it lifts the others, and the condition stays in the instruction", () => {
  const people = [{ id: "g", alias: "grok" }, { id: "c", alias: "claude" }];
  const refused = parseExplicit("@grok build it. when @grok finishes, @claude write the summary", people);
  assert.deepEqual(refused.assignments[1]!.after, [{ index: 0, because: "condition" }]);
  assert.equal(refused.assignments[1]!.timing, null, "a condition is no written directive: the plan offers /now, not a removal");
  assert.deepEqual(errorsOf(refused), ["Waiting for @grok is gone: send this once @grok is done, have the Consigliere sequence it, or add /now to send it now."]);
  const now = parseExplicit("@grok build it. when @grok finishes, @claude /now write the summary", people);
  assert.deepEqual(errorsOf(now), []);
  assert.deepEqual([now.assignments[1]!.after, now.assignments[1]!.timing, now.assignments[1]!.instruction], [[], "now", "when @grok finishes, write the summary"]);
  // On work outside the message too.
  assert.deepEqual(errorsOf(parseExplicit("when @grok finishes, @claude write the summary", people)), ["Waiting for other work is gone: send this once it is done, have the Consigliere sequence it, or add /now to send it now."]);
  assert.deepEqual(errorsOf(parseExplicit("when @grok finishes, @claude /now write the summary", people)), []);
});

