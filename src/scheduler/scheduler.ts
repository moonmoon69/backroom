/**
 * Durable queue driver. One tick:
 *   1. observe   — read thread shells for every active binding; follow each room run's T3 run; ingest results.
 *   2. dispatch  — release queued tasks whose prerequisites all succeeded and whose assignee is free.
 * Runs are persisted before submission and resent with the same T3 commandId when the acknowledgement was lost
 * (T3 keeps a receipt per command, so a resend never starts a second run).
 *
 * A room run is one user message sent to T3. T3 (Orchestrator V2) names that message on the run it starts, or names
 * the run on the message when it was steered into one, so the room finds its run by the message id it chose and
 * reads the outcome from the run's status.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3RuntimeRequest, T3ThreadDetail, T3ThreadShell, TurnImage } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable, backgroundOf, isRunActive, openRequests, runForMessage, runPrompt, runReplies } from "../adapter/types.ts";
import { assembleBriefing, changedStanding, heldStanding, standingFingerprint, standingText, type PrerequisiteResult, type StandingInput, type StandingKey } from "../briefing/assemble.ts";
import type { BrowserBriefing } from "../browser/roomBrowsers.ts";
import type { BrowsersBriefing } from "../briefing/assemble.ts";
import { agentKey, browsersForRoom } from "../browser/catalog.ts";
import type { Database } from "../db/database.ts";
import type { Repos } from "../db/repos.ts";
import type { Participant, ParticipantStatus, Room, RoomEvent, Run, SessionBinding, Task } from "../domain/types.ts";
import { taskLabel } from "../domain/types.ts";
import { roomWorkspaces, workspaceArtifact, type Workspace } from "../git/workspaces.ts";
import { now, threadTitleFor, type RoomService } from "../app/service.ts";
import { CONSIGLIERE_RULES_KEY } from "../app/consigliere.ts";
import { readRoomState } from "../app/roomState.ts";
import { requestPayload } from "../app/threadView.ts";

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["pending", "dispatched", "accepted", "running", "needs_input"]);
/** How long an accepted command may sit without T3 recording its message before the run is failed visibly. */
const ACCEPT_WITHOUT_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** kv key: when this service first recorded members' messages (see the constructor). */
const BOARD_SINCE_KEY = "board.memberMessagesSince";

const BRIEFING_EVENT_KINDS = new Set<RoomEvent["kind"]>(["user.message", "note", "assistant.reply"]);

/**
 * What a thread has of the standing sections: the run that last carried them all and when it was prepared (a compaction
 * after that may have dropped them), and each section as the thread last had it. In kv under the room and the binding;
 * no record means the next delivery carries them all.
 */
interface StandingRecord {
  runId: string;
  at: string;
  sections: Partial<Record<StandingKey, string | null>>;
}

/** kv key of a binding's standing record. */
export const standingRecordKey = (roomId: string, bindingId: string): string => `briefing.standing:${roomId}:${bindingId}`;

/** A slash task that compacts the thread: the next delivery carries the standing sections again. */
const COMPACT_COMMAND = /^\/compact\b/i;

/** A follow-up that holds a wake no longer: it ended, or it is blocked and the poster has to decide about it. */
const FOLLOW_UP_ENDED = new Set<Task["state"]>(["succeeded", "failed", "interrupted", "cancelled", "blocked"]);

export interface SchedulerOptions {
  briefingBudgetChars: number;
  /** Browsers: the room's default is started for its tasks, and all the room may use are listed in their briefings. */
  browsers?: {
    briefingFor(browser: { id: string; name: string; description: string }): Promise<BrowserBriefing | null>;
    status?(browserId: string): { state: string };
  };
  /** How agents run rooms-browser (absolute path to bin/rooms-browser, with any environment it needs). */
  browserCommand?: string;
  /** How agents run rooms-board, the same way. */
  boardCommand?: string;
  log?: (message: string, detail?: unknown) => void;
}

export class Scheduler {
  private ticking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly statuses = new Map<string, ParticipantStatus>();
  /** Last latest-run state seen per binding, so direct runs are imported only when a run finishes. */
  private readonly seenLatestRun = new Map<string, string>();
  /** Each binding's newest user message as last scanned, so members' messages are read when one arrives. */
  private readonly seenUserMessage = new Map<string, string>();
  /** Each participant's active T3 run as last observed: what a steered message is sent into. */
  private readonly activeT3Runs = new Map<string, string | null>();
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly boardSince: string;
  /** Last error from T3 connectivity, surfaced to the UI, and when it happened; cleared by the next good tick. */
  lastAdapterError: string | null = null;
  lastAdapterErrorAt: string | null = null;

  private readonly db: Database;
  private readonly repos: Repos;
  private readonly adapter: T3Adapter;
  private readonly service: RoomService;
  private readonly options: SchedulerOptions;
  private readonly notify: (roomId: string) => void;

