/**
 * A1, the agents file (src/app/agentsFile.ts): creating a room in a project whose folder has no AGENTS.md writes the
 * default there (and a CLAUDE.md importing it when that is missing too), never over or into a file that is there, and
 * never in a folder that holds others; Backroom writes once per project folder. In a git repository the files stay out
 * of git (the repository's .git/info/exclude, never .gitignore; nothing is committed), and a post-checkout hook copies
 * them into each new worktree. Each project here is a folder this file makes (a git repository unless the test says
 * otherwise) and removes, added to the fake T3.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { AgentsFiles, COPY_LINE, EXCLUDE_END, EXCLUDE_START, HOOK_TEXT, defaultAgentsText, home as accountHome, projectChecks, withExcluded, type AgentsFileWritten as ServerWritten } from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";
import type { CommandResult as ServerResult } from "../src/app/service.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { createHttpApp } from "../src/server/http.ts";
import type * as Web from "../web/src/types.ts";

// The web keeps hand copies of what a room's creation says it wrote, and of the setting's command: `npm run typecheck`
// fails when they drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Array<true> = [
  true satisfies Same<Web.AgentsFileWritten, ServerWritten>,
  true satisfies Same<Extract<Web.CommandResult, { type: "room.created" }>, Extract<ServerResult, { type: "room.created" }>>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "agentsFile.enabled.set" }>, Extract<RoomCommandInput, { type: "agentsFile.enabled.set" }>>,
];

// Backroom's git runs with the process's environment: an identity of the test's own for the test's commits, and none of
// the user's git config (a hooks path there would change where hooks go).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backroom-agents-")));
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const read = (path: string) => readFileSync(path, "utf8");
const commits = (dir: string) => git(dir, "log", "--oneline").trim().split("\n").length;
const status = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=all").trimEnd().split("\n");
const exclude = (repo: string) => read(join(repo, ".git", "info", "exclude"));
/** The entries between Backroom's marker lines in the repository's exclude file. */
const block = (repo: string) => {
  const lines = exclude(repo).split("\n");
  return lines.slice(lines.indexOf(EXCLUDE_START) + 1, lines.indexOf(EXCLUDE_END));
};
const hookOf = (repo: string) => join(repo, ".git", "hooks", "post-checkout");
/** git as this machine has it, for a stand-in that hands most calls on. */
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

