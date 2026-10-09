/**
 * A1, the agents file (src/app/agentsFile.ts): creating a room in a project whose folder has no AGENTS.md writes the
 * default there (and a CLAUDE.md importing it when that is missing too), never over or into a file that is there;
 * Backroom writes once per project folder; in a git repository the user is asked once whether to commit it, and the
 * answer is remembered. Each project here is a folder this file makes (a git repository unless the test says
 * otherwise) and removes, added to the fake T3; nothing is pushed anywhere.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { AgentsFiles, defaultAgentsText, projectChecks, type AgentsFileQuestion as ServerQuestion } from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";
import type { CommandResult as ServerResult } from "../src/app/service.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { createHttpApp } from "../src/server/http.ts";
import type * as Web from "../web/src/types.ts";

// The web keeps hand copies of the question and the answer's result: `npm run typecheck` fails when they drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Array<true> = [
  true satisfies Same<Web.AgentsFileQuestion, ServerQuestion>,
  true satisfies Same<Extract<Web.CommandResult, { type: "project.agentsFile.answered" }>, Extract<ServerResult, { type: "project.agentsFile.answered" }>>,
  true satisfies Same<Extract<Web.CommandResult, { type: "room.created" }>, Extract<ServerResult, { type: "room.created" }>>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "project.agentsFile.answer" }>, Extract<RoomCommandInput, { type: "project.agentsFile.answer" }>>,
];

// Backroom's git runs with the process's environment: an identity of the test's own, and none of the user's git config
// (a signing key or a hooks path there would change what a commit does).
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
const status = (dir: string) => git(dir, "status", "--porcelain").trimEnd().split("\n");

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
  const stack = createStack({ dbPath: options.dbPath ?? ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: (options.agentsFile ?? true) && { questionsCacheMs: 0 } });
  t.after(() => stack.close());
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command)) as Promise<any>;
  let projects = 0;
  const project = (workspaceRoot: string) => {
    const id = `project_${++projects}`;
    fake.projects.push({ id, title: `p${projects}`, workspaceRoot, defaultModelSelection: null });
    return id;
  };
  const room = (projectId: string) => run({ type: "room.create", projectId, title: "work", consigliere: false });
  const questions = () => stack.service.agentsFiles!.questions();
  return { stack, fake, run, project, room, questions };
}

test("the web's copies of the question, the answer and its result match the server's (checked by npm run typecheck)", () => {
  assert.equal(same.length, 4);
});

// ---------------- what is written ----------------

test("neither file: AGENTS.md with the project's checks, a CLAUDE.md importing it, and the question", async (t) => {
  const { project, room, questions } = stackFor(t);
  const dir = folder();
  const created = await room(project(dir));

  const agents = read(join(dir, "AGENTS.md"));
  assert.equal(agents, defaultAgentsText(["npm run lint", "npm run test"]));
  assert.match(agents, /`npm run lint`, `npm run test`, and whatever else its README asks for/);
  assert.ok(agents.endsWith("\n") && !agents.includes("\r"), "LF line endings and a final newline");
  assert.doesNotMatch(agents, /\/home|\/tmp|127\.0\.0\.1|localhost|Backroom's rooms|Consigliere/, "nothing machine-specific, nothing about routing");
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n", "the bare import line, no copy");
  assert.deepEqual(created.agentsFile, {
    projectId: "project_1",
    folder: dir,
    files: ["AGENTS.md", "CLAUDE.md"],
    branch: "main",
    ignored: [],
    blocked: null,
    text: agents,
    error: null,
  });
  assert.deepEqual(await questions(), [created.agentsFile], "the question stays open until it is answered");
  assert.equal(commits(dir), 1, "nothing is committed, or staged, before the answer");
  assert.deepEqual(status(dir), ["?? AGENTS.md", "?? CLAUDE.md"]);
});

test("AGENTS.md there, CLAUDE.md missing: the one-line CLAUDE.md alone, importing the project's own, in the same question", async (t) => {
  const { project, room, run } = stackFor(t);
  const own = "# Our own habits\n";
  for (const files of [{ "AGENTS.md": own }, { "AGENTS.md": own, "AGENTS.override.md": "# Codex's\n" }]) {
    const dir = folder({ files });
    const projectId = project(dir);
    const created = await room(projectId);
    assert.equal(read(join(dir, "AGENTS.md")), own, "the project's AGENTS.md is untouched");
    assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
    assert.deepEqual([created.agentsFile.files, created.agentsFile.text], [["CLAUDE.md"], own], JSON.stringify(files));
    assert.deepEqual(status(dir), ["?? CLAUDE.md"]);
    await run({ type: "project.agentsFile.answer", projectId, commit: true });
    assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["CLAUDE.md"]);
  }
  // A link to the project's AGENTS.md elsewhere in it is a file the import reaches.
  const linked = folder({ files: { "docs/agents.md": own } });
  symlinkSync("docs/agents.md", join(linked, "AGENTS.md"));
  assert.deepEqual((await room(project(linked))).agentsFile.files, ["CLAUDE.md"]);
});

test("AGENTS.md only in other capitals, as AGENTS.override.md, as a link to nowhere or deleted while tracked: nothing is written", async (t) => {
  const { project, room, questions } = stackFor(t);
  for (const files of [{ "agents.md": "# ours\n" }, { "Agents.md": "# ours\n" }, { "AGENTS.override.md": "# ours\n" }]) {
    const dir = folder({ files });
    assert.equal((await room(project(dir))).agentsFile, undefined, JSON.stringify(files));
    for (const [name, text] of Object.entries(files)) assert.equal(read(join(dir, name)), text, `${name} is untouched`);
    assert.deepEqual(status(dir), [""], `nothing new beside ${Object.keys(files).join(", ")}`);
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
  assert.deepEqual(await questions(), []);
});

test("CLAUDE.md there, in any form, with or without AGENTS.md: the project has its own instructions, and nothing is written", async (t) => {
  const { project, room, questions } = stackFor(t);
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
  }
  const linked = folder();
  symlinkSync(join(scratch, "outside", "claude.md"), join(linked, "CLAUDE.md"));
  assert.equal((await room(project(linked))).agentsFile, undefined, "a CLAUDE.md link to nowhere is there too");
  assert.equal(existsSync(join(scratch, "outside")), false, "and is never followed");
  const deleted = folder({ files: { "CLAUDE.md": "# tracked\n" } });
  unlinkSync(join(deleted, "CLAUDE.md"));
  assert.equal((await room(project(deleted))).agentsFile, undefined);
  assert.deepEqual(status(deleted), [" D CLAUDE.md"]);
  assert.deepEqual(await questions(), []);
});

test("a folder that is not a git repository gets the files and no question; a folder not on this machine gets nothing", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const dir = folder({ repo: false });
  const projectId = project(dir);
  const created = await room(projectId);
  assert.equal(created.agentsFile, undefined, "nothing to commit, so nothing to ask");
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
  assert.match(read(join(dir, "AGENTS.md")), /`npm run lint`, `npm run test`/);
  assert.deepEqual(await questions(), []);
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /wrote no agents file in this project's repository/);

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
    const question = await files.roomCreated({ id: `p_race_${name}`, workspaceRoot: raced });
    assert.equal(read(join(raced, name)), theirs, `${name} that appeared is kept`);
    if (name === "AGENTS.md") {
      assert.equal(question, null, "nothing more is written, nothing asked");
      assert.equal(existsSync(join(raced, "CLAUDE.md")), false);
    } else assert.deepEqual(question?.files, ["AGENTS.md"]);
  }
  // The same beside the project's own AGENTS.md: a CLAUDE.md that appears is kept, and nothing is written or asked.
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

test("instructions in a folder above the project, up to its repository's top, are the project's own: nothing is written", async (t) => {
  const { project, room, questions } = stackFor(t);
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
  assert.deepEqual((await room(project(inner))).agentsFile.files, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal((await questions()).length, 1);
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

test("a project folder git ignores as a whole: the files are written, and the question says nothing can be committed", async (t) => {
  const { project, room, run } = stackFor(t);
  const repo = folder({ files: { ".gitignore": "web/\n", "web/index.html": "<p>hi</p>\n" } });
  const projectId = project(join(repo, "web"));
  const created = await room(projectId);
  assert.deepEqual([created.agentsFile.files, created.agentsFile.ignored], [["AGENTS.md", "CLAUDE.md"], ["AGENTS.md", "CLAUDE.md"]]);
  assert.match(created.agentsFile.blocked, /are ignored by git here/);
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /ignored by git here/);
  assert.equal(commits(repo), 1);
});

test("a room created while a commit runs in its project does not wait for it", async (t) => {
  const { project, room, run } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 2\n");
  chmodSync(hook, 0o755);
  const committing = run({ type: "project.agentsFile.answer", projectId, commit: true });
  await new Promise((done) => setTimeout(done, 200));
  const started = Date.now();
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.ok(Date.now() - started < 1000, `the room took ${Date.now() - started} ms`);
  assert.equal((await committing).answer, "commit");
});

test("Backroom writes once per project folder: a removed file stays removed, and nothing is asked again", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  assert.ok((await room(projectId)).agentsFile);
  assert.equal((await room(projectId)).agentsFile, undefined, "a second room while the question is open asks nothing");
  unlinkSync(join(dir, "AGENTS.md"));
  unlinkSync(join(dir, "CLAUDE.md"));
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
});

test("two rooms created at once write the files once and ask once", async (t) => {
  const { project, room } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  const both = await Promise.all([room(projectId), room(projectId)]);
  assert.equal(both.filter((created) => created.agentsFile).length, 1);
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
});

test("consigliere.start creates its room the same way, and writes the same files", async (t) => {
  const { project, run, questions } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  const { presetId } = await run({ type: "preset.create", name: "astra", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", workspaceMode: "local" });
  await run({ type: "consigliere.preset.set", presetId });
  const started = await run({ type: "consigliere.start", projectId, text: "Plan the release", requestId: randomUUID() });
  assert.equal(started.type, "consigliere.started");
  assert.equal(read(join(dir, "CLAUDE.md")), "@AGENTS.md\n");
  assert.deepEqual((await questions()).map((q) => [q.projectId, q.files]), [[projectId, ["AGENTS.md", "CLAUDE.md"]]]);
});

test("Backroom's own repository has both files: a room in it writes nothing", async (t) => {
  const { project, room, questions, stack } = stackFor(t);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(read(join(repo, "CLAUDE.md")), "@AGENTS.md\n");
  assert.ok(existsSync(join(repo, "AGENTS.md")));
  const projectId = project(repo);
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(stack.service.agentsFiles!.record(projectId), null);
  assert.deepEqual(await questions(), []);
});

// ---------------- the commit question ----------------

test("Commit: one commit of the files Backroom wrote; the user's staged and unstaged changes stay as they were", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const dir = folder({ files: { "src.txt": "one\n" } });
  const projectId = project(dir);
  await room(projectId);
  // The user's own work in progress: a staged change, an unstaged change and an untracked file.
  writeFileSync(join(dir, "package.json"), "{}\n");
  git(dir, "add", "package.json");
  writeFileSync(join(dir, "src.txt"), "two\n");
  writeFileSync(join(dir, "notes.txt"), "mine\n");

  const answered = await run({ type: "project.agentsFile.answer", projectId, commit: true });
  assert.deepEqual([answered.type, answered.answer, answered.commit], ["project.agentsFile.answered", "commit", git(dir, "rev-parse", "HEAD").trim()]);
  assert.deepEqual(git(dir, "diff", "--name-status", "HEAD~1", "HEAD").trim().split("\n"), ["A\tAGENTS.md", "A\tCLAUDE.md"], "the commit adds the two files and nothing else");
  assert.equal(git(dir, "show", "HEAD:CLAUDE.md"), "@AGENTS.md\n");
  assert.match(git(dir, "log", "-1", "--format=%s%n%an%n%b"), /^Add AGENTS\.md and CLAUDE\.md, written by Backroom\nTester\nAGENTS\.md: the habits/);
  assert.doesNotMatch(git(dir, "log", "-1", "--format=%B"), /Co-authored-by/i);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "on the branch checked out there");
  assert.deepEqual(status(dir), ["M  package.json", " M src.txt", "?? notes.txt"], "staged still staged, unstaged still unstaged");

  assert.deepEqual(await questions(), []);
  const again = await run({ type: "project.agentsFile.answer", projectId, commit: false });
  assert.deepEqual([again.answer, again.commit], ["commit", answered.commit], "the first answer is the one remembered");
  assert.equal((await room(projectId)).agentsFile, undefined);
  assert.equal(commits(dir), 2);
});

test("Commit never pushes: a repository with a remote keeps the remote's refs", async (t) => {
  const { project, room, run } = stackFor(t);
  const dir = folder();
  const remote = join(scratch, `remote-${folders}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  const before = git(remote, "for-each-ref");
  const projectId = project(dir);
  await room(projectId);
  await run({ type: "project.agentsFile.answer", projectId, commit: true });
  assert.equal(git(remote, "for-each-ref"), before);
  assert.match(git(dir, "status", "-sb").split("\n")[0]!, /\[ahead 1\]/);
});

test("the files as they are when the answer comes: changed is committed as changed, removed means nothing to commit", async (t) => {
  const { project, room, run } = stackFor(t);
  const changed = folder();
  const changedId = project(changed);
  await room(changedId);
  writeFileSync(join(changed, "AGENTS.md"), "# Edited before the answer\n");
  await run({ type: "project.agentsFile.answer", projectId: changedId, commit: true });
  assert.equal(git(changed, "show", "HEAD:AGENTS.md"), "# Edited before the answer\n");

  const removed = folder();
  const removedId = project(removed);
  await room(removedId);
  unlinkSync(join(removed, "AGENTS.md"));
  unlinkSync(join(removed, "CLAUDE.md"));
  const answered = await run({ type: "project.agentsFile.answer", projectId: removedId, commit: true });
  assert.deepEqual([answered.answer, answered.commit], ["commit", null]);
  assert.equal(commits(removed), 1, "no empty commit");
});

test("Leave uncommitted: the files stay untracked, and the answer is remembered", async (t) => {
  const { project, room, run, stack, questions } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const answered = await run({ type: "project.agentsFile.answer", projectId, commit: false });
  assert.deepEqual([answered.answer, answered.commit], ["leave", null]);
  assert.deepEqual(status(dir), ["?? AGENTS.md", "?? CLAUDE.md"]);
  assert.equal(commits(dir), 1);
  assert.equal(new AgentsFiles(stack.repos).record(projectId)?.answer, "leave");
  assert.deepEqual(await questions(), []);
  assert.equal((await room(projectId)).agentsFile, undefined);
});

test("the question and its answer survive a restart; deleting the room leaves the question to the project", async (t) => {
  const data = join(scratch, `data-${++folders}`);
  mkdirSync(data);
  const dbPath = join(data, "rooms.sqlite");
  const dir = folder();
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const open = () => createStack({ dbPath, adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: true });
  const first = open();
  fake.projects.push({ id: "p_kept", title: "kept", workspaceRoot: dir, defaultModelSelection: null });
  const created = (await first.service.execute(parseCommand({ type: "room.create", projectId: "p_kept", title: "work", consigliere: false }))) as { roomId: string };
  await first.service.execute(parseCommand({ type: "room.delete", roomId: created.roomId }));
  assert.deepEqual((await first.service.agentsFiles!.questions()).map((q) => q.projectId), ["p_kept"], "the question is the project's, not the room's");
  first.close();

  const second = open();
  assert.deepEqual((await second.service.agentsFiles!.questions()).map((q) => q.projectId), ["p_kept"], "still open after a restart");
  await second.service.execute(parseCommand({ type: "project.agentsFile.answer", projectId: "p_kept", commit: false }));
  second.close();
  const third = stackFor(t, { dbPath, fake });
  assert.equal(third.stack.service.agentsFiles!.record("p_kept")?.answer, "leave");
  assert.equal((await third.room("p_kept")).agentsFile, undefined);
});

test("a project removed from T3 and added again for the same folder takes over the record and its open question", async (t) => {
  const { fake, project, room, run, questions } = stackFor(t);
  const dir = folder();
  const oldId = project(dir);
  await room(oldId);
  fake.projects.splice(fake.projects.findIndex((p) => p.id === oldId), 1);
  unlinkSync(join(dir, "CLAUDE.md"));
  const newId = project(dir);
  assert.notEqual(newId, oldId);
  assert.equal((await room(newId)).agentsFile, undefined, "nothing written again, nothing asked again");
  assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
  assert.deepEqual((await questions()).map((q) => [q.projectId, q.files]), [[newId, ["AGENTS.md"]]]);
  assert.equal((await run({ type: "project.agentsFile.answer", projectId: newId, commit: true })).answer, "commit");
});

test("no commit while git is mid-operation or on a detached HEAD: the question stays open and says why", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const answer = (projectId: string) => run({ type: "project.agentsFile.answer", projectId, commit: true });

  const detached = folder();
  const detachedId = project(detached);
  await room(detachedId);
  git(detached, "checkout", "-q", "--detach");
  await assert.rejects(answer(detachedId), /has no branch checked out \(a detached HEAD\)/);

  const merging = folder({ files: { "a.txt": "base\n" } });
  const mergingId = project(merging);
  await room(mergingId);
  git(merging, "checkout", "-q", "-b", "other");
  writeFileSync(join(merging, "a.txt"), "theirs\n");
  git(merging, "commit", "-q", "-am", "theirs");
  git(merging, "checkout", "-q", "main");
  writeFileSync(join(merging, "a.txt"), "ours\n");
  git(merging, "commit", "-q", "-am", "ours");
  assert.throws(() => git(merging, "merge", "-q", "other"));
  await assert.rejects(answer(mergingId), /A merge is in progress/);

  const bisecting = folder();
  const bisectingId = project(bisecting);
  await room(bisectingId);
  git(bisecting, "bisect", "start");
  await assert.rejects(answer(bisectingId), /A bisect is in progress/);

  /** A repository whose main and side branch change a.txt each their own way, with the files written in it. */
  const diverged = async () => {
    const dir = folder({ files: { "a.txt": "base\n" } });
    const id = project(dir);
    await room(id);
    git(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "a.txt"), "side\n");
    git(dir, "commit", "-q", "-am", "side");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "main\n");
    git(dir, "commit", "-q", "-am", "main");
    return { dir, id };
  };
  const rebasing = await diverged();
  git(rebasing.dir, "checkout", "-q", "side");
  assert.throws(() => git(rebasing.dir, "rebase", "main"));
  await assert.rejects(answer(rebasing.id), /A rebase is in progress/);
  const picking = await diverged();
  assert.throws(() => git(picking.dir, "cherry-pick", "side"));
  await assert.rejects(answer(picking.id), /A cherry-pick is in progress/);
  const reverting = await diverged();
  writeFileSync(join(reverting.dir, "a.txt"), "later\n");
  git(reverting.dir, "commit", "-q", "-am", "later");
  assert.throws(() => git(reverting.dir, "revert", "--no-edit", "HEAD~1"));
  await assert.rejects(answer(reverting.id), /A revert is in progress/);
  // Conflicts with no operation recorded: a stash put back over a change of its own.
  const stashed = await diverged();
  writeFileSync(join(stashed.dir, "a.txt"), "stashed\n");
  git(stashed.dir, "stash", "-q");
  writeFileSync(join(stashed.dir, "a.txt"), "other\n");
  git(stashed.dir, "commit", "-q", "-am", "other");
  assert.throws(() => git(stashed.dir, "stash", "pop", "-q"));
  await assert.rejects(answer(stashed.id), /has files with merge conflicts/);

  const open = await questions();
  assert.deepEqual(
    open.map((q) => [q.projectId, q.blocked !== null, q.error !== null]),
    [detachedId, mergingId, bisectingId, rebasing.id, picking.id, reverting.id, stashed.id].map((id) => [id, true, true]),
  );
  assert.equal(open[0]!.branch, null);
  assert.equal(commits(detached), 1);
  assert.deepEqual(status(bisecting), ["?? AGENTS.md", "?? CLAUDE.md"], "nothing staged");
});

