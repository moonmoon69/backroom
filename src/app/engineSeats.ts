/**
 * The seat lifecycle on the room's journal (stage 4/5 plan, item L4b). Seating a member gives it a journal seat
 * and, in a room with a Consigliere, the seat briefing; making or clearing the Consigliere designates him in the
 * journal; retiring a member retires its seat; a reseat asks the member for its checkpoint, then transfers its work to a
 * fresh seat in the same folder. The journal records each of these (seat.created, orchestrator.set, seat.retired,
 * transfer); rooms.sqlite keeps the members, their threads and the Consigliere's mark in step with it.
 *
 * A seat is a member's binding: its ID and its thread (src/runtime/bindings.ts). The page and the CLI send the room
 * commands they always have; the service hands those to this class (src/app/service.ts).
 *
 * What Backroom asks a member for itself wakes nobody with its one-line answer. Its briefings (the seat briefing, the
 * line naming a new Consigliere) are its own requests (`$system`): their failure goes to the Consigliere, not the user,
 * he may cancel them, and a member that leaves takes its open one with it (journals from before B1 hold them as the
 * user's, known by their IDs: backroomBriefing). The reseat's checkpoint and call-off are requests from the user. Request
 * IDs say what each is: `seat-briefing:`, `reseat:`, `moved:`, `takeover:`, `reseat-off:`.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3ThreadDetail, T3ThreadShell, ThreadLifecycleAction } from "../adapter/types.ts";
import { T3Unavailable } from "../adapter/types.ts";
import type { Repos } from "../db/repos.ts";
import { RoomError, notFound } from "../domain/errors.ts";
import type { Participant, Room, SessionBinding } from "../domain/types.ts";
import type { Activity, Projection } from "../engine/index.ts";
import { deliveredInputs, inputTree, unread } from "../engine/index.ts";
import { standingText } from "../briefing/assemble.ts";
import { MOVED, SEAT_BRIEFING, backroomBriefing } from "../runtime/bindings.ts";
import type { BriefingSource } from "../runtime/render.ts";
import type { EngineHost } from "../runtime/host.ts";
import { threadFree } from "../runtime/t3.ts";
import { RESEAT_CHECKPOINT, pendingActivities } from "../runtime/work.ts";
import { engineSeatInstruction, movedInstruction, retireThreadChoice } from "./consigliere.ts";
import { engineCheckpointInstruction, engineTakeoverInstruction, readEngineReseats, writeEngineReseats, type EngineReseat } from "./reseat.ts";
import type { CommandResult, EngineHandler } from "./service.ts";
import { backgroundTasks } from "./threadView.ts";

const TAKEOVER = "takeover:";
const RESEAT_OFF = "reseat-off:";

const now = (): string => new Date().toISOString();
/** A seat still on the board. Only a retired seat has left. */
const present = (p: Projection, seatId: string): boolean => p.seats.get(seatId)?.status === "active";
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface EngineSeatsDeps {
  repos: Repos;
  adapter: T3Adapter;
  host: EngineHost;
  /** The host's briefing source: `rooms-board rules` prints the standing sections the briefings give. */
  briefing: BriefingSource;
  notify(roomId: string): void;
  /** rooms.sqlite writes that belong together. */
  transaction<T>(fn: () => T): T;
  /** The service's seating of a fresh member where the old one worked, with IDs chosen ahead (RoomService.seatFresh). */
  seatFresh(room: Room, old: Participant, ids: EngineReseat["fresh"]): Promise<void>;
  /** The service's mirror of a thread's model, options and modes into its member; true when it changed. */
  mirror(participant: Participant, shell: T3ThreadShell): boolean;
  /** A member's thread title: "room · alias". */
  title(room: Room, participant: Participant): string;
  /**
   * The service's T3 thread action within its per-call limit (RoomService.threadActionWithin): done, failed, or timeout
   * when T3 has not confirmed it; a late outcome is logged under `what`.
   */
  threadAction(what: string, entry: { alias: string; threadId: string }, action: ThreadLifecycleAction): Promise<{ result: "done" | "failed" | "timeout"; detail?: string }>;
  log?(message: string, detail?: unknown): void;
}

type ThreadOutcome = { threadId: string; action: ThreadLifecycleAction | "keep"; result: "done" | "kept" | "failed" | "timeout"; detail?: string };

export class EngineSeats {
  private readonly deps: EngineSeatsDeps;
  private readonly repos: Repos;
  private readonly host: EngineHost;
  /** Thread titles already asked for, so T3 is not asked again while it catches up. */
  private readonly titlesAsked = new Map<string, string>();
  /** Reseats being advanced now, so two ticks never advance one at the same time. */
  private readonly advancing = new Set<string>();

