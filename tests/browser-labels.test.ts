/**
 * The accessible names of a browser's controls in the room's side panel (web/src/browserLabels.ts): each holds the words
 * the control shows, and tells the browsers apart (label in name).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COPY_TEXT, copyWatchLinkName, nameHoldsText, powerName, powerText, WATCH_LINK_TEXT, watchLinkName, type PowerPhase } from "../web/src/browserLabels.ts";

test("the Watch link's name holds its visible words and says which browser", () => {
  assert.equal(WATCH_LINK_TEXT, "Open the browser screen");
  assert.equal(watchLinkName("staging"), "Open the browser screen of staging");
  assert.ok(nameHoldsText(watchLinkName("staging"), WATCH_LINK_TEXT));
  assert.notEqual(watchLinkName("staging"), watchLinkName("general"));
  assert.equal(watchLinkName(), "Open the browser screen", "on a browser's own page it is its words alone");
});

test("the Copy button's name holds Copy and says which browser's link", () => {
  for (const name of ["staging", undefined]) assert.ok(nameHoldsText(copyWatchLinkName(name), COPY_TEXT), `${name}: ${copyWatchLinkName(name)}`);
  assert.notEqual(copyWatchLinkName("staging"), copyWatchLinkName("general"));
  assert.equal(copyWatchLinkName(), "Copy watch link");
});

test("a Start or Stop button's name holds the words it shows, in every phase, and says which browser", () => {
  const phases: PowerPhase[] = ["start", "stop", "starting", "stopping"];
  for (const phase of phases) {
    assert.ok(nameHoldsText(powerName(phase, "staging"), powerText(phase, true)), `${phase}: shows ${powerText(phase, true)}, named ${powerName(phase, "staging")}`);
    assert.notEqual(powerName(phase, "staging"), powerName(phase, "general"));
  }
  assert.deepEqual(phases.map((phase) => powerText(phase, true)), ["Start", "Stop", "Starting…", "Stopping…"]);
  assert.deepEqual(phases.map((phase) => powerText(phase, false)), ["Start browser", "Stop browser", "Starting…", "Stopping…"], "alone, as before");
});

test("the panel draws the Watch link with those words and that name", () => {
  const source = readFileSync(new URL("../web/src/components/RoomBrowser.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label=\{name \? watchLinkName\(name\) : undefined\}>\s*\{WATCH_LINK_TEXT\}\s*<\/a>/, "the link shows WATCH_LINK_TEXT and is named by watchLinkName");
  assert.match(source, /label=\{copyWatchLinkName\(name\)\}/);
  assert.match(source, /aria-label=\{label\}[^>]*onClick=\{power\.(stop|start)\}/, "Start and Stop are named by powerName");
  assert.doesNotMatch(source, /aria-label=\{name \? `/, "no name is spelled out in the panel itself");
});
