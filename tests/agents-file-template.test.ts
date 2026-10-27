/**
 * A1's template (src/app/agentsFile.ts): the text a new room writes is a template with {checks} filled per project,
 * Backroom's or the user's (agentsFile.text.set); GET /api/agents-files says of every folder where Backroom wrote
 * AGENTS.md whether it is the same as the saved template rendered for it, differs, was removed or is blocked; the diff
 * route shows the difference with the digests of both sides; agentsFile.apply writes the rendered template over the
 * file, bound to those digests, only through a handle on a plain file of its own, and touches nothing else.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import {
  AGENTS_TEXT_MAX,
  AgentsFiles,
  CHECKS_PLACEHOLDER,
  DEFAULT_AGENTS_TEMPLATE,
  STALE,
  checksPhrase,
  defaultAgentsText,
  renderAgentsText,
  type AgentsFileDiff as ServerDiff,
  type AgentsFileEntry as ServerEntry,
} from "../src/app/agentsFile.ts";
import { createStack } from "../src/app/bootstrap.ts";
import type { CommandResult as ServerResult } from "../src/app/service.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { createHttpApp } from "../src/server/http.ts";
import type * as Web from "../web/src/types.ts";
import { templateSaved } from "../web/src/agentsTemplate.ts";

// The web keeps hand copies of the route's entries, the diff, the two commands and apply's result: `npm run typecheck`
// fails when they drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Array<true> = [
  true satisfies Same<Web.AgentsFileEntry, ServerEntry>,
  true satisfies Same<Web.AgentsFileDiff, ServerDiff>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "agentsFile.text.set" }>, Extract<RoomCommandInput, { type: "agentsFile.text.set" }>>,
  true satisfies Same<Extract<Web.RoomCommand, { type: "agentsFile.apply" }>, Extract<RoomCommandInput, { type: "agentsFile.apply" }>>,
  true satisfies Same<Extract<Web.CommandResult, { type: "agentsFile.applied" }>, Extract<ServerResult, { type: "agentsFile.applied" }>>,
];

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backroom-agents-template-")));
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
process.on("exit", () => {
  // A folder a test locked is unlocked first, so the scratch folder goes.
  try {
    execFileSync("chmod", ["-R", "u+rwx", scratch]);
  } catch {
    // nothing locked
  }
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const read = (path: string) => readFileSync(path, "utf8");
const checks = ["npm run lint", "npm run test"];

let folders = 0;
/** A project folder: a git repository on main with one commit (package.json with lint and test), unless `repo` is false. */
function folder(options: { repo?: boolean; files?: Record<string, string> } = {}): string {
  const dir = join(scratch, `project-${++folders}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test", lint: "eslint ." } }));
  for (const [name, text] of Object.entries(options.files ?? {})) writeFileSync(join(dir, name), text);
  if (options.repo !== false) {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "First commit");
  }
  return dir;
}

function stackFor(t: TestContext, options: { onlyUnder?: string[] } = {}) {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null, agentsFile: options.onlyUnder ? { onlyUnder: options.onlyUnder } : true });
  t.after(() => stack.close());
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(scratch, "data"), ROOMS_PORT: "0" }), "/nonexistent/dist");
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command)) as Promise<any>;
  /** A command through the page's route: its JSON and status. */
  const post = async (command: unknown) => {
    const response = await app.request("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const get = async (path: string) => {
    const response = await app.request(path);
    return { status: response.status, body: (await response.json()) as any };
  };
  const project = (workspaceRoot: string, title = `p${fake.projects.length}`) => {
    const id = `project_${fake.projects.length}`;
    fake.projects.push({ id, title, workspaceRoot, defaultModelSelection: null });
    return id;
  };
  const room = (projectId: string) => run({ type: "room.create", projectId, title: "work", consigliere: false });
  const states = async () => (await get("/api/agents-files")).body as ServerEntry[];
  const stateOf = async (dir: string) => (await states()).find((entry) => entry.folder === dir);
  const diff = async (dir: string) => (await get(`/api/agents-files/diff?folder=${encodeURIComponent(dir)}`)).body as ServerDiff & { message?: string };
  /** Apply bound to the diff fetched just now. */
  const apply = async (dir: string, seen?: ServerDiff) => {
    const looked = seen ?? (await diff(dir));
    return post({ type: "agentsFile.apply", folder: dir, fileDigest: looked.fileDigest ?? "none", templateDigest: looked.templateDigest ?? "none" });
  };
  return { stack, fake, app, run, post, get, project, room, states, stateOf, diff, apply };
}

/** A project folder with Backroom's AGENTS.md and CLAUDE.md written by a room. */
async function written(s: ReturnType<typeof stackFor>, options: Parameters<typeof folder>[0] = {}) {
  const dir = folder(options);
  const projectId = s.project(dir);
  assert.deepEqual((await s.room(projectId)).agentsFile.written, ["AGENTS.md", "CLAUDE.md"]);
  return { dir, projectId };
}

test("the web's copies of the agents files' entries, diff, commands and apply's result match the server's (checked by npm run typecheck)", () => {
  assert.equal(same.length, 5);
});

// ---------------- the template ----------------

test("rendering: {checks} with checks, without, more than once, and a template without it; the default renders as defaultAgentsText", () => {
  assert.equal(checksPhrase(checks), "`npm run lint`, `npm run test`, and whatever else its README asks for");
  assert.equal(checksPhrase([]), "the ones its README or package scripts name");
  assert.ok(DEFAULT_AGENTS_TEMPLATE.includes(`report ready: ${CHECKS_PLACEHOLDER}. Say what you ran`), "the default holds the placeholder once, where the checks line was");
  assert.equal(DEFAULT_AGENTS_TEMPLATE.split(CHECKS_PLACEHOLDER).length, 2);
  for (const list of [checks, []]) {
    assert.equal(renderAgentsText(DEFAULT_AGENTS_TEMPLATE, list), defaultAgentsText(list));
    assert.ok(defaultAgentsText(list).includes(`report ready: ${checksPhrase(list)}. Say what you ran`));
    assert.equal(defaultAgentsText(list).includes(CHECKS_PLACEHOLDER), false);
  }
  assert.equal(renderAgentsText("Run {checks}; again: {checks}.", ["make test"]), "Run `make test`, and whatever else its README asks for; again: `make test`, and whatever else its README asks for.\n");
  assert.equal(renderAgentsText("# Ours\n\nNo checks named here.", checks), "# Ours\n\nNo checks named here.\n", "a template without the placeholder is written as it is");
  assert.equal(renderAgentsText("a\r\nb\r\n\r\n\n", []), "a\nb\n", "LF line endings, one final newline");
  assert.ok(defaultAgentsText([]).endsWith("Backroom changes it only when you apply the current default from Settings → Agents file.\n"));
});

test("agentsFile.text.set: trimmed, never empty, capped, kept, and null resets; the settings route keeps its boolean and adds the template", async (t) => {
  const s = stackFor(t);
  const settings = async () => (await s.get("/api/settings")).body as { agentsFile: boolean; agentsFileText: { text: string; custom: boolean; defaultText: string } };
  assert.equal((await settings()).agentsFile, true);
  assert.deepEqual((await settings()).agentsFileText, { text: DEFAULT_AGENTS_TEMPLATE, custom: false, defaultText: DEFAULT_AGENTS_TEMPLATE });

  assert.equal((await s.post({ type: "agentsFile.text.set", text: "  # Ours\n\nRun {checks}.\n\n  " })).body.type, "settings.updated");
  assert.deepEqual((await settings()).agentsFileText, { text: "# Ours\n\nRun {checks}.", custom: true, defaultText: DEFAULT_AGENTS_TEMPLATE });
  for (const text of ["", "   \n  ", "x".repeat(AGENTS_TEXT_MAX + 1)]) {
    const refused = await s.post({ type: "agentsFile.text.set", text });
    assert.equal(refused.status, 400, `refused: ${text.length} characters`);
    assert.equal(refused.body.error, "invalid_command");
  }
  assert.equal((await s.post({ type: "agentsFile.text.set", text: "x".repeat(AGENTS_TEXT_MAX) })).status, 200, "the cap itself is allowed");
  assert.equal((await settings()).agentsFileText.text.length, AGENTS_TEXT_MAX);
  assert.equal((await s.post({ type: "agentsFile.text.set", text: null })).body.type, "settings.updated");
  assert.deepEqual((await settings()).agentsFileText, { text: DEFAULT_AGENTS_TEMPLATE, custom: false, defaultText: DEFAULT_AGENTS_TEMPLATE });
  assert.equal((await settings()).agentsFile, true, "the switch is untouched by the template");
});

test("a new room writes the saved template rendered for its project, the default after a reset; saving one changes no file already written", async (t) => {
  const s = stackFor(t);
  const before = await written(s);
  const was = read(join(before.dir, "AGENTS.md"));
  await s.run({ type: "agentsFile.text.set", text: "# Ours\n\nRun {checks} before you report." });
  const custom = await written(s);
  assert.equal(read(join(custom.dir, "AGENTS.md")), "# Ours\n\nRun `npm run lint`, `npm run test`, and whatever else its README asks for before you report.\n");
  assert.equal(read(join(custom.dir, "CLAUDE.md")), "@AGENTS.md\n");
  assert.equal(read(join(before.dir, "AGENTS.md")), was, "a project written earlier keeps its file");
  assert.equal((await s.room(custom.projectId)).agentsFile, undefined, "a second room writes nothing");

  await s.run({ type: "agentsFile.text.set", text: null });
  const reset = await written(s, { repo: false });
  assert.equal(read(join(reset.dir, "AGENTS.md")), defaultAgentsText(checks));
  assert.equal(read(join(custom.dir, "AGENTS.md")).startsWith("# Ours"), true, "nor does a reset change one");
});

// ---------------- the states ----------------

test("GET /api/agents-files: one entry per folder where Backroom wrote AGENTS.md, with T3's title while it has the project; same, differs, removed", async (t) => {
  const s = stackFor(t);
  const same = await written(s);
  const edited = await written(s);
  const removed = await written(s);
  const checksChanged = await written(s);
  // CLAUDE.md alone (the project's own AGENTS.md there): not listed, Backroom wrote no AGENTS.md there.
  const own = folder({ files: { "AGENTS.md": "# ours\n" } });
  assert.deepEqual((await s.room(s.project(own))).agentsFile.written, ["CLAUDE.md"]);
  writeFileSync(join(edited.dir, "AGENTS.md"), `${read(join(edited.dir, "AGENTS.md"))}- One more of ours.\n`);
  unlinkSync(join(removed.dir, "AGENTS.md"));
  // The project's checks changed since: the template rendered for it now names the new one.
  writeFileSync(join(checksChanged.dir, "package.json"), JSON.stringify({ scripts: { check: "tsc && node --test" } }));
  const editedTitle = s.fake.projects.find((p) => p.id === edited.projectId)!.title;
  // A project removed from T3 keeps its record, with no title.
  s.fake.projects.splice(s.fake.projects.findIndex((p) => p.id === same.projectId), 1);

  const entries = await s.states();
  assert.deepEqual(entries.map((entry) => entry.folder), [same.dir, edited.dir, removed.dir, checksChanged.dir].sort());
  const of = (dir: string) => entries.find((entry) => entry.folder === dir)!;
  assert.deepEqual([of(same.dir).state, of(same.dir).title, of(same.dir).projectId], ["same", null, same.projectId]);
  assert.deepEqual([of(edited.dir).state, of(edited.dir).title], ["differs", editedTitle]);
  assert.equal(of(removed.dir).state, "removed");
  assert.equal(of(checksChanged.dir).state, "differs");
  assert.equal(of(same.dir).appliedAt, null);
  assert.ok(of(same.dir).writtenAt);
  assert.equal(existsSync(join(removed.dir, "AGENTS.md")), false, "a list never writes a file again");

  // A template saved: every file written with the default differs from it now.
  await s.run({ type: "agentsFile.text.set", text: "# New\n\n{checks}" });
  assert.equal((await s.stateOf(edited.dir))?.state, "differs");
  assert.equal((await s.stateOf(removed.dir))?.state, "removed");
  // A T3 that does not answer: the entries all the same, with no titles.
  s.fake.listProjects = async () => {
    throw new Error("T3 is down");
  };
  assert.deepEqual((await s.states()).map((entry) => entry.title), [null, null, null, null]);
});

test("blocked, never removed: a link, a folder, a hard link, an unreadable file, a folder not on this machine; diff and apply refuse each", async (t) => {
  const s = stackFor(t);
  const linked = await written(s);
  const target = join(scratch, `elsewhere-${folders}.md`);
  writeFileSync(target, read(join(linked.dir, "AGENTS.md")));
  unlinkSync(join(linked.dir, "AGENTS.md"));
  symlinkSync(target, join(linked.dir, "AGENTS.md"));
  const dangling = await written(s);
  unlinkSync(join(dangling.dir, "AGENTS.md"));
  symlinkSync(join(scratch, "nowhere", "AGENTS.md"), join(dangling.dir, "AGENTS.md"));
  const dir = await written(s);
  unlinkSync(join(dir.dir, "AGENTS.md"));
  mkdirSync(join(dir.dir, "AGENTS.md"));
  const hard = await written(s);
  linkSync(join(hard.dir, "AGENTS.md"), join(scratch, `hard-${folders}.md`));
  const unreadable = await written(s);
  chmodSync(join(unreadable.dir, "AGENTS.md"), 0o000);
  t.after(() => chmodSync(join(unreadable.dir, "AGENTS.md"), 0o644));
  const gone = await written(s);
  rmSync(gone.dir, { recursive: true, force: true });
  // A folder that is there but cannot be searched: AGENTS.md cannot even be looked at, which is no removal.
  const unsearchable = await written(s);
  chmodSync(unsearchable.dir, 0o666);
  t.after(() => chmodSync(unsearchable.dir, 0o755));

  const cases: Array<[string, string, RegExp]> = [
    ["a link", linked.dir, /a link now/],
    ["a link to nowhere", dangling.dir, /a link now/],
    ["a folder", dir.dir, /no longer a plain file/],
    ["a hard link", hard.dir, /another name \(a hard link\)/],
    ["a folder not on this machine", gone.dir, /is not on this machine/],
  ];
  // Root reads a file whatever its mode: the unreadable case is only for an ordinary account.
  if (process.getuid?.() !== 0) cases.push(["an unreadable file", unreadable.dir, /cannot be read/], ["a folder that cannot be searched", unsearchable.dir, /cannot be looked at/]);
  for (const [what, at, reason] of cases) {
    const entry = await s.stateOf(at);
    assert.equal(entry?.state, "blocked", what);
    assert.match(entry?.reason ?? "", reason, what);
    const looked = await s.get(`/api/agents-files/diff?folder=${encodeURIComponent(at)}`);
    assert.deepEqual([looked.status, looked.body.error], [409, "agents_file_refused"], `${what}: no diff`);
    const applied = await s.post({ type: "agentsFile.apply", folder: at, fileDigest: "x", templateDigest: "y" });
    assert.equal(applied.status, 409, `${what}: no apply`);
    assert.match(applied.body.message, reason, what);
  }
  assert.equal(read(target), defaultAgentsText(checks), "the link's target is untouched");
  assert.equal(existsSync(join(scratch, "nowhere")), false, "a link to nowhere is never followed");
  assert.equal(existsSync(gone.dir), false, "no folder is made");
});

// ---------------- the diff ----------------

test("the diff: from the project's file to the saved template rendered for it, blank lines and a missing final newline kept, with both digests", async (t) => {
  const s = stackFor(t);
  const { dir, projectId } = await written(s);
  const same = await s.diff(dir);
  assert.deepEqual([same.state, same.diff, same.projectId, same.folder], ["same", "", projectId, dir]);
  assert.equal(same.fileDigest, same.templateDigest, "the same text, the same digest");

  writeFileSync(join(dir, "AGENTS.md"), "# Ours\n\n\nOur own line.");
  const looked = await s.diff(dir);
  assert.equal(looked.state, "differs");
  assert.match(looked.diff, /^--- a\/project\/AGENTS\.md$/m, "the project's file is the old side");
  assert.match(looked.diff, /^\+\+\+ b\/template\/AGENTS\.md$/m, "the template the new side");
  assert.match(looked.diff, /^-Our own line\.$/m);
  assert.match(looked.diff, /^\+# Working in this project$/m);
  assert.match(looked.diff, /^\+$/m, "a blank line is a line of the diff");
  assert.match(looked.diff, /^ $/m, "and a blank line both have is context");
  assert.match(looked.diff, /^\\ No newline at end of file$/m, "the missing final newline is said");
  assert.notEqual(looked.fileDigest, looked.templateDigest);
  assert.equal((await s.get(`/api/agents-files/diff?projectId=${encodeURIComponent(projectId)}`)).body.diff, looked.diff, "by project id too");

  for (const query of ["", `?projectId=${projectId}&folder=${encodeURIComponent(dir)}`]) assert.equal((await s.get(`/api/agents-files/diff${query}`)).status, 400, `refused: ${query || "neither"}`);
  const other = folder();
  assert.equal((await s.get(`/api/agents-files/diff?folder=${encodeURIComponent(other)}`)).status, 409, "a folder Backroom never wrote in");
  unlinkSync(join(dir, "AGENTS.md"));
  assert.match((await s.diff(dir)).message ?? "", /gone from/);
});

// ---------------- apply ----------------

test("apply writes the saved template over the AGENTS.md Backroom wrote, and nothing else: CLAUDE.md, the exclude file, the hook, git and worktrees as they were", async (t) => {
  const s = stackFor(t);
  const { dir, projectId } = await written(s);
  const worktree = join(scratch, `worktree-${++folders}`);
  git(dir, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(join(dir, "AGENTS.md"), "# Edited by the user\n");
  writeFileSync(join(worktree, "AGENTS.md"), "# The worktree's copy\n");
  await s.run({ type: "agentsFile.text.set", text: "# New habits\n\nRun {checks}." });
  const kept = (path: string) => (existsSync(path) ? read(path) : null);
  const others = [join(dir, "CLAUDE.md"), join(dir, ".git", "info", "exclude"), join(dir, ".git", "hooks", "post-checkout"), join(worktree, "CLAUDE.md")];
  const before = { files: others.map(kept), head: git(dir, "rev-parse", "HEAD"), status: git(dir, "status", "--porcelain", "--untracked-files=all"), index: read(join(dir, ".git", "index")) };
  assert.equal((await s.stateOf(dir))?.state, "differs");

  const result = await s.apply(dir);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.type, "agentsFile.applied");
  assert.deepEqual([result.body.file.state, result.body.file.projectId, result.body.file.folder], ["same", projectId, dir]);
  assert.ok(result.body.file.appliedAt);
  assert.equal(read(join(dir, "AGENTS.md")), "# New habits\n\nRun `npm run lint`, `npm run test`, and whatever else its README asks for.\n");
  assert.equal((await s.stateOf(dir))?.state, "same", "the state goes back to same");
  assert.deepEqual(others.map(kept), before.files, "CLAUDE.md, the exclude file, the hook and the worktree's CLAUDE.md as they were");
  assert.equal(read(join(worktree, "AGENTS.md")), "# The worktree's copy\n", "the worktree keeps its copy");
  assert.equal(git(dir, "rev-parse", "HEAD"), before.head, "nothing committed");
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), before.status);
  assert.equal(read(join(dir, ".git", "index")), before.index, "the index untouched");

  // By project id too; and with the setting off, which governs automatic writing only.
  await s.run({ type: "agentsFile.enabled.set", enabled: false });
  await s.run({ type: "agentsFile.text.set", text: null });
  const looked = await s.diff(dir);
  const byId = await s.post({ type: "agentsFile.apply", projectId, fileDigest: looked.fileDigest, templateDigest: looked.templateDigest });
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.equal(read(join(dir, "AGENTS.md")), defaultAgentsText(checks));
});

test("apply is bound to the diff the user looked at: the file or the template changed since is refused, and the file kept", async (t) => {
  const s = stackFor(t);
  const { dir } = await written(s);
  writeFileSync(join(dir, "AGENTS.md"), "# Ours\n");
  const looked = await s.diff(dir);
  writeFileSync(join(dir, "AGENTS.md"), "# Ours, edited again elsewhere\n");
  const fileChanged = await s.apply(dir, looked);
  assert.deepEqual([fileChanged.status, fileChanged.body.message], [409, STALE]);
  assert.equal(read(join(dir, "AGENTS.md")), "# Ours, edited again elsewhere\n");

  const again = await s.diff(dir);
  await s.run({ type: "agentsFile.text.set", text: "# A template saved since\n" });
  const templateChanged = await s.apply(dir, again);
  assert.deepEqual([templateChanged.status, templateChanged.body.message], [409, STALE]);
  assert.equal(read(join(dir, "AGENTS.md")), "# Ours, edited again elsewhere\n");
  assert.equal((await s.apply(dir)).status, 200, "looked at again, it applies");
  assert.equal(read(join(dir, "AGENTS.md")), "# A template saved since\n");
});

test("apply refuses a missing file, a folder without a record, CLAUDE.md alone, a folder outside onlyUnder, and neither or both of projectId and folder", async (t) => {
  const s = stackFor(t);
  const { dir, projectId } = await written(s);
  const looked = await s.diff(dir);
  const refused = async (command: Record<string, unknown>, status: number, pattern: RegExp) => {
    const result = await s.post({ type: "agentsFile.apply", fileDigest: looked.fileDigest, templateDigest: looked.templateDigest, ...command });
    assert.equal(result.status, status, JSON.stringify(command));
    assert.match(result.body.message, pattern, JSON.stringify(command));
  };
  await refused({}, 400, /a projectId or a folder/);
  await refused({ projectId, folder: dir }, 400, /a projectId or a folder/);
  await refused({ folder: folder() }, 409, /wrote no AGENTS\.md there/);
  await refused({ projectId: "project_unknown" }, 409, /wrote no AGENTS\.md there/);
  await refused({ folder: "relative/path" }, 409, /wrote no AGENTS\.md there/);
  const own = folder({ files: { "AGENTS.md": "# ours\n" } });
  await s.room(s.project(own));
  await refused({ folder: own }, 409, /wrote no AGENTS\.md there/);
  assert.equal(read(join(own, "AGENTS.md")), "# ours\n", "the project's own AGENTS.md beside Backroom's CLAUDE.md is never applied over");

  unlinkSync(join(dir, "AGENTS.md"));
  await refused({ folder: dir }, 409, /gone from .*does not write it again/);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false, "a missing file is not written");

  // A service that writes only under its own folders: a record outside them is never applied.
  const inside = folder();
  const outside = folder();
  const restricted = new AgentsFiles(s.stack.repos, { onlyUnder: [inside] });
  const anywhere = new AgentsFiles(s.stack.repos);
  assert.ok(await anywhere.roomCreated({ id: "p_outside", workspaceRoot: outside }));
  writeFileSync(join(outside, "AGENTS.md"), "# ours\n");
  const seen = await anywhere.diff({ folder: outside });
  await assert.rejects(restricted.apply({ folder: outside, fileDigest: seen.fileDigest, templateDigest: seen.templateDigest }), /outside the folders this service writes in/);
  assert.equal(read(join(outside, "AGENTS.md")), "# ours\n");
  assert.ok(await restricted.roomCreated({ id: "p_inside", workspaceRoot: inside }));
  writeFileSync(join(inside, "AGENTS.md"), "# ours\n");
  const seenInside = await restricted.diff({ folder: inside });
  assert.equal((await restricted.apply({ folder: inside, fileDigest: seenInside.fileDigest, templateDigest: seenInside.templateDigest })).state, "same");
});

test("apply between the look and the write: a link swapped in is never followed, a file removed is not made, a hard link or an edit is refused", async (t) => {
  const s = stackFor(t);
  const swaps: Array<[string, (dir: string) => void, RegExp, (dir: string) => void]> = [
    [
      "a link swapped in",
      (dir) => {
        unlinkSync(join(dir, "AGENTS.md"));
        symlinkSync(join(dir, "victim.md"), join(dir, "AGENTS.md"));
      },
      /a link now/,
      (dir) => assert.equal(read(join(dir, "victim.md")), "# not Backroom's\n", "the link's target is untouched"),
    ],
    ["the file removed", (dir) => unlinkSync(join(dir, "AGENTS.md")), /gone from/, (dir) => assert.equal(existsSync(join(dir, "AGENTS.md")), false, "not made again")],
    [
      "a hard link made",
      (dir) => linkSync(join(dir, "AGENTS.md"), join(dir, "victim-hard.md")),
      /plain file of its own/,
      (dir) => assert.equal(read(join(dir, "victim-hard.md")), "# Ours\n", "the other name's contents are untouched"),
    ],
    ["the file edited", (dir) => writeFileSync(join(dir, "AGENTS.md"), "# Edited meanwhile\n"), new RegExp(STALE), (dir) => assert.equal(read(join(dir, "AGENTS.md")), "# Edited meanwhile\n")],
  ];
  for (const [what, swap, reason, check] of swaps) {
    const dir = folder({ files: { "victim.md": "# not Backroom's\n" } });
    const plain = new AgentsFiles(s.stack.repos);
    assert.ok(await plain.roomCreated({ id: `p_${what}`, workspaceRoot: dir }));
    writeFileSync(join(dir, "AGENTS.md"), "# Ours\n");
    const seen = await plain.diff({ folder: dir });
    const racing = new AgentsFiles(s.stack.repos, { beforeWrite: (at, file) => at === dir && file === "AGENTS.md" && swap(dir) });
    await assert.rejects(racing.apply({ folder: dir, fileDigest: seen.fileDigest, templateDigest: seen.templateDigest }), reason, what);
    check(dir);
  }
});

test("apply after the open: the folder still the recorded one, and the handle the file its name gives now, else refused", async (t) => {
  const s = stackFor(t);
  const { dir } = await written(s);
  writeFileSync(join(dir, "AGENTS.md"), "# Ours\n");
  const files = new AgentsFiles(s.stack.repos);
  const seen = await files.diff({ folder: dir });
  // Between the open and the write: the file renamed away and another put under its name. The handle still holds the
  // old one, whose bytes the user saw; the check after the open sees the name gives another file now.
  const realpath = fs.realpathSync;
  let calls = 0;
  t.mock.method(fs, "realpathSync", (...args: Parameters<typeof fs.realpathSync>) => {
    // The third look at the folder in apply: the record's lookup, compare's, then the one after the open.
    if (String(args[0]) === dir && ++calls === 3) {
      fs.renameSync(join(dir, "AGENTS.md"), join(dir, "AGENTS.old.md"));
      writeFileSync(join(dir, "AGENTS.md"), "# Put there meanwhile\n");
    }
    return realpath(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(files.apply({ folder: dir, fileDigest: seen.fileDigest, templateDigest: seen.templateDigest }), /replaced while it was being applied/);
  assert.equal(calls, 3, "the folder is looked at again after the open");
  assert.equal(read(join(dir, "AGENTS.md")), "# Put there meanwhile\n");
  assert.equal(read(join(dir, "AGENTS.old.md")), "# Ours\n", "the file the handle holds is not written either");
});

test("the editor after a save the service took: the textarea takes the saved text only when it still holds what was submitted (review #81)", () => {
  const before = { text: "# A  ", saved: "# Old", custom: false, defaultText: "# Default" };
  // Nothing typed while the save ran: the textarea shows the saved (trimmed) text, and nothing is left unsaved.
  assert.deepEqual(templateSaved(before, "# A  ", "# A", true), { text: "# A", saved: "# A", custom: true, defaultText: "# Default" });
  // Typed on while it ran: the newer draft stays, unsaved against the text the service now holds.
  assert.deepEqual(templateSaved({ ...before, text: "# A, and B typed meanwhile" }, "# A  ", "# A", true), { text: "# A, and B typed meanwhile", saved: "# A", custom: true, defaultText: "# Default" });
  // Reset to default the same way.
  assert.deepEqual(templateSaved({ ...before, text: "# Mine" }, "# Mine", "# Default", false).text, "# Default");
  assert.deepEqual(templateSaved({ ...before, text: "# Mine, and more" }, "# Mine", "# Default", false).text, "# Mine, and more");
});
