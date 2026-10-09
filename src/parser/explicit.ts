/**
 * Explicit composer syntax. Deterministic; no model.
 *
 *   @sol2 review the diff                       -> one assignment for sol2
 *   @sol1 @sol2 independently investigate       -> one assignment, a request each
 *   @alice do this @bob do that                 -> two assignments
 *   @alice /steer also add tests                -> if alice is mid-turn, sent into that turn
 *   @all review the release notes               -> one assignment, every participant
 *   Sol two, review the parser                  -> spoken alias at the start resolves to sol2
 *
 * Nothing waits on other work (decision D2). /after and /hold are refused wherever they are written, and so is a wait
 * the text implies, with the way out: "@alice fix it, then @bob deploy" ("then"), "@alice fix it. @bob check alice's
 * work" (naming an earlier recipient), "when @grok finishes, @fable check it" (a condition). /now on an assignment says
 * it goes now, which takes away the implied wait. Room notes are gone (N1): a message that starts with /note is refused.
 *
 * In a room that has a Consigliere, every message is for him, whoever it names: he reads the @names as who the user
 * wants on it and hands the work out himself. It is sent into his turn when he is working, so it reaches him while he
 * waits. Only a T3 slash command ("@bob /compact") still goes to the member it names, because a harness runs one only
 * when it is the whole message on its own thread.
 *
 * Only the addressing/command syntax is interpreted; the remaining text of each assignment is its verbatim instruction.
 * Incomplete or invalid syntax produces a draft with unresolved fields rather than an error.
 */

export interface ParticipantRef {
  id: string;
  alias: string;
  /** True when the participant is working (room run or direct T3 activity). Used for alias pools. */
  busy?: boolean;
}

export interface Unresolved {
  /** "wait": the assignment waits on other work, which is refused (D2); "delivery": how it reaches a running turn. */
  field: "recipients" | "wait" | "delivery" | "instruction";
  message: string;
  /** "incomplete": still being written (no recipient or no text yet), shown as guidance. "error": cannot be sent as written. */
  severity: "incomplete" | "error";
  participantCandidates?: Array<{ participantId: string; alias: string; busy: boolean }>;
}

/** An @mention in the source text and how it was read. Offsets index into sourceText. */
export interface MentionSpan {
  start: number;
  end: number;
  alias: string;
  participantId: string | null;
  role: "address" | "reference";
  /** Assignment the mention belongs to; null inside the preamble. */
  assignment: number | null;
}

export interface DependencyRef {
  /** Index of an earlier assignment in the same message. */
  index: number;
  /** Why: "then" (sequencing word), "mention" (names that assignment's recipient), "after" (explicit /after @name),
   *  "condition" ("when @grok finishes, @fable check it" or "@fable check it when @grok finishes"). */
  because: "then" | "mention" | "after" | "condition";
}

/** One assignment of a message: the same instruction for each recipient, one request per recipient. */
export interface DraftAssignment {
  recipients: string[];
  instruction: string;
  /** Earlier assignments in this message that this one's text waits for: a wait that is refused (D2), unless /now. */
  after: DependencyRef[];
  /** The timing directive written for this assignment, if any: /now takes away an implied wait; /hold and /after are refused. */
  timing: "now" | "hold" | "after" | null;
  /** "/steer": if the recipient is mid-turn, send into that turn instead of waiting for it to end. */
  delivery: "queue" | "steer";
  /**
   * The instruction starts with a slash command that is not a room command ("@claude /compact …"): it is one of the
   * recipient's T3 commands, run by sending the instruction verbatim. The composer checks the name against T3's list.
   */
  slashCommand: string | null;
  /** Offsets into sourceText: the assignment's span, and where a directive can be inserted (after its addressing). */
  start: number;
  end: number;
  insertAt: number;
  unresolved: Unresolved[];
  consumed: string[];
}

export interface Draft {
  kind: "task" | "empty" | "participant.add" | "participant.remove";
  /** For participant.add: the alias to seat (with T3's default model unless the dialog picks one). */
  add?: { alias: string };
  /** For participant.remove: the resolved participant. */
  participant?: { participantId: string; alias: string };
  /** Kind "task" (a message): the assignments in message order. */
  assignments: DraftAssignment[];
  /** Kind "task": text before the first address. Not an assignment; everyone receives the whole message as context. */
  preamble: string;
  mentions: MentionSpan[];
  sourceText: string;
  /** Everything unresolved, message-level and per assignment. Empty means the draft can be submitted as is. */
  unresolved: Unresolved[];
  /** Tokens consumed as syntax, for display. */
  consumed: string[];
  /** Non-blocking observations. */
  hints: string[];
}

/** "@all" addresses every participant in the room; the alias is reserved. */
export const ALL_ALIAS = "all";

const MENTION = /^@([a-z0-9][a-z0-9_-]*)/i;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * Spoken forms derived from an alias, so dictation works without configuring anything:
 * "sol2" → "sol two", "sol 2"; "code-reviewer" → "code reviewer". Explicit spoken aliases are added on top.
 */
export function spokenVariants(alias: string): string[] {
  const variants = new Set<string>();
  const lower = alias.toLowerCase();
  const spaced = lower.replace(/[-_]+/g, " ");
  if (spaced !== lower) variants.add(spaced);
  const split = /^([a-z]+)(\d+)$/.exec(lower);
  if (split) {
    const [, word, digits] = split as unknown as [string, string, string];
    variants.add(`${word} ${digits}`);
    const number = Number(digits);
    if (number >= 0 && number < NUMBER_WORDS.length) variants.add(`${word} ${NUMBER_WORDS[number]}`);
  }
  variants.delete(lower);
  return [...variants];
}

