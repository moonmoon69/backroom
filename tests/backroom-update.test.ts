/** How this copy was installed decides its folders and its update: a checkout, a global package, a package elsewhere. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackroomUpdate } from "../src/app/backroomUpdate.ts";
import { detectInstall, type Install } from "../src/app/install.ts";
import { npmDistTag } from "../src/app/t3Updates.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { createTestStack } from "./helpers.ts";

const NAME = "agents-backroom";

/** A folder of the test's own with a node and its npm laid out as Node's installer does, and a package folder. */
function machine(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "backroom-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const execPath = join(dir, "node", "bin", "node");
  mkdirSync(join(dir, "node", "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(dir, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
  const globalRoot = join(dir, "node", "lib", "node_modules");
  const copy = (root: string, version = "0.2.0") => {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: NAME, version, bin: { backroom: "bin/backroom.mjs" } }));
    writeFileSync(join(root, "bin", "backroom.mjs"), "");
    return root;
  };
  /** The command npm links into the prefix for a global install. */
  const link = (root: string) => {
    mkdirSync(join(dir, "node", "bin"), { recursive: true });
    symlinkSync(join(root, "bin", "backroom.mjs"), join(dir, "node", "bin", "backroom"));
    return root;
  };
  return { dir, execPath, globalRoot, copy, link, home: join(dir, "home") };
}

test("a checkout keeps its data and page beside it, and is never told it can update itself", (t) => {
  const m = machine(t);
  const root = m.copy(join(m.dir, "checkout"));
  mkdirSync(join(root, ".git"));
  const install = detectInstall({ root, home: m.home, execPath: m.execPath });
  assert.deepEqual([install.kind, install.name, install.version, install.dataDir, install.webDistDir], ["checkout", NAME, "0.2.0", join(root, "data"), join(root, "web", "dist")]);
  // A worktree's .git is a file.
  const worktree = m.copy(join(m.dir, "worktree"));
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  assert.equal(detectInstall({ root: worktree, home: m.home, execPath: m.execPath }).kind, "checkout");
  // From any working directory, the folders are the checkout's; the variables still override them.
  const config = loadConfig({}, install);
  assert.deepEqual([config.dataDir, config.webDistDir, config.dbPath], [join(root, "data"), join(root, "web", "dist"), join(root, "data", "rooms.sqlite")]);
  const overridden = loadConfig({ ROOMS_DATA_DIR: join(m.dir, "d"), ROOMS_WEB_DIST: join(m.dir, "w") }, install);
  assert.deepEqual([overridden.dataDir, overridden.webDistDir], [join(m.dir, "d"), join(m.dir, "w")]);
});

test("a package in npm's global folder is global, one anywhere else is not; both keep data in ~/.backroom and their page in their own folder", (t) => {
  const m = machine(t);
  const root = m.copy(join(m.globalRoot, NAME));
  // In a global folder but without the command npm links for it: not a global install.
  assert.equal(detectInstall({ root, home: m.home, execPath: m.execPath }).kind, "package");
  m.link(root);
  const global = detectInstall({ root, home: m.home, execPath: m.execPath });
  assert.deepEqual([global.kind, global.dataDir, global.webDistDir, global.npmCli, global.prefix], ["global", join(m.home, ".backroom"), join(root, "web", "dist"), join(m.globalRoot, "npm", "bin", "npm-cli.js"), join(m.dir, "node")]);
  const npxRoot = m.copy(join(m.dir, "npm-cache", "_npx", "abc", "node_modules", NAME));
  const elsewhere = detectInstall({ root: npxRoot, home: m.home, execPath: m.execPath });
  assert.deepEqual([elsewhere.kind, elsewhere.dataDir, elsewhere.webDistDir, elsewhere.prefix], ["package", join(m.home, ".backroom"), join(npxRoot, "web", "dist"), null]);
  // A project's own lib/node_modules is not a global folder: no command of the prefix links to it.
  const local = m.copy(join(m.dir, "project", "lib", "node_modules", NAME));
  assert.equal(detectInstall({ root: local, home: m.home, execPath: m.execPath }).kind, "package");
  // A node without its npm beside it cannot update a copy, wherever it is.
  const bare = detectInstall({ root, home: m.home, execPath: join(m.dir, "other", "bin", "node") });
  assert.deepEqual([bare.kind, bare.npmCli], ["package", null]);
  assert.equal(loadConfig({}, global).dataDir, join(m.home, ".backroom"));
});

