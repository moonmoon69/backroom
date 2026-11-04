/**
 * Skill packs (src/app/packs.ts) from local bare repositories (scripts/pstack-fixture.ts), never the network, with the
 * skill folders under a home of the test's own: Add pack, the daily check, the update shown and taken, local changes,
 * links and their refusals, Remove, readers during a checkout, pstack seeded from Poteto mode's clone and keys (the
 * migration in src/db/database.ts), the agents file's {skills}, and the routes and commands.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { DEFAULT_AGENTS_TEMPLATE, SKILLS_PLACEHOLDER, renderAgentsText } from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { DAY_MS, Packs, SKILLS_FOLDER, frontmatter, packName, type PackClock, type PackState as ServerPackState, type PackUpdateDetail as ServerDetail } from "../src/app/packs.ts";
import type { CommandResult as ServerResult } from "../src/app/service.ts";
import type { SkillRow as ServerRow } from "../src/app/skillRoster.ts";
import { loadConfig } from "../src/config.ts";
import { Database, MIGRATIONS } from "../src/db/database.ts";
import { Repos } from "../src/db/repos.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { POTETO_WORDS, PSTACK_FOLDER, PSTACK_PACK, PSTACK_REPO } from "../src/domain/skills.ts";
import { createHttpApp } from "../src/server/http.ts";
import type * as Web from "../web/src/types.ts";
import { makePackFixture, makePstackFixture } from "../scripts/pstack-fixture.ts";

// The web keeps hand copies of the shapes and the commands: `npm run typecheck` fails when they drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Cmd<T extends string> = Same<Extract<Web.RoomCommand, { type: T }>, Extract<RoomCommandInput, { type: T }>>;
const same: Array<true> = [
  true satisfies Same<Web.PackState, ServerPackState>,
  true satisfies Same<Web.PackUpdateDetail, ServerDetail>,
  true satisfies Same<Web.SkillRow, ServerRow>,
  true satisfies Cmd<"pack.add">,
  true satisfies Cmd<"pack.remove">,
  true satisfies Cmd<"pack.check">,
  true satisfies Cmd<"pack.update.take">,
  true satisfies Cmd<"pack.standing.set">,
  true satisfies Cmd<"skill.link">,
  true satisfies Cmd<"skill.unlink">,
  true satisfies Cmd<"skill.hint.set">,
  true satisfies Same<Extract<Web.CommandResult, { type: "pack.updated" }>, Extract<ServerResult, { type: "pack.updated" }>>,
];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backroom-packs-")));
const emptyConfig = join(scratch, "gitconfig");
writeFileSync(emptyConfig, "");
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Tester",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Tester",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
});
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let dirs = 0;
const dir = (name = "d") => {
  const path = join(scratch, `${name}-${++dirs}`);
  mkdirSync(path, { recursive: true });
  return path;
};
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

function fakeClock(): PackClock & { t: number; advance(ms: number): void } {
  return {
    t: Date.parse("2026-11-04T08:00:00Z"),
    now() {
      return this.t;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    advance(ms) {
      this.t += ms;
    },
  };
}

/** Packs over a fresh database (pstack's row deleted unless a source is given for it), a data folder and a home of their own. */
function packsFor(options: { dataDir?: string; pstack?: string; clock?: ReturnType<typeof fakeClock>; dbPath?: string } = {}) {
  const db = new Database(options.dbPath ?? ":memory:");
  const repos = new Repos(db);
  if (!options.pstack) repos.deletePack(PSTACK_PACK);
  const dataDir = options.dataDir ?? dir("data");
  const home = dir("home");
  const clock = options.clock ?? fakeClock();
  const logs: string[] = [];
  const packs = new Packs(repos, { dataDir, home, ...(options.pstack ? { pstackSource: options.pstack } : {}), clock, log: (m) => logs.push(m) });
  return { db, repos, packs, dataDir, home, clock, logs, skills: join(realpathSync(dataDir), SKILLS_FOLDER) };
}

test("the web's copies of the packs' and the roster's shapes, commands and result match the server's (checked by npm run typecheck)", () => {
  assert.equal(same.length, 12);
});

