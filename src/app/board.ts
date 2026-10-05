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
import type { Participant, ParticipantStatus, Room, RoomEvent, Task } from "../domain/types.ts";
import { roomForKey } from "../browser/catalog.ts";
import { parseExplicit } from "../parser/explicit.ts";

/** A post longer than this is printed in pages. */
export const BOARD_PAGE_CHARS = 20_000;

/** Posts as `index` lists them by default: what was said. Status lines and system notes come with --all. */
const SAID = new Set<RoomEvent["kind"]>(["user.message", "note", "assistant.reply", "t3.turn", "t3.message", "member.message"]);

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
                                     --after lists only later posts; --all adds task status lines and system notes.
  read <number>...  [--page <n>]     the exact saved text of those posts. A post over ${BOARD_PAGE_CHARS.toLocaleString("en-US")} characters is printed
                                     in pages; the output says how many there are.
  post "<text>"                      a post to members: "@name the job", several names for several jobs. Each becomes a
                                     task on that member's thread, and you are woken with the answer when it ends:
                                     post, then end your turn. "@name /steer ..." goes into a turn already running;
                                     "@name /compact" runs that command on its thread. Quote the text as one argument.
  members                            the room's seated members: alias, model, what each is doing now, thread id, and who is the Consigliere.
  crew                               the user's saved crew, by name, with model.
  seat <saved crew name>             seats that saved crew member in this room; prints the new member's alias and thread id.
                                     Seating the same one again gives a numbered alias (opus, opus2): one thread each.
  help                               this list.

Posts are numbered as the user sees them: #51 here is #51 on the page.`;

export interface BoardDeps {
  repos: Repos;
  /** Runs a room command (seating goes through the same command the page uses). */
  execute(command: RoomCommand): Promise<unknown>;
  /** Called after seating, so the seat briefing is on its way before the caller sends the new member work. */
  afterSeat?(): Promise<void>;
  /** What a member's thread is doing now, from the scheduler's last look. */
  statusOf?(participantId: string): ParticipantStatus;
}

