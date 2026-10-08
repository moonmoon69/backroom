/**
 * The user's message path (stage 4/5 plan, item L4a). What the user sends goes on the
 * room's journal through the host's API (src/runtime/host.ts), and the host delivers it:
 *
 * - a message makes one request per recipient per assignment, from the user, each carrying the message's preamble as
 *   context; the requests share the message's ID (in their IDs, `messageIdOf`) so the room can show them as one message;
 * - `/steer` makes the request a steered one (`steer:` ID): the host sends it into the recipient's running turn, or it
 *   waits for the turn to end like any other; in a room with a Consigliere every message is his, and steered;
 * - a T3 slash command goes to the member's thread exactly as typed, and is recorded as a note;
 * - `/note` is a room note: no request, and every seat's next briefing carries it;
 * - the user cancels or corrects a request, retries a failed run, and stops what a member runs in T3.
 *
 * Decision D2: nothing waits on other work. The parser refuses held or chained assignments, and the command has no field
 * that would carry them.
 * A message's T3 commands are sent before any of its requests is recorded, so a message T3 refuses leaves nothing that
 * sending it again would duplicate; with the client's message ID, sending it again replays it whole.
 * Which images came with a message is kept with the room's attachments (kv `engine.images:<room>:<message>`), and the
 * briefing source reads them by the request's event ID (`messageImages`).
 */
import { createHash, randomUUID } from "node:crypto";
import type { T3Adapter, TurnImage } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable, isRunActive } from "../adapter/types.ts";
import { ROOM_NOTE } from "../briefing/envelope.ts";
import type { Repos } from "../db/repos.ts";
import type { Assignment, RoomCommand } from "../domain/commands.ts";
import { RoomError, notFound } from "../domain/errors.ts";
import { ATTACHMENT_MAX_TOTAL_BYTES, type Participant, type Room } from "../domain/types.ts";
import { parseExplicit } from "../parser/explicit.ts";
import type { EngineHost } from "../runtime/index.ts";
import { STEER_REQUEST } from "../runtime/steer.ts";
import type { CommandResult, EngineHandler } from "./service.ts";

const USER = "$user";
/** §7: the message API refuses a post over 1 MiB. */
export const MAX_POST_BYTES = 1024 * 1024;

/** A request made from a user message: `msg:` or `steer:`, the message ID, the assignment's index, the recipient's seat. */
export function messageRequestId(delivery: Assignment["delivery"], messageId: string, index: number, seatId: string): string {
  return `${delivery === "steer" ? STEER_REQUEST : "msg:"}${messageId}:${index}:${seatId}`;
}

/** The user message a request came from, for showing its requests as one message; null for any other event. */
export function messageIdOf(eventId: string): string | null {
  return messageOf(eventId)?.messageId ?? null;
}

/** The user message a request came from, the assignment's index in it, and whether it was steered; null for any other event. */
export function messageOf(eventId: string): { messageId: string; index: number; steer: boolean } | null {
  const match = /^(msg|steer):([^:]+):(\d+):/.exec(eventId);
  return match ? { messageId: match[2]!, index: Number(match[3]), steer: match[1] === "steer" } : null;
}

const imagesKey = (roomId: string, messageId: string) => `engine.images:${roomId}:${messageId}`;

/** The attachment IDs of the images that came with a user message, in order (the read API shows them with its requests). */
export function messageAttachmentIds(repos: Repos, roomId: string, messageId: string): string[] {
  const stored = repos.getKv(imagesKey(roomId, messageId));
  return stored ? (JSON.parse(stored) as string[]) : [];
}