  constructor(
    db: Database,
    repos: Repos,
    adapter: T3Adapter,
    service: RoomService,
    options: SchedulerOptions,
    notify: (roomId: string) => void = () => {},
  ) {
    this.db = db;
    this.repos = repos;
    this.adapter = adapter;
    this.service = service;
    this.options = options;
    this.notify = notify;
    this.log = options.log ?? (() => {});
    // Members' messages are recorded from the first start that could record them: older ones stay in T3 only, so a
    // board does not open with months of old messages appended as new posts.
    const since = repos.getKv(BOARD_SINCE_KEY);
    this.boardSince = since ?? now();
    if (!since) repos.setKv(BOARD_SINCE_KEY, this.boardSince);
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  participantStatus(participantId: string): ParticipantStatus {
    return (
      this.statuses.get(participantId) ?? {
        status: "unknown",
        threadMissing: false,
        externalActivity: false,
        pendingApprovals: false,
        pendingUserInput: false,
        activeRunId: null,
        background: null,
      }
    );
  }

  private noteAdapterError(message: string | null): void {
    if (message === null) {
      this.lastAdapterError = null;
      this.lastAdapterErrorAt = null;
    } else {
      this.lastAdapterError = message;
      this.lastAdapterErrorAt = now();
    }
  }

  /** Serialized tick; concurrent calls await the in-flight one. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const touched = new Set<string>();
    try {
      await this.observe(touched);
      // A checkpoint that just landed seats its fresh member before dispatch, so its first task goes out now.
      await this.service.advanceReseats(touched);
      await this.dispatch(touched);
      this.noteAdapterError(null);
    } catch (error) {
      if (error instanceof T3Unavailable) {
        this.noteAdapterError(error.message);
        this.log("t3 unavailable", error.message);
      } else {
        this.noteAdapterError((error as Error).message);
        this.log("tick failed", error);
      }
    } finally {
      for (const roomId of touched) this.notify(roomId);
    }
  }

  // ---------------- observation ----------------

  private async observe(touched: Set<string>): Promise<void> {
    const bindings = this.repos.listActiveBindings();
    if (bindings.length === 0) return;
    const shells = new Map<string, T3ThreadShell>();
    for (const shell of await this.adapter.listThreads()) shells.set(shell.id, shell);
    // Several room runs can be active on one thread when messages were steered into its running run.
    const activeRuns = new Map<string, Run[]>();
    for (const run of this.repos.listRunsByStatus([...ACTIVE_RUN_STATUSES])) activeRuns.set(run.bindingId, [...(activeRuns.get(run.bindingId) ?? []), run]);

    // Who each thread is, to name the sender of a message one member's agent sent another.
    const members = new Map<string, { participant: Participant; binding: SessionBinding }>();
    for (const binding of bindings) {
      const participant = this.repos.getParticipant(binding.participantId);
      if (participant && !participant.retiredAt) members.set(`${participant.roomId}:${binding.threadId}`, { participant, binding });
    }
    const senderOf = (roomId: string, threadId: string): RoomEvent["speaker"] => {
      const member = members.get(`${roomId}:${threadId}`);
      if (member) return { type: "participant", participantId: member.participant.id, bindingId: member.binding.id };
      return { type: "outside", threadId, title: shells.get(threadId)?.title ?? "a thread outside the room" };
    };

    for (const binding of bindings) {
      const participant = this.repos.getParticipant(binding.participantId);
      if (!participant) continue;
      const shell = shells.get(binding.threadId) ?? null;
      const runs = activeRuns.get(binding.id) ?? [];
      const run = runs[0] ?? null;
      if (!shell) {
        // T3 answered but does not list this thread any more (deleted or archived there). Surface it and stop any in-flight run.
        this.statuses.set(participant.id, { status: "unknown", threadMissing: true, externalActivity: false, pendingApprovals: false, pendingUserInput: false, activeRunId: run?.id ?? null, background: null });
        this.activeT3Runs.delete(participant.id);
        for (const run of runs.filter((r) => r.status !== "pending")) {
          const task = this.repos.getTask(run.taskId);
          if (task) {
            const reason = `T3 thread for @${participant.alias} no longer exists`;
            this.db.transaction(() => {
              this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: reason, updatedAt: now() });
              this.service.setTaskState(task, "failed", reason, { currentRunId: run.id });
              this.service.statusEvent(task, `${taskLabel(task)} failed: ${reason}`, run.id);
              this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} failed: ${reason}`);
            });
            touched.add(participant.roomId);
          }
        }
        continue;
      }
      // The room follows the thread: mirror model/options/permission changes made in T3.
      if (this.service.syncParticipantFromThread(participant, shell)) touched.add(participant.roomId);
      // The thread follows the room's name: "room · alias", after a room rename, a member rename, or a title T3
      // generated for it. Once per tick at most, never twice for the same title.
      await this.alignThreadTitle(participant, shell);
      const ours = new Set(runs.map((r) => r.t3RunId).filter((id): id is string => id !== null));
      const activeT3Run = isRunActive(shell.status) ? shell.activeRunId : null;
      this.activeT3Runs.set(participant.id, activeT3Run);
      // Busy in T3: its active run is not one the room sent, and no room message is still waiting to be matched to its run.
      const externalActivity = activeT3Run !== null && !ours.has(activeT3Run) && !runs.some((r) => r.t3RunId === null);
      this.statuses.set(participant.id, {
        status: shell.status,
        threadMissing: false,
        externalActivity,
        pendingApprovals: shell.pendingRequest !== null && shell.pendingRequest.kind !== "user_input",
        pendingUserInput: shell.pendingRequest?.kind === "user_input",
        activeRunId: run?.id ?? null,
        background: backgroundOf(shell),
      });

      let detail: T3ThreadDetail | null = null;
      const loadDetail = async (): Promise<T3ThreadDetail | null> => {
        if (detail === null) detail = await this.adapter.getThreadDetail(binding.threadId, { bounded: true });
        return detail;
      };

      if (shell.pendingRequest) {
        const loaded = await loadDetail();
        if (loaded) {
          // The projection says what is asked, and whether a question still holds a run (see openRequests).
          const open = openRequests(loaded);
          const status = this.statuses.get(participant.id);
          if (status) this.statuses.set(participant.id, { ...status, pendingApprovals: open.some((r) => r.type === "approval"), pendingUserInput: open.some((r) => r.type === "user-input") });
          if (this.syncNativeRequests(participant, binding, open)) touched.add(participant.roomId);
        }
      } else if (this.repos.listOpenNativeRequests([participant.id]).length > 0) {
        this.db.transaction(() => {
          for (const request of this.repos.listOpenNativeRequests([participant.id])) this.repos.resolveNativeRequest(request.threadId, request.requestId);
        });
        touched.add(participant.roomId);
      }

      for (const active of runs.filter((r) => r.status !== "pending")) {
        const changed = await this.observeRun(active, participant, binding, shell, loadDetail);
        if (changed) touched.add(participant.roomId);
      }

      // Messages other agents sent this thread with T3's tools go on the board as they arrive: read the thread when
      // it has a new user message, and whenever it was read for another reason.
      const seenKey = `${shell.latestRunId ?? ""}:${shell.status}`;
      const runChanged = shell.latestRunId !== null && this.seenLatestRun.get(binding.id) !== seenKey;
      const messageKey = shell.latestUserMessageAt ?? "";
      const read = runChanged || this.seenUserMessage.get(binding.id) !== messageKey ? await loadDetail() : (detail as T3ThreadDetail | null);
      if (read) {
        if (this.importMemberMessages(participant, binding, read, senderOf)) touched.add(participant.roomId);
        this.seenUserMessage.set(binding.id, messageKey);
      }

      // Mirror runs started directly in T3 (or by an agent) into the timeline once they finish (display only).
      if (runChanged) {
        const loaded = await loadDetail();
        if (loaded && this.importDirectRuns(participant, binding, loaded)) touched.add(participant.roomId);
        this.seenLatestRun.set(binding.id, seenKey);
      }
      // This is the bounded detail (T3's recent window). A compaction early in a long run the room did not start (a turn
      // typed in T3, a member carrying on by itself) can fall outside it and go unnoticed: only a room run's end reads
      // the whole thread. The thread can still recover: every lean briefing's header names `rooms-board rules`.
      const seen = detail as T3ThreadDetail | null;
      if (seen) this.noteCompactions(participant.roomId, binding, seen);
    }
  }

  // ---------------- standing sections ----------------

  private readStanding(roomId: string, bindingId: string): StandingRecord | null {
    const raw = this.repos.getKv(standingRecordKey(roomId, bindingId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StandingRecord;
    } catch {
      return null;
    }
  }

  /** The thread may not have the standing sections any more: its next delivery carries them all. */
  private forgetStanding(roomId: string, bindingId: string): void {
    this.repos.deleteKv(standingRecordKey(roomId, bindingId));
  }

  /** A run that carried all the standing sections never reached the agent: the next delivery carries them again. */
  private forgetStandingOf(run: Run, roomId: string): void {
    if (this.readStanding(roomId, run.bindingId)?.runId === run.id) this.forgetStanding(roomId, run.bindingId);
  }

  /** The thread was rolled back past the run that carried the standing sections (T3 no longer has it): it lost them. */
  private forgetStandingIfRolledBack(roomId: string, bindingId: string, detail: T3ThreadDetail): void {
    const record = this.readStanding(roomId, bindingId);
    if (!record) return;
    const carrier = this.repos.getRun(record.runId);
    if (!carrier?.t3RunId || !detail.runs.some((t3Run) => t3Run.id === carrier.t3RunId)) this.forgetStanding(roomId, bindingId);
  }

  /**
   * The harness compacted the thread after it was last given the standing sections (T3 records each compaction, Claude
   * Code's automatic ones and /compact alike, as a turn item): the summary may have dropped them, so they go out again.
   */
  private noteCompactions(roomId: string, binding: SessionBinding, detail: T3ThreadDetail): void {
    const record = this.readStanding(roomId, binding.id);
    if (!record) return;
    const compacted = detail.turnItems.some((item) => item.type === "compaction" && item.status === "completed" && (item.completedAt ?? item.updatedAt) > record.at);
    if (compacted) this.forgetStanding(roomId, binding.id);
  }

  /** What the standing sections are made of for this participant now. Reads T3 and starts the room's default browser. */
  private async standingInput(room: Room, participant: Participant): Promise<StandingInput> {
    return {
      room,
      participant,
      participantsById: new Map(this.repos.listParticipants(room.id).map((p) => [p.id, p])),
      browsers: room.browserEnabled ? await this.browsersBriefing(room, participant) : null,
      workspaces: await this.workspaces(room.id),
      board: { command: this.options.boardCommand ?? "rooms-board", as: agentKey(participant.alias, room.id) },
      consigliereRules: this.repos.getKv(CONSIGLIERE_RULES_KEY),
      roomState: readRoomState(this.repos, room.id),
    };
  }

  /** The standing sections in full, as a thread's first briefing gives them: what `rooms-board rules` prints. */
  async standingText(participantId: string): Promise<string> {
    const participant = this.repos.getParticipant(participantId);
    const room = participant ? this.repos.getRoom(participant.roomId) : null;
    if (!participant || !room) return "";
    return standingText(await this.standingInput(room, participant));
  }

  /** Thread titles already asked for this tick cycle, so T3 is not asked again while it catches up. */
  private readonly titlesAsked = new Map<string, string>();

  private async alignThreadTitle(participant: Participant, shell: T3ThreadShell): Promise<void> {
    const room = this.repos.getRoom(participant.roomId);
    if (!room) return;
    const wanted = threadTitleFor(room, participant);
    if (shell.title === wanted) {
      this.titlesAsked.delete(shell.id);
      return;
    }
    if (this.titlesAsked.get(shell.id) === wanted) return;
    this.titlesAsked.set(shell.id, wanted);
    try {
      await this.adapter.setThreadTitle({ commandId: randomUUID(), threadId: shell.id, title: wanted });
    } catch (error) {
      this.log("thread title not set", (error as Error).message);
    }
  }

  /**
   * Messages another agent sent to this member's thread with T3's tools (work handed out, a steer, a queued follow-up,
   * a question, an answer: all the same kind of T3 message, which names its sender's thread) appear on the board as
   * "member.message" events, each once, as soon as they are seen. This covers turns the room started too, so a steer
   * into one is recorded. Display only: never delivered in briefings.
   */
  private importMemberMessages(participant: Participant, binding: SessionBinding, detail: T3ThreadDetail, senderOf: (roomId: string, threadId: string) => RoomEvent["speaker"]): boolean {
    const sent = detail.messages.filter(
      (m) =>
        m.role === "user" &&
        m.createdBy === "agent" &&
        m.senderThreadId !== null &&
        m.createdAt >= binding.createdAt &&
        m.createdAt >= this.boardSince &&
        m.text.trim().length > 0 &&
        this.repos.findEventIdForSource(binding.threadId, m.id) === null,
    );
    if (sent.length === 0) return false;
    this.db.transaction(() => {
      for (const message of sent) {
        this.service.appendEvent({
          roomId: participant.roomId,
          kind: "member.message",
          speaker: senderOf(participant.roomId, message.senderThreadId as string),
          to: participant.id,
          text: message.text,
          sourceRef: { threadId: binding.threadId, messageId: message.id, t3RunId: runForMessage(detail, message.id)?.id ?? message.runId },
          createdAt: message.createdAt,
        });
      }
    });
    return true;
  }

  /**
   * Runs on a participant's thread that the room did not send (someone typed in T3 Code, another member's agent sent
   * it work, or the agent woke itself when its background work finished) appear in the timeline as "t3.turn" events:
   * the prompt a person typed, the progress messages, the final answer, and how the run ended. A run that was
   * interrupted or failed before it answered is recorded too, with empty text. They are not room messages: they are
   * never delivered in briefings and never satisfy prerequisites. Only runs finished after the thread joined the room.
   */
  private importDirectRuns(participant: Participant, binding: SessionBinding, detail: T3ThreadDetail): boolean {
    const imports: Array<{ t3RunId: string; completedAt: string; selfStarted: boolean; prompt: string | null; promptImages: string[]; final: string; finalId: string; progress: Array<{ text: string; at: string }>; outcome: NonNullable<RoomEvent["outcome"]> }> = [];
    for (const t3Run of detail.runs) {
      if (isRunActive(t3Run.status) || !t3Run.completedAt || t3Run.completedAt < binding.createdAt) continue;
      if (this.repos.isRunT3Run(binding.threadId, t3Run.id) || this.repos.hasTurnForT3Run(binding.threadId, t3Run.id)) continue;
      const replies = runReplies(detail, t3Run.id);
      const finalMessage = replies[replies.length - 1];
      const outcome = t3Run.status === "completed" ? "completed" : t3Run.status === "interrupted" || t3Run.status === "cancelled" ? "interrupted" : "failed";
      // A completed run that said nothing has nothing to show; one that was stopped or failed is still a fact of the room.
      if (!finalMessage && (outcome === "completed" || t3Run.completedAt < this.boardSince)) continue;
      // Null for a run the agent started itself (T3 writes its notice, not a person). Also null when the prompt is
      // already in the timeline as a note typed into a room run (t3.message).
      const promptMessage = runPrompt(detail, t3Run);
      const promptShown = promptMessage !== null && this.repos.findEventIdForSource(binding.threadId, promptMessage.id) === null;
      imports.push({
        t3RunId: t3Run.id,
        completedAt: t3Run.completedAt,
        selfStarted: promptMessage === null,
        prompt: promptShown ? promptMessage.text : null,
        // The prompt's images (T3 files named by id), shown with the prompt like a room message's.
        promptImages: promptShown ? promptMessage.attachments.filter((a) => a.type === "image").map((a) => a.id) : [],
        final: finalMessage?.text.trim() ?? "",
        finalId: finalMessage?.id ?? `run:${t3Run.id}`,
        progress: replies.filter((m) => m !== finalMessage).map((m) => ({ text: m.text.trim(), at: m.createdAt })),
        outcome,
      });
    }
    if (imports.length === 0) return false;
    imports.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    this.db.transaction(() => {
      for (const turn of imports) {
        const event = this.service.appendEvent({
          roomId: participant.roomId,
          kind: "t3.turn",
          speaker: { type: "participant", participantId: participant.id, bindingId: binding.id },
          text: turn.final,
          progress: turn.progress,
          prompt: turn.prompt,
          attachmentIds: turn.promptImages,
          outcome: turn.outcome,
          sourceRef: { threadId: binding.threadId, messageId: turn.finalId, t3RunId: turn.t3RunId },
          createdAt: turn.completedAt,
        });
        if (turn.selfStarted && turn.completedAt >= this.boardSince) this.wakePosterOfLatestJob(participant, event, turn.outcome);
      }
    });
    return true;
  }

  /**
   * A member continued on its own (background work finished and woke it) and that run has ended: whoever posted the
   * member's latest job on the board is woken with it, as they were with the first answer. A job from the user needs
   * no wake: the continuation is news to the user already.
   */
  private wakePosterOfLatestJob(participant: Participant, turn: RoomEvent, outcome: NonNullable<RoomEvent["outcome"]>): void {
    const job = this.repos
      .listTasks(participant.roomId)
      .filter((task) => task.participantId === participant.id && task.kind === "assignment")
      .sort((a, b) => b.number - a.number)[0];
    if (!job) return;
    const post = this.repos.getEvent(job.sourceEventId);
    if (!post || post.kind !== "member.message" || post.sourceRef !== null || post.speaker.type !== "participant") return;
    const poster = this.repos.getParticipant(post.speaker.participantId);
    if (!poster || poster.retiredAt) return;
    const head = turn.text.replace(/\s+/g, " ").trim().slice(0, 600);
    const instruction = `@${participant.alias} continued on its own after ${taskLabel(job)} and that run has ${outcome === "completed" ? "ended" : outcome}: post #${turn.postNumber ?? turn.sequence}${head ? `. It says: ${head}${turn.text.length > 600 ? "…" : ""}` : ""}. Read the post for the whole of it and carry on.`;
    this.service.createWake(participant.roomId, poster, post.id, instruction, null);
  }

  /** Mirror T3's open approvals and questions for the participant: new ones are recorded, the rest are closed. */
  private syncNativeRequests(participant: Participant, binding: SessionBinding, open: T3RuntimeRequest[]): boolean {
    const byId = new Map(open.map((request) => [request.id, request]));
    let changed = false;
    this.db.transaction(() => {
      for (const existing of this.repos.listOpenNativeRequests([participant.id])) {
        if (!byId.has(existing.requestId)) {
          this.repos.resolveNativeRequest(existing.threadId, existing.requestId);
          changed = true;
        }
      }
      for (const request of open) {
        if (this.repos.upsertNativeRequest({ participantId: participant.id, threadId: binding.threadId, requestId: request.id, kind: request.type, payload: requestPayload(request), createdAt: request.createdAt })) {
          changed = true;
        }
      }
    });
    return changed;
  }

  /**
   * Notes the user types in T3 Code into a run the room started (T3 steers them into it, so the room's reply answers
   * them too) appear in the timeline as "t3.message" events with their images, ahead of the reply. Display only: never
   * delivered in briefings. The room's own messages on the thread are skipped.
   */
  private importMidRunMessages(run: Run, task: Task, binding: SessionBinding, detail: T3ThreadDetail): boolean {
    if (!run.t3RunId) return false;
    const own = detail.messages.find((m) => m.id === run.messageId);
    const since = own?.createdAt ?? run.createdAt;
    const notes = detail.messages.filter(
      (m) =>
        m.role === "user" &&
        m.createdBy === "user" &&
        m.runId === run.t3RunId &&
        m.id !== run.messageId &&
        m.createdAt > since &&
        (m.text.trim().length > 0 || m.attachments.length > 0) &&
        !this.repos.isRunMessage(binding.threadId, m.id) &&
        this.repos.findEventIdForSource(binding.threadId, m.id) === null,
    );
    if (notes.length === 0) return false;
    this.db.transaction(() => {
      for (const note of notes) {
        this.service.appendEvent({
          roomId: task.roomId,
          kind: "t3.message",
          speaker: { type: "user" },
          text: note.text.trim(),
          taskId: task.id,
          runId: run.id,
          attachmentIds: note.attachments.filter((a) => a.type === "image").map((a) => a.id),
          sourceRef: { threadId: binding.threadId, messageId: note.id, t3RunId: run.t3RunId },
          createdAt: note.createdAt,
        });
      }
    });
    return true;
  }

  private failRun(run: Run, task: Task, reason: string, dependents: string): void {
    this.db.transaction(() => {
      this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: reason, updatedAt: now() });
      this.service.setTaskState(task, "failed", reason, { currentRunId: run.id });
      this.service.statusEvent(task, `${taskLabel(task)} failed: ${reason}`, run.id);
      this.service.blockPendingDependents(task, dependents);
    });
  }

  private async observeRun(run: Run, participant: Participant, binding: SessionBinding, shell: T3ThreadShell, loadDetail: () => Promise<T3ThreadDetail | null>): Promise<boolean> {
    const task = this.repos.getTask(run.taskId);
    if (!task) return false;
    let detail = await loadDetail();
    if (!detail) return false;

    // The T3 run for our message: the run it started, or the run it was steered into. T3 records both.
    if (run.t3RunId === null) {
      const t3Run = runForMessage(detail, run.messageId);
      if (!t3Run) {
        if (run.status === "dispatched") {
          // Acknowledgement was lost and T3 does not show the message: resend identically (T3 keeps a receipt per command).
          await this.send(run, task, participant, binding);
          return true;
        }
        // Accepted by T3 but the message never materialised: fail visibly after a bounded wait instead of hanging.
        if (Date.now() - Date.parse(run.acceptedAt ?? run.createdAt) > ACCEPT_WITHOUT_RUN_TIMEOUT_MS) {
          this.failRun(run, task, "T3 accepted the command but never recorded the message; check the provider in T3 and retry", `prerequisite ${taskLabel(task)} failed to start`);
          this.forgetStandingOf(run, task.roomId);
          return true;
        }
        return false;
      }
      run = { ...run, t3RunId: t3Run.id, acceptedAt: run.acceptedAt ?? now(), updatedAt: now() };
      this.repos.updateRun(run);
    }

    const t3Run = detail.runs.find((candidate) => candidate.id === run.t3RunId);
    if (!t3Run) {
      // T3 has no such run: the thread was rolled back past it, or its history came from T3's V1 import (messages only).
      this.failRun(run, task, "T3 no longer has this run (the thread was rolled back, or T3 was migrated while it ran)", `prerequisite ${taskLabel(task)} failed: its run is gone in T3`);
      this.forgetStandingIfRolledBack(task.roomId, binding.id, detail);
      this.statuses.set(participant.id, { ...this.participantStatus(participant.id), activeRunId: null });
      return true;
    }

    if (t3Run.status === "preparing" || t3Run.status === "queued" || t3Run.status === "starting") {
      // T3 has the message; the provider has not started on it yet (its workspace is prepared, or another run is ahead).
      const reason = t3Run.status === "queued" ? `queued in T3 behind @${participant.alias}'s running turn` : `accepted by T3; waiting for @${participant.alias} to start`;
      if (run.status === "accepted" && task.stateReason === reason) return false;
      this.db.transaction(() => {
        this.repos.updateRun({ ...run, status: "accepted", updatedAt: now() });
        this.service.setTaskState(task, "dispatching", reason, { currentRunId: run.id });
      });
      return true;
    }

    if (t3Run.status === "running" || t3Run.status === "waiting") {
      let changed = false;
      if (run.startedAt === null) {
        run = { ...run, status: "running", startedAt: now(), updatedAt: now() };
        this.db.transaction(() => {
          this.repos.updateRun(run);
          this.service.setTaskState(task, "running", `running on @${participant.alias}`, { currentRunId: run.id });
          this.service.statusEvent(task, `${taskLabel(task)} started on @${participant.alias}`, run.id);
        });
        changed = true;
      }
      // Notes the user types into this run in T3 show up while it runs, not only when it ends.
      if (this.importMidRunMessages(run, task, binding, detail)) changed = true;
      // An approval, or a question that holds the run, is waiting on the user.
      const needsInput = openRequests(detail).some((request) => request.runId === t3Run.id && request.responseMode !== "message");
      const nextStatus: Run["status"] = needsInput ? "needs_input" : "running";
      if (run.status === nextStatus && task.state === nextStatus) return changed;
      this.db.transaction(() => {
        this.repos.updateRun({ ...run, status: nextStatus, updatedAt: now() });
        this.service.setTaskState(task, nextStatus, needsInput ? `@${participant.alias} is waiting for your approval or answer` : `running on @${participant.alias}`, { currentRunId: run.id });
        if (needsInput && task.state !== "needs_input") this.service.statusEvent(task, `${taskLabel(task)} needs your approval or answer`, run.id);
      });
      return true;
    }

    // The run ended. The recent window carries its last messages; a long run's earlier ones need the whole thread.
    if (detail.partial) detail = (await this.adapter.getThreadDetail(binding.threadId)) ?? detail;
    // A compaction early in a long run can be outside the recent window the tick looked at.
    this.noteCompactions(task.roomId, binding, detail);
    this.importMidRunMessages(run, task, binding, detail);
    // T3 keeps each assistant message of a run separately: progress notes between tool calls, then the final answer.
    // The final one is the reply (and what dependents receive); the earlier ones are kept as progress.
    const replies = runReplies(detail, t3Run.id);
    const finalMessage = replies[replies.length - 1] ?? null;
    const replyText = finalMessage?.text.trim() ?? "";
    const progress = replies.filter((m) => m !== finalMessage).map((m) => ({ text: m.text.trim(), at: m.createdAt }));
    const assistantMessageId = finalMessage?.id ?? `assistant:${t3Run.id}`;
    const checkpoint = detail.checkpoints.filter((c) => c.runId === t3Run.id).pop();
    const files = (checkpoint?.files ?? []).map((file) => ({ path: file.path, kind: file.kind, additions: file.additions, deletions: file.deletions }));
    // Where the work is (folder, branch, commit, what is uncommitted), so whoever builds on it looks in the right place.
    const where = workspaceArtifact((await this.workspaces(participant.roomId, participant.id))?.[0]);
    const artifacts = where ? [where, ...files] : files;
    const outcome: Run["status"] = t3Run.status === "completed" ? "succeeded" : t3Run.status === "interrupted" || t3Run.status === "cancelled" ? "interrupted" : "failed";
    const lastError = detail.turnItems.filter((item) => item.runId === t3Run.id && item.type === "error").pop();
    const errorText = t3Run.status === "rolled_back" ? "the run was rolled back in T3" : lastError?.type === "error" ? lastError.message : (shell.lastError ?? detail.shell.lastError ?? "provider reported an error");

    this.db.transaction(() => {
      // A run several room messages were steered into answers them with one final message: the first room run to
      // finish records the reply and the others point at the same event.
      let resultEventId: string | null = this.repos.findEventIdForSource(binding.threadId, assistantMessageId);
      if (replyText.length > 0 && resultEventId === null) {
        const event = this.service.appendEvent({
          roomId: task.roomId,
          kind: "assistant.reply",
          speaker: { type: "participant", participantId: participant.id, bindingId: binding.id },
          text: replyText,
          taskId: task.id,
          runId: run.id,
          artifacts,
          progress,
          sourceRef: { threadId: binding.threadId, messageId: assistantMessageId, t3RunId: t3Run.id },
        });
        resultEventId = event.id;
      }
      this.repos.updateRun({ ...run, status: outcome, startedAt: run.startedAt ?? t3Run.startedAt ?? now(), completedAt: now(), resultEventId, error: outcome === "failed" ? errorText : null, updatedAt: now() });
      // Context delivered before a failure is still delivered; do not replay it on retry.
      this.repos.updateBinding({ ...binding, deliveredCursor: Math.max(binding.deliveredCursor, run.includedToSequence) });
      if (outcome === "succeeded") {
        this.service.setTaskState(task, "succeeded", "completed", { currentRunId: run.id });
        this.service.statusEvent(task, `${taskLabel(task)} succeeded on @${participant.alias}${files.length > 0 ? ` (${files.length} file(s) changed)` : ""}`, run.id);
      } else {
        const reason = outcome === "interrupted" ? "interrupted" : `failed: ${errorText}`;
        this.service.setTaskState(task, outcome, reason, { currentRunId: run.id });
        this.service.statusEvent(task, `${taskLabel(task)} ${reason} on @${participant.alias}`, run.id);
        this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} ${reason}`);
      }
    });
    // The status snapshot for this tick was taken while the run was still active; reflect completion immediately.
    this.statuses.set(participant.id, { ...this.participantStatus(participant.id), activeRunId: null });
    return true;
  }

  // ---------------- dispatch ----------------

  private async dispatch(touched: Set<string>): Promise<void> {
    // Resend runs persisted before a crash/outage.
    for (const run of this.repos.listRunsByStatus(["pending"])) {
      const task = this.repos.getTask(run.taskId);
      const binding = this.repos.getBinding(run.bindingId);
      const participant = task ? this.repos.getParticipant(task.participantId) : null;
      if (!task || !binding || !participant) continue;
      await this.send(run, task, participant, binding);
      touched.add(task.roomId);
    }

    const queued = this.repos.listTasksByState(["queued"]);
    if (queued.length === 0) return;
    const busyParticipants = new Set(
      this.repos.listRunsByStatus([...ACTIVE_RUN_STATUSES]).map((run) => this.repos.getTask(run.taskId)?.participantId ?? ""),
    );
    for (const task of queued) {
      const room = this.repos.getRoom(task.roomId);
      const participant = this.repos.getParticipant(task.participantId);
      if (!room || !participant) continue;
      const tasks = new Map(this.repos.listTasks(room.id).map((t) => [t.id, t]));
      const readiness = this.prerequisiteReadiness(task, tasks);
      if (readiness.kind === "blocked") {
        this.db.transaction(() => {
          this.service.setTaskState(task, "blocked", readiness.reason);
          this.service.statusEvent(task, `${taskLabel(task)} blocked: ${readiness.reason}`);
        });
        touched.add(room.id);
        continue;
      }
      if (readiness.kind === "waiting") {
        if (task.stateReason !== readiness.reason) {
          this.service.setTaskState(task, "queued", readiness.reason);
          touched.add(room.id);
        }
        continue;
      }
      const binding = this.repos.currentBinding(participant.id);
      if (!binding || participant.retiredAt) {
        this.db.transaction(() => {
          this.service.setTaskState(task, "blocked", participant.retiredAt ? `@${participant.alias} was removed from the room; reassign the task` : `@${participant.alias} has no bound T3 thread`);
        });
        touched.add(room.id);
        continue;
      }
      const status = this.statuses.get(participant.id);
      if (status?.threadMissing) {
        const reason = `T3 thread for @${participant.alias} was deleted; rebind the participant or remove it`;
        if (task.stateReason !== reason) {
          this.db.transaction(() => {
            this.service.setTaskState(task, "blocked", reason);
            this.service.statusEvent(task, `${taskLabel(task)} blocked: ${reason}`);
          });
          touched.add(room.id);
        }
        continue;
      }
      const sessionBusy = status ? status.externalActivity || status.pendingApprovals || status.pendingUserInput : false;
      // Steering: send into the run that is running now (T3 steers it into the provider's turn). Only into a run that
      // has started (not one still being dispatched), never while a native approval or question is open, and only on a
      // thread that already received the room's bootstrap briefing.
      const runRunning = status?.status === "running" && (this.activeT3Runs.get(participant.id) ?? null) !== null && !status.pendingApprovals && !status.pendingUserInput;
      if (task.delivery === "steer" && runRunning && binding.bootstrapDeliveredAt !== null && !this.hasUnstartedRun(participant.id)) {
        const run = this.prepareRun(room, task, participant, binding, tasks, readiness.results, { steer: true });
        await this.send(run, task, participant, binding);
        touched.add(room.id);
        continue;
      }
      if (busyParticipants.has(participant.id) || sessionBusy) {
        const reason = `waiting for @${participant.alias} (${busyParticipants.has(participant.id) ? "busy with room work" : "working on its own"})`;
        if (task.stateReason !== reason) {
          this.service.setTaskState(task, "queued", reason);
          touched.add(room.id);
        }
        continue;
      }
      busyParticipants.add(participant.id);
      // A room with browsers on gets its default browser running before the briefing lists the browsers (slash commands
      // skip it).
      const browsers = room.browserEnabled && !task.slashCommand ? await this.browsersBriefing(room, participant) : null;
      const workspaces = task.slashCommand ? null : await this.workspaces(room.id);
      const run = this.prepareRun(room, task, participant, binding, tasks, readiness.results, { browsers, workspaces });
      await this.send(run, task, participant, binding);
      touched.add(room.id);
    }
  }

  /** Where the room's participants work (or one of them); null when T3 or git can't be read, which never holds up work. */
  private async workspaces(roomId: string, participantId?: string): Promise<Workspace[] | null> {
    try {
      return await roomWorkspaces(this.adapter, this.repos, roomId, participantId ? { participantId } : {});
    } catch (error) {
      this.log("workspaces unreadable", (error as Error).message);
      return null;
    }
  }

  /** The browsers section for one agent: the room's allowed browsers, its default started, the agent's own key. */
  private async browsersBriefing(room: Room, participant: Participant): Promise<BrowsersBriefing | null> {
    const manager = this.options.browsers;
    const defaultBrowser = this.service.effectiveBrowser(room);
    if (!manager || !defaultBrowser) return null;
    const started = await manager.briefingFor(defaultBrowser);
    if (!started) return null;
    return {
      command: this.options.browserCommand ?? "rooms-browser",
      as: agentKey(participant.alias, room.id),
      started,
      browsers: browsersForRoom(this.repos, room).map((browser) => ({
        name: browser.name,
        description: browser.description,
        isDefault: browser.id === defaultBrowser.id,
        running: browser.id === defaultBrowser.id || manager.status?.(browser.id).state === "running",
      })),
    };
  }

  /** What a member's thread is still doing after its reply, in a few words; null when it is idle. */
  private continuingNote(participantId: string): string | null {
    const status = this.participantStatus(participantId);
    if (status.activeRunId || status.externalActivity || status.status === "running" || status.status === "waiting") return "already in another turn";
    if (status.background === "working") return "still working after this reply (subagents or commands running; it continues on its own when they finish)";
    if (status.background === "monitoring") return "still monitoring something after this reply";
    return null;
  }

  private prerequisiteReadiness(
    task: Task,
    tasks: Map<string, Task>,
  ): { kind: "ready"; results: PrerequisiteResult[] } | { kind: "waiting"; reason: string } | { kind: "blocked"; reason: string } {
    const waiting: string[] = [];
    const results: PrerequisiteResult[] = [];
    for (const ref of task.prerequisites) {
      const prerequisite = tasks.get(ref.taskId);
      if (!prerequisite) return { kind: "blocked", reason: `prerequisite ${ref.taskId} no longer exists` };
      if (prerequisite.revision !== ref.revision) {
        return { kind: "blocked", reason: `prerequisite ${taskLabel(prerequisite)} changed to revision ${prerequisite.revision}; re-point or carry the dependency` };
      }
      switch (prerequisite.state) {
        case "succeeded": {
          const run = prerequisite.currentRunId ? this.repos.getRun(prerequisite.currentRunId) : null;
          const resultEvent = run?.resultEventId ? this.repos.getEvent(run.resultEventId) : null;
          const assignee = this.repos.getParticipant(prerequisite.participantId);
          results.push({ task: prerequisite, assigneeAlias: assignee?.alias ?? prerequisite.participantId, resultEvent });
          break;
        }
        case "failed":
        case "interrupted":
        case "cancelled":
        case "blocked": {
          // A wake task runs however the work ended, or when it is stuck (blocked until someone acts on it): the poster
          // is told what happened and decides. A wake waiting on a blocked task would wait for good, and with it every
          // wake held for the exchange that task belongs to.
          if (task.kind === "wake") {
            const assignee = this.repos.getParticipant(prerequisite.participantId);
            results.push({ task: prerequisite, assigneeAlias: assignee?.alias ?? prerequisite.participantId, resultEvent: null });
            break;
          }
          // Other work waits for a blocked task, which may be unblocked yet; it is blocked by one that ended badly.
          if (prerequisite.state === "blocked") {
            waiting.push(taskLabel(prerequisite));
            break;
          }
          return { kind: "blocked", reason: `prerequisite ${taskLabel(prerequisite)} ${prerequisite.state}` };
        }
        default:
          waiting.push(taskLabel(prerequisite));
      }
    }
    if (waiting.length > 0) return { kind: "waiting", reason: `waiting for ${waiting.join(", ")}` };
    // A wake waits as well for what the member went on with through the board, and then carries how that ended.
    if (task.kind === "wake") {
      for (const result of results) {
        const chain = this.followUps(result.task, tasks);
        if (chain.length === 0) continue;
        const open = chain.filter((t) => !FOLLOW_UP_ENDED.has(t.state));
        if (open.length > 0) return { kind: "waiting", reason: `waiting for ${open.map(taskLabel).join(", ")}: what @${result.assigneeAlias} posted after ${taskLabel(result.task)}` };
        const lastTurn = chain.filter((t) => t.kind === "wake" && t.participantId === result.task.participantId).at(-1) ?? null;
        const lastRun = lastTurn?.currentRunId ? this.repos.getRun(lastTurn.currentRunId) : null;
        result.followUps = {
          tasks: chain.filter((t) => t.kind !== "wake").map((t) => ({ label: taskLabel(t), alias: this.repos.getParticipant(t.participantId)?.alias ?? t.participantId, state: t.state, reason: t.state === "succeeded" ? null : t.stateReason })),
          lastTurn,
          lastResult: lastRun?.resultEventId ? this.repos.getEvent(lastRun.resultEventId) : null,
        };
      }
    }
    return { kind: "ready", results };
  }

  /**
   * What a member went on with from a task through the board: the tasks its posts made while that task's run was going,
   * the wakes that brought it their answers, and in turn what it posted from those wakes. The wake of whoever posted
   * the task waits until none of it is still going (all ended, or blocked), so the poster (the Consigliere, mostly) is
   * woken once, with how the exchange ended, and not at every hand-over between a worker and its reviewer. Posts a
   * member makes in a turn of its own are not part of it.
   */
  private followUps(root: Task, tasks: Map<string, Task>): Task[] {
    const member = root.participantId;
    const posted = new Map<string, boolean>();
    const postedByMember = (eventId: string): boolean => {
      if (!posted.has(eventId)) {
        const event = this.repos.getEvent(eventId);
        posted.set(eventId, event?.kind === "member.message" && event.sourceRef === null && event.speaker.type === "participant" && event.speaker.participantId === member);
      }
      return posted.get(eventId) as boolean;
    };
    const chain: Task[] = [];
    const seen = new Set<string>([root.id]);
    const turns: Task[] = [root];
    for (let turn = turns.shift(); turn; turn = turns.shift()) {
      // While the turn's runs went on: from when each was prepared to when it ended (or now, while it runs).
      const windows = this.repos.listRunsForTask(turn.id).map((run) => [run.createdAt, run.completedAt] as const);
      for (const candidate of tasks.values()) {
        if (seen.has(candidate.id) || !windows.some(([from, to]) => candidate.createdAt >= from && (to === null || candidate.createdAt <= to))) continue;
        if (!postedByMember(candidate.sourceEventId)) continue;
        seen.add(candidate.id);
        chain.push(candidate);
        if (candidate.kind === "wake" && candidate.participantId === member) turns.push(candidate);
      }
    }
    return chain.sort((a, b) => a.number - b.number);
  }

  /** True when a user message is just this task's addressing plus its instruction, addressed to nobody else. */
  private sourceIsOnlyThisAssignment(source: RoomEvent, task: Task): boolean {
    const others = this.repos.listTasks(task.roomId).some((t) => t.sourceEventId === source.id && t.participantId !== task.participantId);
    if (others) return false;
    const text = source.text.trim();
    const instruction = task.instruction.trim();
    if (!text.endsWith(instruction)) return false;
    const prefix = text.slice(0, text.length - instruction.length);
    return /^[\s,]*(?:(?:@[a-z0-9][a-z0-9_-]*|\/(?:now|hold|steer)|\/after\s+[^\s]+)[\s,]*)*$/i.test(prefix);
  }

  /** A room run for this participant that T3 has not matched to a run yet: steering must wait for it. */
  private hasUnstartedRun(participantId: string): boolean {
    return this.repos
      .listRunsByStatus(["pending", "dispatched", "accepted"])
      .some((run) => this.repos.getTask(run.taskId)?.participantId === participantId && run.t3RunId === null);
  }

  private prepareRun(
    room: Room,
    task: Task,
    participant: Participant,
    binding: SessionBinding,
    tasks: Map<string, Task>,
    prerequisiteResults: PrerequisiteResult[],
    options: { steer?: boolean; browsers?: BrowsersBriefing | null; workspaces?: Workspace[] | null } = {},
  ): Run {
    if (options.steer) return this.prepareSteerRun(room, task, participant, binding);
    if (task.slashCommand) return this.prepareSteerRun(room, task, participant, binding, { verbatim: true });
    return this.db.transaction(() => {
      const current = this.repos.getRoom(room.id) as Room;
      const cutoff = current.nextSequence - 1;
      const participantsById = new Map(this.repos.listParticipants(room.id).map((p) => [p.id, p]));
      // A seat briefing carries no room messages: the member reads the board by number when it is pointed at posts.
      const unseen = (task.kind === "seat" ? [] : this.repos.listEvents(room.id, binding.deliveredCursor + 1, cutoff))
        .filter((event) => BRIEFING_EVENT_KINDS.has(event.kind))
        .filter((event) => !(event.speaker.type === "participant" && event.speaker.bindingId === binding.id))
        // The user's message that is nothing but this assignment would be delivered twice (as a room message and as
        // the assignment); the assignment section alone carries it. Split messages stay: they show the others' parts.
        .filter((event) => event.id !== task.sourceEventId || !this.sourceIsOnlyThisAssignment(event, task));
      const standingInput: StandingInput = {
        room: current,
        participant,
        participantsById,
        browsers: options.browsers ?? null,
        workspaces: options.workspaces ?? null,
        board: { command: this.options.boardCommand ?? "rooms-board", as: agentKey(participant.alias, room.id) },
        consigliereRules: this.repos.getKv(CONSIGLIERE_RULES_KEY),
        roomState: readRoomState(this.repos, room.id),
      };
      // All the standing sections on the thread's first delivery and after a compaction (no record), else the ones that
      // changed since it last had them.
      const had = this.readStanding(room.id, binding.id);
      const fingerprint = standingFingerprint(standingInput);
      const standing = had ? changedStanding(had.sections, fingerprint) : "all";
      const briefing = assembleBriefing({
        ...standingInput,
        task,
        unseenEvents: unseen,
        // A wake carries each answer with a word on whether that member's thread is still busy after it.
        prerequisiteResults: task.kind === "wake" ? prerequisiteResults.map((result) => ({ ...result, continuing: this.continuingNote(result.task.participantId) })) : prerequisiteResults,
        attachmentNames: task.attachmentIds.map((id) => this.repos.getAttachment(id)?.name ?? "image"),
        standing,
        budgetChars: this.options.briefingBudgetChars,
      });
      const attempt = this.repos.listRunsForTask(task.id).length + 1;
      const run: Run = {
        id: randomUUID(),
        taskId: task.id,
        taskRevision: task.revision,
        attempt,
        bindingId: binding.id,
        threadId: binding.threadId,
        commandId: randomUUID(),
        messageId: randomUUID(),
        t3RunId: null,
        status: "pending",
        steered: false,
        briefing: briefing.text,
        includedFromSequence: binding.deliveredCursor + 1,
        includedToSequence: cutoff,
        interruptRequestedAt: null,
        acceptedAt: null,
        startedAt: null,
        completedAt: null,
        resultEventId: null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.repos.insertRun(run);
      if (standing === "all") {
        this.repos.setKv(standingRecordKey(room.id, binding.id), JSON.stringify({ runId: run.id, at: now(), sections: heldStanding({}, fingerprint) } satisfies StandingRecord));
      } else if (had && standing.length > 0) {
        this.repos.setKv(standingRecordKey(room.id, binding.id), JSON.stringify({ ...had, sections: heldStanding(had.sections, fingerprint) } satisfies StandingRecord));
      }
      this.service.setTaskState(task, "dispatching", `sending to @${participant.alias}${briefing.condensed ? " (older context condensed)" : ""}`, { currentRunId: run.id });
      void tasks;
      return run;
    });
  }

  /**
   * A message sent into the participant's running run. The session already holds the room briefing and the context
   * of the run, so this is only the user's words (plus images). It claims no room events as delivered: whatever the
   * participant has not seen yet still comes with its next ordinary briefing.
   */
  private prepareSteerRun(room: Room, task: Task, participant: Participant, binding: SessionBinding, options: { verbatim?: boolean } = {}): Run {
    return this.db.transaction(() => {
      // A slash command must be the whole turn text for the harness to run it, so it is sent exactly as written.
      const text = options.verbatim ? task.instruction : [
        `[Backroom: the user added this to your current turn in room "${room.title}" (${taskLabel(task)})]`,
        task.instruction,
        ...(task.attachmentIds.length > 0 ? [`Images attached: ${task.attachmentIds.map((id) => this.repos.getAttachment(id)?.name ?? "image").join(", ")}.`] : []),
        "Take it into account in the work you are doing now, and cover it in your final reply for this turn.",
      ].join("\n");
      const run: Run = {
        id: randomUUID(),
        taskId: task.id,
        taskRevision: task.revision,
        attempt: this.repos.listRunsForTask(task.id).length + 1,
        bindingId: binding.id,
        threadId: binding.threadId,
        commandId: randomUUID(),
        messageId: randomUUID(),
        t3RunId: null,
        status: "pending",
        steered: !options.verbatim,
        briefing: text,
        includedFromSequence: binding.deliveredCursor + 1,
        includedToSequence: binding.deliveredCursor,
        interruptRequestedAt: null,
        acceptedAt: null,
        startedAt: null,
        completedAt: null,
        resultEventId: null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.repos.insertRun(run);
      this.service.setTaskState(task, "dispatching", options.verbatim ? `running ${task.instruction.split(/\s/)[0]} on @${participant.alias}` : `sending into @${participant.alias}'s running turn`, { currentRunId: run.id });
      return run;
    });
  }

  /** The task's images as T3 upload attachments. The bytes are immutable, so a resend delivers the same images. */
  private loadImages(ids: string[]): TurnImage[] {
    return ids.flatMap((id) => {
      const attachment = this.repos.getAttachment(id);
      const data = this.repos.getAttachmentData(id);
      if (!attachment || !data) return [];
      const dataUrl = `data:${attachment.mimeType};base64,${Buffer.from(data).toString("base64")}`;
      return [{ name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, dataUrl }];
    });
  }

  /** Submit (or identically resubmit) a run. Never rebuilds the briefing or mints a new command id. */
  private async send(run: Run, task: Task, participant: Participant, binding: SessionBinding): Promise<void> {
    this.repos.updateRun({ ...run, status: "dispatched", updatedAt: now() });
    try {
      // A steered message goes into the run that is active now; when that run has ended meanwhile, it starts one.
      // Any other message starts a run (T3 queues it behind a run that slipped in since the last look).
      const steerInto = run.steered ? (this.activeT3Runs.get(participant.id) ?? null) : null;
      // Name the model, as T3 Code's composer does: a live session keeps the model it started with unless the message
      // names one. The participant mirrors the thread (observe syncs it just before dispatch), so changes made in T3
      // Code still take effect. The permission and interaction modes are the thread's own in T3.
      await this.adapter.sendMessage({
        commandId: run.commandId,
        threadId: run.threadId,
        messageId: run.messageId,
        text: run.briefing,
        ...(task.attachmentIds.length > 0 ? { images: this.loadImages(task.attachmentIds) } : {}),
        modelSelection: participant.modelSelection,
        // No title seed: the thread is named "room · alias" at launch, and a seed on a thread's first message makes T3
        // generate a title from it instead (that is how T3 titles its own new threads).
        mode: steerInto ? { type: "steer", runId: steerInto } : { type: "start" },
      });
    } catch (error) {
      if (error instanceof T3Unavailable) {
        // Keep it pending; the next tick resends with the same command id.
        this.repos.updateRun({ ...run, status: "pending", updatedAt: now() });
        this.noteAdapterError(error.message);
        return;
      }
      if (error instanceof T3CommandRejected) {
        this.db.transaction(() => {
          this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: error.message, updatedAt: now() });
          this.service.setTaskState(task, "failed", `T3 rejected the dispatch: ${error.message}`, { currentRunId: run.id });
          this.service.statusEvent(task, `${taskLabel(task)} failed: T3 rejected the dispatch`, run.id);
          this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} failed to dispatch`);
          this.forgetStandingOf(run, task.roomId);
        });
        return;
      }
      // Unknown outcome (for example a dropped connection after the request left): stay "dispatched" and reconcile next tick.
      this.log("dispatch acknowledgement unknown; will reconcile", (error as Error).message);
      return;
    }
    this.db.transaction(() => {
      this.repos.updateRun({ ...run, status: "accepted", acceptedAt: now(), updatedAt: now() });
      if (binding.bootstrapDeliveredAt === null) this.repos.updateBinding({ ...binding, bootstrapDeliveredAt: now() });
      // The summary a compaction leaves may not keep the standing sections; the turn item T3 records says so too, later.
      if (task.slashCommand && COMPACT_COMMAND.test(task.instruction.trim())) this.forgetStanding(task.roomId, run.bindingId);
      this.service.setTaskState(task, "dispatching", `accepted by T3; waiting for @${participant.alias} to start`, { currentRunId: run.id });
      this.service.statusEvent(task, `${taskLabel(task)} delivered to @${participant.alias} (attempt ${run.attempt})`, run.id);
    });
  }
}
