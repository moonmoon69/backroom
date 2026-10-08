/** Where everyone works: the briefing section. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceSection } from "../src/briefing/assemble.ts";
import { createTestStack } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();

test("briefings say where everyone works: each member's own folder and branch, the others', and who shares a folder", async (t) => {
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
  /** The briefing of the member's latest turn, as T3 received it. */
  const briefing = (alias: string) => {
    const thread = stack.fake.threads.get(stack.threadOf(alias))!;
    return thread.messages.find((m) => m.id === thread.runs.at(-1)!.userMessageId)!.text;
  };

  // sol2 works in its worktree; sol1 and claude share the project folder.
  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol2!], instruction: "add b" }] });
  await stack.tick(2);
  const sol2Briefing = briefing("sol2");
  assert.match(sol2Briefing, /== Where everyone works ==\nYou: .*\/feature, branch feature\./);
  assert.match(sol2Briefing, new RegExp(`@sol1: ${repo} \\(the project folder\\), branch main\\.`));
  assert.match(sol2Briefing, /git diff <your branch>\.\.\.<branch>/, "how to read the others' work");
  assert.match(sol2Briefing, /Extra worktrees are fine for parallel work \(sub-agents, experiments\): base them on your branch, merge what you keep into your branch before you finish/);
  assert.doesNotMatch(sol2Briefing, /Choose your own workspace strategy/);
  assert.doesNotMatch(sol2Briefing, /You share your folder/);

  await stack.run({ type: "message.create", roomId: stack.roomId, assignments: [{ recipients: [stack.participants.sol1!], instruction: "review b" }] });
  await stack.tick(2);
  const sol1Briefing = briefing("sol1");
  assert.match(sol1Briefing, /@claude: the same folder as you\./);
  assert.match(sol1Briefing, /You share your folder with @claude: don't switch branches/);
});

test("the section lists each folder and branch, and is left out when the own folder is unknown", () => {
  const ws = (participantId: string, alias: string, folder: string, branch: string) => ({ participantId, alias, folder, isProjectRoot: false, branch, headSha: null, changed: 0 });
  const section = workspaceSection("a", [ws("a", "a", "/r", "main"), ws("b", "b", "/w", "feature")])!;
  assert.match(section, /You: \/r, branch main\.\n@b: \/w, branch feature\./);
  assert.equal(workspaceSection("a", [{ ...ws("a", "a", "/r", "main"), folder: null }]), null, "no section when the own folder is unknown");
});
