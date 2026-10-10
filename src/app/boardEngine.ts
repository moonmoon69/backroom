/**
 * The board for agents (stage 4/5 plan, item L3; H5: members only answer): what bin/rooms-board runs. The room's
 * journal is the board. Members read it; their final replies are their answers, so they run nothing
 * else. The Consigliere posts the work (a request per recipient), corrects, cancels and retries it; every read comes
 * from the journal.
 *
 * Every command goes through the host's member API (src/runtime/host.ts), which keeps the semantics; this file parses
 * the command line, resolves names and numbers, refuses what the engine would refuse in words a member can act on, and
 * words the replies. A post's number is its journal sequence number, as briefings print it (L2's journalDirectory), so
 * `#n` means the same post everywhere. The caller is the seat its --as key names, in that key's room only.
 */
import { randomUUID } from "node:crypto";
import type { Repos } from "../db/repos.ts";
import type { RoomCommand } from "../domain/commands.ts";
import { RoomError } from "../domain/errors.ts";
import type { Participant, Room } from "../domain/types.ts";
import { contextPhrase, type ContextMeter } from "../domain/contextMeter.ts";
import { roomForKey } from "../browser/catalog.ts";
import { roomStateSection } from "../briefing/assemble.ts";
import { deliveredInputs, inputTree } from "../engine/index.ts";
import type { ClaimOutcome, Principal, Projection, Request, RoomEvent, Run } from "../engine/index.ts";
import { FOLLOW_UP, HostRefusal, MEMBERS_DO_NOT_POST, backroomRequest, type EngineHost } from "../runtime/index.ts";
import { BOARD_PAGE_CHARS, BoardError, threadOutcome, type RetiredThread } from "./board.ts";
import { retireThreadChoice } from "./consigliere.ts";
import { readKeepAlive, writeKeepAlive } from "./keepAlive.ts";
import { ROOM_STATE_MAX_CHARS, readRoomState, writeRoomState } from "./roomState.ts";

/** The largest text a command may carry, in UTF-8 bytes (plan §7): the host reserves 4 MiB, so no input blocks. */
export const MAX_POST_BYTES = 1024 * 1024;

/**
 * The seat lifecycle (src/app/engineSeats.ts): the service routes the room commands `seat`, `reseat` and `retire` send
 * (participant.fromPreset, .reseat, .retire) to it, and the CLI reads the reseats in progress from it.
 */
export interface EngineSeatsView {
  reseats(roomId: string): Array<{ participantId: string; seatId: string; requestId: string; stage: "checkpoint" | "seated" }>;
}

export interface BoardEngineDeps {
  repos: Repos;
  host: EngineHost;
  /** Runs a room command: how seating, reseating and retiring reach the seat lifecycle. */
  execute?(command: RoomCommand): Promise<unknown>;
  /** The seat lifecycle (`stack.seats`); a board built without it (in a test) refuses seat, reseat and retire. */
  seats?: EngineSeatsView | null;
  /** A member's standing sections in full, as its first briefing gives them. */
  standing?(participantId: string): Promise<string>;
  contextOf?(participant: Participant): ContextMeter | null;
  /** Called after seating, so the seat briefing is on its way before the caller sends the new member work. */
  afterSeat?(): Promise<void>;
  notify?(roomId: string): void;
}

const HELP = `rooms-board: this room's board. Always pass --as <your key>.
A post's number (#n) is the same in your briefings, here and on the page. A member's final reply is its answer: members
read the board and run nothing else. Quote each text as one argument; for a text longer than a shell allows (128 KiB),
pass --file <path>, or --file - to read it from stdin. A text is at most 1 MiB.

Anyone:
  read <n>... [--page <p>]        the exact text of those posts; one over ${BOARD_PAGE_CHARS.toLocaleString("en-US")} characters is printed in pages.
  index [--after <n>] [--all]     the room's posts: number, kind, sender, receiver, state, size. --all adds the
                                  board's own records (runs, subscriptions), which have numbers but are not posts.
  members                         the room's members: model, what each is doing now, its requests, its thread.
  rules                           your standing sections, as your first briefing gave them.
  state                           prints the room state.
  keepalive                       this room's keep-alives: the interval, and the seats they are on for.
  help                            this list.

The Consigliere's (the user posts from the page):
  post "@name the job"            a request to that member; "@a @b the job" makes one request each, "@all" one for every
                                  other member. The member's reply wakes you, with its T3 status at the top, and so does
                                  each follow-up of it (a turn it started itself, background work that ended).
  correct #n "<text>"             corrects your request #n: it goes into its owner's running turn, or starts one.
  cancel #n                       withdraws your open request #n, or Backroom's to a member (a seat briefing, a
                                  reseat's checkpoint).
  retry #n                        runs a failed turn again; #n is its error notice or its request.
  state "<text>"                  replaces the room state (at most ${ROOM_STATE_MAX_CHARS.toLocaleString("en-US")} characters).
  keepalive @name on|off          turns keep-alives on or off for that seat (on for you and off for members by default).
  keepalive every <minutes>       the room's keep-alive interval, 1 to 59 minutes (55 or less leaves the wake time to
                                  reach the model within the cache's hour), or "default".
  crew                            the user's saved crew, by name, with model.
  seat <saved crew name>          seats that saved crew member in this room.
  reseat <alias> ["<plan>"]       asks that member for a checkpoint, then a fresh seat takes over.
  retire <alias>                  that member leaves the room; refused while it has work open. A request of
                                  Backroom's it has not answered (its briefing) goes with it.`;

/** Commands members had before H5 and N1, and why they are gone: a final reply is the answer. */
const GONE: Record<string, string> = {
  answer: "your final reply is your answer; there is nothing to run.",
  working: "there is no working mark: your final reply is your answer, and the Consigliere reads your T3 status (what still runs in the background) at the top of it.",
  follow: "nobody follows requests: every reply of a member, and each follow-up of it, wakes the Consigliere.",
  note: "notes are gone: say it in your final reply.",
};

