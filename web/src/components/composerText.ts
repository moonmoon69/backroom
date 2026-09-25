/**
 * Text edits behind the composer's controls. The text is the single source of truth: every control
 * (mention, note, timing, "it's a reference", prerequisite pick) rewrites the text and the parser reads it back.
 * Offsets come from the parser's draft of the same text (src/parser/explicit.ts).
 */
import type { DraftAssignment, MentionSpan } from "../types.ts";

export interface TextEdit {
  text: string;
  /** Where the caret should go after the edit. */
  caret: number;
}

const REF = String.raw`(?:(?:task|#)\d+|@[a-z0-9][a-z0-9_-]*)`;
/** Timing directives as the parser reads them in an assignment's head: /now, /hold, /after <refs>. */
const DIRECTIVES = new RegExp(String.raw`\/(?:hold|now|steer)\b\s*|\/after\b\s*(?:${REF}(?:\s*,\s*${REF})*[\s,]*)?`, "gi");
const NOTE = /^(\s*)\/note\b[ \t]*/i;

/** Insert `token` at `at`, keeping one space on each side. */
function insertToken(text: string, at: number, token: string): TextEdit {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = /^[ \t]/.test(after) ? "" : " ";
  const inserted = `${lead}${token}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: at + inserted.length };
}

/**
 * Set an assignment's timing directive: drop any /now, /hold, /after in its head, then write `/now` or `/hold`
 * right after its addressing. `null` just removes the directive (the assignment falls back to its default timing).
 */
export function setTiming(text: string, assignment: DraftAssignment, timing: "now" | "hold" | "steer" | null): TextEdit {
  const head = text.slice(assignment.start, assignment.insertAt);
  const stripped = head.replace(DIRECTIVES, "");
  const base = `${text.slice(0, assignment.start)}${stripped}${text.slice(assignment.insertAt)}`;
  const at = assignment.start + stripped.length;
  if (!timing) return { text: base, caret: at };
  return insertToken(base, at, `/${timing}`);
}

/** Start a new line before a reference mention so it addresses a new assignment. */
export function splitAtMention(text: string, mention: MentionSpan): TextEdit {
  let from = mention.start;
  while (from > 0 && /[ \t]/.test(text[from - 1] as string)) from -= 1;
  const next = `${text.slice(0, from)}\n${text.slice(mention.start)}`;
  return { text: next, caret: from + 1 };
}

/** Drop the `@` of an address mention so it reads as a plain name inside the previous assignment. */
export function mentionToReference(text: string, mention: MentionSpan): TextEdit {
  if (text[mention.start] !== "@") return { text, caret: mention.start };
  return { text: `${text.slice(0, mention.start)}${text.slice(mention.start + 1)}`, caret: mention.end - 1 };
}

/** Replace `@alias` after the assignment's /after directive with a concrete task label. */
export function pickPrerequisite(text: string, assignment: DraftAssignment, alias: string, label: string): TextEdit | null {
  const head = text.slice(assignment.start, assignment.insertAt);
  const after = /\/after\b/i.exec(head);
  if (!after) return null;
  const pattern = new RegExp(String.raw`(?<![\w@])@${escapeRegExp(alias)}(?![\w-])`, "i");
  const rest = head.slice(after.index);
  const match = pattern.exec(rest);
  if (!match) return null;
  const at = assignment.start + after.index + match.index;
  return { text: `${text.slice(0, at)}${label}${text.slice(at + match[0].length)}`, caret: at + label.length };
}

/** Replace a mention's alias (alias pools: "@sol" → "@sol2"). */
export function replaceMention(text: string, mention: MentionSpan, alias: string): TextEdit {
  const token = `@${alias}`;
  return { text: `${text.slice(0, mention.start)}${token}${text.slice(mention.end)}`, caret: mention.start + token.length };
}

/** Insert `@alias ` at the caret (or at the start of an empty text). */
export function insertMention(text: string, caret: number, alias: string): TextEdit {
  const at = text.trim().length === 0 ? 0 : Math.max(0, Math.min(caret, text.length));
  const base = text.trim().length === 0 ? "" : text;
  return insertToken(base, at, `@${alias}`);
}

export const isNote = (text: string): boolean => NOTE.test(text);

/** Add or remove a leading `/note `. */
export function toggleNote(text: string): TextEdit {
  if (isNote(text)) {
    const next = text.replace(NOTE, "$1");
    return { text: next, caret: next.length };
  }
  const next = `/note ${text.replace(/^\s+/, "")}`;
  return { text: next, caret: next.length };
}

/** Prefix the text with `/after task3, task4 ` (follow-up from a task card). */
export function prependAfter(text: string, labels: string[]): TextEdit {
  const prefix = `/after ${labels.join(", ")} `;
  const rest = text.replace(/^\s+/, "");
  return { text: `${prefix}${rest}`, caret: prefix.length };
}

/** Same rule as the parser: an @mention at the start of the text, a line, or a sentence always addresses. */
export function isSentenceStart(text: string, position: number): boolean {
  const before = text.slice(0, position);
  return /^\s*$/.test(before) || /\n\s*$/.test(before) || /[.!?;:]\s+$/.test(before);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
