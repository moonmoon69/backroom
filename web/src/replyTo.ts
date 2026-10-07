import { taskLabel, type RoomEvent, type Run, type Task } from "./types.ts";

/**
 * What a reply answers, said truthfully, for the tag over it. A reply answers one or more tasks (several when
 * messages were steered into the same turn), and a task comes from one of these:
 * - your message (an assignment from a user.message): "your 07:43 PM message";
 * - another member's post (an assignment from a member.message): "Fable's 07:43 PM message";
 * - a wake-up after a member's task ended (a "wake" task waiting on it): "after Opus's result · 07:43 PM", at the time
 *   of that result, or "after Opus's task7 ended" when it ended without one;
 * - a wake-up after a member continued on its own (a "wake" task with nothing to wait on, from the poster's own post to
 *   that member): "after Opus's own turn · 07:43 PM", at the time of that turn;
 * - Backroom's own note to a member: "seat briefing", or "new Consigliere notice".
 * Only a message the user wrote is "your", and only a reply to a message carries the reply arrow "↩".
 */
export type ReplySource =
  | { kind: "user"; event: RoomEvent }
  | { kind: "member"; who: string; event: RoomEvent }
  | { kind: "result"; who: string; task: Task; answered: boolean; event: RoomEvent | null }
  | { kind: "continued"; who: string; event: RoomEvent | null }
  | { kind: "notice"; label: "seat briefing" | "new Consigliere notice" }
  | { kind: "unknown"; event: RoomEvent | null };

export interface ReplyContext {
  tasks: readonly Task[];
  runs: readonly Pick<Run, "taskId" | "resultEventId">[];
  events: readonly RoomEvent[];
  aliasOf: (participantId: string) => string;
}

const byId = (events: readonly RoomEvent[], id: string | null | undefined): RoomEvent | null => (id ? (events.find((e) => e.id === id) ?? null) : null);
const speakerId = (event: RoomEvent): string | null => (event.speaker.type === "participant" ? event.speaker.participantId : null);

/** Where each task a reply answers came from, oldest first; one entry per source (tasks from the same post share it). */
export function replySources(answered: readonly Task[], context: ReplyContext): ReplySource[] {
  const sources: Array<{ key: string; order: string; source: ReplySource }> = [];
  const add = (key: string, order: string, source: ReplySource) => {
    if (!sources.some((s) => s.key === key)) sources.push({ key, order, source });
  };
  for (const task of answered) {
    const post = byId(context.events, task.sourceEventId);
    if (task.kind === "seat") {
      const label = post?.text.startsWith("New Consigliere") ? "new Consigliere notice" : "seat briefing";
      add(`notice:${label}`, post?.createdAt ?? task.createdAt, { kind: "notice", label });
    } else if (task.kind === "wake" && task.prerequisites.length > 0) {
      for (const ref of task.prerequisites) {
        const ended = context.tasks.find((t) => t.id === ref.taskId);
        if (!ended) continue;
        const resultId = context.runs.filter((run) => run.taskId === ended.id && run.resultEventId).at(-1)?.resultEventId ?? null;
        const event = byId(context.events, resultId);
        add(`result:${ended.id}`, event?.createdAt ?? task.createdAt, { kind: "result", who: context.aliasOf(ended.participantId), task: ended, answered: resultId !== null, event });
      }
    } else if (task.kind === "wake") {
      // Woken without a task to wait on: the member the poster's post went to continued on its own, and its turn ended.
      const member = post?.to ?? null;
      const turn = member
        ? (context.events.filter((e) => e.kind === "t3.turn" && speakerId(e) === member && e.createdAt <= task.createdAt).at(-1) ?? null)
        : null;
      if (member) add(`continued:${member}:${task.id}`, turn?.createdAt ?? task.createdAt, { kind: "continued", who: context.aliasOf(member), event: turn });
      else add(`unknown:${task.id}`, task.createdAt, { kind: "unknown", event: post });
    } else if (post?.kind === "user.message") {
      add(`post:${post.id}`, post.createdAt, { kind: "user", event: post });
    } else if (post?.kind === "member.message") {
      const from = speakerId(post);
      const who = from ? context.aliasOf(from) : post.speaker.type === "outside" ? post.speaker.title : "a member";
      add(`post:${post.id}`, post.createdAt, { kind: "member", who, event: post });
    } else {
      add(`unknown:${task.id}`, task.createdAt, { kind: "unknown", event: post });
    }
  }
  return sources.sort((a, b) => a.order.localeCompare(b.order)).map((s) => s.source);
}

