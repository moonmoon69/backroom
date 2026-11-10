/**
 * Backroom's release and update: install.sh installs and updates a copy from a repository's release tags, the row reads
 * the newest release from the copy's origin, and Update runs the copy's own install.sh. Every repository here is a
 * scratch one the test makes: a bare repository with made-up releases of a made-up project stands in for GitHub.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BackroomUpdate, copyScript, originRelease } from "../src/app/backroomUpdate.ts";
import { COPY_VERSION, loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const SCRIPT = join(import.meta.dirname, "..", "install.sh");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Example Owner", GIT_AUTHOR_EMAIL: "owner@example.com", GIT_COMMITTER_NAME: "Example Owner", GIT_COMMITTER_EMAIL: "owner@example.com" };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "backroom-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A scratch "GitHub": a bare repository, and a working repository that makes the releases of a made-up project with
 * this checkout's install.sh, a package with no dependencies, and a page build that writes its version (or fails).
 */
function upstream(dir: string) {
  const bare = join(dir, "example-org", "shop.git");
  const work = join(dir, "work");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare", "-b", "main");
  mkdirSync(work);
  git(work, "init", "--quiet", "-b", "main");
  git(work, "remote", "add", "origin", bare);
  const commit = (version: string, options: { buildFails?: boolean } = {}) => {
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "example-shop", version, private: true, scripts: { "build:web": "node build.mjs" } }, null, 2));
    writeFileSync(join(work, "package-lock.json"), JSON.stringify({ name: "example-shop", version, lockfileVersion: 3, requires: true, packages: { "": { name: "example-shop", version } } }, null, 2));
    writeFileSync(
      join(work, "build.mjs"),
      options.buildFails
        ? `import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nrmSync("web/dist", { recursive: true, force: true });\nmkdirSync("web/dist", { recursive: true });\nwriteFileSync("web/dist/half.js", "");\nconsole.error("build failed on purpose");\nprocess.exit(1);\n`
        : `import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nrmSync("web/dist", { recursive: true, force: true });\nmkdirSync("web/dist", { recursive: true });\nwriteFileSync("web/dist/index.html", "page ${version}");\n`,
    );
    writeFileSync(join(work, ".gitignore"), "node_modules/\nweb/dist/\ndata/\n");
    copyFileSync(SCRIPT, join(work, "install.sh"));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "--allow-empty", "-m", `example-shop ${version}`);
    git(work, "push", "--quiet", "origin", "main");
  };
  const release = (version: string, options: { buildFails?: boolean } = {}) => {
    commit(version, options);
    git(work, "tag", `v${version}`);
    git(work, "push", "--quiet", "origin", `v${version}`);
  };
  return { bare, commit, release };
}

function install(dir: string, repo: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("sh", [SCRIPT, dir], { env: { ...GIT_ENV, BACKROOM_REPO: repo, ...env }, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const at = (copy: string) => git(copy, "describe", "--tags", "--exact-match", "HEAD");
const page = (copy: string) => readFileSync(join(copy, "web", "dist", "index.html"), "utf8");

test("install.sh: a fresh install lands on the newest release, never a prerelease, built and ready to start", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  for (const version of ["0.1.0", "0.2.0", "0.10.0", "0.11.0-beta.1"]) up.release(version);
  const copy = join(dir, "copy");
  const run = install(copy, up.bare);
  assert.equal(run.status, 0, run.out);
  assert.equal(at(copy), "v0.10.0", "0.10.0 is newer than 0.2.0, and a prerelease does not count");
  assert.equal(page(copy), "page 0.10.0");
  assert.match(run.out, new RegExp(`Start it with: cd ${copy} && npm start`));
});

test("install.sh: with no release tag yet, a fresh install stays on the default branch", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.commit("0.1.0");
  const copy = join(dir, "copy");
  const run = install(copy, up.bare);
  assert.equal(run.status, 0, run.out);
  assert.equal(git(copy, "symbolic-ref", "--short", "HEAD"), "main");
  assert.match(run.out, /no release yet/);
  assert.equal(page(copy), "page 0.1.0");
});

test("install.sh: an update moves a copy from an older release to the newest, and says to restart", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "copy");
  assert.equal(install(copy, up.bare).status, 0);
  up.release("0.2.0");
  // The update reads the copy's own origin, whatever BACKROOM_REPO says.
  const run = install(copy, join(dir, "nowhere.git"));
  assert.equal(run.status, 0, run.out);
  assert.equal(at(copy), "v0.2.0");
  assert.equal(page(copy), "page 0.2.0");
  assert.match(run.out, /Moved .* from v0\.1\.0 to v0\.2\.0/);
  assert.match(run.out, /Restart it to run the new version/);
});

