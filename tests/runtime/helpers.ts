/**
 * A room on the engine host for tests/runtime: a dedicated SQLite journal in a temporary folder, the in-memory T3 fake
 * with runs completed by hand, and seats seated by the user. Every T3 run on a seat's thread is one wake of that seat,
 * so wake counts are read from the fake's runs, not from the journal.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeT3Adapter, type FakeRunCompletion } from "../../src/adapter/fake.ts";
import type { SendMessageInput, T3BackgroundTask, T3Run, T3Subagent, TurnImage } from "../../src/adapter/types.ts";
import type { Participant, Room as DomainRoom } from "../../src/domain/types.ts";
import { T3CommandRejected, T3Unavailable } from "../../src/adapter/types.ts";
import { EngineStore, unread } from "../../src/engine/index.ts";
import type { ClaimOutcome, Input, Projection, RoomEvent } from "../../src/engine/index.ts";
import { EngineHost, type BriefingSource, type EngineHostOptions, type HostStep } from "../../src/runtime/index.ts";

/** The fake T3 plus what these tests need: work left in the background at turn end, subagents, and send faults. */
export class RuntimeFake extends FakeT3Adapter {
  /** The next sends T3 refuses (a rejected command), then accepts. */
  refuseSends = 0;
  /** The next sends fail as an outage (T3 unreachable). */
  unavailableSends = 0;
  readonly sent: SendMessageInput[] = [];
  /** Runs once, the next time the host reads this thread: lets a test land a command in the middle of an import. */
  onDetail: { threadId: string; run: () => void | Promise<void> } | null = null;

  constructor() {
    super({ autoCompleteMs: null });
  }

  override async getThreadDetail(threadId: string) {
    const hook = this.onDetail;
    if (hook && hook.threadId === threadId) {
      this.onDetail = null;
      await hook.run();
    }
    return super.getThreadDetail(threadId);
  }

  /** Every send the host tried, refused or not: its command and message IDs. */
  readonly attempts: Array<{ threadId: string; commandId: string; messageId: string }> = [];

  override async sendMessage(input: SendMessageInput): Promise<void> {
    this.attempts.push({ threadId: input.threadId, commandId: input.commandId, messageId: input.messageId });
    if (this.unavailableSends > 0) {
      this.unavailableSends -= 1;
      throw new T3Unavailable("T3 is not reachable (simulated)");
    }
    if (this.refuseSends > 0) {
      this.refuseSends -= 1;
      throw new T3CommandRejected("T3 RPC orchestration.dispatchCommand failed: busy (simulated)", 500, null);
    }
    this.sent.push(structuredClone(input));
    return super.sendMessage(input);
  }

