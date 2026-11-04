import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { makePackFixture } from "../scripts/pstack-fixture.ts";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { Packs } from "../src/app/packs.ts";
import { skillRoster } from "../src/app/skillRoster.ts";
import { Database } from "../src/db/database.ts";
import { Repos } from "../src/db/repos.ts";
import { slashEntries, slashInsert } from "../web/src/slashList.ts";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sol-review-skills-"));
  const db = new Database(":memory:");
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const repos = new Repos(db);
  repos.deletePack("pstack");
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir);
  const packs = new Packs(repos, { dataDir, home });
  const fx = makePackFixture(join(root, "upstream"));
  await packs.add(fx.bare);
  return { packs, home, fx };
}

for (const [instanceId, folder] of [["codex", "agents"], ["claudeAgent", "claude"]] as const) {
  test(`review: a linked compact skill preserves ${instanceId}'s native compact command`, async (t) => {
    const { packs, fx, home } = await fixture(t);
    const sha = fx.commit("a skill with a built-in command's name", { files: { "skills/compact/SKILL.md": "---\nname: compact\ndescription: A pack skill.\n---\n" } });
    await packs.checkNow("skills-pack");
    await packs.takeUpdate("skills-pack", sha);
    await packs.link("skills-pack", "skills/compact", folder);
    const adapter = new FakeT3Adapter({ autoCompleteMs: null });
    adapter.skillsHome = home;
    const rows = skillRoster({ providers: await adapter.listProviders(), packs: packs.list().map((pack) => ({ pack, skills: packs.skills(pack) })), folders: packs.folders(), crew: [], hints: new Map() });
    const entries = slashEntries(rows, [instanceId], { atStart: false, query: "compact" });
    assert.ok(entries.some((entry) => entry.kind === "command" && slashInsert(entry) === "/compact "), "the native /compact must remain a command, alongside the pack skill");
  });
}

test("review: an update deleting SKILL.md unlinks the skill even when scripts remain", async (t) => {
  const { packs, fx, home } = await fixture(t);
  await packs.link("skills-pack", "skills/alpha", "claude");
  rmSync(join(fx.work, "skills/alpha/SKILL.md"));
  const sha = fx.commit("alpha is no longer a skill; keep its script");
  await packs.checkNow("skills-pack");
  const result = await packs.takeUpdate("skills-pack", sha);
  assert.equal(result.state.skills.some((skill) => skill.path === "skills/alpha"), false);
  assert.equal(result.unlinked.length, 1, "the link to a removed skill must be reported and removed");
  assert.throws(() => lstatSync(join(home, ".claude/skills/alpha")), { code: "ENOENT" });
});
