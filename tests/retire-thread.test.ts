/** The retire setting: what happens to a member's T3 thread when the Consigliere retires it or a reseat retires the old seat. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { RETIRE_THREAD_KEY } from "../src/app/consigliere.ts";
import { createTestStack } from "./helpers.ts";

test("the retire setting is keep until the user picks another, and the settings route reads it", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-retire-thread", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const setting = async () => ((await (await app.request("/api/settings")).json()) as { retireThread: string }).retireThread;
  assert.equal(await setting(), "keep");
  for (const thread of ["settle", "archive", "delete"] as const) {
    await stack.run({ type: "consigliere.retireThread.set", thread });
    assert.equal(await setting(), thread);
  }
  await stack.run({ type: "consigliere.retireThread.set", thread: "keep" });
  assert.equal(await setting(), "keep");
  assert.equal(stack.repos.getKv(RETIRE_THREAD_KEY), null, "keep is the default, not a stored value");
  await assert.rejects(stack.run({ type: "consigliere.retireThread.set", thread: "unarchive" } as never));
});