test("files git ignores are never forced in: the rest is committed, and with every file ignored nothing can be", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const some = folder({ files: { ".gitignore": "CLAUDE.md\n" } });
  const someId = project(some);
  const created = await room(someId);
  assert.deepEqual([created.agentsFile.files, created.agentsFile.ignored, created.agentsFile.blocked], [["AGENTS.md", "CLAUDE.md"], ["CLAUDE.md"], null]);
  await run({ type: "project.agentsFile.answer", projectId: someId, commit: true });
  assert.deepEqual(git(some, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["AGENTS.md"]);
  assert.ok(existsSync(join(some, "CLAUDE.md")), "the ignored file stays in the folder, uncommitted");

  const all = folder({ files: { ".gitignore": "*.md\n" } });
  const allId = project(all);
  await room(allId);
  const [open] = await questions();
  assert.match(open?.blocked ?? "", /AGENTS\.md and CLAUDE\.md are ignored by git here/);
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId: allId, commit: true }), /ignored by git here/);
  assert.equal(commits(all), 1);
  assert.equal((await run({ type: "project.agentsFile.answer", projectId: allId, commit: false })).answer, "leave");
});

test("git refuses: the files are unstaged again, the question keeps the reason, and a later answer commits", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /git could not commit on main: lint failed/);
  assert.deepEqual(status(dir), ["?? AGENTS.md", "?? CLAUDE.md"], "unstaged again");
  assert.equal((await questions())[0]?.error, "git could not commit on main: lint failed");

  writeFileSync(join(dir, ".git", "index.lock"), "");
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /another git command is running in .* \(its index\.lock is there\): try again/);
  unlinkSync(join(dir, ".git", "index.lock"));

  // A draft of AGENTS.md the user staged, then edited again: a refused commit leaves both as they were.
  writeFileSync(join(dir, "AGENTS.md"), "# draft\n");
  git(dir, "add", "AGENTS.md");
  writeFileSync(join(dir, "AGENTS.md"), "# final\n");
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /lint failed/);
  assert.deepEqual(status(dir), ["AM AGENTS.md", "?? CLAUDE.md"]);
  assert.equal(git(dir, "show", ":AGENTS.md"), "# draft\n", "the user's staged version is still staged");

  unlinkSync(hook);
  const answered = await run({ type: "project.agentsFile.answer", projectId, commit: true });
  assert.equal(answered.answer, "commit");
  assert.equal(git(dir, "show", "HEAD:AGENTS.md"), "# final\n", "the file as it is when the answer comes");
  assert.deepEqual(await questions(), []);
});

