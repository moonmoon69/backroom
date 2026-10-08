/**
 * The board for agents: the engine behind bin/rooms-board. The board is the room's saved record, the same posts the
 * user reads on the page, under the same numbers. T3's tools reach one thread at a time; this reaches the room: its
 * posts by number (the user's own messages too), its members, the user's saved crew, and seating one of them.
 *
 * It reads, seats and posts. A post addressed to members is how work moves between them: Backroom delivers it as a
 * task and wakes the poster with the answer when it ends, so nobody waits in a tool call. The caller is the member its
 * key names ("alias.<room id prefix>", the key rooms-browser uses), and every command works within that room only.
 *
 * The command line is parsed here, not in the CLI, so help and rules have one home.
 */
import type { Repos } from "../db/repos.ts";
import type { RoomCommand } from "../domain/commands.ts";
import { type Participant, type ParticipantStatus, type Room, type RoomEvent, type Task } from "../domain/types.ts";
import { roomForKey } from "../browser/catalog.ts";
import { parseExplicit } from "../parser/explicit.ts";
import { contextPhrase, type ContextMeter } from "../domain/contextMeter.ts";
import { readReseats } from "./reseat.ts";
import { ROOM_STATE_MAX_CHARS, readRoomState, writeRoomState } from "./roomState.ts";
import { retireThreadChoice } from "./consigliere.ts";
import { roomStateSection } from "../briefing/assemble.ts";

/** A post longer than this is printed in pages. */
export const BOARD_PAGE_CHARS = 20_000;


export class BoardError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BoardError";
    this.status = status;
  }
}

const HELP = `rooms-board: this room's board: read it, post on it, seat the user's saved crew. Always pass --as <your key>.

  index [--after <number>] [--all]   the room's posts, oldest first: number, kind, sender, receiver, outcome, size. No text.
                                     --after lists only later posts; --all adds task status lines and system notes,
                                     which have no number.
  read <number>...  [--page <n>]     the exact saved text of those posts. A post over ${BOARD_PAGE_CHARS.toLocaleString("en-US")} characters is printed
                                     in pages; the output says how many there are.
  post "<text>"                      a post to members: "@name the job", several names for several jobs. Each becomes a
                                     task on that member's thread, and you are woken with the answer when it ends:
                                     post, then end your turn. "@name /steer ..." goes into a turn already running;
                                     "@name /compact" runs that command on its thread. Quote the text as one argument.
  members                            the room's seated members: alias, model, what each is doing now, its context
                                     ("context ≈ 575k, 6 compactions"; "no meter" off Claude), thread id, and who is the Consigliere.
  crew                               the user's saved crew, by name, with model.
  seat <saved crew name>             seats that saved crew member in this room; prints the new member's alias and thread id.
                                     Seating the same one again gives a numbered alias (opus, opus2): one thread each.
  reseat <alias> ["<plan>"]          the Consigliere's: asks that member for a checkpoint post (decisions, dead ends, state of
                                     the code, next step); when it lands, a fresh seat of the same saved crew member takes
                                     over with it, in the same folder, with its pending tasks (and the Consigliere's mark, if
                                     it was his), and the old seat leaves as with retire. <plan> is what the fresh seat
                                     carries on with.
  retire <alias>                     the Consigliere's: that member leaves the room, once its deliverable has passed its gate.
                                     Refused while it has work open. Its T3 thread is kept unless the user's setting settles,
                                     archives or deletes it; the reply says which.
  rules                              your standing sections, as your first briefing gave them: who you are, the rules,
                                     where everyone works, the browsers, the room state. Later briefings leave them out.
  state ["<text>"]                   prints the room state, the Consigliere's summary of where the room stands; with a text,
                                     the Consigliere replaces it (at most ${ROOM_STATE_MAX_CHARS.toLocaleString("en-US")} characters). Every new seat is given it first.
  help                               this list.

Posts are numbered as the user sees them: #51 here is #51 on the page. Only posts take numbers, so they count
1, 2, 3; an older room may skip numbers among its earliest posts.`;

