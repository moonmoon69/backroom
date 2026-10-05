/** Where a new thread works: the project folder, a new worktree T3 makes when it launches the thread, or an existing worktree. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
import { branchSlug } from "../src/app/workspaceChoice.ts";
import type { LaunchThreadInput } from "../src/adapter/types.ts";
import { createTestStack } from "./helpers.ts";

/** The threads the room asked T3 to launch: the workspace it asked for, and where T3 then put the thread. */
const created = (stack: Awaited<ReturnType<typeof createTestStack>>) =>
  stack.fake.commands
    .filter((c) => c.type === "thread.launch")
    .map((c) => c.payload as LaunchThreadInput)
    .map((launch) => ({ threadId: launch.threadId, workspace: launch.workspace, branch: stack.fake.threads.get(launch.threadId)?.shell.branch ?? null, worktreePath: stack.fake.threads.get(launch.threadId)?.shell.worktreePath ?? null }));

test("a participant can get a new worktree, named after the room and itself unless a branch is typed", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const before = created(stack).length;
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "builder", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main" } } });
  await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "tester", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main", branch: "feature/tests" } } });
  const [builder, tester] = created(stack).slice(before);
  // T3 is asked for the worktree with the thread; the room names the branch.
  assert.deepEqual(builder!.workspace, { type: "worktree", baseRef: "main", branch: "payments/builder" });
  assert.deepEqual(tester!.workspace, { type: "worktree", baseRef: "main", branch: "feature/tests" });
  assert.deepEqual([builder!.branch, builder!.worktreePath], ["payments/builder", "/tmp/demo-worktrees/payments-builder"]);
  assert.deepEqual([tester!.branch, tester!.worktreePath], ["feature/tests", "/tmp/demo-worktrees/feature-tests"]);
  // The thread works there from the start: T3 records the worktree, and the briefing names it.
  assert.equal(stack.fake.threads.get(builder!.threadId)!.shell.worktreePath, "/tmp/demo-worktrees/payments-builder");

  // A participant already in the project folder keeps working there.
  const sol1Thread = stack.fake.threads.get(stack.threadOf("sol1"))!;
  assert.equal(sol1Thread.shell.worktreePath, null);
  assert.deepEqual(created(stack)[0]!.workspace, { type: "root" });
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
    (error: Error & { code?: string }) => error.code === "worktree_failed" && /nope is not a branch of this project/.test(error.message),
  );
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "taken", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main", branch: "payments/builder" } } }),
    (error: Error & { code?: string }) => error.code === "worktree_failed" && /a branch named 'payments\/builder' already exists/.test(error.message),
  );
  // What T3 itself refuses while making the worktree is passed on, and nobody is seated either.
  stack.fake.failCreateWorktree = "fatal: could not create work tree dir";
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "unlucky", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "worktree", baseBranch: "main" } } }),
    (error: Error & { code?: string }) => error.code === "t3_rejected" && /could not create work tree dir/.test(error.message),
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
  assert.deepEqual(last.workspace, { type: "existing_worktree", worktreePath: "/tmp/wt/x", branch: "feature/x" });
  assert.deepEqual([last.branch, last.worktreePath], ["feature/x", "/tmp/wt/x"]);
  await assert.rejects(
    stack.run({ type: "participant.create", roomId: stack.roomId, alias: "stray", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, thread: { mode: "create", workspace: { mode: "existing", worktreePath: "/etc" } } }),
    (error: Error & { code?: string }) => error.code === "unknown_worktree",
  );
});

test("a thread of its own in a new worktree names no branch: T3 names it from the first message", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  await stack.run({ type: "thread.start", projectId: "project_demo", text: "fix the login bug", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, workspace: { mode: "worktree", baseBranch: "main" } });
  const thread = created(stack).at(-1)!;
  assert.deepEqual(thread.workspace, { type: "worktree", baseRef: "main" });
  assert.equal(thread.branch, "t3code/fix-the-login-bug");
  assert.equal(thread.worktreePath, "/tmp/demo-worktrees/t3code-fix-the-login-bug");
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