test("a refused commit while something else moves HEAD is not taken for Backroom's", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, '#!/bin/sh\nc=$(echo foreign | git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD)\ngit update-ref HEAD "$c"\nexit 1\n');
  chmodSync(hook, 0o755);
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /git could not commit on main/);
  assert.equal(git(dir, "log", "-1", "--format=%s").trim(), "foreign");
  assert.deepEqual(status(dir), ["?? AGENTS.md", "?? CLAUDE.md"]);
  assert.equal((await questions()).length, 1);
});

test("no identity configured: git invents none, and the question stays open with git's reason", async (t) => {
  const { project, room, run, questions } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const kept = { ...process.env };
  t.after(() => Object.assign(process.env, kept));
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[name];
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /git could not commit on main: .*(identity|tell me who you are|user\.useConfigOnly)/i);
  assert.equal(commits(dir), 1);
  assert.deepEqual(status(dir), ["?? AGENTS.md", "?? CLAUDE.md"]);
  assert.equal((await questions()).length, 1);
});

test("two Commit answers at once make one commit", async (t) => {
  const { project, room, run } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const [first, second] = await Promise.all([run({ type: "project.agentsFile.answer", projectId, commit: true }), run({ type: "project.agentsFile.answer", projectId, commit: true })]);
  assert.equal(first.commit, second.commit);
  assert.equal(commits(dir), 2);
  // Commit and Leave from two pages at once: the first answer is the one, and the second is told it.
  const other = folder();
  const otherId = project(other);
  await room(otherId);
  const both = await Promise.all([run({ type: "project.agentsFile.answer", projectId: otherId, commit: true }), run({ type: "project.agentsFile.answer", projectId: otherId, commit: false })]);
  assert.deepEqual(both.map((answered) => answered.answer), ["commit", "commit"]);
  assert.equal(commits(other), 2);
});