export interface BoardDeps {
  repos: Repos;
  /** Runs a room command (seating goes through the same command the page uses). */
  execute(command: RoomCommand): Promise<unknown>;
  /** Called after seating, so the seat briefing is on its way before the caller sends the new member work. */
  afterSeat?(): Promise<void>;
  /** What a member's thread is doing now, from the scheduler's last look. */
  statusOf?(participantId: string): ParticipantStatus;
  /** A member's context meter, from its thread's transcript; null when it has no thread. */
  contextOf?(participant: Participant): ContextMeter | null;
  /** A member's standing sections in full, as its first briefing gave them (the scheduler builds them). */
  standing?(participantId: string): Promise<string>;
  /** Tells the room's open pages it changed (the room state is written here, not through a room command). */
  notify?(roomId: string): void;
}

/** What participant.retire did with the member's T3 thread. */
export interface RetiredThread {
  action: string;
  result: "done" | "kept" | "failed";
  detail?: string;
}

const PAST: Record<string, string> = { settle: "settled", archive: "archived", delete: "deleted" };

/** What became of a retired member's T3 thread, in a sentence for the retire reply. */
export function threadOutcome(thread: RetiredThread | undefined): string {
  if (!thread) return "It had no T3 thread.";
  if (thread.result === "done") return `Its T3 thread was ${PAST[thread.action] ?? thread.action}, as the user's retire setting says.`;
  if (thread.result === "failed") return `Its T3 thread stays as it was: T3 could not ${thread.action} it (${thread.detail ?? "failed"}).`;
  if (thread.action === "keep") return "Its thread stays in T3.";
  return `Its thread stays in T3 (${thread.detail ?? "kept"}), although the retire setting says ${thread.action}.`;
}

/** A member's state in a word or two, as the page says it. */
function stateWord(status: ParticipantStatus | undefined, openTasks: Task[]): string {
  if (!status) return "ready";
  if (status.threadMissing) return "thread deleted in T3";
  if (status.pendingApprovals) return "needs the user's approval";
  if (status.pendingUserInput) return "waiting for the user's answer";
  if (status.activeRunId || status.status === "running" || status.status === "waiting") return `working${openTasks.length > 0 ? ` on ${openTasks.map((t) => `task${t.number}`).join(", ")}` : ""}`;
  if (status.externalActivity) return "working on its own";
  if (status.status === "preparing" || status.status === "queued" || status.status === "starting") return "starting";
  if (status.background === "working") return "background work running (continues on its own)";
  if (status.background === "monitoring") return "monitoring";
  if (status.status === "failed") return "last run failed";
  return "ready";
}

export class Board {
  private readonly deps: BoardDeps;
  constructor(deps: BoardDeps) {
    this.deps = deps;
  }

  /** One command line (without --as), for the member the key names. Returns what the CLI prints. */
  async run(argv: string[], as: string | null): Promise<string> {
    const args = [...argv];
    const command = args.shift() ?? "help";
    if (command === "help" || command === "--help" || command === "-h") return HELP;
    const { room, member } = this.caller(as);
    switch (command) {
      case "index":
        return this.index(room, args);
      case "read":
        return this.read(room, args);
      case "members":
        return this.members(room);
      case "crew":
        return this.crew();
      case "seat":
        return this.seat(room, member, args);
      case "reseat":
        return this.reseat(room, member, args);
      case "retire":
        return this.retire(room, member, args);
      case "rules":
        return this.rules(room, member);
      case "state":
        return this.state(room, member, args);
      case "post":
      case "say":
        return this.post(room, member, args);
      default:
        throw new BoardError(`rooms-board: no command "${command}". Run "rooms-board help".`);
    }
  }