test("a SKILL.md's frontmatter: plain, quoted and folded descriptions on one line; a pack's name from its URL", () => {
  assert.deepEqual(frontmatter("---\nname: a\ndescription: plain words\n---\nbody"), { name: "a", description: "plain words" });
  assert.deepEqual(frontmatter('---\nname: "b"\ndescription: "say \\"hi\\""\n---\n'), { name: "b", description: 'say "hi"' });
  assert.deepEqual(frontmatter("---\nname: c\ndescription: >-\n  folded over\n  two lines\nlicense: MIT\n---\n"), { name: "c", description: "folded over two lines" });
  assert.deepEqual(frontmatter("---\ndescription: 'it''s'\n---\n"), { name: null, description: "it's" });
  assert.deepEqual(frontmatter("# no frontmatter\n"), { name: null, description: null });
  assert.equal(packName("https://github.com/Leonxlnx/taste-skill.git"), "taste-skill");
  assert.equal(packName("git@github.com:owner/My Skills.git"), "my-skills");
  assert.equal(packName("/srv/repos/pack.git/"), "pack");
});

test("Add pack: a whole clone in data/skills/<name>, pinned at the commit cloned, its skills from their frontmatter, nothing linked, no script run", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos, home, skills } = packsFor();
  const state = await packs.add(fx.bare);
  assert.equal(state.name, "skills-pack");
  assert.equal(state.folder, join(skills, "skills-pack"));
  assert.equal(state.pinned, git(fx.work, "rev-parse", "HEAD"));
  assert.equal(git(state.folder, "rev-parse", "HEAD"), state.pinned, "checked out at its pin");
  assert.ok(existsSync(join(state.folder, "README.md")) && !existsSync(join(state.folder, ".git/info/sparse-checkout")), "the whole repository");
  assert.ok(existsSync(join(state.folder, "setup.sh")), "its other files kept beside its skills");
  assert.deepEqual(
    state.skills.map((s) => [s.path, s.name, s.linkName, s.description, s.folders, s.linked]),
    [
      ["skills/alpha", "alpha", "alpha", "Use alpha for the first kind of job.", ["claude", "agents", "grok"], []],
      ["skills/beta", "beta-skill", "beta", "Beta, for the second kind.", ["claude", "agents", "grok"], []],
    ],
  );
  assert.equal(existsSync(fx.marker), false, "no script of the pack ran");
  assert.deepEqual(readdirSync(skills).filter((name) => name.startsWith(".")), [], "no temporary folder left");
  assert.deepEqual(readdirSync(home), [], "nothing linked: no skill folder even made");
  assert.equal(repos.getPack("skills-pack")?.standing, null, "no standing line until the user writes one");
  assert.ok(state.checkedAt, "checked as it was cloned");
});

test("Add pack refused with nothing left: a URL Backroom does not clone, a repository with no SKILL.md, a name kept already", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos, skills } = packsFor();
  for (const url of ["ext::sh -c touch% /tmp/pwned", "--upload-pack=evil", "relative/path", "https://"]) {
    await assert.rejects(packs.add(url), (error: Error) => /is not a repository URL Backroom clones|no pack name/.test(error.message), url);
  }
  const plain = dir("plain");
  execFileSync("git", ["init", "-q", "-b", "main", join(plain, "work")]);
  writeFileSync(join(plain, "work", "README.md"), "no skills here\n");
  git(join(plain, "work"), "add", ".");
  git(join(plain, "work"), "commit", "-q", "-m", "first");
  execFileSync("git", ["clone", "-q", "--bare", join(plain, "work"), join(plain, "noskills.git")]);
  await assert.rejects(packs.add(join(plain, "noskills.git")), /holds no SKILL\.md/);
  assert.equal(repos.getPack("noskills"), null);
  assert.equal(existsSync(join(skills, "noskills")), false);
  assert.deepEqual(readdirSync(skills).filter((name) => name.startsWith(".")), [], "its temporary folder removed");
  await packs.add(fx.bare);
  await assert.rejects(packs.add(fx.bare), /a pack named skills-pack is kept already/);
  await assert.rejects(packs.add(join(scratch, "missing.git")), /the clone of .* failed/);
});

