/**
 * The room header's Browser button (web/src/browserSummary.ts): its count and its words speak for every browser the
 * room may use, not only the default (B3).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { roomBrowserSummary, roomTabsLine } from "../web/src/browserSummary.ts";

const tab = (n: number) => ({ id: `t${n}`, title: `tab ${n}`, url: `https://example.com/${n}` });
const running = (...tabs: number[]) => ({ state: "running" as const, mode: "vnc" as const, tabs: tabs.map(tab) });
const off = { state: "stopped" as const, mode: "vnc" as const, tabs: [] };

test("the count adds up the tabs of every running browser the room may use, and the title names each one", () => {
  const summary = roomBrowserSummary(
    true,
    [
      { browser: { id: "general", name: "general" }, status: running(1, 2, 3) },
      { browser: { id: "b2", name: "staging" }, status: running(4, 5) },
      { browser: { id: "b3", name: "scratch" }, status: off },
    ],
    "general",
  );
  assert.equal(summary.tabs, 5);
  assert.equal(summary.failed, false);
  assert.equal(summary.title, "Browser: on for this room's agents · general (default) running, 3 tabs; staging running, 2 tabs; scratch off");
});

test("a default that is off does not hide tabs open in another browser the room may use", () => {
  const summary = roomBrowserSummary(true, [{ browser: { id: "general", name: "general" }, status: off }, { browser: { id: "b2", name: "staging" }, status: running(1) }], "general");
  assert.equal(summary.tabs, 1);
  assert.equal(summary.title, "Browser: on for this room's agents · general (default) off; staging running, 1 tab");
});

test("a browser that failed to start marks the button failed; one that cannot run here says so", () => {
  const failed = roomBrowserSummary(false, [{ browser: { id: "general", name: "general" }, status: off }, { browser: { id: "b2", name: "staging" }, status: { state: "error", mode: "vnc", tabs: [] } }], "general");
  assert.equal(failed.failed, true);
  assert.equal(failed.title, "Browser: off for this room's agents · general (default) off; staging failed");
  const unavailable = roomBrowserSummary(true, [{ browser: { id: "general", name: "general" }, status: { state: "stopped", mode: null, tabs: [] } }], "general");
  assert.equal(unavailable.title, "Browser: on for this room's agents · general (default) unavailable");
});

test("a room with no browser says so, and counts nothing", () => {
  assert.deepEqual(roomBrowserSummary(true, [], null), { title: "Browser: on for this room's agents · no browser yet", tabs: 0, failed: false });
});

test("the panel's line says the button's number is open tabs, and is not there when none is open (#526, #533)", () => {
  assert.equal(roomTabsLine(5), "5 tabs open in all across the browsers below: the number on the Browser button.");
  assert.equal(roomTabsLine(1), "1 tab open in all across the browsers below: the number on the Browser button.");
  assert.equal(roomTabsLine(0), null);
});
