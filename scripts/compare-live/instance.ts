/**
 * One Backroom instance as the runner drives it over its HTTP API: saved crew, a throwaway T3 project and room per
 * job, seating, the user's message, and the board the runner watches for member answers and the final report.
 *
 * Two drivers implement the same interface, and the runner selects one per side: LegacyInstance for the old runtime
 * (tasks and runs, the API at the B commit) and EngineInstance for ROOMS_ENGINE=1 (the journal: L4a's message path, L4b's
 * seats, L4c's read API in src/server/engineView.ts with the shapes of src/domain/engineView.ts).
 */
import { randomUUID } from "node:crypto";
import type { EnginePost, EngineRoomSnapshot, EngineRunDetail } from "../../src/domain/engineView.ts";
import type { ModelSelection, Participant, RoomEvent, RoomSnapshot, RuntimeMode, Task } from "../../src/domain/types.ts";

/** A post on the board as the runner needs it, the same shape on both sides. */
export interface BoardPost {
  id: string;
  number: number | null;
  /**
   * When it happened, by the side's own clock. Old side: the instance's record of it (it lags T3 by 2 to 58 s). New side:
   * T3's exact time of the turn it stands for (EnginePost.at), or, for a post with none (an explicit answer), when the
   * runner first saw it. The report's time in the measure is T3's message time on both sides, never this.
   */
  at: string;
  /** Where `at` came from: "instance" (old side), "t3" or "seen" (new side). */
  clock?: "instance" | "t3" | "seen";
  /** The member's alias, or "user". */
  from: string;
  fromConsigliere: boolean;
  /**
   * What the member said: on the old side every turn-end reply (assistant.reply); on the new side every output (a run's
   * final, an explicit `rooms-board answer`, a continuation, an idle settle; any disposition) and every note a T3 turn
   * the room did not start was imported as. Both are what the member said at the end of its work, whoever it reached.
   * On the new side the Consigliere's own `rooms-board note` counts too, for the report only: it is his way to the user
   * once the user's request is closed (the old board has no note command).
   */
  isAnswer: boolean;
  /** New side: how it came (output source "final", "answer", "continuation", "idle", "other"; "t3-turn"; or "note"). */
  via?: string;
  /** New side: what each request it named came to (answered, pending_activity, superseded, late, …). */
  claims?: string[];
  text: string;
}

/** One quiet sample of the instance: its pending work (empty = quiet on the instance's side), with what was read. */
export interface InstanceQuiet {
  pending: string[];
  /** New side: the journal's head when read; null on the old side. */
  head: number | null;
  detail?: Record<string, unknown>;
}

export interface InstanceDriver {
  readonly url: string;
  /** Which runtime the driver speaks to: the runner refuses an instance that turns out to run the other one. */
  readonly runtime: "legacy" | "engine";
  ensurePreset(name: string, modelSelection: ModelSelection, runtimeMode: RuntimeMode): Promise<string>;
  setConsiglierePreset(presetId: string): Promise<void>;
  createProject(workspaceRoot: string, title: string): Promise<string>;
  /** T3's project for a folder with this title, as the instance lists T3's projects; null when T3 has none. */
  findProject(workspaceRoot: string, title: string): Promise<string | null>;
  /** A room with the Consigliere seated and marked. */
  createRoom(projectId: string, title: string): Promise<{ roomId: string; consigliere: { id: string; alias: string; threadId: string } }>;
  seat(roomId: string, presetId: string, alias: string): Promise<{ id: string; alias: string; threadId: string }>;
  /**
   * Post the user's message to the Consigliere, as the page's composer does. `clientMessageId` is the message's own ID
   * on the new side (sending again with it records nothing twice); the old runtime has none and ignores it.
   */
  postAsUser(roomId: string, text: string, clientMessageId: string): Promise<{ requestIds: string[] }>;
  posts(roomId: string): Promise<BoardPost[]>;
  /** Work the instance still has for the room: on the old side, tasks queued, dispatching, running or waiting on input. */
  pendingWork(roomId: string): Promise<string[]>;
  /** pendingWork with what was read for it, for the quiet samples. */
  quiet(roomId: string): Promise<InstanceQuiet>;
  /** Seat briefings answered and nothing pending: seating is over. */
  seatingDone(roomId: string): Promise<boolean>;
  /** Run a rooms-board command as a member (the dry run plays the Consigliere with it). */
  board(argv: string[], as: string): Promise<string>;
  /** A thread as the instance's own T3 adapter shows it (the dry run's T3 is the fake inside the instance). */
  thread(threadId: string): Promise<InstanceThreadView>;
  /** The room as the instance records it, with the runs and the briefings it sent: the evidence's instance-room.json. */
  roomRecord(roomId: string): Promise<Record<string, unknown>>;
}

