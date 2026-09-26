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
import { agentKey, browsersForRoom, reconcileBrowserCatalog, roomForKey } from "../src/browser/catalog.ts";
import { BrowserTools, type BrowserToolError } from "../src/browser/tools.ts";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
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
  assert.match(briefing, /== Browsers ==/);
  assert.match(briefing, /- general \(this room's default\): General browsing/);
  const key = `sol1.${stack.roomId.slice(0, 8)}`;
  assert.ok(briefing.includes(`rooms-browser general open <url> --as ${key}`), "the command, with the agent's own key");
  assert.match(briefing, /Work only in tabs you opened/);
  assert.match(briefing, /http:\/\/box\.ts\.net:6101\/vnc\.html/);
  assert.match(briefing, /DevTools connections at http:\/\/127\.0\.0\.1:9301/, "the DevTools address stays as a fallback");
  // The browser section sits in the header, before the assignment.
  assert.ok(briefing.indexOf("== Browsers ==") < briefing.indexOf("== Your assignment"));
});

test("rooms without a browser never start one; turning it on twice is recorded once", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1", "sol2"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "plain task", schedule: { mode: "now" } });
  await stack.tick();
  assert.deepEqual(browsers.asked, []);
  assert.doesNotMatch(stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing, /== Browsers ==/);

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
  assert.doesNotMatch(stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing, /== Browsers ==/);
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
  const briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(briefing, /- t3-rooms-testing \(this room's default\): Logged into staging as the test user/);
  assert.match(briefing, /- general \(stopped; starts on first use\): General browsing/, "every browser the room may use is listed");

  await stack.run({ type: "browser.update", browserId: created.browserId, name: "staging" });
  assert.equal(stack.repos.getBrowser(created.browserId)?.name, "staging");
  await assert.rejects(stack.run({ type: "browser.delete", browserId: created.browserId }), (error: RoomError) => error.code === "browser_in_use" && /payments/.test(error.message));
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: null });
  await stack.run({ type: "browser.delete", browserId: created.browserId });
  assert.equal(stack.repos.getBrowser(created.browserId), null);
  assert.match(stack.repos.listEvents(stack.roomId).map((e) => e.text).join("\n"), /Default browser set to "general"/);
});

test("a room can be limited to some browsers; its default must be one of them", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  const testing = ((await stack.run({ type: "browser.create", name: "testing", description: "Staging logins" })) as { browserId: string }).browserId;
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: testing, allowed: [testing] });
  assert.deepEqual(stack.repos.getRoom(stack.roomId)?.allowedBrowserIds, [testing]);
  await assert.rejects(stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: "general" }), (error: RoomError) => error.code === "default_not_allowed");

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "check staging", schedule: { mode: "now" } });
  await stack.tick();
  const briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(briefing, /- testing \(this room's default\): Staging logins/);
  assert.doesNotMatch(briefing, /- general/, "browsers outside the room's list are not offered");

  // While the room uses it, the browser cannot be deleted. Once the room's browsers are off it can; the room's list,
  // left empty, is cleared and its browsers stay off rather than silently widening to every browser.
  await assert.rejects(stack.run({ type: "browser.delete", browserId: testing }), (error: RoomError) => error.code === "browser_in_use");
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: false });
  await stack.run({ type: "browser.delete", browserId: testing });
  assert.equal(stack.repos.getRoom(stack.roomId)?.allowedBrowserIds, null);
  assert.equal(stack.repos.getRoom(stack.roomId)?.browserEnabled, false);
});

test("a room need not use general: dropping it from the list moves the default to a browser still allowed", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  const testing = ((await stack.run({ type: "browser.create", name: "testing", description: "Staging logins" })) as { browserId: string }).browserId;
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  // No default chosen: the room uses general. Unticking general (the panel sends the next default with the list).
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: testing, allowed: [testing] });
  const room = stack.repos.getRoom(stack.roomId)!;
  assert.deepEqual([room.defaultBrowserId, room.allowedBrowserIds], [testing, [testing]]);
  const notes = stack.repos.listEvents(stack.roomId).filter((e) => e.kind === "system").map((e) => e.text);
  assert.ok(notes.includes('This room may use these browsers: testing; its default is now "testing"'), notes.join(" | "));

  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol1!], instruction: "check staging", schedule: { mode: "now" } });
  await stack.tick();
  const briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(briefing, /- testing \(this room's default\): Staging logins/);
  assert.doesNotMatch(briefing, /- general/);
});

