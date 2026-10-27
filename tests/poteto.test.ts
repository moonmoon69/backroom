/**
 * Poteto mode (src/app/poteto.ts): pstack cloned sparse into the data folder from a local bare repository (never the
 * network), fast-forwarded once a day and on Update now, kept at a pin, refused where the folder is not Backroom's own,
 * off by the setting; the agents file's {poteto} line (src/app/agentsFile.ts); the briefing's Skills section per harness
 * and its retraction (src/briefing/assemble.ts); the settings route and the three commands.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { DEFAULT_AGENTS_TEMPLATE, POTETO_PLACEHOLDER, STALE, defaultAgentsText, renderAgentsText } from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";
import {
  CLONE_FOLDER,
  DAY_MS,
  POTETO_PIN_KEY,
  POTETO_RECORD_KEY,
  POTETO_SETTING_KEY,
  PSTACK_REPO,
  PotetoPack,
  SKILLS_FOLDER,
  TICK_MS,
  potetoLine,
  type PotetoClock,
  type PotetoState as ServerState,
} from "../src/app/poteto.ts";
import type { CommandResult as ServerResult } from "../src/app/service.ts";
import { SKILLS_OFF, briefingHeader, changedStanding, heldStanding, skillsHarness, skillsSection, standingFingerprint, standingText, type SkillsBriefing, type StandingInput } from "../src/briefing/assemble.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import type { Participant, Room } from "../src/domain/types.ts";
import { createHttpApp } from "../src/server/http.ts";
import type * as Web from "../web/src/types.ts";
import { FIXTURE_SKILLS, makePstackFixture, type PstackFixture } from "../scripts/pstack-fixture.ts";
import { potetoStatus } from "../web/src/potetoStatus.ts";

// The web keeps hand copies of the state and the commands: `npm run typecheck` fails when they drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Array<true> = [
  true satisfies Same<Web.PotetoState, ServerState>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "poteto.enabled.set" }>, Extract<RoomCommandInput, { type: "poteto.enabled.set" }>>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "poteto.update" }>, Extract<RoomCommandInput, { type: "poteto.update" }>>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "poteto.pin.set" }>, Extract<RoomCommandInput, { type: "poteto.pin.set" }>>,
  true satisfies Same<Extract<Web.CommandResult, { type: "poteto.updated" }>, Extract<ServerResult, { type: "poteto.updated" }>>,
];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backroom-poteto-")));
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
const upstream = (version = "0.15.0"): PstackFixture => makePstackFixture(dir("upstream"), version);

type FakeClock = PotetoClock & { t: number; timers: Map<number, { fn: () => void; ms: number }>; advance(ms: number): void };
function fakeClock(): FakeClock {
  let id = 0;
  return {
    t: Date.parse("2026-10-27T08:00:00Z"),
    timers: new Map(),
    now() {
      return this.t;
    },
    setInterval(fn, ms) {
      this.timers.set(++id, { fn, ms });
      return id;
    },
    clearInterval(handle) {
      this.timers.delete(handle as number);
    },
    advance(ms) {
      this.t += ms;
    },
  };
}

function memoryKv() {
  const kv = new Map<string, string>();
  return { kv, getKv: (key: string) => kv.get(key) ?? null, setKv: (key: string, value: string) => void kv.set(key, value), deleteKv: (key: string) => void kv.delete(key) };
}

function packFor(source: string, options: { dataDir?: string; clock?: FakeClock } = {}) {
  const repos = memoryKv();
  const dataDir = options.dataDir ?? dir("data");
  const clock = options.clock ?? fakeClock();
  const logs: string[] = [];
  const pack = new PotetoPack(repos, { dataDir, source, clock, log: (message) => logs.push(message) });
  const folder = join(realpathSync(dataDir), SKILLS_FOLDER, CLONE_FOLDER);
  const record = () => JSON.parse(repos.getKv(POTETO_RECORD_KEY) ?? "{}") as { checkedAt?: string; commit?: string };
  return { pack, repos, dataDir, clock, folder, record, logs };
}

const versionIn = (folder: string) => (JSON.parse(readFileSync(join(folder, "pstack/plugin.json"), "utf8")) as { version: string }).version;

test("the web's copies of Poteto mode's state, commands and result match the server's (checked by npm run typecheck)", () => {
  assert.equal(same.length, 5);
});

// ---------------- the pack ----------------

test("the clone: sparse to pstack/ and harness/pstack/ on main, from ROOMS_PSTACK_REPO, under the data folder's real path, renamed into place", async () => {
  const up = upstream("0.15.0");
  const real = dir("real-data");
  const linked = join(scratch, `data-link-${++dirs}`);
  symlinkSync(real, linked);
  const { pack, folder, record } = packFor(up.bare, { dataDir: linked });
  assert.equal(folder, join(real, SKILLS_FOLDER, CLONE_FOLDER), "from the configured data folder's real path");
  assert.equal(pack.state().ready, false);
  assert.equal(pack.pointerLine(), null, "nothing pointed at before the clone");
  const state = await pack.update();
  assert.equal(state.ready, true);
  assert.equal(state.error, null);
  assert.equal(state.version, "0.15.0");
  assert.equal(state.commit, git(up.work, "rev-parse", "HEAD"));
  assert.equal(state.lastChange, `${git(up.work, "rev-parse", "--short", "HEAD")} pstack: first commit`);
  assert.equal(state.checkedAt, "2026-10-27T08:00:00.000Z");
  assert.equal(state.folder, folder);
  assert.equal(state.source, up.bare);
  for (const path of ["pstack/plugin.json", "pstack/skills/poteto-mode/SKILL.md", "harness/pstack/claude-code/skills/poteto-mode/SKILL.md", "pstack/docs/harness/claude-code.md"]) assert.ok(existsSync(join(folder, path)), path);
  for (const path of ["other-plugin", "harness/other"]) assert.equal(existsSync(join(folder, path)), false, `${path} left out by the sparse checkout`);
  assert.equal(git(folder, "branch", "--show-current"), "main");
  assert.equal(git(folder, "remote", "get-url", "origin"), up.bare);
  assert.deepEqual(readdirSync(join(real, SKILLS_FOLDER)), [CLONE_FOLDER], "no temporary folder left beside it");
  assert.equal(readFileSync(join(folder, "pstack/skills/poteto-mode/SKILL.md"), "utf8"), readFileSync(join(up.work, "pstack/skills/poteto-mode/SKILL.md"), "utf8"), "pstack as it is");
  assert.deepEqual(pack.briefing(), { clone: folder, version: "0.15.0", commit: state.commit!.slice(0, 7), names: FIXTURE_SKILLS });
  assert.equal(pack.pointerLine(), potetoLine(folder));
  assert.equal(record().commit, undefined, "kv keeps no commit: git says it");
  // A new pack over the same data, with nothing in kv, reads the clone as ready from the start, its commit from git.
  const again = new PotetoPack({ getKv: () => null, setKv: () => {}, deleteKv: () => {} }, { dataDir: linked, source: up.bare });
  assert.deepEqual(again.briefing(), pack.briefing());
});

test("ROOMS_PSTACK_REPO: GitHub's cursor/plugins by default, a URL as it is, a local path from the service's folder", () => {
  assert.equal(loadConfig({}).pstackRepo, PSTACK_REPO);
  assert.equal(PSTACK_REPO, "https://github.com/cursor/plugins");
  assert.equal(loadConfig({ ROOMS_PSTACK_REPO: "https://example.com/plugins.git" }).pstackRepo, "https://example.com/plugins.git");
  assert.equal(loadConfig({ ROOMS_PSTACK_REPO: "git@example.com:plugins.git" }).pstackRepo, "git@example.com:plugins.git");
  assert.equal(loadConfig({ ROOMS_PSTACK_REPO: "fixtures/plugins.git" }).pstackRepo, join(process.cwd(), "fixtures/plugins.git"));
});

test("a clone that validates nothing is never put in place: no plugin.json, or poteto-mode missing from either tree", async () => {
  for (const missing of ["pstack/plugin.json", "pstack/skills/poteto-mode/SKILL.md", "harness/pstack/claude-code/skills/poteto-mode/SKILL.md"]) {
    const up = upstream();
    rmSync(join(up.work, missing));
    up.commit(`remove ${missing}`);
    const { pack, folder, dataDir } = packFor(up.bare);
    const state = await pack.update();
    assert.equal(state.ready, false, missing);
    assert.equal(state.error?.during, "clone");
    assert.match(state.error!.reason, new RegExp(missing.replace(/[/.]/g, "\\$&")));
    assert.equal(existsSync(folder), false, "nothing renamed into place");
    assert.deepEqual(readdirSync(join(dataDir, SKILLS_FOLDER)), [], "the temporary folder removed");
  }
});

test("Update now and the daily update fast-forward to origin's main; the last change is git's one-line log", async () => {
  const up = upstream("0.15.0");
  const { pack, folder } = packFor(up.bare);
  await pack.update();
  const next = up.commit("pstack: teach tdd to wait", { version: "0.15.1", files: { "pstack/skills/tdd/SKILL.md": "# tdd, newer\n" } });
  const state = await pack.update();
  assert.equal(state.error, null);
  assert.equal(state.version, "0.15.1");
  assert.equal(state.commit, next);
  assert.equal(state.lastChange, `${next.slice(0, 7)} pstack: teach tdd to wait`);
  assert.equal(readFileSync(join(folder, "pstack/skills/tdd/SKILL.md"), "utf8"), "# tdd, newer\n");
  assert.equal(pack.briefing()?.commit, next.slice(0, 7), "the briefing's revision follows");
  // A commit outside pstack is fetched and fast-forwarded, and is not pstack's last change.
  const outside = up.commit("other plugin", { files: { "other-plugin/README.md": "changed\n" } });
  const after = await pack.update();
  assert.equal(after.commit, outside);
  assert.equal(after.lastChange, `${next.slice(0, 7)} pstack: teach tdd to wait`);
});

test("a failed fetch is recorded with its reason, the clone stays usable, and the next attempt recovers", async () => {
  const up = upstream("0.15.0");
  const { pack, clock } = packFor(up.bare);
  await pack.update();
  up.commit("newer", { version: "0.16.0" });
  renameSync(up.bare, `${up.bare}.away`);
  clock.advance(1000);
  const failed = await pack.update();
  assert.equal(failed.error?.during, "update");
  assert.match(failed.error!.reason, /^could not fetch from /);
  assert.equal(failed.error!.at, new Date(clock.t).toISOString());
  assert.equal(failed.ready, true, "still pointed at");
  assert.equal(failed.version, "0.15.0");
  assert.equal(pack.pointerLine() !== null, true);
  renameSync(`${up.bare}.away`, up.bare);
  // The hourly look tries again at once after a failure, not a day later.
  clock.advance(TICK_MS);
  await pack.tick();
  assert.equal(pack.state().error, null);
  assert.equal(pack.state().version, "0.16.0");
});

test("a failed clone (the source unreachable) leaves nothing, is shown, and the next look clones", async () => {
  const up = upstream("0.15.0");
  renameSync(up.bare, `${up.bare}.away`);
  const { pack, folder, dataDir } = packFor(up.bare);
  await pack.prepare();
  const state = pack.state();
  assert.equal(state.ready, false);
  assert.equal(state.error?.during, "clone");
  assert.ok(state.error!.reason.length > 0);
  assert.equal(existsSync(folder), false);
  assert.deepEqual(readdirSync(join(dataDir, SKILLS_FOLDER)), []);
  renameSync(`${up.bare}.away`, up.bare);
  await pack.tick();
  assert.equal(pack.state().ready, true);
  assert.equal(pack.state().error, null);
});

test("the timer: an hourly look started with one at once, a fetch only once a day, stopped on shutdown", async () => {
  const up = upstream("0.15.0");
  const { pack, clock, record } = packFor(up.bare);
  pack.start();
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.ms), [TICK_MS]);
  pack.start();
  assert.equal(clock.timers.size, 1, "started once");
  await pack.prepare();
  assert.equal(pack.state().ready, true, "the look at start cloned it");
  const first = record().checkedAt;
  up.commit("newer", { version: "0.15.1" });
  clock.advance(DAY_MS - TICK_MS);
  await pack.tick();
  assert.equal(record().checkedAt, first, "23 hours on: no check");
  assert.equal(pack.state().version, "0.15.0");
  clock.advance(TICK_MS);
  const [timer] = [...clock.timers.values()];
  timer!.fn();
  await pack.update().then(() => undefined); // waits for the timer's update, queued before it
  assert.equal(pack.state().version, "0.15.1", "a day on: fetched and fast-forwarded");
  pack.stop();
  assert.equal(clock.timers.size, 0, "stopped");
});

test("off: nothing is cloned or fetched by the look at start, the timer, the settings or Update now; the clone stays", async () => {
  const up = upstream("0.15.0");
  const { pack, repos, folder, clock, record } = packFor(up.bare);
  repos.setKv(POTETO_SETTING_KEY, "off");
  pack.start();
  const preparing = pack.prepare();
  assert.equal(pack.state().busy, false, "nothing even queued");
  await preparing;
  await pack.tick();
  assert.equal(existsSync(folder), false, "no clone while off");
  assert.equal(pack.state().checkedAt, null, "not even an attempt");
  assert.equal((await pack.update()).checkedAt, null);
  pack.stop();
  repos.deleteKv(POTETO_SETTING_KEY);
  await pack.update();
  const checked = record().checkedAt;
  repos.setKv(POTETO_SETTING_KEY, "off");
  up.commit("newer", { version: "0.16.0" });
  clock.advance(3 * DAY_MS);
  await pack.tick();
  await pack.update();
  assert.equal(record().checkedAt, checked, "no attempt while off");
  assert.equal(versionIn(folder), "0.15.0");
  assert.ok(existsSync(folder), "the clone stays");
  assert.equal(pack.pointerLine(), null, "and nothing points at it");
  assert.equal(pack.briefing(), null);
  assert.equal(pack.state().ready, true, "ready all the same, for when it is on again");
});

test("a pin: updates fetch and keep it checked out, through the daily tick; Follow latest fast-forwards; an older pin rolls back", async () => {
  const up = upstream("0.15.0");
  const { pack, repos, folder, clock } = packFor(up.bare);
  await pack.update();
  const first = git(folder, "rev-parse", "HEAD");
  repos.setKv(POTETO_PIN_KEY, first);
  const second = up.commit("newer", { version: "0.16.0" });
  clock.advance(DAY_MS);
  await pack.tick();
  let state = pack.state();
  assert.equal(git(folder, "rev-parse", "HEAD"), first, "the pin survives the daily tick");
  assert.equal(state.version, "0.15.0");
  assert.equal(state.pinned, `pinned at ${first}, latest is ${second.slice(0, 7)}`);
  assert.equal(state.error, null);
  repos.deleteKv(POTETO_PIN_KEY);
  state = await pack.update();
  assert.equal(state.commit, second);
  assert.equal(state.pinned, null);
  assert.equal(git(folder, "branch", "--show-current"), "main", "back on main");
  // Roll back: pin the older commit; a tag pins too.
  repos.setKv(POTETO_PIN_KEY, first.slice(0, 10));
  assert.equal((await pack.update()).commit, first);
  git(up.work, "tag", "v0.16.0", second);
  git(up.work, "push", "-q", up.bare, "v0.16.0");
  repos.setKv(POTETO_PIN_KEY, "v0.16.0");
  assert.equal((await pack.update()).commit, second);
  repos.setKv(POTETO_PIN_KEY, "no-such-tag");
  state = await pack.update();
  assert.match(state.error!.reason, /the pin no-such-tag is not in /);
  assert.equal(state.commit, second, "nothing moved");
});

test("local changes in the clone stop any move: recorded, nothing overwritten; a diverged main is refused the same way", async () => {
  const up = upstream("0.15.0");
  const { pack, folder } = packFor(up.bare);
  await pack.update();
  const skill = join(folder, "pstack/skills/how/SKILL.md");
  writeFileSync(skill, "my own edit\n");
  up.commit("newer", { version: "0.16.0", files: { "pstack/skills/how/SKILL.md": "upstream's\n" } });
  let state = await pack.update();
  assert.equal(state.error?.reason, `local changes in ${folder}: Backroom moves nothing while they are there`);
  assert.equal(readFileSync(skill, "utf8"), "my own edit\n");
  assert.equal(versionIn(folder), "0.15.0");
  // Committed in the clone: main diverges from origin's, and the fast-forward refuses.
  git(folder, "-c", "user.name=U", "-c", "user.email=u@example.com", "commit", "-q", "-am", "mine");
  const mine = git(folder, "rev-parse", "HEAD");
  state = await pack.update();
  assert.ok(state.error, "refused");
  assert.equal(git(folder, "rev-parse", "HEAD"), mine, "the local commit kept");
});

test("containment: a link on the way, a .git file, a folder that is no clone, an enclosing repository: refused, nothing touched", async () => {
  const up = upstream();
  // skills/ is a link to a folder elsewhere.
  {
    const data = dir("data");
    const elsewhere = dir("elsewhere");
    writeFileSync(join(elsewhere, "sentinel"), "keep\n");
    symlinkSync(elsewhere, join(data, SKILLS_FOLDER));
    const { pack } = packFor(up.bare, { dataDir: data });
    const state = await pack.update();
    assert.equal(state.error?.reason, `${join(data, SKILLS_FOLDER)} is a link: Backroom keeps pstack only in a folder of its own`);
    assert.deepEqual(readdirSync(elsewhere), ["sentinel"]);
  }
  // The clone folder itself is a link.
  {
    const data = dir("data");
    const elsewhere = dir("elsewhere");
    mkdirSync(join(data, SKILLS_FOLDER));
    symlinkSync(elsewhere, join(data, SKILLS_FOLDER, CLONE_FOLDER));
    const { pack, folder } = packFor(up.bare, { dataDir: data });
    assert.equal((await pack.update()).error?.reason, `${folder} is a link: Backroom keeps pstack only in a folder of its own`);
    assert.deepEqual(readdirSync(elsewhere), []);
  }
  // A clone whose .git is a file (its repository elsewhere), once ready: refused, and no longer pointed at.
  {
    const { pack, folder } = packFor(up.bare);
    await pack.update();
    assert.ok(pack.pointerLine());
    const gitDir = join(scratch, `moved-git-${++dirs}`);
    renameSync(join(folder, ".git"), gitDir);
    writeFileSync(join(folder, ".git"), `gitdir: ${gitDir}\n`);
    const state = await pack.update();
    assert.equal(state.error?.reason, `${folder}/.git is a file: its repository is elsewhere`);
    assert.equal(pack.pointerLine(), null);
    assert.equal(readFileSync(join(folder, ".git"), "utf8"), `gitdir: ${gitDir}\n`, "left as it is");
  }
  // A ready clone inside a repository whose own .git is emptied: its files still validate, but git's top level is the
  // repository above: refused, and no longer pointed at (readiness keeps the refusal until the next look).
  {
    const outer = dir("outer");
    execFileSync("git", ["init", "-q", outer]);
    mkdirSync(join(outer, "data"), { recursive: true });
    const { pack, folder } = packFor(up.bare, { dataDir: join(outer, "data") });
    await pack.update();
    assert.ok(pack.pointerLine());
    rmSync(join(folder, ".git"), { recursive: true, force: true });
    mkdirSync(join(folder, ".git"));
    const state = await pack.update();
    assert.equal(state.error?.reason, `git's top level in ${folder} is ${outer}, not the folder itself`);
    assert.equal(pack.pointerLine(), null);
    assert.equal(pack.briefing(), null);
    assert.ok(existsSync(join(folder, "pstack/skills/poteto-mode/SKILL.md")), "left as it is");
  }
  // A folder there that is no git clone (the data folder is inside Backroom's own checkout).
  {
    const data = dir("data");
    const folder = join(data, SKILLS_FOLDER, CLONE_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "mine.txt"), "keep\n");
    const { pack } = packFor(up.bare, { dataDir: data });
    assert.equal((await pack.update()).error?.reason, `${folder} is there but is no git clone; Backroom leaves it as it is`);
    assert.deepEqual(readdirSync(folder), ["mine.txt"]);
  }
  // An enclosing repository: the folder's .git is an empty folder, so git's top level is the repository above.
  {
    const outer = dir("outer");
    execFileSync("git", ["init", "-q", outer]);
    const folder = join(outer, "data", SKILLS_FOLDER, CLONE_FOLDER);
    mkdirSync(join(folder, ".git"), { recursive: true });
    const { pack } = packFor(up.bare, { dataDir: join(outer, "data") });
    assert.equal((await pack.update()).error?.reason, `git's top level in ${folder} is ${outer}, not the folder itself`);
    assert.deepEqual(readdirSync(folder), [".git"]);
  }
});

test("one at a time: overlapping prepares, the timer and Update now clone once; nothing is pointed at until it validates", async () => {
  const up = upstream("0.15.0");
  const { pack, logs } = packFor(up.bare);
  const all = [pack.prepare(), pack.prepare(), pack.tick(), pack.update()];
  assert.equal(pack.state().busy, true);
  assert.equal(pack.pointerLine(), null, "not before the clone validates");
  assert.equal(pack.briefing(), null);
  await Promise.all(all);
  const state = pack.state();
  assert.equal(state.busy, false);
  assert.equal(state.ready, true);
  assert.equal(state.error, null, "the later ones found it ready: no second clone into a folder already there");
  assert.deepEqual(logs.filter((line) => line.startsWith("poteto mode: pstack cloned")).length, 1, "cloned once");
  assert.deepEqual(logs.filter((line) => line.includes("failed")), []);
});

test("the README's git procedures, through the daily tick: an older commit found with git log and pinned through the commands route stays; a hand checkout without a pin is moved back; checkout -- . clears local changes", async (t) => {
  const up = upstream("0.15.0");
  const s = stackFor(t, up.bare);
  const pack = s.stack.poteto!;
  await pack.update();
  up.commit("pstack: second", { version: "0.15.1" });
  up.commit("pstack: third", { version: "0.15.2" });
  await pack.update();
  const clock = (pack as unknown as { clock: FakeClock }).clock;
  const day = async () => {
    clock.advance(DAY_MS);
    await pack.tick();
  };
  // git -C <clone> log --oneline -- pstack: the older commit, pinned as the README says.
  const older = git(s.folder, "log", "--format=%H", "--", "pstack").split("\n")[1]!;
  assert.equal((await s.post({ type: "poteto.pin.set", pin: older })).body.poteto.version, "0.15.1");
  up.commit("pstack: fourth", { version: "0.15.3" });
  await day();
  assert.equal(git(s.folder, "rev-parse", "HEAD"), older, "the pin stays through the daily tick");
  assert.match(pack.state().pinned!, /^pinned at [0-9a-f]{40}, latest is [0-9a-f]{7}$/);
  await s.post({ type: "poteto.pin.set", pin: null });
  assert.equal(pack.state().version, "0.15.3");
  // A checkout by hand, with no pin: the next daily update moves it back.
  git(s.folder, "checkout", "-q", "--detach", older);
  await day();
  assert.equal(git(s.folder, "branch", "--show-current"), "main");
  assert.equal(pack.state().version, "0.15.3");
  // A local edit stops every move until `git checkout -- .`.
  writeFileSync(join(s.folder, "pstack/skills/how/SKILL.md"), "edited\n");
  up.commit("pstack: fifth", { version: "0.15.4" });
  await day();
  assert.match(pack.state().error!.reason, /^local changes in /);
  git(s.folder, "checkout", "--", ".");
  clock.advance(TICK_MS);
  await pack.tick();
  assert.equal(pack.state().error, null);
  assert.equal(pack.state().version, "0.15.4");
});

test("while a clone or an update runs, the agents file and the briefing read the checkout as the last read found it, never one half moved", async () => {
  const up = upstream("0.15.0");
  const { pack, folder } = packFor(up.bare);
  await pack.update();
  const before = pack.briefing();
  assert.ok(before);
  const running = pack.update();
  // What a checkout half way through a move can look like: plugin.json gone for a moment.
  renameSync(join(folder, "pstack/plugin.json"), join(folder, "plugin.json.moving"));
  assert.equal(pack.state().busy, true);
  assert.deepEqual(pack.briefing(), before, "the briefing: the checkout as it was");
  assert.equal(pack.pointerLine(), potetoLine(folder), "the agents file's line: still there");
  await running;
  renameSync(join(folder, "plugin.json.moving"), join(folder, "pstack/plugin.json"));
  assert.deepEqual(pack.briefing(), before, "read afresh once nothing runs");
});

test("an update queued behind a clone: while its checkout is paused, readers see what the clone left, not what was there before it", async (t) => {
  const up = upstream("0.15.0");
  const first = git(up.work, "rev-parse", "HEAD");
  up.commit("pstack: tdd changed", { version: "0.15.1", files: { "pstack/skills/tdd/SKILL.md": "# tdd, changed\n" } });
  // A smudge filter on tdd's SKILL.md that, once armed, pauses git's checkout there until released.
  const gate = dir("gate");
  const [armed, entered, release] = ["armed", "entered", "release"].map((name) => join(gate, name)) as [string, string, string];
  const filter = join(gate, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\nif [ -e '${armed}' ]; then : > '${entered}'; while [ ! -e '${release}' ]; do sleep 0.01; done; fi\ncat\n`, { mode: 0o755 });
  writeFileSync(join(gate, "attributes"), "pstack/skills/tdd/SKILL.md filter=gate\n");
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.attributesFile", GIT_CONFIG_VALUE_0: join(gate, "attributes"), GIT_CONFIG_KEY_1: "filter.gate.smudge", GIT_CONFIG_VALUE_1: filter, GIT_CONFIG_KEY_2: "filter.gate.clean", GIT_CONFIG_VALUE_2: "cat" });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  });
  const { pack, repos, folder } = packFor(up.bare);
  repos.setKv(POTETO_PIN_KEY, first);
  const cloning = pack.update();
  const updating = pack.update();
  await cloning;
  // Between the two: the clone at the pin; the update, already queued, follows origin's main and moves tdd.
  repos.deleteKv(POTETO_PIN_KEY);
  writeFileSync(armed, "");
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(entered) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(existsSync(entered), "git reached the paused checkout");
    assert.deepEqual(pack.briefing(), { clone: folder, version: "0.15.0", commit: first.slice(0, 7), names: FIXTURE_SKILLS }, "the checkout the clone left");
    assert.equal(pack.pointerLine(), potetoLine(folder));
  } finally {
    writeFileSync(release, "");
    await updating;
  }
  assert.equal(pack.state().version, "0.15.1");
});

// ---------------- the agents file ----------------

test("{poteto}: one line when on and ready, nothing (and no blank line) when not; a custom template without it gets none", () => {
  const line = potetoLine("/data/skills/cursor-plugins");
  assert.equal(
    line,
    "- For any non-trivial job, read and follow poteto-mode at /data/skills/cursor-plugins/pstack/skills/poteto-mode/SKILL.md (Claude Code: the copy at /data/skills/cursor-plugins/harness/pstack/claude-code/skills/poteto-mode/SKILL.md). " +
      "pstack has no adapter for Codex or Antigravity: there, map its Cursor names to your own tools as its Claude Code adapter note (/data/skills/cursor-plugins/pstack/docs/harness/claude-code.md) does. " +
      "Backroom's three differences take precedence over the mode where they conflict. " +
      "Deliver the change committed on your branch with a Handoff instead of opening a pull request. " +
      "In a room, the Consigliere hands parallel work to the room's members, and a member uses subagents only within its own outcome. " +
      "Model routing is the crew's: skip setup-pstack.",
  );
  assert.equal(DEFAULT_AGENTS_TEMPLATE.split("\n").filter((l) => l === POTETO_PLACEHOLDER).length, 1, "the default holds it once, on a line of its own");
  const checks = ["npm run check"];
  const on = defaultAgentsText(checks, line);
  const off = defaultAgentsText(checks);
  assert.ok(on.includes(`untrue.\n${line}\n- When another agent`), "the line in the habits, after the one on reading the owner's code");
  assert.equal(off.includes(POTETO_PLACEHOLDER), false);
  assert.equal(off, on.replace(`${line}\n`, ""), "off: the line gone and no blank line left");
  assert.equal(off.includes("\n\n- When"), false);
  assert.equal(renderAgentsText("# Ours\nRun {checks}.", checks, line), "# Ours\nRun `npm run check`, and whatever else its README asks for.\n", "a custom template without {poteto} gets no line");
  assert.equal(renderAgentsText("a\n  {poteto}  \nb", [], null), "a\nb\n", "a line holding only {poteto} goes, spaces and all");
  assert.equal(renderAgentsText("a {poteto} b", [], null), "a  b\n", "elsewhere it is emptied");
  assert.equal(renderAgentsText("a\r\n{poteto}\r\nb", [], "X"), "a\nX\nb\n");
});

/** The fake T3 with one more provider instance, "work", of the Claude driver: its name does not say which harness it is. */
class CatalogT3 extends FakeT3Adapter {
  override async listCatalog() {
    return [...(await super.listCatalog()), { instanceId: "work", model: "claude-opus-5-5", label: "Claude Opus 5.5 (work)", providerName: "Work", driver: "claudeAgent", source: "server" as const }];
  }
}