  constructor(deps: EngineSeatsDeps) {
    this.deps = deps;
    this.repos = deps.repos;
    this.host = deps.host;
  }

  /** A member's journal seat: its current binding's ID. */
  seatIdOf(participantId: string): string | null {
    return this.repos.currentBinding(participantId)?.id ?? null;
  }

  /** `rooms-board rules`: the member's standing sections in full, as its first engine briefing gives them. */
  async standingText(participantId: string): Promise<string> {
    const participant = this.repos.getParticipant(participantId);
    const seatId = this.seatIdOf(participantId);
    if (!participant || !seatId) return "";
    return standingText(await this.deps.briefing.standing(participant.roomId, seatId));
  }

  /** The room's reseats in progress, for `rooms-board members`. */
  reseats(roomId: string): Array<{ participantId: string; seatId: string; requestId: string; stage: EngineReseat["stage"] }> {
    return readEngineReseats(this.repos, roomId).map((r) => ({ participantId: r.participantId, seatId: r.seatId, requestId: r.requestId, stage: r.stage }));
  }

  // ---------------- seating and the Consigliere ----------------

  /** After rooms.sqlite seated a member (the service's hook): its journal seat, and the seat briefing when asked for. */
  seated(room: Room, participant: Participant, binding: SessionBinding, options: { briefing: boolean }): void {
    // A reseat's fresh member: the transfer makes its seat, and the handover is its first briefing.
    if (this.reseatFor(room.id, participant.id, "fresh")) return;
    if (!this.view(room.id).seats.has(binding.id)) this.host.seat(room.id, { actor: "$user", id: `seat:${binding.id}`, seatId: binding.id, threadId: binding.threadId });
    if (options.briefing) this.brief(room.id, binding.id, `${SEAT_BRIEFING}${binding.id}:seated`, "seat");
  }

  /**
   * At start: every seated member has its journal seat, the Consigliere's mark and the journal's orchestrator agree, and
   * a reseat whose transfer is in the journal is finished. Only a crash between rooms.sqlite and the journal leaves them
   * apart. Seats made here get no seat briefing: their first briefing carries the standing facts.
   */
  reconcile(): void {
    for (const room of this.repos.listRooms()) {
      // One member at a time: a member the board cannot seat (say, on a thread a member who left had) holds up no other.
      for (const participant of this.repos.listActiveParticipants(room.id)) {
        const binding = this.repos.currentBinding(participant.id);
        if (!binding || this.reseatFor(room.id, participant.id, "fresh") || this.view(room.id).seats.has(binding.id)) continue;
        try {
          this.host.seat(room.id, { actor: "$user", id: `seat:${binding.id}`, seatId: binding.id, threadId: binding.threadId });
        } catch (error) {
          this.log("member not seated on the board", { roomId: room.id, participantId: participant.id, error: message(error) });
        }
      }
      try {
        for (const record of readEngineReseats(this.repos, room.id)) {
          if (this.view(room.id).events.some((e) => e.id === `transfer:${record.requestId}`)) this.handOver(room.id, record);
        }
        this.alignMark(room.id);
      } catch (error) {
        this.log("seats not reconciled", { roomId: room.id, error: message(error) });
      }
    }
  }

  /**
   * The journal is the record: once it has named an orchestrator (a seat made one, or designate), the Consigliere's mark
   * in rooms.sqlite follows it. A journal that never named one (members seated before the engine ran) takes the mark.
   */
  private alignMark(roomId: string): void {
    const p = this.view(roomId);
    const named = p.events.some((e) => e.data.kind === "orchestrator.set" || (e.data.kind === "seat.created" && e.data.orchestrator));
    const room = this.repos.getRoom(roomId)!;
    if (named) {
      const binding = p.orchestrator ? this.repos.getBinding(p.orchestrator) : null;
      const participant = binding && !binding.retiredAt ? this.repos.getParticipant(binding.participantId) : null;
      const mark = participant && !participant.retiredAt ? participant.id : null;
      if (room.consigliereId !== mark) this.repos.setRoomConsigliere(roomId, mark, now());
      return;
    }
    const mark = room.consigliereId ? this.seatIdOf(room.consigliereId) : null;
    if (mark !== null && present(p, mark)) this.host.designate(roomId, { id: `designate:${randomUUID()}`, seatId: mark });
  }