test("install.sh: a copy with uncommitted changes or commits of its own is left as it was", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "copy");
  assert.equal(install(copy, up.bare).status, 0);
  up.release("0.2.0");
  writeFileSync(join(copy, "build.mjs"), "// my own change\n");
  const dirty = install(copy, up.bare);
  assert.equal(dirty.status, 1);
  assert.match(dirty.out, /has uncommitted changes; nothing was changed/);
  assert.deepEqual([at(copy), readFileSync(join(copy, "build.mjs"), "utf8")], ["v0.1.0", "// my own change\n"]);

  git(copy, "commit", "--quiet", "-am", "my own change");
  const mine = git(copy, "rev-parse", "HEAD");
  const ahead = install(copy, up.bare);
  assert.equal(ahead.status, 1);
  assert.match(ahead.out, /has commits that v0\.2\.0 does not contain; nothing was changed/);
  assert.equal(git(copy, "rev-parse", "HEAD"), mine);
});

test("install.sh: a build that fails after the move puts the copy back on its release, with the page it served", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "copy");
  assert.equal(install(copy, up.bare).status, 0);
  up.release("0.2.0", { buildFails: true });
  const run = install(copy, up.bare);
  assert.equal(run.status, 1);
  assert.match(run.out, /build failed on purpose[\s\S]*the page's build failed on v0\.2\.0; .* is back on v0\.1\.0 as it was\.\n$/);
  assert.equal(at(copy), "v0.1.0");
  assert.equal(page(copy), "page 0.1.0");
  assert.equal(existsSync(join(copy, "web", "dist", "half.js")), false, "nothing of the failed build is left in the page");
  assert.equal(git(copy, "status", "--porcelain"), "");
});

test("install.sh: refuses plainly without git or without Node 24", (t) => {
  const dir = scratch(t);
  const empty = join(dir, "empty-bin");
  mkdirSync(empty);
  const noGit = spawnSync("/bin/sh", [SCRIPT, join(dir, "copy")], { env: { PATH: empty, HOME: dir }, encoding: "utf8" });
  assert.equal(noGit.status, 1);
  assert.match(noGit.stderr, /git is needed/);
  const old = join(dir, "old-bin");
  mkdirSync(old);
  writeFileSync(join(old, "node"), `#!/bin/sh\ncase "$1" in -p) echo 22 ;; *) echo v22.0.0 ;; esac\n`);
  writeFileSync(join(old, "npm"), "#!/bin/sh\n");
  chmodSync(join(old, "node"), 0o755);
  chmodSync(join(old, "npm"), 0o755);
  const oldNode = spawnSync("/bin/sh", [SCRIPT, join(dir, "copy")], { env: { PATH: `${old}:${dirname(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim())}`, HOME: dir }, encoding: "utf8" });
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.stderr, /Node 24 or newer is needed; this node is v22\.0\.0/);
  assert.equal(existsSync(join(dir, "copy")), false);
});

test("the lookup reads the origin's release tags: newer, the same, older, a prerelease only for a prerelease, none", async (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  const copy = join(dir, "copy");
  up.commit("0.0.1");
  git(dir, "clone", "--quiet", up.bare, copy);
  assert.equal(await originRelease(copy, "0.1.0"), null, "no release tag yet");
  for (const version of ["0.1.0", "0.2.0", "0.3.0-beta.1"]) up.release(version);
  git(join(dir, "work"), "tag", "vnext");
  git(join(dir, "work"), "push", "--quiet", "origin", "vnext");
  const row = (version: string) => new BackroomUpdate({ root: copy, version }).view(false);
  assert.deepEqual(await row("0.1.0").then((v) => [v.latest, v.newer]), ["0.2.0", true]);
  assert.deepEqual(await row("0.2.0").then((v) => [v.latest, v.newer]), ["0.2.0", false]);
  assert.deepEqual(await row("0.4.0").then((v) => [v.latest, v.newer]), ["0.2.0", false]);
  assert.deepEqual(await row("0.3.0-beta.0").then((v) => [v.latest, v.newer]), ["0.3.0-beta.1", true]);
  const offered = await row("0.1.0");
  assert.equal(offered.command, `sh ${join(copy, "install.sh")} ${copy}`, "the command to run by hand names the copy's real folder");
});