function stackFor(t: TestContext, source: string, options: { agentsFile?: boolean } = {}) {
  const fake = new CatalogT3({ autoCompleteMs: null });
  const dataDir = dir("data");
  const stack = createStack({ dbPath: ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: options.agentsFile ?? false, poteto: { dataDir, source, clock: fakeClock() } });
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
  const folder = join(realpathSync(dataDir), SKILLS_FOLDER, CLONE_FOLDER);
  return { stack, fake, app, run, post, get, dataDir, folder };
}

test("Poteto mode on or off changes the rendered template: a written project differs, the diff shows the line, Apply pushes it, a stale diff is refused", async (t) => {
  const up = upstream();
  const s = stackFor(t, up.bare, { agentsFile: true });
  await s.stack.poteto!.update();
  const project = dir("project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { check: "true" } }));
  git(project, "add", ".");
  git(project, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", "first");
  s.fake.projects.push({ id: "project_p", title: "p", workspaceRoot: project, defaultModelSelection: null });
  await s.run({ type: "room.create", projectId: "project_p", title: "work", consigliere: false });
  const line = potetoLine(s.folder);
  const file = () => readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.equal(file(), defaultAgentsText(["npm run check"], line), "written with the line while on and ready");
  const stateOf = async () => ((await s.get("/api/agents-files")).body as Array<{ folder: string; state: string }>).find((e) => e.folder === project)?.state;
  assert.equal(await stateOf(), "same");

  const seenOn = (await s.get(`/api/agents-files/diff?folder=${encodeURIComponent(project)}`)).body;
  assert.equal((await s.post({ type: "poteto.enabled.set", enabled: false })).body.type, "settings.updated");
  assert.equal(await stateOf(), "differs", "off: the written file keeps its line, and differs");
  const stale = await s.post({ type: "agentsFile.apply", folder: project, fileDigest: seenOn.fileDigest, templateDigest: seenOn.templateDigest });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.message, STALE, "a diff seen while on is refused once it is off");
  const diff = (await s.get(`/api/agents-files/diff?folder=${encodeURIComponent(project)}`)).body;
  assert.ok(diff.diff.includes(`\n-${line}\n`), "the diff removes the line");
  assert.equal((await s.post({ type: "agentsFile.apply", folder: project, fileDigest: diff.fileDigest, templateDigest: diff.templateDigest })).status, 200);
  assert.equal(file(), defaultAgentsText(["npm run check"]));
  assert.equal(await stateOf(), "same");
  await s.post({ type: "poteto.enabled.set", enabled: true });
  assert.equal(await stateOf(), "differs", "on again: differs the other way");
  // The clone missing (removed by hand): no line, as when off.
  rmSync(s.folder, { recursive: true, force: true });
  const fresh = createStack({ dbPath: ":memory:", adapter: s.fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: true, poteto: { dataDir: s.dataDir, source: up.bare } });
  t.after(() => fresh.close());
  assert.equal(fresh.poteto!.pointerLine(), null, "missing: nothing to point at");
});

// ---------------- the briefing ----------------

const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "c", createdAt: "", updatedAt: "" };
const member = (id: string, alias: string): Participant => ({ id, roomId: "r", alias, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "" });
const pack = (harness: SkillsBriefing["harness"], commit = "abc1234"): SkillsBriefing => ({ clone: "/data/skills/cursor-plugins", version: "0.15.34", commit, names: ["how", "poteto-mode", "tdd"], harness });