const matchesSpoken = (participant: ParticipantRef, wanted: string): boolean =>
  participant.alias.toLowerCase() === wanted || spokenVariants(participant.alias).includes(wanted);


export interface ParseOptions {
  /** The room's Consigliere, when it has one: who an unaddressed message is for, and who @all leaves out. */
  consigliereId?: string | null;
}

export function parseExplicit(text: string, participants: ParticipantRef[], options: ParseOptions = {}): Draft {
  const sourceText = text;
  const trimmed = text.trim();
  const byAlias = new Map(participants.map((p) => [p.alias.toLowerCase(), p]));
  const draft: Draft = { kind: "empty", assignments: [], preamble: "", mentions: [], sourceText, unresolved: [], consumed: [], hints: [] };
  if (trimmed.length === 0) return draft;

  // /add <alias> — seat a new participant on a new T3 thread with T3's default model.
  const addMatch = /^\/add\b\s*(\S+)?\s*$/i.exec(trimmed);
  if (addMatch) {
    draft.kind = "participant.add";
    draft.consumed.push("/add");
    const alias = addMatch[1] ?? "";
    if (!alias) {
      draft.unresolved.push({ severity: "incomplete", field: "recipients", message: "give the new member a name, e.g. /add alice" });
      return draft;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(alias)) {
      draft.unresolved.push({ severity: "error", field: "recipients", message: `"${alias}" is not a valid name (letters, digits, dash, underscore)` });
      return draft;
    }
    if (alias.toLowerCase() === ALL_ALIAS) {
      draft.unresolved.push({ severity: "error", field: "recipients", message: "@all is reserved: it addresses everyone in the room" });
    } else if (byAlias.has(alias.toLowerCase())) {
      draft.unresolved.push({ severity: "error", field: "recipients", message: `@${alias} is already in this room` });
    }
    draft.add = { alias };
    return draft;
  }

  // /remove @alias — retire a participant (the UI asks what happens to its T3 thread).
  const removeMatch = /^\/remove\b\s*@?(.*)$/i.exec(trimmed);
  if (removeMatch) {
    draft.kind = "participant.remove";
    draft.consumed.push("/remove");
    const wanted = (removeMatch[1] ?? "").trim().toLowerCase();
    const participant = wanted ? participants.find((p) => matchesSpoken(p, wanted)) : undefined;
    if (!participant) {
      draft.unresolved.push({ severity: "incomplete", field: "recipients", message: wanted ? `no member @${removeMatch[1]} in this room` : "which member?" });
      return draft;
    }
    draft.participant = { participantId: participant.id, alias: participant.alias };
    return draft;
  }

  // Room notes are gone (N1): a message that starts with /note is refused, not sent.
  if (NOTE_DIRECTIVE.test(trimmed)) {
    draft.kind = "task";
    draft.unresolved.push({ severity: "error", field: "instruction", message: NOTE_GONE });
    return draft;
  }

  draft.kind = "task";
  // Quoted text is literal: @names and /commands inside code blocks, inline code, "> " quotes, or written as \@name
  // address nobody. They are masked (same length, so offsets hold) while parsing and restored in the output.
  const consigliere = options.consigliereId ? (participants.find((p) => p.id === options.consigliereId) ?? null) : null;
  const parsed = parseAssignments(maskQuoted(text), participants, consigliere?.id ?? null);
  const written = [...parsed.assignments];
  if (consigliere) routeToConsigliere(parsed, consigliere.id, text);
  retireDependencies(parsed, written, participants);
  draft.assignments = parsed.assignments.map((a) => ({ ...a, instruction: unmask(a.instruction) }));
  draft.preamble = unmask(parsed.preamble);
  draft.mentions = parsed.mentions;
  draft.hints.push(...parsed.hints.map(unmask));
  for (const assignment of parsed.assignments) {
    draft.consumed.push(...assignment.consumed);
    draft.unresolved.push(...assignment.unresolved);
  }
  if (parsed.assignments.length === 0) {
    draft.unresolved.push({ field: "recipients", severity: "incomplete", message: "start with @name to address someone" });
  }
  return draft;
}

/**
 * In a room that has a Consigliere, what addresses nobody is his: plain text becomes one assignment to him, and an
 * assignment that only lacks a recipient gets him. It is sent as a steer, which reaches him mid-turn and starts a turn
 * of its own when he is idle; a slash command starts its own turn as always.
 */