  private caller(as: string | null): { room: Room; member: Participant } {
    if (!as) throw new BoardError("rooms-board: pass --as <your key>, as your briefing gives it.");
    const room = roomForKey(this.deps.repos, as);
    const alias = as.slice(0, Math.max(as.lastIndexOf("."), 0)).toLowerCase();
    const member = room ? this.deps.repos.listActiveParticipants(room.id).find((p) => p.alias.toLowerCase() === alias) : undefined;
    if (!room || !member) throw new BoardError(`rooms-board: "${as}" is not the key of a member seated in a room.`, 403);
    return { room, member };
  }

  private flag(args: string[], name: string): string | undefined {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const [, value] = args.splice(at, 2);
    if (value === undefined) throw new BoardError(`rooms-board: ${name} needs a value.`);
    return value;
  }

  private number(text: string, what: string): number {
    const value = Number(text.replace(/^#/, ""));
    if (!Number.isInteger(value) || value < 1) throw new BoardError(`rooms-board: ${what} must be a post number such as 51, got "${text}".`);
    return value;
  }

  /**
   * Who said a post and who it was for, as the page words it; `note` says what a report nobody asked for follows (a
   * wake-up after a member's task, or after a member's own turn), in the page's words: "after @Opus's result #11".
   */
  private parties(room: Room, event: RoomEvent, events: RoomEvent[]): { from: string; to: string; note: string } {
    const aliasOf = (participantId: string) => `@${this.deps.repos.getParticipant(participantId)?.alias ?? participantId}`;
    const from =
      event.speaker.type === "participant" ? aliasOf(event.speaker.participantId) : event.speaker.type === "outside" ? `outside the room (${event.speaker.title})` : event.speaker.type;
    let to = "";
    let note = "";
    if (event.kind === "member.message" && event.to) to = aliasOf(event.to);
    else if (event.kind === "user.message") {
      to = [...new Set(this.deps.repos.listTasks(room.id).filter((task) => task.sourceEventId === event.id).map((task) => aliasOf(task.participantId)))].join(" ");
    } else if (event.kind === "assistant.reply") {
      // An answer goes to whoever asked: the user, or the member whose post made the task. A seat briefing's
      // acknowledgement answers Backroom; a wake-up's report answers nobody, and says what it follows.
      const task = event.taskId ? this.deps.repos.getTask(event.taskId) : null;
      const source = task ? this.deps.repos.getEvent(task.sourceEventId) : null;
      if (task?.kind === "wake") note = this.follows(task, events, aliasOf);
      else if (task?.kind === "seat") to = "";
      else if (source?.kind === "member.message") to = source.speaker.type === "participant" ? aliasOf(source.speaker.participantId) : "a member";
      else to = "user";
    }
    else if (event.kind === "t3.turn") {
      // The answer goes to whoever asked: the member whose message started the run, or the person who typed in T3.
      const asked = event.sourceRef?.t3RunId ? events.find((e) => e.kind === "member.message" && e.sourceRef?.t3RunId === event.sourceRef?.t3RunId && e.sourceRef?.threadId === event.sourceRef?.threadId) : undefined;
      to = asked ? this.parties(room, asked, events).from : event.prompt !== null ? "user" : "";
    }
    return { from, to, note };
  }

  /**
   * What a wake-up's report follows: the result of the task it waited on ("after @Opus's result #11", or "after @Opus's
   * task7 ended" without one), or the turn a member took on its own ("after @Opus's own turn #14").
   */
  private follows(task: Task, events: RoomEvent[], aliasOf: (participantId: string) => string): string {
    if (task.prerequisites.length === 0) {
      const member = this.deps.repos.getEvent(task.sourceEventId)?.to;
      if (!member) return "after Backroom woke it";
      const turn = events.filter((e) => e.kind === "t3.turn" && e.speaker.type === "participant" && e.speaker.participantId === member && e.createdAt <= task.createdAt).at(-1);
      return `after ${aliasOf(member)}'s own turn${turn ? ` #${turn.postNumber ?? turn.sequence}` : ""}`;
    }
    const causes = task.prerequisites.map((ref) => {
      const ended = this.deps.repos.getTask(ref.taskId);
      if (!ended) return "a task that ended";
      const resultId = this.deps.repos.listRunsForTask(ended.id).filter((run) => run.resultEventId).at(-1)?.resultEventId;
      const result = resultId ? this.deps.repos.getEvent(resultId) : null;
      return result ? `${aliasOf(ended.participantId)}'s result #${result.postNumber ?? result.sequence}` : `${aliasOf(ended.participantId)}'s task${ended.number} ended`;
    });
    return `after ${causes.join(" and ")}`;
  }

  private index(room: Room, args: string[]): string {
    const all = args.includes("--all");
    const afterText = this.flag(args, "--after");
    const after = afterText === undefined ? 0 : this.number(afterText, "--after");
    const events = this.deps.repos.listEvents(room.id, 1, Number.MAX_SAFE_INTEGER, 100_000);
    // "After #n" is after the last post numbered n or less; the status lines --all adds fall in place by when they happened.
    const from = after > 0 ? (events.filter((e) => e.postNumber !== null && e.postNumber <= after).at(-1)?.sequence ?? 0) : 0;
    const listed = events.filter((event) => event.sequence > from && (all || event.postNumber !== null));
    const posts = listed.filter((event) => event.postNumber !== null).length;
    if (listed.length === 0) return after > 0 ? `No posts after #${after}.` : "The board is empty.";
    const lines = listed.map((event) => {
      const { from: sender, to, note } = this.parties(room, event, events);
      const outcome = event.outcome ? ` · ${event.outcome}` : "";
      const number = event.postNumber !== null ? `#${event.postNumber}` : "  ·";
      return `${number}  ${event.kind}  ${sender}${to ? ` → ${to}` : ""}${note ? ` · ${note}` : ""}${outcome} · ${event.text.length.toLocaleString("en-US")} chars`;
    });
    return [`Board of "${room.title}": ${posts} post${posts === 1 ? "" : "s"}${after > 0 ? ` after #${after}` : ""}. Read one with: read <number>`, ...lines].join("\n");
  }

  private read(room: Room, args: string[]): string {
    const pageText = this.flag(args, "--page");
    const page = pageText === undefined ? 1 : Number(pageText);
    if (!Number.isInteger(page) || page < 1) throw new BoardError(`rooms-board: --page must be 1 or more, got "${pageText}".`);
    if (args.length === 0) throw new BoardError("rooms-board: read needs one or more post numbers, e.g. read 51 53.");
    const events = this.deps.repos.listEvents(room.id, 1, Number.MAX_SAFE_INTEGER, 100_000);
    const out: string[] = [];
    for (const arg of args) {
      const number = this.number(arg, "a post");
      // Only this room's posts exist here: a number names a post of the caller's room or nothing.
      const event = events.find((e) => e.postNumber === number);
      if (!event) throw new BoardError(`rooms-board: this room has no post #${number}.`, 404);
      const { from, to, note } = this.parties(room, event, events);
      const pages = Math.max(1, Math.ceil(event.text.length / BOARD_PAGE_CHARS));
      if (page > pages) throw new BoardError(`rooms-board: post #${number} has ${pages} page${pages === 1 ? "" : "s"}.`);
      const head = `[#${number} ${event.kind} · ${from}${to ? ` → ${to}` : ""}${note ? ` · ${note}` : ""}${event.outcome ? ` · ${event.outcome}` : ""} · ${event.createdAt}${pages > 1 ? ` · page ${page} of ${pages}` : ""}]`;
      const body = event.text.slice((page - 1) * BOARD_PAGE_CHARS, page * BOARD_PAGE_CHARS);
      out.push(head, body.length > 0 ? body : "(no text)");
      if (event.kind === "t3.turn" && event.prompt !== null && page === 1) out.push(`[#${number} was asked, in T3]`, event.prompt);
      if (pages > 1 && page < pages) out.push(`[#${number} continues: read ${number} --page ${page + 1}]`);
      out.push("");
    }
    return out.join("\n").trimEnd();
  }

  /**
   * A post to members: parsed as the composer parses the user's message, from the poster's seat (names are delivered
   * as written; what addresses nobody goes to the Consigliere; the poster cannot address himself). Backroom makes one
   * task per recipient and a wake task for the poster after each.
   */
  private async post(room: Room, member: Participant, args: string[]): Promise<string> {
    const text = args.join(" ").trim();
    if (!text) throw new BoardError('rooms-board: post needs the text, as one quoted argument: post "@opus write the plan".');
    const tasks = this.deps.repos.listTasks(room.id);
    const busy = new Set(tasks.filter((t) => t.state === "dispatching" || t.state === "running" || t.state === "needs_input" || t.state === "queued").map((t) => t.participantId));
    const others = this.deps.repos
      .listActiveParticipants(room.id)
      .filter((p) => p.id !== member.id)
      .map((p) => ({ id: p.id, alias: p.alias, busy: busy.has(p.id) }));
    if (others.length === 0) throw new BoardError("rooms-board: nobody else is seated in this room; `seat` someone first.");
    const draft = parseExplicit(text, others, tasks, { consigliereId: room.consigliereId === member.id ? null : room.consigliereId, direct: true });
    if (draft.kind !== "task") throw new BoardError("rooms-board: a post is work or a message for members: start with @name. Notes and room commands are the user's.");
    const problems = draft.unresolved.filter((u) => u.severity === "error" || u.severity === "incomplete");
    if (problems.length > 0) throw new BoardError(`rooms-board: ${problems.map((u) => u.message).join("; ")}`);
    const result = (await this.deps.execute({
      type: "member.post",
      roomId: room.id,
      participantId: member.id,
      sourceText: text,
      assignments: draft.assignments.map((a) => ({
        recipients: a.recipients,
        instruction: a.instruction,
        schedule: a.schedule ?? { mode: "now" },
        after: a.after.map((ref) => ref.index),
        delivery: a.delivery,
        slashCommand: a.slashCommand !== null,
      })),
    })) as { taskIds: string[]; eventId: string };
    const event = this.deps.repos.getEvent(result.eventId);
    const made = result.taskIds.map((id) => this.deps.repos.getTask(id)).filter((t): t is Task => t !== null);
    const lines = made.map((task) => `${this.taskLine(task)}`);
    return [
      `Posted as #${event?.postNumber ?? "?"}.`,
      ...lines,
      "You will be woken with each answer when it lands: end your turn now, with your note to the user.",
    ].join("\n");
  }

  private taskLine(task: Task): string {
    const alias = this.deps.repos.getParticipant(task.participantId)?.alias ?? task.participantId;
    return `task${task.number} → @${alias}: ${task.state}${task.stateReason ? ` (${task.stateReason})` : ""}`;
  }

  private members(room: Room): string {
    const members = this.deps.repos.listActiveParticipants(room.id);
    if (members.length === 0) return "Nobody is seated in this room.";
    const tasks = this.deps.repos.listTasks(room.id);
    const reseats = readReseats(this.deps.repos, room.id);
    const lines = members.map((member) => {
      const thread = this.deps.repos.currentBinding(member.id)?.threadId ?? "no thread";
      const open = tasks.filter((t) => t.participantId === member.id && (t.state === "running" || t.state === "dispatching" || t.state === "needs_input") && t.kind !== "wake");
      const queued = tasks.filter((t) => t.participantId === member.id && t.state === "queued" && t.kind !== "wake").length;
      const context = this.deps.contextOf ? ` · ${contextPhrase(this.deps.contextOf(member))}` : "";
      const reseat = reseats.find((r) => r.participantId === member.id);
      const reseating = reseat ? ` · being reseated (checkpoint task${this.deps.repos.getTask(reseat.checkpointTaskId)?.number ?? "?"})` : "";
      return `@${member.alias}${room.consigliereId === member.id ? " (the Consigliere)" : ""} · ${member.modelSelection.model} · ${stateWord(this.deps.statusOf?.(member.id), open)}${queued > 0 ? ` · ${queued} queued` : ""}${context}${reseating} · thread ${thread}`;
    });
    return [`Members of "${room.title}":`, ...lines, ...(room.consigliereId ? [] : ["This room has no Consigliere."])].join("\n");
  }

  private crew(): string {
    const presets = this.deps.repos.listPresets();
    if (presets.length === 0) return "The user has no saved crew.";
    return [
      "The user's saved crew (seat one with: seat <name>):",
      ...presets.map((preset) => `${preset.name} · ${preset.modelSelection.model}${preset.workspaceMode === "worktree" ? " · works in its own worktree" : ""}`),
    ].join("\n");
  }

  /**
   * A reseat, for the Consigliere: the member is sent a task to write its checkpoint post; when that lands a fresh seat
   * of the same saved crew member takes over with it (RoomService.advanceReseats). Nobody is woken for the reseat
   * itself; the Consigliere is woken when the fresh seat's first task ends, or when the reseat is called off.
   */
  private async reseat(room: Room, member: Participant, args: string[]): Promise<string> {
    const name = args.shift();
    if (!name) throw new BoardError('rooms-board: reseat needs the member\'s alias, and may take what the fresh seat carries on with: reseat opus "item 4 of docs/plans/x.md".');
    if (room.consigliereId !== member.id) {
      const consigliere = room.consigliereId ? this.deps.repos.getParticipant(room.consigliereId) : null;
      throw new BoardError(`rooms-board: only this room's Consigliere${consigliere ? ` (@${consigliere.alias})` : ""} reseats members.`, 403);
    }
    const alias = name.replace(/^@/, "").toLowerCase();
    const target = this.deps.repos.listActiveParticipants(room.id).find((p) => p.alias.toLowerCase() === alias);
    if (!target) throw new BoardError(`rooms-board: nobody called @${name.replace(/^@/, "")} is seated in this room; \`members\` lists them.`, 404);
    const plan = args.join(" ").trim() || null;
    const result = (await this.deps.execute({ type: "participant.reseat", participantId: target.id, by: member.id, plan })) as { taskId: string; eventId: string };
    const task = this.deps.repos.getTask(result.taskId);
    const event = this.deps.repos.getEvent(result.eventId);
    const self = target.id === member.id;
    return [
      `Asked @${target.alias} for its checkpoint: task${task?.number ?? "?"} (post #${event?.postNumber ?? "?"}). It runs when ${self ? "this turn ends" : `@${target.alias} has finished the work in hand`}.`,
      `When the checkpoint lands, a fresh seat of the same crew member takes over ${self ? "as this room's Consigliere" : `@${target.alias}'s work and pending tasks`} with it${plan ? " and your plan" : ""}, and ${self ? "you leave" : `@${target.alias} leaves`} the room. If it fails, you are woken and nothing changes.`,
      self ? "End your turn now: the checkpoint is your next task." : "You are woken when the fresh seat's first task ends, not before: end your turn now.",
    ].join("\n");
  }

  private async seat(room: Room, member: Participant, args: string[]): Promise<string> {
    const name = args[0];
    if (!name) throw new BoardError("rooms-board: seat needs the name of a saved crew member; `crew` lists them.");
    // In a room that has a Consigliere, he alone brings people in.
    if (room.consigliereId && room.consigliereId !== member.id) {
      const consigliere = this.deps.repos.getParticipant(room.consigliereId);
      throw new BoardError(`rooms-board: only this room's Consigliere${consigliere ? ` (@${consigliere.alias})` : ""} seats members. Ask him.`, 403);
    }
    const preset = this.deps.repos.findPresetByName(name.replace(/^@/, ""));
    if (!preset) throw new BoardError(`rooms-board: the user has no saved crew member called "${name}"; \`crew\` lists them.`, 404);
    const seated = (await this.deps.execute({ type: "participant.fromPreset", roomId: room.id, presetId: preset.id })) as { alias: string; threadId: string };
    await this.deps.afterSeat?.();
    return `Seated @${seated.alias} (${preset.modelSelection.model}) · thread ${seated.threadId}\nIts seat briefing is on its way; what you send it next waits behind that.`;
  }

  /**
   * Retiring, for the Consigliere: one seat per deliverable, so a member whose deliverable has passed its gate leaves the
   * room. Refused while it has work open; the wakes it was still due are cancelled with it. Its T3 thread goes as the
   * user's retire setting says (Settings → Consigliere: kept unless settle, archive or delete was chosen).
   */
  private async retire(room: Room, member: Participant, args: string[]): Promise<string> {
    const name = args[0];
    if (!name) throw new BoardError("rooms-board: retire needs the member's alias; `members` lists them.");
    if (room.consigliereId !== member.id) {
      const consigliere = room.consigliereId ? this.deps.repos.getParticipant(room.consigliereId) : null;
      throw new BoardError(`rooms-board: only this room's Consigliere${consigliere ? ` (@${consigliere.alias})` : ""} retires members.`, 403);
    }
    const alias = name.replace(/^@/, "").toLowerCase();
    const target = this.deps.repos.listActiveParticipants(room.id).find((p) => p.alias.toLowerCase() === alias);
    if (!target) throw new BoardError(`rooms-board: nobody called @${name.replace(/^@/, "")} is seated in this room; \`members\` lists them.`, 404);
    if (target.id === member.id) throw new BoardError("rooms-board: you cannot retire yourself; `reseat` hands your seat to a fresh one.", 409);
    const open = this.deps.repos
      .listTasks(room.id)
      .filter((t) => t.participantId === target.id && t.kind !== "wake" && (t.state === "queued" || t.state === "dispatching" || t.state === "running" || t.state === "needs_input"));
    if (open.length > 0) throw new BoardError(`rooms-board: @${target.alias} still has ${open.map((t) => `task${t.number}`).join(", ")} open; retire it once that has ended.`, 409);
    const result = (await this.deps.execute({ type: "participant.retire", participantId: target.id, pendingTasks: "cancel", thread: retireThreadChoice(this.deps.repos) })) as { thread?: RetiredThread } | null;
    return `@${target.alias} has left the room. ${threadOutcome(result?.thread)}`;
  }

  /** The standing sections again: briefings after the first leave them out, and a compaction may have taken them. */
  private async rules(room: Room, member: Participant): Promise<string> {
    const text = (await this.deps.standing?.(member.id)) ?? "";
    if (!text) throw new BoardError("rooms-board: the standing sections cannot be built here.", 503);
    return `Standing sections for @${member.alias} in room "${room.title}", as they are now:\n${text}`;
  }

  /**
   * The room state: anyone prints it; the Consigliere replaces it (any member, in a room without one). Each write
   * replaces the last one whole, so it stays a summary.
   */
  private state(room: Room, member: Participant, args: string[]): string {
    const text = args.join(" ").trim();
    if (!text) {
      const state = readRoomState(this.deps.repos, room.id);
      if (state) return roomStateSection(state);
      return `This room has no state yet.${room.consigliereId === member.id || !room.consigliereId ? ' Write it with: state "<text>".' : ""}`;
    }
    if (room.consigliereId && room.consigliereId !== member.id) {
      const consigliere = this.deps.repos.getParticipant(room.consigliereId);
      throw new BoardError(`rooms-board: only this room's Consigliere${consigliere ? ` (@${consigliere.alias})` : ""} writes the room state.`, 403);
    }
    if (text.length > ROOM_STATE_MAX_CHARS) {
      throw new BoardError(`rooms-board: the room state is ${text.length.toLocaleString("en-US")} characters; keep it under ${ROOM_STATE_MAX_CHARS.toLocaleString("en-US")} by pointing at post numbers instead of repeating them.`);
    }
    writeRoomState(this.deps.repos, room.id, { text, by: member.alias, at: new Date().toISOString() });
    this.deps.notify?.(room.id);
    return `Room state saved (${text.length.toLocaleString("en-US")} characters). It replaces the last one, and every new seat is given it with its first briefing.`;
  }
}
