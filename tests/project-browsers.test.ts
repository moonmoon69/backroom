/** A project's setting for the browsers of its new rooms: kept, cleared, copied into new rooms, and what deleted browsers leave. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/db/database.ts";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
import type { RoomError } from "../src/domain/errors.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

const RUNNING = { cdpUrl: "http://127.0.0.1:9301", cdpPort: 9301, mode: "vnc" as const, watchUrl: "http://box.ts.net:6101/vnc.html?autoconnect=1" };

/** Stands in for the process manager: every browser asked for starts. */
const fakeBrowsers = () => ({
  async briefingFor(browser: { id: string; name: string; description: string }) {
    return { ...RUNNING, name: browser.name, description: browser.description };
  },
  status: () => ({ state: "stopped" }),
  detach() {},
});

const newRoom = async (stack: TestStack, title = "next") => {
  const { roomId } = (await stack.run({ type: "room.create", projectId: "project_demo", title, consigliere: false })) as { roomId: string };
  return stack.repos.getRoom(roomId)!;
};

const browserOf = (stack: TestStack, name: string, description = "") =>
  stack.run({ type: "browser.create", name, description }).then((r) => (r as { browserId: string }).browserId);

test("the migration adds the table to a database at the schema before it, and leaves the rest as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "rooms-project-browsers-"));
  try {
    const path = join(dir, "rooms.db");
    const first = new Database(path);
    const count = (first.raw.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    first.raw.prepare("INSERT INTO kv (key, value) VALUES ('kept', 'yes')").run();
    // The schema before this migration: its table not there and its number not applied.
    first.raw.exec(`DROP TABLE project_browsers; DELETE FROM migrations WHERE id = ${count};`);
    first.close();

    const second = new Database(path);
    const columns = (second.raw.prepare("PRAGMA table_info(project_browsers)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(columns, ["project_id", "browser_enabled", "default_browser_id", "browser_ids_json", "updated_at"]);
    assert.equal((second.raw.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n, count);
    assert.equal((second.raw.prepare("SELECT value FROM kv WHERE key = 'kept'").get() as { value: string }).value, "yes");
    // The table there but its number not applied (a database migrated by a branch that numbered it otherwise): no error.
    second.raw.exec(`DELETE FROM migrations WHERE id = ${count};`);
    second.close();
    const third = new Database(path);
    assert.equal((third.raw.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n, count);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project's setting is kept, read on the project, and cleared; with a room's rules", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-project-browsers", ROOMS_PORT: "0" }), "/nonexistent/dist", { tools: null, token: "t", command: "rooms-browser" });
  const read = async () => ((await (await app.request("/api/t3/projects")).json()) as Array<{ id: string; browsers: unknown }>).find((p) => p.id === "project_demo")!.browsers;
  const testing = await browserOf(stack, "testing");

  assert.equal(stack.repos.getProjectBrowsers("project_demo"), null);
  assert.equal(await read(), null, "no setting: null on the project");

  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: testing, allowed: [testing, "general"] });
  assert.deepEqual(await read(), { enabled: true, defaultBrowserId: testing, allowedBrowserIds: [testing, "general"] });
  // Omitted keeps the current choice; null widens the list to every browser, and falls the default back to general.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: false });
  assert.deepEqual(await read(), { enabled: false, defaultBrowserId: testing, allowedBrowserIds: [testing, "general"] });
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: null, allowed: null });
  assert.deepEqual(await read(), { enabled: true, defaultBrowserId: "general", allowedBrowserIds: null });
  const kept = stack.repos.getProjectBrowsers("project_demo")!;
  assert.deepEqual([kept.browserEnabled, kept.defaultBrowserId, kept.allowedBrowserIds], [true, null, null], "every browser is stored as null, as a room's list is");

  // A room's rules: the default must be allowed, a browser must exist, the project must be T3's.
  await assert.rejects(stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: "general", allowed: [testing] }), (error: RoomError) => error.code === "default_not_allowed");
  await assert.rejects(stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: "nope" }), (error: RoomError) => error.code === "not_found");
  await assert.rejects(stack.run({ type: "project.browser", projectId: "project_gone", enabled: true }), (error: RoomError) => error.code === "unknown_project");
  assert.equal(stack.repos.getProjectBrowsers("project_gone"), null);

  // Cleared: no setting again.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: null });
  assert.equal(stack.repos.getProjectBrowsers("project_demo"), null);
  assert.equal(await read(), null);
});

