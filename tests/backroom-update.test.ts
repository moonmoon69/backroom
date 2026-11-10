/**
 * Backroom's release and update: install.sh installs and updates a copy from a repository's release tags, the row reads
 * the newest release from the copy's origin, and Update runs the copy's own install.sh. Every repository here is a
 * scratch one the test makes: a bare repository with made-up releases of a made-up project stands in for GitHub.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BackroomUpdate, copyScript, originRelease } from "../src/app/backroomUpdate.ts";
import { COPY_VERSION, loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { backroomCheckNote } from "../web/src/backroomRow.ts";
import type { BackroomUpdateView } from "../web/src/types.ts";
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
 * A scratch "GitHub": a bare repository, and a working repository that makes the releases of a made-up stand-in for
 * Backroom (its package.json names backroom) with this checkout's install.sh, a package with no dependencies, and a page
 * build that writes its version (or fails). `name` makes another project; `noScript` a release from before install.sh.
 */
function upstream(dir: string) {
  const bare = join(dir, "example-org", "shop.git");
  const work = join(dir, "work");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare", "-b", "main");
  mkdirSync(work);
  git(work, "init", "--quiet", "-b", "main");
  git(work, "remote", "add", "origin", bare);
  type Options = { buildFails?: boolean; name?: string; noScript?: boolean };
  const commit = (version: string, options: Options = {}) => {
    const name = options.name ?? "backroom";
    writeFileSync(join(work, "package.json"), JSON.stringify({ name, version, private: true, scripts: { "build:web": "node build.mjs" } }, null, 2));
    writeFileSync(join(work, "package-lock.json"), JSON.stringify({ name, version, lockfileVersion: 3, requires: true, packages: { "": { name, version } } }, null, 2));
    writeFileSync(
      join(work, "build.mjs"),
      options.buildFails
        ? `import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nrmSync("web/dist", { recursive: true, force: true });\nmkdirSync("web/dist", { recursive: true });\nwriteFileSync("web/dist/half.js", "");\nconsole.error("build failed on purpose");\nprocess.exit(1);\n`
        : `import { mkdirSync, rmSync, writeFileSync } from "node:fs";\nrmSync("web/dist", { recursive: true, force: true });\nmkdirSync("web/dist", { recursive: true });\nwriteFileSync("web/dist/index.html", "page ${version}");\n`,
    );
    writeFileSync(join(work, ".gitignore"), "node_modules/\nweb/dist/\ndata/\n");
    if (options.noScript) rmSync(join(work, "install.sh"), { force: true });
    else copyFileSync(SCRIPT, join(work, "install.sh"));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "--allow-empty", "-m", `example-shop ${version}`);
    git(work, "push", "--quiet", "origin", "main");
  };
  const release = (version: string, options: Options = {}) => {
    commit(version, options);
    git(work, "tag", `v${version}`);
    git(work, "push", "--quiet", "origin", `v${version}`);
  };
  return { bare, commit, release };
}

