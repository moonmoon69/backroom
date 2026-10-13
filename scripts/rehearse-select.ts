/**
 * Which states a rehearsal step plays (T2), from `--only` and `--until`:
 *
 * - `--only <state>` (as many as wanted) checks just the states it names; what they depend on is played silently first
 *   (the story's actions run, the other states' page checks and screenshots do not), and the step stops after the
 *   last of them.
 * - `--until <state>` plays every state, checked as always, and stops after the one it names.
 *
 * A state is named by its number in the step (as `--list` prints them, from 1), a range of numbers ("12-15"), a
 * /pattern/ on its name, or any part of its name (case aside).
 *
 * A step cut into sections (rehearse-keys.ts's, each `section("<its first state>", …)`) does not play the sections
 * before the one the first state checked is in: that one's setup builds what it starts from, and its states before the
 * chosen one are played silently. The step's states are read from the script's source,
 * where each is named by a string literal at its call; as the step runs, every state is checked against that list, so
 * a list out of step with the script fails the run instead of choosing the wrong state.
 */

/**
 * The names in the calls `state("…")`, `check.state("…")` (any object's) and `check.begin("…")` (a state checked by
 * hand) of a piece of source, in order.
 */
export function stateNames(source: string): string[] {
  return [...source.matchAll(/(?<![\w.])(?:\w+\.)?(?:state|begin)\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string);
}

/** The first states of the sections of a piece of source: the names in its calls `section("…")`, in order. */
export function sectionNames(source: string): string[] {
  return [...source.matchAll(/(?<![\w.])section\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string);
}

/**
 * The sections of a piece of source whose call is not followed by the call of the state they name: a section begins
 * right before its first state's code, so the next state called after `section("X")` is X.
 */
export function misplacedSections(source: string): string[] {
  const states = [...source.matchAll(/(?<![\w.])(?:\w+\.)?(?:state|begin)\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => ({ at: m.index, name: JSON.parse(m[1]!) as string }));
  return [...source.matchAll(/(?<![\w.])section\(\s*("(?:[^"\\\n]|\\.)*")/g)]
    .map((m) => ({ name: JSON.parse(m[1]!) as string, next: states.find((x) => x.at > m.index)?.name }))
    .filter((x) => x.next !== x.name)
    .map((x) => `section(${JSON.stringify(x.name)}) is followed by state ${JSON.stringify(x.next ?? "(none)")}`);
}

/** Where each step's states are: a script, and the functions of it that play them, in order (none: the whole file). */
export const STEP_SOURCES = {
  ui: { file: "rehearse.ts", functions: ["rehearseUi", "rehearseAgentsFile", "rehearseProjectBrowsers", "rehearsePagePush", "rehearseThreadPush"] },
  room: { file: "rehearse.ts", functions: ["rehearseRoom", "rehearseBrowserPanel"] },
  keys: { file: "rehearse-keys.ts", functions: [] },
} as const;

/** A step's source, its parts in the order the step plays them, read with `read` (a script's name → its text). */
export function stepSource(step: keyof typeof STEP_SOURCES, read: (file: string) => string): string[] {
  const { file, functions } = STEP_SOURCES[step];
  const text = read(file);
  return functions.length === 0 ? [text] : functions.map((name) => functionSource(text, name));
}

/** The text of a top-level function of a module's source, from its declaration to the next top-level declaration. */
export function functionSource(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  if (start < 0) throw new Error(`no function ${name} in the source`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async function|function|class|const|let|interface|type) /m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** The indexes (from 0) of the states a name stands for: see the module's comment. */
export function matching(names: readonly string[], pattern: string): number[] {
  const range = /^(\d+)(?:-(\d+))?$/.exec(pattern.trim());
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    return names.map((_, i) => i).filter((i) => i + 1 >= from && i + 1 <= to);
  }
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) {
    const re = new RegExp(regex[1]!, regex[2]);
    return names.map((name, i) => (re.test(name) ? i : -1)).filter((i) => i >= 0);
  }
  const part = pattern.toLowerCase();
  return names.map((name, i) => (name.toLowerCase().includes(part) ? i : -1)).filter((i) => i >= 0);
}

/**
 * For a run of every step (--step all): the flags that apply to one step, given its states. A step runs with no flags
 * given, or when one of them names a state of its own; then it gets the --only patterns that name one of its states,
 * and --until if it names one.
 */
export function forStep(names: readonly string[], only: readonly string[], until: string | null): { run: boolean; only: string[]; until: string | null } {
  const mine = only.filter((pattern) => matching(names, pattern).length > 0);
  const stop = until !== null && matching(names, until).length > 0 ? until : null;
  const run = (only.length === 0 && until === null) || mine.length > 0 || (only.length === 0 && stop !== null);
  return { run, only: mine, until: stop };
}

/**
 * For --step all, every step's flags (forStep), once each --only and --until is found to name a state of some step:
 * a name no step has is a mistake, not a step left out. (A number names that state in every step that has it.)
 */
export function forSteps<S extends string>(steps: Record<S, readonly string[]>, only: readonly string[], until: string | null): Record<S, { run: boolean; only: string[]; until: string | null }> {
  const all = Object.values(steps) as Array<readonly string[]>;
  for (const [flag, patterns] of [["--only", only], ["--until", until === null ? [] : [until]]] as const) {
    for (const pattern of patterns) if (!all.some((names) => matching(names, pattern).length > 0)) throw new Error(`no state of any step matches ${flag} ${JSON.stringify(pattern)}; --list prints them`);
  }
  return Object.fromEntries(Object.entries(steps).map(([step, names]) => [step, forStep(names as readonly string[], only, until)])) as Record<S, { run: boolean; only: string[]; until: string | null }>;
}

/** Thrown after the last state the selection plays: the step ends there, passed. */
export class SelectionDone extends Error {}

export class Selection {
  readonly names: readonly string[];
  /** The states checked as always; null for all of them (no --only). */
  private readonly loudSet: ReadonlySet<number> | null;
  /** The index of the last state played: the step stops after it. */
  readonly last: number;
  /** The index of the state the step is at: the next `enter` must name names[cursor]. */
  private cursor = 0;
  /** How many states were checked, set up silently, and not played (a section a jump skips). */
  private readonly count = { checked: 0, silent: 0, skipped: 0 };
  /** The index of each section's first state, in order (none: the step plays from its start). */
  private readonly starts: readonly number[];

  constructor(names: readonly string[], only: readonly string[] = [], until: string | null = null, sections: readonly string[] = []) {
    if (names.length === 0) throw new Error("no states were found in the step's source");
    const duplicate = names.find((name, i) => names.indexOf(name) !== i);
    if (duplicate) throw new Error(`two states share the name ${JSON.stringify(duplicate)}: name each once, so --only can choose it`);
    this.names = names;
    const chosen = (pattern: string, flag: string) => {
      const found = matching(names, pattern);
      if (found.length === 0) throw new Error(`no state matches ${flag} ${JSON.stringify(pattern)}; --list prints the step's states`);
      return found;
    };
    const loud = only.flatMap((pattern) => chosen(pattern, "--only"));
    this.loudSet = only.length > 0 ? new Set(loud) : null;
    const stop = until === null ? null : chosen(until, "--until")[0]!;
    this.last = stop ?? (loud.length > 0 ? Math.max(...loud) : names.length - 1);
    if (this.loudSet && ![...this.loudSet].some((i) => i <= this.last)) throw new Error(`--until ${JSON.stringify(until)} stops before every state --only names`);
    this.starts = sections.map((first) => {
      const index = names.indexOf(first);
      if (index < 0) throw new Error(`a section starts at ${JSON.stringify(first)}, which is no state's name`);
      return index;
    });
    if (this.starts.length > 0 && this.starts[0] !== 0) throw new Error(`the first section must start at the step's first state, ${JSON.stringify(names[0])}`);
    if (this.starts.some((start, i) => i > 0 && start <= this.starts[i - 1]!)) throw new Error("the sections are not in the order of their states");
  }

  /** Whether the run jumps into a section past the first: the sections before it are not played. */
  get jumps(): boolean {
    return this.target > 0;
  }

  /**
   * Whether a section played runs its setup's replay: in a run that jumps, the section it jumps into and every one played
   * after it, since a later one may read what the skipped sections would have made (a replay makes only what is still
   * missing); never in a run that plays from the start.
   */
  replays(first: string): boolean {
    const k = this.starts.findIndex((start) => this.names[start] === first);
    if (k < 0) throw new Error(`no section starts at ${JSON.stringify(first)}`);
    return this.jumps && k >= this.target;
  }

  /** The section the first state checked is in: a run jumps there. */
  private get target(): number {
    return this.starts.findLastIndex((start) => start <= this.first);
  }

  /**
   * A section begins (named by its first state): "skip" when all its states come before the first one checked (they
   * are counted as not played), "jump" when it holds that state and the sections before it were skipped (its setup
   * runs), else "play".
   */
  section(first: string): "skip" | "jump" | "play" {
    const k = this.starts.findIndex((start) => this.names[start] === first);
    if (k < 0) throw new Error(`no section starts at ${JSON.stringify(first)}`);
    const start = this.starts[k]!;
    if (this.cursor !== start) throw new Error(`the section of ${JSON.stringify(first)} (state ${start + 1}) begins with the script at state ${this.cursor + 1}: the sections are out of step with the states`);
    if (k < this.target) {
      this.skip((this.starts[k + 1] ?? this.names.length) - start);
      return "skip";
    }
    return k === this.target && k > 0 ? "jump" : "play";
  }

  /** Whether every state up to the end is played and checked: no --only, no --until. */
  get whole(): boolean {
    return this.loudSet === null && this.last === this.names.length - 1;
  }

  /** Whether the state at `index` is checked (else it is set up silently). */
  loud(index: number): boolean {
    return index <= this.last && (this.loudSet === null || this.loudSet.has(index));
  }

  /** The first state checked: what a run that jumps ahead jumps to. */
  get first(): number {
    return this.loudSet === null ? 0 : Math.min(...this.loudSet);
  }

  /**
   * A state begins: its index, and whether it is checked. It must be the state the source lists next, or the list is out
   * of step with the script (a state named other than by a literal, or played out of order). Past the last state played,
   * the step stops here: a state whose checks go on after its call (rehearse.ts's check.state) has had them all.
   */
  enter(name: string): { index: number; loud: boolean } {
    const index = this.cursor;
    if (index > this.last && !this.whole) this.done();
    if (this.names[index] !== name) {
      throw new Error(`the states read from the source are out of step with the script: state ${index + 1} is ${JSON.stringify(this.names[index] ?? "(none)")} in the source, but the script runs ${JSON.stringify(name)}`);
    }
    this.cursor += 1;
    const loud = this.loud(index);
    this.count[loud ? "checked" : "silent"] += 1;
    return { index, loud };
  }

  /** A whole run of states the script skips (a section a jump does not play): the cursor moves past them. */
  skip(count: number): void {
    this.cursor += count;
    this.count.skipped += count;
  }

  /** The index of the state the script is at. */
  get at(): number {
    return this.cursor;
  }

  /**
   * A state whose checks are all done by now ended (rehearse-keys.ts's state, called last): after the last one played,
   * the step stops at once.
   */
  leave(index: number): void {
    if (index >= this.last && !this.whole) this.done();
  }

  /** Past the last state played, the step stops here: before work that leads only to later states. */
  stopIfDone(): void {
    if (this.cursor > this.last && !this.whole) this.done();
  }

  private done(): never {
    throw new SelectionDone(`${this.summary()}; stopped after state ${this.last + 1} of ${this.names.length}`);
  }

  /** How many states were checked so far. */
  get checked(): number {
    return this.count.checked;
  }

  /** How many states were checked, set up silently and not played. */
  summary(): string {
    const { checked, silent, skipped } = this.count;
    return `${checked} state${checked === 1 ? "" : "s"} checked in the API and on the page, console clean; ${silent} set up silently${skipped > 0 ? `, ${skipped} not played` : ""}`;
  }

  /** "12/76 name", for logs. */
  label(index: number): string {
    return `${index + 1}/${this.names.length} ${this.names[index]}`;
  }
}
