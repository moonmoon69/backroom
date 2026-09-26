/** The Git tab's reads through the HTTP app, against a real repository with a linked worktree. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpApp } from "../src/server/http.ts";
import { loadConfig } from "../src/config.ts";
import { parseStatus, splitRenamedPath } from "../src/server/git.ts";
import { createTestStack } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });

function makeRepo(): { dir: string; repo: string; worktree: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rooms-git-")));
  const repo = join(dir, "app");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "old.txt"), "moved\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "First commit");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "commit", "-q", "-am", "Second commit");
  // Uncommitted: a modified file (staged), a rename, and an untracked file.
  writeFileSync(join(repo, "a.txt"), "one\n2\nthree\n");
  git(repo, "add", "a.txt");
  git(repo, "mv", "old.txt", "new.txt");
  writeFileSync(join(repo, "notes.md"), "# notes\nline\n");
  const worktree = join(dir, "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  return { dir, repo, worktree };
}

test("git view: the room's folders, uncommitted files, commits, worktrees and diffs", async (t) => {
  const { dir, repo, worktree } = makeRepo();
  const stack = await createTestStack();
  t.after(() => {
    stack.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-git", ROOMS_PORT: "0" }), "/nonexistent/dist");
  stack.fake.projects[0]!.workspaceRoot = repo;
  // sol2 works in its own worktree; sol1 and claude in the project's folder.
  stack.fake.threads.get(stack.threadOf("sol2"))!.shell.worktreePath = worktree;

  const response = await app.request(`/api/rooms/${stack.roomId}/git`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { folders: any[]; view: any };
  assert.deepEqual(
    body.folders.map((f) => [f.path, f.participantIds.length, f.branch, f.changed]),
    [
      [repo, 2, "main", 3],
      [worktree, 1, "feature", 0],
    ],
  );
  const view = body.view;
  assert.equal(view.path, repo);
  assert.equal(view.repoName, "app");
  assert.equal(view.isLinkedWorktree, false);
  const files = Object.fromEntries(view.files.map((f: any) => [f.path, f]));
  assert.deepEqual([files["a.txt"].status, files["a.txt"].staged, files["a.txt"].additions, files["a.txt"].deletions], ["modified", "all", 1, 1]);
  assert.deepEqual([files["new.txt"].status, files["new.txt"].origPath], ["renamed", "old.txt"]);
  assert.deepEqual([files["notes.md"].status, files["notes.md"].additions], ["untracked", 2]);
  assert.deepEqual(
    view.commits.map((c: any) => [c.subject, c.fileCount, c.pushed]),
    [
      ["Second commit", 1, null],
      ["First commit", 2, null],
    ],
  );
  assert.equal(view.head.subject, "Second commit");
  assert.deepEqual(
    view.worktrees.map((w: any) => [w.path, w.branch, w.isMain]),
    [
      [repo, "main", true],
      [worktree, "feature", false],
    ],
  );

  const inWorktree = (await (await app.request(`/api/rooms/${stack.roomId}/git?path=${encodeURIComponent(worktree)}`)).json()) as { view: any };
  assert.equal(inWorktree.view.path, worktree);
  assert.equal(inWorktree.view.isLinkedWorktree, true);
  assert.equal(inWorktree.view.repoName, "app", "a worktree is named after its repository");

  const summary = (await (await app.request(`/api/rooms/${stack.roomId}/git?summary=1`)).json()) as { view: unknown };
  assert.equal(summary.view, null);

  const diff = async (query: string) => app.request(`/api/rooms/${stack.roomId}/git/diff?path=${encodeURIComponent(repo)}&${query}`);
  const modified = (await (await diff("file=a.txt")).json()) as { diff: string; truncated: boolean };
  assert.match(modified.diff, /^-two$/m);
  assert.match(modified.diff, /^\+2$/m);
  const untracked = (await (await diff("file=notes.md&untracked=1")).json()) as { diff: string };
  assert.match(untracked.diff, /^\+# notes$/m);
  const first = view.commits[1].sha as string;
  const inCommit = (await (await diff(`file=old.txt&commit=${first}`)).json()) as { diff: string };
  assert.match(inCommit.diff, /^\+moved$/m);

  assert.equal((await diff("file=../../etc/passwd")).status, 400);
  assert.equal((await diff("file=.git/config&untracked=1")).status, 400, "nothing under .git");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  assert.equal((await diff("file=.env&untracked=1")).status, 400, "ignored files are not untracked files");
  assert.equal((await diff("file=a.txt&commit=HEAD;rm")).status, 400);
  const outside = await app.request(`/api/rooms/${stack.roomId}/git/diff?path=${encodeURIComponent(dir)}&file=a.txt`);
  assert.equal(outside.status, 403, "only the room's folders and their worktrees can be read");
  // A folder that is not on this machine is reported, not an error.
  stack.fake.projects[0]!.workspaceRoot = join(dir, "elsewhere");
  const gone = (await (await app.request(`/api/rooms/${stack.roomId}/git`)).json()) as { folders: any[] };
  assert.deepEqual(
    gone.folders.map((f) => [f.exists, f.isRepo]),
    [
      [false, false],
      [true, true],
    ],
  );
});

test("git status and numstat paths: renames split, branch and upstream read", () => {
  assert.deepEqual(splitRenamedPath("src/{old => new}/a.ts"), { path: "src/new/a.ts", origPath: "src/old/a.ts" });
  assert.deepEqual(splitRenamedPath("src/{ => sub}/a.ts"), { path: "src/sub/a.ts", origPath: "src/a.ts" });
  assert.deepEqual(splitRenamedPath("a.txt => b.txt"), { path: "b.txt", origPath: "a.txt" });
  assert.deepEqual(splitRenamedPath("plain.ts"), { path: "plain.ts", origPath: null });
  const status = parseStatus(
    ["# branch.oid abc", "# branch.head work", "# branch.upstream origin/work", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 h1 h2 has space.txt", "? new file.md", ""].join("\0"),
  );
  assert.deepEqual([status.branch, status.upstream, status.ahead, status.behind], ["work", "origin/work", 2, 1]);
  assert.deepEqual(
    status.files.map((f) => [f.path, f.status, f.staged]),
    [
      ["has space.txt", "modified", "none"],
      ["new file.md", "untracked", "none"],
    ],
  );
});