test("the daily check only fetches: an update names the upstream commit with its stat, files, description changes and diff; Take update checks out exactly the commit looked at; discovery enables nothing", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos, clock } = packsFor();
  const added = await packs.add(fx.bare);
  await packs.link("skills-pack", "skills/alpha", "claude");
  const next = fx.commit("skills: gamma, and alpha says more", {
    files: { "skills/gamma/SKILL.md": "---\nname: gamma\ndescription: Gamma.\n---\n", "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Use alpha for every job.\n---\n" },
  });
  await packs.tick();
  assert.equal(packs.state(repos.getPack("skills-pack")!).update, null, "not due: a day has not passed");
  clock.advance(DAY_MS);
  await packs.tick();
  const state = packs.state(repos.getPack("skills-pack")!);
  assert.deepEqual(state.update, { commit: next, subject: "skills: gamma, and alpha says more" });
  assert.equal(git(added.folder, "rev-parse", "HEAD"), added.pinned, "the check moved nothing");
  assert.deepEqual(state.skills.map((s) => s.path), ["skills/alpha", "skills/beta"], "the new skill is not there before the update is taken");
  const detail = await packs.updateDetail("skills-pack", next);
  assert.equal(detail.from, added.pinned);
  assert.match(detail.stat, /2 files changed/);
  assert.deepEqual(detail.files, [
    { status: "M", path: "skills/alpha/SKILL.md" },
    { status: "A", path: "skills/gamma/SKILL.md" },
  ]);
  assert.deepEqual(detail.descriptions, [
    { path: "skills/alpha/SKILL.md", before: "Use alpha for the first kind of job.", after: "Use alpha for every job." },
    { path: "skills/gamma/SKILL.md", before: null, after: "Gamma." },
  ]);
  assert.match(detail.diff, /^\+description: Use alpha for every job\.$/m);
  // Upstream moves on after the user looked: the commit taken is the one looked at.
  const later = fx.commit("skills: later", { files: { "skills/beta/extra.md": "later\n" } });
  assert.equal((await packs.checkNow("skills-pack")).update?.commit, later);
  const taken = await packs.takeUpdate("skills-pack", next);
  assert.equal(git(added.folder, "rev-parse", "HEAD"), next, "exactly the commit looked at, not upstream's newer one");
  assert.equal(repos.getPack("skills-pack")!.pinned, next);
  assert.equal(taken.state.update?.commit, later, "the newer one is offered next");
  assert.deepEqual(
    taken.state.skills.map((s) => [s.path, s.linked]),
    [
      ["skills/alpha", ["claude"]],
      ["skills/beta", []],
      ["skills/gamma", []],
    ],
    "the skill the update brought is not linked anywhere",
  );
  assert.deepEqual(taken.unlinked, []);
  assert.equal(existsSync(fx.marker), false, "no script ran");
  await assert.rejects(packs.takeUpdate("skills-pack", "0".repeat(40)), /is not a commit skills-pack has fetched/);
});

test("local changes: an untracked file is no dirt; one in the update's way refuses Take update by name, as a tracked change does, with nothing changed", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos } = packsFor();
  const added = await packs.add(fx.bare);
  const folder = added.folder;
  writeFileSync(join(folder, "skills/alpha/.state"), "written by the skill as it ran\n");
  const next = fx.commit("skills: beta's notes", { files: { "skills/beta/notes.md": "upstream's notes\n" } });
  await packs.checkNow("skills-pack");
  const notes = join(folder, "skills/beta/notes.md");
  writeFileSync(notes, "mine\n");
  await assert.rejects(packs.takeUpdate("skills-pack", next), /untracked skills\/beta\/notes\.md in .* would be overwritten by [0-9a-f]{7}: move it away first/);
  assert.equal(git(folder, "rev-parse", "HEAD"), added.pinned, "nothing moved");
  assert.equal(readFileSync(notes, "utf8"), "mine\n", "the file kept");
  assert.equal(repos.getPack("skills-pack")!.pinned, added.pinned);
  rmSync(notes);
  writeFileSync(join(folder, "skills/beta/SKILL.md"), "changed by hand\n");
  await assert.rejects(packs.takeUpdate("skills-pack", next), /local changes to tracked files in .* \(skills\/beta\/SKILL\.md\): Backroom moves nothing while they are there/);
  assert.equal(git(folder, "rev-parse", "HEAD"), added.pinned);
  assert.equal(readFileSync(join(folder, "skills/beta/SKILL.md"), "utf8"), "changed by hand\n");
  git(folder, "checkout", "--", ".");
  await packs.takeUpdate("skills-pack", next);
  assert.equal(git(folder, "rev-parse", "HEAD"), next, "with only untracked files of its own, it moves");
  assert.equal(readFileSync(join(folder, "skills/alpha/.state"), "utf8"), "written by the skill as it ran\n", "and leaves them as they are");
});

test("Take update takes out Backroom's links to skills the update removed, and only those", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, home } = packsFor();
  await packs.add(fx.bare);
  await packs.link("skills-pack", "skills/alpha", "claude");
  await packs.link("skills-pack", "skills/beta", "agents");
  rmSync(join(fx.work, "skills/beta"), { recursive: true });
  const next = fx.commit("skills: beta goes");
  await packs.checkNow("skills-pack");
  const taken = await packs.takeUpdate("skills-pack", next);
  assert.deepEqual(taken.unlinked, [`${join(home, ".agents/skills")}/beta`]);
  assert.equal(isLink(join(home, ".agents/skills/beta")), false);
  assert.ok(isLink(join(home, ".claude/skills/alpha")), "alpha's link stays");
});

