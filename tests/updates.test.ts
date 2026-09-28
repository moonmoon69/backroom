/** Updates for T3 and its harnesses: shown with a count, and started only when the user asks for each one. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, releaseChannel } from "../src/app/t3Updates.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const NEWEST = "0.0.43-nightly.20260928.2375";
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
  assert.equal(after.available, 1, "only T3 itself is left");

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

test("T3 updates to the newest release shown, keeps running turns going, and is done when it answers on it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null, updateMs: 30 }, undefined, { latestRelease: async () => NEWEST });
  t.after(() => stack.close());
  await assert.rejects(stack.updates.updateServer("0.0.43-nightly.20260927.2331"), /newest T3 is now/);
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