/** One piece of the tag: words, and a time that points at an event (clickable where it is shown). */
export type ReplyPiece = { text: string } | { time: RoomEvent };

/** What a reply answers (a message) as against what a report follows (something a member did). */
const follows = (source: ReplySource): boolean => source.kind === "result" || source.kind === "continued";

/**
 * The tag's pieces. A reply to a message keeps the reply arrow: "↩ your ", time, " message". A report that follows
 * something a member did says what, without the arrow: "after Opus's result · ", time; "after Opus's own turn · ",
 * time; "after Opus's task7 ended". Both, when a message was steered into such a turn, joined by " · ".
 */
export function replyPieces(sources: readonly ReplySource[]): ReplyPiece[] {
  const join = (parts: ReplyPiece[][]): ReplyPiece[] =>
    parts.flatMap((part, index) => [...(index > 0 ? [{ text: index === parts.length - 1 ? " and " : ", " }] : []), ...part]);

  // Replies to messages. Your messages, and one member's messages, read as one phrase: "your 07:40 PM and 07:43 PM messages".
  const replies: ReplyPiece[][] = [];
  const grouped = new Map<string, RoomEvent[]>();
  for (const source of sources.filter((s) => !follows(s))) {
    if (source.kind === "user" || source.kind === "member") {
      const key = source.kind === "user" ? "your" : `${source.who}'s`;
      const list = grouped.get(key);
      if (list) list.push(source.event);
      else {
        grouped.set(key, [source.event]);
        replies.push([{ text: key }]);
      }
    } else if (source.kind === "notice") {
      replies.push([{ text: source.label }]);
    } else if (source.kind === "unknown") {
      replies.push(source.event ? [{ text: "message · " }, { time: source.event }] : [{ text: "a message" }]);
    }
  }
  for (const part of replies) {
    const head = part[0];
    const events = head && "text" in head ? grouped.get(head.text) : undefined;
    if (events && part.length === 1) {
      part.push({ text: " " });
      events.forEach((event, index) => {
        if (index > 0) part.push({ text: index === events.length - 1 ? " and " : ", " });
        part.push({ time: event });
      });
      part.push({ text: events.length === 1 ? " message" : " messages" });
    }
  }

  // What a report follows.
  const after: ReplyPiece[][] = [];
  for (const source of sources) {
    if (source.kind === "result") {
      if (!source.answered) after.push([{ text: `${source.who}'s ${taskLabel(source.task)} ended` }]);
      else after.push(source.event ? [{ text: `${source.who}'s result · ` }, { time: source.event }] : [{ text: `${source.who}'s result` }]);
    } else if (source.kind === "continued") {
      after.push(source.event ? [{ text: `${source.who}'s own turn · ` }, { time: source.event }] : [{ text: `${source.who}'s own turn` }]);
    }
  }

  const pieces: ReplyPiece[] = [];
  if (replies.length > 0) pieces.push({ text: "↩ " }, ...join(replies));
  if (after.length > 0) pieces.push({ text: replies.length > 0 ? " · after " : "after " }, ...join(after));
  return pieces;
}

/** The tag as plain text, times written by `timeOf` (for the tooltip and tests). */
export function replyText(sources: readonly ReplySource[], timeOf: (iso: string) => string): string {
  return replyPieces(sources)
    .map((piece) => ("text" in piece ? piece.text : timeOf(piece.time.createdAt)))
    .join("");
}

/** The tooltip, in the tag's own words: "Reply to your 07:43 PM message (task5)…", "After Opus's result · 07:43 PM (task7)…". */
export function replyTitle(sources: readonly ReplySource[], answered: readonly Task[], timeOf: (iso: string) => string): string {
  const where = sources
    .map((source) => (follows(source) && "event" in source && source.event?.postNumber ? `#${source.event.postNumber}` : null))
    .filter(Boolean);
  const text = replyText(sources, timeOf);
  const said = text.startsWith("↩ ") ? `Reply to ${text.slice(2)}` : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return `${said} (${answered.map((t) => taskLabel(t)).join(", ")})${where.length > 0 ? `; on the board as ${where.join(", ")}` : ""}; click a time to show it`;
}
