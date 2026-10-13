/**
 * Read-only review regression: an HTTP fallback read must not dismiss a pushed feed outage.
 * Run after build:web, against live T3, using an EMPTY throwaway service and an owned browser tab:
 * node scripts/review-shell-feed-page.ts --as <key> --credentials <live-data-dir> --browser general --port 4534 --out /tmp/feed-page-review
 * Only the credential is read from the live data directory. No rooms or T3 commands are created.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { readStoredAuth } from "../src/adapter/auth.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback = "") => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const key = option("--as");
const credentials = option("--credentials");
assert.ok(key && credentials, "--as and --credentials are required");
const stored = readStoredAuth(credentials);
assert.ok(stored?.accessToken, "stored credential is present");
const browser = option("--browser", "general");
const port = Number(option("--port", "4534"));
const out = resolve(option("--out", "/tmp/feed-page-review"));
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "backroom-feed-page-review-"));
const baseUrl = process.env.T3_BASE_URL ?? stored.baseUrl ?? "http://127.0.0.1:3773";
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets: ReadOnlySocket[] = [];
let blocked = false;
let shellGets = 0;
class ReadOnlySocket extends WebSocket {
  feed = false;
  constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
  override send(data: Parameters<WebSocket["send"]>[0]): void {
    const frame = JSON.parse(String(data)) as { _tag: string; tag?: string };
    if (frame._tag === "Request") {
      assert.ok(!/dispatchCommand|launchThread|mutate|interruptRun/.test(frame.tag ?? ""), `unexpected mutating RPC ${frame.tag}`);
      if (frame.tag === "orchestration.subscribeShell" || frame.tag === "orchestration.subscribeArchivedShell") {
        this.feed = true;
        if (blocked) { queueMicrotask(() => this.close()); return; }
      }
    }
    super.send(data);
  }
}
const adapter = new HttpT3Adapter({
  baseUrl, accessToken: stored.accessToken, webSocketImpl: ReadOnlySocket, feed: { retryMs: 60_000 },
  fetchImpl: (input, init) => {
    if (new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname === "/api/orchestration/shell") shellGets++;
    return fetch(input, init);
  },
});
const config = loadConfig({ ROOMS_ADAPTER: "http", ROOMS_DATA_DIR: data, ROOMS_PORT: String(port), T3_BASE_URL: baseUrl, ROOMS_BROWSER_MODE: "off", ROOMS_SPEECH: "off" });
const stack = createStack({ dbPath: join(data, "rooms.sqlite"), adapter, briefingBudgetChars: 60_000, keepAliveMs: 0, latestRelease: async () => null });
const app = createHttpApp(stack, config, resolve("web/dist"));
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
const command = async (...parts: string[]) => (await run(resolve("bin/rooms-browser"), [browser, ...parts, "--as", key], { env: { ...process.env, ROOMS_BROWSER_API: join(resolve(credentials), "browser-api.json") }, timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout;
let tab: string | null = null;
/** The banner is found by its mark (data-t3-banner: "down" when T3's lists cannot be read, "feed" when they are read the slow way). */
interface View { banner: string | null; bannerText: string | null; chip: string | null; error: string | null; feed: string; hidden: boolean }
const inspect = async (on = tab!): Promise<View> => {
  const output = await command(on, "eval", `async () => {
    const status = await (await fetch('/api/status')).json();
    const banner = document.querySelector('[data-t3-banner]');
    return { banner: banner?.dataset.t3Banner ?? null, bannerText: banner?.textContent ?? null,
      chip: document.querySelector('.connection-chip')?.textContent ?? null, error: status.t3.error,
      feed: status.t3.feed.state, hidden: document.hidden };
  }`);
  return JSON.parse(/\x60\x60\x60json\s*([\s\S]*?)\s*\x60\x60\x60/.exec(output)![1]!) as View;
};
try {
  adapter.startFeed();
  const deadline = Date.now() + 10_000;
  while (adapter.feed().state !== "connected" && Date.now() < deadline) await sleep(25);
  assert.equal(adapter.feed().state, "connected");
  assert.deepEqual(stack.repos.listRooms(), []);
  const opened = await command("open", `http://feed-page-review-${port}.localhost:${port}`);
  tab = /Opened tab (\S+)/.exec(opened)?.[1] ?? null;
  assert.ok(tab, opened);
  await sleep(1500);
  const before = await inspect();
  assert.deepEqual([before.feed, before.error, before.banner], ["connected", null, null]);
  blocked = true;
  for (const socket of sockets) if (socket.feed) socket.close();
  await sleep(150);
  const dropped = await inspect();
  console.log("Just after the feed drops:", dropped);
  assert.equal(dropped.feed, "down");
  assert.ok(dropped.banner, "the pushed outage is visible before the refresh");
  await command(tab, "screenshot", "--out", join(out, "feed-down-before-http-fallback.png"));
  const getsBefore = shellGets;
  // The same browser event PageStream handles when the user returns to this tab.
  await command(tab, "eval", "() => { document.dispatchEvent(new Event('visibilitychange')); return document.hidden; }");
  await sleep(1500);
  const after = await inspect();
  console.log("After returning to the page:", after, "fallback shell GETs:", shellGets - getsBefore);
  await command(tab, "screenshot", "--out", join(out, "feed-down-after-http-fallback.png"));
  assert.equal(after.hidden, false, "this tab is visible");
  assert.equal(after.feed, "down");
  assert.ok(after.error, "the server still reports the feed outage");
  assert.match(after.chip ?? "", /error/);
  assert.ok(shellGets > getsBefore, "the page successfully read the HTTP fallback");
  // A page loaded while the feed is down: told the feed is down and T3's lists read the slow way, with no return to it.
  const fresh = /Opened tab (\S+)/.exec(await command("open", `http://feed-page-review-${port}.localhost:${port}`))?.[1] ?? null;
  assert.ok(fresh, "a second tab");
  let loaded: View;
  try {
    await sleep(2500);
    loaded = await inspect(fresh);
    console.log("A page loaded while the feed is down:", loaded);
    await command(fresh, "screenshot", "--out", join(out, "feed-down-fresh-page.png"));
  } finally {
    await command(fresh, "close").catch(() => undefined);
  }
  assert.equal(loaded.banner, "feed", "a page loaded during the outage says the live feed is down once its slow read succeeded");
  assert.equal(after.banner, "feed", "HTTP fallback success must not clear the feed outage banner before a pushed recovery; it says the live feed is down");
  assert.ok(after.bannerText?.includes("live feed is down") && after.bannerText.includes(after.error!), `the banner names the feed's error and that the lists may lag: ${after.bannerText}`);
  assert.match(after.bannerText ?? "", /may lag/);
  console.log("PASS: the feed outage remains visible after a successful HTTP fallback, worded for lists read the slow way");
} finally {
  if (tab) await command(tab, "close").catch(() => undefined);
  stack.close();
  adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(data, { recursive: true, force: true });
}