test("rooms-browser rules that need no browser: help, list, and a room's limits", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const testing = ((await stack.run({ type: "browser.create", name: "testing" })) as { browserId: string }).browserId;
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: testing, allowed: [testing] });
  const manager = { status: () => ({ state: "stopped" }), ensure: async () => assert.fail("no browser should start"), touch() {} };
  const tools = new BrowserTools({
    browsers: manager as never,
    findBrowser: (name) => stack.repos.getBrowserByName(name) ?? stack.repos.getBrowser(name),
    listBrowsers: () => stack.repos.listBrowsers(),
    roomForKey: (key) => roomForKey(stack.repos, key),
    browsersForRoom: (room) => browsersForRoom(stack.repos, room),
  });
  const key = agentKey("sol1", stack.roomId);
  assert.match(await tools.run(["help"], { as: null, force: false }), /Work only in tabs you opened/);
  assert.match(await tools.run(["list"], { as: key, force: false }), /- testing \(stopped; starts on first use\)/);
  assert.doesNotMatch(await tools.run(["list"], { as: key, force: false }), /general/, "a room's agent sees only its browsers");
  await assert.rejects(tools.run(["general", "tabs"], { as: key, force: false }), (error: BrowserToolError) => error.status === 403 && /can't use "general"/.test(error.message));
  await assert.rejects(tools.run(["nosuch", "tabs"], { as: key, force: false }), (error: BrowserToolError) => error.status === 404);
  await assert.rejects(tools.run(["testing", "open", "https://example.com"], { as: null, force: false }), /Pass --as/);
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: false });
  await assert.rejects(tools.run(["testing", "tabs"], { as: key, force: false }), /turned off/);
});

test("the tool endpoint needs the token from browser-api.json", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const calls: string[][] = [];
  const tools = { run: async (argv: string[]) => (calls.push(argv), "ran") };
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-tools", ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: tools as never, token: "secret", command: "rooms-browser" });
  const post = (headers: Record<string, string>) => app.request("/api/browser-tools", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ argv: ["list"], as: "sol1.x" }) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
  const ok = await post({ authorization: "Bearer secret" });
  assert.deepEqual(await ok.json(), { text: "ran" });
  assert.deepEqual(calls, [["list"]]);
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

test("rooms-browser against a real headless Chrome: own tabs, element uids, refusals, --force", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = new RoomBrowsers({ dataDir, mode: "headless" });
  const record = { id: "tools", name: "tools", description: "", createdAt: "", updatedAt: "" };
  const tools = new BrowserTools({ browsers, findBrowser: (name) => (name === "tools" ? record : null), listBrowsers: () => [record], roomForKey: () => null, browsersForRoom: () => [record] });
  const site = createServer((_req, res) => res.end(`<title>form</title><h1>ready</h1><input aria-label="Name"><button onclick="document.querySelector('h1').textContent='hi '+document.querySelector('input').value">Greet</button>`));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/form`;
  t.after(async () => {
    tools.closeAll();
    await browsers.stopAll();
    site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const a = { as: "sol1.aaaaaaaa", force: false };
  const opened = await tools.run(["tools", "open", url], a);
  const tab = /Opened tab (\d+)/.exec(opened)?.[1];
  assert.ok(tab, opened);
  const snapshot = await tools.run(["tools", tab, "snapshot"], a);
  const input = /uid=(\S+) textbox "Name"/.exec(snapshot)?.[1];
  const button = /uid=(\S+) button "Greet"/.exec(snapshot)?.[1];
  assert.ok(input && button, snapshot);
  await tools.run(["tools", tab, "fill", input, "Ada", "Lovelace"], a);
  await tools.run(["tools", tab, "click", button], a);
  assert.match(await tools.run(["tools", tab, "eval", "() => document.querySelector('h1').textContent"], a), /hi Ada Lovelace/);
  assert.match(await tools.run(["tools", "tabs"], a), new RegExp(`${tab}: form .*\\[yours\\]`));
  await assert.rejects(tools.run(["tools", tab, "snapshot"], { as: "sol2.bbbbbbbb", force: false }), /belongs to sol1\.aaaaaaaa/);
  assert.match(await tools.run(["tools", tab, "snapshot"], { as: "sol2.bbbbbbbb", force: true }), /hi Ada Lovelace/);
  assert.match(await tools.run(["tools", tab, "screenshot"], a), /Saved screenshot to .*\.png/);
  await tools.run(["tools", tab, "close"], a);
  assert.doesNotMatch(await tools.run(["tools", "tabs"], a), /form/);
});