function routeToConsigliere(parsed: ParsedMessage, consigliereId: string, text: string): void {
  // The user's message that names members goes to him whole, names and all. Slash commands keep their own path.
  const named = parsed.assignments.some((assignment) => assignment.recipients.some((id) => id !== consigliereId) || assignment.unresolved.some((u) => u.field === "recipients" && u.severity === "error"));
  if (named && !parsed.assignments.some((assignment) => assignment.slashCommand !== null) && text.trim().length > 0) {
    const start = text.length - text.trimStart().length;
    parsed.assignments = [{ ...emptyAssignment(start), recipients: [consigliereId], instruction: text.trim(), delivery: "steer", end: text.trimEnd().length }];
    parsed.preamble = "";
    parsed.hints = [];
    for (const mention of parsed.mentions) Object.assign(mention, { role: "reference", assignment: 0 });
    return;
  }
  const steerable = (assignment: DraftAssignment) => assignment.slashCommand === null && assignment.timing === null && assignment.after.length === 0 && !assignment.unresolved.some((u) => u.field === "wait");
  if (parsed.assignments.length === 0) {
    const instruction = parsed.preamble.trim();
    if (instruction.length === 0) return;
    const start = text.length - text.trimStart().length;
    const assignment: DraftAssignment = { ...emptyAssignment(start), recipients: [consigliereId], instruction, end: text.trimEnd().length };
    const command = /^\/([a-z0-9][\w:.-]*)/i.exec(instruction);
    if (command) assignment.slashCommand = command[1] as string;
    if (steerable(assignment)) assignment.delivery = "steer";
    parsed.assignments.push(assignment);
    parsed.preamble = "";
    return;
  }
  parsed.assignments.forEach((assignment, index) => {
    // Alone in the room he gets an unaddressed message already (one member needs no @name); it is sent the same way.
    const addressed = parsed.mentions.some((mention) => mention.role === "address" && mention.assignment === index);
    if (!addressed && assignment.recipients.length === 1 && assignment.recipients[0] === consigliereId && assignment.delivery === "queue" && steerable(assignment)) assignment.delivery = "steer";
  });
  for (const assignment of parsed.assignments) {
    if (assignment.recipients.length > 0) continue;
    const others = assignment.unresolved.filter((u) => !(u.field === "recipients" && u.severity === "incomplete"));
    if (others.some((u) => u.field === "recipients")) continue;
    assignment.recipients.push(consigliereId);
    assignment.unresolved = others;
    if (assignment.delivery === "queue" && steerable(assignment)) assignment.delivery = "steer";
  }
}

/** The retired room note's directive at the start of a message (N1); a T3 command such as /notes-sync is not it. */
export const NOTE_DIRECTIVE = /^\/note(?![\w:.-])/i;
export const NOTE_GONE = "/note is gone: there are no room notes, so send it as a message.";
export const AFTER_GONE = "/after is gone: Backroom no longer waits on other work. Send this once that work is done, or have the Consigliere sequence it.";
export const HOLD_GONE = "/hold is gone: keep this as a draft and send it when it should start.";

/**
 * Decision D2: nothing waits on other work. A /after or /hold directive is refused wherever it is written. A wait the
 * text implies is refused on each assignment that keeps it, with the way out: send it later, have the Consigliere
 * sequence it, or /now. A message the Consigliere takes whole is his to sequence, so it has none. `written` is the
 * assignments as parsed, before any went to the Consigliere.
 */
function retireDependencies(parsed: ParsedMessage, written: DraftAssignment[], participants: ParticipantRef[]): void {
  const used = (assignment: DraftAssignment, name: string) => assignment.consumed.some((token) => token.toLowerCase() === `/${name}`);
  const directives = (assignment: DraftAssignment): Unresolved[] => [
    ...(used(assignment, "after") ? [{ field: "wait" as const, severity: "error" as const, message: AFTER_GONE }] : []),
    ...(used(assignment, "hold") ? [{ field: "wait" as const, severity: "error" as const, message: HOLD_GONE }] : []),
  ];
  const alias = (id: string) => `@${participants.find((p) => p.id === id)?.alias ?? id}`;
  const kept = new Set(parsed.assignments);
  for (const assignment of written) {
    if (!kept.has(assignment)) {
      if (parsed.assignments[0]) parsed.assignments[0].unresolved.push(...directives(assignment));
      continue;
    }
    const refused = directives(assignment);
    const waits = assignment.after.length > 0 || assignment.timing === "after" || assignment.unresolved.some((u) => u.field === "wait");
    if (refused.length === 0 && waits) {
      const names = [...new Set(assignment.after.flatMap((ref) => (written[ref.index]?.recipients ?? []).map(alias)))];
      const whom = names.length > 0 ? names.join(" and ") : "other work";
      const until = names.length > 0 ? names.join(" and ") : "it";
      refused.push({ field: "wait", severity: "error", message: `Waiting for ${whom} is gone: send this once ${until} is done, have the Consigliere sequence it, or add /now to send it now.` });
    }
    assignment.unresolved = [...assignment.unresolved.filter((u) => u.field !== "wait"), ...refused];
  }
}

/** Marks a wait on work outside the message, which retireDependencies refuses. */
function waitsOutside(assignment: DraftAssignment): void {
  if (!assignment.unresolved.some((u) => u.field === "wait")) assignment.unresolved.push({ field: "wait", severity: "error", message: "waits on work outside this message" });
}

/** Words that, directly before a mid-sentence @mention, make it a reference ("work with @alice") rather than a new address. */
const LINK_WORDS = new Set([
  "with", "from", "to", "for", "by", "of", "about", "at", "on", "in", "into", "onto", "over", "through", "than", "like", "after", "before", "as", "via", "per", "between", "unlike", "versus", "vs",
  "what", "whatever", "which", "who", "whom", "whose", "where", "how", "why", "ask", "tell", "cc", "ping",
  "the", "a", "an", "my", "your", "our", "their", "his", "her", "its",
  "when", "once", "until", "unless", "if", "whenever", "while", "since",
]);

/** A condition clause before an address: "when @grok finishes, @fable …", "once alice is done @bob …". */
const CONDITION_LEAD = /^(?:and\s+|then\s+|but\s+)?(when|once|after|as soon as|whenever)\b\s+/i;

