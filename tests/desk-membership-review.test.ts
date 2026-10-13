import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The hook's event wiring needs no DOM. Run it with mocked React effects in a
// child because Node's module mocks require an experimental flag, while the
// normal test command intentionally does not enable that flag for other tests.
test("Astra: an open room learns newly seated threads before the desk fallback", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-test-module-mocks",
    "--test",
    fileURLToPath(new URL("./fixtures/desk-membership-review.mjs", import.meta.url)),
  ], { encoding: "utf8", timeout: 10_000, env });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