test("links: per folder, named after the skill's folder, to its real path, the folder made; refused where the name is taken or synced; unlink removes only Backroom's own", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, home } = packsFor();
  const pack = await packs.add(fx.bare);
  assert.deepEqual(
    packs.folders().map((f) => [f.id, f.path, f.readBy]),
    [
      ["claude", join(home, ".claude/skills"), ["Claude", "Cursor", "OpenCode"]],
      ["agents", join(home, ".agents/skills"), ["Codex", "Cursor", "OpenCode", "Pi"]],
      ["grok", join(home, ".grok/skills"), ["Grok"]],
    ],
  );
  const linked = await packs.link("skills-pack", "skills/alpha", "claude");
  const entry = join(home, ".claude/skills/alpha");
  assert.ok(isLink(entry));
  assert.equal(readlinkSync(entry), join(pack.folder, "skills/alpha"), "the skill's folder by its real path");
  assert.match(readFileSync(join(entry, "SKILL.md"), "utf8"), /name: alpha/);
  assert.deepEqual(linked.skills.find((s) => s.path === "skills/alpha")!.linked, ["claude"]);
  await packs.link("skills-pack", "skills/alpha", "claude");
  assert.equal(readlinkSync(entry), join(pack.folder, "skills/alpha"), "linking again changes nothing");

  // beta's folder name is taken in two folders, by a folder and by someone else's link.
  mkdirSync(join(home, ".agents/skills/beta"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/beta/SKILL.md"), "the user's own\n");
  await assert.rejects(packs.link("skills-pack", "skills/beta", "agents"), /\.agents\/skills\/beta is a folder, not Backroom's link to skills-pack's skills\/beta: nothing changed/);
  assert.equal(readFileSync(join(home, ".agents/skills/beta/SKILL.md"), "utf8"), "the user's own\n");
  mkdirSync(join(home, ".grok/skills"), { recursive: true });
  symlinkSync("/somewhere/else", join(home, ".grok/skills/beta"));
  await assert.rejects(packs.link("skills-pack", "skills/beta", "grok"), /is a link to \/somewhere\/else, not Backroom's link/);
  assert.equal(readlinkSync(join(home, ".grok/skills/beta")), "/somewhere/else");
  await assert.rejects(packs.unlink("skills-pack", "skills/beta", "agents"), /is not Backroom's link to skills-pack's skills\/beta: nothing changed/);
  await assert.rejects(packs.unlink("skills-pack", "skills/beta", "grok"), /is not Backroom's link/);
  assert.ok(existsSync(join(home, ".agents/skills/beta/SKILL.md")) && isLink(join(home, ".grok/skills/beta")), "neither touched");
  await assert.rejects(packs.link("skills-pack", "skills/nothing", "claude"), /has no skill at skills\/nothing/);
  await assert.rejects(packs.link("skills-pack", "skills/alpha", "elsewhere"), /no skill folder elsewhere/);

  await packs.unlink("skills-pack", "skills/alpha", "claude");
  assert.equal(isLink(entry), false);
  assert.ok(existsSync(join(pack.folder, "skills/alpha/SKILL.md")), "the skill itself stays");

  // A skill folder named "synced" is Claude's sync's name: never linked, the sync's folder untouched.
  const synced = makePackFixture(dir("up"), "synced-pack");
  synced.commit("skills: one named synced", { files: { "skills/synced/SKILL.md": "---\nname: synced\n---\n" } });
  mkdirSync(join(home, ".claude/skills/synced/dataviz"), { recursive: true });
  await packs.add(synced.bare);
  await assert.rejects(packs.link("synced-pack", "skills/synced", "claude"), /"synced" is Claude's synced skills/);
  await assert.rejects(packs.link("synced-pack", "skills/synced", "agents"), /"synced" is Claude's synced skills/);
  assert.ok(statSync(join(home, ".claude/skills/synced/dataviz")).isDirectory());
});

test("a skill folder that leads out of its pack (a tracked folder swapped for a link by hand) is not offered, so no link reaches elsewhere", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos } = packsFor();
  const pack = await packs.add(fx.bare);
  const elsewhere = dir("elsewhere");
  writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: alpha\n---\n");
  rmSync(join(pack.folder, "skills/alpha"), { recursive: true });
  symlinkSync(elsewhere, join(pack.folder, "skills/alpha"));
  const state = packs.state(repos.getPack("skills-pack")!);
  assert.deepEqual(state.skills.map((s) => s.path), ["skills/beta"]);
  await assert.rejects(packs.link("skills-pack", "skills/alpha", "claude"), /has no skill at skills\/alpha/);
});

test("pstack installed fresh: a whole clone pinned at what it cloned, its two trees each linked only into theirs, nothing linked by itself", async () => {
  const up = makePstackFixture(dir("up"));
  const { packs, repos, skills } = packsFor({ pstack: up.bare });
  assert.equal(repos.getPack(PSTACK_PACK)?.url, up.bare, "ROOMS_PSTACK_REPO stands in for its source");
  await packs.tick();
  const pack = repos.getPack(PSTACK_PACK)!;
  assert.equal(pack.pinned, git(up.work, "rev-parse", "HEAD"));
  const state = packs.state(pack);
  assert.equal(state.folder, join(skills, PSTACK_FOLDER));
  const of = (path: string) => state.skills.find((s) => s.path === path)!;
  assert.deepEqual(of("harness/pstack/claude-code/skills/tdd").folders, ["claude"]);
  assert.deepEqual(of("pstack/skills/tdd").folders, ["agents", "grok"]);
  assert.ok(state.skills.every((s) => s.linked.length === 0), "nothing linked by discovery");
  await assert.rejects(packs.link(PSTACK_PACK, "harness/pstack/claude-code/skills/tdd", "agents"), /goes only to .*\.claude\/skills/);
  await assert.rejects(packs.link(PSTACK_PACK, "pstack/skills/tdd", "claude"), /goes only to .*\.agents\/skills and .*\.grok\/skills/);
  await packs.link(PSTACK_PACK, "harness/pstack/claude-code/skills/tdd", "claude");
  await packs.link(PSTACK_PACK, "pstack/skills/tdd", "agents");
  // The two trees' tdd share a name: the second in the same folder would be refused, so each keeps to its own folder.
  assert.deepEqual([of("harness/pstack/claude-code/skills/tdd").path, packs.state(repos.getPack(PSTACK_PACK)!).skills.filter((s) => s.linked.length > 0).map((s) => [s.path, s.linked])], [
    "harness/pstack/claude-code/skills/tdd",
    [
      ["harness/pstack/claude-code/skills/tdd", ["claude"]],
      ["pstack/skills/tdd", ["agents"]],
    ],
  ]);
  assert.deepEqual(state.presets.map((p) => p.label), ["Principles and reply rules", "The whole mode"]);
});

test("pstack seeded from the clone Poteto mode made: taken as it is, no new clone, pinned at its checkout; its line as the agents file had it; its diffs keep to its sparse paths", async () => {
  const up = makePstackFixture(dir("up"));
  const dataDir = dir("data");
  const folder = join(realpathSync(dataDir), SKILLS_FOLDER, PSTACK_FOLDER);
  mkdirSync(join(folder, ".."), { recursive: true });
  // As Poteto mode cloned it: sparse to its two trees, blobs fetched as needed, on main.
  git(join(folder, ".."), "clone", "--quiet", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", "main", "--", up.bare, folder);
  git(folder, "sparse-checkout", "set", "--cone", "pstack", "harness/pstack");
  git(folder, "checkout", "--quiet", "main");
  writeFileSync(join(folder, "kept-by-hand.txt"), "proof it was not cloned again\n");
  const inode = statSync(join(folder, ".git")).ino;
  const { packs, repos } = packsFor({ dataDir, pstack: up.bare });
  assert.equal(repos.getPack(PSTACK_PACK)!.pinned, null, "no pin before it is looked at");
  assert.deepEqual(packs.agentsLines(), [`- ${POTETO_WORDS.principles.text.split("{folder}").join(folder)}`], "pointed at as it was, before the first look");
  await packs.tick();
  const pack = repos.getPack(PSTACK_PACK)!;
  assert.equal(pack.pinned, git(folder, "rev-parse", "HEAD"), "pinned at its checkout");
  assert.equal(statSync(join(folder, ".git")).ino, inode, "the same clone");
  assert.ok(existsSync(join(folder, "kept-by-hand.txt")));
  assert.equal(existsSync(join(folder, "other-plugin")), false, "still sparse");
  assert.deepEqual(
    packs.agentsLines(),
    [
      `- Follow poteto-mode's principles, reply and comment rules at ${folder}/pstack/skills/poteto-mode/SKILL.md (Claude Code: the copy at ${folder}/harness/pstack/claude-code/skills/poteto-mode/SKILL.md); skip setup-pstack. Its triggers and playbooks apply only when your assignment names them: no how, architect, arena, interrogate or swarm fan-out, no mandatory subagent delegation, no data-shape-first or lever-building rule, no plan template and no pull request otherwise. Where the mode conflicts with this file, this file wins.`,
    ],
    "Poteto mode's principles line, word for word",
  );
  assert.deepEqual(packs.state(pack).skills.map((s) => s.path).filter((p) => p.startsWith("other")), [], "a sparse clone's skills are those it holds");
  const next = up.commit("pstack and another plugin", { files: { "pstack/skills/tdd/SKILL.md": "---\nname: tdd\ndescription: newer\n---\n", "other-plugin/README.md": "changed\n" } });
  await packs.checkNow(PSTACK_PACK);
  const detail = await packs.updateDetail(PSTACK_PACK, next);
  assert.deepEqual(detail.files, [{ status: "M", path: "pstack/skills/tdd/SKILL.md" }], "only what the clone keeps");
  await packs.setStanding(PSTACK_PACK, POTETO_WORDS.full.text);
  assert.deepEqual(packs.agentsLines(), [`- For any non-trivial job, read and follow poteto-mode at ${folder}/pstack/skills/poteto-mode/SKILL.md (Claude Code: the copy at ${folder}/harness/pstack/claude-code/skills/poteto-mode/SKILL.md); skip setup-pstack. Where the mode conflicts with this file, this file wins.`]);
  await packs.setStanding(PSTACK_PACK, null);
  assert.deepEqual(packs.agentsLines(), [], "no standing line: no line");
});

test("pstack seeded with Poteto mode's pin (a tag): the tag resolved to its commit, which stays checked out", async () => {
  const up = makePstackFixture(dir("up"));
  const first = git(up.work, "rev-parse", "HEAD");
  git(up.work, "tag", "v1", first);
  git(up.work, "push", "-q", up.bare, "v1");
  up.commit("pstack: newer", { version: "0.16.0" });
  const dataDir = dir("data");
  const folder = join(realpathSync(dataDir), SKILLS_FOLDER, PSTACK_FOLDER);
  mkdirSync(join(folder, ".."), { recursive: true });
  git(join(folder, ".."), "clone", "--quiet", "--", up.bare, folder);
  git(folder, "checkout", "--quiet", "--detach", "v1");
  const { packs, repos } = packsFor({ dataDir, pstack: up.bare });
  repos.savePack({ ...repos.getPack(PSTACK_PACK)!, pinned: "v1" });
  await packs.tick();
  assert.equal(repos.getPack(PSTACK_PACK)!.pinned, first);
  assert.equal(git(folder, "rev-parse", "HEAD"), first);
});

test("Remove: Backroom's links to the pack out first, then its folder and row; refused with nothing changed for a folder that is a link or whose repository is elsewhere", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs, repos, home, skills, dataDir } = packsFor();
  const pack = await packs.add(fx.bare);
  await packs.link("skills-pack", "skills/alpha", "claude");
  await packs.link("skills-pack", "skills/beta", "agents");
  symlinkSync("/the/users/own", join(home, ".claude/skills/mine"));
  const { unlinked } = await packs.remove("skills-pack");
  assert.deepEqual(unlinked.sort(), [`${join(home, ".agents/skills")}/beta`, `${join(home, ".claude/skills")}/alpha`]);
  assert.equal(existsSync(pack.folder), false);
  assert.equal(repos.getPack("skills-pack"), null);
  assert.equal(readlinkSync(join(home, ".claude/skills/mine")), "/the/users/own", "a link not to the pack stays");

  // A pack folder that is a link: refused, the links and the folder it leads to kept.
  const again = await packs.add(fx.bare);
  await packs.link("skills-pack", "skills/alpha", "claude");
  renameSync(again.folder, `${again.folder}.real`);
  symlinkSync(`${again.folder}.real`, again.folder);
  await assert.rejects(packs.remove("skills-pack"), /skills-pack is not removed: .* is a link: Backroom keeps packs only in folders of its own/);
  assert.ok(existsSync(join(`${again.folder}.real`, ".git")));
  assert.ok(isLink(join(home, ".claude/skills/alpha")), "its link kept");
  assert.ok(repos.getPack("skills-pack"));
  rmSync(again.folder);
  renameSync(`${again.folder}.real`, again.folder);

  // A .git that is a file: its repository elsewhere.
  repos.savePack({ name: "elsewhere", url: "/x", folder: "elsewhere", pinned: null, standing: null, checkedAt: null, error: null, createdAt: new Date().toISOString() });
  mkdirSync(join(skills, "elsewhere"));
  writeFileSync(join(skills, "elsewhere", ".git"), "gitdir: /somewhere/else\n");
  await assert.rejects(packs.remove("elsewhere"), /\.git is a file: its repository is elsewhere/);
  assert.ok(existsSync(join(skills, "elsewhere", ".git")));

  // An empty .git inside the data folder's own repository: git's top level is the enclosing one.
  execFileSync("git", ["init", "-q", realpathSync(dataDir)]);
  repos.savePack({ name: "nested", url: "/x", folder: "nested", pinned: null, standing: null, checkedAt: null, error: null, createdAt: new Date().toISOString() });
  mkdirSync(join(skills, "nested", ".git"), { recursive: true });
  writeFileSync(join(skills, "nested", "keep.txt"), "kept\n");
  await assert.rejects(packs.remove("nested"), /git's top level in .*nested is .*, not the folder itself|git cannot read/);
  assert.equal(readFileSync(join(skills, "nested", "keep.txt"), "utf8"), "kept\n");
  assert.ok(repos.getPack("nested"));
});

test("while Take update's checkout runs, the agents file and the briefing read each pack as it was before it moved anything (git moves HEAD last)", async () => {
  const fx = makePackFixture(dir("up"));
  const { packs } = packsFor();
  const pack = await packs.add(fx.bare);
  packs.setStanding("skills-pack", "Use the skills at {folder}.");
  const before = packs.standing();
  assert.equal(before[0]!.commit, pack.pinned!.slice(0, 7));
  const entered = join(scratch, `entered-${++dirs}`);
  const release = join(scratch, `release-${dirs}`);
  const filter = join(scratch, `filter-${dirs}.sh`);
  writeFileSync(filter, `#!/bin/sh\n: > '${entered}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\ncat\n`, { mode: 0o755 });
  // Git's real checkout paused at a file the update changes, before HEAD moves.
  writeFileSync(join(pack.folder, ".git/info/attributes"), "skills/beta/SKILL.md filter=review\n");
  git(pack.folder, "config", "filter.review.smudge", filter);
  git(pack.folder, "config", "filter.review.clean", "cat");
  const next = fx.commit("beta changes", { files: { "skills/beta/SKILL.md": "---\nname: beta-skill\ndescription: changed\n---\n" } });
  await packs.checkNow("skills-pack");
  const taking = packs.takeUpdate("skills-pack", next);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(entered) && Date.now() < deadline) await sleep(10);
    assert.ok(existsSync(entered), "git reached the paused checkout");
    assert.deepEqual(packs.standing(), before, "the pack as it was before the move");
    assert.equal(packs.state(packs.list()[0]!).busy, true);
  } finally {
    writeFileSync(release, "go\n");
    await taking;
  }
  assert.equal(packs.standing()[0]!.commit, next.slice(0, 7), "and as it is once it has moved");
});

