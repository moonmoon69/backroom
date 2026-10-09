import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomBrowsers, type BrowserBriefing, type RoomBrowserOptions } from "../src/browser/roomBrowsers.ts";
import { accessForKey, agentKey, reconcileBrowserCatalog, threadKey } from "../src/browser/catalog.ts";
import { mainCheckoutData } from "../src/browser/ports.ts";
import { BrowserTools, BrowserToolError, cdpCall } from "../src/browser/tools.ts";
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
    status: () => ({ state: "stopped" }),
    detach() {},
  };
  return browsers;
}

/** The briefing of the member's latest turn, as T3 received it. */
const briefingOf = (stack: Awaited<ReturnType<typeof createTestStack>>, alias: string) => {
  const thread = stack.fake.threads.get(stack.threadOf(alias))!;
  return thread.messages.find((m) => m.id === thread.runs.at(-1)!.userMessageId)!.text;
};

const RUNNING = { cdpUrl: "http://127.0.0.1:9301", cdpPort: 9301, mode: "vnc" as const, watchUrl: "http://box.ts.net:6101/vnc.html?autoconnect=1" };

test("a room with its browser on starts it and tells each agent where to attach", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  assert.equal(stack.repos.getRoom(stack.roomId)?.browserEnabled, true);
  assert.match(stack.repos.listEvents(stack.roomId).at(-1)?.text ?? "", /Browsers turned on: .*"general"/);

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "check the login page renders" }] });
  await stack.tick();
  assert.deepEqual(browsers.asked, ["general"], "a room without its own default uses general");
  const briefing = briefingOf(stack, "sol1");
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
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "plain work" }] });
  await stack.tick();
  assert.deepEqual(browsers.asked, []);
  assert.doesNotMatch(briefingOf(stack, "sol1"), /== Browsers ==/);

  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  assert.equal(stack.repos.listEvents(stack.roomId).filter((e) => /Browsers turned on/.test(e.text)).length, 1, "turning it on twice records it once");
});

test("a browser that cannot start leaves the briefing without a browser section", async (t) => {
  const browsers = fakeBrowsers(null);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true });
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "anything" }] });
  await stack.tick();
  assert.doesNotMatch(briefingOf(stack, "sol1"), /== Browsers ==/);
});

test("browsers are a list named by purpose; a room picks its default and the briefing names it", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  assert.deepEqual(stack.repos.listBrowsers().map((b) => b.name), ["general"], "general exists from the start");

  const created = (await stack.run({ type: "browser.create", name: "  Backroom-Testing ", description: "Logged into staging as the test user" })) as { browserId: string };
  assert.equal(stack.repos.getBrowser(created.browserId)?.name, "backroom-testing", "names are lowercased and trimmed");
  await assert.rejects(stack.run({ type: "browser.create", name: "backroom-testing" }), (error: RoomError) => error.code === "browser_name_taken");
  await assert.rejects(stack.run({ type: "browser.create", name: "has spaces" }), /lowercase letters, digits and dashes/);

  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: true, browserId: created.browserId });
  assert.equal(stack.repos.getRoom(stack.roomId)?.defaultBrowserId, created.browserId);
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "run the smoke test" }] });
  await stack.tick();
  assert.deepEqual(browsers.asked, ["backroom-testing"]);
  const briefing = briefingOf(stack, "sol1");
  assert.match(briefing, /- backroom-testing \(this room's default\): Logged into staging as the test user/);
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

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "check staging" }] });
  await stack.tick();
  const briefing = briefingOf(stack, "sol1");
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

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "check staging" }] });
  await stack.tick();
  const briefing = briefingOf(stack, "sol1");
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
    accessFor: (key) => accessForKey(stack.repos, key),
  });
  const key = agentKey("sol1", stack.roomId);
  assert.match(await tools.run(["help"], { as: null, force: false }), /Work only in tabs you opened/);
  assert.match(await tools.run(["list"], { as: key, force: false }), /- testing \(stopped; starts on first use\)/);
  assert.doesNotMatch(await tools.run(["list"], { as: key, force: false }), /general/, "a room's agent sees only its browsers");
  await assert.rejects(tools.run(["general", "tabs"], { as: key, force: false }), (error: BrowserToolError) => error.status === 403 && /can't use "general"/.test(error.message));
  await assert.rejects(tools.run(["nosuch", "tabs"], { as: key, force: false }), (error: BrowserToolError) => error.status === 404);
  // Every command but help names the agent, and only keys Backroom gave out are taken.
  for (const argv of [["list"], ["testing", "tabs"], ["testing", "open", "https://example.com"]]) {
    await assert.rejects(tools.run(argv, { as: null, force: false }), /Pass --as/);
  }
  await assert.rejects(tools.run(["list"], { as: "someone.00000000", force: false }), (error: BrowserToolError) => error.status === 403 && /not a key Backroom gave out/.test(error.message));
  await stack.run({ type: "room.browser", roomId: stack.roomId, enabled: false });
  await assert.rejects(tools.run(["testing", "tabs"], { as: key, force: false }), /turned off/);
  await assert.rejects(tools.run(["list"], { as: key, force: false }), /turned off/, "a room with browsers off lists none either");
});

