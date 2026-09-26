/**
 * Durable queue driver (PRD section 6). One tick:
 *   1. observe   — poll thread shells for every active binding; correlate runs to turns; ingest results.
 *   2. dispatch  — release queued tasks whose prerequisites all succeeded and whose assignee is free.
 * Runs are persisted before submission and resent with the same T3 commandId when the acknowledgement was lost.
 */
import { randomUUID } from "node:crypto";
import type { T3Adapter, T3Message, T3ThreadDetail, T3ThreadShell, TurnImage } from "../adapter/types.ts";
import { T3CommandRejected, T3Unavailable } from "../adapter/types.ts";
import { assembleBriefing, type PrerequisiteResult } from "../briefing/assemble.ts";
import type { BrowserBriefing } from "../browser/roomBrowsers.ts";
import type { BrowsersBriefing } from "../briefing/assemble.ts";
import { agentKey, browsersForRoom } from "../browser/catalog.ts";
import { promptMessageForTurn, resolveTurnForMessage, type TurnResolution } from "../adapter/correlate.ts";
import type { Database } from "../db/database.ts";
import type { Repos } from "../db/repos.ts";
import type { Participant, ParticipantStatus, Room, RoomEvent, Run, SessionBinding, Task } from "../domain/types.ts";
import { taskLabel } from "../domain/types.ts";
import { dependentsOf } from "../domain/graph.ts";
import { now, type RoomService } from "../app/service.ts";

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["pending", "dispatched", "accepted", "running", "needs_input"]);
const VANISHED_TURN = "T3 no longer reports this turn";
/** How long a run failed as vanished keeps being re-checked (T3 may show its turn after all). */
const VANISHED_RECHECK_MS = 30 * 60 * 1000;
/** A turn this recent is never declared vanished: T3's reads can briefly disagree right after a turn starts. */
const TURN_VANISH_GRACE_MS = 2 * 60 * 1000;
/** How long an accepted command may sit without a recorded turn before the run is failed visibly. */
const ACCEPT_WITHOUT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** While a room turn runs, the thread is re-read for notes the user types into it in T3 whenever its shell changes,
 * and at least this often as a fallback. */
const MID_TURN_SCAN_MS = 4000;
const BRIEFING_EVENT_KINDS = new Set<RoomEvent["kind"]>(["user.message", "note", "assistant.reply"]);

export interface SchedulerOptions {
  briefingBudgetChars: number;
  /** Browsers: the room's default is started for its tasks, and all the room may use are listed in their briefings. */
  browsers?: {
    briefingFor(browser: { id: string; name: string; description: string }): Promise<BrowserBriefing | null>;
    status?(browserId: string): { state: string };
  };
  /** How agents run rooms-browser (absolute path to bin/rooms-browser, with any environment it needs). */
  browserCommand?: string;
  log?: (message: string, detail?: unknown) => void;
}