test("the migration: pstack's row from Poteto mode's keys (Off, Principles, the whole mode, a pin), the old keys gone for good, a saved template's {poteto} now {skills}", () => {
  const cases: Array<[Record<string, string>, string | null]> = [
    [{}, POTETO_WORDS.principles.text],
    [{ "poteto.enabled": "off" }, null],
    [{ "poteto.scope": "full" }, POTETO_WORDS.full.text],
    [{ "poteto.enabled": "off", "poteto.scope": "full" }, null],
    [{ "poteto.pin": "v0.15.0" }, POTETO_WORDS.principles.text],
  ];
  for (const [keys, standing] of cases) {
    const path = join(dir("db"), "rooms.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.slice(0, -1).forEach((sql, index) => {
      raw.exec(sql);
      raw.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(index + 1, "2026-11-01T00:00:00Z");
    });
    for (const [key, value] of Object.entries({ ...keys, "poteto.pack": '{"checkedAt":"2026-11-03T03:49:28.504Z"}', "agentsFile.text": "# mine\n{poteto}\nmore" })) raw.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(key, value);
    raw.close();
    for (let open = 0; open < 2; open += 1) {
      const db = new Database(path);
      const repos = new Repos(db);
      const packs = repos.listPacks();
      assert.equal(packs.length, 1, `one row (open ${open})`);
      assert.deepEqual([packs[0]!.name, packs[0]!.url, packs[0]!.folder, packs[0]!.pinned, packs[0]!.standing], [PSTACK_PACK, PSTACK_REPO, PSTACK_FOLDER, keys["poteto.pin"] ?? null, standing], JSON.stringify(keys));
      assert.deepEqual([...repos.listKv("poteto.").keys()], [], "the old keys gone, and not made again by a restart");
      assert.equal(repos.getKv("agentsFile.text"), "# mine\n{skills}\nmore");
      db.close();
    }
  }
});

