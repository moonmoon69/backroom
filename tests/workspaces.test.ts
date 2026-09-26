/** Where everyone works: the briefing section, the location recorded with each reply, and branch tags on replies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isWorkspaceArtifact } from "../src/domain/types.ts";
import { workspaceSection } from "../src/briefing/assemble.ts";
import { createTestStack } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();

test("briefings say where everyone works; replies record where their work is; dependents are told", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rooms-ws-")));
  const repo = join(dir, "app");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "First");
  const worktree = join(dir, "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(join(worktree, "b.txt"), "new\n");

  const stack = await createTestStack();
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stack.fake.projects[0]!.workspaceRoot = repo;
  stack.fake.threads.get(stack.threadOf("sol2"))!.shell.worktreePath = worktree;

  // sol2 works in its worktree; sol1 and claude share the project folder.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.sol2!], instruction: "add b", schedule: { mode: "now" } });
  await stack.tick(2);
  const sol2Briefing = stack.repos.listRunsForTask(stack.task(1).id)[0]!.briefing;
  assert.match(sol2Briefing, /== Where everyone works ==\nYou: .*\/feature, branch feature\./);
  assert.match(sol2Briefing, new RegExp(`@sol1: ${repo} \\(the project folder\\), branch main\\.`));
  assert.match(sol2Briefing, /git diff <your branch>\.\.\.<branch>/, "how to read the others' work");
  assert.match(sol2Briefing, /Extra worktrees are fine for parallel work \(sub-agents, experiments\): base them on your branch, merge what you keep into your branch before you finish/);
  assert.doesNotMatch(sol2Briefing, /Choose your own workspace strategy/);
  assert.doesNotMatch(sol2Briefing, /You share your folder/);

  stack.fake.completeTurn(stack.threadOf("sol2"), { text: "Added b.txt.", files: [{ path: "b.txt", kind: "added", additions: 1, deletions: 0 }] });
  await stack.tick(2);
  const reply = stack.repos.listEvents(stack.roomId).find((e) => e.kind === "assistant.reply")!;
  const where = reply.artifacts.find(isWorkspaceArtifact)!;
  assert.deepEqual([where.path, where.branch, where.commit, where.note], [worktree, "feature", git(worktree, "rev-parse", "HEAD"), "1 file uncommitted"]);

  // sol1 builds on it: told where the work is, and sol2's reply is marked as being on another branch.
  await stack.run({
    type: "task.create",
    roomId: stack.roomId,
    recipients: [stack.participants.sol1!],
    instruction: "review b",
    schedule: { mode: "after_all", prerequisites: [{ taskId: stack.task(1).id, revision: 1 }] },
  });
  await stack.tick(2);
  const sol1Briefing = stack.repos.listRunsForTask(stack.task(2).id)[0]!.briefing;
  assert.match(sol1Briefing, new RegExp(`Where the work is: ${worktree}, branch feature at commit [0-9a-f]{12} \\(1 file uncommitted when the task finished\\)\\.`));
  assert.match(sol1Briefing, /Files changed in that turn, relative to that folder:\n {2}- added b\.txt/);
  assert.match(sol1Briefing, /@claude: the same folder as you\./);
  assert.match(sol1Briefing, /You share your folder with @claude: don't switch branches/);

  // claude reads sol2's reply as a room message: tagged with the branch it was made on, which is not claude's.
  await stack.run({ type: "task.create", roomId: stack.roomId, recipients: [stack.participants.claude!], instruction: "look around", schedule: { mode: "now" } });
  await stack.tick(2);
  const claudeBriefing = stack.repos.listRunsForTask(stack.task(3).id)[0]!.briefing;
  assert.match(claudeBriefing, /\[#\d+ sol2 reply · on branch feature\]\nAdded b\.txt\./);
});

test("the section lists each folder and branch, and is left out when the own folder is unknown", () => {
  const ws = (participantId: string, alias: string, folder: string, branch: string) => ({ participantId, alias, folder, isProjectRoot: false, branch, headSha: null, changed: 0 });
  const section = workspaceSection("a", [ws("a", "a", "/r", "main"), ws("b", "b", "/w", "feature")])!;
  assert.match(section, /You: \/r, branch main\.\n@b: \/w, branch feature\./);
  assert.equal(workspaceSection("a", [{ ...ws("a", "a", "/r", "main"), folder: null }]), null, "no section when the own folder is unknown");
});
