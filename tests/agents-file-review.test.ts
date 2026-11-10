import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { AGENTS_TEXT_KEY, AgentsFiles } from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "sol-agents-review-")));
  const allowed = join(root, "allowed");
  const folder = join(allowed, "project");
  const outside = join(root, "outside");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(outside);
  const stack = createStack({ dbPath: ":memory:", adapter: new FakeT3Adapter(), briefingBudgetChars: 60000, latestRelease: async () => null });
  t.after(() => {
    stack.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const files = new AgentsFiles(stack.repos, { onlyUnder: [allowed] });
  const projects = [{ id: "review-project", title: "review", workspaceRoot: folder }];
  fs.writeFileSync(join(folder, "AGENTS.md"), "# Reviewed project wording\n");
  fs.writeFileSync(join(outside, "AGENTS.md"), "# Reviewed project wording\n");
  stack.repos.setKv(AGENTS_TEXT_KEY, "# Replacement template");
  const seen = await files.diff("review-project", projects);
  const redirect = () => {
    fs.renameSync(folder, folder + "-original");
    fs.symlinkSync(outside, folder, "dir");
  };
  return { root, allowed, folder, outside, stack, files, projects, seen, redirect };
}

test("review: a project folder redirected outside onlyUnder is blocked for state and diff reads", async (t) => {
  const f = await fixture(t);
  f.redirect();
  assert.equal(f.files.list(f.projects)[0]?.state, "blocked", "a folder resolved outside onlyUnder is never read");
  await assert.rejects(f.files.diff("review-project", f.projects));
});

test("review: Apply cannot follow a project folder's replacement link outside onlyUnder", async (t) => {
  const f = await fixture(t);
  f.redirect();
  let refused = false;
  try {
    await f.files.apply({ projectId: "review-project", fileDigest: f.seen.fileDigest, templateDigest: f.seen.templateDigest }, f.projects);
  } catch {
    refused = true;
  }
  assert.equal(fs.readFileSync(join(f.outside, "AGENTS.md"), "utf8"), "# Reviewed project wording\n", "Apply must leave the file outside onlyUnder untouched");
  assert.equal(refused, true, "the redirected folder must be refused");
});

test("review: a folder link swapped in after comparison cannot redirect Apply's final open", async (t) => {
  const f = await fixture(t);
  const racing = new AgentsFiles(f.stack.repos, { onlyUnder: [f.allowed], beforeWrite: f.redirect });
  let refused = false;
  try {
    await racing.apply({ projectId: "review-project", fileDigest: f.seen.fileDigest, templateDigest: f.seen.templateDigest }, f.projects);
  } catch {
    refused = true;
  }
  assert.equal(fs.readFileSync(join(f.outside, "AGENTS.md"), "utf8"), "# Reviewed project wording\n", "the no-follow final open must also protect its parent folder");
  assert.equal(refused, true);
});

test("review: O_NOFOLLOW blocks a state-read link swapped in after lstat", async (t) => {
  const f = await fixture(t);
  const path = join(f.folder, "AGENTS.md");
  const realLstat = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const result = realLstat(...args);
    if (String(args[0]) === path && !swapped) {
      swapped = true;
      fs.unlinkSync(path);
      fs.symlinkSync(join(f.outside, "AGENTS.md"), path);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const entry = f.files.list(f.projects)[0];
  assert.equal(swapped, true);
  assert.equal(entry?.state, "blocked", "a successful lstat is insufficient if a link appears before open");
  assert.match(entry?.reason ?? "", /is a link/);
});

/** Swaps the project's folder for a link to the outside folder at the n-th lstat of its AGENTS.md: after the check, before the open. */
function swapAtLstat(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, n: number): () => boolean {
  const path = join(f.folder, "AGENTS.md");
  const realLstat = fs.lstatSync;
  let calls = 0;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const result = realLstat(...args);
    if (String(args[0]) === path && ++calls === n) f.redirect();
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => calls >= n;
}

test("review #267: a folder swapped for a link after the read's check is blocked, never read from outside onlyUnder", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.outside, "AGENTS.md"), "# OUTSIDE_SENTINEL\n");
  const swapped = swapAtLstat(t, f, 1);
  await assert.rejects(f.files.diff("review-project", f.projects), /leads elsewhere now/);
  assert.equal(swapped(), true);
});

test("review #267: Apply's own open goes through the same guard: a folder swapped after its check is refused, the outside file untouched", async (t) => {
  const f = await fixture(t);
  // compare's open looks at the name twice (before and after); Apply's own open looks first at the third.
  const swapped = swapAtLstat(t, f, 3);
  await assert.rejects(f.files.apply({ projectId: "review-project", fileDigest: f.seen.fileDigest, templateDigest: f.seen.templateDigest }, f.projects), /leads elsewhere now/);
  assert.equal(swapped(), true);
  assert.equal(fs.readFileSync(join(f.outside, "AGENTS.md"), "utf8"), "# Reviewed project wording\n");
});