test("the lookup says why when the copy has no origin, or its origin does not answer", async (t) => {
  const dir = scratch(t);
  const copy = join(dir, "copy");
  mkdirSync(copy);
  git(copy, "init", "--quiet", "-b", "main");
  const none = await new BackroomUpdate({ root: copy, version: "0.1.0" }).view(false);
  assert.deepEqual([none.latest, none.newer, none.releaseError], [null, false, "git: this copy has no origin remote"]);

  git(copy, "remote", "add", "origin", join(dir, "gone.git"));
  await assert.rejects(originRelease(copy, "0.1.0"), /origin did not answer: .*gone\.git/);

  // A server that takes the connection and never answers.
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => silent.close());
  git(copy, "remote", "set-url", "origin", `git://127.0.0.1:${(silent.address() as { port: number }).port}/example-org/shop.git`);
  await assert.rejects(originRelease(copy, "0.1.0", 1000), /origin did not answer within 1 s/);
});

/** A copy whose install.sh only records how it was run, then writes `version` into the copy's package.json. */
function recordingCopy(dir: string, version: string) {
  const root = join(dir, "copy");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(root, "install.sh"), `printf '%s\\n' "$0" "$@" "$(pwd)" "\${PATH%%:*}" >> ran.txt\nprintf '{"version":"${version}"}' > package.json\n`);
  const runs = () => (existsSync(join(root, "ran.txt")) ? readFileSync(join(root, "ran.txt"), "utf8").trim().split("\n") : []);
  return { root, runs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("Update runs only the copy's own install.sh on its own folder, whatever the request says, then stops on the version installed", async (t) => {
  const dir = scratch(t);
  const { root, runs } = recordingCopy(dir, "0.2.0");
  const stopped: string[] = [];
  const update = new BackroomUpdate({ root, version: "0.1.0", lookup: async () => "0.2.0", installed: (v) => stopped.push(v), stopDelayMs: 0 });
  await assert.rejects(update.update("9.9.9"), /newest Backroom is now 0\.2\.0/);
  await assert.rejects(update.update("0.2.0; touch owned"), /newest Backroom is now 0\.2\.0/);
  assert.deepEqual(runs(), [], "a request that names anything else runs nothing");
  assert.equal((await update.update("0.2.0")).job?.state, "installing");
  await settle();
  assert.deepEqual(runs(), [join(root, "install.sh"), root, root, dirname(process.execPath)], "the script, on the copy's folder, with this node first on PATH");
  assert.deepEqual([(await update.view(false)).job?.state, stopped], ["restarting", ["0.2.0"]]);
  assert.equal(existsSync(join(root, "owned")), false);
});

test("two Update requests during one release lookup start one run; the second is refused as running", async () => {
  const waiting: Array<(version: string) => void> = [];
  let runs = 0;
  const update = new BackroomUpdate({ root: "/nonexistent", version: "0.1.0", lookup: () => new Promise((resolve) => waiting.push(resolve)), run: () => (runs++, new Promise<void>(() => {})) });
  const first = update.update("0.2.0");
  const second = update.update("0.2.0");
  for (const resolve of waiting) resolve("0.2.0");
  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.deepEqual([(b as PromiseRejectedResult).reason.code, (b as PromiseRejectedResult).reason.status], ["update_running", 409]);
  assert.equal(runs, 1);
});

test("from the page: a refused update and a failed build leave the copy as it was, and a later Update still starts", async (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "copy");
  assert.equal(install(copy, up.bare).status, 0);
  const stopped: string[] = [];
  // The copy runs 0.1.0; each step looks up its origin afresh.
  const update = () => new BackroomUpdate({ root: copy, version: "0.1.0", installed: (v) => stopped.push(v), stopDelayMs: 0 });
  const finished = async (u: BackroomUpdate) => {
    for (let i = 0; i < 150 && (await u.view(false)).job?.state === "installing"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    return (await u.view(false)).job;
  };

  up.release("0.2.0", { buildFails: true });
  writeFileSync(join(copy, "notes.txt"), "mine\n");
  const refused = update();
  await refused.update("0.2.0");
  const refusal = await finished(refused);
  assert.equal(refusal?.state, "failed");
  assert.match(refusal?.error ?? "", /has uncommitted changes; nothing was changed\./);
  assert.deepEqual([at(copy), readFileSync(join(copy, "notes.txt"), "utf8")], ["v0.1.0", "mine\n"]);
  rmSync(join(copy, "notes.txt"));

  const broken = update();
  await broken.update("0.2.0");
  const failure = await finished(broken);
  assert.equal(failure?.state, "failed");
  assert.match(failure?.error ?? "", /back on v0\.1\.0 as it was\.$/);
  assert.deepEqual([at(copy), page(copy), stopped], ["v0.1.0", "page 0.1.0", []]);

  up.release("0.2.1");
  const fixed = update();
  await fixed.update("0.2.1");
  assert.equal((await finished(fixed))?.state, "restarting");
  assert.deepEqual([at(copy), page(copy), stopped], ["v0.2.1", "page 0.2.1", ["0.2.1"]]);
});

test("a failed run says why, and Update is offered again", async () => {
  const update = new BackroomUpdate({ root: "/nonexistent", version: "0.1.0", lookup: async () => "0.2.0", busy: async () => ["Busy in Smoke (a turn)"], run: async () => { throw new Error("install.sh exited with 1:\nnpm ci failed on v0.2.0; /x is back on v0.1.0 as it was."); } });
  await update.update("0.2.0");
  await settle();
  const view = await update.view(false);
  assert.deepEqual([view.job?.state, view.newer, update.running(), view.busy], ["failed", true, false, ["Busy in Smoke (a turn)"]]);
});

test("the script's runner keeps the last lines of a failure, and stops a run past its time", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "install.sh"), `i=0; while [ $i -lt 60 ]; do echo "line $i"; i=$((i+1)); done; echo "the reason" >&2; exit 3\n`);
  await assert.rejects(copyScript(dir)(), (caught: Error) => caught.message.startsWith("install.sh exited with 3:\n") && caught.message.includes(":\nline 21\n") && caught.message.endsWith("line 59\nthe reason") && !caught.message.includes("line 20\n"));
  writeFileSync(join(dir, "install.sh"), `trap 'echo put back; exit 1' TERM\nsleep 30 &\nwait $!\n`);
  await assert.rejects(copyScript(dir, 500)(), /install\.sh did not finish within 1 s:\nput back/);
});

