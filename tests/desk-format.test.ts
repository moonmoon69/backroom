import assert from "node:assert/strict";
import { test } from "node:test";
import { isEffortOption } from "../src/domain/effort.ts";
import { optionLabel } from "../web/src/components/deskFormat.ts";

test("an option's label: every harness's spelling of the effort level reads 'effort', an unknown id reads as itself", () => {
  // Claude's effort, Codex's reasoningEffort, Cursor's reasoning (gpt-5.x, kimi, glm) and reasoning_effort (Grok 4.7 and
  // others): the ids the shared rule counts as the effort level (src/domain/effort.ts), so the label and the tile agree.
  for (const id of ["effort", "reasoningEffort", "reasoning", "reasoning_effort"]) assert.equal(optionLabel(id), "effort", id);
  assert.equal(optionLabel("contextWindow"), "ctx");
  assert.equal(optionLabel("fastMode"), "fast");
  assert.equal(optionLabel("someNewOption"), "someNewOption");
  assert.equal(optionLabel("thinking"), "thinking", "an option that is not the effort level keeps its own label");
  for (const id of ["effort", "reasoningEffort", "reasoning", "reasoning_effort"]) assert.equal(isEffortOption(id), true, id);
});
