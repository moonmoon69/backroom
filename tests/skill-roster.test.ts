/**
 * The skills roster (src/app/skillRoster.ts): rows by source, T3's skills list beside its commands (through the fake and
 * the HTTP adapter), the merge of what a harness found into the pack row it came from, the user's lines and their cap;
 * the briefing's Skills section and the Consigliere's skills the user wrote lines for (src/briefing/assemble.ts), capped
 * and sent again when they change; and the composer's "/" list (web/src/slashList.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_SKILLS, FakeT3Adapter } from "../src/adapter/fake.ts";
import type { T3ProviderInfo } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { Packs } from "../src/app/packs.ts";
import { ROOM_DIRECTIVES, skillLines, skillRoster, type SkillRow } from "../src/app/skillRoster.ts";
import { SKILLS_OFF, SKILL_LINES_BUDGET, briefingHeader, changedStanding, heldStanding, skillLine, skillLinesSection, skillsSection, standingFingerprint, standingText, type StandingInput } from "../src/briefing/assemble.ts";
import { Database } from "../src/db/database.ts";
import { Repos } from "../src/db/repos.ts";
import { PRESET_DESCRIPTION_MAX, parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { PSTACK_PACK, skillRowId } from "../src/domain/skills.ts";
import type { Participant, Preset, Room } from "../src/domain/types.ts";
import { slashEntries, slashInsert } from "../web/src/slashList.ts";
import { makePackFixture } from "../scripts/pstack-fixture.ts";
import { t3Stub } from "./t3Stub.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "backroom-roster-")));
const emptyConfig = join(scratch, "gitconfig");
writeFileSync(emptyConfig, "");
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e", GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" });
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const dir = (name = "d") => {
  const path = join(scratch, `${name}-${++dirs}`);
  mkdirSync(path, { recursive: true });
  return path;
};

const preset = (name: string, instanceId: string): Preset =>
  ({ id: `p-${name}`, name, modelSelection: { instanceId, model: "m" }, runtimeMode: "full-access", workspaceMode: "local", goodAt: "", avoid: "", createdAt: "", updatedAt: "" }) as unknown as Preset;

/** A pack with alpha linked into Claude's folder and beta into the agents' folder, under a home of its own. */
async function linkedPack() {
  const fx = makePackFixture(dir("up"));
  const repos = new Repos(new Database(":memory:"));
  repos.deletePack(PSTACK_PACK);
  const home = dir("home");
  const packs = new Packs(repos, { dataDir: dir("data"), home });
  await packs.add(fx.bare);
  await packs.link("skills-pack", "skills/alpha", "claude");
  await packs.link("skills-pack", "skills/beta", "agents");
  return { fx, repos, home, packs, input: () => ({ packs: packs.list().map((pack) => ({ pack, skills: packs.skills(pack) })), folders: packs.folders() }) };
}

/** Claude as T3 lists it: its skills as slash commands, with no path; a command's description its author's (or the one given). */
const claude = (commands: Array<string | [string, string]>): T3ProviderInfo =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    slashCommands: commands.map((c) => (typeof c === "string" ? { name: c, description: `${c}, by its author`, hint: null } : { name: c[0], description: c[1], hint: null })),
    skills: [],
  }) as unknown as T3ProviderInfo;

