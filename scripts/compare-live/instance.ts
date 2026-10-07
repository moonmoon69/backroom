/**
 * One Backroom instance as the runner drives it over its HTTP API: saved crew, a throwaway T3 project and room per
 * job, seating, the user's message, and the board the runner watches for member answers and the final report.
 *
 * This is the old runtime's API (tasks and runs). The new runtime's user-message path and read API arrive with L4a and
 * L4c; a driver for them implements the same interface, and Z1 selects it per side.
 */
import type { ModelSelection, Participant, RoomEvent, RoomSnapshot, RuntimeMode, Task } from "../../src/domain/types.ts";

/** A post on the board as the runner needs it, the same shape on both sides. */
export interface BoardPost {
  id: string;
  number: number | null;
  at: string;
  /** The member's alias, or "user". */
  from: string;
  fromConsigliere: boolean;
  /** A member's turn-end reply (the old runtime's assistant.reply); on the new side, an answer. */
  isAnswer: boolean;
  text: string;
}

export interface InstanceDriver {
  readonly url: string;
  ensurePreset(name: string, modelSelection: ModelSelection, runtimeMode: RuntimeMode): Promise<string>;
  setConsiglierePreset(presetId: string): Promise<void>;
  createProject(workspaceRoot: string, title: string): Promise<string>;
  /** A room with the Consigliere seated and marked. */
  createRoom(projectId: string, title: string): Promise<{ roomId: string; consigliere: { id: string; alias: string; threadId: string } }>;
  seat(roomId: string, presetId: string, alias: string): Promise<{ id: string; alias: string; threadId: string }>;
  /** Post the user's message to the Consigliere, as the page's composer does. */
  postAsUser(roomId: string, text: string): Promise<void>;
  posts(roomId: string): Promise<BoardPost[]>;
  /** Work the instance still has for the room: on the old side, tasks queued, dispatching, running or waiting on input. */
  pendingWork(roomId: string): Promise<string[]>;
  /** Run a rooms-board command as a member (the dry run plays the Consigliere with it). */
  board(argv: string[], as: string): Promise<string>;
}

const PENDING: ReadonlySet<Task["state"]> = new Set(["queued", "dispatching", "running", "needs_input"]);

export class LegacyInstance implements InstanceDriver {
  readonly url: string;
  /** browser-api.json's token, for the board API. */
  private readonly boardToken: string | null;