export interface InstanceThreadView {
  thread: { status: string; activeRunId: string | null; pendingRequest: unknown; pendingBackgroundTasks: unknown[] };
  items: Array<{ kind: string; id: string; runId?: string; text: string; at: string }>;
}

/** HTTP to one instance, and the routes both runtimes serve the same way (presets, projects, the board CLI, threads). */
abstract class HttpInstance {
  readonly url: string;
  /** browser-api.json's token, for the board API. */
  protected readonly boardToken: string | null;
  private readonly fetcher: typeof fetch;

  constructor(url: string, boardToken: string | null = null, fetcher: typeof fetch = fetch) {
    this.url = url.replace(/\/$/, "");
    this.boardToken = boardToken;
    this.fetcher = fetcher;
  }

  protected async request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`, response.status);
    return (text ? JSON.parse(text) : null) as T;
  }

  command<T = Record<string, unknown>>(command: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", "/api/commands", command);
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

  async findProject(workspaceRoot: string, title: string): Promise<string | null> {
    const projects = await this.request<Array<{ id: string; title: string; workspaceRoot: string }>>("GET", "/api/t3/projects");
    const root = workspaceRoot.replace(/\/+$/, "");
    return projects.find((p) => p.workspaceRoot.replace(/\/+$/, "") === root && p.title === title)?.id ?? null;
  }

  async board(argv: string[], as: string): Promise<string> {
    if (!this.boardToken) throw new Error("no board token");
    const result = await this.request<{ text: string }>("POST", "/api/board-tools", { argv, as }, { authorization: `Bearer ${this.boardToken}` });
    return result.text;
  }

  thread(threadId: string): Promise<InstanceThreadView> {
    return this.request("GET", `/api/threads/${encodeURIComponent(threadId)}`);
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PENDING: ReadonlySet<Task["state"]> = new Set(["queued", "dispatching", "running", "needs_input"]);

export class LegacyInstance extends HttpInstance implements InstanceDriver {
  readonly runtime = "legacy" as const;

  snapshot(roomId: string): Promise<RoomSnapshot> {
    return this.request<RoomSnapshot>("GET", `/api/rooms/${encodeURIComponent(roomId)}`);
  }

  async createRoom(projectId: string, title: string) {
    const result = await this.command<{ roomId?: string }>({ type: "room.create", projectId, title, consigliere: true });
    if (!result.roomId) throw new Error(`room.create gave no room id: ${JSON.stringify(result)}`);
    const snapshot = await this.snapshot(result.roomId);
    if ((snapshot as { engine?: unknown }).engine === true) throw new Error(`${this.url} runs the engine (ROOMS_ENGINE=1): not an old-side instance`);
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

  async postAsUser(roomId: string, text: string): Promise<{ requestIds: string[] }> {
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
    return { requestIds: [] };
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
          clock: "instance" as const,
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

  /** One run of the room with the briefing the instance sent (the room snapshot leaves briefings out). */
  run(roomId: string, runId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`);
  }

  async quiet(roomId: string): Promise<InstanceQuiet> {
    return { pending: await this.pendingWork(roomId), head: null };
  }

  async roomRecord(roomId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot(roomId);
    const runs = await Promise.all(snapshot.runs.map((run) => this.run(roomId, run.id)));
    return { ...snapshot, runs };
  }
}