test("git cannot read the folder when Commit is answered: nothing is recorded as committed, and the question comes back", async (t) => {
  const { project, room, run, questions, stack } = stackFor(t);
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  writeFileSync(join(dir, ".git", "index"), "not an index");
  await assert.rejects(run({ type: "project.agentsFile.answer", projectId, commit: true }), /git could not read .*: /);
  assert.equal(stack.service.agentsFiles!.record(projectId)?.answer, null);
  unlinkSync(join(dir, ".git", "index"));
  git(dir, "reset", "-q");
  assert.deepEqual((await questions()).map((q) => q.files), [["AGENTS.md", "CLAUDE.md"]]);
});

test("a repository with no commit yet: the files are written, asked about, and make its first commit", async (t) => {
  const { project, room, run } = stackFor(t);
  const dir = join(scratch, `unborn-${++folders}`);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const projectId = project(dir);
  const created = await room(projectId);
  assert.deepEqual([created.agentsFile.files, created.agentsFile.branch, created.agentsFile.blocked], [["AGENTS.md", "CLAUDE.md"], "main", null]);
  await run({ type: "project.agentsFile.answer", projectId, commit: true });
  assert.equal(commits(dir), 1);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["AGENTS.md", "CLAUDE.md"]);
});


test("a project folder inside a repository: its files are written and committed there", async (t) => {
  const { project, room, run } = stackFor(t);
  const repo = folder({ files: { "web/index.html": "<p>hi</p>\n" } });
  const projectId = project(join(repo, "web"));
  const created = await room(projectId);
  assert.deepEqual(created.agentsFile.files, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false, "written in the project's folder, not the repository's top");
  await run({ type: "project.agentsFile.answer", projectId, commit: true });
  assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["web/AGENTS.md", "web/CLAUDE.md"]);
});