/** A UUID-shaped ID derived from a name: a message sent again under its client ID gives T3 the same IDs again. */
function derivedId(name: string): string {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function loadImages(repos: Repos, ids: readonly string[]): TurnImage[] {
  return ids.flatMap((id) => {
    const attachment = repos.getAttachment(id);
    const data = repos.getAttachmentData(id);
    if (!attachment || !data) return [];
    return [{ name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, dataUrl: `data:${attachment.mimeType};base64,${Buffer.from(data).toString("base64")}` }];
  });
}

/** The briefing source's images (src/runtime/render.ts): those of the user message a request event came from. */
export function messageImages(repos: Repos): (roomId: string, eventId: string) => TurnImage[] {
  return (roomId, eventId) => {
    const messageId = messageIdOf(eventId);
    return messageId ? loadImages(repos, messageAttachmentIds(repos, roomId, messageId)) : [];
  };
}

/** The handler bootstrap.ts gives the service when the engine runs. */
export function engineMessages(deps: { repos: Repos; host: EngineHost; adapter: T3Adapter }): EngineHandler {
  const messages = new EngineMessages(deps.repos, deps.host, deps.adapter);
  return (command) => messages.handle(command);
}

export class EngineMessages {
  private readonly repos: Repos;
  private readonly host: EngineHost;
  private readonly adapter: T3Adapter;

  constructor(repos: Repos, host: EngineHost, adapter: T3Adapter) {
    this.repos = repos;
    this.host = host;
    this.adapter = adapter;
  }

  /** The commands of the message path; null for any other, which the service handles. */
  handle(command: RoomCommand): Promise<CommandResult> | null {
    switch (command.type) {
      case "message.create":
        return this.create({ roomId: command.roomId, preamble: command.preamble ?? null, sourceText: command.sourceText, clientMessageId: command.clientMessageId ?? null, attachmentIds: command.attachmentIds, assignments: command.assignments });
      case "room.note.create":
        return this.note(command.roomId, command.text);
      case "request.cancel":
        return this.journal(async () => {
          const result = await this.host.cancel(this.room(command.roomId).id, { actor: USER, id: `cancel:${randomUUID()}`, requestId: command.requestId });
          return { type: "request.updated", requestId: command.requestId, applied: result.applied };
        });
      case "request.correct":
        return this.journal(async () => {
          this.size(command.text);
          this.host.correct(this.room(command.roomId).id, { actor: USER, id: `correct:${randomUUID()}`, requestId: command.requestId, body: command.text });
          return { type: "request.updated", requestId: command.requestId, applied: true };
        });
      case "run.retry":
        return this.journal(async () => {
          const receipt = this.host.retry(this.room(command.roomId).id, { actor: USER, id: `retry:${randomUUID()}`, runId: command.runId, body: command.text || "Try this again." });
          const event = receipt.events.find((e) => e.data.kind === "retry")!;
          return { type: "run.retried", runId: command.runId, eventId: event.id };
        });
      case "run.stop":
        return this.journal(async () => {
          const room = this.room(command.roomId);
          await this.host.stopSeat(room.id, this.seat(room, this.participant(room, command.participantId)).seatId);
          return { type: "run.stopped", participantId: command.participantId };
        });
      default:
        return null;
    }
  }

  /**
   * One user message: a request per recipient per assignment, or for a T3 slash command the command sent as typed and a
   * note. Everything is checked before anything is recorded or sent; the T3 commands go first, then the requests.
   */
  private async create(input: { roomId: string; preamble: string | null; sourceText: string | null; clientMessageId: string | null; attachmentIds: string[]; assignments: Assignment[] }): Promise<CommandResult> {
    const room = this.room(input.roomId);
    const participants = new Map(this.repos.listParticipants(room.id).map((p) => [p.id, p]));
    const consigliere = room.consigliereId ? participants.get(room.consigliereId) ?? null : null;
    for (const assignment of input.assignments) {
      for (const recipient of assignment.recipients) this.participant(room, recipient);
      const forHim = assignment.recipients.length === 1 && assignment.recipients[0] === consigliere?.id;
      if (consigliere && !assignment.slashCommand && !forHim) {
        throw new RoomError("consigliere_room", `In a room with a Consigliere every message is for him: name the members in your text and @${consigliere.alias} hands out the work.`);
      }
    }
    this.requireAttachments(room.id, input.attachmentIds);
    await this.requireSlashCommands(input.assignments, participants);
    // A client that sends no preamble (today's composer): the text before the first address, read the way the parser reads it.
    const preamble = input.preamble ?? (input.sourceText ? this.preambleOf(room, input.sourceText) : "");
    const plan = input.assignments.map((assignment, index) => {
      const text = assignment.instruction || "(See the attached image.)";
      const body = preamble && !assignment.slashCommand ? `${preamble}\n\n${text}` : text;
      this.size(body);
      return { assignment, index, body, seats: assignment.recipients.map((id) => ({ participant: participants.get(id)!, ...this.seat(room, participants.get(id)!) })) };
    });

    const messageId = input.clientMessageId ?? randomUUID();
    if (input.attachmentIds.length > 0) this.repos.setKv(imagesKey(room.id, messageId), JSON.stringify(input.attachmentIds));
    const noteIds: string[] = [];
    for (const { assignment, index, seats } of plan) {
      if (!assignment.slashCommand) continue;
      for (const seat of seats) noteIds.push(await this.slashCommand(room, seat.participant, seat, assignment.instruction, input.attachmentIds, `${messageId}:${index}:${seat.seatId}`));
    }
    const requestIds: string[] = [];
    for (const { assignment, index, body, seats } of plan) {
      if (assignment.slashCommand) continue;
      for (const seat of seats) {
        const id = messageRequestId(assignment.delivery, messageId, index, seat.seatId);
        await this.journal(async () => this.host.request(room.id, { actor: USER, id, to: seat.seatId, body }));
        requestIds.push(id);
      }
    }
    return { type: "requests.created", messageId, requestIds, noteIds };
  }

  private preambleOf(room: Room, sourceText: string): string {
    const participants = this.repos.listActiveParticipants(room.id).map((p) => ({ id: p.id, alias: p.alias }));
    const draft = parseExplicit(sourceText, participants, { consigliereId: room.consigliereId });
    return draft.kind === "task" ? draft.preamble : "";
  }

  /**
   * A T3 slash command: sent to the member's thread exactly as typed (a harness runs one only as the whole message),
   * with no briefing, then recorded as a note by the user. The note has the ID the host's import of that T3 message
   * takes (§3): whichever is written first records it and the other writes nothing, so a tick that imports the message
   * before the note is written is no failure. The command's reply comes back as the member's note when its turn ends.
   * Its T3 IDs derive from `key` (message, assignment, seat), so the message sent again under its client ID replays.
   */
  private async slashCommand(room: Room, participant: Participant, seat: { seatId: string; threadId: string }, instruction: string, attachmentIds: string[], key: string): Promise<string> {
    const messageId = derivedId(`${key}:message`);
    const shell = await this.adapter.getThreadShell(seat.threadId);
    const busy = shell !== null && (isRunActive(shell.status) || shell.activeRunId !== null);
    const images = loadImages(this.repos, attachmentIds);
    try {
      await this.adapter.sendMessage({ commandId: derivedId(`${key}:command`), threadId: seat.threadId, messageId, text: instruction, ...(images.length ? { images } : {}), mode: busy ? { type: "queue" } : { type: "start" } });
    } catch (error) {
      if (error instanceof T3Unavailable || error instanceof T3CommandRejected) {
        throw new RoomError("t3_refused", `T3 did not take ${instruction.split(/\s/)[0]} for @${participant.alias}: ${error.message}`, 502);
      }
      throw error;
    }
    const id = `t3msg:${seat.threadId}:${messageId}`;
    // Read and written in one synchronous step: no tick can land between the check and the write.
    await this.journal(async () => {
      if (this.host.view(room.id).events.some((e) => e.id === id)) return;
      this.host.note(room.id, { actor: USER, id, body: `To @${participant.alias} (T3 command, sent as typed): ${instruction}` });
    });
    return id;
  }

  /** `/note`: a room note by the user. No request, nobody woken; every seat's next briefing carries it. */
  private note(roomId: string, text: string): Promise<CommandResult> {
    return this.journal(async () => {
      this.size(text);
      const receipt = this.host.note(this.room(roomId).id, { actor: USER, id: `note:${randomUUID()}`, body: text, milestone: ROOM_NOTE });
      return { type: "note.created", eventId: receipt.events[0]!.id };
    });
  }

  // ---------------- checks ----------------

  private room(roomId: string): Room {
    const room = this.repos.getRoom(roomId);
    if (!room) throw notFound("room", roomId);
    return room;
  }

  private participant(room: Room, participantId: string): Participant {
    const participant = this.repos.getParticipant(participantId);
    if (!participant || participant.roomId !== room.id) throw new RoomError("unknown_participant", `member ${participantId} is not in this room`);
    if (participant.retiredAt) throw new RoomError("participant_retired", `@${participant.alias} was removed from the room`, 409);
    return participant;
  }

  /** A member's seat on the journal: its current binding, seated there (seat ID = binding ID). */
  private seat(room: Room, participant: Participant): { seatId: string; threadId: string } {
    const binding = this.repos.currentBinding(participant.id);
    const seat = binding ? this.host.view(room.id).seats.get(binding.id) : undefined;
    if (!binding || !seat || seat.status === "retired") throw new RoomError("not_seated", `@${participant.alias} has no seat on this room's board yet`, 409);
    return { seatId: seat.id, threadId: seat.threadId };
  }

  private size(body: string): void {
    if (Buffer.byteLength(body, "utf8") > MAX_POST_BYTES) throw new RoomError("post_too_large", "a post can be up to 1 MiB; put the rest in a file and point at it", 413);
  }

  private requireAttachments(roomId: string, ids: string[]): void {
    let total = 0;
    for (const id of ids) {
      const attachment = this.repos.getAttachment(id);
      if (!attachment || attachment.roomId !== roomId) throw new RoomError("unknown_attachment", `attachment ${id} is not in this room`);
      total += attachment.sizeBytes;
    }
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new RoomError("attachment_too_large", "images can total up to 80 MB per message", 413);
  }

  /** A slash command must be one the recipient's provider offers (T3 lists them per provider). */
  private async requireSlashCommands(assignments: Assignment[], participants: Map<string, Participant>): Promise<void> {
    const wanted = assignments.filter((a) => a.slashCommand);
    if (wanted.length === 0) return;
    const providers = await this.adapter.listProviders();
    for (const assignment of wanted) {
      const name = /^\/([^\s]+)/.exec(assignment.instruction)?.[1] ?? "";
      for (const recipient of assignment.recipients) {
        const participant = participants.get(recipient)!;
        const offered = providers.find((p) => p.instanceId === participant.modelSelection.instanceId)?.slashCommands ?? [];
        if (!offered.some((c) => c.name === name)) throw new RoomError("unknown_slash_command", `@${participant.alias}'s provider has no /${name} command`);
      }
    }
  }

  /** The host refuses with a reason (HostRefusal, or the engine's own rule): the user gets it as the command's error. */
  private async journal<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RoomError || !(error instanceof Error)) throw error;
      throw new RoomError("refused", error.message, 409);
    }
  }
}