/**
 * A condition on the previous assignment(s) by pronoun: "once she's done" (the previous assignment),
 * "once they're finished" / "when both are done" / "when @all finished" (all earlier assignments), "afterwards" (the
 * previous one). "@all" with nothing earlier in the message means everyone else's open work in the room.
 */
const PRONOUN_CONDITION =
  /\b(?:(?:when|once|after|as soon as)\s+(@all|she|he|it|that|they|both|everyone|all)(?:\s+of\s+them)?(?:['’](?:s|re)|\s+(?:is|are|has|have|gets?))?\s+(?:been\s+)?(?:done|finished|finish(?:es)?|complete[sd]?|ready|merged|landed)|(afterwards?|after that))\b/i;

/** A condition at the very start of an instruction: "when @grok finishes, …", "once she's done …". Group 1 is the subject. */
const LEADING_CONDITION_CLAUSE =
  /^(?:and\s+|then\s+|but\s+)?(?:when|once|after|as soon as)\s+([^,.;!?]*?)\s*(?:\b(?:is|are|has|have|gets?)\s+|['’](?:s|re)\s+)?(?:been\s+)?\b(?:done|finished|finish(?:es)?|complete[sd]?|ready|merged|landed)\b[\s,]*/i;

/** A trailing condition on a participant: "… when @grok finishes", "… once alice is done", "… after bob's PR merges". */
const TRAILING_CONDITION =
  /\b(?:when|once|after|as soon as)\s+@?([a-z0-9][a-z0-9_-]*)(?:['’]s\s+\w+)?\s+(?:is\s+|has\s+|['’]s\s+|gets\s+)?(?:done|finished|finishes|completes|completed|wraps up|ready|lands|landed|merges|merged|pushes|pushed)\b/gi;

/** A sequencing lead before an address: "then @bob", "and then @bob", "after that, @bob", "once done @bob". */
const SEQUENCE_LEAD = /^(?:and\s+)?(?:then|after that|afterwards?|once (?:that'?s |that is |it'?s |it is )?(?:done|finished)|when (?:that'?s |that is |it'?s )?(?:done|finished))\b[\s,]*/i;

/** A connector left dangling at the end of an assignment when the next address follows it. */
const TRAILING_CONNECTOR = /(?:^|[\s,;])(and\s+then|then|and|&|\+)[\s,;]*$/i;

const GLOBAL_MENTION = /(?<![\w@/.])@([a-z0-9][a-z0-9_-]*)(?![\w/.-]*[\w/])/gi;

interface ParsedMessage {
  assignments: DraftAssignment[];
  preamble: string;
  mentions: MentionSpan[];
  hints: string[];
}

interface Head {
  assignment: DraftAssignment;
  /** Offset just after the head (addressing and directives). */
  end: number;
  sequence: boolean;
  /** Mention spans consumed as addresses. */
  mentions: MentionSpan[];
  /** /after's @names (and participants named in a leading condition), matched to earlier assignments once they are known. */
  afterTokens: Array<{ token: string; because: "after" | "condition" }>;
  addressed: boolean;
  /** A leading condition that names no participant ("when the tests pass, @bob …"): kept in the instruction. */
  conditionPrefix: string | null;
  /**
   * A leading condition that names participants ("when @grok finishes, @bob …"): a wait on their work, refused like the
   * others, unless /now in the same head lifts it (the clause then goes back into the instruction).
   */
  condition: string | null;
}

/**
 * Split a message into assignments (deterministic, no model).
 *
 * - Leading @mentions address one assignment together: "@alice @bob review this" is the same instruction for both.
 * - A later @mention starts a new assignment ("@alice do this @bob do that"), unless it reads as a reference:
 *   possessive ("@alice's"), directly after a linking word ("work with @alice", "check what @alice did"), or with
 *   nothing after it ("…and tell @alice"). At the start of a sentence or line it always addresses.
 * - "Name," at the start of a sentence addresses too (dictation).
 * - Assignment B would wait for an earlier assignment A of the same message when B follows "then" (or "after that"),
 *   when B's text names one of A's recipients ("@bob check alice's work"), or with "/after @alice"; a condition
 *   ("when @grok finishes") waits too. Such waits are found so that they can be refused (D2); /now on B opts out.
 * - Text before the first address is a preamble; everyone receives the whole message as context.
 */
function parseAssignments(text: string, participants: ParticipantRef[], consigliereId: string | null = null): ParsedMessage {
  const byAlias = new Map(participants.map((p) => [p.alias.toLowerCase(), p]));
  const nameForms = participants
    .flatMap((participant) => [participant.alias.toLowerCase(), ...spokenVariants(participant.alias)].map((form) => ({ form, participant })))
    .sort((a, b) => b.form.length - a.form.length);
  const taken = new Set<string>();
  const assignments: DraftAssignment[] = [];
  const mentions: MentionSpan[] = [];
  const hints: string[] = [];
  const pendingAfter: Array<Array<{ token: string; because: "after" | "condition" }>> = [];
  const sequenceFlags: boolean[] = [];
  const conditionPrefixes: Array<string | null> = [];
  /** Per assignment: its head had a leading condition that names participants (the other implied waits are not read then). */
  const conditionFlags: boolean[] = [];
  let preamble = "";

  const isSentenceStart = (position: number): boolean => {
    const before = text.slice(0, position);
    return /^\s*$/.test(before) || /\n\s*$/.test(before) || /[.!?;:]\s+$/.test(before);
  };
  const possessiveAt = (end: number): boolean => /^['’]s\b/i.test(text.slice(end));

  /**
   * "when @grok finishes @fable check it" / "once alice is done, @bob review": a condition clause followed, in the same
   * sentence, by an address. The address is the first @mention after the clause has some words of its own (so the
   * clause's subject, "@alice and @bob are done", stays inside it). Participants named in the clause are what to wait for.
   */
  const matchCondition = (position: number): { clause: string; addressAt: number; participants: ParticipantRef[]; references: MentionSpan[] } | null => {
    const lead = CONDITION_LEAD.exec(text.slice(position));
    if (!lead) return null;
    const clauseStart = position + lead[0].length;
    const sentenceEndOffset = text.slice(clauseStart).search(/[.!?;\n]/);
    const sentenceEnd = sentenceEndOffset < 0 ? text.length : clauseStart + sentenceEndOffset;
    const window = text.slice(clauseStart, sentenceEnd);
    for (const match of window.matchAll(GLOBAL_MENTION)) {
      const start = clauseStart + (match.index ?? 0);
      const end = start + match[0].length;
      if (possessiveAt(end)) continue;
      const between = text
        .slice(clauseStart, start)
        .replace(GLOBAL_MENTION, " ")
        .replace(/['’]s\b/g, " ")
        .replace(/\b(?:and|or)\b/gi, " ")
        .replace(/[,&]/g, " ");
      if (!/[a-z0-9]/i.test(between)) continue;
      if (!byAlias.has((match[1] as string).toLowerCase())) return null;
      const clauseText = text.slice(clauseStart, start);
      const references: MentionSpan[] = [];
      const named = new Map<string, ParticipantRef>();
      for (const inner of clauseText.matchAll(GLOBAL_MENTION)) {
        const participant = byAlias.get((inner[1] as string).toLowerCase());
        const innerStart = clauseStart + (inner.index ?? 0);
        references.push({ start: innerStart, end: innerStart + inner[0].length, alias: inner[1] as string, participantId: participant?.id ?? null, role: "reference", assignment: null });
        if (participant) named.set(participant.id, participant);
      }
      const plain = clauseText.replace(GLOBAL_MENTION, " ");
      for (const { form, participant } of nameForms) {
        if (new RegExp(`(?<![\\w@])${escapeRegExp(form)}(?![\\w-])`, "i").test(plain)) named.set(participant.id, participant);
      }
      const clause = text.slice(position, start).trim().replace(/[\s,]+$/, "").replace(/^(?:and|then|but)\s+/i, "");
      return { clause, addressAt: start, participants: [...named.values()], references };
    }
    return null;
  };

  const parseHead = (from: number): Head => {
    const assignment = emptyAssignment(from);
    const head: Head = { assignment, end: from, sequence: false, mentions: [], afterTokens: [], addressed: false, conditionPrefix: null, condition: null };
    let position = skipSpace(text, from);
    let lastWasAddress = false;
    let conditionSeen = false;
    let conditionPrefix: string | null = null;
    for (;;) {
      const rest = text.slice(position);
      if (!head.addressed && !head.sequence && assignment.timing === null && head.condition === null) {
        const lead = SEQUENCE_LEAD.exec(rest);
        if (lead && startsAddress(text, position + lead[0].length, nameForms)) {
          head.sequence = true;
          position += lead[0].length;
          continue;
        }
      }
      if (!head.addressed && assignment.timing === null && !conditionSeen) {
        const condition = matchCondition(position);
        if (condition) {
          conditionSeen = true;
          for (const span of condition.references) head.mentions.push(span);
          for (const participant of condition.participants) {
            head.afterTokens.push({ token: `@${participant.alias}`, because: "condition" });
          }
          if (condition.participants.length > 0) head.condition = condition.clause;
          else conditionPrefix = condition.clause;
          assignment.consumed.push(condition.clause);
          position = condition.addressAt;
          continue;
        }
      }
      const mention = MENTION.exec(rest);
      if (mention && !possessiveAt(position + mention[0].length)) {
        const alias = mention[1] as string;
        const span: MentionSpan = { start: position, end: position + mention[0].length, alias, participantId: null, role: "address", assignment: null };
        const participant = byAlias.get(alias.toLowerCase());
        if (participant) {
          span.participantId = participant.id;
          if (!assignment.recipients.includes(participant.id)) assignment.recipients.push(participant.id);
        } else if (alias.toLowerCase() === ALL_ALIAS) {
          // @all: everyone seated in the room, one request each; in a room with a Consigliere, the workers and never him.
          const crew = participants.filter((p) => p.id !== consigliereId);
          for (const everyone of crew) if (!assignment.recipients.includes(everyone.id)) assignment.recipients.push(everyone.id);
          if (crew.length === 0) assignment.unresolved.push({ field: "recipients", severity: "error", message: "@all: nobody is in this room yet" });
        } else {
          // Alias pool: "@sol" selects an available member of sol1, sol2, ... not already addressed in this message.
          const pool = participants.filter((p) => new RegExp(`^${escapeRegExp(alias)}\\d+$`, "i").test(p.alias));
          const available = pool.filter((p) => !p.busy && !taken.has(p.id) && !assignment.recipients.includes(p.id));
          if (pool.length === 0) {
            assignment.unresolved.push({ field: "recipients", severity: "error", message: `nobody called @${alias} in this room` });
          } else if (available.length > 0) {
            const chosen = [...available].sort((a, b) => a.alias.localeCompare(b.alias))[0] as ParticipantRef;
            span.participantId = chosen.id;
            assignment.recipients.push(chosen.id);
            assignment.consumed.push(`${mention[0]}→@${chosen.alias}`);
          } else {
            assignment.unresolved.push({
              field: "recipients",
              severity: "error",
              message: `no free member in the @${alias} pool; pick one or wait`,
              participantCandidates: pool.map((p) => ({ participantId: p.id, alias: p.alias, busy: Boolean(p.busy) })),
            });
          }
        }
        assignment.consumed.push(mention[0]);
        head.mentions.push(span);
        head.addressed = true;
        lastWasAddress = true;
        position = skipSpace(text, position + mention[0].length);
        continue;
      }
      if (!head.addressed && isSentenceStart(position)) {
        const spoken = nameForms.find(({ form }) => new RegExp(`^${escapeRegExp(form)}\\s*[,:]`, "i").test(rest));
        if (spoken) {
          const match = new RegExp(`^${escapeRegExp(spoken.form)}\\s*[,:]\\s*`, "i").exec(rest) as RegExpExecArray;
          if (!assignment.recipients.includes(spoken.participant.id)) assignment.recipients.push(spoken.participant.id);
          assignment.consumed.push(match[0].trim());
          head.addressed = true;
          lastWasAddress = true;
          position += match[0].length;
          continue;
        }
      }
      if (lastWasAddress) {
        const joiner = /^(?:,|&|\+|and\b)\s*(?=@)/i.exec(rest);
        if (joiner) {
          position += joiner[0].length;
          lastWasAddress = false;
          continue;
        }
      }
      const directive = /^\/(after|hold|now|steer)\b\s*/i.exec(rest);
      if (directive) {
        const name = (directive[1] as string).toLowerCase();
        assignment.consumed.push(directive[0].trim());
        position += directive[0].length;
        lastWasAddress = false;
        if (name === "steer") {
          assignment.delivery = "steer";
          continue;
        }
        // /hold and /after are refused (retireDependencies); /now takes away a wait the text implies.
        assignment.timing = name as "hold" | "now" | "after";
        if (name !== "after") continue;
        // What /after names is consumed with it, so the instruction is the text that follows.
        const refs = /^((?:(?:task|#)\d+|@[a-z0-9][a-z0-9_-]*)(?:\s*,\s*(?:(?:task|#)\d+|@[a-z0-9][a-z0-9_-]*))*)[\s,]*/i.exec(text.slice(position));
        if (!refs) continue;
        assignment.consumed.push((refs[1] as string).trim());
        head.afterTokens.push(...(refs[1] as string).split(/\s*,\s*/).map((token) => ({ token, because: "after" as const })));
        position += refs[0].length;
        continue;
      }
      break;
    }
    // /now lifts a leading condition's wait: the condition goes back into the instruction, as one Backroom cannot observe.
    if (head.condition !== null && assignment.timing === "now") {
      conditionPrefix = head.condition;
      head.afterTokens = head.afterTokens.filter((token) => token.because !== "condition");
      head.condition = null;
    }
    head.end = position;
    head.conditionPrefix = conditionPrefix;
    assignment.insertAt = position;
    return head;
  };

  /** True when a mid-sentence mention should start a new assignment rather than be read as a reference. */
  const splitsAt = (span: { start: number; end: number }, bodyStart: number, lastReference: { end: number } | null, addressed: boolean): boolean => {
    if (possessiveAt(span.end)) return false;
    // Before anyone is addressed ("hey @alice can you…"), the first mention addresses.
    if (!addressed) return true;
    const before = text.slice(bodyStart, span.start);
    const word = /([a-z']+)[^a-z']*$/i.exec(before)?.[1]?.toLowerCase();
    if (word && LINK_WORDS.has(word)) return false;
    // A one-word lead ("review @alice changes") reads as verb and object, not as a finished instruction.
    if (before.trim().split(/\s+/).filter(Boolean).length < 2) return false;
    if (lastReference && /^\s*(?:,|and|or|&)\s*$/i.test(text.slice(lastReference.end, span.start))) return false;
    // Something must follow it in the same sentence (after any further mentions and joiners).
    const after = text.slice(span.end).split(/[.!?;\n]/)[0] ?? "";
    return /[a-z0-9]/i.test(after.replace(GLOBAL_MENTION, " ").replace(/\b(?:and|or)\b/gi, " "));
  };

  const sentenceStarts = (from: number): number[] => {
    const positions: number[] = [];
    const pattern = /(?:[.!?;:]\s+|\n\s*)(?=\S)/g;
    pattern.lastIndex = from;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) positions.push(match.index + match[0].length);
    return positions;
  };

  let position = skipSpace(text, 0);
  let index = 0;
  while (position < text.length) {
    const head = parseHead(position);
    const assignment = head.assignment;
    const bodyStart = head.end;
    // Find where this assignment's body ends: the next address, at a sentence start or mid-sentence.
    let splitAt = text.length;
    const bodyMentions: MentionSpan[] = [];
    const starts = new Set(sentenceStarts(bodyStart).filter((p) => p > bodyStart));
    let lastReference: { end: number } | null = null;
    const candidates = [...starts].map((p) => ({ at: p, mention: null as null | { start: number; end: number; alias: string } }));
    for (const match of text.slice(bodyStart).matchAll(GLOBAL_MENTION)) {
      const start = bodyStart + (match.index ?? 0);
      if (!starts.has(start)) candidates.push({ at: start, mention: { start, end: start + match[0].length, alias: match[1] as string } });
    }
    // Mid-sentence condition leads ("… and when @grok finishes @fable check it") can start the next assignment too.
    for (const match of text.slice(bodyStart).matchAll(/(?<![\w@])(?:and\s+|then\s+|but\s+)?(?:when|once|after|as soon as|whenever)\b/gi)) {
      const start = bodyStart + (match.index ?? 0);
      if (start > bodyStart && !starts.has(start) && matchCondition(start)) candidates.push({ at: start, mention: null });
    }
    candidates.sort((a, b) => a.at - b.at);
    for (const candidate of candidates) {
      if (candidate.mention) {
        const { mention } = candidate;
        if (splitsAt(mention, bodyStart, lastReference, head.addressed)) {
          splitAt = mention.start;
          break;
        }
        const participant = byAlias.get(mention.alias.toLowerCase());
        bodyMentions.push({ ...mention, participantId: participant?.id ?? null, role: "reference", assignment: null });
        lastReference = mention;
        continue;
      }
      const probe = parseHead(candidate.at);
      if (probe.addressed || probe.assignment.timing !== null) {
        splitAt = candidate.at;
        break;
      }
    }
    let body = text.slice(bodyStart, splitAt);
    let nextSequence = false;
    if (splitAt < text.length) {
      const trailing = TRAILING_CONNECTOR.exec(body.trimEnd());
      if (trailing) {
        if (/then/i.test(trailing[1] as string)) nextSequence = true;
        body = body.trimEnd().slice(0, body.trimEnd().length - trailing[0].length);
      }
    }
    const instruction = body.trim().replace(/[\s,;]+$/, "");
    const isPreamble = assignments.length === 0 && !head.addressed && assignment.timing === null && splitAt < text.length;
    if (isPreamble) {
      preamble = instruction;
      mentions.push(...bodyMentions);
    } else {
      assignment.instruction = head.conditionPrefix && instruction ? `${head.conditionPrefix}, ${instruction}` : instruction;
      conditionPrefixes.push(head.conditionPrefix);
      assignment.end = bodyStart + body.length;
      for (const span of [...head.mentions, ...bodyMentions]) mentions.push({ ...span, assignment: index });
      for (const id of assignment.recipients) taken.add(id);
      assignments.push(assignment);
      pendingAfter.push(head.afterTokens);
      sequenceFlags.push(head.sequence);
      conditionFlags.push(head.condition !== null);
      index += 1;
    }
    if (splitAt < text.length && nextSequence) sequenceFlags[index] = true;
    position = skipSpace(text, splitAt);
  }

  // With one participant in the room there is nobody else to mean: a message (or part) that addresses nobody is for
  // them. A mention that names nobody ("@bob" in a room without bob) stays an error.
  const only = participants.length === 1 ? (participants[0] as ParticipantRef) : null;
  if (only) {
    for (const assignment of assignments) {
      if (assignment.recipients.length === 0 && !assignment.unresolved.some((u) => u.field === "recipients")) assignment.recipients.push(only.id);
    }
  }

  // Waits: on earlier assignments of this message, or on work outside it. Both are refused (retireDependencies).
  assignments.forEach((assignment, current) => {
    for (const { token, because } of pendingAfter[current] ?? []) {
      const mention = MENTION.exec(token);
      const participant = mention ? byAlias.get((mention[1] as string).toLowerCase()) : undefined;
      const earlier = participant ? latestEarlier(assignments, current, participant.id) : -1;
      if (earlier >= 0) addAfter(assignment, earlier, because);
      // A leading condition on work outside the message (its member has no earlier assignment here).
      else if (because === "condition") waitsOutside(assignment);
    }
    if (assignment.timing === null && !conditionFlags[current]) {
      // "@fable check it when @grok finishes": a wait for grok's assignment in this message, or for grok's work outside it.
      for (const match of assignment.instruction.matchAll(TRAILING_CONDITION)) {
        const named = nameForms.find(({ form }) => form === (match[1] as string).toLowerCase())?.participant;
        if (!named || assignment.recipients.includes(named.id)) continue;
        const earlier = latestEarlier(assignments, current, named.id);
        if (earlier >= 0) addAfter(assignment, earlier, "condition");
        else if (!assignments.slice(current + 1).some((later) => later.recipients.includes(named.id))) waitsOutside(assignment);
      }
      if (current > 0 && (sequenceFlags[current] || /^then\b/i.test(assignment.instruction))) addAfter(assignment, current - 1, "then");
      const pronoun = PRONOUN_CONDITION.exec(assignment.instruction);
      if (pronoun && current > 0) {
        const plural = /they|both|everyone|all/i.test(pronoun[1] ?? "");
        for (let earlier = plural ? 0 : current - 1; earlier < current; earlier += 1) addAfter(assignment, earlier, "condition");
      } else if (pronoun && /^@all$/i.test(pronoun[1] ?? "")) {
        // "@alice cross check when @all finished" as a message of its own: a wait for everyone else's work.
        waitsOutside(assignment);
      }
      const prefix = conditionPrefixes[current];
      if (prefix && !pronoun) hints.push(`The room cannot wait for "${prefix}"; it is sent as part of the instruction.`);
      for (const participantId of referencedParticipants(assignment, mentions, current, nameForms)) {
        // Naming yourself is not a wait; in a group (e.g. @all) naming one member still waits for their earlier part.
        if (assignment.recipients.length === 1 && assignment.recipients[0] === participantId) continue;
        const earlier = latestEarlier(assignments, current, participantId);
        if (earlier >= 0) addAfter(assignment, earlier, "mention");
      }
    }
    // A condition at the start of the instruction that names what the assignment waits for is taken out of the text
    // ("when @grok finishes please send a message" → "please send a message"): the plan row shows that wait, refused.
    // Trailing conditions stay: in "tell me when @fable finishes" the condition is the point of the instruction.
    const leading = LEADING_CONDITION_CLAUSE.exec(assignment.instruction);
    if (leading) {
      const waitedFor = new Set(assignment.after.flatMap((d) => (assignments[d.index] as DraftAssignment).recipients));
      const clause = (leading[1] ?? "").replace(GLOBAL_MENTION, (_, alias: string) => alias);
      const namesWaited = nameForms.some(
        ({ form, participant }) => waitedFor.has(participant.id) && new RegExp(`(?<![\\w@])${escapeRegExp(form)}(?![\\w-])`, "i").test(clause),
      );
      const pronounWaited = waitedFor.size > 0 && /\b(?:she|he|it|that|they|both|everyone|all)\b/i.test(clause);
      const rest = assignment.instruction.slice(leading[0].length).trim();
      if ((namesWaited || pronounWaited) && rest.length > 0) assignment.instruction = rest;
    }
    if (assignment.recipients.length === 0 && !assignment.unresolved.some((u) => u.field === "recipients")) {
      assignment.unresolved.push({ field: "recipients", severity: "incomplete", message: "who is this for? start with @name" });
    }
    if (assignment.instruction.length === 0) {
      const who = assignment.recipients.map((id) => `@${participants.find((p) => p.id === id)?.alias ?? id}`).join(" ");
      assignment.unresolved.push({ field: "instruction", severity: "incomplete", message: who ? `what should ${who} do?` : "nothing to send yet" });
    }
    const leadingCommand = /^\/([a-z0-9][\w:.-]*)/i.exec(assignment.instruction);
    if (leadingCommand) {
      assignment.slashCommand = leadingCommand[1] as string;
      if (assignment.delivery === "steer") {
        assignment.unresolved.push({ field: "delivery", severity: "error", message: `/${assignment.slashCommand} starts its own turn; it cannot be sent into a running one` });
      }
    }
    // A directive is syntax only right after the @name; /after and /hold are refused wherever they are written, with no hint.
    const directiveInside = /(?<!\S)\/(after|hold|now|steer)\b/i.exec(assignment.instruction);
    if (directiveInside && !/^\/(?:after|hold)$/i.test(directiveInside[0])) {
      hints.push(`"${directiveInside[0]}" in the middle of a sentence is plain text; put it right after the @name.`);
    }
  });

  return { assignments, preamble, mentions, hints };
}

const MASK_AT = "\uE000";
const MASK_SLASH = "\uE001";

/** Hide @ and / inside quoted text (fenced or inline code, "> " lines, \@name) from the parser, keeping offsets. */
export function maskQuoted(text: string): string {
  const hide = (segment: string) => segment.replace(/@/g, MASK_AT).replace(/\//g, MASK_SLASH);
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, hide)
    .replace(/`[^`\n]*`/g, hide)
    .replace(/^[ \t]*>.*$/gm, hide)
    .replace(/\\@/g, `\\${MASK_AT}`);
}

function unmask(text: string): string {
  return text.replace(new RegExp(MASK_AT, "g"), "@").replace(new RegExp(MASK_SLASH, "g"), "/");
}

function emptyAssignment(start: number): DraftAssignment {
  return { recipients: [], instruction: "", after: [], timing: null, delivery: "queue", slashCommand: null, start, end: start, insertAt: start, unresolved: [], consumed: [] };
}

function addAfter(assignment: DraftAssignment, index: number, because: DependencyRef["because"]): void {
  if (!assignment.after.some((ref) => ref.index === index)) assignment.after.push({ index, because });
}

function latestEarlier(assignments: DraftAssignment[], current: number, participantId: string): number {
  for (let index = current - 1; index >= 0; index -= 1) {
    if ((assignments[index] as DraftAssignment).recipients.includes(participantId)) return index;
  }
  return -1;
}

/** Participants an assignment's text refers to: reference mentions plus plain names ("alice's work", "sol two"). */
function referencedParticipants(
  assignment: DraftAssignment,
  mentions: MentionSpan[],
  index: number,
  nameForms: Array<{ form: string; participant: ParticipantRef }>,
): string[] {
  const found = new Set<string>();
  for (const span of mentions) {
    if (span.assignment === index && span.role === "reference" && span.participantId) found.add(span.participantId);
  }
  const plain = assignment.instruction.replace(GLOBAL_MENTION, " ");
  for (const { form, participant } of nameForms) {
    if (new RegExp(`(?<![\\w@])${escapeRegExp(form)}(?![\\w-])`, "i").test(plain)) found.add(participant.id);
  }
  return [...found];
}

/** Whether a head at this position would address someone: optional "then", then @mention, "Name," or a directive. */
function startsAddress(text: string, position: number, nameForms: Array<{ form: string }>): boolean {
  const rest = text.slice(skipSpace(text, position));
  if (/^@[a-z0-9]/i.test(rest) || /^\/(after|hold|now|steer)\b/i.test(rest)) return true;
  return nameForms.some(({ form }) => new RegExp(`^${escapeRegExp(form)}\\s*[,:]`, "i").test(rest));
}

function skipSpace(text: string, position: number): number {
  let index = position;
  while (index < text.length && /\s/.test(text[index] as string)) index += 1;
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