/** A member's state in a word or two, as the page says it. */
function stateWord(status: ParticipantStatus | undefined, openTasks: Task[]): string {
  if (!status) return "ready";
  if (status.threadMissing) return "thread deleted in T3";
  if (status.pendingApprovals) return "needs the user's approval";
  if (status.pendingUserInput) return "waiting for the user's answer";
  if (status.activeRunId || status.status === "running" || status.status === "waiting") return `working${openTasks.length > 0 ? ` on ${openTasks.map((t) => `task${t.number}`).join(", ")}` : ""}`;
  if (status.externalActivity) return "working in T3";
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

  /** Who said a post and who it was for, as the page words it. */
  private parties(room: Room, event: RoomEvent, events: RoomEvent[]): { from: string; to: string } {
    const aliasOf = (participantId: string) => `@${this.deps.repos.getParticipant(participantId)?.alias ?? participantId}`;
    const from =
      event.speaker.type === "participant" ? aliasOf(event.speaker.participantId) : event.speaker.type === "outside" ? `outside the room (${event.speaker.title})` : event.speaker.type;
    let to = "";
    if (event.kind === "member.message" && event.to) to = aliasOf(event.to);
    else if (event.kind === "user.message") {
      to = [...new Set(this.deps.repos.listTasks(room.id).filter((task) => task.sourceEventId === event.id).map((task) => aliasOf(task.participantId)))].join(" ");
    } else if (event.kind === "assistant.reply") {
      // A seat briefing's acknowledgement answers Backroom, not the user.
      const task = event.taskId ? this.deps.repos.getTask(event.taskId) : null;
      to = task?.kind === "seat" ? "" : "user";
    }
    else if (event.kind === "t3.turn") {
      // The answer goes to whoever asked: the member whose message started the run, or the person who typed in T3.
      const asked = event.sourceRef?.t3RunId ? events.find((e) => e.kind === "member.message" && e.sourceRef?.t3RunId === event.sourceRef?.t3RunId && e.sourceRef?.threadId === event.sourceRef?.threadId) : undefined;
      to = asked ? this.parties(room, asked, events).from : event.prompt !== null ? "user" : "";
    }
    return { from, to };
  }

  private index(room: Room, args: string[]): string {
    const all = args.includes("--all");
    const afterText = this.flag(args, "--after");
    const after = afterText === undefined ? 0 : this.number(afterText, "--after");
    const events = this.deps.repos.listEvents(room.id, 1, Number.MAX_SAFE_INTEGER, 100_000);
    const listed = events.filter((event) => event.sequence > after && (all || SAID.has(event.kind)));
    if (listed.length === 0) return after > 0 ? `No posts after #${after}.` : "The board is empty.";
    const lines = listed.map((event) => {
      const { from, to } = this.parties(room, event, events);
      const outcome = event.outcome ? ` · ${event.outcome}` : "";
      return `#${event.sequence}  ${event.kind}  ${from}${to ? ` → ${to}` : ""}${outcome} · ${event.text.length.toLocaleString("en-US")} chars`;
    });
    return [`Board of "${room.title}": ${listed.length} post${listed.length === 1 ? "" : "s"}${after > 0 ? ` after #${after}` : ""}. Read one with: read <number>`, ...lines].join("\n");
  }

  private read(room: Room, args: string[]): string {
    const pageText = this.flag(args, "--page");
    const page = pageText === undefined ? 1 : Number(pageText);
    if (!Number.isInteger(page) || page < 1) throw new BoardError(`rooms-board: --page must be 1 or more, got "${pageText}".`);
    if (args.length === 0) throw new BoardError("rooms-board: read needs one or more post numbers, e.g. read 51 53.");
    const events = this.deps.repos.listEvents(room.id, 1, Number.MAX_SAFE_INTEGER, 100_000);
    const out: string[] = [];
    for (const arg of args) {
      const sequence = this.number(arg, "a post");
      // Only this room's posts exist here: a number names a post of the caller's room or nothing.
      const event = events.find((e) => e.sequence === sequence);
      if (!event) throw new BoardError(`rooms-board: this room has no post #${sequence}.`, 404);
      const { from, to } = this.parties(room, event, events);
      const pages = Math.max(1, Math.ceil(event.text.length / BOARD_PAGE_CHARS));
      if (page > pages) throw new BoardError(`rooms-board: post #${sequence} has ${pages} page${pages === 1 ? "" : "s"}.`);
      const head = `[#${event.sequence} ${event.kind} · ${from}${to ? ` → ${to}` : ""}${event.outcome ? ` · ${event.outcome}` : ""} · ${event.createdAt}${pages > 1 ? ` · page ${page} of ${pages}` : ""}]`;
      const body = event.text.slice((page - 1) * BOARD_PAGE_CHARS, page * BOARD_PAGE_CHARS);
      out.push(head, body.length > 0 ? body : "(no text)");
      if (event.kind === "t3.turn" && event.prompt !== null && page === 1) out.push(`[#${event.sequence} was asked, in T3]`, event.prompt);
      if (pages > 1 && page < pages) out.push(`[#${event.sequence} continues: read ${sequence} --page ${page + 1}]`);
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
      `Posted as #${event?.sequence ?? "?"}.`,
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
    const lines = members.map((member) => {
      const thread = this.deps.repos.currentBinding(member.id)?.threadId ?? "no thread";
      const open = tasks.filter((t) => t.participantId === member.id && (t.state === "running" || t.state === "dispatching" || t.state === "needs_input") && t.kind !== "wake");
      const queued = tasks.filter((t) => t.participantId === member.id && t.state === "queued" && t.kind !== "wake").length;
      return `@${member.alias}${room.consigliereId === member.id ? " (the Consigliere)" : ""} · ${member.modelSelection.model} · ${stateWord(this.deps.statusOf?.(member.id), open)}${queued > 0 ? ` · ${queued} queued` : ""} · thread ${thread}`;
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
}