test("the roster: directives, commands per provider, T3's skills by source, linked pack skills; what a harness found of a pack's skill is that pack's row", async () => {
  const { home, input } = await linkedPack();
  const codex = {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    // A command named and described as beta, linked in a folder Codex reads: Codex gives paths, so it stays Codex's command.
    slashCommands: [{ name: "compact", description: "Codex's compact", hint: null }, { name: "beta", description: "Beta, for the second kind.", hint: null }],
    // beta as Codex found it, through Backroom's link in ~/.agents/skills, under its frontmatter name.
    skills: [...CODEX_SKILLS, { name: "beta-skill", description: "Beta, for the second kind.", shortDescription: null, path: join(home, ".agents/skills/beta/SKILL.md"), scope: "user", enabled: true, displayName: null, userInvocationOnly: true, userInvocable: true }],
  } as unknown as T3ProviderInfo;
  const rows = skillRoster({
    ...input(),
    // Claude lists alpha, linked in its folder, as a command named by its folder and described by its frontmatter.
    providers: [claude(["compact", ["alpha", "Use alpha for the first kind of job."], "dataviz"]), codex],
    crew: [preset("Opus", "claudeAgent"), preset("Sol", "codex")],
    hints: new Map([[skillRowId.command("claudeAgent", "dataviz"), { useWhen: "charts for the user", avoid: "" }]]),
  });
  const view = rows.map((r) => [r.kind, r.name, r.source, r.instances.join(","), r.members.join(",")]);
  assert.deepEqual(view, [
    ["directive", "now", "room", "", ""],
    ["directive", "add", "room", "", ""],
    ["directive", "remove", "room", "", ""],
    ["command", "beta", "Codex", "codex", "Sol"],
    ["command", "compact", "Claude", "claudeAgent", "Opus"],
    ["command", "compact", "Codex", "codex", "Sol"],
    ["command", "dataviz", "Claude", "claudeAgent", "Opus"],
    ["skill", "deploy-check", "Codex · user", "codex", "Sol"],
    ["skill", "house-style", "Codex · user", "codex", "Sol"],
    ["skill", "imagegen", "Codex · system", "codex", "Sol"],
    ["skill", "openai-templates:artifact-template-analytics-dashboard", "Codex · plugin", "codex", "Sol"],
    ["pack", "alpha", "skills-pack · skills/alpha", "claudeAgent", "Opus"],
    ["pack", "beta-skill", "skills-pack · skills/beta", "codex", "Sol"],
  ]);
  const row = (name: string) => rows.find((r) => r.name === name)!;
  assert.notEqual(rows.filter((r) => r.name === "compact")[0]!.id, rows.filter((r) => r.name === "compact")[1]!.id, "a command is one row per provider");
  assert.equal(row("openai-templates:artifact-template-analytics-dashboard").label, "Analytics Dashboard", "the display name a label, the prefixed name kept");
  assert.equal(row("imagegen").description, "Generate or edit images", "the author's short line");
  assert.equal(rows.some((r) => r.name === "retired-skill"), false, "a skill its harness turned off is no one's");
  assert.deepEqual([row("house-style").userInvocable, row("deploy-check").userInvocationOnly], [false, true]);
  assert.equal(row("beta-skill").userInvocationOnly, true, "the pack row takes T3's restriction");
  assert.equal(row("beta-skill").path, realpathSync(join(home, ".agents/skills/beta")), "the real source path");
  assert.deepEqual(row("alpha").linked, ["claude"]);
  assert.equal(row("alpha").id, skillRowId.pack("skills-pack", "skills/alpha"));
  assert.deepEqual([row("dataviz").useWhen, row("dataviz").avoid], ["charts for the user", ""]);
  assert.equal(row("imagegen").useWhen, "", "the author's line is never copied into the user's");
  // A Claude command with a linked skill's name but not its description is Claude's own: it stays a command, and the pack
  // row is not Claude's.
  const native = skillRoster({ ...input(), providers: [claude([["alpha", "Claude's own alpha"]])], crew: [], hints: new Map() });
  assert.deepEqual(native.filter((r) => r.name === "alpha").map((r) => [r.kind, r.instances.join(",")]), [
    ["command", "claudeAgent"],
    ["pack", ""],
  ]);
  // T3 unreadable: its rows go, the directives and the linked pack skills stand.
  const without = skillRoster({ ...input(), providers: null, crew: [], hints: new Map() });
  assert.deepEqual(without.map((r) => [r.kind, r.name]), [...ROOM_DIRECTIVES.map((d) => ["directive", d.name]), ["pack", "alpha"], ["pack", "beta-skill"]]);
});