  /**
   * Make a member the Consigliere, move the mark, or clear it (room.consigliere.set, from the page). The journal's
   * orchestrator follows; a room's first Consigliere means every other member gets the seat briefing, a move tells
   * every member who he is now. Each is Backroom's request, so nobody is woken by the acknowledgements.
   */
  async designate(command: { roomId: string; participantId: string | null }): Promise<CommandResult> {
    const room = this.room(command.roomId);
    const p = this.view(room.id);
    if (command.participantId === null) {
      if (room.consigliereId === null && p.orchestrator === null) return { type: "room.updated", roomId: room.id };
      if (p.orchestrator !== null) this.host.designate(room.id, { id: `designate:${randomUUID()}`, seatId: null });
      this.repos.setRoomConsigliere(room.id, null, now());
      this.deps.notify(room.id);
      return { type: "room.updated", roomId: room.id };
    }
    const participant = this.member(command.participantId);
    if (participant.roomId !== room.id) throw new RoomError("unknown_participant", `member ${command.participantId} is not in this room`);
    const seatId = this.activeSeat(participant);
    if (room.consigliereId === participant.id && p.orchestrator === seatId) return { type: "room.updated", roomId: room.id };
    const previous = room.consigliereId ? this.repos.getParticipant(room.consigliereId) : null;
    const moved = previous !== null && !previous.retiredAt && previous.id !== participant.id;
    const id = randomUUID();
    if (p.orchestrator !== seatId) this.host.designate(room.id, { id: `designate:${id}`, seatId });
    this.repos.setRoomConsigliere(room.id, participant.id, now());
    for (const other of this.repos.listActiveParticipants(room.id)) {
      const otherSeat = other.id === participant.id ? null : this.seatIdOf(other.id);
      if (otherSeat) this.brief(room.id, otherSeat, `${moved ? MOVED : SEAT_BRIEFING}${otherSeat}:${id}`, moved ? "moved" : "seat");
    }
    this.deps.notify(room.id);
    return { type: "room.updated", roomId: room.id };
  }

  /**
   * Backroom's request to a member: the seat facts, or the line naming the new Consigliere. Once per ID. Its answer wakes
   * nobody, and a turn that fails on it is the Consigliere's notice, not the user's.
   */
  private brief(roomId: string, seatId: string, id: string, kind: "seat" | "moved"): void {
    const room = this.repos.getRoom(roomId);
    const consigliere = room?.consigliereId ? this.repos.getParticipant(room.consigliereId) : null;
    const p = this.view(roomId);
    if (!consigliere || consigliere.retiredAt || this.seatIdOf(consigliere.id) === seatId || p.requests.has(id) || !present(p, seatId)) return;
    const body = kind === "seat" ? engineSeatInstruction(consigliere) : movedInstruction(consigliere, this.repos.currentBinding(consigliere.id)?.threadId ?? null);
    this.host.request(roomId, { actor: "$system", id, to: seatId, body });
  }

  // ---------------- retire ----------------

  /**
   * A member leaves the room (participant.retire from the page, `rooms-board retire` from the Consigliere: `by`). Refused,
   * naming what is open, while its seat has a run (one being stopped too) or a turn in T3, owns an open request, has a
   * pending activity, or has an answer to its own question that has not reached it. Backroom's briefing it has not
   * answered (its thread failed on it, say) is nobody's work: it is cancelled in the same step. Then its seat is retired
   * in the journal, the member and its thread in rooms.sqlite (with the Consigliere's mark when it was his), and its T3
   * thread goes as the thread setting says.
   */
  async retire(input: { participantId: string; by?: string | null; thread: ThreadLifecycleAction | "keep" }): Promise<CommandResult> {
    const participant = this.member(input.participantId);
    const room = this.room(participant.roomId);
    const actor = this.manager(room, input.by ?? null, "retires members");
    if (this.reseatFor(room.id, participant.id, "either")) {
      throw new RoomError("reseat_pending", `@${participant.alias} is being reseated: it leaves the room when its fresh seat takes over.`, 409);
    }
    const binding = this.repos.currentBinding(participant.id);
    if (binding && present(this.view(room.id), binding.id)) {
      this.refuseOpen(room.id, binding.id, participant.alias, "retired", false);
      const shell = await this.shell(binding.threadId);
      if (shell && !threadFree(shell)) {
        throw new RoomError("participant_busy", `@${participant.alias} cannot be retired now: its T3 thread is in a turn (${shell.status}). Retire it once that turn has ended.`, 409);
      }
      // Read again after the await: work may have reached the seat meanwhile. The core checks the run and requests too.
      // An unread answer holds it only while T3 still lists its thread (neither archived nor deleted, as listThreads
      // filters): otherwise nothing will ever wake it.
      this.refuseOpen(room.id, binding.id, participant.alias, "retired", shell !== null && shell.archivedAt === null && shell.deletedAt === null);
      for (const q of this.view(room.id).requests.values()) {
        if (q.owner === binding.id && q.state === "open" && backroomBriefing(q)) this.host.withdraw(room.id, { actor, id: `retire-briefing:${q.id}`, requestId: q.id });
      }
      this.host.retire(room.id, { actor, id: `retire:${binding.id}`, seatId: binding.id, evidence: shell ? `lean: T3 thread ${binding.threadId} ${shell.status}` : `lean: T3 no longer lists thread ${binding.threadId}` });
    }
    this.deps.transaction(() => {
      if (binding) this.repos.updateBinding({ ...binding, retiredAt: now() });
      this.repos.updateParticipant({ ...participant, retiredAt: now(), updatedAt: now() });
      if (this.repos.getRoom(room.id)?.consigliereId === participant.id) this.repos.setRoomConsigliere(room.id, null, now());
    });
    const thread = binding ? await this.threadAction(participant, binding, input.thread) : undefined;
    this.deps.notify(room.id);
    return { type: "participant.updated", participantId: participant.id, ...(thread ? { thread } : {}) };
  }

