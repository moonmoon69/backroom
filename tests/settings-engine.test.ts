/**
 * Settings → the Consigliere's rules show the wording in force: on the engine its own default (the board's mechanics
 * are added after it whatever the wording), on the old runtime the old one; the user's saved wording either way.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { CONSIGLIERE_RULES_KEY, DEFAULT_CONSIGLIERE_RULES, ENGINE_DEFAULT_CONSIGLIERE_RULES } from "../src/app/consigliere.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";

type Rules = { text: string; custom: boolean; defaultText: string };

function settingsApp(t: TestContext, engine: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-settings-"));
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null, engine });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const rules = async () => ((await (await app.request("/api/settings")).json()) as { consigliereRules: Rules }).consigliereRules;
  return { stack, rules };
}

test("Settings show the engine's default rules on the engine, the old ones without it, and the user's own either way", async (t) => {
  const on = settingsApp(t, true);
  assert.deepEqual(await on.rules(), { text: ENGINE_DEFAULT_CONSIGLIERE_RULES, custom: false, defaultText: ENGINE_DEFAULT_CONSIGLIERE_RULES });
  on.stack.repos.setKv(CONSIGLIERE_RULES_KEY, "- Keep reports short.");
  assert.deepEqual(await on.rules(), { text: "- Keep reports short.", custom: true, defaultText: ENGINE_DEFAULT_CONSIGLIERE_RULES });

  const off = settingsApp(t, false);
  assert.deepEqual(await off.rules(), { text: DEFAULT_CONSIGLIERE_RULES, custom: false, defaultText: DEFAULT_CONSIGLIERE_RULES });
  assert.notEqual(ENGINE_DEFAULT_CONSIGLIERE_RULES, DEFAULT_CONSIGLIERE_RULES);
});
