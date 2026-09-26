/** Where a new thread works: the project folder, a new worktree made through T3, or an existing worktree. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
import { branchSlug } from "../src/app/workspaceChoice.ts";
import { createTestStack } from "./helpers.ts";

const created = (stack: Awaited<ReturnType<typeof createTestStack>>) =>
  stack.fake.commands.filter((c) => c.type === "thread.create").map((c) => c.payload as { threadId: string; branch?: string | null; worktreePath?: string | null });

test("a participant can get a new worktree, named after the room and itself unless a branch is typed", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const before = created(stack).length;
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "builder", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main" } } });
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "tester", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main", branch: "feature/tests" } } });
  const [builder, tester] = created(stack).slice(before);
  assert.deepEqual([builder!.branch, builder!.worktreePath], ["payments/builder", "/tmp/demo-worktrees/payments-builder"]);
  assert.deepEqual([tester!.branch, tester!.worktreePath], ["feature/tests", "/tmp/demo-worktrees/feature-tests"]);
  // The thread works there from the start: T3 records the worktree, and the briefing names it.
  assert.equal(stack.fake.threads.get(builder!.threadId)!.shell.worktreePath, "/tmp/demo-worktrees/payments-builder");

  // A participant already in the project folder keeps working there.
  const sol1Thread = stack.fake.threads.get(stack.threadOf("sol1"))!;
  assert.equal(sol1Thread.shell.worktreePath, null);
});

test("the default branch avoids names in use; a taken or bad base branch fails without seating anyone", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  stack.fake.refs.set("/tmp/demo", [
    { name: "main", isRemote: false, current: true, isDefault: true, worktreePath: "/tmp/demo" },
    { name: "payments/builder", isRemote: false, current: false, isDefault: false, worktreePath: null },
  ]);
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "builder", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main" } } });
  assert.equal(created(stack).at(-1)!.branch, "payments/builder-2");

  const count = stack.repos.listActiveParticipants(stack.roomId).length;
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "other", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "nope" } } }),
    (error: Error & { code?: string }) => error.code === "worktree_failed" && /invalid reference: nope/.test(error.message),
  );
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "bad", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main", branch: "a..b" } } }),
  );
  assert.equal(stack.repos.listActiveParticipants(stack.roomId).length, count, "nobody seated after a failure");
});

test("an existing worktree is used as it is; a folder that is not one of the project's worktrees is refused", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  stack.fake.refs.set("/tmp/demo", [
    { name: "main", isRemote: false, current: true, isDefault: true, worktreePath: "/tmp/demo" },
    { name: "feature/x", isRemote: false, current: false, isDefault: false, worktreePath: "/tmp/wt/x" },
  ]);
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "joiner", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "existing", worktreePath: "/tmp/wt/x/" } } });
  const last = created(stack).at(-1)!;
  assert.deepEqual([last.branch, last.worktreePath], ["feature/x", "/tmp/wt/x"]);
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "stray", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "existing", worktreePath: "/etc" } } }),
    (error: Error & { code?: string }) => error.code === "unknown_worktree",
  );
});

test("a thread of its own in a new worktree gets T3's temporary branch, which T3 renames from the first message", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "thread.start", projectId: "project_demo", text: "fix the login bug", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, workspace: { mode: "worktree", baseBranch: "main" } });
  const thread = created(stack).at(-1)!;
  assert.match(thread.branch ?? "", /^t3code\/[0-9a-f]{8}$/);
  assert.equal(thread.worktreePath, `/tmp/demo-worktrees/${thread.branch!.replace("/", "-")}`);
});

test("the refs route lists the project's branches with their worktrees and T3's default for new threads", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-refs", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const body = (await (await app.request("/api/t3/projects/project_demo/refs")).json()) as { isRepo: boolean; workspaceRoot: string; refs: Array<{ name: string; worktreePath: string | null }> };
  assert.equal(body.isRepo, true);
  assert.equal(body.workspaceRoot, "/tmp/demo");
  assert.deepEqual(body.refs.map((r) => [r.name, r.worktreePath]), [["main", "/tmp/demo"]]);
  assert.equal(branchSlug("Payments & Billing!", "room"), "payments-billing");
});