interface Caller {
  room: Room;
  member: Participant;
  seatId: string;
}

/** Engine refusals a member can meet, in words it can act on. The rest are passed on as they are. */
const ENGINE_WORDS: Record<string, string> = {
  "author seat is not active": "your seat is no longer active (you were reseated or retired)",
  "requester authorization required": "only whoever asked for that request can do that",
  "closed request needs a new request": "that request is closed; post a new request that cites it",
  "unrelated causal parent": "a post can only go under a request you own",
  "own request cannot create a wake": "you cannot post to yourself",
  "unknown request": "there is no such request in this room",
  "unknown seat": "that member has no seat on this room's board",
};

const RECIPIENT = /^@([a-z0-9][a-z0-9_-]{0,31})(?![a-z0-9_-])[\s,:;]*/i;
const REF = /^#?\d+$/;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export class BoardEngine {
  private readonly deps: BoardEngineDeps;
  private readonly host: EngineHost;
  constructor(deps: BoardEngineDeps) {
    this.deps = deps;
    this.host = deps.host;
  }

  /** One command line (without --as), for the seat the key names. Returns what the CLI prints. */
  async run(argv: string[], as: string | null): Promise<string> {
    const args = [...argv];
    const command = args.shift() ?? "help";
    if (command === "help" || command === "--help" || command === "-h") return HELP;
    const c = this.caller(as);
    switch (command) {
      case "post":
      case "say":
        return this.post(c, args);
      case "answer":
      case "working":
      case "follow":
      case "note":
        throw new BoardError(`rooms-board: ${GONE[command]}`, 410);
      case "correct":
        return this.correct(c, args);
      case "cancel":
        return this.cancel(c, args);
      case "retry":
        return this.retry(c, args);
      case "index":
        return this.index(c, args);
      case "read":
        return this.read(c, args);
      case "members":
        return this.members(c);
      case "crew":
        return this.crew();
      case "seat":
        return this.seat(c, args);
      case "reseat":
        return this.reseat(c, args);
      case "retire":
        return this.retire(c, args);
      case "rules":
        return this.rules(c);
      case "state":
        return this.state(c, args);
      case "keepalive":
      case "keep-alive":
        return this.keepAlive(c, args);
      default:
        throw new BoardError(`rooms-board: no command "${command}". Run "rooms-board help".`);
    }
  }

  // ---------------- who is asking ----------------

  /** The key names a member of one room; its seat is that member's current binding in the room's journal. */
  private caller(as: string | null): Caller {
    if (!as) throw new BoardError("rooms-board: pass --as <your key>, as your briefing gives it.");
    const room = roomForKey(this.deps.repos, as);
    const alias = as.slice(0, Math.max(as.lastIndexOf("."), 0)).toLowerCase();
    const member = room ? this.deps.repos.listActiveParticipants(room.id).find((p) => p.alias.toLowerCase() === alias) : undefined;
    if (!room || !member) throw new BoardError(`rooms-board: "${as}" is not the key of a member seated in a room.`, 403);
    const seatId = this.seatOf(room.id, member);
    if (!seatId) throw new BoardError(`rooms-board: @${member.alias} has no seat on this room's board.`, 403);
    return { room, member, seatId };
  }

  /** A member's seat in the room's journal: its current binding, while that seat is not retired. */
  private seatOf(roomId: string, member: Participant): string | null {
    const binding = this.deps.repos.currentBinding(member.id);
    const seat = binding ? this.view(roomId).seats.get(binding.id) : undefined;
    return seat && seat.status !== "retired" ? seat.id : null;
  }

  private view(roomId: string): Projection {
    return this.host.view(roomId);
  }

  private orchestrator(c: Caller): string | null {
    return this.view(c.room.id).orchestrator;
  }

  private onlyConsigliere(c: Caller, what: string): void {
    const o = this.orchestrator(c);
    if (o !== c.seatId) throw new BoardError(`rooms-board: only this room's Consigliere${o ? ` (${this.name(o)})` : ""} ${what}.`, 403);
  }

  // ---------------- names and numbers ----------------

  private alias(seatId: string): string {
    const binding = this.deps.repos.getBinding(seatId);
    return (binding ? this.deps.repos.getParticipant(binding.participantId)?.alias : null) ?? seatId;
  }

  private name(principal: Principal): string {
    if (principal === "$user") return "the user";
    if (principal === "$system") return "Backroom";
    return `@${this.alias(principal)}`;
  }

  /** The number of the post that made a request: its `request` event's sequence. */
  private number(p: Projection, requestId: string): number | null {
    return p.events.find((e) => e.data.kind === "request" && e.data.request.id === requestId)?.seq ?? null;
  }

  private label(p: Projection, requestId: string): string {
    const n = this.number(p, requestId);
    return n === null ? "a request" : `#${n}`;
  }

  private labels(p: Projection, ids: readonly string[]): string {
    return ids.map((id) => this.label(p, id)).join(", ");
  }

  /** The host's texts name requests and seats by ID; members type post numbers and aliases, and cannot post to the user. */
  private words(p: Projection, text: string): string {
    const names = [
      ["@$user", "the user"] as const,
      ...[...p.requests.keys()].map((id) => [`#${id}`, this.label(p, id)] as const),
      ...[...p.seats.keys()].map((id) => [`@${id}`, `@${this.alias(id)}`] as const),
    ].filter(([raw]) => !/^.\d+$/.test(raw)).sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [raw, shown] of names) if (out.includes(raw)) out = out.split(raw).join(shown);
    return out;
  }

  private parseNumber(text: string, what: string): number {
    const value = Number(text.replace(/^#/, ""));
    if (!Number.isInteger(value) || value < 1) throw new BoardError(`rooms-board: ${what} must be a post number such as 51, got "${text}".`);
    return value;
  }

  /** The event a post number names in this room's journal, if it is a post. */
  private postAt(p: Projection, n: number): RoomEvent | null {
    const event = p.events[n - 1];
    return event && isPost(event) ? event : null;
  }

  /** `#n` as a request of this room: the post that made it. Another post about one request names that request. */
  private request(p: Projection, text: string): Request {
    const n = this.parseNumber(text, "a request");
    const event = this.postAt(p, n);
    if (!event) throw new BoardError(`rooms-board: this room has no post #${n}.`, 404);
    if (event.data.kind === "request") return p.requests.get(event.data.request.id)!;
    const about = requestsOf(event);
    const kind = describe(event).kind;
    if (about.length === 1) throw new BoardError(`rooms-board: #${n} is a ${kind} on ${this.label(p, about[0]!)}, not a request: name ${this.label(p, about[0]!)}.`);
    throw new BoardError(`rooms-board: #${n} is a ${kind}, not a request.`);
  }

  /** Leading `#n` arguments, then the text (always the last argument, so a text that is a number stays a text). */
  private refsAndText(c: Caller, args: string[]): { requests: Request[]; text: string } {
    const p = this.view(c.room.id);
    const refs: string[] = [];
    while (args.length > 1 && REF.test(args[0]!)) refs.push(args.shift()!);
    const text = args.join(" ").trim();
    if (refs.length === 0 && REF.test(text)) throw new BoardError(`rooms-board: ${text} looks like a post number with no text after it; quote the text as its own argument: ${text} "…".`);
    return { requests: refs.map((ref) => this.request(p, ref)), text };
  }

  private size(text: string): void {
    const n = bytes(text);
    if (n > MAX_POST_BYTES) {
      throw new BoardError(`rooms-board: that text is ${n.toLocaleString("en-US")} bytes; the board takes at most 1 MiB (${MAX_POST_BYTES.toLocaleString("en-US")} bytes). Put the bulk in a file in your folder and post its path.`, 413);
    }
  }

  /** Runs a member command, turning the host's and the engine's refusals into sentences with board numbers. */
  private async act<T>(c: Caller, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BoardError) throw error;
      if (error instanceof HostRefusal) throw new BoardError(`rooms-board: ${this.words(this.view(c.room.id), error.message)}`, 409);
      if (error instanceof RoomError) throw new BoardError(`rooms-board: ${this.words(this.view(c.room.id), error.message)}`, error.status);
      if (error instanceof Error && error.constructor === Error) throw new BoardError(`rooms-board: refused: ${ENGINE_WORDS[error.message] ?? error.message}.`, 409);
      throw error;
    }
  }

  /** A fresh command ID per invocation, never derived from the text: two identical posts are two posts. */
  private commandId(): string {
    return `board:${randomUUID()}`;
  }

  /** Events a command appended: those of its own ID and of the `<id>:…` commands the host made with it. */
  private appended(p: Projection, seatId: string, id: string): RoomEvent[] {
    return p.events.filter((e) => {
      const [actor, key] = JSON.parse(e.commandKey) as [string, string];
      return actor === seatId && (key === id || key.startsWith(`${id}:`));
    });
  }

  // ---------------- writing ----------------

  /** `post "@x …"`: one request per recipient, with the whole text as its body; the Consigliere's (members answer). */
  private async post(c: Caller, args: string[]): Promise<string> {
    if (this.orchestrator(c) !== c.seatId) throw new BoardError(`rooms-board: ${MEMBERS_DO_NOT_POST}`, 403);
    const text = args.join(" ").trim();
    if (!text) throw new BoardError('rooms-board: post needs the text, as one quoted argument: post "@opus write the plan".');
    this.size(text);
    let rest = text;
    const names: string[] = [];
    for (let m = RECIPIENT.exec(rest); m; m = RECIPIENT.exec(rest)) {
      names.push(m[1]!.toLowerCase());
      rest = rest.slice(m[0].length);
    }
    if (names.length === 0) throw new BoardError("rooms-board: a post is work for members: start with @name.");
    if (!rest.trim()) throw new BoardError("rooms-board: the post names members but says nothing for them to do.");
    if (/^\/[a-z][\w-]*(\s|$)/i.test(rest)) {
      throw new BoardError(`rooms-board: "${rest.split(/\s/)[0]}" is a slash command; members cannot send those through the board. Post the work in words.`);
    }
    const recipients = this.recipients(c, names);
    const made: string[] = [];
    const base = this.commandId();
    await this.act(c, () => {
      recipients.forEach((to, index) => {
        const id = recipients.length === 1 ? base : `${base}:${index + 1}`;
        this.host.post(c.room.id, { actor: c.seatId, id, to, body: text });
        made.push(id);
      });
    });
    const after = this.view(c.room.id);
    return [
      ...made.map((id) => `Posted #${this.number(after, id)} → ${this.name(after.requests.get(id)!.owner)}.`),
      "Each reply wakes you, with the member's T3 status at the top, and so does each follow-up of it.",
    ].join("\n");
  }

  /** Recipients by alias: active members of this room with a seat in its journal; `@all` is every other one. */
  private recipients(c: Caller, names: string[]): string[] {
    const members = this.deps.repos.listActiveParticipants(c.room.id);
    const seats = new Map<string, string>();
    for (const m of members) {
      const seatId = this.seatOf(c.room.id, m);
      const seat = seatId ? this.view(c.room.id).seats.get(seatId) : undefined;
      if (seatId && seat) seats.set(m.alias.toLowerCase(), seatId);
    }
    const out: string[] = [];
    for (const name of names) {
      if (name === "all") {
        for (const seatId of seats.values()) if (seatId !== c.seatId && !out.includes(seatId)) out.push(seatId);
        continue;
      }
      const seatId = seats.get(name);
      if (!seatId) {
        const others = [...seats.keys()].filter((a) => seats.get(a) !== c.seatId).map((a) => `@${a}`);
        throw new BoardError(`rooms-board: nobody called @${name} can take work in this room${others.length ? `; members: ${others.join(", ")}` : ""}.`, 404);
      }
      if (seatId === c.seatId) throw new BoardError("rooms-board: you cannot post to yourself.");
      if (!out.includes(seatId)) out.push(seatId);
    }
    if (out.length === 0) throw new BoardError("rooms-board: nobody else is seated in this room.");
    return out;
  }

  /** `correct #n "…"`, for the requester: it goes into the owner's running turn (M1), or starts one. */
  private async correct(c: Caller, args: string[]): Promise<string> {
    const { requests, text } = this.refsAndText(c, args);
    if (requests.length !== 1 || !text) throw new BoardError('rooms-board: correct needs one request and the text: correct #n "…".');
    this.size(text);
    const q = requests[0]!;
    const p = this.view(c.room.id);
    this.mayControl(c, p, q, "correct");
    if (q.state !== "open") throw new BoardError(`rooms-board: ${this.label(p, q.id)} is ${q.state}; a closed request is not corrected: post a new one that cites it.`, 409);
    const id = this.commandId();
    await this.act(c, () => this.host.correct(c.room.id, { actor: c.seatId, id, requestId: q.id, body: text }));
    const after = this.view(c.room.id);
    const event = this.appended(after, c.seatId, id)[0];
    return `Correction #${event?.seq ?? "?"} to ${this.label(after, q.id)} → ${this.name(q.owner)}: it goes into ${this.name(q.owner)}'s running turn, or starts one, and its answer to ${this.label(after, q.id)} takes it into account.`;
  }

  /**
   * Cancel and correct are the requester's alone: the owner is told, and the requester is the one waiting for the
   * answer. Anyone else (the Consigliere too) would close or change work someone else is waiting on, unseen by them.
   * Backroom's request to a member (its briefing, a reseat's checkpoint) is nobody's work: the Consigliere may cancel it
   * (a member whose thread fails it).
   */
  private mayControl(c: Caller, p: Projection, q: Request, verb: string): void {
    if (backroomRequest(q)) {
      if (verb === "cancel" && this.orchestrator(c) === c.seatId) return;
      const o = this.orchestrator(c);
      throw new BoardError(`rooms-board: ${this.label(p, q.id)} is Backroom's request to ${this.name(q.owner)}: only this room's Consigliere${o ? ` (${this.name(o)})` : ""} can cancel it, and nobody corrects it.`, 403);
    }
    if (q.returnTo !== c.seatId) {
      const asker = q.returnTo === "$user" ? "the user" : this.name(q.returnTo);
      throw new BoardError(`rooms-board: only ${asker}, who asked ${this.label(p, q.id)}, can ${verb} it${q.returnTo === "$user" ? "" : `; ask ${asker}`}.`, 403);
    }
  }

  /** `cancel #n`, for the requester (§6: the host interrupts or defers as the owner's turn requires). */
  private async cancel(c: Caller, args: string[]): Promise<string> {
    if (args.length !== 1) throw new BoardError("rooms-board: cancel needs one request: cancel #n.");
    const p = this.view(c.room.id);
    const q = this.request(p, args[0]!);
    this.mayControl(c, p, q, "cancel");
    if (q.state !== "open") throw new BoardError(`rooms-board: ${this.label(p, q.id)} is already ${q.state}.`, 409);
    const result = await this.act(c, () => this.host.cancel(c.room.id, { actor: c.seatId, id: this.commandId(), requestId: q.id }));
    const owner = this.name(q.owner);
    if (result.deferred) return `${this.label(p, q.id)} is cancelled when ${owner}'s current turn ends, since that turn works on other requests. Nobody is woken now.`;
    if (result.applied) return `${this.label(p, q.id)} is cancelled. ${owner} is told${this.view(c.room.id).seats.get(q.owner)?.activeRunId ? ", and its turn on it is stopped" : ""}.`;
    return `${this.label(p, q.id)} had already closed; nothing changed.`;
  }

  /**
   * `retry #n`, the Consigliere's: #n is a failed run's error notice or output, or a request it carried. Refused for a
   * run already retried (the seat would do the work twice) and for one whose requests are all closed (a wake for nothing).
   */
  private async retry(c: Caller, args: string[]): Promise<string> {
    this.onlyConsigliere(c, "retries a failed turn; tell the Consigliere which one");
    const target = args.shift();
    if (!target) throw new BoardError('rooms-board: retry needs the failed turn: retry #n, where #n is its error notice or its request.');
    const text = args.join(" ").trim();
    this.size(text);
    const p = this.view(c.room.id);
    const run = this.failedRun(p, target);
    const open = this.runRequests(p, run).filter((id) => p.requests.get(id)?.state === "open");
    const seat = this.name(run.seatId);
    const done = p.events.find((e) => e.data.kind === "retry" && e.data.runId === run.id);
    if (done) throw new BoardError(`rooms-board: that turn of ${seat} was already retried as #${done.seq}.`, 409);
    if (open.length === 0) throw new BoardError(`rooms-board: nothing to redo: every request that turn of ${seat} carried is closed.`, 409);
    const id = this.commandId();
    await this.act(c, () => this.host.retry(c.room.id, { actor: c.seatId, id, runId: run.id, body: text || `Retry of the turn that failed on ${this.labels(p, open)}.` }));
    const after = this.view(c.room.id);
    const event = this.appended(after, c.seatId, id).find((e) => e.data.kind === "retry");
    return `Retry #${event?.seq ?? "?"} → ${seat}: the turn that failed on ${this.labels(after, open)} (${run.failure ?? "failed"}) runs again with its original input.`;
  }

  /** The failed run a retry names: by its error notice or error output, or the latest failed run carrying a request. */
  private failedRun(p: Projection, text: string): Run {
    const n = this.parseNumber(text, "the failed turn");
    const event = this.postAt(p, n);
    if (!event) throw new BoardError(`rooms-board: this room has no post #${n}.`, 404);
    const d = event.data;
    let run: Run | undefined;
    if (d.kind === "notice" && d.intent === "error") {
      if (d.causeId.startsWith("activity:")) throw new BoardError(`rooms-board: #${n} is the failure of background work, not of a turn; a background job is not retried: post the work again.`, 409);
      run = p.runs.get(d.causeId);
    }
    else if (d.kind === "output" && d.disposition.kind === "error" && d.association.kind === "run") run = p.runs.get(d.association.id);
    else if (d.kind === "request") {
      const id = d.request.id;
      run = [...p.runs.values()].filter((r) => r.phase === "terminal" && r.failure !== null && this.runRequests(p, r).includes(id)).at(-1);
      if (!run) throw new BoardError(`rooms-board: no turn on #${n} has failed.`, 404);
    }
    if (!run) throw new BoardError(`rooms-board: #${n} is not a failed turn: name its error notice or its request.`);
    if (run.phase !== "terminal" || run.failure === null) throw new BoardError(`rooms-board: the turn #${n} names did not fail.`, 409);
    return run;
  }

  /** The requests a run worked on: each input's request walked up to the first one the seat owns (§1). */
  private runRequests(p: Projection, run: Run): string[] {
    const ids = new Set<string>();
    for (const input of inputTree(deliveredInputs(p, run.id))) {
      for (const id of input.requestIds) {
        let q = p.requests.get(id);
        while (q && q.owner !== run.seatId) q = q.parentId ? p.requests.get(q.parentId) : undefined;
        if (q) ids.add(q.id);
      }
    }
    return [...ids];
  }

  // ---------------- reading ----------------

  private index(c: Caller, args: string[]): string {
    const all = args.includes("--all");
    const afterText = flag(args, "--after");
    const after = afterText === undefined ? 0 : this.parseNumber(afterText, "--after");
    const p = this.view(c.room.id);
    const listed = p.events.filter((e) => e.seq > after && (all || isPost(e)));
    const posts = listed.filter(isPost).length;
    if (listed.length === 0) return after > 0 ? `No posts after #${after}.` : "The board is empty.";
    const lines = listed.map((e) => (isPost(e) ? this.line(c, p, e) : `#${e.seq}  (${recordLine(e)})`));
    return [`Board of "${c.room.title}": ${plural(posts, "post")}${after > 0 ? ` after #${after}` : ""}. Read one with: read <number>`, ...lines].join("\n");
  }

  /** One post as the index lists it: number, kind, from → to, what it is about and its state, size. */
  private line(c: Caller, p: Projection, e: RoomEvent): string {
    const { from, to, about } = this.parties(c, p, e);
    const text = bodyOf(e);
    return `#${e.seq}  ${describe(e).kind}  ${from}${to ? ` → ${to}` : ""}${about ? ` · ${about}` : ""} · ${text.length.toLocaleString("en-US")} chars`;
  }

  private parties(c: Caller, p: Projection, e: RoomEvent): { from: string; to: string; about: string } {
    const name = (x: Principal) => this.name(x);
    const names = (xs: readonly Principal[]) => xs.map(name).join(" ");
    // Backroom's request that journals from before B1 hold in the user's name is Backroom's, and so is the answer it got.
    const asker = (requestId: string, principal: Principal) => (principal === "$user" && backroomRequest({ id: requestId, returnTo: principal }) ? "Backroom (in the user's name)" : name(principal));
    const d = e.data;
    switch (d.kind) {
      case "request": {
        const q = p.requests.get(d.request.id);
        const answer = q?.answerId ? p.events.find((x) => x.id === q.answerId) : undefined;
        const state = q?.state === "answered" ? `answered${answer ? ` by #${answer.seq}` : ""}` : (q?.state ?? "open");
        return { from: asker(d.request.id, d.author), to: name(d.request.owner), about: [d.request.parentId ? `under ${this.label(p, d.request.parentId)}` : "", state].filter(Boolean).join(" · ") };
      }
      case "correction":
        return { from: name(d.author), to: names(d.recipients), about: `on ${this.label(p, d.requestId)}` };
      case "cancel":
        return { from: name(d.author), to: names(d.recipients), about: `of ${this.label(p, d.requestId)}${d.applied ? "" : " (it had already closed)"}` };
      case "note":
      case "progress":
        return { from: name(d.author), to: names(d.recipients), about: d.requestIds.length ? `on ${this.labels(p, d.requestIds)}` : "" };
      case "output": {
        const disposition = d.disposition;
        const about = d.claims.length
          ? d.claims.map((cl) => `${this.label(p, cl.requestId)} ${CLAIM_WORDS[cl.outcome]}`).join(", ")
          : "requestIds" in disposition && disposition.requestIds.length ? `on ${this.labels(p, disposition.requestIds)}` : "";
        const to = d.claims.length ? [...new Set(d.claims.map((cl) => asker(cl.requestId, cl.returnTo)))].join(" ") : names(d.recipients);
        return { from: name(d.author), to, about };
      }
      case "notice":
        return { from: name(d.author), to: names(d.recipients), about: d.requestIds.length ? `on ${this.labels(p, d.requestIds)}` : "" };
      case "retry":
        return { from: name(d.author), to: names(d.recipients), about: d.requestIds.length ? `of the turn on ${this.labels(p, d.requestIds)}` : "" };
      case "transfer":
        return { from: name(d.oldSeatId), to: name(d.newSeatId), about: `${plural(d.owned.length, "owned request")}, ${plural(d.awaited.length, "awaited answer")}` };
      case "delivery.blocked":
        return { from: "Backroom", to: name(d.seatId), about: `#${p.events.find((x) => x.id === d.eventId)?.seq ?? "?"} needs ${d.requiredBytes.toLocaleString("en-US")} bytes` };
      default:
        return { from: "", to: "", about: "" };
    }
  }

  private read(c: Caller, args: string[]): string {
    const pageText = flag(args, "--page");
    const page = pageText === undefined ? 1 : Number(pageText);
    if (!Number.isInteger(page) || page < 1) throw new BoardError(`rooms-board: --page must be 1 or more, got "${pageText}".`);
    if (args.length === 0) throw new BoardError("rooms-board: read needs one or more post numbers, e.g. read 51 53.");
    const p = this.view(c.room.id);
    const out: string[] = [];
    for (const arg of args) {
      const n = this.parseNumber(arg, "a post");
      const e = this.postAt(p, n);
      if (!e) throw new BoardError(`rooms-board: this room has no post #${n}.`, 404);
      const { from, to, about } = this.parties(c, p, e);
      const text = this.words(p, bodyOf(e));
      const pages = Math.max(1, Math.ceil(text.length / BOARD_PAGE_CHARS));
      if (page > pages) throw new BoardError(`rooms-board: post #${n} has ${plural(pages, "page")}.`);
      out.push(`[#${n} ${describe(e).kind} · ${from}${to ? ` → ${to}` : ""}${about ? ` · ${about}` : ""}${pages > 1 ? ` · page ${page} of ${pages}` : ""}]`);
      const body = text.slice((page - 1) * BOARD_PAGE_CHARS, page * BOARD_PAGE_CHARS);
      out.push(body.length > 0 ? body : "(no text)");
      if (e.data.kind === "request" && page === pages) {
        const q = p.requests.get(e.data.request.id);
        const corrections = q?.corrections.map((x) => `#${x.seq}`) ?? [];
        if (corrections.length) out.push(`[corrected by ${corrections.join(", ")}]`);
      }
      if (pages > 1 && page < pages) out.push(`[#${n} continues: read ${n} --page ${page + 1}]`);
      out.push("");
    }
    return out.join("\n").trimEnd();
  }

  private members(c: Caller): string {
    const p = this.view(c.room.id);
    const seats = [...p.seats.values()].filter((s) => s.status !== "retired");
    if (seats.length === 0) return "Nobody is seated on this room's board.";
    const reseating = this.deps.seats?.reseats(c.room.id) ?? [];
    const lines = seats.map((seat) => {
      const binding = this.deps.repos.getBinding(seat.id);
      const member = binding ? this.deps.repos.getParticipant(binding.participantId) : null;
      const owns = [...p.requests.values()].filter((q) => q.owner === seat.id && q.state === "open").map((q) => q.id);
      const awaits = [...p.requests.values()].filter((q) => q.returnTo === seat.id && q.state === "open").map((q) => q.id);
      const context = this.deps.contextOf && member ? ` · ${contextPhrase(this.deps.contextOf(member))}` : "";
      const reseat = reseating.find((r) => r.seatId === seat.id && r.stage === "checkpoint");
      return [
        `${this.name(seat.id)}${p.orchestrator === seat.id ? " (the Consigliere)" : ""}`,
        member?.modelSelection.model ?? "model unknown",
        this.doing(c, p, seat.id),
        owns.length ? `owns ${this.labels(p, owns)}` : "",
        awaits.length ? `waits on ${this.labels(p, awaits)}` : "",
      ].filter(Boolean).join(" · ") + `${context}${reseat ? ` · being reseated (checkpoint ${this.label(p, reseat.requestId)})` : ""} · thread ${seat.threadId}`;
    });
    return [`Members of "${c.room.title}":`, ...lines, ...(p.orchestrator ? [] : ["This room has no Consigliere."])].join("\n");
  }

  /** What a seat is doing now, from the journal: a turn, or input about to start one. */
  private doing(c: Caller, p: Projection, seatId: string): string {
    const seat = p.seats.get(seatId)!;
    const run = seat.activeRunId ? p.runs.get(seat.activeRunId) : undefined;
    if (run && (run.phase === "prepared" || run.phase === "sending")) return "starting a turn";
    if (run) {
      const work = this.host.currentWork(c.room.id, seatId)?.requestIds ?? [];
      return work.length ? `working on ${this.labels(p, work)}` : "in a turn";
    }
    const unread = this.host.unread(c.room.id, seatId);
    return unread ? `${plural(unread, "unread post")}, starts when its thread is free` : "ready";
  }

  private crew(): string {
    const presets = this.deps.repos.listPresets();
    if (presets.length === 0) return "The user has no saved crew.";
    return [
      "The user's saved crew (seat one with: seat <name>):",
      ...presets.map((preset) => `${preset.name} · ${preset.modelSelection.model}${preset.workspaceMode === "worktree" ? " · works in its own worktree" : ""}`),
    ].join("\n");
  }

  private async rules(c: Caller): Promise<string> {
    const text = (await this.deps.standing?.(c.member.id)) ?? "";
    if (!text) throw new BoardError("rooms-board: the standing sections cannot be built here.", 503);
    return `Standing sections for @${c.member.alias} in room "${c.room.title}", as they are now:\n${text}`;
  }

  /** The room state: anyone prints it; the Consigliere replaces it (any member, in a room without one). */
  private state(c: Caller, args: string[]): string {
    const text = args.join(" ").trim();
    const o = this.orchestrator(c);
    if (!text) {
      const state = readRoomState(this.deps.repos, c.room.id);
      if (state) return roomStateSection(state);
      return `This room has no state yet.${o === c.seatId || !o ? ' Write it with: state "<text>".' : ""}`;
    }
    this.size(text);
    if (o && o !== c.seatId) throw new BoardError(`rooms-board: only this room's Consigliere (${this.name(o)}) writes the room state.`, 403);
    if (text.length > ROOM_STATE_MAX_CHARS) {
      throw new BoardError(`rooms-board: the room state is ${text.length.toLocaleString("en-US")} characters; keep it under ${ROOM_STATE_MAX_CHARS.toLocaleString("en-US")} by pointing at post numbers instead of repeating them.`);
    }
    writeRoomState(this.deps.repos, c.room.id, { text, by: c.member.alias, at: new Date().toISOString() });
    this.deps.notify?.(c.room.id);
    return `Room state saved (${text.length.toLocaleString("en-US")} characters). It replaces the last one, and every new seat is given it with its first briefing.`;
  }

  /**
   * H6: the room's keep-alives. Anyone prints them; the Consigliere (any member, in a room without one) turns them on or
   * off for a seat, by member so that a reseat keeps it, and sets the room's interval.
   */
  private keepAlive(c: Caller, args: string[]): string {
    const usage = 'keepalive takes nothing (it prints the setting), "@name on", "@name off" or "every <minutes>".';
    if (args.length > 0) {
      const o = this.orchestrator(c);
      if (o && o !== c.seatId) throw new BoardError(`rooms-board: only this room's Consigliere (${this.name(o)}) sets keep-alives.`, 403);
      const setting = readKeepAlive(this.deps.repos, c.room.id);
      const [first, second, ...rest] = args;
      if (rest.length > 0) throw new BoardError(`rooms-board: ${usage}`);
      if (first === "every") {
        const minutes = Number(second);
        if (second === "default") setting.intervalMs = null;
        else if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 59) setting.intervalMs = minutes * 60_000;
        else throw new BoardError('rooms-board: keepalive every <minutes> takes 1 to 59 minutes, under the prompt cache\'s hour, or "default".');
      } else {
        if (second !== "on" && second !== "off") throw new BoardError(`rooms-board: ${usage}`);
        setting.members[this.target(c, first, usage).member.id] = second === "on";
      }
      writeKeepAlive(this.deps.repos, c.room.id, setting);
      this.deps.notify?.(c.room.id);
    }
    const room = readKeepAlive(this.deps.repos, c.room.id);
    const o = this.orchestrator(c);
    const seats = this.deps.repos.listActiveParticipants(c.room.id).flatMap((member) => {
      const seatId = this.seatOf(c.room.id, member);
      return seatId ? [{ member, seatId, ...this.host.keepAliveFor(c.room.id, seatId) }] : [];
    });
    const interval = seats[0]?.intervalMs ?? room.intervalMs ?? 0;
    const span = interval >= 60_000 ? plural(Math.round(interval / 60_000), "minute") : plural(Math.round(interval / 1000), "second");
    if (interval <= 0) return "Keep-alives are off in this room: Backroom runs with ROOMS_KEEPALIVE_MS=0, and the room sets no interval of its own (`keepalive every <minutes>`).";
    const why = (s: (typeof seats)[number]) => (s.chosen ? `turned ${s.on ? "on" : "off"}` : s.seatId === o ? "the Consigliere's default" : "members' default");
    const list = (on: boolean) => seats.filter((s) => s.on === on).map((s) => `@${s.member.alias} (${why(s)})`).join(", ") || "nobody";
    return [
      `Keep-alives in room "${c.room.title}": a seat with work in flight (a member it asked still working, background work or a subagent of its own) that nothing has woken for ${span} gets a keep-alive post, the status lines of that work, so its prompt cache stays warm. The seat replies in one line and uses no tools; the reply is a note that wakes nobody.`,
      `Interval: ${span} (${room.intervalMs === null ? "Backroom's default" : "this room's own"}).`,
      `On for: ${list(true)}.`,
      `Off for: ${list(false)}.`,
      "Work that never ends (a dev server left running) keeps a seat warm without end, one keep-alive per interval: have it stopped, or turn keep-alives off for that seat.",
    ].join("\n");
  }

  // ---------------- seats (L4b) ----------------

  /** Seating, reseating and retiring go through the room commands, which the service routes to the seat lifecycle. */
  private lifecycle(): (command: RoomCommand) => Promise<unknown> {
    if (!this.deps.seats || !this.deps.execute) throw new BoardError("rooms-board: this board has no seat lifecycle: seat, reseat and retire are not available.", 501);
    return this.deps.execute;
  }

  /** A seated member of this room by alias, with its seat in the journal. */
  private target(c: Caller, name: string | undefined, usage: string): { member: Participant; seatId: string } {
    if (!name) throw new BoardError(`rooms-board: ${usage}`);
    const alias = name.replace(/^@/, "").toLowerCase();
    const member = this.deps.repos.listActiveParticipants(c.room.id).find((p) => p.alias.toLowerCase() === alias);
    const seatId = member ? this.seatOf(c.room.id, member) : null;
    if (!member || !seatId) throw new BoardError(`rooms-board: nobody called @${name.replace(/^@/, "")} is seated in this room; \`members\` lists them.`, 404);
    return { member, seatId };
  }

  private async seat(c: Caller, args: string[]): Promise<string> {
    const name = args[0];
    if (!name) throw new BoardError("rooms-board: seat needs the name of a saved crew member; `crew` lists them.");
    const o = this.orchestrator(c);
    if (o && o !== c.seatId) throw new BoardError(`rooms-board: only this room's Consigliere (${this.name(o)}) seats members. Ask him.`, 403);
    const preset = this.deps.repos.findPresetByName(name.replace(/^@/, ""));
    if (!preset) throw new BoardError(`rooms-board: the user has no saved crew member called "${name}"; \`crew\` lists them.`, 404);
    const execute = this.lifecycle();
    const seated = (await this.act(c, () => execute({ type: "participant.fromPreset", roomId: c.room.id, presetId: preset.id }))) as { alias: string; threadId: string };
    await this.deps.afterSeat?.();
    return `Seated @${seated.alias} (${preset.modelSelection.model}) · thread ${seated.threadId}\nIts seat briefing is on its way; what you send it next waits behind that.`;
  }

  private async reseat(c: Caller, args: string[]): Promise<string> {
    this.onlyConsigliere(c, "reseats members");
    const { member } = this.target(c, args.shift(), 'reseat needs the member\'s alias, and may take what the fresh seat carries on with: reseat opus "item 4 of docs/plans/x.md".');
    const plan = args.join(" ").trim() || null;
    const execute = this.lifecycle();
    const result = (await this.act(c, () => execute({ type: "participant.reseat", participantId: member.id, by: c.member.id, plan }))) as { eventId?: string };
    const p = this.view(c.room.id);
    const checkpoint = result.eventId;
    const self = member.id === c.member.id;
    return [
      `Asked @${member.alias} for its checkpoint${checkpoint ? `: ${this.label(p, checkpoint)}` : ""}. It runs when ${self ? "this turn ends" : `@${member.alias} has finished the work in hand`}.`,
      `When the checkpoint lands, a fresh seat of the same crew member takes over ${self ? "as this room's Consigliere" : `@${member.alias}'s work`} with it${plan ? " and your plan" : ""}, and ${self ? "you leave" : `@${member.alias} leaves`} the room.`,
    ].join("\n");
  }

  private async retire(c: Caller, args: string[]): Promise<string> {
    this.onlyConsigliere(c, "retires members");
    const { member, seatId } = this.target(c, args[0], "retire needs the member's alias; `members` lists them.");
    if (seatId === c.seatId) throw new BoardError("rooms-board: you cannot retire yourself; `reseat` hands your seat to a fresh one.", 409);
    const execute = this.lifecycle();
    const result = (await this.act(c, () => execute({ type: "participant.retire", participantId: member.id, thread: retireThreadChoice(this.deps.repos) }))) as { thread?: RetiredThread } | null;
    return `@${member.alias} has left the room. ${threadOutcome(result?.thread)}`;
  }
}