test("the Skills section: the revision, poteto-mode for the reader's harness, the note where pstack has no adapter, the differences, the skills by name", () => {
  const tail =
    "Backroom's three differences take precedence over the mode where they conflict:\n" +
    "- Deliver the change committed on your branch with a Handoff instead of opening a pull request.\n" +
    "- In a room, the Consigliere hands parallel work to the room's members, and a member uses subagents only within its own outcome.\n" +
    "- Model routing is the crew's: skip setup-pstack.\n";
  assert.equal(
    skillsSection(pack("claude")),
    "== Skills ==\n" +
      "Poteto mode is on: pstack 0.15.34 at commit abc1234, Lauren Tan's skills (MIT), kept by Backroom in /data/skills/cursor-plugins.\n" +
      "For any non-trivial job, read and follow /data/skills/cursor-plugins/harness/pstack/claude-code/skills/poteto-mode/SKILL.md.\n" +
      tail +
      "pstack's skills: how, poteto-mode, tdd; read /data/skills/cursor-plugins/harness/pstack/claude-code/skills/<name>/SKILL.md for one.",
  );
  for (const [harness, name] of [["codex", "Codex"], ["antigravity", "Antigravity"]] as const) {
    assert.equal(
      skillsSection(pack(harness)),
      "== Skills ==\n" +
        "Poteto mode is on: pstack 0.15.34 at commit abc1234, Lauren Tan's skills (MIT), kept by Backroom in /data/skills/cursor-plugins.\n" +
        "For any non-trivial job, read and follow /data/skills/cursor-plugins/pstack/skills/poteto-mode/SKILL.md.\n" +
        `pstack has no adapter for ${name}: map its Cursor names to your own tools as its Claude Code adapter note (/data/skills/cursor-plugins/pstack/docs/harness/claude-code.md) does.\n` +
        tail +
        "pstack's skills: how, poteto-mode, tdd; read /data/skills/cursor-plugins/pstack/skills/<name>/SKILL.md for one.",
    );
  }
  const cursor = skillsSection(pack("other"));
  assert.ok(cursor.includes("read and follow /data/skills/cursor-plugins/pstack/skills/poteto-mode/SKILL.md."), "Cursor and the rest: pstack's own tree");
  assert.equal(cursor.includes("no adapter"), false, "no note for a harness pstack is written for");
  assert.deepEqual(["claudeAgent", "codex", "antigravity", "cursor", "opencode", "my-claude", "gemini-cli"].map(skillsHarness), ["claude", "codex", "antigravity", "other", "other", "claude", "antigravity"]);
});

