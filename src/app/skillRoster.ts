/**
 * The skills roster (board #113, #199, #218): every skill, command and directive the user can name, one row per source,
 * with the user's two lines (use when, avoid) beside the author's. Settings → Skills shows it, the composer's "/" list is
 * drawn from it, and the Consigliere's briefing carries the rows the user wrote lines for (src/briefing/assemble.ts).
 *
 * Rows are the room's directives, what T3 reports per provider (its slash commands, and its skills list with each skill's
 * path, scope and who may invoke it), and the packs' skills Backroom has linked (src/app/packs.ts). A row's identity is its
 * source (skillRowId in src/domain/skills.ts), never a display name. A T3 skill whose real path is a pack's skill folder is
 * that pack's row; so is a slash command with no path of a harness that reads a folder holding Backroom's link of that name.
 * T3 lists what a harness found at its session's start, so a newly linked skill reaches a member after a reseat.
 */
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { T3Adapter, T3ProviderInfo } from "../adapter/types.ts";
import type { Repos } from "../db/repos.ts";
import { SKILL_KINDS, skillRowId, type SkillKind } from "../domain/skills.ts";
import type { Pack, Preset, SkillHint } from "../domain/types.ts";
import type { LinkFolder, PackSkill, Packs } from "./packs.ts";

/** The room's own directives, as the composer offers them after "/" (the parser, web/src/parser.ts, reads them). */
export const ROOM_DIRECTIVES: Array<{ name: string; description: string; hint: string | null }> = [
  { name: "now", description: "Start now", hint: null },
  { name: "add", description: "Seat a new member on a new T3 thread", hint: "name" },
  { name: "remove", description: "Remove a member from the room", hint: "@name" },
];

export interface SkillRow {
  id: string;
  kind: SkillKind;
  /** The name it is invoked or named by, a plugin's prefix kept. */
  name: string;
  /** T3's display name, shown beside the name. */
  label: string | null;
  /** The author's line (T3's short description, else its description; a pack's from its frontmatter). */
  description: string | null;
  /** Where it comes from: "room", a provider (and scope), or a pack and the skill's path in it. */
  source: string;
  /** Its folder's real path, for a skill. */
  path: string | null;
  /** What a command takes after its name. */
  hint: string | null;
  /** Its author lets only the user invoke it (T3's userInvocationOnly): offered in the composer, never routed by the Consigliere on his own. */
  userInvocationOnly: boolean;
  /** False: its author lets only the model invoke it: not offered in the composer. */
  userInvocable: boolean;
  /** The provider instances whose T3 list has it. */
  instances: string[];
  /** The saved crew members who have it: those whose harness's T3 list has it. */
  members: string[];
  /** For a pack's skill: the folders Backroom's link to it is in. */
  linked: string[];
  useWhen: string;
  avoid: string;
}

export interface RosterInput {
  /** T3's providers; null when T3 could not be read (the rows T3 reports are then missing, the rest stand). */
  providers: T3ProviderInfo[] | null;
  packs: Array<{ pack: Pack; skills: PackSkill[] }>;
  folders: LinkFolder[];
  crew: Preset[];
  hints: Map<string, SkillHint>;
}