const install = (kind: Install["kind"], version = "0.2.0"): Install => ({ kind, root: "/nonexistent", name: NAME, version, dataDir: "/nonexistent/data", webDistDir: "/nonexistent/web", npmCli: kind === "checkout" ? null : "/nonexistent/npm-cli.js", prefix: kind === "global" ? "/nonexistent/prefix" : null });

test("the row compares the newest release on the copy's own channel: newer, the same, older, and a prerelease's channel", async () => {
  const asked: string[] = [];
  const row = (version: string, latest: string | null) =>
    new BackroomUpdate({ install: install("global", version), lookup: async (name, channel) => (asked.push(`${name} ${channel}`), latest) }).view(false);
  assert.deepEqual(await row("0.2.0", "0.3.0").then((v) => [v.latest, v.newer, v.canUpdate, v.manual]), ["0.3.0", true, true, null]);
  assert.deepEqual(await row("0.2.0", "0.2.0").then((v) => [v.newer, v.canUpdate]), [false, false]);
  assert.deepEqual(await row("0.2.0", "0.1.9").then((v) => [v.newer, v.canUpdate]), [false, false]);
  const pre = await row("0.3.0-beta.1", "0.3.0-beta.2");
  assert.deepEqual([pre.channel, pre.newer], ["beta", true]);
  assert.deepEqual(asked, [`${NAME} latest`, `${NAME} latest`, `${NAME} latest`, `${NAME} beta`]);
  const checkout = await new BackroomUpdate({ install: install("checkout"), lookup: async () => "0.3.0" }).view(false);
  assert.deepEqual([checkout.newer, checkout.canUpdate], [true, false]);
  assert.match(checkout.manual ?? "", /git checkout: Backroom does not update it/);
  const elsewhere = await new BackroomUpdate({ install: install("package"), lookup: async () => "0.3.0" }).view(false);
  assert.equal(elsewhere.canUpdate, false);
  assert.match(elsewhere.manual ?? "", /npx agents-backroom@0\.3\.0/);
});