let folders = 0;
/** A project folder: a git repository on main with one commit (package.json with scripts), unless `repo` is false. */
function folder(options: { repo?: boolean; files?: Record<string, string> } = {}): string {
  const dir = join(scratch, `project-${++folders}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test", lint: "eslint ." } }));
  for (const [name, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  if (options.repo !== false) {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "First commit");
  }
  return dir;
}

function stackFor(t: TestContext, options: { agentsFile?: boolean; dbPath?: string; fake?: FakeT3Adapter } = {}) {
  const fake = options.fake ?? new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: options.dbPath ?? ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: options.agentsFile ?? true });
  t.after(() => stack.close());
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command)) as Promise<any>;
  const project = (workspaceRoot: string) => {
    const id = `project_${fake.projects.length}`;
    fake.projects.push({ id, title: `p${fake.projects.length}`, workspaceRoot, defaultModelSelection: null });
    return id;
  };
  const room = (projectId: string) => run({ type: "room.create", projectId, title: "work", consigliere: false });
  return { stack, fake, run, project, room };
}

test("the web's copies of what a room's creation wrote, and of the setting's command, match the server's (checked by npm run typecheck)", () => {
  assert.equal(same.length, 3);
});

// ---------------- what is written ----------------

test("neither file: AGENTS.md with the project's checks and a CLAUDE.md importing it, kept out of git, the worktree hook installed, nothing committed", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  const created = await room(project(dir));

  const agents = read(join(dir, "AGENTS.md"));
  assert.equal(agents, defaultAgentsText(["npm run lint", "npm run test"]));
  assert.match(agents, /`npm run lint`, `npm run test`, and whatever else its README asks for/);
  assert.ok(agents.endsWith("\n") && !agents.includes("\r"), "LF line endings and a final newline");
  assert.doesNotMatch(agents, /\/home|\/tmp|127\.0\.0\.1|localhost|Backroom's rooms|Consigliere/, "nothing machine-specific, nothing about routing");
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n", "the bare import line, no copy");
  assert.deepEqual(created.agentsFile, { projectId: "project_1", folder: dir, written: ["AGENTS.md", "CLAUDE.md"], excluded: true, hook: "installed" });

  assert.deepEqual(block(dir), ["/AGENTS.md", "/CLAUDE.md"], "listed in the repository's own exclude file");
  assert.deepEqual(status(dir), [""], "git sees nothing to add");
  assert.equal(existsSync(join(dir, ".gitignore")), false, "no .gitignore written");
  assert.equal(commits(dir), 1, "nothing committed");
  assert.equal(read(hookOf(dir)), HOOK_TEXT);
  assert.ok((statSync(hookOf(dir)).mode & 0o111) !== 0, "the hook runs");
});

test("AGENTS.md there, CLAUDE.md missing: the one-line CLAUDE.md alone, kept out of git", async (t) => {
  const { project, room } = stackFor(t);
  const own = "# Our own habits\n";
  for (const files of [{ "AGENTS.md": own }, { "AGENTS.md": own, "AGENTS.override.md": "# Codex's\n" }]) {
    const dir = folder({ files });
    const created = await room(project(dir));
    assert.equal(read(join(dir, "AGENTS.md")), own, "the project's AGENTS.md is untouched");
    assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
    assert.deepEqual([created.agentsFile.written, created.agentsFile.excluded, created.agentsFile.hook], [["CLAUDE.md"], true, "installed"], JSON.stringify(files));
    assert.deepEqual(block(dir), ["/CLAUDE.md"]);
    assert.deepEqual(status(dir), [""]);
  }
  // A link to the project's AGENTS.md elsewhere in it is a file the import reaches.
  const linked = folder({ files: { "docs/agents.md": own } });
  symlinkSync("docs/agents.md", join(linked, "AGENTS.md"));
  assert.deepEqual((await room(project(linked))).agentsFile.written, ["CLAUDE.md"]);
});

test("AGENTS.md only in other capitals, as AGENTS.override.md, as a link to nowhere or deleted while tracked: nothing is written", async (t) => {
  const { project, room } = stackFor(t);
  for (const files of [{ "agents.md": "# ours\n" }, { "Agents.md": "# ours\n" }, { "AGENTS.override.md": "# ours\n" }]) {
    const dir = folder({ files });
    assert.equal((await room(project(dir))).agentsFile, undefined, JSON.stringify(files));
    for (const [name, text] of Object.entries(files)) assert.equal(read(join(dir, name)), text, `${name} is untouched`);
    assert.deepEqual(status(dir), [""], `nothing new beside ${Object.keys(files).join(", ")}`);
    assert.equal(existsSync(hookOf(dir)), false, "no hook");
  }
  const linked = folder();
  const outside = join(scratch, "outside", "target.md");
  symlinkSync(outside, join(linked, "AGENTS.md"));
  assert.equal((await room(project(linked))).agentsFile, undefined);
  assert.equal(existsSync(outside), false, "the link's target is not created");
  assert.equal(existsSync(join(linked, "CLAUDE.md")), false);
  // Tracked but deleted in the folder: a change in progress, not a missing file.
  const deleted = folder({ files: { "AGENTS.md": "# tracked\n" } });
  unlinkSync(join(deleted, "AGENTS.md"));
  assert.equal((await room(project(deleted))).agentsFile, undefined);
  assert.deepEqual(status(deleted), [" D AGENTS.md"]);
});

test("CLAUDE.md there, in any form, with or without AGENTS.md: the project has its own instructions, and nothing is written", async (t) => {
  const { project, room } = stackFor(t);
  const cases: Array<Record<string, string>> = [
    { "CLAUDE.md": "# Our Claude notes\n\nUse tabs.\n" },
    { "claude.md": "# ours\n" },
    { ".claude/CLAUDE.md": "# ours\n" },
    { "AGENTS.md": "# ours\n", "CLAUDE.md": "# theirs\n" },
  ];
  for (const files of cases) {
    const dir = folder({ files });
    assert.equal((await room(project(dir))).agentsFile, undefined, JSON.stringify(files));
    for (const [name, text] of Object.entries(files)) assert.equal(read(join(dir, name)), text, `${name} is untouched`);
    assert.deepEqual(status(dir), [""], `nothing new beside ${Object.keys(files).join(", ")}`);
    assert.equal(exclude(dir).includes(EXCLUDE_START), false, "the exclude file untouched");
  }
  const linked = folder();
  symlinkSync(join(scratch, "outside", "claude.md"), join(linked, "CLAUDE.md"));
  assert.equal((await room(project(linked))).agentsFile, undefined, "a CLAUDE.md link to nowhere is there too");
  assert.equal(existsSync(join(scratch, "outside")), false, "and is never followed");
  const deleted = folder({ files: { "CLAUDE.md": "# tracked\n" } });
  unlinkSync(join(deleted, "CLAUDE.md"));
  assert.equal((await room(project(deleted))).agentsFile, undefined);
  assert.deepEqual(status(deleted), [" D CLAUDE.md"]);
});

test("a folder that is not a git repository gets the files, with nothing to keep out of git and no hook; a folder not on this machine gets nothing", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder({ repo: false });
  const created = await room(project(dir));
  assert.deepEqual(created.agentsFile, { projectId: "project_1", folder: dir, written: ["AGENTS.md", "CLAUDE.md"], excluded: false, hook: null });
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
  assert.match(read(join(dir, "AGENTS.md")), /`npm run lint`, `npm run test`/);
  assert.equal(existsSync(join(dir, ".git")), false, "no repository made");

  const elsewhere = join(scratch, "not-here");
  assert.equal((await room(project(elsewhere))).agentsFile, undefined);
  assert.equal(existsSync(elsewhere), false, "no folder is made");
});

test("a path that is not absolute is never resolved against Backroom's own folder", async (t) => {
  const { stack } = stackFor(t);
  const files = new AgentsFiles(stack.repos);
  const cwd = process.cwd();
  process.chdir(scratch);
  t.after(() => process.chdir(cwd));
  mkdirSync(join(scratch, "relative"), { recursive: true });
  assert.equal(await files.roomCreated({ id: "p_rel", workspaceRoot: "relative" }), null);
  assert.equal(await files.roomCreated({ id: "p_home", workspaceRoot: "~/relative" }), null);
  assert.equal(existsSync(join(scratch, "relative", "AGENTS.md")), false);
  assert.equal(files.record("p_rel"), null);
});

test("a file that appears between the look and the write is kept byte for byte", async (t) => {
  const { stack } = stackFor(t);
  const theirs = "# Written by someone else in the meantime\n";
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const raced = folder();
    const files = new AgentsFiles(stack.repos, { beforeWrite: (at, file) => file === name && writeFileSync(join(at, name), theirs) });
    const written = await files.roomCreated({ id: `p_race_${name}`, workspaceRoot: raced });
    assert.equal(read(join(raced, name)), theirs, `${name} that appeared is kept`);
    if (name === "AGENTS.md") {
      assert.equal(written, null, "nothing more is written");
      assert.equal(existsSync(join(raced, "CLAUDE.md")), false);
    } else assert.deepEqual(written?.written, ["AGENTS.md"]);
  }
  // The same beside the project's own AGENTS.md: a CLAUDE.md that appears is kept, and nothing is written.
  const own = folder({ files: { "AGENTS.md": "# ours\n" } });
  const files = new AgentsFiles(stack.repos, { beforeWrite: (at, file) => file === "CLAUDE.md" && writeFileSync(join(at, "CLAUDE.md"), theirs) });
  assert.equal(await files.roomCreated({ id: "p_race_own", workspaceRoot: own }), null);
  assert.equal(read(join(own, "CLAUDE.md")), theirs);
});

test("a link to nowhere that appears before the write is never followed", async (t) => {
  const { stack } = stackFor(t);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const dir = folder();
    const outside = join(scratch, `outside-${folders}`, "target.md");
    // The target's folder is there: a write that followed the link would create the target.
    mkdirSync(dirname(outside), { recursive: true });
    const files = new AgentsFiles(stack.repos, { beforeWrite: (at, file) => file === name && symlinkSync(outside, join(at, name)) });
    await files.roomCreated({ id: `p_link_${name}`, workspaceRoot: dir });
    assert.equal(existsSync(outside), false, `${name}: the link's target is not created`);
  }
});