test("every seat gets the section, the Consigliere and members; none while off; sent again when the revision moves; retracted for a seat that had it", () => {
  const c = member("c", "Fable");
  const w = member("w", "Sol");
  const input = (skills: SkillsBriefing | null, reader = w): StandingInput => ({ room, participant: reader, participantsById: new Map([[c.id, c], [w.id, w]]), board: { command: "rooms-board", as: "k" }, skills });
  for (const reader of [c, w]) assert.ok(standingText(input(pack("claude"), reader)).includes(skillsSection(pack("claude"))), reader.alias);
  assert.equal(standingText(input(null)).includes("== Skills =="), false, "off: no section in a first briefing");

  const told = heldStanding({}, standingFingerprint(input(pack("claude"))));
  assert.deepEqual(changedStanding(told, standingFingerprint(input(pack("claude")))), []);
  const moved = standingFingerprint(input(pack("claude", "def5678")));
  assert.deepEqual(changedStanding(told, moved), ["skills"], "the same names and paths at another commit: sent again");
  assert.ok(briefingHeader(input(pack("claude", "def5678")), ["skills"], { seat: false }).join("\n").includes("Changed since your last briefing:\n== Skills ==\nPoteto mode is on: pstack 0.15.34 at commit def5678"));

  const off = standingFingerprint(input(null));
  assert.deepEqual(changedStanding(told, off), ["skills"], "off: a seat that had it is told");
  assert.equal(briefingHeader(input(null), ["skills"], { seat: false }).slice(1).join("\n"), `Changed since your last briefing:\n${SKILLS_OFF}`);
  assert.equal(SKILLS_OFF, "== Skills ==\nPoteto mode is off now: the Skills section you were given earlier no longer applies. Follow a pstack skill only when your assignment names one.");
  const offHeld = heldStanding(told, off);
  assert.deepEqual(changedStanding(offHeld, off), [], "told once");
  assert.deepEqual(changedStanding(offHeld, standingFingerprint(input(pack("claude")))), ["skills"], "on again: the full section returns");
  const { skills: _never, ...before } = off;
  assert.deepEqual(changedStanding(before, off), [], "a seat never told of it (a thread from before the section) is not told it is off");
  assert.deepEqual(changedStanding(heldStanding({}, off), off), []);
});