  constructor(url: string, boardToken: string | null = null) {
    this.url = url.replace(/\/$/, "");
    this.boardToken = boardToken;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  command<T = Record<string, unknown>>(command: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", "/api/commands", command);
  }

  snapshot(roomId: string): Promise<RoomSnapshot> {
    return this.request<RoomSnapshot>("GET", `/api/rooms/${encodeURIComponent(roomId)}`);
  }

  async ensurePreset(name: string, modelSelection: ModelSelection, runtimeMode: RuntimeMode): Promise<string> {
    const presets = await this.request<Array<{ id: string; name: string }>>("GET", "/api/presets");
    const existing = presets.find((p) => p.name === name);
    if (existing) {
      await this.command({ type: "preset.update", presetId: existing.id, modelSelection, runtimeMode, workspaceMode: "local" });
      return existing.id;
    }
    await this.command({ type: "preset.create", name, modelSelection, runtimeMode, workspaceMode: "local" });
    const created = (await this.request<Array<{ id: string; name: string }>>("GET", "/api/presets")).find((p) => p.name === name);
    if (!created) throw new Error(`preset ${name} was not created`);
    return created.id;
  }

  async setConsiglierePreset(presetId: string): Promise<void> {
    await this.command({ type: "consigliere.preset.set", presetId });
  }

  async createProject(workspaceRoot: string, title: string): Promise<string> {
    const result = await this.command<{ projectId?: string }>({ type: "project.create", workspaceRoot, title, createIfMissing: false });
    if (!result.projectId) throw new Error(`project.create gave no project id: ${JSON.stringify(result)}`);
    return result.projectId;
  }

  async createRoom(projectId: string, title: string) {
    const result = await this.command<{ roomId?: string }>({ type: "room.create", projectId, title, consigliere: true });
    if (!result.roomId) throw new Error(`room.create gave no room id: ${JSON.stringify(result)}`);
    const snapshot = await this.snapshot(result.roomId);
    const consigliere = snapshot.participants.find((p) => p.id === snapshot.room.consigliereId);
    if (!consigliere) throw new Error("the room has no Consigliere: is the Consigliere preset set?");
    return { roomId: result.roomId, consigliere: this.member(snapshot, consigliere) };
  }

  async seat(roomId: string, presetId: string, alias: string) {
    const result = await this.command<{ participantId?: string }>({ type: "participant.fromPreset", roomId, presetId, alias });
    const snapshot = await this.snapshot(roomId);
    const participant = snapshot.participants.find((p) => p.id === result.participantId || p.alias === alias);
    if (!participant) throw new Error(`seating ${alias} failed: ${JSON.stringify(result)}`);
    return this.member(snapshot, participant);
  }

  private member(snapshot: RoomSnapshot, participant: Participant) {
    const binding = snapshot.bindings.find((b) => b.participantId === participant.id && b.retiredAt === null);
    if (!binding) throw new Error(`@${participant.alias} has no thread`);
    return { id: participant.id, alias: participant.alias, threadId: binding.threadId };
  }

  async postAsUser(roomId: string, text: string): Promise<void> {
    const draft = await this.request<{ kind: string; assignments?: Array<{ recipients: string[]; instruction: string; schedule?: unknown; after: Array<{ index: number }>; slashCommand?: boolean; delivery?: string }> }>(
      "POST",
      `/api/rooms/${encodeURIComponent(roomId)}/parse`,
      { text },
    );
    if (draft.kind !== "task" || !draft.assignments || draft.assignments.length === 0) throw new Error(`the composer would not send this: ${JSON.stringify(draft).slice(0, 500)}`);
    // The same command the page's composer builds from the draft (web/src/components/Composer.tsx).
    await this.command({
      type: "message.create",
      roomId,
      sourceText: text,
      attachmentIds: [],
      assignments: draft.assignments.map((a) => ({
        recipients: a.recipients,
        instruction: a.instruction,
        schedule: a.schedule ?? { mode: "now" },
        after: a.after.map((ref) => ref.index),
        slashCommand: Boolean(a.slashCommand),
        delivery: a.delivery === "steer" ? "steer" : "queue",
      })),
    });
  }

  async posts(roomId: string): Promise<BoardPost[]> {
    const snapshot = await this.snapshot(roomId);
    const alias = new Map(snapshot.participants.map((p) => [p.id, p.alias]));
    return snapshot.events
      .filter((e: RoomEvent) => e.postNumber !== null)
      .map((e: RoomEvent) => {
        const participantId = e.speaker.type === "participant" ? e.speaker.participantId : null;
        return {
          id: e.id,
          number: e.postNumber,
          at: e.createdAt,
          from: participantId ? (alias.get(participantId) ?? participantId) : e.speaker.type,
          fromConsigliere: participantId !== null && participantId === snapshot.room.consigliereId,
          isAnswer: e.kind === "assistant.reply",
          text: e.text,
        };
      });
  }

  async pendingWork(roomId: string): Promise<string[]> {
    const snapshot = await this.snapshot(roomId);
    return snapshot.tasks.filter((t) => PENDING.has(t.state)).map((t) => `task${t.number}:${t.state}`);
  }

  async seatingDone(roomId: string): Promise<boolean> {
    const snapshot = await this.snapshot(roomId);
    const seats = snapshot.tasks.filter((t) => t.kind === "seat");
    return seats.length > 0 && seats.every((t) => t.state === "succeeded");
  }

  async board(argv: string[], as: string): Promise<string> {
    if (!this.boardToken) throw new Error("no board token");
    const result = await this.request<{ text: string }>("POST", "/api/board-tools", { argv, as }, { authorization: `Bearer ${this.boardToken}` });
    return result.text;
  }

  /** One run of the room with the briefing the instance sent (the room snapshot leaves briefings out). */
  run(roomId: string, runId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`);
  }

  /** A thread as the instance's own T3 adapter shows it (the dry run's T3 is the fake inside the instance). */
  thread(threadId: string): Promise<{ thread: { status: string; activeRunId: string | null; pendingRequest: unknown; pendingBackgroundTasks: unknown[] }; items: Array<{ kind: string; id: string; runId?: string; text: string; at: string }> }> {
    return this.request("GET", `/api/threads/${encodeURIComponent(threadId)}`);
  }
}
