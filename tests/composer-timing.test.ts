/**
 * The plan row's fix for a timing D2 refuses (web/src/components/composerText.ts timingFixes, setTiming): "Remove /…"
 * only for a directive written in the head, "Send it now" for a wait the text implies, a condition's included; the fix
 * applied, the message parses with nothing refused (Z4 review round 1, item 4).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExplicit, type DraftAssignment } from "../src/parser/explicit.ts";
import { setTiming, timingFixes } from "../web/src/components/composerText.ts";

const members = [{ id: "c", alias: "claude" }, { id: "g", alias: "grok" }];
const errors = (text: string) => parseExplicit(text, members).unresolved.filter((u) => u.severity === "error").map((u) => u.message);

/** The text after the row's fix for assignment `index` is applied, with the fix offered. */
function fix(text: string, index: number): { offered: ReturnType<typeof timingFixes>; text: string } {
  const assignment = parseExplicit(text, members).assignments[index] as DraftAssignment;
  const offered = timingFixes(assignment);
  const timing = offered.remove ? null : offered.sendNow ? "now" : undefined;
  assert.notEqual(timing, undefined, `a fix is offered for ${JSON.stringify(text)}`);
  return { offered, text: setTiming(text, assignment, timing ?? null).text };
}

test("a leading condition offers Send it now, not Remove /after, and /now lifts its wait with the condition kept in the instruction", () => {
  for (const [text, index] of [["when @grok finishes, @claude write the summary", 0], ["@grok build it. when @grok finishes, @claude write the summary", 1]] as const) {
    assert.equal(errors(text).length, 1, text);
    const fixed = fix(text, index);
    assert.deepEqual(fixed.offered, { remove: null, sendNow: true }, text);
    assert.match(fixed.text, /when @grok finishes, @claude \/now write the summary$/);
    assert.deepEqual(errors(fixed.text), [], fixed.text);
    assert.equal(parseExplicit(fixed.text, members).assignments[index]!.instruction, "when @grok finishes, write the summary", "the member still reads the condition");
  }
});

test("a written /after or /hold offers its removal; a wait the text implies offers Send it now; nothing else offers a fix", () => {
  const after = fix("/after @claude @grok deploy it", 0);
  assert.deepEqual(after.offered, { remove: "after", sendNow: false });
  assert.equal(after.text, "@grok deploy it");
  assert.deepEqual(errors(after.text), []);
  const hold = fix("/hold @grok save this for later", 0);
  assert.deepEqual(hold.offered, { remove: "hold", sendNow: false });
  assert.deepEqual(errors(hold.text), []);
  for (const [text, index] of [["@claude build it, then @grok deploy it", 1], ["@claude fix it. @grok check claude's work", 1], ["@grok deploy it when claude finishes", 0]] as const) {
    const fixed = fix(text, index);
    assert.deepEqual(fixed.offered, { remove: null, sendNow: true }, text);
    assert.deepEqual(errors(fixed.text), [], fixed.text);
  }
  // M1: a written /steer offers its removal too, and the message then goes as it is (into a running turn, if any).
  const steer = fix("@grok /steer deploy it", 0);
  assert.deepEqual(steer.offered, { remove: "steer", sendNow: false });
  assert.equal(steer.text, "@grok deploy it");
  assert.deepEqual(errors(steer.text), []);
  assert.deepEqual(timingFixes(parseExplicit("@grok deploy it", members).assignments[0]!), { remove: null, sendNow: false });
  assert.deepEqual(timingFixes(parseExplicit("@claude build it. @grok /now read the notes", members).assignments[1]!), { remove: null, sendNow: false });
});