// ---------------- the new side: ROOMS_ENGINE=1 ----------------

/** The members of an engine room by seat: alias, and whether the seat is the Consigliere's (any of his bindings). */
function seatsOf(snapshot: EngineRoomSnapshot): { alias: Map<string, string>; consigliere: Set<string> } {
  const consigliereId = snapshot.room.consigliereId;
  const byParticipant = new Map(snapshot.participants.map((p) => [p.id, p.alias]));
  const alias = new Map(snapshot.seats.map((s) => [s.seatId, s.alias ?? (s.participantId ? byParticipant.get(s.participantId) : undefined) ?? s.seatId]));
  const consigliere = new Set(snapshot.seats.filter((s) => consigliereId !== null && s.participantId === consigliereId).map((s) => s.seatId));
  return { alias, consigliere };
}

/**
 * The journal's posts as the board the runner watches. What a member said is every output (a run's final, and before
 * H5 an explicit `rooms-board answer`, a continuation, an idle settle; whatever it came to) and every note or follow-up
 * a T3 turn the room did not start was imported as: the old side's every turn-end reply, so T2's "V reviewed before the
 * report" and the report rule read the same on both sides. A post's time is T3's exact time when it has one, else when
 * the runner first saw it.
 */
export function engineBoardPosts(snapshot: EngineRoomSnapshot, firstSeen: (post: EnginePost) => string): BoardPost[] {
  const { alias, consigliere } = seatsOf(snapshot);
  return snapshot.posts.map((post) => {
    const bySeat = !post.author.startsWith("$");
    const turnNote = post.kind === "note" && post.note?.source === "t3-turn";
    // Since H5 the reply of a turn the room did not start is a follow-up post (progress, milestone follow-up), with its T3 turn.
    const followUp = post.kind === "progress" && post.progress?.milestone === "follow-up" && post.progress.t3 !== null;
    // His own `rooms-board note`: a report there is seen (and fails for lack of a T3 message), not missed.
    const consigliereNote = post.kind === "note" && post.note?.source === "post" && consigliere.has(post.author);
    return {
      id: post.id,
      number: post.number,
      at: post.at ?? firstSeen(post),
      clock: post.at ? ("t3" as const) : ("seen" as const),
      from: post.author === "$user" ? "user" : bySeat ? (alias.get(post.author) ?? post.author) : post.author.replace(/^\$/, ""),
      fromConsigliere: bySeat && consigliere.has(post.author),
      isAnswer: bySeat && (post.kind === "output" || turnNote || followUp || consigliereNote),
      ...(post.kind === "output" ? { via: post.output?.source ?? "other", claims: (post.output?.claims ?? []).map((c) => c.outcome) } : turnNote || followUp ? { via: "t3-turn", claims: [] } : consigliereNote ? { via: "note", claims: [] } : {}),
      text: post.body,
    };
  });
}

/**
 * The instance's half of the quiet rule on the new side (plan R0, "The job window"): no unread addressed input and no
 * unresolved run, the journal's own two counts (fold-backed; a run in any phase but terminal is unresolved, rejected
 * included), and no open approval or question the instance holds for a member. Never the busy or waiting figures (they
 * miss runs that are not a seat's active run). A read where the instance could not reach T3 is not quiet either.
 */
export function engineQuiet(snapshot: EngineRoomSnapshot): InstanceQuiet {
  const pending: string[] = [];
  const { alias } = seatsOf(snapshot);
  if (snapshot.counts.unread > 0) {
    const seats = snapshot.seats.filter((s) => s.unread > 0).map((s) => `@${alias.get(s.seatId)}:${s.unread}`);
    pending.push(`unread:${snapshot.counts.unread}${seats.length ? `(${seats.join(",")})` : ""}`);
  }
  if (snapshot.counts.unresolvedRuns > 0) {
    const runs = snapshot.runs.filter((r) => r.phase !== "terminal").map((r) => `@${alias.get(r.seatId)}:${r.phase}`);
    pending.push(`unresolvedRuns:${snapshot.counts.unresolvedRuns}${runs.length ? `(${runs.join(",")})` : ""}`);
  }
  for (const request of snapshot.nativeRequests) pending.push(`native:${request.kind}:${request.requestId}`);
  if (!snapshot.t3.reachable) pending.push("t3-unreachable");
  return {
    pending,
    head: snapshot.head,
    detail: {
      unread: snapshot.counts.unread,
      unresolvedRuns: snapshot.counts.unresolvedRuns,
      // Not part of the rule (plan: member-held work does not hold the window open); recorded for Z1's behaviour checks.
      openRequests: snapshot.counts.openRequests,
      pendingActivities: snapshot.seats.flatMap((s) => s.activities.map((a) => `${a.id}@${alias.get(s.seatId)}${a.memberHeld ? ":held" : ""}`)),
    },
  };
}