test("a new room starts with its project's setting, and without one with browsers off as before; it is a copy", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const testing = await browserOf(stack, "testing");

  const before = await newRoom(stack, "before");
  assert.deepEqual([before.browserEnabled, before.defaultBrowserId, before.allowedBrowserIds], [false, null, null], "no setting: off, no default, every browser");

  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: testing, allowed: [testing] });
  const after = await newRoom(stack, "after");
  assert.deepEqual([after.browserEnabled, after.defaultBrowserId, after.allowedBrowserIds], [true, testing, [testing]]);
  assert.deepEqual(stack.repos.getRoom(before.id)!.browserEnabled, false, "a room made before keeps its own");

  // The project's setting changed later leaves the room; the room's own panel leaves the project.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: false, allowed: null });
  assert.equal(stack.repos.getRoom(after.id)!.browserEnabled, true);
  await stack.run({ type: "room.browser", roomId: after.id, enabled: true, allowed: null, browserId: "general" });
  const record = stack.repos.getProjectBrowsers("project_demo")!;
  assert.deepEqual([record.browserEnabled, record.defaultBrowserId, record.allowedBrowserIds], [false, testing, null]);

  // Cleared: today's default again.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: null });
  const cleared = await newRoom(stack, "cleared");
  assert.deepEqual([cleared.browserEnabled, cleared.defaultBrowserId, cleared.allowedBrowserIds], [false, null, null]);
  // Threads outside rooms stay off.
  assert.equal(stack.repos.getThreadBrowsers("1a2b3c4d-0000-4000-8000-000000000000"), null);
});

test("the Consigliere's conversation start makes its room with the project's setting, and his first briefing names its default", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, [], { browsers: () => fakeBrowsers() as never });
  t.after(() => stack.close());
  const testing = await browserOf(stack, "testing", "Staging logins");
  const presetId = ((await stack.run({ type: "preset.create", name: "alice", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } })) as { presetId: string }).presetId;
  await stack.run({ type: "consigliere.preset.set", presetId });

  const plain = (await stack.run({ type: "consigliere.start", projectId: "project_demo", text: "Plan the release", requestId: "7b0c1f0e-7f0a-4a55-9d4b-3a3f0e1c2d11" })) as { roomId: string };
  assert.equal(stack.repos.getRoom(plain.roomId)!.browserEnabled, false, "no setting: off, as today");

  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: testing, allowed: [testing, "general"] });
  const started = (await stack.run({ type: "consigliere.start", projectId: "project_demo", text: "Check the login page", requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" })) as { roomId: string; participantId: string };
  const room = stack.repos.getRoom(started.roomId)!;
  assert.deepEqual([room.browserEnabled, room.defaultBrowserId, room.allowedBrowserIds], [true, testing, [testing, "general"]]);
  await stack.tick(2);
  const thread = stack.fake.threads.get(stack.repos.currentBinding(started.participantId)!.threadId)!;
  const briefing = thread.messages.find((m) => m.id === thread.runs[0]!.userMessageId)!.text;
  assert.match(briefing, /== Browsers ==/);
  assert.match(briefing, /- testing \(this room's default\): Staging logins/);
});

test("a browser the project's setting names that is deleted falls back as a room's does", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const testing = await browserOf(stack, "testing");
  const staging = await browserOf(stack, "staging");

  // Its default deleted: general (null) by default, the list without it.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: testing, allowed: [testing, "general"] });
  await stack.run({ type: "browser.delete", browserId: testing });
  const record = stack.repos.getProjectBrowsers("project_demo")!;
  assert.deepEqual([record.browserEnabled, record.defaultBrowserId, record.allowedBrowserIds], [true, null, ["general"]]);
  const room = await newRoom(stack, "after default deleted");
  assert.deepEqual([room.browserEnabled, room.defaultBrowserId, room.allowedBrowserIds], [true, null, ["general"]]);

  // Its only allowed browser deleted: off, never on with every browser or none.
  await stack.run({ type: "project.browser", projectId: "project_demo", enabled: true, browserId: staging, allowed: [staging] });
  await stack.run({ type: "browser.delete", browserId: staging });
  const emptied = stack.repos.getProjectBrowsers("project_demo")!;
  assert.deepEqual([emptied.browserEnabled, emptied.defaultBrowserId, emptied.allowedBrowserIds], [false, null, null]);
  const off = await newRoom(stack, "after the list emptied");
  assert.deepEqual([off.browserEnabled, off.defaultBrowserId, off.allowedBrowserIds], [false, null, null]);
});

test("a new room drops browsers the project's setting names that no longer exist, as the deletion would have", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  // A record naming browsers that are gone, written past the command (whose checks would refuse them).
  stack.repos.setProjectBrowsers({ projectId: "project_demo", browserEnabled: true, defaultBrowserId: "gone", allowedBrowserIds: ["gone", "general"], updatedAt: new Date().toISOString() });
  const some = await newRoom(stack, "some left");
  assert.deepEqual([some.browserEnabled, some.defaultBrowserId, some.allowedBrowserIds], [true, null, ["general"]]);

  stack.repos.setProjectBrowsers({ projectId: "project_demo", browserEnabled: true, defaultBrowserId: "gone", allowedBrowserIds: ["gone", "also-gone"], updatedAt: new Date().toISOString() });
  const none = await newRoom(stack, "none left");
  assert.deepEqual([none.browserEnabled, none.defaultBrowserId, none.allowedBrowserIds], [false, null, null], "none left: off, never on with every browser or none");
});
