import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomBrowsers, type BrowserBriefing } from "../src/browser/roomBrowsers.ts";
import { reconcileBrowserCatalog } from "../src/browser/catalog.ts";
import type { RoomError } from "../src/domain/errors.ts";
import { createTestStack } from "./helpers.ts";

/** Stands in for the process manager: records which browsers were asked for (by name). */
function fakeBrowsers(briefing: Omit<BrowserBriefing, "name" | "description"> | null) {
  const asked: string[] = [];
  const browsers = {
    asked,
    async briefingFor(browser: { id: string; name: string; description: string }) {
      asked.push(browser.name);
      return briefing ? { ...briefing, name: browser.name, description: browser.description } : null;
    },
    detach() {},
  };
  return browsers;
}

const RUNNING = { cdpUrl: "http://127.0.0.1:9301", cdpPort: 9301, mode: "vnc" as const, watchUrl: "http://box.ts.net:6101/vnc.html?autoconnect=1" };

test("a room with its browser on starts it and tells each agent where to attach", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  assert.equal(stack.repos.getRoom(stack.roomId)?.browserEnabled, true);
  assert.match(stack.repos.listEvents(stack.roomId).at(-1)?.text ?? "", /Browsers turned on: .*"general"/);

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "check the login page renders", schedule: { mode: "now" } });
  await stack.tick();
  assert.deepEqual(browsers.asked, ["general"], "a room without its own default uses general");
  const briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(briefing, /== Room browser ==/);
  assert.match(briefing, /This room's browser is "general"/);
  assert.match(briefing, /What it is for: General browsing/);
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
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => /Browsers turned on/.test(e.text)).length, 1, "turning it on twice records it once");
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

test("browsers are a list named by purpose; a room picks its default and the briefing names it", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  assert.deepEqual(stack.repos.listBrowsers().map((b) => b.name), ["general"], "general exists from the start");

  const created = (await stack.run({ type: "browser.create", name: "  T3-Rooms-Testing ", description: "Logged into staging as the test user" })) as { browserId: string };
  assert.equal(stack.repos.getBrowser(created.browserId)?.name, "t3-rooms-testing", "names are lowercased and trimmed");
  await assert.rejects(stack.run({ type: "browser.create", name: "t3-rooms-testing" }), (error: RoomError) => error.code === "browser_name_taken");
  await assert.rejects(stack.run({ type: "browser.create", name: "has spaces" }), /lowercase letters, digits and dashes/);

  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: created.browserId });
  assert.equal(stack.repos.getRoom(stack.roomId)?.defaultBrowserId, created.browserId);
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "run the smoke test", schedule: { mode: "now" } });
  await stack.tick();
  assert.deepEqual(browsers.asked, ["t3-rooms-testing"]);
  assert.match(stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing, /What it is for: Logged into staging as the test user/);

  await stack.run({ type: "browser.update", browserId: created.browserId, name: "staging" });
  assert.equal(stack.repos.getBrowser(created.browserId)?.name, "staging");
  await assert.rejects(stack.run({ type: "browser.delete", browserId: created.browserId }), (error: RoomError) => error.code === "browser_in_use" && /payments/.test(error.message));
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: null });
  await stack.run({ type: "browser.delete", browserId: created.browserId });
  assert.equal(stack.repos.getBrowser(created.browserId), null);
  assert.match(stack.repos.listEvents(stack.roomId).map((e) => e.text).join("\n"), /Default browser set to "general"/);
});

test("profile folders from before browsers were a list become browsers, and their room keeps using them", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-catalog-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "browsers", stack.roomId, "profile"), { recursive: true });
  mkdirSync(join(dataDir, "browsers", "0123456789abcdef", "profile"), { recursive: true });
  const adopted = reconcileBrowserCatalog(stack.repos, dataDir);
  assert.deepEqual(adopted.map((b) => [b.id, b.name]).sort(), [["0123456789abcdef", "browser-01234567"], [stack.roomId, "payments"]].sort());
  assert.equal(stack.repos.getRoom(stack.roomId)?.defaultBrowserId, stack.roomId, "the room's old browser stays its default");
  assert.deepEqual(reconcileBrowserCatalog(stack.repos, dataDir), [], "idempotent");
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
  const briefing = await browsers.briefingFor({ id: "room-a", name: "room-a", description: "" });
  assert.equal(briefing?.cdpPort, status.cdpPort);
  await browsers.stop("room-a");
  assert.equal(browsers.status("room-a").state, "stopped");
  const again = await browsers.ensure("room-a");
  assert.equal(again.cdpPort, status.cdpPort, "the port is stable per room");
});

test("a real headless Chrome quits cleanly on stop: its tabs come back and its history is kept", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = new RoomBrowsers({ dataDir, mode: "headless" });
  const site = createServer((_req, res) => res.end("<title>kept tab</title><h1>kept</h1>"));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/kept`;
  t.after(async () => {
    await browsers.stopAll();
    site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const status = await browsers.ensure("room-b");
  await fetch(`${status.cdpUrl}/json/new?${url}`, { method: "PUT" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await browsers.stop("room-b");

  // History is committed only by a normal quit; a killed Chrome leaves the visit in an uncommitted journal.
  const history = new DatabaseSync(join(dataDir, "browsers", "room-b", "profile", "Default", "History"), { readOnly: true });
  const visited = history.prepare("SELECT url FROM urls").all().map((row) => (row as { url: string }).url);
  history.close();
  assert.ok(visited.includes(url), `history keeps the visit (${visited.join(", ")})`);

  const again = await browsers.ensure("room-b");
  const tabs = (await (await fetch(`${again.cdpUrl}/json/list`)).json()) as Array<{ type: string; url: string }>;
  assert.ok(tabs.some((tab) => tab.type === "page" && tab.url === url), `the tab is reopened (${tabs.map((tab) => tab.url).join(", ")})`);
});

test("under systemd, a real Chrome runs in its own scope, outside the service's cgroup", { skip: process.env.ROOMS_TEST_CHROME !== "1" || process.platform !== "linux" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = new RoomBrowsers({ dataDir, mode: "headless", systemdScope: true });
  t.after(async () => {
    await browsers.stopAll();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await browsers.ensure("room-c");
  const state = JSON.parse(readFileSync(join(dataDir, "browsers", "room-c", "state.json"), "utf8")) as { groups: number[] };
  const chrome = state.groups[state.groups.length - 1] as number;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // Chrome moves its main process into a scope of its own, but its helpers (renderers, GPU, network) stay where they
  // were started. None of them may be in this process's cgroup, which is what a service restart kills.
  const members = execSync(`ps -o pid= -g ${chrome}`).toString().trim().split(/\s+/).filter(Boolean);
  const cgroups = members.map((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
    } catch {
      return null; // exited meanwhile
    }
  });
  const own = readFileSync("/proc/self/cgroup", "utf8").trim();
  assert.ok(members.length > 1, "Chrome started its helpers");
  assert.ok(!cgroups.includes(own), "no Chrome process is left in the service's cgroup");
  assert.ok(cgroups.some((cg) => cg !== null && /\/run-[^/]+\.scope$/.test(cg)), "the helpers run in the transient scope");
  await browsers.stop("room-c");
  assert.throws(() => process.kill(-chrome, 0), "the scoped process group is gone after stop");
});