test("T3's skills list read beside its commands: through the HTTP adapter's mapping, and the fake's harnesses finding what is linked in their folders", async () => {
  const { adapter } = t3Stub({}, (frame) =>
    frame.tag === "server.getConfig"
      ? {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
              slashCommands: [{ name: "compact" }],
              skills: [
                { name: "openai-templates:x", path: "/p/SKILL.md", scope: "plugin", displayName: "X", shortDescription: "short", description: "long" },
                { name: "mine", enabled: false, userInvocationOnly: true, userInvocable: false },
              ],
            },
          ],
        }
      : null,
  );
  const [codex] = await adapter.listProviders();
  assert.equal(codex!.driver, "codex");
  assert.deepEqual(codex!.skills, [
    { name: "openai-templates:x", description: "long", shortDescription: "short", path: "/p/SKILL.md", scope: "plugin", enabled: true, displayName: "X", userInvocationOnly: false, userInvocable: true },
    { name: "mine", description: null, shortDescription: null, path: null, scope: null, enabled: false, displayName: null, userInvocationOnly: true, userInvocable: false },
  ]);
  const { home } = await linkedPack();
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  fake.skillsHome = home;
  const providers = await fake.listProviders();
  const of = (id: string) => providers.find((p) => p.instanceId === id)!;
  assert.ok(of("claudeAgent").slashCommands!.some((c) => c.name === "alpha"), "Claude lists what it finds in its folder as a command");
  assert.ok(of("codex").skills!.some((s) => s.name === "beta" && s.path === join(home, ".agents/skills/beta/SKILL.md")), "Codex lists it with the path it found it at");
  assert.equal(of("codex").skills!.some((s) => s.name === "alpha"), false, "Claude's folder is not Codex's");
});

test("the user's lines: kept by the row's identity with a crew line's cap, folded to one line, both empty removing them", async (t) => {
  const stack = createStack({ dbPath: ":memory:", adapter: new FakeT3Adapter({ autoCompleteMs: null }), briefingBudgetChars: 60000, latestRelease: async () => null });
  t.after(() => stack.close());
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const id = skillRowId.command("claudeAgent", "dataviz");
  await run({ type: "skill.hint.set", skillId: id, useWhen: "  charts\n for the user ", avoid: "tables" });
  assert.deepEqual(stack.repos.listSkillHints().get(id), { useWhen: "charts for the user", avoid: "tables" });
  assert.throws(() => parseCommand({ type: "skill.hint.set", skillId: id, useWhen: "x".repeat(PRESET_DESCRIPTION_MAX + 1) }), /useWhen/);
  await run({ type: "skill.hint.set", skillId: id, useWhen: "", avoid: "" });
  assert.equal(stack.repos.listSkillHints().has(id), false);
});

const room = { id: "r", title: "Room", consigliereId: "c", browserEnabled: false } as unknown as Room;
const member = (id: string, alias: string) => ({ id, alias, roomId: "r", retiredAt: null }) as unknown as Participant;
const people = new Map([
  ["c", member("c", "Fable")],
  ["m", member("m", "Sol")],
]);
const inputFor = (who: "c" | "m", extra: Partial<StandingInput> = {}): StandingInput => ({ room, participant: people.get(who)!, participantsById: people, ...extra });
const line = (name: string, extra: Partial<ReturnType<typeof skillLines>[number]> = {}) => ({ name, source: "Codex · user", useWhen: `${name} for a job`, avoid: "", members: ["Sol"], userInvocationOnly: false, ...extra });

test("the Skills section: each pack's standing line with its revision and folder; sent again when a pack moves, retracted when none has one", () => {
  const pack = { name: "pstack", folder: "/data/skills/cursor-plugins", commit: "ae5650f", line: "Follow it." };
  const section = skillsSection([pack]);
  assert.equal(section, "== Skills ==\nThe skill packs Backroom keeps, each with its standing line (the agents file carries the same line):\n- pstack at commit ae5650f, in /data/skills/cursor-plugins: Follow it.");
  assert.equal(section.includes("pstack's skills:"), false, "no dump of a pack's names");
  const had = heldStanding({}, standingFingerprint(inputFor("m", { skills: [pack] })));
  assert.deepEqual(changedStanding(had, standingFingerprint(inputFor("m", { skills: [{ ...pack, commit: "1234567" }] }))), ["skills"]);
  const gone = standingFingerprint(inputFor("m", { skills: [] }));
  assert.deepEqual(changedStanding(had, gone), ["skills"]);
  assert.ok(briefingHeader(inputFor("m", { skills: [], board: { command: "rooms-board", as: "Sol.r" } }), ["skills"], { seat: false }).includes(SKILLS_OFF));
});