test("a folder Backroom cannot write in, or with no git to run: nothing is written, nothing remembered, and the room is made", async (t) => {
  const { project, room, stack } = stackFor(t);
  const locked = folder();
  chmodSync(locked, 0o555);
  t.after(() => chmodSync(locked, 0o755));
  const lockedId = project(locked);
  const created = await room(lockedId);
  assert.ok(created.roomId);
  assert.equal(created.agentsFile, undefined);
  assert.equal(stack.service.agentsFiles!.record(lockedId), null, "tried again with the next room");

  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
  });
  const gitless = folder();
  process.env.PATH = join(scratch, "no-git-here");
  const gitlessId = project(gitless);
  assert.ok((await room(gitlessId)).roomId);
  process.env.PATH = path;
  assert.equal(existsSync(join(gitless, "AGENTS.md")), false);
  assert.equal(stack.service.agentsFiles!.record(gitlessId), null);
});

test("git cannot say whether the folder is a repository (an ownership refusal): nothing is written, and the next room writes", async (t) => {
  const { project, room, stack } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  // A git that refuses to look at this repository, as git does for one owned by another account.
  const bin = join(scratch, `refusing-git-${++folders}`);
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--show-toplevel" ] && { echo "fatal: detected dubious ownership in repository at '${dir}'" >&2; exit 128; }; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
  });
  process.env.PATH = `${bin}:${path}`;
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  assert.equal(stack.service.agentsFiles!.record(projectId), null, "not recorded as outside git");
  process.env.PATH = path;
  assert.deepEqual((await room(projectId)).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);

  // A worktree whose repository moved: git says "not a git repository: <gitdir>", which is no answer about the folder.
  const orphan = join(scratch, `orphan-${++folders}`);
  mkdirSync(orphan);
  writeFileSync(join(orphan, ".git"), `gitdir: ${join(scratch, "moved-away", ".git", "worktrees", "x")}\n`);
  const orphanId = project(orphan);
  assert.equal((await room(orphanId)).agentsFile, undefined);
  assert.equal(existsSync(join(orphan, "AGENTS.md")), false);
  assert.equal(stack.service.agentsFiles!.record(orphanId), null);
});