test("the status gives this copy's version, and the Updates view carries Backroom's row", async (t) => {
  const stack = await createTestStack(undefined, undefined, { backroom: { lookup: async () => "99.0.0", run: () => new Promise<void>(() => {}) } });
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-backroom-update", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const status = (await (await app.request("/api/status")).json()) as { version: string };
  assert.equal(status.version, COPY_VERSION);
  const updates = (await (await app.request("/api/t3/updates")).json()) as { backroom: { version: string; latest: string; newer: boolean; command: string }; available: number };
  assert.deepEqual([updates.backroom.version, updates.backroom.latest, updates.backroom.newer], [COPY_VERSION, "99.0.0", true]);
  assert.match(updates.backroom.command, /^sh .*install\.sh /);
  const stale = await app.request("/api/backroom/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetVersion: "98.0.0" }) });
  assert.equal(stale.status, 409);
  const started = await app.request("/api/backroom/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetVersion: "99.0.0" }) });
  const view = (await started.json()) as { backroom: { job: { state: string } }; available: number };
  assert.deepEqual([started.status, view.backroom.job.state, view.available], [200, "installing", updates.available - 1], "a newer Backroom counts on the Updates button until its update runs");
});

test("a copy's folders are its own, from any working directory; the variables still override them", () => {
  const root = join(import.meta.dirname, "..");
  const config = loadConfig({});
  assert.deepEqual([config.dataDir, config.webDistDir], [join(root, "data"), join(root, "web", "dist")]);
  const overridden = loadConfig({ ROOMS_DATA_DIR: "/tmp/d", ROOMS_WEB_DIST: "/tmp/w" });
  assert.deepEqual([overridden.dataDir, overridden.webDistDir], ["/tmp/d", "/tmp/w"]);
});