/** Seating on the new side is over when every member but the Consigliere has answered its seat briefing and nothing is pending. */
export function engineSeatingDone(snapshot: EngineRoomSnapshot): boolean {
  const consigliereId = snapshot.room.consigliereId;
  const members = snapshot.seats.filter((s) => s.status === "active" && s.participantId !== consigliereId);
  if (members.length === 0) return false;
  const briefings = new Map(snapshot.posts.flatMap((p) => (p.kind === "request" && p.request ? [[p.request.id, p.request.state] as const] : [])));
  const briefed = members.every((s) => {
    const state = briefings.get(`seat-briefing:${s.seatId}:seated`);
    return state !== undefined && state !== "open";
  });
  return briefed && engineQuiet(snapshot).pending.length === 0;
}

interface Draft {
  kind: string;
  preamble?: string;
  assignments?: Array<{ recipients: string[]; instruction: string; slashCommand?: boolean; delivery?: string }>;
}

/** Drives a ROOMS_ENGINE=1 instance: the journal through L4a's message path and L4c's read API. */
export class EngineInstance extends HttpInstance implements InstanceDriver {
  readonly runtime = "engine" as const;
  /** When the runner first saw each post: the time of a post T3 gives none (an explicit answer). */
  private readonly seenAt = new Map<string, string>();

  /** The room as the read API shows it, every post included; refused when the instance does not run the engine. */
  async snapshot(roomId: string): Promise<EngineRoomSnapshot> {
    const snapshot = await this.request<EngineRoomSnapshot>("GET", `/api/rooms/${encodeURIComponent(roomId)}?posts=5000`);
    if (snapshot?.engine !== true) throw new Error(`${this.url} does not run the engine (ROOMS_ENGINE=1): its room snapshot is the old one`);
    if (snapshot.earlier) throw new Error(`room ${roomId} has more than 5000 posts: the driver reads the board in one page`);
    return snapshot;
  }

  private seated(snapshot: EngineRoomSnapshot, participant: Participant) {
    const seat = snapshot.seats.find((s) => s.participantId === participant.id && s.status === "active");
    if (!seat) throw new Error(`@${participant.alias} has no seat on the journal: creating a member should seat it`);
    return { id: participant.id, alias: participant.alias, threadId: seat.threadId };
  }

  async createRoom(projectId: string, title: string) {
    const result = await this.command<{ roomId?: string }>({ type: "room.create", projectId, title, consigliere: true });
    if (!result.roomId) throw new Error(`room.create gave no room id: ${JSON.stringify(result)}`);
    const snapshot = await this.snapshot(result.roomId);
    const consigliere = snapshot.participants.find((p) => p.id === snapshot.room.consigliereId);
    if (!consigliere) throw new Error("the room has no Consigliere: is the Consigliere preset set?");
    const seat = this.seated(snapshot, consigliere);
    if (!snapshot.seats.some((s) => s.participantId === consigliere.id && s.orchestrator)) throw new Error(`@${consigliere.alias} is not the journal's orchestrator`);
    return { roomId: result.roomId, consigliere: seat };
  }