/** install.sh on `dir`, with a scratch HOME beside it. */
function install(dir: string, repo: string, env: NodeJS.ProcessEnv = {}) {
  const home = join(dirname(dir), "home");
  mkdirSync(home, { recursive: true });
  const result = spawnSync("sh", [SCRIPT, dir], { env: { ...GIT_ENV, HOME: home, BACKROOM_REPO: repo, ...env }, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const at = (copy: string) => git(copy, "describe", "--tags", "--exact-match", "HEAD");
const page = (copy: string) => readFileSync(join(copy, "web", "dist", "index.html"), "utf8");

test("install.sh: a fresh install lands on the newest release, three plain numbers and nothing else, built and ready to start", (t) => {
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

/** A command on PATH ahead of the real one: `body` is sh, and "$real" runs the real command. */
function shim(bin: string, name: string, body: string): void {
  mkdirSync(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, name), `#!/bin/sh\nreal=${real}\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** The command a line of install.sh's output prints after `lead`, run by sh with its last step replaced by `pwd`. */
function runPrinted(out: string, lead: string, last: string): string {
  const line = out.split("\n").find((l) => l.includes(lead))!;
  const command = line.slice(line.indexOf(lead) + lead.length).replace(/\s*\(.*\)\.?$/, "").replace(/\.$/, "");
  assert.ok(command.endsWith(last), `${command} ends with ${last}`);
  const result = spawnSync("sh", ["-c", `${command.slice(0, -last.length)}pwd`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("install.sh: when the put-back's own npm ci fails, the page served is still the old one, and the command it names finishes the copy", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "space copy");
  const installed = install(copy, up.bare);
  assert.equal(installed.status, 0, installed.out);
  assert.equal(runPrinted(installed.out, "Start it with: ", "npm start"), copy, "the start command runs as printed for a folder with a space");
  up.release("0.2.0", { buildFails: true });
  // npm ci works for the update and fails for the put-back.
  const bin = join(dir, "bin");
  const mark = join(dir, "ci-ran");
  shim(bin, "npm", `if [ "$1" = ci ] && [ -e '${mark}' ]; then echo "packages unavailable" >&2; exit 42; fi\n[ "$1" != ci ] || touch '${mark}'\nexec "$real" "$@"`);
  const run = install(copy, up.bare, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(run.status, 1);
  assert.deepEqual([at(copy), existsSync(join(copy, "web", "dist", "index.html")) && page(copy), existsSync(join(copy, "web", "dist", "half.js"))], ["v0.1.0", "page 0.1.0", false]);
  assert.match(run.out, /npm ci failed on v0\.1\.0 too: .* is on v0\.1\.0 with the page it served, but its packages are not installed\. Finish it with: cd '.*space copy' && npm ci\n$/);
  assert.equal(runPrinted(run.out, "Finish it with: ", "npm ci"), copy, "the command it names runs as printed");
});

test("install.sh: a stop right after the checkout moved the copy puts it back", (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  up.release("0.1.0");
  const copy = join(dir, "copy");
  assert.equal(install(copy, up.bare).status, 0);
  up.release("0.2.0");
  // The first checkout that succeeds sends TERM to the script, before it runs anything else.
  const bin = join(dir, "bin");
  const mark = join(dir, "stopped");
  shim(bin, "git", `"$real" "$@"; status=$?\ncase " $* " in *" checkout "*) if [ $status = 0 ] && [ ! -e '${mark}' ]; then touch '${mark}'; kill -TERM $PPID; fi ;; esac\nexit $status`);
  const run = install(copy, up.bare, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(run.status, 1);
  assert.match(run.out, /the update was stopped on v0\.2\.0; .* is back on v0\.1\.0 as it was\.\n$/);
  assert.deepEqual([at(copy), page(copy), git(copy, "status", "--porcelain")], ["v0.1.0", "page 0.1.0", ""]);
});

test("install.sh: a checkout that is not Backroom is refused with nothing changed; a copy cloned before install.sh existed updates", (t) => {
  const dir = scratch(t);
  const other = upstream(join(dir, "other"));
  other.release("0.1.0", { name: "example-shop" });
  other.release("0.2.0", { name: "example-shop" });
  const shop = join(dir, "shop");
  git(dir, "clone", "--quiet", "--branch", "v0.1.0", other.bare, shop);
  const refused = install(shop, other.bare);
  assert.equal(refused.status, 1);
  assert.match(refused.out, /is not a copy of Backroom: its package\.json does not name backroom\. Nothing was changed\.\n$/);
  assert.deepEqual([at(shop), existsSync(join(shop, "web"))], ["v0.1.0", false], "not moved, and its build never ran");

  const up = upstream(join(dir, "up"));
  up.release("0.1.0", { noScript: true });
  const old = join(dir, "old");
  git(dir, "clone", "--quiet", "--branch", "v0.1.0", up.bare, old);
  up.release("0.2.0");
  const run = install(old, up.bare);
  assert.equal(run.status, 0, run.out);
  assert.deepEqual([at(old), page(old)], ["v0.2.0", "page 0.2.0"]);
  assert.match(run.out, /start it again with: cd \S+ && npm start/);
});

test("prerelease tags never count, so the row and install.sh agree: a copy on one is offered nothing and is not moved", async (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  for (const version of ["0.9.0", "1.0.0-alpha10", "1.0.0-alpha2"]) up.release(version);
  const copy = join(dir, "copy");
  git(dir, "clone", "--quiet", "--branch", "v1.0.0-alpha10", up.bare, copy);
  const row = await new BackroomUpdate({ root: copy, version: "1.0.0-alpha10" }).view(false);
  assert.deepEqual([row.latest, row.newer], ["0.9.0", false]);
  const run = install(copy, up.bare);
  assert.equal(run.status, 1);
  assert.match(run.out, /has commits that v0\.9\.0 does not contain; nothing was changed/);
  assert.equal(at(copy), "v1.0.0-alpha10");
});

test("a number with a leading zero or more than nine digits makes no release, so the row and install.sh pick the same one", async (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  for (const version of ["1.0.0", "1.00.1", "01.2.0", "1.1234567890.0"]) up.release(version);
  const copy = join(dir, "copy");
  const run = install(copy, up.bare);
  assert.equal(run.status, 0, run.out);
  assert.equal(at(copy), "v1.0.0");
  assert.equal(await originRelease(copy), "1.0.0");
});

test("neither the lookup nor the script Update runs starts a prompt: no askpass, no terminal, ssh in batch mode", async (t) => {
  const dir = scratch(t);
  const asked = join(dir, "asked.txt");
  const askpass = join(dir, "askpass.sh");
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${asked}'\necho example-answer\n`);
  chmodSync(askpass, 0o755);
  const before = process.env.GIT_ASKPASS;
  process.env.GIT_ASKPASS = askpass;
  t.after(() => (before === undefined ? delete process.env.GIT_ASKPASS : (process.env.GIT_ASKPASS = before)));
  // A remote that asks for a credential.
  const server = createHttpServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Example"' });
    response.end("authentication required");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const copy = join(dir, "copy");
  mkdirSync(copy);
  git(copy, "init", "--quiet", "-b", "main");
  git(copy, "remote", "add", "origin", `http://127.0.0.1:${(server.address() as { port: number }).port}/example-org/shop.git`);
  await assert.rejects(originRelease(copy, 5000), /origin did not answer/);
  assert.equal(existsSync(asked), false, "the lookup ran no askpass program");

  writeFileSync(join(copy, "install.sh"), `printf '%s\\n' "askpass=[$GIT_ASKPASS]" "prompt=$GIT_TERMINAL_PROMPT" "ssh=$GIT_SSH_COMMAND" > env.txt\n`);
  await copyScript(copy)();
  assert.deepEqual(readFileSync(join(copy, "env.txt"), "utf8").trim().split("\n"), ["askpass=[]", "prompt=0", "ssh=ssh -o BatchMode=yes"]);
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

test("the lookup reads the origin's release tags: newer, the same, older, none; a tag that is not three plain numbers never counts", async (t) => {
  const dir = scratch(t);
  const up = upstream(dir);
  const copy = join(dir, "copy");
  up.commit("0.0.1");
  git(dir, "clone", "--quiet", up.bare, copy);
  assert.equal(await originRelease(copy), null, "no release tag yet");
  for (const version of ["0.1.0", "0.2.0", "0.3.0-beta.1"]) up.release(version);
  git(join(dir, "work"), "tag", "vnext");
  git(join(dir, "work"), "push", "--quiet", "origin", "vnext");
  const row = (version: string) => new BackroomUpdate({ root: copy, version }).view(false);
  assert.deepEqual(await row("0.1.0").then((v) => [v.latest, v.newer]), ["0.2.0", true]);
  assert.deepEqual(await row("0.2.0").then((v) => [v.latest, v.newer]), ["0.2.0", false]);
  assert.deepEqual(await row("0.4.0").then((v) => [v.latest, v.newer]), ["0.2.0", false]);
  assert.deepEqual(await row("0.3.0-beta.0").then((v) => [v.latest, v.newer]), ["0.2.0", false], "not even for a copy that runs a prerelease");
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
  await assert.rejects(originRelease(copy), /origin did not answer: .*gone\.git/);

  // A server that takes the connection and never answers.
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => silent.close());
  git(copy, "remote", "set-url", "origin", `git://127.0.0.1:${(silent.address() as { port: number }).port}/example-org/shop.git`);
  await assert.rejects(originRelease(copy, 1000), /origin did not answer within 1 s/);
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
  // The script Update runs gets this process's environment: a scratch HOME.
  const home = process.env.HOME;
  process.env.HOME = join(dir, "home");
  t.after(() => (process.env.HOME = home));
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

test("the row shows a failed lookup's reason, also while it still shows a newer release from an earlier lookup", () => {
  const row = (part: Partial<BackroomUpdateView>): BackroomUpdateView => ({ version: "0.1.0", folder: "/x", latest: "0.2.0", newer: true, command: "sh /x/install.sh /x", busy: [], releaseCheckedAt: null, releaseError: null, job: null, ...part });
  assert.equal(backroomCheckNote(row({ releaseError: "git: origin did not answer: gone" })), "Could not check for a newer Backroom (git: origin did not answer: gone)");
  assert.equal(backroomCheckNote(row({ newer: false, latest: null, releaseError: "git: this copy has no origin remote" })), "Could not check for a newer Backroom (git: this copy has no origin remote)");
  assert.equal(backroomCheckNote(row({})), null, "a newer release, checked: the row offers it");
  assert.equal(backroomCheckNote(row({ newer: false })), "Up to date");
  assert.equal(backroomCheckNote(row({ newer: false, latest: null })), "No release yet");
  assert.equal(backroomCheckNote(row({ releaseError: "late", job: { targetVersion: "0.2.0", state: "installing", startedAt: "", finishedAt: null, error: null } })), null, "nothing while the update runs");
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