  /** The room commands the engine takes from the page and the CLI, registered with service.useEngine (bootstrap.ts). */
  handler(): EngineHandler {
    return (command) => {
      switch (command.type) {
        case "participant.retire":
          return this.retire(command);
        case "participant.reseat":
          return this.reseat(command);
        case "room.consigliere.set":
          return this.designate(command);
        default:
          return null;
      }
    };
  }


  // ---------------- reseat ----------------

  /**
   * Ask a member for its checkpoint (participant.reseat, from `rooms-board reseat`; `by` is the Consigliere). Refused
   * while the member has a pending activity, which is named. The checkpoint is a request from the user, so its answer
   * wakes nobody; once it is answered and the seat is idle, `watch` hands the work to a fresh seat.
   */
  async reseat(command: { participantId: string; by: string; plan: string | null }): Promise<CommandResult> {
    const target = this.member(command.participantId);
    const by = this.member(command.by);
    if (by.roomId !== target.roomId) throw new RoomError("unknown_participant", `member ${command.by} is not in this room`);
    const room = this.room(target.roomId);
    this.manager(room, by.id, "reseats members");
    const binding = this.repos.currentBinding(target.id);
    if (!binding) throw new RoomError("no_binding", `@${target.alias} has no thread to write a checkpoint on`);
    const seatId = this.activeSeat(target);
    const list = readEngineReseats(this.repos, room.id);
    const already = list.find((r) => r.participantId === target.id || r.fresh.participantId === target.id);
    if (already) {
      const q = this.view(room.id).requests.get(already.requestId);
      throw new RoomError("reseat_pending", `@${target.alias} is being reseated already (checkpoint ${this.number(this.view(room.id), already.requestId)}: ${q?.state ?? "not posted yet"})`, 409);
    }
    const p = this.view(room.id);
    const activities = pendingActivities(p, seatId);
    if (activities.length > 0) {
      throw new RoomError("activity_pending", `@${target.alias} cannot be reseated now: ${activities.map((a) => this.describeActivity(p, a)).join("; ")}. Reseat it once that has ended, or cancel the request.`, 409);
    }
    const record: EngineReseat = {
      participantId: target.id,
      seatId,
      by: by.id,
      plan: command.plan?.trim() || null,
      requestId: `${RESEAT_CHECKPOINT}${randomUUID()}`,
      fresh: { participantId: randomUUID(), threadId: randomUUID(), commandId: randomUUID() },
      stage: "checkpoint",
      requestedAt: now(),
    };
    // The record first: a checkpoint request is never posted that nothing would advance.
    writeEngineReseats(this.repos, room.id, [...list, record]);
    this.postCheckpoint(room.id, record);
    this.deps.notify(room.id);
    return { type: "participant.reseating", participantId: target.id, eventId: record.requestId };
  }

  private postCheckpoint(roomId: string, record: EngineReseat): void {
    if (this.view(roomId).requests.has(record.requestId)) return;
    const room = this.room(roomId);
    const body = engineCheckpointInstruction({ consigliere: room.consigliereId === record.participantId, plan: record.plan, by: record.by === record.participantId ? null : this.repos.getParticipant(record.by)?.alias ?? null });
    this.host.request(roomId, { actor: "$user", id: record.requestId, to: record.seatId, body });
  }

  // ---------------- each tick, per seat (the host's watch) ----------------

