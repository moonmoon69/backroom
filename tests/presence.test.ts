/** Backroom in place of T3's window: T3's client lease while a page is open, and the checks T3's window would ask for. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import type { T3ProviderInfo } from "../src/adapter/types.ts";
import { T3Presence } from "../src/app/t3Presence.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const MINUTE = 60_000;

function setup() {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  let now = Date.parse("2026-09-29T12:00:00.000Z");
  const presence = new T3Presence(fake, { now: () => now });
  return { fake, presence, advance: (ms: number) => (now += ms), at: () => now };
}

const inView = { visible: true, focused: true, interactedAt: null };

test("an open page holds T3's lease, and the first arrival asks T3 for a full check", async (t) => {
  const { fake, presence, advance } = setup();
  t.after(() => presence.stop());
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.deepEqual(fake.activityReports, [{ visible: true, focused: true, recentlyInteracted: false, ttlMs: 45_000 }]);
  assert.deepEqual(fake.providerRefreshes, [{}], "every provider is checked when someone arrives");

  // Away and back within five minutes: T3's own checks run under the lease, so nothing more is asked for.
  await presence.page({ pageId: "a", visible: false, focused: false, interactedAt: null });
  advance(2 * MINUTE);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 1);

  // Back after longer: checked again.
  await presence.page({ pageId: "a", visible: false, focused: false, interactedAt: null });
  advance(6 * MINUTE);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 2);
});

test("a hidden page keeps the connection but asks for nothing; a closed one ends the lease", async (t) => {
  const { fake, presence, advance } = setup();
  t.after(() => presence.stop());
  await presence.page({ pageId: "a", visible: false, focused: false, interactedAt: null });
  await presence.idle();
  assert.deepEqual(fake.activityReports, [{ visible: false, focused: false, recentlyInteracted: false, ttlMs: 45_000 }]);
  assert.deepEqual(fake.providerRefreshes, []);

  // Used a moment ago counts as in view even without focus, as in T3.
  await presence.page({ pageId: "b", visible: true, focused: false, interactedAt: Date.parse("2026-09-29T12:00:00.000Z") });
  await presence.idle();
  assert.deepEqual(fake.activityReports.at(-1), { visible: true, focused: false, recentlyInteracted: true, ttlMs: 45_000 });
  assert.equal(fake.providerRefreshes.length, 1);

  await presence.page({ pageId: "b", ...inView, closed: true });
  advance(3 * MINUTE);
  await presence.page({ pageId: "c", ...inView, closed: true });
  assert.equal(fake.activityReports.at(-1), null, "page a went quiet and b closed: the lease ends");
});

const reading = (instanceId: string, windows: Array<{ resetsAt: string }>, checkedAt: string): T3ProviderInfo => ({
  instanceId, displayName: instanceId, enabled: true, installed: true, status: "ready", version: null, authStatus: null, authLabel: null, message: null,
  usageWindows: windows.map((w, i) => ({ id: `w${i}`, label: `Window ${i}`, usedPercent: 98, resetsAt: w.resetsAt })), usageCheckedAt: checkedAt, reportsContextWindow: true, autoCompactWindow: null,
});
const iso = (ms: number) => new Date(ms).toISOString();

test("a usage window that reset after T3's last reading is checked at once, and not again straight away", async (t) => {
  const { fake, presence, advance, at } = setup();
  t.after(() => presence.stop());
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 1);

  // Read 30s ago, but the session window reset 10s ago: the share shown is from before the reset.
  let providers = [reading("claudeAgent", [{ resetsAt: iso(at() + 15_000) }], iso(at() - 5_000))];
  fake.listProviders = async () => providers;
  advance(25_000);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.deepEqual(fake.providerRefreshes.at(-1), { instanceId: "claudeAgent" });
  assert.equal(fake.providerRefreshes.length, 2);

  advance(25_000);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 2, "not asked again within the minute");

  // T3 read it after the reset, a moment ago: nothing to do.
  advance(40_000);
  providers = [reading("claudeAgent", [{ resetsAt: iso(at() - 50_000) }], iso(at() - 10_000))];
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 2);
});

test("while someone looks, a reading older than a minute is checked again; a check that reads nothing is left alone", async (t) => {
  const { fake, presence, advance, at } = setup();
  t.after(() => presence.stop());
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.equal(fake.providerRefreshes.length, 1, "the full check on arrival");

  const weekly = [{ resetsAt: "2026-10-05T00:00:00.000Z" }];
  let claudeReadAt = at();
  const cursorReadAt = iso(at() - 2 * 86_400_000);
  // No bars, nothing to check; Cursor's check never brings a reading (its time stays put).
  const providers = () => [
    reading("claudeAgent", weekly, iso(claudeReadAt)),
    reading("cursor", weekly, cursorReadAt),
    { ...reading("opencode", [], iso(at() - 86_400_000)), usageWindows: [] },
  ];
  fake.listProviders = async () => providers();
  const asked = () => fake.providerRefreshes.slice(1).map((r) => r.instanceId);

  advance(25_000);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.deepEqual(asked(), ["cursor"], "Claude's reading is 25s old; Cursor's is two days old");

  advance(40_000);
  await presence.page({ pageId: "a", ...inView });
  await presence.idle();
  assert.deepEqual(asked(), ["cursor", "claudeAgent"], "Claude's reading passed a minute; Cursor's last check read nothing");
  claudeReadAt = at();

  advance(31 * MINUTE);
  await presence.page({ pageId: "a", visible: true, focused: true, interactedAt: at() });
  await presence.idle();
  assert.deepEqual(asked().slice(2).sort(), ["claudeAgent", "cursor"], "after half an hour Cursor is tried again");
});

test("the routes take a page's report and an explicit refresh, models included", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-presence", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await post("/api/t3/presence", { visible: true })).status, 400);
  assert.equal((await post("/api/t3/presence", { pageId: "p1", visible: true, focused: true, interactedAt: null })).status, 200);
  await stack.presence.idle();
  assert.equal(stack.fake.activityReports.at(-1)?.visible, true);

  const refreshed = await post("/api/t3/providers/refresh", { models: true });
  assert.equal(refreshed.status, 200);
  assert.ok(Array.isArray(await refreshed.json()));
  assert.deepEqual(stack.fake.providerRefreshes.at(-1), { refreshModels: true });
  await post("/api/t3/providers/refresh", { instanceId: "codex" });
  assert.deepEqual(stack.fake.providerRefreshes.at(-1), { instanceId: "codex" });
});
