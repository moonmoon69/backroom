import type { SkillKind, SkillRow } from "./types.ts";

/** One entry of the composer's "/" list, drawn from the roster (src/app/skillRoster.ts). */
export interface SlashEntry {
  key: string;
  kind: SkillKind;
  name: string;
  /** What a command takes after its name. */
  hint: string | null;
  /** The user's "use when" line, else the author's. */
  line: string | null;
  /** Whether `line` is the user's. */
  mine: boolean;
  /** The user's "avoid" line: the entry sinks to the bottom of its group. */
  avoid: string | null;
}

const KINDS: SkillKind[] = ["directive", "command", "skill", "pack"];
/** The room directives offered after an @name; the others only at a message's start. */
export const ADDRESSED_DIRECTIVES = new Set(["now"]);
/** The most entries the list shows. */
export const SLASH_LIST_MAX = 40;

/**
 * The "/" list: the room's directives (all at a message's start, /now after an @name), then for the addressed members
 * what every one of them has (by kind and name, from their harnesses' instances), grouped by kind as the roster is, each
 * with the user's line (the author's when there is none), the entries with an avoid line last in their group. A skill its
 * author lets only the model invoke is not offered; one only the user may invoke is.
 */
export function slashEntries(rows: SkillRow[], recipients: Array<string | null>, options: { atStart: boolean; query: string }): SlashEntry[] {
  const query = options.query.toLowerCase();
  const groups = new Map<string, SkillRow[]>();
  for (const row of rows) {
    if (row.kind === "directive" ? !options.atStart && !ADDRESSED_DIRECTIVES.has(row.name) : recipients.length === 0 || !row.userInvocable) continue;
    if (!row.name.toLowerCase().includes(query)) continue;
    const key = `${row.kind}:${row.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const entries: SlashEntry[] = [];
  for (const [key, named] of groups) {
    const first = named[0]!;
    if (first.kind !== "directive" && !recipients.every((instance) => instance !== null && named.some((row) => row.instances.includes(instance)))) continue;
    // The lines of the addressed members' own rows: a command of the same name on another harness is another row.
    const matching = first.kind === "directive" ? named : named.filter((row) => row.instances.some((instance) => recipients.includes(instance)));
    const useWhen = matching.find((row) => row.useWhen)?.useWhen ?? null;
    entries.push({
      key,
      kind: first.kind,
      name: first.name,
      hint: first.hint,
      line: useWhen ?? matching.find((row) => row.description)?.description ?? null,
      mine: useWhen !== null,
      avoid: matching.find((row) => row.avoid)?.avoid ?? null,
    });
  }
  const order = (entry: SlashEntry) => KINDS.indexOf(entry.kind);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => order(a.entry) - order(b.entry) || Number(a.entry.avoid !== null) - Number(b.entry.avoid !== null) || a.index - b.index)
    .map(({ entry }) => entry)
    .slice(0, SLASH_LIST_MAX);
}

/** What picking an entry puts in the text: a directive or a command as itself, a skill as words in the message (never a leading slash). */
export function slashInsert(entry: Pick<SlashEntry, "kind" | "name">): string {
  return entry.kind === "directive" || entry.kind === "command" ? `/${entry.name} ` : `using the ${entry.name} skill `;
}