  /** Creating a member from the saved crew seats it on the journal, with its seat briefing (L4b); nothing is seated by hand. */
  async seat(roomId: string, presetId: string, alias: string) {
    const result = await this.command<{ participantId?: string }>({ type: "participant.fromPreset", roomId, presetId, alias });
    const snapshot = await this.snapshot(roomId);
    const participant = snapshot.participants.find((p) => p.id === result.participantId || (p.alias === alias && !p.retiredAt));
    if (!participant) throw new Error(`seating ${alias} failed: ${JSON.stringify(result)}`);
    return this.seated(snapshot, participant);
  }

  /**
   * The user's message, as the page's composer sends it on the engine (web/src/components/Composer.tsx): the draft from
   * /parse, then message.create with the draft's preamble and the message's client ID. In a room with a Consigliere the
   * parser gives him the whole text; anything else is refused before sending, and the request the journal recorded must
   * carry the text byte for byte. A send that fails on the way is sent again under the same ID, which records it once.
   */
  async postAsUser(roomId: string, text: string, clientMessageId: string): Promise<{ requestIds: string[] }> {
    const draft = await this.request<Draft>("POST", `/api/rooms/${encodeURIComponent(roomId)}/parse`, { text });
    const before = await this.snapshot(roomId);
    const consigliereId = before.room.consigliereId;
    const only = draft.assignments?.[0];
    if (draft.kind !== "task" || draft.assignments?.length !== 1 || !only || only.recipients.length !== 1 || only.recipients[0] !== consigliereId || only.slashCommand || only.instruction !== text || (draft.preamble ?? "") !== "") {
      throw new Error(`the composer would not send this to the Consigliere verbatim: ${JSON.stringify(draft).slice(0, 500)}`);
    }
    const command = {
      type: "message.create",
      roomId,
      sourceText: text,
      preamble: draft.preamble ?? "",
      clientMessageId,
      attachmentIds: [],
      assignments: [{ recipients: only.recipients, instruction: only.instruction, schedule: { mode: "now" }, after: [], slashCommand: false, delivery: only.delivery === "steer" ? "steer" : "queue" }],
    };
    let result: { requestIds?: string[] } | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await this.command<{ requestIds?: string[] }>(command);
        break;
      } catch (error) {
        // A refusal (4xx) is final; a failure on the way is sent again with the same client ID, which replays it.
        if ((error instanceof HttpError && error.status < 500) || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    const after = await this.snapshot(roomId);
    const made = after.posts.filter((p) => p.kind === "request" && p.request?.message?.id === clientMessageId);
    const seat = after.seats.find((s) => s.participantId === consigliereId && s.status === "active");
    if (made.length !== 1 || made[0]!.request!.owner !== seat?.seatId || made[0]!.body !== text) {
      throw new Error(`the message was not recorded as one request to the Consigliere carrying the text: ${JSON.stringify(made.map((p) => ({ id: p.id, owner: p.request?.owner, bytes: Buffer.byteLength(p.body) })))}`);
    }
    return { requestIds: result?.requestIds ?? made.map((p) => p.request!.id) };
  }

  async posts(roomId: string): Promise<BoardPost[]> {
    const snapshot = await this.snapshot(roomId);
    const now = new Date().toISOString();
    return engineBoardPosts(snapshot, (post) => {
      const seen = this.seenAt.get(post.id) ?? now;
      this.seenAt.set(post.id, seen);
      return seen;
    });
  }

  async pendingWork(roomId: string): Promise<string[]> {
    return (await this.quiet(roomId)).pending;
  }

  async quiet(roomId: string): Promise<InstanceQuiet> {
    return engineQuiet(await this.snapshot(roomId));
  }

  async seatingDone(roomId: string): Promise<boolean> {
    return engineSeatingDone(await this.snapshot(roomId));
  }

  /** One run with the briefing T3 was sent (its frozen dispatch; a resend sends the same). */
  run(roomId: string, runId: string): Promise<EngineRunDetail> {
    return this.request("GET", `/api/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`);
  }

  async roomRecord(roomId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot(roomId);
    const runs = await Promise.all(snapshot.runs.map((run) => this.run(roomId, run.id)));
    return { ...snapshot, runs };
  }
}
