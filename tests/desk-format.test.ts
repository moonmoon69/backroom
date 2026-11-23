import assert from "node:assert/strict";
import { test } from "node:test";
import { isEffortOption } from "../src/domain/effort.ts";
import { hoursSince, optionLabel, roomTileTitle, startedWords } from "../web/src/components/deskFormat.ts";

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

test("how long a room has been around: minutes under one hour, then whole hours however long, nothing for no time", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(hoursSince("2026-11-23T12:00:00Z", now), "0m");
  assert.equal(hoursSince("2026-11-23T11:00:01Z", now), "59m");
  assert.equal(hoursSince("2026-11-23T11:00:00Z", now), "1h");
  assert.equal(hoursSince("2026-11-23T10:00:01Z", now), "1h", "an hour not yet over is not counted");
  assert.equal(hoursSince("2026-11-02T12:00:00Z", now), "504h", "three weeks stay hours, never days");
  assert.equal(hoursSince("2026-11-23T12:00:30Z", now), "0m", "a clock behind the service's does not go negative");
  for (const none of [null, undefined, "", "not a time"]) assert.equal(hoursSince(none, now), "", String(none));
});

test("when a room started, in words: the day and time, nothing for no time", () => {
  const iso = "2026-11-21T10:13:00Z";
  assert.equal(startedWords(iso), `Started ${new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`);
  for (const none of [null, undefined, "", "not a time"]) assert.equal(startedWords(none), "", String(none));
});

// Review #23: a title on the age inside the tile was never reached, the tile's button being stretched over it.
test("a room tile's hover text says when the room started, after what a click does; without a time, only that", () => {
  const iso = "2026-11-21T10:13:00Z";
  assert.equal(roomTileTitle("Search latency", iso), `Open Search latency · ${startedWords(iso)}`);
  assert.equal(roomTileTitle("Search latency", "not a time"), "Open Search latency");
});