test("a folder that holds other projects gets nothing: the reviewer's P1, the home folder and above, a repository directly below", async (t) => {
  const { project, room, stack } = stackFor(t);
  const nothing = (dir: string) => assert.deepEqual(["AGENTS.md", "CLAUDE.md"].filter((name) => existsSync(join(dir, name))), [], dir);

  // P1: a folder outside git with one of T3's projects (a repository) below it.
  const umbrella = join(scratch, `umbrella-${++folders}`);
  mkdirSync(umbrella);
  const child = join(umbrella, "child");
  mkdirSync(child);
  execFileSync("git", ["init", "-q", "-b", "main", child]);
  project(child);
  const umbrellaId = project(umbrella);
  const created = await room(umbrellaId);
  assert.equal(created.type, "room.created");
  assert.equal(created.agentsFile, undefined);
  nothing(umbrella);
  nothing(child);
  assert.equal(stack.service.agentsFiles!.record(umbrellaId), null);

  // Another project below, not a repository, in a folder that is one: still nothing.
  const repo = folder();
  const inner = join(repo, "tools");
  mkdirSync(inner);
  project(inner);
  assert.equal((await room(project(repo))).agentsFile, undefined);
  nothing(repo);

  // Outside git, a repository directly below it, though T3 lists no project there.
  const holder = join(scratch, `holder-${++folders}`);
  mkdirSync(join(holder, "lib"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", join(holder, "lib")]);
  assert.equal((await room(project(holder))).agentsFile, undefined);
  nothing(holder);

  // The home folder and a folder above it (which holds nothing else, so only the home rule keeps it out).
  const home = join(scratch, `above-${++folders}`, "home");
  mkdirSync(join(home, "projects"), { recursive: true });
  const kept = process.env.HOME;
  t.after(() => {
    if (kept === undefined) delete process.env.HOME;
    else process.env.HOME = kept;
  });
  process.env.HOME = home;
  // The folder above first: once the home folder is a project, the folder above would hold one anyway.
  for (const dir of [dirname(home), home]) {
    assert.equal((await room(project(dir))).agentsFile, undefined, dir);
    nothing(dir);
  }
  // A project below the home folder is written in as ever.
  const own = join(home, "projects", "own");
  mkdirSync(own);
  execFileSync("git", ["init", "-q", "-b", "main", own]);
  assert.deepEqual((await room(project(own))).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);

  // A project in a folder whose name starts with two dots is below its folder all the same.
  const dotted = join(scratch, `dotted-${++folders}`);
  mkdirSync(join(dotted, "..old"), { recursive: true });
  project(join(dotted, "..old"));
  assert.equal((await room(project(dotted))).agentsFile, undefined);
  nothing(dotted);
  // A repository one folder further down (clients/acme), outside git and listed nowhere.
  const clients = join(scratch, `clients-${++folders}`);
  mkdirSync(join(clients, "acme", "repo"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", join(clients, "acme", "repo")]);
  // The outer folder first: once acme is a project, clients would hold one anyway.
  assert.equal((await room(project(clients))).agentsFile, undefined, "one folder further down");
  assert.equal((await room(project(join(clients, "acme")))).agentsFile, undefined, "directly below");
  nothing(clients);
});

test("the home folder when HOME is empty or not absolute: the system's record of it", (t) => {
  const kept = process.env.HOME;
  t.after(() => {
    if (kept === undefined) delete process.env.HOME;
    else process.env.HOME = kept;
  });
  for (const value of ["", "relative/home"]) {
    process.env.HOME = value;
    assert.equal(accountHome(), realpathSync(userInfo().homedir), JSON.stringify(value));
  }
});

test("instructions in a folder above the project, up to its repository's top, are the project's own: nothing is written", async (t) => {
  const { project, room } = stackFor(t);
  for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"]) {
    const repo = folder({ files: { [name]: "# the repository's\n", "packages/web/index.html": "<p>hi</p>\n" } });
    const web = join(repo, "packages", "web");
    assert.equal((await room(project(web))).agentsFile, undefined, name);
    assert.equal(existsSync(join(web, "AGENTS.md")) || existsSync(join(web, "CLAUDE.md")), false, name);
  }
  // Above the repository's top is the user's own business, not the project's: a repository inside a folder with one is written in.
  const parent = join(scratch, `parent-${++folders}`);
  mkdirSync(parent);
  writeFileSync(join(parent, "CLAUDE.md"), "# mine\n");
  const inner = join(parent, "inner");
  mkdirSync(inner);
  execFileSync("git", ["init", "-q", "-b", "main", inner]);
  writeFileSync(join(inner, "README.md"), "# inner\n");
  git(inner, "add", ".");
  git(inner, "commit", "-q", "-m", "first");
  assert.deepEqual((await room(project(inner))).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);
});

test("a throwaway service writes only under its own folders; a project with no folder path makes its room all the same", async (t) => {
  const { stack, fake, run } = stackFor(t);
  const inside = folder();
  const outside = folder();
  const files = new AgentsFiles(stack.repos, { onlyUnder: [inside] });
  assert.equal(await files.roomCreated({ id: "p_out", workspaceRoot: outside }), null);
  assert.equal(existsSync(join(outside, "AGENTS.md")), false);
  assert.ok(await files.roomCreated({ id: "p_in", workspaceRoot: inside }));

  fake.projects.push({ id: "p_nopath", title: "nopath", workspaceRoot: undefined as unknown as string, defaultModelSelection: null });
  const created = await run({ type: "room.create", projectId: "p_nopath", title: "work", consigliere: false });
  assert.equal(created.type, "room.created");
  assert.equal(created.agentsFile, undefined);
});

test("Backroom writes once per project folder: a removed file stays removed, also across a restart and a project added again", async (t) => {
  const data = join(scratch, `data-${++folders}`);
  mkdirSync(data);
  const dbPath = join(data, "rooms.sqlite");
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const first = createStack({ dbPath, adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: true });
  const dir = folder();
  fake.projects.push({ id: "p_kept", title: "kept", workspaceRoot: dir, defaultModelSelection: null });
  const create = (stack: ReturnType<typeof createStack>, projectId: string) => stack.service.execute(parseCommand({ type: "room.create", projectId, title: "work", consigliere: false })) as Promise<any>;
  assert.ok((await create(first, "p_kept")).agentsFile);
  assert.equal((await create(first, "p_kept")).agentsFile, undefined, "a second room writes nothing");
  unlinkSync(join(dir, "AGENTS.md"));
  unlinkSync(join(dir, "CLAUDE.md"));
  first.close();

  const second = stackFor(t, { dbPath, fake });
  assert.equal((await second.room("p_kept")).agentsFile, undefined, "after a restart");
  // The project removed from T3 and added again for the same folder: the record goes with it.
  fake.projects.splice(fake.projects.findIndex((p) => p.id === "p_kept"), 1);
  fake.projects.push({ id: "p_again", title: "again", workspaceRoot: dir, defaultModelSelection: null });
  assert.equal((await second.room("p_again")).agentsFile, undefined);
  assert.equal(second.stack.service.agentsFiles!.record("p_again")?.folder, dir);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
});

test("two rooms created at once write the files once", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  const both = await Promise.all([room(projectId), room(projectId)]);
  assert.equal(both.filter((created) => created.agentsFile).length, 1);
  assert.deepEqual(block(dir), ["/AGENTS.md", "/CLAUDE.md"], "listed once");
});

test("consigliere.start creates its room the same way, and writes the same files", async (t) => {
  const { project, run, stack } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  const { presetId } = await run({ type: "preset.create", name: "astra", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", workspaceMode: "local" });
  await run({ type: "consigliere.preset.set", presetId });
  const started = await run({ type: "consigliere.start", projectId, text: "Plan the release", requestId: randomUUID() });
  assert.equal(started.type, "consigliere.started");
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
  assert.deepEqual(stack.service.agentsFiles!.record(projectId)?.written, ["AGENTS.md", "CLAUDE.md"]);
});

test("Backroom's own repository keeps both files out of git, as every project does (the user's #1119, #1814): a room in it writes nothing", async (t) => {
  const { project, room, stack } = stackFor(t);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(git(repo, "ls-files", "--", "AGENTS.md", "CLAUDE.md").trim(), "", "never committed");
  // A checkout without them (a fresh clone) has nothing to say about a room in it.
  if (!existsSync(join(repo, "AGENTS.md"))) return t.skip("this checkout has no agents files");
  assert.equal(read(join(repo, "CLAUDE.md")), "@AGENTS.md\n");
  const projectId = project(repo);
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(stack.service.agentsFiles!.record(projectId), null);
});

// ---------------- kept out of git ----------------

test("the exclude file: Backroom's block added once, every other line kept; a project in a subfolder lists its own paths", async (t) => {
  const { project, room } = stackFor(t);
  const repo = folder({ files: { "web/index.html": "<p>hi</p>\n", "api/main.go": "package main\n" } });
  const theirs = "# git ls-files --others --exclude-from=.git/info/exclude\n*.local\n";
  writeFileSync(join(repo, ".git", "info", "exclude"), theirs);
  assert.deepEqual((await room(project(join(repo, "web")))).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual((await room(project(join(repo, "api")))).agentsFile.hook, "ours", "the hook there already is Backroom's");
  assert.ok(exclude(repo).startsWith(theirs), "the repository's own lines first, as they were");
  assert.deepEqual(block(repo), ["/web/AGENTS.md", "/web/CLAUDE.md", "/api/AGENTS.md", "/api/CLAUDE.md"]);
  assert.equal(exclude(repo).split(EXCLUDE_START).length, 2, "one block");
  assert.deepEqual(status(repo), [""]);
  // The pure function: a block that is there takes what is missing, and nothing twice.
  assert.equal(withExcluded(withExcluded("", ["/A"]), ["/A", "/B"]), `${EXCLUDE_START}\n/A\n/B\n${EXCLUDE_END}\n`);
  // CRLF lines: the block is found all the same, and nothing is listed twice.
  assert.equal(withExcluded(`*.local\r\n${EXCLUDE_START}\r\n/A\r\n${EXCLUDE_END}\r\n`, ["/A", "/B"]), `*.local\r\n${EXCLUDE_START}\r\n/A\r\n/B\n${EXCLUDE_END}\r\n`);
  // A start marker whose end was removed: the end goes back before the first line that is no path.
  assert.equal(withExcluded(`${EXCLUDE_START}\n/A\n*.log\n`, ["/A", "/B"]), `${EXCLUDE_START}\n/A\n/B\n${EXCLUDE_END}\n*.log\n`);
});

test("a repository without an info folder gets one; an exclude file that cannot be written leaves the files visible to git, and says so", async (t) => {
  const { project, room } = stackFor(t);
  const bare = folder();
  rmSync(join(bare, ".git", "info"), { recursive: true, force: true });
  const created = await room(project(bare));
  assert.equal(created.agentsFile.excluded, true);
  assert.deepEqual(block(bare), ["/AGENTS.md", "/CLAUDE.md"]);

  const locked = folder();
  chmodSync(join(locked, ".git", "info", "exclude"), 0o444);
  t.after(() => chmodSync(join(locked, ".git", "info", "exclude"), 0o644));
  const written = await room(project(locked));
  assert.deepEqual([written.agentsFile.written, written.agentsFile.excluded, written.agentsFile.hook], [["AGENTS.md", "CLAUDE.md"], false, "no-exclude"]);
  assert.deepEqual(status(locked), ["?? AGENTS.md", "?? CLAUDE.md"]);
  assert.equal(existsSync(hookOf(locked)), false, "no hook: it would have no block to read");
});

test("a project whose place in its repository cannot be written in the exclude file as it is gets nothing", async (t) => {
  const { project, room } = stackFor(t);
  const repo = folder({ files: { "we[b]/index.html": "<p>hi</p>\n" } });
  assert.equal((await room(project(join(repo, "we[b]")))).agentsFile, undefined);
  assert.equal(existsSync(join(repo, "we[b]", "AGENTS.md")), false);
});

// ---------------- copied into new worktrees ----------------

test("the hook: a worktree added gets the two files from the main checkout; a branch switch does nothing", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  await room(project(dir));
  const worktree = join(scratch, `worktree-${++folders}`);
  git(dir, "worktree", "add", "-q", "-b", "feature", worktree);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) assert.equal(read(join(worktree, name)), read(join(dir, name)), name);
  assert.deepEqual(status(worktree), [""], "kept out of git there too (the exclude file is shared)");
  assert.equal(commits(dir), 1);
  // A branch switch (the previous HEAD is no zeros) copies nothing: a file removed in the worktree stays removed.
  unlinkSync(join(worktree, "AGENTS.md"));
  git(worktree, "checkout", "-q", "-b", "other");
  assert.equal(existsSync(join(worktree, "AGENTS.md")), false);
  git(dir, "checkout", "-q", "-b", "other-main");
  git(dir, "checkout", "-q", "main");
  assert.deepEqual(status(dir), [""]);
});

test("the hook copies a subfolder project's files, and never over a file or a link the new worktree has", async (t) => {
  const { project, room } = stackFor(t);
  const repo = folder({ files: { "web/index.html": "<p>hi</p>\n" } });
  await room(project(join(repo, "web")));
  // A branch where the project tracks an AGENTS.md of its own, and a CLAUDE.md that is a link.
  git(repo, "checkout", "-q", "-b", "own");
  const branchAgents = "# the branch's own\n";
  rmSync(join(repo, "web", "AGENTS.md"));
  rmSync(join(repo, "web", "CLAUDE.md"));
  writeFileSync(join(repo, "web", "AGENTS.md"), branchAgents);
  symlinkSync("AGENTS.md", join(repo, "web", "CLAUDE.md"));
  git(repo, "add", "-f", "web/AGENTS.md", "web/CLAUDE.md");
  git(repo, "commit", "-q", "-m", "own instructions");
  git(repo, "checkout", "-q", "main");
  // Back on main the tracked files are gone from the folder: Backroom's are put back as they were for this check.
  writeFileSync(join(repo, "web", "AGENTS.md"), defaultAgentsText(["npm run lint", "npm run test"]));
  writeFileSync(join(repo, "web", "CLAUDE.md"), "@AGENTS.md\n");

  const plain = join(scratch, `worktree-${++folders}`);
  git(repo, "worktree", "add", "-q", "-b", "plain", plain, "main");
  assert.equal(read(join(plain, "web", "AGENTS.md")), read(join(repo, "web", "AGENTS.md")));
  assert.equal(read(join(plain, "web", "CLAUDE.md")), "@AGENTS.md\n");

  const kept = join(scratch, `worktree-${++folders}`);
  git(repo, "worktree", "add", "-q", kept, "own");
  assert.equal(read(join(kept, "web", "AGENTS.md")), branchAgents, "the branch's own AGENTS.md is not written over");
  assert.ok(statSync(join(kept, "web", "CLAUDE.md")).isFile() && read(join(kept, "web", "CLAUDE.md")) === branchAgents, "the branch's CLAUDE.md link is not written over");
});

test("the hook with a CRLF exclude file, a subfolder named -web, and a worktree whose ref lacks the folder: copies what it can and never fails", async (t) => {
  const { project, room } = stackFor(t);
  const crlf = folder();
  writeFileSync(join(crlf, ".git", "info", "exclude"), "# theirs\r\n*.local\r\n");
  await room(project(crlf));
  const crlfTree = join(scratch, `worktree-${++folders}`);
  git(crlf, "worktree", "add", "-q", "-b", "crlf", crlfTree);
  assert.equal(read(join(crlfTree, "CLAUDE.md")), "@AGENTS.md\n");

  const dashed = folder({ files: { "-web/index.html": "<p>hi</p>\n" } });
  await room(project(join(dashed, "-web")));
  const dashedTree = join(scratch, `worktree-${++folders}`);
  git(dashed, "worktree", "add", "-q", "-b", "dashed", dashedTree);
  assert.equal(read(join(dashedTree, "-web", "CLAUDE.md")), "@AGENTS.md\n");

  // web/ came in a later commit: a worktree of the first commit has no web/, and git worktree add still succeeds,
  // with Backroom's hook and with the copy line at the end of a hook of the repository's own.
  const late = folder();
  mkdirSync(join(late, "web"));
  writeFileSync(join(late, "web", "index.html"), "<p>hi</p>\n");
  git(late, "add", ".");
  git(late, "commit", "-q", "-m", "web");
  await room(project(join(late, "web")));
  const old = join(scratch, `worktree-${++folders}`);
  execFileSync("git", ["-C", late, "worktree", "add", "-q", "-b", "old", old, "HEAD~1"], { encoding: "utf8" });
  assert.equal(existsSync(join(old, "web")), false);
  writeFileSync(hookOf(late), `#!/bin/sh\necho theirs >/dev/null\n${COPY_LINE}\n`, { mode: 0o755 });
  const older = join(scratch, `worktree-${++folders}`);
  const out = execFileSync("git", ["-C", late, "worktree", "add", "-q", "-b", "older", older, "HEAD~1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(out, "");
  // And a second project in that repository finds the copy line there: Backroom's own, nothing more to add.
  mkdirSync(join(late, "api"));
  writeFileSync(join(late, "api", "main.go"), "package main\n");
  git(late, "add", ".");
  git(late, "commit", "-q", "-m", "api");
  assert.equal((await room(project(join(late, "api")))).agentsFile.hook, "ours");
});

test("the hook never copies through a link to nowhere the new worktree has", async (t) => {
  const { project, room } = stackFor(t);
  const repo = folder();
  await room(project(repo));
  const target = join(scratch, `nowhere-${++folders}`, "CLAUDE.md");
  mkdirSync(dirname(target));
  git(repo, "checkout", "-q", "-b", "linked");
  rmSync(join(repo, "CLAUDE.md"));
  symlinkSync(target, join(repo, "CLAUDE.md"));
  git(repo, "add", "-f", "CLAUDE.md");
  git(repo, "commit", "-q", "-m", "a link");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
  const tree = join(scratch, `worktree-${++folders}`);
  git(repo, "worktree", "add", "-q", tree, "linked");
  assert.equal(existsSync(target), false, "the link's target is not created");
  assert.equal(read(join(tree, "AGENTS.md")), read(join(repo, "AGENTS.md")));
});

test("a repository with a post-checkout hook of its own keeps it untouched; README's copy line added to it copies the files", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  const theirs = "#!/bin/sh\necho 'their own hook'\n";
  writeFileSync(hookOf(dir), theirs, { mode: 0o755 });
  const created = await room(project(dir));
  assert.deepEqual([created.agentsFile.excluded, created.agentsFile.hook], [true, "own-hook"]);
  assert.equal(read(hookOf(dir)), theirs, "byte for byte");
  const without = join(scratch, `worktree-${++folders}`);
  git(dir, "worktree", "add", "-q", "-b", "without", without);
  assert.equal(existsSync(join(without, "AGENTS.md")), false, "nothing copied by a hook that is not Backroom's");

  // The line README gives, added by hand.
  writeFileSync(hookOf(dir), `${theirs}${COPY_LINE}\n`, { mode: 0o755 });
  const withLine = join(scratch, `worktree-${++folders}`);
  git(dir, "worktree", "add", "-q", "-b", "with-line", withLine);
  assert.equal(read(join(withLine, "AGENTS.md")), read(join(dir, "AGENTS.md")));
  assert.equal(read(join(withLine, "CLAUDE.md")), "@AGENTS.md\n");
});

test("a repository that sets core.hooksPath gets no hook; a hooks folder git refuses to write in gets none either", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  git(dir, "config", "core.hooksPath", ".githooks");
  const created = await room(project(dir));
  assert.deepEqual([created.agentsFile.excluded, created.agentsFile.hook], [true, "hooks-path"]);
  assert.equal(existsSync(hookOf(dir)), false);
  assert.equal(existsSync(join(dir, ".githooks")), false, "nothing made in the hooks path either");

  // A hooks path inside .git, where the hooks folder's own place would still pass: refused by the setting itself.
  const inside = folder();
  git(inside, "config", "core.hooksPath", ".git/custom-hooks");
  assert.equal((await room(project(inside))).agentsFile.hook, "hooks-path");
  assert.equal(existsSync(join(inside, ".git", "custom-hooks")), false, "nothing made there");
  assert.equal(existsSync(hookOf(inside)), false);

  // Set to nothing, which points git's hooks at the checkout itself: no post-checkout there either.
  const empty = folder();
  git(empty, "config", "core.hooksPath", "");
  assert.equal((await room(project(empty))).agentsFile.hook, "hooks-path");
  assert.equal(existsSync(join(empty, "post-checkout")), false);
  assert.equal(existsSync(hookOf(empty)), false);

  const locked = folder();
  chmodSync(join(locked, ".git", "hooks"), 0o555);
  t.after(() => chmodSync(join(locked, ".git", "hooks"), 0o755));
  const failed = await room(project(locked));
  assert.deepEqual([failed.agentsFile.written, failed.agentsFile.excluded, failed.agentsFile.hook], [["AGENTS.md", "CLAUDE.md"], true, "failed"]);

  // No hooks folder at all: made, inside .git. A post-checkout that is a link to nowhere: the repository's own.
  const noHooks = folder();
  rmSync(join(noHooks, ".git", "hooks"), { recursive: true, force: true });
  assert.equal((await room(project(noHooks))).agentsFile.hook, "installed");
  assert.equal(read(hookOf(noHooks)), HOOK_TEXT);
  const dangling = folder();
  symlinkSync(join(scratch, "their-hooks", "post-checkout"), hookOf(dangling));
  assert.equal((await room(project(dangling))).agentsFile.hook, "own-hook");
  assert.equal(existsSync(join(scratch, "their-hooks")), false, "the link is left alone");
});

test("a project that is not its repository's main checkout (a linked worktree, a submodule) gets the files kept out of git, and no hook", async (t) => {
  const { project, room } = stackFor(t);
  const repo = folder();
  const linked = join(scratch, `linked-${++folders}`);
  git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  const created = await room(project(linked));
  assert.deepEqual([created.agentsFile.written, created.agentsFile.excluded, created.agentsFile.hook], [["AGENTS.md", "CLAUDE.md"], true, "not-main"]);
  assert.deepEqual(block(repo), ["/AGENTS.md", "/CLAUDE.md"], "the shared exclude file");
  assert.deepEqual(status(linked), [""]);
  assert.equal(existsSync(hookOf(repo)), false);

  const sub = folder();
  const superproject = folder();
  execFileSync("git", ["-C", superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"], { stdio: "ignore" });
  const created2 = await room(project(join(superproject, "sub")));
  assert.deepEqual([created2.agentsFile.excluded, created2.agentsFile.hook], [true, "not-main"]);
  assert.deepEqual(status(join(superproject, "sub")), [""], "kept out of git in the submodule's own exclude file");
  assert.equal(existsSync(join(superproject, ".git", "modules", "sub", "hooks", "post-checkout")), false);
});

test("the hook's line is README's: one source, and README says what is written, where, and what never is", () => {
  const readme = read(resolve(dirname(fileURLToPath(import.meta.url)), "..", "README.md"));
  assert.ok(HOOK_TEXT.includes(`\n${COPY_LINE}\n`), "the installed hook runs the copy line");
  assert.ok(readme.includes(COPY_LINE), "README gives the copy line as the hook has it");
  for (const phrase of [".git/info/exclude", "post-checkout", "core.hooksPath", "never commits", "never edits `.gitignore`", "the home folder or one above it"]) assert.ok(readme.includes(phrase), phrase);
});

test("off: Settings → Agents file off writes nothing until it is on again; a stack without it never writes", async (t) => {
  const { project, room, run, stack } = stackFor(t);
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(scratch, "data"), ROOMS_PORT: "0" }), "/nonexistent/dist");
  const setting = async () => ((await (await app.request("/api/settings")).json()) as { agentsFile: boolean }).agentsFile;
  assert.equal(await setting(), true, "on by default");
  assert.equal((await run({ type: "agentsFile.enabled.set", enabled: false })).type, "settings.updated");
  assert.equal(await setting(), false);
  const dir = folder();
  const projectId = project(dir);
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  assert.equal(existsSync(hookOf(dir)), false);
  assert.equal(stack.service.agentsFiles!.record(projectId), null, "nothing remembered: turned on again, the next room writes");
  await run({ type: "agentsFile.enabled.set", enabled: true });
  assert.equal(await setting(), true);
  assert.deepEqual((await room(projectId)).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);

  const without = stackFor(t, { agentsFile: false });
  const other = folder();
  assert.equal((await without.room(without.project(other))).agentsFile, undefined);
  assert.equal(existsSync(join(other, "AGENTS.md")), false);
});

test("the fake T3's demo project takes its folder from the caller; /tmp/demo by default", () => {
  assert.equal(new FakeT3Adapter().projects[0]!.workspaceRoot, "/tmp/demo");
  assert.equal(new FakeT3Adapter({ projectRoot: "/x/scratch" }).projects[0]!.workspaceRoot, "/x/scratch");
});

test("the project's checks: package scripts with its package manager, and make targets", () => {
  const dir = (files: Record<string, string>) => {
    const path = join(scratch, `checks-${++folders}`);
    mkdirSync(path, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
    return path;
  };
  assert.deepEqual(projectChecks(dir({ "package.json": JSON.stringify({ scripts: { check: "tsc && node --test", test: "node --test" } }) })), ["npm run check"]);
  assert.deepEqual(projectChecks(dir({ "package.json": JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc", build: "vite build" } }), "pnpm-lock.yaml": "" })), ["pnpm run typecheck", "pnpm run test"]);
  assert.deepEqual(projectChecks(dir({ Makefile: "CC := cc\nlint:\n\truff .\ntest: build\n\tpytest\n" })), ["make lint", "make test"]);
  assert.deepEqual(projectChecks(dir({ "package.json": "not json", "README.md": "# hi\n" })), []);
  assert.match(defaultAgentsText([]), /the ones its README or package scripts name/);
});

test("the default text, with checks and without: the session, scope, shared-checkout, commit, role and report habits, under twenty lines, nothing of a model, a harness, Backroom's own work or another project's", () => {
  for (const text of [defaultAgentsText(["npm run check"]), defaultAgentsText([])]) {
    const lines = text.split("\n");
    assert.ok(lines.length - 1 < 20, `under twenty lines (has ${lines.length - 1})`);
    assert.equal(lines[0], "# Working in this project");
    assert.match(lines.at(-2) ?? "", /^Backroom wrote this file .* Backroom never changes it\.$/, "the closing line");
    for (const [habit, pattern] of [
      ["keep going without a decision", /Keep going while a step needs no decision from the user/],
      ["stop before what is hard to undo", /Stop and ask before anything hard to undo: rewriting published history, deleting runtime state, merging to the default branch, tagging or releasing/],
      ["read the owner and its tests first", /Read the code that owns a behaviour and its tests before you change it/],
      ["fix at the owner, keep to the task", /fix a problem at its owner, keep the change to the task/],
      ["docs made untrue, in the same change", /update in the same change the docs it makes untrue/],
      ["a worktree of its own in a shared checkout", /When another agent works in the same checkout, work in a worktree of your own; before you finish, merge what you keep into the branch you were given, and remove the worktrees you no longer need/],
      ["commits", /Commit on your own branch; merge into the default branch only when it is the branch you were given or you were asked\. The user releases/],
      ["the writer", /\n- A writer delivers the change committed, with its tests and the checks it ran\.\n/],
      ["the reviewer", /\n- A reviewer reads the diff, runs the checks and answers pass or fail, each fail naming the file, the line and how to show it fails\.\n/],
      ["the planner", /\n- A planner delivers steps that each name their files and how they are verified, so anyone can start one from the plan alone\.\n/],
      ["self-review", /Before you report ready, review your own diff and fix what it finds/],
      ["finding to test", /Turn every review finding into a test that fails without the fix/],
      ["the checks", /Run the project's checks before you report ready: /],
      ["no status files", /Write no separate status or report files unless asked/],
      ["the Handoff", /End every answer with a Handoff/],
    ] as const) assert.match(text, pattern, habit);
    assert.doesNotMatch(text, /subagent|sub-agent|\btiers?\b|\bmodels?\b|harness|workflow|Claude|Codex|Cursor|Gemini|GPT|Opus|Sonnet|Haiku|Fable/i, "no model, tier, harness or subagent named");
    assert.doesNotMatch(text, /build:web|rehears|rooms-board|Consigliere|\bwaves?\b|partition|licen[cs]e|SPDX|Co-Authored-By/i, "nothing of Backroom's own work or Shop's");
  }
});