  /**
   * What the seat lifecycle does for a member's thread each tick, beside the host: mirror the thread's model, options and
   * modes, keep its title "room · alias", and carry the member's reseat a step on. Called after the host's own work on
   * the seat, so a continuation's import is done.
   */
  async watch(at: { roomId: string; seatId: string; threadId: string }, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>): Promise<void> {
    const binding = this.repos.getBinding(at.seatId);
    const participant = binding && !binding.retiredAt ? this.repos.getParticipant(binding.participantId) : null;
    const room = this.repos.getRoom(at.roomId);
    if (!participant || participant.retiredAt || !room) return;
    if (this.deps.mirror(participant, shell)) this.deps.notify(room.id);
    await this.alignTitle(room, this.repos.getParticipant(participant.id) ?? participant, shell);
    const record = readEngineReseats(this.repos, room.id).find((r) => r.seatId === at.seatId);
    if (!record || this.advancing.has(record.requestId)) return;
    this.advancing.add(record.requestId);
    try {
      await this.advance(room.id, record, shell, detail);
    } catch (error) {
      this.log("reseat waits", { roomId: room.id, requestId: record.requestId, error: message(error) });
    } finally {
      this.advancing.delete(record.requestId);
    }
  }

  private async alignTitle(room: Room, participant: Participant, shell: T3ThreadShell): Promise<void> {
    const wanted = this.deps.title(room, participant);
    if (shell.title === wanted) {
      this.titlesAsked.delete(shell.id);
      return;
    }
    if (this.titlesAsked.get(shell.id) === wanted) return;
    this.titlesAsked.set(shell.id, wanted);
    try {
      await this.deps.adapter.setThreadTitle({ commandId: randomUUID(), threadId: shell.id, title: wanted });
    } catch (error) {
      this.log("thread title not set", message(error));
    }
  }

  /**
   * One reseat as far as it goes now. Checkpoint stage: wait for the answer and an idle seat, then make the fresh member
   * where the old one worked. Then the handover. A cancelled checkpoint, a member that left, a pending activity or a
   * fresh member T3 cannot make calls the reseat off.
   */
  private async advance(roomId: string, start: EngineReseat, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>): Promise<void> {
    let record = start;
    const old = this.repos.getParticipant(record.participantId);
    const p = this.view(roomId);
    if (!old || old.retiredAt || !present(p, record.seatId)) return this.callOff(roomId, record, "it left the room", false);
    if (record.stage === "checkpoint") {
      const q = p.requests.get(record.requestId);
      if (!q) return this.postCheckpoint(roomId, record);
      if (q.state === "cancelled") return this.callOff(roomId, record, `its checkpoint request ${this.number(p, q.id)} was cancelled`, false);
      if (q.state !== "answered" || !(await this.quiet(roomId, record, shell, detail))) return;
      if (!this.repos.getParticipant(record.fresh.participantId)) {
        try {
          await this.deps.seatFresh(this.room(roomId), old, record.fresh);
        } catch (error) {
          // T3 away: the next tick asks again for the same thread. Anything else calls the reseat off.
          if (error instanceof T3Unavailable || error instanceof RoomError && error.status === 503) return;
          return this.callOff(roomId, record, `the fresh seat could not be made: ${message(error)}`, true);
        }
      }
      record = { ...record, stage: "seated" };
      this.save(roomId, record);
      // Making the fresh thread took a while: read the old one again, so a turn T3 started there meanwhile ends first.
      const threadId = this.repos.getBinding(record.seatId)!.threadId;
      const again = await this.deps.adapter.getThreadShell(threadId);
      if (!again || !(await this.quiet(roomId, record, again, () => this.deps.adapter.getThreadDetail(threadId)))) return;
    } else if (!(await this.quiet(roomId, record, shell, detail))) return;
    this.handOver(roomId, record);
  }

  /** The seat can be handed over: no run, its T3 thread idle with nothing in the background, no pending activity. */
  private async quiet(roomId: string, record: EngineReseat, shell: T3ThreadShell, detail: () => Promise<T3ThreadDetail | null>): Promise<boolean> {
    if (this.view(roomId).seats.get(record.seatId)?.activeRunId || !threadFree(shell)) return false;
    const thread = await detail();
    if (!thread || backgroundTasks(thread).length > 0) return false;
    const p = this.view(roomId);
    if (p.seats.get(record.seatId)?.activeRunId) return false;
    const activities = pendingActivities(p, record.seatId);
    if (activities.length > 0) {
      this.callOff(roomId, record, activities.map((a) => this.describeActivity(p, a)).join("; "), true);
      return false;
    }
    return true;
  }