// ---------------- the journal as posts ----------------

const CLAIM_WORDS: Record<ClaimOutcome["outcome"], string> = {
  answered: "answered",
  pending_activity: "still open",
  superseded: "still open (superseded)",
  already_answered: "already answered",
  late: "late",
};

/** Journal events that are posts: what someone wrote or was told. Runs, activities and subscriptions are records. */
export function isPost(e: RoomEvent): boolean {
  switch (e.data.kind) {
    case "request":
    case "correction":
    case "cancel":
    case "note":
    case "progress":
    case "notice":
    case "retry":
    case "transfer":
    case "delivery.blocked":
      return true;
    case "output":
      return e.data.disposition.kind !== "silent";
    default:
      return false;
  }
}

function describe(e: RoomEvent): { kind: string } {
  const d = e.data;
  switch (d.kind) {
    case "progress":
      return { kind: d.milestone === FOLLOW_UP ? "follow-up" : d.milestone === "working" ? "working" : "progress" };
    case "output":
      return { kind: { answer: "answer", progress: "after", error: "failed", yield: "reply", silent: "silent" }[d.disposition.kind] };
    case "notice":
      return { kind: `notice (${d.intent})` };
    case "transfer":
      return { kind: "handover" };
    case "delivery.blocked":
      return { kind: "blocked" };
    default:
      return { kind: d.kind };
  }
}