test("the files committed by hand, or removed, close the question", async (t) => {
  const { project, room, questions } = stackFor(t);
  const dir = folder();
  await room(project(dir));
  git(dir, "add", "AGENTS.md", "CLAUDE.md");
  git(dir, "commit", "-q", "-m", "mine");
  const other = folder();
  await room(project(other));
  unlinkSync(join(other, "AGENTS.md"));
  unlinkSync(join(other, "CLAUDE.md"));
  assert.deepEqual(await questions(), []);
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
  assert.equal(stack.service.agentsFiles!.record(projectId), null, "nothing remembered: turned on again, the next room writes");
  await run({ type: "agentsFile.enabled.set", enabled: true });
  assert.equal(await setting(), true);
  assert.deepEqual((await room(projectId)).agentsFile.files, ["AGENTS.md", "CLAUDE.md"]);

  const without = stackFor(t, { agentsFile: false });
  const other = folder();
  const otherId = without.project(other);
  assert.equal((await without.room(otherId)).agentsFile, undefined);
  assert.equal(existsSync(join(other, "AGENTS.md")), false);
  await assert.rejects(without.run({ type: "project.agentsFile.answer", projectId: otherId, commit: true }), /writes no agents files/);
});

test("the page's routes: the open questions, and the answer through /api/commands", async (t) => {
  const { project, room, stack } = stackFor(t);
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(scratch, "data"), ROOMS_PORT: "0" }), "/nonexistent/dist");
  const dir = folder();
  const projectId = project(dir);
  await room(projectId);
  const questions = (await (await app.request("/api/agents-files")).json()) as Array<{ projectId: string; files: string[] }>;
  assert.deepEqual(questions.map((q) => [q.projectId, q.files]), [[projectId, ["AGENTS.md", "CLAUDE.md"]]]);
  const response = await app.request("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "project.agentsFile.answer", projectId, commit: true }) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { answer: string }).answer, "commit");
  assert.deepEqual(await (await app.request("/api/agents-files")).json(), []);
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