test("{skills}: one line per pack with a standing line, the line going when there is none; the default template holds it once", () => {
  assert.equal(renderAgentsText("a\n{skills}\nb", [], []), "a\nb\n");
  assert.equal(renderAgentsText("a\n{skills}\nb", [], ["- one", "- two"]), "a\n- one\n- two\nb\n");
  assert.equal(renderAgentsText("no placeholder", [], ["- one"]), "no placeholder\n", "a template without it gets none");
  assert.equal(DEFAULT_AGENTS_TEMPLATE.split("\n").filter((line) => line === SKILLS_PLACEHOLDER).length, 1);
  assert.equal(DEFAULT_AGENTS_TEMPLATE.includes("{poteto}"), false);
});

function stackFor(t: TestContext, options: { agentsFile?: boolean; packs?: boolean } = {}) {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const dataDir = dir("data");
  const home = dir("home");
  const stack = createStack({ dbPath: ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: options.agentsFile ?? false, packs: options.packs === false ? null : { dataDir, home, clock: fakeClock() } });
  stack.repos.deletePack(PSTACK_PACK);
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dataDir, ROOMS_PORT: "0" }), "/nonexistent/dist");
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command)) as Promise<any>;
  const post = async (command: unknown) => {
    const response = await app.request("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const get = async (path: string) => {
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as any };
  };
  return { stack, fake, app, run, post, get, dataDir, home };
}