test("the briefing source: each seat's harness from T3's catalog, the section while on and ready, none before the clone; seating never waits for it", async (t) => {
  const up = upstream("0.15.0");
  const s = stackFor(t, up.bare);
  const { roomId } = await s.run({ type: "room.create", projectId: "project_demo", title: "skills" });
  const seat = async (alias: string, instanceId: string, model: string) => (await s.run({ type: "participant.create", roomId, alias, modelSelection: { instanceId, model }, thread: { mode: "create" } })).participantId as string;
  const claude = await seat("Opus", "claudeAgent", "claude-opus-5-5");
  const codex = await seat("Sol", "codex", "gpt-6-sol");
  const gemini = await seat("Gem", "antigravity", "gemini-3.8-flash-high");
  const work = await seat("Work", "work", "claude-opus-5-5");
  // The clone runs in the background; the standing text does not wait for it.
  const cloning = s.stack.poteto!.prepare();
  assert.equal((await s.stack.seats.standingText(claude)).includes("== Skills =="), false, "not before the clone is ready");
  await cloning;
  const commit = git(up.work, "rev-parse", "--short=7", "HEAD");
  const claudeText = await s.stack.seats.standingText(claude);
  assert.ok(claudeText.includes(`Poteto mode is on: pstack 0.15.0 at commit ${commit}`));
  assert.ok(claudeText.includes(`read and follow ${s.folder}/harness/pstack/claude-code/skills/poteto-mode/SKILL.md.`));
  assert.ok(claudeText.includes(`pstack's skills: ${FIXTURE_SKILLS.join(", ")}; read ${s.folder}/harness/pstack/claude-code/skills/<name>/SKILL.md for one.`));
  const codexText = await s.stack.seats.standingText(codex);
  assert.ok(codexText.includes(`read and follow ${s.folder}/pstack/skills/poteto-mode/SKILL.md.`));
  assert.ok(codexText.includes("pstack has no adapter for Codex"));
  assert.ok((await s.stack.seats.standingText(gemini)).includes("pstack has no adapter for Antigravity"));
  assert.ok((await s.stack.seats.standingText(work)).includes(`read and follow ${s.folder}/harness/pstack/claude-code/skills/poteto-mode/SKILL.md.`), "the harness from T3's driver, not the instance's name");
  await s.run({ type: "poteto.enabled.set", enabled: false });
  assert.equal((await s.stack.seats.standingText(claude)).includes("== Skills =="), false, "off");
});

