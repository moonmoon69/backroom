/** What counts as a changed standing section (src/briefing/assemble.ts): what a member acts on, not who else is seated. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefingHeader, changedStanding, standingFingerprint, type BrowsersBriefing } from "../src/briefing/assemble.ts";
import type { Participant, Room } from "../src/domain/types.ts";

test("standing sections count as changed for what a member acts on, not for who else is seated or a browser starting", () => {
  const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 1, browserEnabled: true, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: null, createdAt: "", updatedAt: "" };
  const member = (id: string, alias: string): Participant => ({ id, roomId: "r", alias, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "" });
  const sol1 = member("p1", "sol1");
  const sol2 = member("p2", "sol2");
  const browsers = (running: boolean): BrowsersBriefing => ({
    command: "rooms-browser", as: "sol1.r",
    browsers: [{ name: "work", description: "", isDefault: true, running }, { name: "shop", description: "", isDefault: false, running }],
    started: { name: "work", description: "", cdpUrl: "http://127.0.0.1:9222", cdpPort: 9222, mode: "window", watchUrl: null },
  });
  const ws = (participantId: string, alias: string, branch: string) => ({ participantId, alias, folder: "/repo", branch, isProjectRoot: true }) as never;
  const base = { room, participant: sol1, participantsById: new Map([[sol1.id, sol1]]), browsers: browsers(true), workspaces: [ws("p1", "sol1", "main")], board: { command: "rooms-board", as: "sol1.r" } };
  const had = standingFingerprint(base);
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, browsers: browsers(false) })), [], "a browser stopping is not news");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, participantsById: new Map([[sol1.id, sol1], [sol2.id, sol2]]) })), [], "nor a seat");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: null })), [], "T3 not answering is not a change");
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: [ws("p1", "sol1", "feature")] })), ["workspaces"]);
  assert.deepEqual(changedStanding(had, standingFingerprint({ ...base, workspaces: [ws("p1", "sol1", "main"), ws("p2", "sol2", "main")] })), ["workspaces"], "someone now shares the folder");
  const off = { ...base, room: { ...room, browserEnabled: false }, browsers: null };
  assert.deepEqual(changedStanding(had, standingFingerprint(off)), ["browsers"]);

  assert.equal(
    briefingHeader(off, ["browsers"], { seat: false }).join("\n"),
    '[Backroom briefing for @sol1 in room "payments". Your standing rules, where everyone works and the room\'s state: `rooms-board rules --as sol1.r`]\n' +
      "Changed since your last briefing:\n== Browsers ==\nThis room's shared browsers are off now: don't use a browser for its work.",
  );
});