test("the routes: GET /api/skills with the roster, folders and packs; the pack and skill commands through /api/commands, refused where they cannot run", async (t) => {
  const fx = makePackFixture(dir("up"));
  const s = stackFor(t);
  const added = await s.post({ type: "pack.add", url: fx.bare });
  assert.equal(added.status, 200);
  assert.equal(added.body.type, "pack.updated");
  assert.equal(added.body.pack.name, "skills-pack");
  const linked = await s.post({ type: "skill.link", pack: "skills-pack", path: "skills/alpha", folder: "agents" });
  assert.deepEqual(linked.body.pack.skills.find((x: { path: string }) => x.path === "skills/alpha").linked, ["agents"]);
  const listed = await s.get("/api/skills");
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body).sort(), ["folders", "packs", "rows", "t3Error"]);
  assert.equal(listed.body.t3Error, null);
  assert.deepEqual(listed.body.folders.map((f: { id: string }) => f.id), ["claude", "agents", "grok"]);
  assert.deepEqual(listed.body.packs.map((p: { name: string }) => p.name), ["skills-pack"]);
  assert.ok(listed.body.rows.some((row: { kind: string; name: string }) => row.kind === "pack" && row.name === "alpha"), "a linked pack skill is a roster row");
  assert.equal(listed.body.rows.some((row: { name: string }) => row.name === "beta-skill"), false, "one not linked is not");
  const next = fx.commit("alpha changes", { files: { "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Newer.\n---\n" } });
  await s.post({ type: "pack.check", name: "skills-pack" });
  const detail = await s.get(`/api/skills/packs/skills-pack/update?commit=${next}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.descriptions, [{ path: "skills/alpha/SKILL.md", before: "Use alpha for the first kind of job.", after: "Newer." }]);
  assert.equal((await s.get("/api/skills/packs/skills-pack/update?commit=HEAD")).status, 400);
  assert.equal((await s.post({ type: "pack.update.take", name: "skills-pack", commit: "HEAD" })).status, 400, "a commit is a full id");
  assert.equal((await s.post({ type: "pack.update.take", name: "skills-pack", commit: next })).body.pack.pinned, next);
  const standing = await s.post({ type: "pack.standing.set", name: "skills-pack", text: "  Read {folder}/README.md.  " });
  assert.equal(standing.body.pack.standing, "Read {folder}/README.md.");
  assert.equal((await s.post({ type: "pack.standing.set", name: "skills-pack", text: "" })).status, 400, "none is null, not empty");
  const refused = await s.post({ type: "skill.link", pack: "skills-pack", path: "skills/alpha", folder: "claude" });
  assert.equal(refused.status, 200, "a second folder is fine");
  mkdirSync(join(s.home, ".grok/skills/alpha"), { recursive: true });
  const taken = await s.post({ type: "skill.link", pack: "skills-pack", path: "skills/alpha", folder: "grok" });
  assert.equal(taken.status, 409);
  assert.match(taken.body.message, /is a folder, not Backroom's link/);
  assert.equal((await s.post({ type: "pack.remove", name: "nothing" })).status, 404);
  const removed = await s.post({ type: "pack.remove", name: "skills-pack" });
  assert.deepEqual([removed.body.pack, removed.body.unlinked.length], [null, 2]);

  // A service that keeps no packs: an empty list, and the commands refused.
  const none = stackFor(t, { packs: false });
  assert.deepEqual((await none.get("/api/skills")).body.packs, []);
  assert.equal((await none.post({ type: "pack.add", url: fx.bare })).status, 409);
});
