import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { T3Unavailable } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";

test("review B round 2: an outage already pushed is returned by status without waiting for another hung shell read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-push-hang-review-"));
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, changes: { shellMs: 60_000 } });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dir, T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  t.after(() => { stack.close(); rmSync(dir, { recursive: true, force: true }); });

  const outage = new T3Unavailable("T3 did not answer within 30s (orchestration shell)");
  fake.shellOutage = outage;
  const pushed: boolean[] = [];
  const stop = stack.changes.subscribe((event) => { if (event.type === "status") pushed.push(event.status.up); });
  t.after(stop);
  await stack.changes.check();
  assert.deepEqual(pushed, [false], "the page was told T3 is down");
  assert.equal(stack.changes.status()!.up, false, "the checker already established and published downtime");
  assert.ok(await fake.describe(), "T3's descriptor keeps answering during the half-finished restart");

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  fake.listProjects = async () => { await held; throw outage; };
  fake.listThreads = async () => { await held; throw outage; };
  // The next scheduled shell check is hung. The pushed status is already known, and must reach the chip now.
  const checking = stack.changes.check();
  const response = app.request("/api/status");
  let prompt: boolean;
  try {
    prompt = await Promise.race([Promise.resolve(response).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
  } finally {
    release();
    await checking;
  }
  const status = await (await response).json() as { t3: { error: string | null } };
  assert.equal(status.t3.error, outage.message);
  assert.equal(prompt, true, "a published outage must reach the chip without waiting for another shell timeout");
});