  thread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no thread ${threadId}`);
    return thread;
  }

  /** What T3 lists as still running after a turn: commands and monitors the provider left in the background. */
  background(threadId: string, taskIds: string[]): void {
    this.thread(threadId).shell.pendingBackgroundTasks = taskIds.map((taskId): T3BackgroundTask => ({ taskId, kind: "command", description: `background ${taskId}`, childThreadId: null }));
  }

  /** A subagent on the thread's active (or latest) run, in the given state. */
  subagent(threadId: string, id: string, status: T3Subagent["status"]): void {
    const thread = this.thread(threadId);
    const at = new Date().toISOString();
    const existing = thread.subagents.find((s) => s.id === id);
    if (existing) {
      existing.status = status;
      existing.updatedAt = at;
      return;
    }
    thread.subagents.push({ id, runId: thread.shell.activeRunId ?? thread.shell.latestRunId, origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent", childThreadId: null, title: `subagent ${id}`, model: null, prompt: "read the imported files", status, progress: null, result: null, startedAt: at, completedAt: null, updatedAt: at });
  }

  runsOf(threadId: string): T3Run[] {
    return this.thread(threadId).runs;
  }

  liveRun(threadId: string): T3Run | null {
    return this.thread(threadId).runs.find((r) => r.status === "running" || r.status === "queued" || r.status === "waiting" || r.status === "starting" || r.status === "preparing") ?? null;
  }

  promptOf(threadId: string, run: T3Run): string {
    return this.thread(threadId).messages.find((m) => m.id === run.userMessageId)?.text ?? "";
  }
}

export interface RoomOptions {
  seats?: string[];
  orchestrator?: string | null;
  host?: Partial<EngineHostOptions>;
  /** The images a post came with, by its body (what L4a will record with a request). */
  images?: (body: string) => TurnImage[];
  /** Members' aliases by seat, where they differ from the seat ID (as a binding ID does). */
  aliases?: Record<string, string>;
}

/** rooms.sqlite's side of a briefing for the test room: one member per seat, the orchestrator its Consigliere. */
function testSource(r: { room: string; seats: () => string[]; orchestrator: string | null; bodyOf: (eventId: string) => string | null }, images?: (body: string) => TurnImage[], aliases: Record<string, string> = {}): BriefingSource {
  const at = new Date(0).toISOString();
  const participant = (seat: string): Participant => ({ id: seat, roomId: r.room, alias: seat, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: at, updatedAt: at });
  const room: DomainRoom = { id: r.room, projectId: "project_demo", environmentId: null, title: "runtime", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: r.orchestrator, createdAt: at, updatedAt: at };
  return {
    standing: (_roomId, seatId) => ({ room, participant: participant(seatId), participantsById: new Map(r.seats().map((s) => [s, participant(s)])), board: { command: "/repo/bin/rooms-board", as: `${seatId}.key` } }),
    alias: (_roomId, seatId) => aliases[seatId] ?? seatId,
    images: (_roomId, eventId) => {
      const body = images ? r.bodyOf(eventId) : null;
      return body !== null && images ? images(body) : [];
    },
  };
}

export class Room {
  readonly dir = mkdtempSync(join(tmpdir(), "backroom-runtime-"));
  readonly path = join(this.dir, "board.sqlite");
  readonly room = "room";
  readonly fake = new RuntimeFake();
  readonly steps: HostStep[] = [];
  readonly logs: Array<{ message: string; detail: unknown }> = [];
  store: EngineStore;
  host: EngineHost;
  clock = 1_000_000;
  /** Throw here to crash the host after a committed step (the crash method). */
  crash: ((step: HostStep, at: { roomId: string; seatId: string; runId?: string }) => void) | null = null;
  private serial = 0;
  private readonly options: RoomOptions;

  private constructor(options: RoomOptions) {
    this.options = options;
    this.store = new EngineStore(this.path);
    this.host = this.makeHost();
  }

  static async create(options: RoomOptions = {}): Promise<Room> {
    const room = new Room(options);
    const seats = options.seats ?? ["C", "W", "V"];
    const orchestrator = options.orchestrator === undefined ? "C" : options.orchestrator;
    for (const seat of seats) {
      await room.fake.launchThread({ commandId: `launch:${seat}`, threadId: room.threadOf(seat), projectId: "project_demo", title: `room · ${seat}`, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });
      room.host.seat(room.room, { actor: "$user", id: `seat:${seat}`, seatId: seat, threadId: room.threadOf(seat), orchestrator: seat === orchestrator });
    }
    return room;
  }

  makeHost(): EngineHost {
    const seats = this.options.seats ?? ["C", "W", "V"];
    const orchestrator = this.options.orchestrator === undefined ? "C" : this.options.orchestrator;
    const bodyOf = (eventId: string) => {
      const d = this.store.project(this.room).events.find((e) => e.id === eventId)?.data;
      return d?.kind === "request" ? d.request.body : null;
    };
    return new EngineHost({
      store: this.store,
      adapter: this.fake,
      rooms: () => [this.room],
      briefing: testSource({ room: this.room, seats: () => seats, orchestrator, bodyOf }, this.options.images, this.options.aliases),
      now: () => this.clock,
      log: (message, detail) => this.logs.push({ message, detail }),
      onStep: (step, at) => {
        this.steps.push(step);
        this.crash?.(step, at);
      },
      ...this.options.host,
    });
  }

  /** Throw the host away and build a new one over the same SQLite file and the same fake T3. */
  restart(): void {
    this.host.close();
    this.store.close();
    this.crash = null;
    this.store = new EngineStore(this.path);
    this.host = this.makeHost();
  }

  close(): void {
    this.host.close();
    try {
      this.store.close();
    } catch {
      // already closed by a restart that failed half-way
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  threadOf(seat: string): string {
    return `thread:${seat}`;
  }

  id(prefix = "cmd"): string {
    return `${prefix}:${++this.serial}`;
  }

  get p(): Projection {
    return this.store.project(this.room);
  }

  /** Crashes recorded by `crashOnce`, in order: the step and the seat. */
  readonly crashes: string[] = [];
  private restartDue = false;

  /** Crash the host the first time `step` commits for `seatId`; the next tick builds a new host (the crash method). */
  crashOnce(step: HostStep, seatId: string): void {
    let done = false;
    this.crash = (s, at) => {
      if (done || s !== step || at.seatId !== seatId) return;
      done = true;
      this.crashes.push(`${s}:${at.seatId}`);
      this.restartDue = true;
      throw new Error(`simulated crash after ${s}`);
    };
  }

  async tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await this.host.tick();
      if (this.restartDue) {
        this.restartDue = false;
        this.restart();
      }
    }
  }

  /** Tick until the condition holds (at most `limit` ticks). */
  async until(condition: () => boolean, limit = 10): Promise<void> {
    for (let i = 0; i < limit && !condition(); i += 1) await this.tick();
    assert.ok(condition(), "condition not reached");
  }

  /** The user posts a request to a seat; returns its request ID. */
  user(to: string, body: string): string {
    const id = this.id("user");
    this.host.request(this.room, { actor: "$user", id, to, body });
    return id;
  }

  /** The orchestrator posts (L3's `rooms-board post`; members cannot since H5); returns the request ID. */
  post(actor: string, to: string, body: string): string {
    const id = this.id(`post-${actor}`);
    this.host.post(this.room, { actor, id, to, body });
    return id;
  }

  cancel(actor: string, requestId: string) {
    return this.host.cancel(this.room, { actor, id: this.id(`cancel-${actor}`), requestId });
  }

  /** Finish the seat's running T3 run with a final message. */
  complete(seat: string, text: string, extra: Omit<FakeRunCompletion, "text"> = {}): void {
    this.fake.completeRun(this.threadOf(seat), { text, ...extra });
  }

  running(seat: string): boolean {
    return this.fake.liveRun(this.threadOf(seat)) !== null;
  }

  /** Wakes of a seat: T3 runs on its thread. */
  wakes(seat: string): number {
    return this.fake.runsOf(this.threadOf(seat)).length;
  }

  /** The text T3 received for the seat's latest run. */
  prompt(seat: string): string {
    const runs = this.fake.runsOf(this.threadOf(seat));
    const last = runs[runs.length - 1];
    return last ? this.fake.promptOf(this.threadOf(seat), last) : "";
  }

  state(requestId: string): string | undefined {
    return this.p.requests.get(requestId)?.state;
  }

  unread(seat: string): Input[] {
    return unread(this.p, seat);
  }

  /** Every output event, with its claims. */
  outputs(): Array<Extract<RoomEvent["data"], { kind: "output" }>> {
    return this.p.events.flatMap((e) => (e.data.kind === "output" ? [e.data] : []));
  }

  /** Answers that woke someone for a request: answered claims. */
  answeredClaims(requestId: string): ClaimOutcome[] {
    return this.outputs().flatMap((o) => o.claims.filter((c) => c.requestId === requestId && c.outcome === "answered"));
  }

  notices(): Array<Extract<RoomEvent["data"], { kind: "notice" }>> {
    return this.p.events.flatMap((e) => (e.data.kind === "notice" ? [e.data] : []));
  }

  /** Engine runs of a seat that have not ended. */
  unresolvedRuns(): string[] {
    return [...this.p.runs.values()].filter((r) => r.phase !== "terminal").map((r) => `${r.seatId}:${r.phase}`);
  }

  pendingActivities(): string[] {
    return [...this.p.activities.values()].filter((a) => a.status === "pending" || a.status === "uncertain").map((a) => a.id);
  }

  /** Nothing left anywhere: no unresolved run, no pending activity, no unread input, no T3 run going. */
  assertQuiet(seats = ["C", "W", "V"]): void {
    assert.deepEqual(this.unresolvedRuns(), [], "unresolved runs");
    assert.deepEqual(this.pendingActivities(), [], "pending activities");
    for (const seat of seats) {
      assert.deepEqual(this.unread(seat).map((i) => `${i.intent}:${i.body.slice(0, 40)}`), [], `unread input for ${seat}`);
      assert.equal(this.running(seat), false, `${seat} still running in T3`);
    }
  }
}