test("the dialog's status line: the setting before the clone, so off never says seats are pointed at it (review #206)", () => {
  const off = "Off: seats are not pointed at it; the clone is kept.";
  assert.equal(potetoStatus({ enabled: false, busy: false, ready: true }), off);
  assert.equal(potetoStatus({ enabled: false, busy: true, ready: true }), off, "off while an update finishes");
  assert.equal(potetoStatus({ enabled: false, busy: false, ready: false }), "Off: seats are not pointed at it.");
  assert.equal(potetoStatus({ enabled: true, busy: true, ready: true }), "Working on the clone…");
  assert.equal(potetoStatus({ enabled: true, busy: false, ready: true }), "Ready: seats are pointed at it.");
  assert.equal(potetoStatus({ enabled: true, busy: false, ready: false }), "Not cloned yet.");
});

// ---------------- the settings route and the commands ----------------

test("the settings route reports Poteto mode and starts a missing clone; poteto.enabled.set, poteto.update and poteto.pin.set, refused where they cannot run", async (t) => {
  const up = upstream("0.15.0");
  // Turned on with no clone yet: the clone starts in the background at once.
  const later = stackFor(t, up.bare);
  later.stack.repos.setKv(POTETO_SETTING_KEY, "off");
  await later.post({ type: "poteto.enabled.set", enabled: true });
  assert.equal(later.stack.poteto!.state().busy, true, "turning it on started the clone");
  await later.stack.poteto!.prepare();
  assert.equal(later.stack.poteto!.state().ready, true);

  const s = stackFor(t, up.bare);
  const first = (await s.get("/api/settings")).body.poteto as ServerState;
  assert.equal(first.enabled, true, "on by default");
  assert.equal(first.busy, true, "reading the settings started the clone");
  assert.equal(first.folder, s.folder);
  assert.equal(first.source, up.bare);
  await s.stack.poteto!.prepare();
  const ready = (await s.get("/api/settings")).body.poteto as ServerState;
  assert.equal(ready.ready, true);
  assert.equal(ready.version, "0.15.0");

  const next = up.commit("pstack: newer", { version: "0.15.1" });
  const updated = await s.post({ type: "poteto.update" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.type, "poteto.updated");
  assert.equal(updated.body.poteto.version, "0.15.1");
  assert.equal(updated.body.poteto.commit, next);

  const pinned = await s.post({ type: "poteto.pin.set", pin: next });
  assert.equal(pinned.body.type, "poteto.updated");
  assert.equal(pinned.body.poteto.pin, next);
  assert.equal(s.stack.repos.getKv(POTETO_PIN_KEY), next, "kept");
  for (const pin of ["", "-x", "--upload-pack=evil", "a b", "x".repeat(101)]) assert.equal((await s.post({ type: "poteto.pin.set", pin })).status, 400, `refused: ${JSON.stringify(pin)}`);
  assert.equal((await s.post({ type: "poteto.pin.set", pin: null })).body.poteto.pin, null);
  assert.equal(s.stack.repos.getKv(POTETO_PIN_KEY), null);

  renameSync(up.bare, `${up.bare}.away`);
  const failed = await s.post({ type: "poteto.update" });
  assert.equal(failed.status, 200, "a failed fetch is a state to show, not a refusal");
  assert.match(failed.body.poteto.error.reason, /^could not fetch from /);
  renameSync(`${up.bare}.away`, up.bare);

  assert.equal((await s.post({ type: "poteto.enabled.set", enabled: false })).body.type, "settings.updated");
  assert.equal(s.stack.repos.getKv(POTETO_SETTING_KEY), "off");
  assert.equal(((await s.get("/api/settings")).body.poteto as ServerState).enabled, false);
  const refused = await s.post({ type: "poteto.update" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.message, "Poteto mode is off: turn it on to update pstack");
  const older = git(s.folder, "rev-parse", "HEAD~1");
  assert.equal((await s.post({ type: "poteto.pin.set", pin: older })).body.type, "settings.updated", "a pin set while off is only kept");
  assert.notEqual(git(s.folder, "rev-parse", "HEAD"), older);
  assert.equal((await s.post({ type: "poteto.enabled.set", enabled: "yes" })).status, 400);
  assert.equal((await s.post({ type: "poteto.enabled.set", enabled: true })).body.type, "settings.updated");
  assert.equal(s.stack.repos.getKv(POTETO_SETTING_KEY), null);
  await s.stack.poteto!.settled();
  assert.equal(git(s.folder, "rev-parse", "HEAD"), older, "turned on: the pin set while off is checked out, by the update turning it on started");

  // A service that keeps no clone (the tests' default): reported as null, and Update now refused.
  const bare = createStack({ dbPath: ":memory:", adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null });
  t.after(() => bare.close());
  const app = createHttpApp(bare, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dir("data"), ROOMS_PORT: "0" }), "/nonexistent/dist");
  assert.equal(((await (await app.request("/api/settings")).json()) as { poteto: unknown }).poteto, null);
  const none = await app.request("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "poteto.update" }) });
  assert.equal(none.status, 409);
});
