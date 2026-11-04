/**
 * The fixed facts of skills that the database, the service and the page share: pstack (the pack every Backroom starts
 * with), the two standing texts it can have (once Poteto mode's positions), the skill folders the harnesses read, and
 * how a roster row is named. src/app/packs.ts keeps the packs and their links; src/app/skillRoster.ts builds the roster.
 */

/** The pack every Backroom starts with: Lauren Tan's pstack, kept in a clone of cursor/plugins. */
export const PSTACK_PACK = "pstack";
export const PSTACK_REPO = "https://github.com/cursor/plugins";
/** pstack's folder under data/skills: the clone Poteto mode made, kept where it was. */
export const PSTACK_FOLDER = "cursor-plugins";

/** Where a standing text names its pack's folder: filled with the folder's real path wherever the text is used. */
export const FOLDER_PLACEHOLDER = "{folder}";

const MODE_PATHS = `${FOLDER_PLACEHOLDER}/pstack/skills/poteto-mode/SKILL.md (Claude Code: the copy at ${FOLDER_PLACEHOLDER}/harness/pstack/claude-code/skills/poteto-mode/SKILL.md); skip setup-pstack.`;

/**
 * pstack's two standing texts, the one source of both (the migration seeds them from Poteto mode's positions). Principles
 * (the user's #74 and #89 in the agents.md room): poteto-mode's principles, reply and comment rules apply, and its triggers
 * and playbooks, the process half, are the room's to call for, since the Consigliere routes work, seats the reviewer and
 * names the playbook a job needs. The whole mode (#119): the mode as its author publishes it, with no scope sentence.
 */
export const POTETO_WORDS = {
  principles: {
    label: "Principles and reply rules",
    text: `Follow poteto-mode's principles, reply and comment rules at ${MODE_PATHS} Its triggers and playbooks apply only when your assignment names them: no how, architect, arena, interrogate or swarm fan-out, no mandatory subagent delegation, no data-shape-first or lever-building rule, no plan template and no pull request otherwise. Where the mode conflicts with this file, this file wins.`,
  },
  full: {
    label: "The whole mode",
    text: `For any non-trivial job, read and follow poteto-mode at ${MODE_PATHS} Where the mode conflicts with this file, this file wins.`,
  },
} as const;

/** A folder the harnesses discover skills in, under the home folder, and which of T3's drivers read it. */
export interface SkillFolderSpec {
  id: string;
  /** Below the home folder. */
  relative: string;
  /** T3 drivers whose harness reads it. */
  drivers: string[];
}

/**
 * The user-level skill folders Backroom links into. A folder is shared by every harness that reads it: a link placed for
 * one reaches the others, so nothing here is per harness.
 */
export const SKILL_FOLDERS: SkillFolderSpec[] = [
  { id: "claude", relative: ".claude/skills", drivers: ["claudeAgent", "cursor", "opencode"] },
  { id: "agents", relative: ".agents/skills", drivers: ["codex", "cursor", "opencode", "pi"] },
  { id: "grok", relative: ".grok/skills", drivers: ["grok"] },
];

/** The harnesses by T3's driver names, as the page names them. */
export const DRIVER_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  grok: "Grok",
  antigravity: "Antigravity",
};

/** The name in ~/.claude/skills that Claude's account sync owns: never a link of Backroom's. */
export const SYNCED_NAME = "synced";

/**
 * pstack's two trees and the folders each may be linked into: Claude Code's generated copy (with its adapter) to Claude's
 * folder, Cursor's own tree to the others. Its other candidates (in a full clone, other plugins) go anywhere.
 */
export const PSTACK_TREES: Array<{ prefix: string; folders: string[] }> = [
  { prefix: "harness/pstack/claude-code/skills/", folders: ["claude"] },
  { prefix: "pstack/skills/", folders: ["agents", "grok"] },
];

/** The kinds a roster row is, in the order the roster and the composer group them. */
export const SKILL_KINDS = ["directive", "command", "skill", "pack"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

/**
 * A roster row's identity, which the user's lines are kept by: a room directive by its name, a harness command by its
 * provider instance and name, a skill T3 lists by provider instance, scope, path and qualified name, and a pack's skill by
 * the pack and the skill folder's path in it. Never by a display name.
 */
export const skillRowId = {
  directive: (name: string) => JSON.stringify(["directive", name]),
  command: (instanceId: string, name: string) => JSON.stringify(["command", instanceId, name]),
  skill: (instanceId: string, scope: string | null, path: string | null, name: string) => JSON.stringify(["skill", instanceId, scope ?? "", path ?? "", name]),
  pack: (pack: string, path: string) => JSON.stringify(["pack", pack, path]),
};

/** A SKILL.md's frontmatter name and description: plain, quoted, folded or indented-continued values, on one line. */
export function frontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { name: null, description: null };
  const lines = (match[1] ?? "").split(/\r?\n/);
  const value = (key: string): string | null => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return null;
    let first = (lines[index] ?? "").slice(key.length + 1).trim();
    const more: string[] = [];
    for (let i = index + 1; i < lines.length && /^(\s|$)/.test(lines[i] ?? ""); i += 1) more.push((lines[i] ?? "").trim());
    if (/^[>|][-+]?$/.test(first)) first = "";
    let text = [first, ...more].filter(Boolean).join(" ");
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text) ?? /^'((?:[^']|'')*)'$/.exec(text);
    if (quoted) text = text.startsWith('"') ? (quoted[1] ?? "").replace(/\\(.)/g, "$1") : (quoted[1] ?? "").replace(/''/g, "'");
    return text.replace(/\s+/g, " ").trim() || null;
  };
  return { name: value("name"), description: value("description") };
}