test("Update is refused for a checkout and a copy elsewhere, and installs only its own name at the looked-up version", async () => {
  const runs: string[][] = [];
  const npm = async (args: string[]) => void runs.push(args);
  for (const kind of ["checkout", "package"] as const) {
    await assert.rejects(new BackroomUpdate({ install: install(kind), lookup: async () => "0.3.0", npm }).update("0.3.0"), /updates itself only when installed in npm's global folder/);
  }
  const update = new BackroomUpdate({ install: install("global"), lookup: async () => "0.3.0", npm });
  await assert.rejects(update.update("9.9.9"), /newest Backroom is now 0\.3\.0/, "a request does not name the version installed");
  await assert.rejects(update.update("other-package@1.0.0"), /newest Backroom is now 0\.3\.0/);
  assert.deepEqual(runs, []);
  await assert.rejects(new BackroomUpdate({ install: install("global", "0.3.0"), lookup: async () => "0.3.0", npm }).update("0.3.0"), /No newer|already runs/);
  await assert.rejects(new BackroomUpdate({ install: install("global"), lookup: async () => "1.0.0 --prefix=/x", npm }).update("1.0.0 --prefix=/x"), /No newer Backroom/, "only a version npm could name is installed");
  assert.deepEqual(runs, []);
});

test("an installed update stops the copy; a failed one leaves it as it was and says why", async (t) => {
  const m = machine(t);
  const root = m.copy(join(m.globalRoot, NAME), "0.2.0");
  const global: Install = { ...install("global"), root, prefix: join(m.dir, "node") };
  const runs: string[][] = [];
  const stopped: string[] = [];
  let finish = () => {};
  const npm = (args: string[]) => new Promise<void>((resolve) => ((finish = () => (m.copy(root, "0.3.0"), resolve())), runs.push(args)));
  const ok = new BackroomUpdate({ install: global, lookup: async () => "0.3.0", npm, installed: (v) => stopped.push(v), stopDelayMs: 0 });
  assert.equal((await ok.update("0.3.0")).job?.state, "installing");
  await assert.rejects(ok.update("0.3.0"), /already being updated/);
  assert.equal(stopped.length, 0, "nothing stops while npm works");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(runs, [["install", "--global", "--prefix", join(m.dir, "node"), "--no-fund", "--no-audit", `${NAME}@0.3.0`]]);
  assert.equal((await ok.view(false)).job?.state, "restarting");
  assert.deepEqual(stopped, ["0.3.0"]);

  m.copy(root, "0.2.0");
  const failed = new BackroomUpdate({ install: global, lookup: async () => "0.3.0", npm: async () => { throw new Error("npm error code E404"); }, busy: async () => ["Busy in Smoke (a turn)"], installed: (v) => stopped.push(v), stopDelayMs: 0 });
  await failed.update("0.3.0");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const view = await failed.view(false);
  assert.deepEqual([view.version, view.job?.state, view.job?.error, view.canUpdate], ["0.2.0", "failed", "npm error code E404", true]);
  assert.deepEqual([failed.running(), view.busy], [false, ["Busy in Smoke (a turn)"]], "after a failure the update is offered again, naming who works");
  assert.deepEqual(stopped, ["0.3.0"], "a failed install does not stop the copy");
  // npm answering without the new version in the folder is a failure too.
  const unchanged = new BackroomUpdate({ install: global, lookup: async () => "0.3.0", npm: async () => undefined, installed: (v) => stopped.push(v), stopDelayMs: 0 });
  await unchanged.update("0.3.0");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match((await unchanged.view(false)).job?.error ?? "", /holds 0\.2\.0, not 0\.3\.0/);
  assert.equal(stopped.length, 1);
});

test("the status gives this copy's version, and the Updates view carries Backroom's row", async (t) => {
  const stack = await createTestStack(undefined, undefined, { latestRelease: async (name) => (name === NAME ? "99.0.0" : null) });
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-backroom-update", ROOMS_PORT: "0" }, install("global", "0.2.0"));
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const status = (await (await app.request("/api/status")).json()) as { version: string; install: string };
  assert.deepEqual([status.version, status.install], ["0.2.0", "global"]);
  // The stack runs this checkout: its row shows the newest release and says to update with git.
  const updates = (await (await app.request("/api/t3/updates")).json()) as { backroom: { install: string; latest: string; canUpdate: boolean; manual: string } };
  assert.deepEqual([updates.backroom.install, updates.backroom.latest, updates.backroom.canUpdate], ["checkout", "99.0.0", false]);
  assert.match(updates.backroom.manual, /Update it with git/);
  const refused = await app.request("/api/backroom/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetVersion: "99.0.0" }) });
  assert.equal(refused.status, 409);
});

test("the lookup asks the registry npm is pointed at for this run, by the package's own name; an unpublished package has no release", async (t) => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/-/package/agents-backroom/dist-tags") return response.end(JSON.stringify({ latest: "0.3.0", beta: "0.4.0-beta.1" }));
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const before = process.env.npm_config_registry;
  t.after(() => (before === undefined ? delete process.env.npm_config_registry : (process.env.npm_config_registry = before)));
  process.env.npm_config_registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal(await npmDistTag(NAME, "latest"), "0.3.0");
  assert.equal(await npmDistTag(NAME, "beta"), "0.4.0-beta.1");
  assert.equal(await npmDistTag(NAME, "nightly"), null);
  assert.equal(await npmDistTag("@someone/unpublished", "latest"), null);
  assert.deepEqual(paths, ["/-/package/agents-backroom/dist-tags", "/-/package/agents-backroom/dist-tags", "/-/package/agents-backroom/dist-tags", "/-/package/@someone%2funpublished/dist-tags"]);
});