test("the Consigliere's skills the user wrote lines for: each once, with who has it and user-invoked only; capped whole, avoid lines kept, the rest counted; his alone, sent again when they change", () => {
  const lines = [line("alpha"), line("beta", { avoid: "anything public", userInvocationOnly: true }), line("gamma", { members: [] })];
  const section = skillLinesSection(lines)!;
  assert.ok(section.startsWith("== Skills the user wrote lines for =="));
  assert.ok(section.includes("- beta (Codex · user) · use when: beta for a job · avoid: anything public · has it: Sol · user-invoked only"));
  assert.ok(section.includes("- gamma (Codex · user) · use when: gamma for a job · no crew member has it yet"));
  assert.equal(section.includes("more with the user's lines"), false);
  // Over the budget: whole entries only, the one with an avoid line kept first, the rest counted.
  const tight = skillLinesSection(lines, skillLine(lines[1]!).length + skillLine(lines[0]!).length + 2)!;
  assert.deepEqual(tight.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]), ["alpha", "beta"]);
  assert.ok(tight.endsWith("1 more with the user's lines is in Settings → Skills."));
  const one = skillLinesSection(lines, skillLine(lines[1]!).length + 1)!;
  assert.deepEqual(one.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]), ["beta"], "the avoid line is what is kept");
  assert.ok(one.includes("avoid: anything public"), "never shortened");
  assert.ok(one.endsWith("2 more with the user's lines are in Settings → Skills."));
  const many = Array.from({ length: 200 }, (_, i) => line(`skill-${i}`));
  assert.ok(skillLinesSection(many)!.length < SKILL_LINES_BUDGET + 600, "the default budget holds");
  // His alone; another member never gets it.
  assert.ok(standingText(inputFor("c", { skillLines: lines })).includes("== Skills the user wrote lines for =="));
  assert.equal(standingText(inputFor("m", { skillLines: lines })).includes("== Skills the user wrote lines for =="), false);
  assert.equal(standingFingerprint(inputFor("m", { skillLines: lines })).skillLines, null);
  const had = heldStanding({}, standingFingerprint(inputFor("c", { skillLines: lines })));
  assert.deepEqual(changedStanding(had, standingFingerprint(inputFor("c", { skillLines: lines }))), []);
  assert.deepEqual(changedStanding(had, standingFingerprint(inputFor("c", { skillLines: [line("alpha", { members: ["Sol", "Astra"] }), ...lines.slice(1)] }))), ["skillLines"], "who has one changed");
  assert.deepEqual(changedStanding(had, standingFingerprint(inputFor("c", {}))), [], "T3 unread: no change");
  assert.deepEqual(changedStanding(had, standingFingerprint(inputFor("c", { skillLines: [] }))), ["skillLines"]);
  assert.ok(briefingHeader(inputFor("c", { skillLines: [], board: { command: "rooms-board", as: "Fable.r" } }), ["skillLines"], { seat: false }).some((l) => l.includes("None now: the list you were given earlier no longer applies.")));
  // The roster's directives are never in it.
  const rows = [{ kind: "directive", name: "now", useWhen: "start", avoid: "" }, { kind: "command", name: "dataviz", useWhen: "charts", avoid: "", members: [], source: "Claude", userInvocationOnly: false }] as unknown as SkillRow[];
  assert.deepEqual(skillLines(rows).map((l) => l.name), ["dataviz"]);
});

