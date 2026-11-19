/** Updates for T3 and its harnesses: shown with a count, and started only when the user asks for each one. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { missingScopeMessage } from "../src/adapter/auth.ts";
import { T3ScopeMissing, type T3Adapter } from "../src/adapter/types.ts";
import { releaseChannel } from "../src/app/t3Updates.ts";
import { compareVersions } from "../src/domain/versions.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

// Newer than the T3 the fake runs (0.0.46-nightly.20261003.2610).
const NEWEST = "0.0.46-nightly.20261005.2690";
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("versions order like semver, nightlies by date and run; the channel is the prerelease name", () => {
  assert.equal(compareVersions("0.0.43-nightly.20260928.2375", "0.0.43-nightly.20260926.2282"), 1);
  assert.equal(compareVersions("0.0.43-nightly.20260926.2282", "0.0.43-nightly.20260926.2282"), 0);
  assert.equal(compareVersions("0.0.43", "0.0.43-nightly.20260928.2375"), 1, "a release is above its prereleases");
  assert.equal(compareVersions("0.0.42", "0.0.43-nightly.1"), -1);
  assert.equal(compareVersions("2.1.283", "2.1.282"), 1);
  assert.equal(compareVersions("not a version", "1.0.0"), 0);
  assert.equal(releaseChannel("0.0.43-nightly.20260926.2282"), "nightly");
  assert.equal(releaseChannel("0.0.43-preview.20260925.2240"), "preview");
  assert.equal(releaseChannel("0.0.42"), "latest");
});

test("the count covers what can be updated from here, and looking never starts an update", async (t) => {
  const asked: string[] = [];
  const stack = await createTestStack(undefined, undefined, { latestRelease: async (channel) => (asked.push(channel), NEWEST) });
  t.after(() => stack.close());
  const view = await stack.updates.view();
  assert.deepEqual(asked, ["nightly"], "npm is asked on the running T3's channel");
  assert.equal(view.server.newer, true);
  assert.equal(view.server.canUpdate, true);
  assert.equal(view.server.latest, NEWEST);
  // T3 and Claude can be updated from here; Codex is behind but T3 cannot update it, so it is listed and not counted.
  assert.equal(view.available, 2);
  const codex = view.harnesses.find((h) => h.instanceId === "codex")!;
  assert.equal(codex.updatable, false);
  assert.match(codex.note ?? "", /cannot update this install/);
  await stack.updates.view();
  assert.equal(asked.length, 1, "the newest release is kept for an hour");
  assert.equal(stack.fake.serverUpdates.length, 0);
  assert.equal(stack.fake.versionState.harnesses.find((h) => h.instanceId === "claudeAgent")!.update, null);
});

test("a harness updates when asked, through T3; one T3 cannot update is refused", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-updates", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const started = await post("/api/t3/updates/harness", { instanceId: "claudeAgent" });
  assert.equal(started.status, 200);
  await settle();
  const after = (await (await app.request("/api/t3/updates?fresh=1")).json()) as { available: number; harnesses: Array<{ instanceId: string; version: string; status: string; update: { status: string } | null }> };
  const claude = after.harnesses.find((h) => h.instanceId === "claudeAgent")!;
  assert.deepEqual([claude.version, claude.status, claude.update?.status], ["2.1.283", "current", "succeeded"]);
  assert.equal(after.available, 2, "T3 itself is left, and Antigravity now that T3 has checked its release");

  assert.equal((await post("/api/t3/updates/harness", { instanceId: "codex" })).status, 409);
  assert.equal((await post("/api/t3/updates/harness", { instanceId: "claudeAgent" })).status, 409, "already current");
  assert.equal((await post("/api/t3/updates/harness", { instanceId: "nope" })).status, 404);
  assert.equal((await post("/api/t3/updates/harness", {})).status, 400);

  // T3 answers a failed update with the failure in its state.
  stack.fake.versionState.harnesses[0] = { ...stack.fake.versionState.harnesses[0]!, version: "2.1.283", latestVersion: "2.1.284", status: "behind_latest", updatable: true };
  stack.fake.updateFailure = "npm ERR! EACCES";
  await stack.updates.updateHarness("claudeAgent");
  await settle();
  const failed = (await stack.updates.view(true)).harnesses.find((h) => h.instanceId === "claudeAgent")!;
  assert.equal(failed.update?.status, "failed");
  assert.equal(failed.update?.message, "npm ERR! EACCES");
  assert.equal(failed.version, "2.1.283");
});

test("a harness T3 installs itself shows no Update before T3 has checked its release, then installs the newest through T3", async (t) => {
  const stack = await createTestStack({ updateMs: 40 }, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-updates", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const antigravity = async () => (await stack.updates.view(true)).harnesses.find((h) => h.instanceId === "antigravity")!;

  const unchecked = await stack.updates.view(true);
  const before = unchecked.harnesses.find((h) => h.instanceId === "antigravity")!;
  assert.deepEqual([before.version, before.latestVersion, before.status, before.updatable], ["1.3.0", null, "unknown", false], "T3 has not checked yet: no button");
  assert.equal(unchecked.available, 2, "T3 and Claude only");

  const checked = await stack.updates.view(true);
  const behind = checked.harnesses.find((h) => h.instanceId === "antigravity")!;
  assert.deepEqual([behind.version, behind.latestVersion, behind.status, behind.updatable], ["1.3.0", "1.5.12", "behind_latest", true]);
  assert.equal(checked.available, 3, "counted once T3 knows the newest");

  assert.equal((await app.request("/api/t3/updates/harness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: "antigravity" }) })).status, 200);
  const during = await stack.updates.view(true);
  const running = during.harnesses.find((h) => h.instanceId === "antigravity")!;
  assert.equal(running.update?.status, "running");
  assert.match(running.update?.message ?? "", /^Downloading Google's official Antigravity runtime\. 0\.0 of 80 MB$/);
  assert.equal(during.available, 2, "not counted while it runs");
  await assert.rejects(stack.updates.updateHarness("antigravity"), /already being updated/);
  let done = await antigravity();
  for (let waited = 0; done.update?.status === "running" && waited < 2000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await antigravity();
  }
  assert.deepEqual([done.version, done.status, done.updatable, done.update?.status, done.update?.message], ["1.5.12", "current", false, "succeeded", "Installed 1.5.12."]);
  assert.equal(stack.fake.versionState.harnesses.find((h) => h.instanceId === "claudeAgent")!.update, null, "no updater was run");
  await assert.rejects(stack.updates.updateHarness("antigravity"), /no update to install/);
});

test("a failed install shows T3's words, and a harness T3 reports no version for says so and offers nothing", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  await stack.updates.view(true);
  stack.fake.updateFailure = "The Antigravity download failed its size or checksum check. Nothing was installed.";
  await stack.updates.updateHarness("antigravity");
  await settle();
  const view = await stack.updates.view(true);
  const failed = view.harnesses.find((h) => h.instanceId === "antigravity")!;
  assert.deepEqual([failed.update?.status, failed.update?.message], ["failed", "The Antigravity download failed its size or checksum check. Nothing was installed."]);
  assert.deepEqual([failed.version, failed.updatable], ["1.3.0", true], "the previous runtime stays, and the install can be tried again");
  const cursor = view.harnesses.find((h) => h.instanceId === "cursor")!;
  assert.deepEqual([cursor.version, cursor.latestVersion, cursor.status, cursor.updatable, cursor.note], [null, null, "unknown", false, "T3 reports no version for it."]);
});

test("two Update requests for one harness that overlap start it once; a refused one leaves no claim", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  // T3 as it is while a start has not shown yet: each read still says Claude is behind and idle.
  const starts: string[] = [];
  let started: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  stack.fake.updateHarness = async (input) => {
    starts.push(input.instanceId);
    // Once this start has returned and its request has let its claim go.
    setTimeout(started, 5);
  };
  const read = stack.fake.versions.bind(stack.fake);
  let reads = 0;
  stack.fake.versions = async () => {
    // Every read after the first request's own waits until that request's start has returned.
    const held = (reads += 1) > 1;
    const snapshot = await read();
    if (held) await firstStarted;
    return snapshot;
  };
  const first = stack.updates.updateHarness("claudeAgent");
  const second = stack.updates.updateHarness("claudeAgent").then(() => "started", (caught: Error) => caught.message);
  await first;
  assert.match(await second, /already being updated/);
  assert.deepEqual(starts, ["claudeAgent"]);

  await assert.rejects(stack.updates.updateHarness("codex"), /cannot update this install/);
  const codex = (await stack.updates.view(true)).harnesses.find((h) => h.instanceId === "codex")!;
  assert.deepEqual([codex.pending, codex.error], [false, null], "a refusal releases its claim");
});

test("an install offer older than the installed version is no update: up to date, no button, not counted", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  const install = stack.fake.installs.get("antigravity")!;
  install.state = { ...install.state, installedVersion: "1.6.0" };
  install.release = "1.5.12";
  await stack.updates.view(true);
  const view = await stack.updates.view(true);
  const antigravity = view.harnesses.find((h) => h.instanceId === "antigravity")!;
  assert.deepEqual([antigravity.version, antigravity.latestVersion, antigravity.status, antigravity.updatable], ["1.6.0", "1.5.12", "current", false]);
  assert.equal(view.available, 2, "T3 and Claude only");
  await assert.rejects(stack.updates.updateHarness("antigravity"), /no update to install/);
});

test("T3 updates to the newest release shown, keeps running turns going, and is done when it answers on it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null, updateMs: 30 }, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  await assert.rejects(stack.updates.updateServer("0.0.46-nightly.20261004.2650"), /newest T3 is now/);
  const started = await stack.updates.updateServer(NEWEST);
  assert.equal(started.server.job?.state, "installing");
  await assert.rejects(stack.updates.updateServer(NEWEST), /already being updated/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(stack.fake.serverUpdates, [{ targetVersion: NEWEST, continueRunningThreads: true }]);
  const done = await stack.updates.view(true);
  assert.equal(done.server.version, NEWEST);
  assert.equal(done.server.job?.state, "done");
  assert.equal(done.server.newer, false);
  await assert.rejects(stack.updates.updateServer(NEWEST), /already runs/);
});

test("a refused T3 update is shown as failed; npm being unreachable only hides T3's own update", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  stack.fake.updateFailure = "could not download t3";
  await stack.updates.updateServer(NEWEST);
  await settle();
  const failed = await stack.updates.view();
  assert.equal(failed.server.job?.state, "failed");
  assert.match(failed.server.job?.error ?? "", /could not download t3/);

  const offline = await createTestStack(undefined, undefined, {
    latestRelease: async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
  });
  t.after(() => offline.close());
  const view = await offline.updates.view();
  assert.equal(view.server.newer, false);
  assert.match(view.server.releaseError ?? "", /ENOTFOUND/);
  assert.equal(view.available, 1, "Claude's update is still offered");
});

test("an update or read T3 refuses for a permission Backroom's pairing lacks shows the sentence that says how to pair again", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  const adapter: T3Adapter = stack.fake;
  adapter.updateServer = async () => {
    throw new T3ScopeMissing("environment:maintain", null);
  };
  adapter.updateHarness = async () => {
    throw new T3ScopeMissing("providers:manage", null);
  };
  adapter.browseFolders = async () => {
    throw new T3ScopeMissing("filesystem:read", null);
  };
  adapter.usageSummary = async () => {
    throw new T3ScopeMissing("diagnostics:read", null);
  };
  await stack.updates.updateServer(NEWEST);
  await stack.updates.updateHarness("claudeAgent");
  await settle();
  const view = await stack.updates.view();
  assert.equal(view.server.job?.state, "failed");
  assert.equal(view.server.job?.error, missingScopeMessage("environment:maintain"));
  assert.equal(view.harnesses.find((h) => h.instanceId === "claudeAgent")?.error, missingScopeMessage("providers:manage"));

  // Nothing here is written to the data folder.
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/nonexistent/rooms-test-scope", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const folders = (await (await app.request("/api/t3/folders?path=%2Fhome%2F")).json()) as { unreadable: string | null };
  assert.equal(folders.unreadable, missingScopeMessage("filesystem:read"));
  const usage = await app.request("/api/t3/usage/today?tz=UTC");
  assert.equal(usage.status, 403);
  assert.deepEqual(await usage.json(), { error: "t3_scope_missing", message: missingScopeMessage("diagnostics:read") });
});
