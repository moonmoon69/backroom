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
  assert.ok(await files.roomCreated({ id: "review-project", workspaceRoot: folder }));
  fs.writeFileSync(join(folder, "AGENTS.md"), "# Reviewed project wording\n");
  fs.writeFileSync(join(outside, "AGENTS.md"), "# Reviewed project wording\n");
  stack.repos.setKv(AGENTS_TEXT_KEY, "# Replacement template");
  const seen = await files.diff({ projectId: "review-project" });
  const redirect = () => {
    fs.renameSync(folder, folder + "-original");
    fs.symlinkSync(outside, folder, "dir");
  };
  return { root, allowed, folder, outside, stack, files, seen, redirect };
}

test("review: a recorded folder redirected outside onlyUnder is blocked for state and diff reads", async (t) => {
  const f = await fixture(t);
  f.redirect();
  assert.equal(f.files.list()[0]?.state, "blocked", "a canonical record must not follow its folder's replacement link");
  await assert.rejects(f.files.diff({ projectId: "review-project" }));
});

test("review: Apply cannot follow a recorded folder's replacement link outside onlyUnder", async (t) => {
  const f = await fixture(t);
  f.redirect();
  let refused = false;
  try {
    await f.files.apply({ projectId: "review-project", fileDigest: f.seen.fileDigest, templateDigest: f.seen.templateDigest });
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
    await racing.apply({ folder: f.folder, fileDigest: f.seen.fileDigest, templateDigest: f.seen.templateDigest });
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
  const entry = f.files.list()[0];
  assert.equal(swapped, true);
  assert.equal(entry?.state, "blocked", "a successful lstat is insufficient if a link appears before open");
  assert.match(entry?.reason ?? "", /link now/);
});
