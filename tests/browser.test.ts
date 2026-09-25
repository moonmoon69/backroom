import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomBrowsers, type BrowserBriefing } from "../src/browser/roomBrowsers.ts";
import { createTestStack } from "./helpers.ts";

/** Stands in for the process manager: records which rooms asked for a browser. */
function fakeBrowsers(briefing: BrowserBriefing | null) {
  const asked: string[] = [];
  const browsers = {
    asked,
    async briefingFor(roomId: string) {
      asked.push(roomId);
      return briefing;
    },
    detach() {},
  };
  return browsers;
}

const RUNNING: BrowserBriefing = { cdpUrl: "http://127.0.0.1:9301", cdpPort: 9301, mode: "vnc", watchUrl: "http://box.ts.net:6101/vnc.html?autoconnect=1" };

test("a room with its browser on starts it and tells each agent where to attach", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  assert.equal(stack.repos.getRoom(stack.roomId)?.browserEnabled, true);
  assert.match(stack.repos.listEvents(stack.roomId).at(-1)?.text ?? "", /Shared browser turned on/);

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "check the login page renders", schedule: { mode: "now" } });
  await stack.tick();
  assert.deepEqual(browsers.asked, [stack.roomId]);
  const briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(briefing, /== Room browser ==/);
  assert.match(briefing, /DevTools endpoint: http:\/\/127\.0\.0\.1:9301/);
  assert.match(briefing, /agent-browser connect 9301/);
  assert.match(briefing, /open your own tab/);
  assert.match(briefing, /http:\/\/box\.ts\.net:6101\/vnc\.html/);
  // The browser section sits in the header, before the assignment.
  assert.ok(briefing.indexOf("== Room browser ==") < briefing.indexOf("== Your assignment"));
});

test("rooms without a browser never start one; turning it on twice is recorded once", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1", "sol2"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "plain task", schedule: { mode: "now" } });
  await stack.tick();
  assert.deepEqual(browsers.asked, []);
  assert.doesNotMatch(stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing, /Room browser/);

  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => /Shared browser/.test(e.text)).length, 1, "turning it on twice records it once");
});

test("a browser that cannot start leaves the briefing without a browser section", async (t) => {
  const browsers = fakeBrowsers(null);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "anything", schedule: { mode: "now" } });
  await stack.tick();
  assert.equal(stack.task(1).state, "dispatching");
  assert.doesNotMatch(stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing, /Room browser/);
});

test("ROOMS_BROWSER_MODE=off reports the browser as unavailable", () => {
  const browsers = new RoomBrowsers({ dataDir: "/nonexistent", mode: "off" });
  assert.equal(browsers.environment().mode, null);
  const status = browsers.status("room");
  assert.equal(status.state, "stopped");
  assert.match(status.error ?? "", /disabled/);
});

// Launches a real headless Chrome; opt in with ROOMS_TEST_CHROME=1.
test("a real headless Chrome: start, attach, see tabs, stop, restart on the same port", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = new RoomBrowsers({ dataDir, mode: "headless" });
  t.after(async () => {
    await browsers.stopAll();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const status = await browsers.ensure("room-a");
  assert.equal(status.state, "running");
  const version = (await (await fetch(`${status.cdpUrl}/json/version`)).json()) as { Browser: string };
  assert.match(version.Browser, /Chrome|Chromium/);
  await fetch(`${status.cdpUrl}/json/new?https://example.com`, { method: "PUT" });
  const briefing = await browsers.briefingFor("room-a");
  assert.equal(briefing?.cdpPort, status.cdpPort);
  await browsers.stop("room-a");
  assert.equal(browsers.status("room-a").state, "stopped");
  const again = await browsers.ensure("room-a");
  assert.equal(again.cdpPort, status.cdpPort, "the port is stable per room");
});