test("the briefing source: the Consigliere's standing text carries the lines with who has each from T3; a member's does not", async (t) => {
  const { home } = await linkedPack();
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  fake.skillsHome = home;
  const stack = createStack({ dbPath: ":memory:", adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null });
  t.after(() => stack.close());
  const run = (command: RoomCommandInput) => stack.service.execute(parseCommand(command)) as Promise<any>;
  await run({ type: "preset.create", name: "sol", modelSelection: { instanceId: "codex", model: "gpt-6-sol" } });
  await run({ type: "skill.hint.set", skillId: skillRowId.skill("codex", "plugin", "/fake/.codex/plugins/openai-templates/skills/analytics-dashboard/SKILL.md", "openai-templates:artifact-template-analytics-dashboard"), useWhen: "a dashboard from numbers" });
  const { roomId } = await run({ type: "room.create", projectId: "project_demo", title: "skills" });
  const seat = async (alias: string, instanceId: string) => (await run({ type: "participant.create", roomId, alias, modelSelection: { instanceId, model: "m" }, thread: { mode: "create" } })).participantId as string;
  const boss = await seat("Fable", "claudeAgent");
  const sol = await seat("Sol", "codex");
  await run({ type: "room.consigliere.set", roomId, participantId: boss });
  const his = await stack.seats.standingText(boss);
  assert.ok(his.includes("- openai-templates:artifact-template-analytics-dashboard (Codex · plugin) · use when: a dashboard from numbers · has it: sol"), his);
  assert.equal((await stack.seats.standingText(sol)).includes("== Skills the user wrote lines for =="), false);
});

const rows = (): SkillRow[] => {
  const base = { label: null, path: null, hint: null, userInvocationOnly: false, userInvocable: true, members: [], linked: [], useWhen: "", avoid: "", description: null, source: "" };
  return [
    ...ROOM_DIRECTIVES.map((d) => ({ ...base, id: d.name, kind: "directive" as const, name: d.name, description: d.description, hint: d.hint, instances: [] })),
    { ...base, id: "c1", kind: "command", name: "compact", description: "Claude's", instances: ["claudeAgent"] },
    { ...base, id: "c2", kind: "command", name: "compact", description: "Codex's", instances: ["codex"], avoid: "mid-review" },
    { ...base, id: "c3", kind: "command", name: "clear", description: "clears", instances: ["claudeAgent"] },
    { ...base, id: "s4", kind: "skill", name: "copy-edit", description: "edits", instances: ["codex"], avoid: "legal text" },
    { ...base, id: "s1", kind: "skill", name: "deploy-check", description: "the author's", instances: ["codex"], userInvocationOnly: true },
    { ...base, id: "s2", kind: "skill", name: "house-style", description: "model only", instances: ["codex"], userInvocable: false },
    { ...base, id: "s3", kind: "skill", name: "imagegen", description: "images", instances: ["codex"], useWhen: "a bitmap is wanted" },
    { ...base, id: "p1", kind: "pack", name: "alpha", description: "Alpha.", instances: ["claudeAgent", "codex"] },
  ] as SkillRow[];
};

test("the composer's / list: grouped by kind, the user's line under each (the author's when none), avoid last in its group, model-only skills not offered, user-only ones offered; picking a skill writes words", () => {
  const view = (recipients: Array<string | null>, atStart: boolean, query = "") => slashEntries(rows(), recipients, { atStart, query }).map((e) => [e.kind, e.name, e.line, e.mine, e.avoid]);
  assert.deepEqual(view(["codex"], false), [
    ["directive", "now", "Start now", false, null],
    ["command", "compact", "Codex's", false, "mid-review"],
    ["skill", "deploy-check", "the author's", false, null],
    ["skill", "imagegen", "a bitmap is wanted", true, null],
    ["skill", "copy-edit", "edits", false, "legal text"],
    ["pack", "alpha", "Alpha.", false, null],
  ]);
  assert.deepEqual(view(["claudeAgent", "codex"], false).map((e) => e[1]), ["now", "compact", "alpha"], "what every addressed member has");
  assert.deepEqual(view([], true).map((e) => e[1]), ["now", "add", "remove"], "at the start with no one addressed: the directives");
  assert.deepEqual(view(["codex"], false, "im").map((e) => e[1]), ["imagegen"]);
  assert.deepEqual(view([null], false).map((e) => e[1]), ["now"], "a member whose harness is unknown has nothing listed");
  assert.equal(slashInsert({ kind: "skill", name: "imagegen" }), "using the imagegen skill ");
  assert.equal(slashInsert({ kind: "pack", name: "alpha" }), "using the alpha skill ");
  assert.equal(slashInsert({ kind: "command", name: "compact" }), "/compact ");
  assert.equal(slashInsert({ kind: "directive", name: "now" }), "/now ");
});