function bodyOf(e: RoomEvent): string {
  const d = e.data;
  switch (d.kind) {
    case "request":
      return d.request.body;
    case "cancel":
      return d.applied ? "Request cancelled." : "Cancel of a request that had already closed.";
    case "delivery.blocked":
      return `A post is too large to deliver (${d.requiredBytes.toLocaleString("en-US")} bytes); ROOMS_ENVELOPE_BYTES raises the budget.`;
    default:
      return "body" in d && typeof d.body === "string" ? d.body : "";
  }
}

/** The requests a post is about. */
function requestsOf(e: RoomEvent): string[] {
  const d = e.data;
  switch (d.kind) {
    case "request":
      return [d.request.id];
    case "correction":
    case "cancel":
      return [d.requestId];
    case "note":
    case "progress":
    case "notice":
    case "retry":
      return d.requestIds;
    case "output":
      return d.claims.length ? d.claims.map((c) => c.requestId) : "requestIds" in d.disposition ? d.disposition.requestIds : [];
    case "transfer":
      return [...d.owned, ...d.awaited];
    default:
      return [];
  }
}

/** A record (not a post) in `index --all`. */
function recordLine(e: RoomEvent): string {
  const d = e.data;
  switch (d.kind) {
    case "seat.created":
      return `seat ${d.seatId}${d.orchestrator ? ", the Consigliere" : ""}`;
    case "run.prepared":
      return `run ${d.run.id.slice(0, 8)} reserved for ${d.run.seatId}`;
    case "run.phase":
      return `run ${d.runId.slice(0, 8)} ${d.phase}`;
    case "run.ended":
      return `run ${d.runId.slice(0, 8)} ended${d.failure ? `: ${d.failure.slice(0, 80)}` : ""}`;
    case "activity.started":
      return `activity ${d.activity.id.slice(0, 16)} started`;
    case "activity.status":
      return `activity ${d.activityId.slice(0, 16)} ${d.status}`;
    case "subscription":
      return `${d.subscription.seatId} ${d.enabled ? "follows" : "stops following"} a request`;
    default:
      return d.kind;
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (value === undefined) throw new BoardError(`rooms-board: ${name} needs a value.`);
  return value;
}