  /**
   * The handover, synchronous from the transfer to the takeover request, so the fresh seat's first run carries both:
   * the old seat's open requests, return routes and unread posts move in one transfer event (with the checkpoint in
   * full); the Consigliere asks the fresh seat to take over, so he is woken once, when its first turn ends (not when he
   * reseated himself). Then rooms.sqlite follows: the old member leaves, the Consigliere's mark moves with him, the
   * members are told of a new Consigliere, and the old thread goes as the thread setting says. Safe to run again.
   */
  private handOver(roomId: string, record: EngineReseat): void {
    const room = this.room(roomId);
    const old = this.repos.getParticipant(record.participantId)!;
    const fresh = this.repos.getParticipant(record.fresh.participantId);
    const freshBinding = fresh ? this.repos.currentBinding(fresh.id) : null;
    let p = this.view(roomId);
    const transferId = `transfer:${record.requestId}`;
    const transferred = p.events.some((e) => e.id === transferId);
    if (!fresh || !freshBinding) {
      if (!transferred) this.callOff(roomId, record, "the fresh seat is gone", true);
      return;
    }
    const consigliere = room.consigliereId === old.id || p.orchestrator === record.seatId;
    const asker = this.seatIdOf(record.by);
    if (!transferred) {
      const answer = p.requests.get(record.requestId)?.answerId ?? null;
      const event = answer ? p.events.find((e) => e.id === answer) : undefined;
      const checkpoint = event?.data.kind === "output" ? event.data.body : "(the checkpoint was not found on the board)";
      const actor = p.orchestrator !== null && p.seats.get(p.orchestrator)?.status === "active" ? p.orchestrator : "$user";
      this.host.transfer(roomId, {
        actor,
        id: transferId,
        oldSeatId: record.seatId,
        newSeatId: freshBinding.id,
        threadId: freshBinding.threadId,
        body: engineTakeoverInstruction({ from: old.alias, consigliere, plan: record.plan, checkpointNumber: event?.seq ?? null, checkpoint, alsoRead: this.checkpointCompanions(p, record) }),
        evidence: `lean: checkpoint ${this.number(p, record.requestId)} answered; T3 thread of @${old.alias} idle with no background work`,
      });
      p = this.view(roomId);
    }
    const takeoverId = `${TAKEOVER}${record.requestId}`;
    if (asker && asker !== record.seatId && p.seats.get(asker)?.status === "active" && !p.requests.has(takeoverId)) {
      const handed = p.events.find((e) => e.id === transferId)?.data;
      const numbers = handed?.kind === "transfer" ? handed.owned.map((id) => this.number(p, id)) : [];
      this.host.request(roomId, {
        actor: asker,
        id: takeoverId,
        to: freshBinding.id,
        body: [
          `@${fresh.alias} you take over from @${old.alias}: its open requests, its checkpoint and the posts it had not read are in the handover.${record.plan ? ` Carry on with: ${record.plan}` : ""}`,
          `Your final reply answers ${numbers.length ? `the requests handed to you (${numbers.join(", ")}) and this one` : "this request"}.`,
        ].join(" "),
      });
    }
    const thread = this.deps.transaction(() => {
      const binding = this.repos.currentBinding(old.id);
      if (binding) this.repos.updateBinding({ ...binding, retiredAt: now() });
      if (!old.retiredAt) this.repos.updateParticipant({ ...old, retiredAt: now(), updatedAt: now() });
      if (this.repos.getRoom(roomId)?.consigliereId === old.id) this.repos.setRoomConsigliere(roomId, fresh.id, now());
      this.save(roomId, { ...record, stage: "seated" }, true);
      return binding;
    });
    if (consigliere) {
      for (const other of this.repos.listActiveParticipants(roomId)) {
        const otherSeat = other.id === fresh.id ? null : this.seatIdOf(other.id);
        if (otherSeat) this.brief(roomId, otherSeat, `${MOVED}${otherSeat}:${record.requestId}`, "moved");
      }
    }
    if (thread) void this.threadAction(old, thread, retireThreadChoice(this.repos)).then((outcome) => {
      if (outcome.result === "failed") this.log("old thread not handled after a reseat", outcome);
    });
    this.deps.notify(roomId);
  }

  /** The reseat ends without a handover: the record goes, and the asker is told (woken only when it needs to act). */
  private callOff(roomId: string, record: EngineReseat, reason: string, wake: boolean): void {
    this.save(roomId, record, true);
    const p = this.view(roomId);
    const id = `${RESEAT_OFF}${record.requestId}`;
    if (p.events.some((e) => e.id === id)) return;
    const alias = this.repos.getParticipant(record.participantId)?.alias ?? record.participantId;
    const text = `Reseat of @${alias} called off: ${reason}. Nothing was handed over: @${alias} keeps its seat and its work.`;
    const asker = this.seatIdOf(record.by);
    if (wake && asker && asker !== record.seatId && present(p, asker)) this.host.request(roomId, { actor: "$user", id, to: asker, body: text });
    else this.host.note(roomId, { actor: "$user", id, body: text, ...(p.requests.has(record.requestId) ? { requestIds: [record.requestId] } : {}) });
    this.deps.notify(roomId);
  }