test("a thread outside rooms gets browsers as a room does: off until chosen, then only the ones it may use", async (t) => {
  const browsers = fakeBrowsers(RUNNING);
  const stack = await createTestStack({ autoCompleteMs: null }, ["sol1"], { browsers: () => browsers as never });
  t.after(() => stack.close());
  const testing = ((await stack.run({ type: "browser.create", name: "testing", description: "Staging logins" })) as { browserId: string }).browserId;
  const manager = { status: () => ({ state: "stopped" }), ensure: async () => assert.fail("no browser should start"), touch() {} };
  const tools = new BrowserTools({
    browsers: manager as never,
    findBrowser: (name) => stack.repos.getBrowserByName(name) ?? stack.repos.getBrowser(name),
    accessFor: (key) => accessForKey(stack.repos, key),
  });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-thread-browsers", ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "t", command: "rooms-browser" });
  const threadId = "1a2b3c4d-0000-4000-8000-000000000000";
  const key = threadKey(threadId);
  const briefing = async () => app.request(`/api/threads/${threadId}/browser-briefing`);

  // Nothing chosen: off, like a new room. The instructions are refused too.
  await assert.rejects(tools.run(["list"], { as: key, force: false }), /turned off for this thread/);
  assert.equal((await briefing()).status, 409);

  // On, with one browser: the instructions list it alone, and the tool keeps to it.
  await stack.run({ type: "thread.browser", threadId, enabled: true, browserId: testing, allowed: [testing] });
  const text = ((await (await briefing()).json()) as { text: string }).text;
  assert.match(text, /- testing \(your default\): Staging logins/);
  assert.doesNotMatch(text, /- general/, "browsers outside the thread's list are not offered");
  assert.match(text, /--as thread\.1a2b3c4d/);
  assert.match(await tools.run(["list"], { as: key, force: false }), /- testing/);
  assert.doesNotMatch(await tools.run(["list"], { as: key, force: false }), /general/);
  await assert.rejects(tools.run(["general", "tabs"], { as: key, force: false }), (error: BrowserToolError) => error.status === 403 && /This thread can't use "general"/.test(error.message));

  // The same rules as a room's: the default must be allowed; null widens the list to every browser.
  await assert.rejects(stack.run({ type: "thread.browser", threadId, enabled: true, browserId: "general" }), (error: RoomError) => error.code === "default_not_allowed");
  await stack.run({ type: "thread.browser", threadId, enabled: true, allowed: null });
  assert.match(await tools.run(["list"], { as: key, force: false }), /- general/);

  // Off again: refused, and the thread view says so.
  await stack.run({ type: "thread.browser", threadId, enabled: false });
  await assert.rejects(tools.run(["testing", "tabs"], { as: key, force: false }), /turned off for this thread/);
  assert.deepEqual(stack.repos.getThreadBrowsers(threadId)?.allowedBrowserIds, null);
});

/**
 * A Chrome and its engines, as BrowserTools sees them, for tests without a browser: tabs by Chrome's tab id, each
 * engine numbering the pages its own way (engine k from 100·k, in the order it meets them), and a wait_for that
 * returns only when the test releases it.
 */
function fakeChrome() {
  const tabs = new Map<string, { url: string; window: number; active: boolean }>();
  const calls: Array<{ engine: number; tool: string; args: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  let tabSeq = 0;
  let windows = 0;
  const waits: Array<() => void> = [];
  const engines: Array<{ closed: boolean }> = [];
  tabs.set("TAB-USER", { url: "https://user.example/", window: ++windows, active: true });
  const cdp = async (_url: string, method: string, params: Record<string, unknown>) => {
    if (method === "Target.createTarget") {
      created.push(params);
      const tabId = `TAB-${++tabSeq}`;
      tabs.set(tabId, { url: String(params.url), window: params.newWindow ? ++windows : 1, active: true });
      return { targetId: `PAGE-OF-${tabId}` };
    }
    if (method === "Target.closeTarget") {
      tabs.delete(String(params.targetId).replace("PAGE-OF-", ""));
      return {};
    }
    if (method === "Target.getTargets") return { targetInfos: [...tabs].map(([targetId, t]) => ({ targetId, type: "tab", embedderData: { tabActive: t.active } })) };
    throw new Error(`unexpected ${method}`);
  };
  const engine = () => {
    const k = engines.length + 1;
    const ids = new Map<string, number>();
    let next = 100 * k;
    const idOf = (tabId: string) => {
      if (!ids.has(tabId)) ids.set(tabId, next++);
      return ids.get(tabId) as number;
    };
    const tabOf = (page: unknown) => [...ids].find(([, id]) => id === page)?.[0];
    const state = { closed: false };
    engines.push(state);
    const listing = () => `## Pages\n${[...tabs].map(([tabId, t]) => `${idOf(tabId)}: ${t.url}`).join("\n")}`;
    return {
      get closed() {
        return state.closed;
      },
      close() {
        state.closed = true;
      },
      async callTool(tool: string, args: Record<string, unknown>) {
        calls.push({ engine: k, tool, args });
        if (tool === "list_pages") return { text: listing(), isError: false };
        const tabId = tabOf(args.pageId);
        if (!tabId || !tabs.has(tabId)) return { text: "No page found", isError: true };
        const tab = tabs.get(tabId)!;
        if (tool === "get_tab_id") return { text: `Tab ID: ${tabId}`, isError: false };
        if (tool === "navigate_page") {
          tab.url = String(args.url);
          return { text: `Successfully navigated to ${tab.url}.\n${listing()}`, isError: false };
        }
        if (tool === "wait_for") await new Promise<void>((release) => waits.push(release));
        if (tool === "close_page") {
          tabs.delete(tabId);
          return { text: listing(), isError: false };
        }
        return { text: `${tool} on ${tab.url}`, isError: false };
      },
    };
  };
  const manager = { status: () => ({ state: "running", cdpUrl: "http://127.0.0.1:9399", startedAt: "2026-10-09T00:00:00.000Z" }), ensure: async () => assert.fail("it runs"), touch() {} };
  return { tabs, calls, created, waits, engines, cdp, engine, manager };
}

test("two agents in one browser: each its own engine and windows, one tab number for everyone, no waiting for the other", async () => {
  const chrome = fakeChrome();
  const record = { id: "shared", name: "shared", description: "", createdAt: "", updatedAt: "" };
  const tools = new BrowserTools({
    browsers: chrome.manager as never,
    findBrowser: (name) => (name === "shared" ? record : null),
    accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }),
    engine: chrome.engine as never,
    cdp: chrome.cdp,
    engineIdleMs: 50,
  });
  const a = { as: "worker.aaaaaaaa", force: false };
  const b = { as: "reviewer.aaaaaaaa", force: false };
  const tabA = /Opened tab (\d+) in "shared" \(yours, in a window of its own\)/.exec(await tools.run(["shared", "open", "http://127.0.0.1:4461/"], a))?.[1];
  const tabB = /Opened tab (\d+)/.exec(await tools.run(["shared", "open", "http://127.0.0.1:4462/"], b))?.[1];
  assert.ok(tabA && tabB && tabA !== tabB);
  assert.equal(chrome.engines.length, 2, "an engine per agent");
  assert.deepEqual(
    chrome.created.map((c) => c.newWindow),
    [true, true],
    "every tab opens in a window of its own",
  );
  assert.ok(chrome.calls.some((c) => c.engine === 1 && c.tool === "navigate_page" && c.args.url === "http://127.0.0.1:4461/"), "a's engine loads a's page");

  // The engines number pages differently (100… and 200…); the tools show one number per tab to both, with its owner.
  const seenByA = await tools.run(["shared", "tabs"], a);
  const seenByB = await tools.run(["shared", "tabs"], b);
  assert.match(seenByA, new RegExp(`^${tabA}: http://127.0.0.1:4461/ \\[yours\\]$`, "m"));
  assert.match(seenByA, new RegExp(`^${tabB}: http://127.0.0.1:4462/ \\[reviewer.aaaaaaaa's\\]$`, "m"));
  assert.match(seenByB, new RegExp(`^${tabA}: http://127.0.0.1:4461/ \\[worker.aaaaaaaa's\\]$`, "m"));
  assert.match(seenByB, new RegExp(`^${tabB}: http://127.0.0.1:4462/ \\[yours\\]$`, "m"));
  assert.match(seenByB, /: https:\/\/user.example\/ \[not opened by an agent\]$/m);
  assert.doesNotMatch(seenByA, /\b[12]\d\d:/, "no engine's own page id shows");

  // a waits on its page; b's calls go through meanwhile.
  const waiting = tools.run(["shared", tabA, "wait-for", "never"], a);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(chrome.waits.length, 1, "a's wait_for is running");
  assert.match(await tools.run(["shared", tabB, "eval", "() => 1"], b), /evaluate_script on http:\/\/127.0.0.1:4462\//);
  chrome.waits[0]!();
  assert.match(await waiting, /wait_for on http:\/\/127.0.0.1:4461\//);

  // Ownership as before: b may not use a's tab without --force; with it, b's own engine does it.
  await assert.rejects(tools.run(["shared", tabA, "snapshot"], b), (error: BrowserToolError) => error.status === 403 && /belongs to worker\.aaaaaaaa/.test(error.message));
  assert.match(await tools.run(["shared", tabA, "snapshot"], { ...b, force: true }), /take_snapshot on http:\/\/127.0.0.1:4461\//);
  assert.equal(chrome.calls.at(-1)?.engine, 2, "b's engine ran it");

  // A tab behind another of its window is never drawn: its screenshot is refused instead of hanging.
  const [tabIdA] = [...chrome.tabs].find(([, t]) => t.url === "http://127.0.0.1:4461/")!;
  chrome.tabs.get(tabIdA)!.active = false;
  await assert.rejects(tools.run(["shared", tabA, "screenshot"], a), (error: BrowserToolError) => error.status === 409 && /behind another tab of its window/.test(error.message));
  chrome.tabs.get(tabIdA)!.active = true;
  assert.match(await tools.run(["shared", tabA, "screenshot"], a), /take_screenshot on/);

  // An engine unused for a while closes; the agent's next call starts another, and its tab is still its own.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(chrome.engines.every((e) => e.closed), "both engines closed after no use");
  assert.match(await tools.run(["shared", tabA, "eval", "() => 2"], a), /evaluate_script on http:\/\/127.0.0.1:4461\//);
  assert.equal(chrome.engines.length, 3);

  // A closed tab's number is gone for everyone.
  await tools.run(["shared", tabB, "close"], b);
  await assert.rejects(tools.run(["shared", tabB, "snapshot"], b), (error: BrowserToolError) => error.status === 404 && /There is no tab/.test(error.message));
  assert.doesNotMatch(await tools.run(["shared", "tabs"], a), /4462/);
  tools.closeAll();
});

test("the agents with a tab open in a browser, for the idle stop: a tab closed outside rooms-browser is forgotten", async () => {
  const chrome = fakeChrome();
  const record = { id: "shared", name: "shared", description: "", createdAt: "", updatedAt: "" };
  const tools = new BrowserTools({ browsers: chrome.manager as never, findBrowser: () => record, accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }), engine: chrome.engine as never, cdp: chrome.cdp });
  assert.deepEqual(await tools.agentsWithTabs("shared"), [], "nothing opened yet");
  const a = { as: "worker.aaaaaaaa", force: false };
  const tabA = /Opened tab (\d+)/.exec(await tools.run(["shared", "open", "http://127.0.0.1:4461/"], a))?.[1] as string;
  await tools.run(["shared", "open", "http://127.0.0.1:4462/"], { as: "reviewer.aaaaaaaa", force: false });
  assert.deepEqual((await tools.agentsWithTabs("shared")).sort(), ["reviewer.aaaaaaaa", "worker.aaaaaaaa"]);
  // The user closes the reviewer's window.
  chrome.tabs.delete([...chrome.tabs].find(([, t]) => t.url === "http://127.0.0.1:4462/")![0]);
  assert.deepEqual(await tools.agentsWithTabs("shared"), ["worker.aaaaaaaa"]);
  await tools.run(["shared", tabA, "close"], a);
  assert.deepEqual(await tools.agentsWithTabs("shared"), []);
  tools.closeAll();
});

test("an engine whose call timed out is closed; the agent's next call gets a fresh one and its tab is still its own", async () => {
  const chrome = fakeChrome();
  const record = { id: "shared", name: "shared", description: "", createdAt: "", updatedAt: "" };
  let stuck = true;
  // The first snapshot never answers, as a hung screenshot did: the engine gives up after its own timeout (here at once).
  const engine = () => {
    const inner = chrome.engine();
    return {
      get closed() {
        return inner.closed;
      },
      close: () => inner.close(),
      callTool: async (tool: string, args: Record<string, unknown>) => {
        if (tool === "take_snapshot" && stuck) {
          stuck = false;
          throw new BrowserToolError("the browser did not answer within 90s", 504);
        }
        return inner.callTool(tool, args);
      },
    };
  };
  const tools = new BrowserTools({ browsers: chrome.manager as never, findBrowser: () => record, accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }), engine: engine as never, cdp: chrome.cdp });
  const a = { as: "worker.aaaaaaaa", force: false };
  const tab = /Opened tab (\d+)/.exec(await tools.run(["shared", "open", "http://127.0.0.1:4461/"], a))?.[1] as string;
  await assert.rejects(tools.run(["shared", tab, "snapshot"], a), (error: BrowserToolError) => error.status === 504);
  assert.equal(chrome.engines[0]?.closed, true, "the stuck engine is closed");
  assert.match(await tools.run(["shared", tab, "snapshot"], a), /take_snapshot on http:\/\/127.0.0.1:4461\//);
  assert.equal(chrome.engines.length, 2, "a fresh engine took the call");
  tools.closeAll();
});

test("a tab that does not load is closed again and belongs to nobody", async () => {
  const chrome = fakeChrome();
  const record = { id: "shared", name: "shared", description: "", createdAt: "", updatedAt: "" };
  // An engine whose navigation fails as chrome-devtools-mcp's does: a line in the answer, not an error.
  const engine = () => {
    const inner = chrome.engine();
    return {
      get closed() {
        return inner.closed;
      },
      close: () => inner.close(),
      callTool: async (tool: string, args: Record<string, unknown>) =>
        tool === "navigate_page" ? { text: "Unable to navigate in the selected page: net::ERR_CONNECTION_REFUSED.", isError: false } : inner.callTool(tool, args),
    };
  };
  const tools = new BrowserTools({ browsers: chrome.manager as never, findBrowser: () => record, accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }), engine: engine as never, cdp: chrome.cdp });
  await assert.rejects(tools.run(["shared", "open", "http://127.0.0.1:1/"], { as: "worker.aaaaaaaa", force: false }), (error: BrowserToolError) => error.status === 422 && /ERR_CONNECTION_REFUSED/.test(error.message));
  assert.deepEqual([...chrome.tabs.keys()], ["TAB-USER"], "the new tab is closed");
  tools.closeAll();
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

/**
 * A headless Backroom for the tests that launch a real Chrome (ROOMS_TEST_CHROME=1). Its ports are recorded in a
 * folder of its own, which also records the user's browsers (the main checkout's data folder), so a test never takes a
 * port a stopped browser of the user's keeps (#598).
 */
const realBrowsers = (dataDir: string, options: Partial<Pick<RoomBrowserOptions, "systemdScope" | "idleMinutes" | "isBusy" | "pollMs">> = {}) =>
  new RoomBrowsers({ dataDir, mode: "headless", portsDir: join(dataDir, "browser-ports"), knownDataDirs: [mainCheckoutData(process.cwd())].filter((d): d is string => d !== null), ...options });

// Launches a real headless Chrome; opt in with ROOMS_TEST_CHROME=1.
test("a real headless Chrome: start, attach, see tabs, stop, restart on the same port", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = realBrowsers(dataDir);
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
  const browsers = realBrowsers(dataDir);
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
  const browsers = realBrowsers(dataDir, { systemdScope: true });
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
  const browsers = realBrowsers(dataDir);
  const record = { id: "tools", name: "tools", description: "", createdAt: "", updatedAt: "" };
  const tools = new BrowserTools({ browsers, findBrowser: (name) => (name === "tools" ? record : null), accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }) });
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