export class Scheduler {
  private ticking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly statuses = new Map<string, ParticipantStatus>();
  /** Last latest-turn state seen per binding, so direct-turn import reads thread detail only when a turn finishes. */
  private readonly seenLatestTurn = new Map<string, string>();
  /** Last mid-turn note scan per binding: when, and the shell stamp it saw (see importMidTurnMessages). */
  private readonly midTurnScans = new Map<string, { at: number; stamp: string }>();
  /** Per thread: requestedAt → turnId for turns seen as T3's latestTurn (T3 only exposes the latest one). */
  private readonly turnRequests = new Map<string, Map<string, string>>();
  private readonly log: (message: string, detail?: unknown) => void;
  /** Last error from T3 connectivity, surfaced to the UI. */
  lastAdapterError: string | null = null;

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
        session: "unknown",
        threadMissing: false,
        externalActivity: false,
        pendingApprovals: false,
        pendingUserInput: false,
        activeRunId: null,
        background: null,
      }
    );
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
      await this.dispatch(touched);
      this.lastAdapterError = null;
    } catch (error) {
      if (error instanceof T3Unavailable) {
        this.lastAdapterError = error.message;
        this.log("t3 unavailable", error.message);
      } else {
        this.lastAdapterError = (error as Error).message;
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
    // Several runs can be active on one thread when messages were sent into a running turn (steering).
    const activeRuns = new Map<string, Run[]>();
    for (const run of this.repos.listRunsByStatus([...ACTIVE_RUN_STATUSES])) activeRuns.set(run.bindingId, [...(activeRuns.get(run.bindingId) ?? []), run]);

    for (const binding of bindings) {
      const participant = this.repos.getParticipant(binding.participantId);
      if (!participant) continue;
      const shell = shells.get(binding.threadId) ?? (await this.adapter.getThreadShell(binding.threadId));
      const runs = activeRuns.get(binding.id) ?? [];
      const run = runs[0] ?? null;
      if (!shell) {
        // T3 answered but does not have this thread any more (deleted there). Surface it and stop any in-flight run.
        this.statuses.set(participant.id, { session: "unknown", threadMissing: true, externalActivity: false, pendingApprovals: false, pendingUserInput: false, activeRunId: run?.id ?? null, background: null });
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
      if (shell.latestTurn?.requestedAt) {
        const known = this.turnRequests.get(binding.threadId) ?? new Map<string, string>();
        known.set(shell.latestTurn.requestedAt, shell.latestTurn.turnId);
        if (known.size > 50) known.delete(known.keys().next().value as string);
        this.turnRequests.set(binding.threadId, known);
      }
      // The room follows the thread: mirror model/options/permission changes made in T3.
      if (this.service.syncParticipantFromThread(participant, shell)) touched.add(participant.roomId);
      const ourTurns = new Set(runs.map((r) => r.turnId).filter((id): id is string => id !== null));
      const activeTurn = shell.session?.activeTurnId ?? null;
      const externalActivity =
        (shell.session?.status === "running" || shell.session?.status === "starting") && activeTurn !== null && !ourTurns.has(activeTurn) && !runs.some((r) => r.turnId === null);
      this.statuses.set(participant.id, {
        session: shell.session?.status ?? "idle",
        threadMissing: false,
        externalActivity,
        pendingApprovals: shell.hasPendingApprovals,
        pendingUserInput: shell.hasPendingUserInput,
        activeRunId: run?.id ?? null,
        background: shell.backgroundLiveness,
      });

      let detail: T3ThreadDetail | null = null;
      const loadDetail = async (): Promise<T3ThreadDetail | null> => {
        if (detail === null) detail = await this.adapter.getThreadDetail(binding.threadId, { turnLimit: 6 });
        return detail;
      };

      if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
        const loaded = await loadDetail();
        if (loaded && this.syncNativeRequests(participant, binding, loaded)) touched.add(participant.roomId);
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
      if (await this.reviveVanishedRuns(participant, binding, loadDetail)) touched.add(participant.roomId);

      // Mirror turns started directly in T3 into the timeline once they finish (display only).
      const latest = shell.latestTurn;
      const seenKey = `${latest?.turnId ?? ""}:${latest?.state ?? ""}`;
      if (latest && this.seenLatestTurn.get(binding.id) !== seenKey) {
        const loaded = await loadDetail();
        if (loaded && this.importDirectTurns(participant, binding, loaded)) touched.add(participant.roomId);
        this.seenLatestTurn.set(binding.id, seenKey);
      }
    }
  }

  /**
   * Turns on a participant's thread that the room did not start (someone typed in T3 Code) appear in the timeline as
   * "t3.turn" events: the prompt, the progress messages, and the final answer. They are not room messages: they are
   * never delivered in briefings and never satisfy prerequisites. Only turns finished after the thread joined the room.
   */
  private importDirectTurns(participant: Participant, binding: SessionBinding, detail: T3ThreadDetail): boolean {
    const finished = new Map<string, { assistantMessageId: string | null; completedAt: string }>();
    for (const checkpoint of detail.checkpoints) finished.set(checkpoint.turnId, { assistantMessageId: checkpoint.assistantMessageId, completedAt: checkpoint.completedAt });
    const latest = detail.shell.latestTurn;
    if (latest && latest.state !== "running" && latest.completedAt && !finished.has(latest.turnId)) {
      finished.set(latest.turnId, { assistantMessageId: latest.assistantMessageId, completedAt: latest.completedAt });
    }
    const imports: Array<{ turnId: string; completedAt: string; prompt: string | null; final: string; finalId: string; progress: Array<{ text: string; at: string }> }> = [];
    for (const [turnId, turn] of finished) {
      if (turn.completedAt < binding.createdAt) continue;
      if (turnId === detail.shell.session?.activeTurnId) continue;
      if (this.repos.isRunTurn(binding.threadId, turnId) || this.repos.hasEventForTurn(binding.threadId, turnId)) continue;
      const messages = detail.messages.filter((m) => m.turnId === turnId && m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
      if (messages.length === 0) continue;
      const finalMessage = messages[messages.length - 1] as T3Message; // the last message, not the checkpoint's (see observeRun)
      // Null for turns the agent started itself (a background task finishing wakes it): see promptForTurn. Also null
      // when the prompt is already in the timeline as a note typed into the previous room turn (t3.message).
      const promptMessage = promptMessageForTurn(detail.messages, turnId);
      const prompt = promptMessage && this.repos.findEventIdForSource(binding.threadId, promptMessage.id) === null ? promptMessage.text : null;
      imports.push({
        turnId,
        completedAt: turn.completedAt,
        prompt,
        final: finalMessage.text.trim(),
        finalId: finalMessage.id,
        progress: messages.filter((m) => m !== finalMessage).map((m) => ({ text: m.text.trim(), at: m.createdAt })),
      });
    }
    if (imports.length === 0) return false;
    imports.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    this.db.transaction(() => {
      for (const turn of imports) {
        this.service.appendEvent({
          roomId: participant.roomId,
          kind: "t3.turn",
          speaker: { type: "participant", participantId: participant.id, bindingId: binding.id },
          text: turn.final,
          progress: turn.progress,
          prompt: turn.prompt,
          sourceRef: { threadId: binding.threadId, messageId: turn.finalId, turnId: turn.turnId },
          createdAt: turn.completedAt,
        });
      }
    });
    return true;
  }

  private syncNativeRequests(participant: Participant, binding: SessionBinding, detail: T3ThreadDetail): boolean {
    const open = new Map<string, { kind: "approval" | "user-input"; payload: unknown; createdAt: string }>();
    for (const activity of detail.activities) {
      const payload = activity.payload as { requestId?: string } | null;
      const requestId = payload?.requestId;
      if (!requestId) continue;
      if (activity.kind === "approval.requested") open.set(requestId, { kind: "approval", payload: activity.payload, createdAt: activity.createdAt });
      if (activity.kind === "user-input.requested") open.set(requestId, { kind: "user-input", payload: activity.payload, createdAt: activity.createdAt });
      if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") open.delete(requestId);
    }
    let changed = false;
    this.db.transaction(() => {
      for (const existing of this.repos.listOpenNativeRequests([participant.id])) {
        if (!open.has(existing.requestId)) {
          this.repos.resolveNativeRequest(existing.threadId, existing.requestId);
          changed = true;
        }
      }
      for (const [requestId, request] of open) {
        if (this.repos.upsertNativeRequest({ participantId: participant.id, threadId: binding.threadId, requestId, kind: request.kind, payload: request.payload, createdAt: request.createdAt })) {
          changed = true;
        }
      }
    });
    return changed;
  }

  /**
   * Notes the user types in T3 Code into a turn the room started (Claude delivers them inside the running turn, so
   * the room's reply answers them too) appear in the timeline as "t3.message" events with their images, ahead of the
   * reply. Display only: never delivered in briefings. The room's own prompts and steers on the thread are skipped,
   * as is anything after the turn's final answer (that is the next turn's prompt).
   */
  private importMidTurnMessages(run: Run, task: Task, participant: Participant, binding: SessionBinding, detail: T3ThreadDetail, completed: boolean): boolean {
    const own = detail.messages.find((m) => m.id === run.messageId);
    if (!own) return false;
    const finalAt = completed
      ? (detail.messages.filter((m) => m.turnId === run.turnId && m.role === "assistant" && !m.streaming).at(-1)?.createdAt ?? null)
      : null;
    const notes = detail.messages.filter(
      (m) =>
        m.role === "user" &&
        m.id !== run.messageId &&
        m.createdAt > own.createdAt &&
        (m.turnId === null || m.turnId === run.turnId) &&
        (finalAt === null || m.createdAt <= finalAt) &&
        (m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0) &&
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
          attachmentIds: (note.attachments ?? []).map((a) => a.id),
          sourceRef: { threadId: binding.threadId, messageId: note.id, turnId: run.turnId },
          createdAt: note.createdAt,
        });
      }
    });
    return true;
  }

  private async observeRun(
    run: Run,
    participant: Participant,
    binding: SessionBinding,
    shell: T3ThreadShell,
    loadDetail: () => Promise<T3ThreadDetail | null>,
  ): Promise<boolean> {
    const task = this.repos.getTask(run.taskId);
    if (!task) return false;

    // Resolve the turn id from our message id. T3 never stamps the user message; see adapter/correlate.ts.
    if (run.turnId === null) {
      let detail = await loadDetail();
      const knownTurns = this.turnRequests.get(binding.threadId);
      let resolution: TurnResolution = detail ? resolveTurnForMessage(detail, run.messageId, knownTurns) : { kind: "missing" };
      if (resolution.kind === "missing" && detail) {
        // The windowed read may not reach our message if other turns happened since; read the full thread once.
        detail = await this.adapter.getThreadDetail(binding.threadId);
        resolution = detail ? resolveTurnForMessage(detail, run.messageId, knownTurns) : { kind: "missing" };
      }
      if (resolution.kind === "missing") {
        if (run.status === "dispatched") {
          // Acknowledgement was lost and T3 does not show the message: resend identically.
          await this.send(run, task, participant, binding);
          return true;
        }
        // Accepted by T3 but the message never materialised: fail visibly after a bounded wait instead of hanging.
        const waitedMs = Date.now() - Date.parse(run.acceptedAt ?? run.createdAt);
        if (waitedMs > ACCEPT_WITHOUT_TURN_TIMEOUT_MS) {
          const reason = "T3 accepted the command but never recorded the message; check the provider in T3 and retry";
          this.db.transaction(() => {
            this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: reason, updatedAt: now() });
            this.service.setTaskState(task, "failed", reason, { currentRunId: run.id });
            this.service.statusEvent(task, `${taskLabel(task)} failed: ${reason}`, run.id);
            this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} failed to start`);
          });
          return true;
        }
        return false;
      }
      if (resolution.kind === "not_started" || resolution.kind === "superseded") {
        // Message recorded but no turn for it. A provider start failure shows up as a session error; surface it.
        const startFailed = (shell.session?.status === "error" && shell.session.activeTurnId === null) || resolution.kind === "superseded";
        const waitedMs = Date.now() - Date.parse(run.acceptedAt ?? run.createdAt);
        if (startFailed || waitedMs > ACCEPT_WITHOUT_TURN_TIMEOUT_MS) {
          const reason =
            resolution.kind === "superseded"
              ? "T3 recorded the message but no turn ran for it before another message was sent"
              : startFailed
                ? `provider failed to start the turn: ${shell.session?.lastError ?? "unknown error"}`
                : "T3 recorded the message but no turn started within the wait limit";
          this.db.transaction(() => {
            this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: reason, updatedAt: now() });
            this.service.setTaskState(task, "failed", reason, { currentRunId: run.id });
            this.service.statusEvent(task, `${taskLabel(task)} failed: ${reason}`, run.id);
            this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} failed to start`);
          });
          return true;
        }
        if (run.status !== "accepted") {
          this.repos.updateRun({ ...run, status: "accepted", acceptedAt: run.acceptedAt ?? now(), updatedAt: now() });
          return true;
        }
        return false;
      }
      const turnId = resolution.turnId;
      const started: Run = { ...run, status: "running", turnId, acceptedAt: run.acceptedAt ?? now(), startedAt: now(), updatedAt: now() };
      this.db.transaction(() => {
        this.repos.updateRun(started);
        this.service.setTaskState(task, "running", `running on @${participant.alias}`, { currentRunId: run.id });
        this.service.statusEvent(task, `${taskLabel(task)} started on @${participant.alias}`, run.id);
      });
      // Fall through with the resolved turn so a turn that already finished is settled in this same tick.
      run = started;
    }

    // Correlate the outcome of our specific turn.
    let outcome: "running" | "completed" | "error" | "interrupted" | null = null;
    let errorText: string | null = null;
    if (shell.latestTurn?.turnId === run.turnId) {
      outcome = shell.latestTurn.state;
      errorText = shell.session?.lastError ?? null;
    } else {
      // The thread list read at the start of the tick can be older than the detail read since (a turn that just
      // started is in the detail but not yet in the list): decide from the fresher detail shell.
      const detail = await loadDetail();
      const fresh = detail?.shell ?? shell;
      const checkpoint = detail?.checkpoints.find((c) => c.turnId === run.turnId);
      const startedMs = Date.now() - Date.parse(run.startedAt ?? run.acceptedAt ?? run.createdAt);
      if (fresh.latestTurn?.turnId === run.turnId) {
        outcome = fresh.latestTurn.state;
        errorText = fresh.session?.lastError ?? null;
      } else if (checkpoint) {
        outcome = checkpoint.status === "error" ? "error" : "completed";
      } else if (fresh.session?.activeTurnId === run.turnId || shell.session?.activeTurnId === run.turnId) {
        outcome = "running";
      } else if (startedMs < TURN_VANISH_GRACE_MS) {
        // Just started and not visible yet in every read: wait instead of declaring it gone.
        outcome = "running";
      } else {
        // Our turn is neither active nor recorded: treat as failed with a visible reason rather than guessing success.
        outcome = "error";
        errorText = `${VANISHED_TURN} (thread may have been reverted or history rewritten)`;
      }
    }

    if (outcome === "running") {
      // Notes the user types into this turn in T3 show up while it runs, not only when it ends.
      let noted = false;
      const stamp = `${shell.updatedAt}|${shell.latestUserMessageAt ?? ""}`;
      const lastScan = this.midTurnScans.get(binding.id);
      if (!lastScan || lastScan.stamp !== stamp || Date.now() - lastScan.at >= MID_TURN_SCAN_MS) {
        this.midTurnScans.set(binding.id, { at: Date.now(), stamp });
        const scanned = await loadDetail();
        if (scanned) noted = this.importMidTurnMessages(run, task, participant, binding, scanned, false);
      }
      const needsInput = shell.hasPendingApprovals || shell.hasPendingUserInput;
      const nextStatus: Run["status"] = needsInput ? "needs_input" : "running";
      if (run.status === nextStatus && task.state === (needsInput ? "needs_input" : "running")) return noted;
      this.db.transaction(() => {
        this.repos.updateRun({ ...run, status: nextStatus, updatedAt: now() });
        this.service.setTaskState(task, needsInput ? "needs_input" : "running", needsInput ? `@${participant.alias} is waiting for a native permission or question` : `running on @${participant.alias}`, { currentRunId: run.id });
        if (needsInput && task.state !== "needs_input") this.service.statusEvent(task, `${taskLabel(task)} needs input from you in T3 or the room`, run.id);
      });
      return true;
    }

    const detail = await loadDetail();
    if (detail) this.importMidTurnMessages(run, task, participant, binding, detail, true);
    this.midTurnScans.delete(binding.id);
    const checkpoint = detail?.checkpoints.find((c) => c.turnId === run.turnId);
    // T3 keeps each assistant message of a turn separately: progress notes between tool calls, then the final answer.
    // The final one is the reply (and what dependents receive); the earlier ones are kept as progress.
    const turnMessages = (detail?.messages ?? []).filter((m) => m.turnId === run.turnId && m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
    // The final answer is the turn's LAST assistant message. Not checkpoint.assistantMessageId: T3 attaches a checkpoint
    // to the message the file changes belong to, which can be an earlier progress note (verified live 2026-09-24).
    const finalMessage = turnMessages[turnMessages.length - 1] ?? null;
    const replyText = finalMessage?.text.trim() ?? "";
    const progress = turnMessages.filter((m) => m !== finalMessage).map((m) => ({ text: m.text.trim(), at: m.createdAt }));
    const assistantMessageId = finalMessage?.id ?? `assistant:${run.turnId}`;
    const artifacts = (checkpoint?.files ?? []).map((file) => ({ path: file.path, kind: file.kind, additions: file.additions, deletions: file.deletions }));
    if (shell.branch) artifacts.push({ path: "", kind: "branch", additions: 0, deletions: 0 });

    this.db.transaction(() => {
      // A steered turn answers several tasks with one final message: the first run to finish records the reply and
      // the others point at the same event.
      let resultEventId: string | null = this.repos.findEventIdForSource(binding.threadId, assistantMessageId);
      if (replyText.length > 0 && resultEventId === null) {
        const event = this.service.appendEvent({
          roomId: task.roomId,
          kind: "assistant.reply",
          speaker: { type: "participant", participantId: participant.id, bindingId: binding.id },
          text: replyText,
          taskId: task.id,
          runId: run.id,
          artifacts: artifacts.filter((a) => a.path !== ""),
          progress,
          sourceRef: { threadId: binding.threadId, messageId: assistantMessageId, turnId: run.turnId },
        });
        resultEventId = event.id;
      }
      const status: Run["status"] = outcome === "completed" ? "succeeded" : outcome === "interrupted" ? "interrupted" : "failed";
      this.repos.updateRun({ ...run, status, completedAt: now(), resultEventId, error: outcome === "error" ? errorText ?? "provider reported an error" : null, updatedAt: now() });
      if (status === "succeeded") {
        this.repos.updateBinding({ ...binding, deliveredCursor: Math.max(binding.deliveredCursor, run.includedToSequence) });
        this.service.setTaskState(task, "succeeded", "completed", { currentRunId: run.id });
        this.service.statusEvent(task, `${taskLabel(task)} succeeded on @${participant.alias}${artifacts.length > 0 ? ` (${artifacts.filter((a) => a.path).length} file(s) changed)` : ""}`, run.id);
      } else {
        const reason = status === "interrupted" ? "interrupted" : `failed: ${errorText ?? "provider error"}`;
        // Context delivered before the failure is still delivered; do not replay it on retry.
        this.repos.updateBinding({ ...binding, deliveredCursor: Math.max(binding.deliveredCursor, run.includedToSequence) });
        this.service.setTaskState(task, status, reason, { currentRunId: run.id });
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
      // Steering: send into the turn that is running now (T3 feeds it to the same provider turn). Only into a turn that
      // has started (not one still being dispatched), never while a native approval or question is open, and only on a
      // thread that already received the room's bootstrap briefing.
      const turnRunning = status?.session === "running" && !status.pendingApprovals && !status.pendingUserInput;
      if (task.delivery === "steer" && turnRunning && binding.bootstrapDeliveredAt !== null && !this.hasUnstartedRun(participant.id)) {
        const run = this.prepareRun(room, task, participant, binding, tasks, readiness.results, { steer: true });
        await this.send(run, task, participant, binding);
        touched.add(room.id);
        continue;
      }
      if (busyParticipants.has(participant.id) || sessionBusy) {
        const reason = `waiting for @${participant.alias} (${busyParticipants.has(participant.id) ? "busy with room work" : "busy in T3"})`;
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
      const run = this.prepareRun(room, task, participant, binding, tasks, readiness.results, { browsers });
      await this.send(run, task, participant, binding);
      touched.add(room.id);
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
          return { kind: "blocked", reason: `prerequisite ${taskLabel(prerequisite)} ${prerequisite.state}` };
        default:
          waiting.push(taskLabel(prerequisite));
      }
    }
    if (waiting.length > 0) return { kind: "waiting", reason: `waiting for ${waiting.join(", ")}` };
    return { kind: "ready", results };
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

  /**
   * A run failed because T3 did not report its turn may have been a false alarm (reads disagreeing for a moment). If
   * the turn shows up afterwards, resume tracking it instead of leaving work that is actually running as failed; a
   * retry that is queued but not yet sent is dropped, so the task is not delivered twice. Runs whose task already
   * sent a newer attempt are left alone (that duplicate cannot be recalled).
   */
  private async reviveVanishedRuns(participant: Participant, binding: SessionBinding, loadDetail: () => Promise<T3ThreadDetail | null>): Promise<boolean> {
    const since = Date.now() - VANISHED_RECHECK_MS;
    const candidates = this.repos
      .listRunsByStatus(["failed"])
      .filter((run) => run.bindingId === binding.id && run.turnId !== null && (run.error ?? "").startsWith(VANISHED_TURN) && Date.parse(run.completedAt ?? run.updatedAt) >= since);
    if (candidates.length === 0) return false;
    const detail = await loadDetail();
    if (!detail) return false;
    let changed = false;
    for (const run of candidates) {
      const visible =
        detail.shell.latestTurn?.turnId === run.turnId ||
        detail.shell.session?.activeTurnId === run.turnId ||
        detail.checkpoints.some((c) => c.turnId === run.turnId) ||
        detail.messages.some((m) => m.turnId === run.turnId);
      if (!visible) continue;
      const task = this.repos.getTask(run.taskId);
      if (!task) continue;
      const newer = this.repos.listRunsForTask(task.id).some((other) => other.attempt > run.attempt);
      const revivable = !newer && (task.state === "failed" || task.state === "queued") && (task.currentRunId === null || task.currentRunId === run.id);
      if (!revivable) continue;
      this.db.transaction(() => {
        this.repos.updateRun({ ...run, status: "running", error: null, completedAt: null, updatedAt: now() });
        const wasRetry = task.state === "queued";
        this.service.setTaskState(task, "running", `running on @${participant.alias}`, { currentRunId: run.id });
        this.service.statusEvent(
          task,
          `${taskLabel(task)}: T3 does report its turn after all; tracking attempt ${run.attempt} again${wasRetry ? " (the queued retry was not sent)" : ""}`,
          run.id,
        );
        for (const dependent of dependentsOf(task.id, this.repos.listTasks(task.roomId))) {
          if (dependent.state === "blocked" && (dependent.stateReason ?? "").includes(taskLabel(task))) {
            this.service.setTaskState(dependent, "queued", `waiting for ${taskLabel(task)}`);
          }
        }
      });
      changed = true;
    }
    return changed;
  }

  /** A room run for this participant that T3 has not started a turn for yet: steering must wait for it. */
  private hasUnstartedRun(participantId: string): boolean {
    return this.repos
      .listRunsByStatus(["pending", "dispatched", "accepted"])
      .some((run) => this.repos.getTask(run.taskId)?.participantId === participantId && run.turnId === null);
  }

  private prepareRun(
    room: Room,
    task: Task,
    participant: Participant,
    binding: SessionBinding,
    tasks: Map<string, Task>,
    prerequisiteResults: PrerequisiteResult[],
    options: { steer?: boolean; browsers?: BrowsersBriefing | null } = {},
  ): Run {
    if (options.steer) return this.prepareSteerRun(room, task, participant, binding);
    if (task.slashCommand) return this.prepareSteerRun(room, task, participant, binding, { verbatim: true });
    return this.db.transaction(() => {
      const current = this.repos.getRoom(room.id) as Room;
      const cutoff = current.nextSequence - 1;
      const participantsById = new Map(this.repos.listParticipants(room.id).map((p) => [p.id, p]));
      const unseen = this.repos
        .listEvents(room.id, binding.deliveredCursor + 1, cutoff)
        .filter((event) => BRIEFING_EVENT_KINDS.has(event.kind))
        .filter((event) => !(event.speaker.type === "participant" && event.speaker.bindingId === binding.id))
        // The user's message that is nothing but this assignment would be delivered twice (as a room message and as
        // the assignment); the assignment section alone carries it. Split messages stay: they show the others' parts.
        .filter((event) => event.id !== task.sourceEventId || !this.sourceIsOnlyThisAssignment(event, task));
      const briefing = assembleBriefing({
        room: current,
        participant,
        role: participant.roleId ? this.repos.getRole(participant.roleId) : null,
        participantsById,
        task,
        unseenEvents: unseen,
        prerequisiteResults,
        attachmentNames: task.attachmentIds.map((id) => this.repos.getAttachment(id)?.name ?? "image"),
        bootstrap: binding.bootstrapDeliveredAt === null,
        budgetChars: this.options.briefingBudgetChars,
        browsers: options.browsers ?? null,
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
        turnId: null,
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
      this.service.setTaskState(task, "dispatching", `sending to @${participant.alias}${briefing.condensed ? " (older context condensed)" : ""}`, { currentRunId: run.id });
      void tasks;
      return run;
    });
  }

  /**
   * A message sent into the participant's running turn. The session already holds the room briefing and the context
   * of the turn, so this is only the user's words (plus images). It claims no room events as delivered: whatever the
   * participant has not seen yet still comes with its next ordinary briefing.
   */
  private prepareSteerRun(room: Room, task: Task, participant: Participant, binding: SessionBinding, options: { verbatim?: boolean } = {}): Run {
    return this.db.transaction(() => {
      // A slash command must be the whole turn text for the harness to run it, so it is sent exactly as written.
      const text = options.verbatim ? task.instruction : [
        `[T3 Rooms: the user added this to your current turn in room "${room.title}" (${taskLabel(task)})]`,
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
        turnId: null,
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
      // No modelSelection: T3 applies the thread's current model and options, so changes made in T3 Code take effect.
      await this.adapter.startTurn({
        commandId: run.commandId,
        threadId: run.threadId,
        messageId: run.messageId,
        text: run.briefing,
        ...(task.attachmentIds.length > 0 ? { images: this.loadImages(task.attachmentIds) } : {}),
        runtimeMode: participant.runtimeMode,
        interactionMode: participant.interactionMode,
        titleSeed: `${participant.alias}: ${task.instruction.slice(0, 60)}`,
      });
    } catch (error) {
      if (error instanceof T3Unavailable) {
        // Keep it pending; the next tick resends with the same command id.
        this.repos.updateRun({ ...run, status: "pending", updatedAt: now() });
        this.lastAdapterError = error.message;
        return;
      }
      if (error instanceof T3CommandRejected) {
        this.db.transaction(() => {
          this.repos.updateRun({ ...run, status: "failed", completedAt: now(), error: error.message, updatedAt: now() });
          this.service.setTaskState(task, "failed", `T3 rejected the dispatch: ${error.message}`, { currentRunId: run.id });
          this.service.statusEvent(task, `${taskLabel(task)} failed: T3 rejected the dispatch`, run.id);
          this.service.blockPendingDependents(task, `prerequisite ${taskLabel(task)} failed to dispatch`);
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
      this.service.setTaskState(task, "dispatching", `accepted by T3; waiting for @${participant.alias} to start`, { currentRunId: run.id });
      this.service.statusEvent(task, `${taskLabel(task)} delivered to @${participant.alias} (attempt ${run.attempt})`, run.id);
    });
  }
}