  /**
   * The service's check before it writes a member that attaches an existing T3 thread: the board never seats one thread
   * twice, so a thread a member of this room's board had (one who left, or was reseated) is refused here, before
   * anything is written.
   */
  refuseSeatedThread(roomId: string, threadId: string): void {
    const seat = [...this.view(roomId).seats.values()].find((s) => s.threadId === threadId);
    if (!seat) return;
    const owner = this.repos.getBinding(seat.id);
    const alias = owner ? this.repos.getParticipant(owner.participantId)?.alias ?? null : null;
    throw new RoomError("thread_seated_before", `T3 thread ${threadId} was ${alias ? `@${alias}'s` : "a member's"} on this room's board, and the board never seats a thread twice: seat the member on a new thread.`, 409);
  }

  /**
   * What the checkpoint turn brought besides the checkpoint: the old seat read it there but did not act on it, and it is
   * not unread, so the transfer does not carry it. The handover names each by number, to read with `rooms-board read`.
   */
  private checkpointCompanions(p: Projection, record: EngineReseat): string[] {
    const runs = [...p.runs.values()].filter((r) => r.seatId === record.seatId && inputTree(deliveredInputs(p, r.id)).some((i) => i.eventId === record.requestId));
    const seen = new Set<string>([record.requestId]);
    const lines: string[] = [];
    for (const input of runs.flatMap((r) => inputTree(deliveredInputs(p, r.id)))) {
      // A keep-alive (H6) asks nothing, so there is nothing in it to hand over.
      if (seen.has(input.eventId) || input.intent === "keep-alive") continue;
      seen.add(input.eventId);
      const event = p.events.find((e) => e.id === input.eventId);
      const author = event && "author" in event.data ? this.nameOf(event.data.author) : "someone";
      const about = input.requestIds.filter((id) => id !== input.eventId).map((id) => this.number(p, id)).join(", ");
      const what = {
        request: p.requests.get(input.eventId)?.state === "open" ? `a request from ${author}, handed over to you` : `a request from ${author}`,
        correction: `a correction of ${about} from ${author}`,
        result: `${author}'s answer to ${about}`,
        progress: `progress from ${author} on ${about}`,
        error: `an error notice about ${about}`,
        attention: `a notice about ${about}`,
        cancel: `the cancel of ${about}`,
        retry: `a retry of ${about}`,
        transfer: `a handover from ${author}`,
      }[input.intent];
      lines.push(`#${input.seq}: ${what}`);
    }
    return lines;
  }

  private nameOf(principal: string): string {
    if (principal === "$user") return "the user";
    const binding = this.repos.getBinding(principal);
    const alias = binding ? this.repos.getParticipant(binding.participantId)?.alias : null;
    return alias ? `@${alias}` : principal;
  }

  // ---------------- helpers ----------------

  /** Who may do this: the user (no `by`), or the room's Consigliere; the journal actor for it. */
  private manager(room: Room, by: string | null, what: string): string {
    if (by === null) return "$user";
    const consigliere = room.consigliereId ? this.repos.getParticipant(room.consigliereId) : null;
    if (!consigliere || consigliere.retiredAt || consigliere.id !== by) {
      throw new RoomError("not_consigliere", `Only this room's Consigliere${consigliere && !consigliere.retiredAt ? ` (@${consigliere.alias})` : ""} ${what}.`, 403);
    }
    return this.activeSeat(consigliere);
  }

  /**
   * Refuse with every piece of open work the seat has, named: its run, its open
   * requests, its pending activities, and (with `answers`) answers to what it asked that have not reached it. Other posts
   * it has not read (notices, cancels) do not hold it; they stay on the board.
   */
  private refuseOpen(roomId: string, seatId: string, alias: string, verb: string, answers: boolean): void {
    const p = this.view(roomId);
    const seat = p.seats.get(seatId)!;
    const reasons: string[] = [];
    if (seat.activeRunId) reasons.push(`it is in a turn (its run is ${p.runs.get(seat.activeRunId)?.phase ?? "open"})`);
    // Backroom's briefing is nobody's work: retire cancels it.
    const owned = [...p.requests.values()].filter((r) => r.owner === seatId && r.state === "open" && !backroomBriefing(r));
    if (owned.length > 0) reasons.push(`it owns open request${owned.length > 1 ? "s" : ""} ${owned.map((r) => this.number(p, r.id)).join(", ")}: answer or cancel ${owned.length > 1 ? "them" : "it"} first`);
    for (const a of pendingActivities(p, seatId)) reasons.push(this.describeActivity(p, a));
    // An answer to a question it asked that has not reached it yet would be lost on it: it is about to be woken.
    const unreadAnswers = answers ? unread(p, seatId).filter((i) => i.intent === "result") : [];
    if (unreadAnswers.length > 0) reasons.push(`the answer${unreadAnswers.length > 1 ? "s" : ""} ${unreadAnswers.map((i) => `#${i.seq}`).join(", ")} to what it asked ${unreadAnswers.length > 1 ? "have" : "has"} not reached it yet (it is about to be woken)`);
    if (reasons.length > 0) throw new RoomError("open_work", `@${alias} cannot be ${verb} now: ${reasons.join("; ")}.`, 409);
  }

  private describeActivity(p: Projection, a: Activity): string {
    const ids = a.requestIds.map((id) => this.number(p, id)).join(", ");
    return a.id.startsWith("work:")
      ? `it said it is still working on ${ids} (activity ${a.id}; it ends when it answers, or when the request is cancelled)`
      : `background work it started on ${ids} is still running (activity ${a.id})`;
  }

  /** A request or post as the board numbers it. */
  private number(p: Projection, eventId: string): string {
    const seq = p.events.find((e) => e.id === eventId)?.seq;
    return seq === undefined ? eventId : `#${seq}`;
  }

  /** A reseat this member is part of: the one being reseated, the fresh one, or either. */
  private reseatFor(roomId: string, participantId: string, as: "old" | "fresh" | "either"): EngineReseat | null {
    return readEngineReseats(this.repos, roomId).find((r) => (as !== "fresh" && r.participantId === participantId) || (as !== "old" && r.fresh.participantId === participantId)) ?? null;
  }

  private save(roomId: string, record: EngineReseat, remove = false): void {
    const others = readEngineReseats(this.repos, roomId).filter((r) => r.requestId !== record.requestId);
    writeEngineReseats(this.repos, roomId, remove ? others : [...others, record]);
  }

  /** A retired member's T3 thread: kept, or settled, archived or deleted as chosen; a thread also seated in another room is kept. */
  private async threadAction(participant: Participant, binding: SessionBinding, action: ThreadLifecycleAction | "keep"): Promise<ThreadOutcome> {
    if (action === "keep") return { threadId: binding.threadId, action, result: "kept" };
    const elsewhere = this.repos.listActiveBindings().some((b) => b.threadId === binding.threadId && b.participantId !== participant.id && this.repos.getParticipant(b.participantId)?.roomId !== participant.roomId);
    if (elsewhere) return { threadId: binding.threadId, action, result: "kept", detail: "also used in another room" };
    // Within the same per-call limit as room deletion: T3 answering late, or not at all, holds nobody up.
    const room = this.repos.getRoom(participant.roomId);
    const { result, detail } = await this.deps.threadAction(`@${participant.alias} left room "${room?.title ?? participant.roomId}"`, { alias: participant.alias, threadId: binding.threadId }, action);
    return { threadId: binding.threadId, action, result, ...(detail !== undefined ? { detail } : {}) };
  }

  private async shell(threadId: string): Promise<T3ThreadShell | null> {
    try {
      return await this.deps.adapter.getThreadShell(threadId);
    } catch (error) {
      if (error instanceof T3Unavailable) throw new RoomError("t3_unavailable", error.message, 503);
      throw error;
    }
  }

  private activeSeat(participant: Participant): string {
    const seatId = this.seatIdOf(participant.id);
    const seat = seatId ? this.view(participant.roomId).seats.get(seatId) : undefined;
    if (!seatId || !seat || seat.status === "retired") throw new RoomError("no_seat", `@${participant.alias} has no seat on the board`, 409);
    return seatId;
  }

  private member(participantId: string): Participant {
    const participant = this.repos.getParticipant(participantId);
    if (!participant) throw notFound("participant", participantId);
    if (participant.retiredAt) throw new RoomError("participant_retired", `@${participant.alias} was removed from the room`, 409);
    return participant;
  }

  private room(roomId: string): Room {
    const room = this.repos.getRoom(roomId);
    if (!room) throw notFound("room", roomId);
    return room;
  }

  private view(roomId: string): Projection {
    return this.host.view(roomId);
  }

  private log(text: string, detail?: unknown): void {
    this.deps.log?.(text, detail);
  }
}