const realDir = (skillFile: string | null): string | null => {
  if (!skillFile) return null;
  const folder = skillFile.endsWith("SKILL.md") ? dirname(skillFile) : skillFile;
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

const blank = (row: Pick<SkillRow, "id" | "kind" | "name" | "source"> & Partial<SkillRow>): SkillRow => ({
  label: null,
  description: null,
  path: null,
  hint: null,
  userInvocationOnly: false,
  userInvocable: true,
  instances: [],
  members: [],
  linked: [],
  useWhen: "",
  avoid: "",
  ...row,
});

/** The roster: directives, harness commands, skills and the packs' skills, each group by name, with the user's lines. */
export function skillRoster(input: RosterInput): SkillRow[] {
  const rows: SkillRow[] = ROOM_DIRECTIVES.map((d) => blank({ id: skillRowId.directive(d.name), kind: "directive", name: d.name, description: d.description, source: "room", hint: d.hint }));
  const packRows = new Map<string, SkillRow>();
  const byLink = new Map<string, SkillRow>();
  for (const { pack, skills } of input.packs) {
    for (const skill of skills) {
      const row = blank({ id: skillRowId.pack(pack.name, skill.path), kind: "pack", name: skill.name, description: skill.description, source: `${pack.name} · ${skill.path}`, path: skill.realPath, linked: skill.linked });
      packRows.set(skill.realPath, row);
      // A harness names a skill it found by its frontmatter's name, else its folder's.
      for (const folder of skill.linked) for (const name of new Set([skill.linkName, skill.name])) byLink.set(`${folder}/${name}`, row);
    }
  }
  const addInstance = (row: SkillRow, instanceId: string) => {
    if (!row.instances.includes(instanceId)) row.instances.push(instanceId);
  };
  for (const provider of input.providers ?? []) {
    const folders = input.folders.filter((folder) => provider.driver !== undefined && folder.drivers.includes(provider.driver)).map((folder) => folder.id);
    for (const skill of provider.skills ?? []) {
      const real = realDir(skill.path);
      const packRow = real ? packRows.get(real) : undefined;
      if (packRow) {
        if (skill.enabled) addInstance(packRow, provider.instanceId);
        packRow.userInvocationOnly ||= skill.userInvocationOnly;
        packRow.userInvocable &&= skill.userInvocable;
        continue;
      }
      // A skill its harness has turned off is no one's to use.
      if (!skill.enabled) continue;
      rows.push(
        blank({
          id: skillRowId.skill(provider.instanceId, skill.scope, skill.path, skill.name),
          kind: "skill",
          name: skill.name,
          label: skill.displayName && skill.displayName !== skill.name ? skill.displayName : null,
          description: skill.shortDescription ?? skill.description,
          source: skill.scope ? `${provider.displayName} · ${skill.scope}` : provider.displayName,
          path: real,
          userInvocationOnly: skill.userInvocationOnly,
          userInvocable: skill.userInvocable,
          instances: [provider.instanceId],
        }),
      );
    }
    for (const command of provider.slashCommands ?? []) {
      const linked = folders.map((folder) => byLink.get(`${folder}/${command.name}`)).find(Boolean);
      if (linked) {
        addInstance(linked, provider.instanceId);
        continue;
      }
      rows.push(blank({ id: skillRowId.command(provider.instanceId, command.name), kind: "command", name: command.name, description: command.description, source: provider.displayName, hint: command.hint, instances: [provider.instanceId] }));
    }
  }
  rows.push(...[...packRows.values()].filter((row) => row.linked.length > 0 || row.instances.length > 0));
  for (const row of rows) {
    row.members = input.crew.filter((preset) => row.instances.includes(preset.modelSelection.instanceId)).map((preset) => preset.name);
    const hint = input.hints.get(row.id);
    if (hint) Object.assign(row, hint);
  }
  const order = (kind: SkillKind) => SKILL_KINDS.indexOf(kind);
  // Directives keep their own order; the other groups go by name.
  return rows.sort((a, b) => order(a.kind) - order(b.kind) || (a.kind === "directive" ? 0 : a.name.localeCompare(b.name) || a.source.localeCompare(b.source)));
}

/** What the Consigliere's briefing says of a row the user wrote lines for. */
export interface SkillLine {
  name: string;
  source: string;
  useWhen: string;
  avoid: string;
  members: string[];
  userInvocationOnly: boolean;
}

/** The rows the Consigliere is told of: every one but the room's directives with at least one line of the user's. */
export function skillLines(rows: SkillRow[]): SkillLine[] {
  return rows
    .filter((row) => row.kind !== "directive" && (row.useWhen || row.avoid))
    .map((row) => ({ name: row.name, source: row.source, useWhen: row.useWhen, avoid: row.avoid, members: row.members, userInvocationOnly: row.userInvocationOnly }));
}

/** The roster as it is now: T3's providers read (null, with why, when T3 did not answer), the packs' skills and the user's lines. */
export async function readRoster(input: { packs: Packs | null; adapter: Pick<T3Adapter, "listProviders">; repos: Pick<Repos, "listPresets" | "listSkillHints"> }): Promise<{ rows: SkillRow[]; t3Error: string | null }> {
  let t3Error: string | null = null;
  const providers = await input.adapter.listProviders().catch((error: unknown) => {
    t3Error = error instanceof Error ? error.message : String(error);
    return null;
  });
  const packs = input.packs;
  const rows = skillRoster({
    providers,
    packs: packs ? packs.list().map((pack) => ({ pack, skills: packs.skills(pack) })) : [],
    folders: packs?.folders() ?? [],
    crew: input.repos.listPresets(),
    hints: input.repos.listSkillHints(),
  });
  return { rows, t3Error };
}