test("two agents at once in one real headless Chrome: a window each, focus rings in both, neither waits", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  const browsers = realBrowsers(dataDir);
  const record = { id: "pair", name: "pair", description: "", createdAt: "", updatedAt: "" };
  const tools = new BrowserTools({ browsers, findBrowser: (name) => (name === "pair" ? record : null), accessFor: () => ({ subject: "the room", kind: "room", enabled: true, allowed: [record] }) });
  const site = createServer((req, res) => res.end(`<title>${req.url}</title><style>button:focus-visible{outline:3px solid red}</style><button>one</button>`));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  t.after(async () => {
    tools.closeAll();
    await browsers.stopAll();
    site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const a = { as: "worker.aaaaaaaa", force: false };
  const b = { as: "reviewer.aaaaaaaa", force: false };
  const [openedA, openedB] = await Promise.all([tools.run(["pair", "open", `${base}/a`], a), tools.run(["pair", "open", `${base}/b`], b)]);
  const tabA = /Opened tab (\d+)/.exec(openedA)?.[1] as string;
  const tabB = /Opened tab (\d+)/.exec(openedB)?.[1] as string;
  assert.ok(tabA && tabB && tabA !== tabB, `${openedA}\n${openedB}`);

  // A window each.
  const cdpUrl = browsers.status("pair").cdpUrl as string;
  const pages = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{ id: string; url: string }>;
  const windowOf = async (path: string) => ((await cdpCall(cdpUrl, "Browser.getWindowForTarget", { targetId: pages.find((p) => p.url === `${base}${path}`)?.id })) as { windowId: number }).windowId;
  assert.notEqual(await windowOf("/a"), await windowOf("/b"), "the two tabs are in windows of their own");

  // a's call takes 3 s; b's goes through meanwhile.
  const started = Date.now();
  const slow = tools.run(["pair", tabA, "eval", "() => new Promise((done) => setTimeout(() => done('late'), 3000))"], a);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(await tools.run(["pair", tabB, "eval", "() => document.title"], b), /\/b/);
  const quick = Date.now() - started;
  assert.match(await slow, /late/);
  assert.ok(quick < 2500, `b answered after ${quick} ms, while a's call ran`);

  // Both pages hold the focus and draw its ring, and both can be photographed.
  for (const [tab, who] of [[tabA, a], [tabB, b]] as const) {
    await tools.run(["pair", tab, "press", "Tab"], who);
    assert.match(await tools.run(["pair", tab, "eval", "() => document.hasFocus() && document.activeElement.matches(':focus-visible') ? 'ring' : 'none'"], who), /ring/);
    assert.match(await tools.run(["pair", tab, "screenshot"], who), /Saved screenshot to .*\.png/);
  }
});

test("a real headless Chrome idle past its time is stopped only once nothing uses it; a busy check that fails counts as busy", { skip: process.env.ROOMS_TEST_CHROME !== "1" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rooms-browser-"));
  let answer: "busy" | "fails" | "idle" = "busy";
  const asked: string[] = [];
  // Idle after 60 ms, checked every 300 ms.
  const browsers = realBrowsers(dataDir, {
    idleMinutes: 0.001,
    pollMs: 300,
    isBusy: async (browserId) => {
      asked.push(browserId);
      if (answer === "fails") throw new Error("T3 did not answer");
      return answer === "busy";
    },
  });
  t.after(async () => {
    await browsers.stopAll();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await browsers.ensure("idle");
  browsers.start();
  const after = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await after(1000);
  assert.ok(asked.length >= 2, `the poll asked (${asked.length} times)`);
  assert.equal(browsers.status("idle").state, "running", "an agent's tab is in use");
  answer = "fails";
  await after(1000);
  assert.equal(browsers.status("idle").state, "running", "not stopped on a failed question");
  answer = "idle";
  const end = Date.now() + 8000;
  while (browsers.status("idle").state !== "stopped" && Date.now() < end) await after(100);
  assert.equal(browsers.status("idle").state, "stopped");
});
