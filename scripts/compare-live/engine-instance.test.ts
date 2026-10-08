/**
 * R1: the new side's driver (EngineInstance in instance.ts) and what the runner and measure.ts do with it.
 *
 * - On a real ROOMS_ENGINE=1 stack (the fake T3, runs completed by hand, served by the real HTTP app): creating members
 *   seats them, seating ends when the seat briefings are answered, the prompt is one request to the Consigliere with the
 *   client message ID (sent again: recorded once), the board's answers and the report, the quiet read, the room record
 *   with the briefings sent; a report that answers nothing (yield) counts as on the old side; a report through
 *   `rooms-board answer` is marked so, with no T3 time.
 * - The quiet rule from the journal's two counts only (never busy or waiting), approvals, T3 unreachable.
 * - measure.ts: the briefing cross-check compares bytes on the new side, and fails a difference or a check of nothing;
 *   a report through `rooms-board answer` fails the accuracy check.
 * - The runner refuses an instance checkout that contains scripts/compare-live, paid and dry.
 * - The four prompts go to the Consigliere verbatim through the engine's parser.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FakeT3Adapter } from "../../src/adapter/fake.ts";
import { createStack, type AppStack } from "../../src/app/bootstrap.ts";
import { loadConfig } from "../../src/config.ts";
import type { EnginePost, EngineRoomSnapshot } from "../../src/domain/engineView.ts";
import { parseExplicit } from "../../src/parser/explicit.ts";
import { createHttpApp } from "../../src/server/http.ts";
import type { JobRecord } from "./campaign.ts";
import { CREW } from "./campaign.ts";
import { EngineInstance, engineBoardPosts, engineQuiet, engineSeatingDone, type BoardPost } from "./instance.ts";
import { measureJob, verifyJob } from "./measure.ts";
import { capClose, createJobProject, refuseTaintedCheckout } from "./run.ts";
import { T3Unavailable } from "../../src/adapter/types.ts";
import { TASKS, TASK_IDS, hasJobDoneLine } from "./tasks.ts";

const SCRATCH = join(import.meta.dirname, `.scratch-engine-${process.pid}`);
const SAMPLE = join(import.meta.dirname, "testdata", "job");

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// ---------------- a ROOMS_ENGINE=1 instance in process ----------------

interface Instance {
  stack: AppStack;
  fake: FakeT3Adapter;
  driver: EngineInstance;
  close(): void;
}

function engineInstance(name: string): Instance {
  const dir = join(SCRATCH, name);
  mkdirSync(join(dir, "folder"), { recursive: true });
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const stack = createStack({ dbPath: join(dir, "rooms.sqlite"), adapter: fake, briefingBudgetChars: 60000, latestRelease: async () => null });
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: join(dir, "data"), ROOMS_PORT: "0", T3_USERDATA_DIR: join(dir, "t3"), CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") });
  const app = createHttpApp(stack, config, "/nonexistent/dist", { tools: null, token: "board-token", command: "rooms-board" });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input).replace("http://instance", ""), init)) as typeof fetch;
  stack.engine.start(10);
  return { stack, fake, driver: new EngineInstance("http://instance", "board-token", fetcher), close: () => stack.close() };
}

const until = async <T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

/** Complete a thread's run once T3 has one, with the agent's final text. */
async function complete(i: Instance, threadId: string, text: string): Promise<void> {
  await until(`a run on ${threadId}`, async () => i.fake.threads.get(threadId)?.shell.activeRunId);
  i.fake.completeRun(threadId, { text });
}

/** A room with the Consigliere and W1, V seated from the saved crew, seating finished: as Job.run does it. */
async function seatedRoom(i: Instance) {
  const fable = await i.driver.ensurePreset(CREW.consigliere.name, CREW.consigliere.modelSelection, CREW.runtimeMode);
  const opus = await i.driver.ensurePreset(CREW.member.name, CREW.member.modelSelection, CREW.runtimeMode);
  await i.driver.setConsiglierePreset(fable);
  const projectId = await i.driver.createProject(join(SCRATCH, "folder"), `tally-${randomUUID().slice(0, 6)}`);
  const room = await i.driver.createRoom(projectId, "tally");
  const w1 = await i.driver.seat(room.roomId, opus, "W1");
  const v = await i.driver.seat(room.roomId, opus, "V");
  return { roomId: room.roomId, c: room.consigliere, w1, v };
}

async function finishSeating(i: Instance, r: Awaited<ReturnType<typeof seatedRoom>>): Promise<void> {
  assert.equal(await i.driver.seatingDone(r.roomId), false, "the seat briefings are not answered yet");
  await complete(i, r.w1.threadId, "Seated.");
  await complete(i, r.v.threadId, "Seated.");
  await until("seating done", () => i.driver.seatingDone(r.roomId));
}

/** The Consigliere's board key, from the briefing T3 received (as the dry run's DryConsigliere reads it). */
async function keyOf(i: Instance, threadId: string): Promise<string> {
  const view = await i.driver.thread(threadId);
  const key = /--as ([A-Za-z0-9._-]+)/.exec(view.items.find((item) => item.kind === "user")?.text ?? "")?.[1];
  assert.ok(key, "the Consigliere's briefing carries his board key");
  return key;
}

const said = (posts: BoardPost[], alias: string) => posts.filter((p) => p.from === alias && p.isAnswer);

describe("EngineInstance on a ROOMS_ENGINE=1 instance", () => {
  test("seating, the prompt with its client ID, answers, the JOB-DONE report, quiet, and the room record", async () => {
    const i = engineInstance("flow");
    try {
      const r = await seatedRoom(i);
      // Creating a member seats it on the journal; the Consigliere is the orchestrator and gets no seat briefing.
      const seated = await i.driver.snapshot(r.roomId);
      assert.deepEqual(seated.seats.map((s) => [s.alias, s.orchestrator]).sort(), [["Fable", true], ["V", false], ["W1", false]]);
      assert.equal(i.fake.threads.get(r.c.threadId)?.shell.activeRunId ?? null, null, "no seat briefing for the Consigliere");
      await finishSeating(i, r);
      assert.deepEqual((await i.driver.quiet(r.roomId)).pending, [], "nothing pending after seating");

      const before = await i.driver.posts(r.roomId);
      const clientMessageId = randomUUID();
      const posted = await i.driver.postAsUser(r.roomId, TASKS.T1.prompt, clientMessageId);
      assert.equal(posted.requestIds.length, 1);
      assert.match(posted.requestIds[0]!, new RegExp(`^steer:${clientMessageId}:0:`), "a steered request under the client ID");
      // Sent again under the same client ID (a send that failed on the way): recorded once.
      await i.driver.postAsUser(r.roomId, TASKS.T1.prompt, clientMessageId);
      const requests = (await i.driver.snapshot(r.roomId)).posts.filter((p) => p.request?.message?.id === clientMessageId);
      assert.equal(requests.length, 1, "one request for the message");
      assert.equal(requests[0]!.body, TASKS.T1.prompt, "byte for byte");
      assert.ok((await i.driver.quiet(r.roomId)).pending.length > 0, "the Consigliere's turn is pending");

      // His turn hands W1 a piece of work through the board and ends: since H5 that final answers the user's request.
      await until("his run", async () => i.fake.threads.get(r.c.threadId)?.shell.activeRunId);
      const key = await keyOf(i, r.c.threadId);
      await i.driver.board(["post", "@W1 find the imports of src/cli.ts"], key);
      i.fake.completeRun(r.c.threadId, { text: "Handed out to @W1." });
      await complete(i, r.w1.threadId, "node:fs, args, text, format, dates, legacy, types; legacy unused (cli.ts:6).");
      await complete(i, r.c.threadId, "All found.\n\nJOB-DONE");
      await until("quiet", async () => (await i.driver.quiet(r.roomId)).pending.length === 0);

      const posts = (await i.driver.posts(r.roomId)).filter((p) => !before.some((b) => b.id === p.id));
      const consigliere = said(posts, "Fable");
      assert.deepEqual(consigliere.map((p) => [p.text, p.fromConsigliere, p.via, p.clock]), [
        ["Handed out to @W1.", true, "final", "t3"],
        ["All found.\n\nJOB-DONE", true, "final", "t3"],
      ]);
      assert.deepEqual(consigliere.map((p) => p.claims), [["answered"], []], "his hand-off answers the user; his report is an update");
      assert.equal(consigliere.filter((p) => hasJobDoneLine(p.text)).length, 1, "one report");
      const w1 = said(posts, "W1");
      assert.deepEqual(w1.map((p) => [p.fromConsigliere, p.via, p.claims]), [[false, "final", ["answered"]]]);
      // T3's exact time: the run's completedAt, as the fake recorded it.
      const t3Run = i.fake.threads.get(r.w1.threadId)!.runs.at(-1)!;
      assert.equal(w1[0]!.at, t3Run.completedAt);
      // Requests and notes are not things a member said.
      assert.ok(posts.some((p) => p.from === "Fable" && !p.isAnswer), "his board post is no answer");
      assert.equal(posts.filter((p) => p.from === "user").every((p) => !p.isAnswer), true);

      // The room record: the journal's runs with the bytes T3 received, matching T3's own message for each run.
      const record = (await i.driver.roomRecord(r.roomId)) as unknown as EngineRoomSnapshot & { runs: Array<{ t3RunId: string | null; briefing: string | null; threadId: string }> };
      assert.equal(record.engine, true);
      assert.ok(record.runs.length >= 5, "seat briefings and the job's runs");
      for (const run of record.runs) {
        const thread = i.fake.threads.get(run.threadId)!;
        const t3 = thread.runs.find((x) => x.id === run.t3RunId)!;
        const received = thread.messages.find((m) => m.id === t3.userMessageId)!;
        assert.equal(received.text, run.briefing, "the frozen briefing is what T3 received");
      }
    } finally {
      i.close();
    }
  });

  test("a report that answers nothing (yield) is the report, as any Consigliere reply with the line is on the old side", async () => {
    const i = engineInstance("yield");
    try {
      const r = await seatedRoom(i);
      await finishSeating(i, r);
      await i.driver.postAsUser(r.roomId, TASKS.T1.prompt, randomUUID());
      await until("his run", async () => i.fake.threads.get(r.c.threadId)?.shell.activeRunId);
      const key = await keyOf(i, r.c.threadId);
      // He answers the user at once ("handed out"), then hands W1 work between turns.
      i.fake.completeRun(r.c.threadId, { text: "Handing it out." });
      await until("his answer", async () => (await i.driver.posts(r.roomId)).some((p) => p.fromConsigliere && p.isAnswer));
      await i.driver.board(["post", "@W1 find the imports"], key);
      await complete(i, r.w1.threadId, "Found them.");
      await complete(i, r.c.threadId, "Done.\n\nJOB-DONE");
      const report = await until("the report", async () => (await i.driver.posts(r.roomId)).find((p) => p.fromConsigliere && p.isAnswer && hasJobDoneLine(p.text)));
      assert.deepEqual(report.claims, [], "it answered nothing: the user's request was answered before");
      assert.equal(report.via, "final");
    } finally {
      i.close();
    }
  });

  test("since H5 rooms-board answer is gone: the board refuses it, and his next final is the report", async () => {
    const i = engineInstance("answer");
    try {
      const r = await seatedRoom(i);
      await finishSeating(i, r);
      await i.driver.postAsUser(r.roomId, TASKS.T1.prompt, randomUUID());
      await until("his run", async () => i.fake.threads.get(r.c.threadId)?.shell.activeRunId);
      const key = await keyOf(i, r.c.threadId);
      await i.driver.board(["post", "@W1 find the imports"], key);
      i.fake.completeRun(r.c.threadId, { text: "Handed out." });
      await until("his final", async () => (await i.driver.posts(r.roomId)).some((p) => p.fromConsigliere && p.isAnswer));
      await assert.rejects(i.driver.board(["answer", "Done.\n\nJOB-DONE"], key), /your final reply is your answer/);
      await complete(i, r.w1.threadId, "Found them.");
      await complete(i, r.c.threadId, "Done.\n\nJOB-DONE");
      const report = await until("the report", async () => (await i.driver.posts(r.roomId)).find((p) => p.fromConsigliere && p.isAnswer && hasJobDoneLine(p.text)));
      assert.deepEqual([report.via, report.clock, report.claims], ["final", "t3", []]);
    } finally {
      i.close();
    }
  });

  test("a report through the Consigliere's own rooms-board note is seen, marked as such, with no T3 time", async () => {
    const i = engineInstance("note");
    try {
      const r = await seatedRoom(i);
      await finishSeating(i, r);
      await i.driver.postAsUser(r.roomId, TASKS.T1.prompt, randomUUID());
      await until("his run", async () => i.fake.threads.get(r.c.threadId)?.shell.activeRunId);
      const key = await keyOf(i, r.c.threadId);
      // He answers the user at once; later, the user's request closed, the board's way to the user is a note.
      i.fake.completeRun(r.c.threadId, { text: "Handing it out." });
      await until("his answer", async () => (await i.driver.posts(r.roomId)).some((p) => p.fromConsigliere && p.isAnswer));
      await i.driver.board(["note", "All found.\n\nJOB-DONE"], key);
      const report = await until("the note", async () => (await i.driver.posts(r.roomId)).find((p) => p.fromConsigliere && p.isAnswer && hasJobDoneLine(p.text)));
      assert.equal(report.via, "note");
      assert.equal(report.clock, "seen", "no T3 time: the runner's first sight of it");
    } finally {
      i.close();
    }
  });

  test("a project T3 took while answering the command with a failure is taken, with a note; a folder T3 has not is refused", async () => {
    const i = engineInstance("project");
    try {
      // As in R1's first smoke attempt: T3 records the project, then the command times out.
      const create = i.fake.createProject.bind(i.fake);
      i.fake.createProject = async (input) => {
        await create(input);
        throw new T3Unavailable("T3 RPC project.create timed out after 15000ms");
      };
      const folder = join(SCRATCH, "project-folder");
      mkdirSync(folder, { recursive: true });
      const notes: string[] = [];
      const id = await createJobProject(i.driver, folder, "tally-abc123", (text) => notes.push(text), 1);
      assert.equal(id, i.fake.projects.find((p) => p.workspaceRoot === folder)?.id);
      assert.match(notes[0] ?? "", /answered 422 but T3 has tally-abc123 for the folder/);
      // T3 refused and has no project there: the failure stands.
      i.fake.createProject = async () => {
        throw new T3Unavailable("refused");
      };
      await assert.rejects(createJobProject(i.driver, join(SCRATCH, "elsewhere"), "tally-def456", () => {}, 1), /HTTP 422/);
    } finally {
      i.close();
    }
  });

  test("an instance that does not run the engine is refused", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ room: {}, events: [], tasks: [] }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(new EngineInstance("http://old", null, fetcher).snapshot("r"), /does not run the engine/);
  });
});

// ---------------- the quiet rule and the posts, on constructed snapshots ----------------

function snapshot(over: Omit<Partial<EngineRoomSnapshot>, "counts"> & { counts?: Partial<EngineRoomSnapshot["counts"]> } = {}): EngineRoomSnapshot {
  const counts = { posts: 0, requests: 0, openRequests: 0, runs: 0, unresolvedRuns: 0, notices: 0, blocked: 0, pendingActivities: 0, unread: 0, needsYou: 0, busy: 0, waiting: 0, working: 0, ...over.counts };
  return {
    engine: true,
    room: { id: "room", consigliereId: "p-c" } as EngineRoomSnapshot["room"],
    participants: [{ id: "p-c", alias: "Fable" }, { id: "p-w", alias: "W1" }] as EngineRoomSnapshot["participants"],
    bindings: [],
    head: 10,
    seats: [
      { seatId: "s-c", participantId: "p-c", alias: "Fable", threadId: "t-c", status: "active", orchestrator: true, cursor: 0, activeRunId: null, unread: 0, blocked: null, activities: [], owns: 0, awaits: 0 },
      { seatId: "s-w", participantId: "p-w", alias: "W1", threadId: "t-w", status: "active", orchestrator: false, cursor: 0, activeRunId: null, unread: 0, blocked: null, activities: [], owns: 0, awaits: 0 },
    ],
    posts: [],
    earlier: false,
    requests: [],
    runs: [],
    needsYou: [],
    blocked: [],
    nativeRequests: [],
    participantStatus: {},
    news: { seenSeq: 0, unseen: 0, latest: null },
    notices: { through: 0, ids: [] },
    browser: null,
    state: null,
    t3: { reachable: true },
    ...over,
    counts,
  };
}

const post = (over: Partial<EnginePost>): EnginePost => ({ seq: 1, number: 1, id: "e1", kind: "note", author: "$user", to: [], body: "", about: [], turn: false, at: null, after: null, ...over });

describe("the new side's quiet rule and board", () => {
  test("quiet comes from the journal's unread and unresolved-run counts, never from busy or waiting", () => {
    assert.deepEqual(engineQuiet(snapshot()).pending, []);
    // A run that is no seat's active run (a rejected or uncertain one) shows in unresolvedRuns, not in busy.
    const unresolved = snapshot({ counts: { unresolvedRuns: 1, busy: 0, waiting: 0 }, runs: [{ id: "r1", seatId: "s-w", threadId: "t-w", phase: "rejected", t3RunId: null, reservedSeq: 3, through: 3, inputs: [], requestIds: [], failure: "refused", output: null, startedAt: null, endedAt: null }] });
    assert.deepEqual(engineQuiet(unresolved).pending, ["unresolvedRuns:1(@W1:rejected)"]);
    // Unread input with a seat shown neither busy nor waiting (say, its seat retired mid-read) is still not quiet.
    assert.deepEqual(engineQuiet(snapshot({ counts: { unread: 2, waiting: 0 } })).pending, ["unread:2"]);
    // Busy or waiting alone, with both counts at zero, do not decide it either way: only the two counts do.
    assert.deepEqual(engineQuiet(snapshot({ counts: { busy: 1, waiting: 1 } })).pending, []);
    // An approval or question the instance holds, and a read where the instance could not reach T3.
    assert.deepEqual(engineQuiet(snapshot({ nativeRequests: [{ participantId: "p-w", threadId: "t-w", requestId: "q1", kind: "user-input", payload: null, createdAt: "" }] })).pending, ["native:user-input:q1"]);
    assert.deepEqual(engineQuiet(snapshot({ t3: { reachable: false } })).pending, ["t3-unreachable"]);
    // Member-held work does not hold the window open (the plan's rule); it is recorded for Z1's behaviour checks.
    const held = snapshot({ counts: { pendingActivities: 1, openRequests: 1 } });
    held.seats[1]!.activities = [{ id: "work:r9", kind: "work", seatId: "s-w", runId: "r9", requestIds: ["q"], status: "pending", memberHeld: true, since: { at: null, after: null } }];
    const read = engineQuiet(held);
    assert.deepEqual(read.pending, []);
    assert.deepEqual(read.detail?.pendingActivities, ["work:r9@W1:held"]);
    assert.equal(read.head, 10);
  });

  test("seating is done only when every member answered its seat briefing and nothing is pending", () => {
    const briefing = (state: "open" | "answered") => post({ kind: "request", id: "seat-briefing:s-w:seated", request: { id: "seat-briefing:s-w:seated", parentId: null, rootId: "seat-briefing:s-w:seated", owner: "s-w", returnTo: "$user", state, answer: null, corrections: 0, message: null } });
    assert.equal(engineSeatingDone(snapshot()), false, "no briefing yet");
    assert.equal(engineSeatingDone(snapshot({ posts: [briefing("open")] })), false);
    assert.equal(engineSeatingDone(snapshot({ posts: [briefing("answered")], counts: { unresolvedRuns: 1 } })), false);
    assert.equal(engineSeatingDone(snapshot({ posts: [briefing("answered")] })), true);
  });

  test("what a member said: every output and T3-turn note, any disposition; a post's time is T3's or first sight", () => {
    const output = (author: string, source: "final" | "answer" | "continuation" | "idle", disposition: "answer" | "yield" | "progress", at: string | null) =>
      post({ kind: "output", author, body: `${source} ${disposition}`, at, output: { disposition, claims: disposition === "answer" ? [{ requestId: "q", number: 1, outcome: "answered", returnTo: "s-c" }] : [], source, runId: null, activityId: null, t3: null, afterAnswer: false } });
    const posts = engineBoardPosts(snapshot({ posts: [
      output("s-w", "final", "yield", "2026-10-08T10:00:00.000Z"),
      output("s-w", "answer", "answer", null),
      output("s-w", "continuation", "progress", "2026-10-08T10:01:00.000Z"),
      output("s-c", "idle", "answer", null),
      post({ kind: "note", author: "s-w", body: "self-started", note: { source: "t3-turn", room: false, t3: null, afterAnswer: true }, at: "2026-10-08T10:02:00.000Z" }),
      post({ kind: "note", author: "s-w", body: "a note", note: { source: "post", room: false, t3: null, afterAnswer: false } }),
      post({ kind: "note", author: "s-c", body: "Done.\n\nJOB-DONE", note: { source: "post", room: false, t3: null, afterAnswer: true } }),
      post({ kind: "progress", author: "s-w", body: "working", progress: { milestone: "working", working: true, t3: null } }),
      post({ kind: "request", author: "$user", body: "the prompt" }),
    ] }), () => "2026-10-08T11:00:00.000Z");
    assert.deepEqual(posts.map((p) => [p.from, p.isAnswer, p.fromConsigliere, p.via ?? null, p.clock, p.at]), [
      ["W1", true, false, "final", "t3", "2026-10-08T10:00:00.000Z"],
      ["W1", true, false, "answer", "seen", "2026-10-08T11:00:00.000Z"],
      ["W1", true, false, "continuation", "t3", "2026-10-08T10:01:00.000Z"],
      ["Fable", true, true, "idle", "seen", "2026-10-08T11:00:00.000Z"],
      ["W1", true, false, "t3-turn", "t3", "2026-10-08T10:02:00.000Z"],
      ["W1", false, false, null, "seen", "2026-10-08T11:00:00.000Z"],
      ["Fable", true, true, "note", "seen", "2026-10-08T11:00:00.000Z"],
      ["W1", false, false, null, "seen", "2026-10-08T11:00:00.000Z"],
      ["user", false, false, null, "seen", "2026-10-08T11:00:00.000Z"],
    ]);
  });
});

// ---------------- measure.ts on new-side evidence ----------------

const C = "11111111-1111-4111-8111-111111111111";
const W = "22222222-2222-4222-8222-222222222222";

/** The committed sample job as new-side evidence: T3's runs keep their user message, the instance's record is the journal's. */
function newSideJob(name: string, runs: Array<{ threadId: string; t3RunId: string | null; briefing: string | null }>, report?: JobRecord["report"]): string {
  const dir = join(SCRATCH, name);
  cpSync(SAMPLE, dir, { recursive: true });
  execFileSync("sqlite3", [join(dir, "t3", "state-subset.sqlite"), `.read ${join(dir, "t3", "state.sql")}`]);
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
  job.side = "new";
  if (report !== undefined) job.report = report;
  writeFileSync(join(dir, "job.json"), JSON.stringify(job));
  const threads = JSON.parse(readFileSync(join(dir, "t3", "threads.json"), "utf8")) as Array<{ runs: Array<{ id: string; userMessageId?: string | null }>; messages: Array<{ id: string; role: string; runId: string | null }> }>;
  for (const thread of threads) for (const run of thread.runs) run.userMessageId = thread.messages.find((m) => m.role === "user" && m.runId === run.id)?.id ?? null;
  writeFileSync(join(dir, "t3", "threads.json"), JSON.stringify(threads));
  writeFileSync(join(dir, "instance-room.json"), JSON.stringify({ head: 20, counts: { unread: 0, unresolvedRuns: 0 }, seats: [], requests: [], runs: runs.map((run, index) => ({ id: `h${index}`, ...run })) }));
  return dir;
}

function sampleRuns(): Array<{ threadId: string; t3RunId: string; text: string }> {
  const threads = JSON.parse(readFileSync(join(SAMPLE, "t3", "threads.json"), "utf8")) as Array<{ threadId: string; runs: Array<{ id: string; requestedAt: string }>; messages: Array<{ role: string; runId: string | null; text: string }> }>;
  return threads.flatMap((t) => t.runs.filter((r) => r.requestedAt >= "2026-10-08T10:00:00.000Z").map((r) => ({ threadId: t.threadId, t3RunId: r.id, text: t.messages.find((m) => m.role === "user" && m.runId === r.id)!.text })));
}

describe("measure.ts on the new side", () => {
  test("the briefing cross-check compares the frozen briefing with the bytes T3 received, run by run", () => {
    const runs = sampleRuns();
    assert.ok(runs.length >= 2 && runs.some((r) => r.threadId === C) && runs.some((r) => r.threadId === W));
    const same = newSideJob("cross-same", runs.map((r) => ({ threadId: r.threadId, t3RunId: r.t3RunId, briefing: r.text })));
    const measured = measureJob(same, { liveStateDb: null });
    assert.deepEqual(measured.briefing.crossCheck, { compared: runs.length, equal: runs.length, missing: 0 });
    assert.deepEqual(verifyJob(same, measured).filter((d) => /briefing/.test(d.what)), []);
    assert.deepEqual(measured.engineAtClose, { head: 20, unread: 0, unresolvedRuns: 0, openRequests: [], pendingActivities: [] });

    // One byte off in one run: a difference.
    const off = newSideJob("cross-off", runs.map((r, index) => ({ threadId: r.threadId, t3RunId: r.t3RunId, briefing: index === 0 ? `${r.text} ` : r.text })));
    const offMeasured = measureJob(off, { liveStateDb: null });
    assert.deepEqual(offMeasured.briefing.crossCheck, { compared: runs.length, equal: runs.length - 1, missing: 0 });
    assert.ok(verifyJob(off, offMeasured).some((d) => d.what === "briefings sent and received differ"));

    // A record with no T3 run on any host run compares nothing on a job with turns: that is a difference too.
    const none = newSideJob("cross-none", runs.map((r) => ({ threadId: r.threadId, t3RunId: null, briefing: r.text })));
    const noneMeasured = measureJob(none, { liveStateDb: null });
    assert.deepEqual(noneMeasured.briefing.crossCheck, { compared: 0, equal: 0, missing: 0 });
    assert.ok(verifyJob(none, noneMeasured).some((d) => d.what === "the briefing cross-check compared no turn"));
  });

  for (const via of ["answer", "note"]) {
    test(`a report through rooms-board ${via} fails the accuracy check`, () => {
      const runs = sampleRuns().map((r) => ({ threadId: r.threadId, t3RunId: r.t3RunId, briefing: r.text }));
      const dir = newSideJob(`via-${via}`, runs, { postId: "e-report", text: "Done.\n\nJOB-DONE", via });
      const differences = verifyJob(dir, measureJob(dir, { liveStateDb: null }));
      assert.ok(differences.some((d) => d.what === `the JOB-DONE report came through rooms-board ${via}: no T3 message carries it`), JSON.stringify(differences));
    });
  }
});

// ---------------- the checkout the members' board command lives in ----------------

describe("a new-side checkout that holds the harness is refused", () => {
  const worktrees = join(SCRATCH, "worktrees");
  before(() => {
    for (const side of ["compare-old", "compare-new"]) mkdirSync(join(worktrees, side), { recursive: true });
    mkdirSync(join(worktrees, "compare-new", "scripts", "compare-live"), { recursive: true });
  });

  test("refuseTaintedCheckout", () => {
    assert.throws(() => refuseTaintedCheckout(join(worktrees, "compare-new")), /contains scripts\/compare-live/);
    assert.doesNotThrow(() => refuseTaintedCheckout(join(worktrees, "compare-old")));
  });

  for (const argv of [["--campaign", "r1-refusal", "--side", "new", "--jobs", "T1:1"], ["--dry", "--campaign", "r1-refusal-dry"]]) {
    test(`run.ts ${argv.join(" ")} stops before any job or instance`, () => {
      const evidence = join(SCRATCH, "evidence");
      const root = join(SCRATCH, "compare-root");
      const result = spawnSync(process.execPath, ["--no-warnings", join(import.meta.dirname, "run.ts"), ...argv], {
        encoding: "utf8",
        env: { ...process.env, COMPARE_WORKTREES: worktrees, COMPARE_EVIDENCE: evidence, COMPARE_ROOT: root },
        timeout: 60_000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /compare-new contains scripts\/compare-live/);
      assert.equal(existsSync(evidence), false, "no job was started");
      assert.equal(existsSync(join(root, "dry")), false, "no fake instance was started");
    });
  }
});

// ---------------- the prompts ----------------

test("each task's prompt goes to the Consigliere verbatim through the engine's parser, as one steered request", () => {
  const participants = [{ id: "p-c", alias: "Fable" }, { id: "p-w1", alias: "W1" }, { id: "p-v", alias: "V" }, { id: "p-w2", alias: "W2" }];
  for (const task of TASK_IDS) {
    const draft = parseExplicit(TASKS[task].prompt, participants, { consigliereId: "p-c" });
    assert.equal(draft.kind, "task", task);
    assert.equal(draft.assignments.length, 1, task);
    assert.deepEqual(draft.assignments[0]!.recipients, ["p-c"], task);
    assert.equal(draft.assignments[0]!.instruction, TASKS[task].prompt, task);
    assert.equal(draft.preamble, "", task);
    assert.equal(draft.assignments[0]!.delivery, "steer", `${task}: every message is his, steered (an idle Consigliere starts an ordinary run)`);
  }
});

// ---------------- the caps ----------------

test("the 30 minutes after the report count from T3's report time when known, on both sides; the board's only as fallback", () => {
  const posted = Date.parse("2026-10-08T10:00:00.000Z");
  const t3 = "2026-10-08T10:05:00.000Z";
  // The old side's board shows the report 58 s after T3 has it.
  const board = "2026-10-08T10:05:58.000Z";
  const at = (iso: string) => Date.parse(iso);
  const record = (t3ReportAt: string | null): Pick<JobRecord, "report" | "times"> => ({
    report: { postId: "p", text: "JOB-DONE" },
    times: { createdAt: "", seatingStart: null, seatingEnd: null, postedAt: "2026-10-08T10:00:00.000Z", reportAt: board, t3ReportAt, reportObservedAt: board, quietSince: null, closeAt: null },
  });
  assert.equal(capClose(record(t3), at("2026-10-08T10:34:59.999Z"), posted), null);
  assert.equal(capClose(record(t3), at("2026-10-08T10:35:00.000Z"), posted), "did not quiesce", "30 minutes after T3's time, not the board's");
  // T3's time not known (the dry run, a failed read): the board's time.
  assert.equal(capClose(record(null), at("2026-10-08T10:35:00.000Z"), posted), null);
  assert.equal(capClose(record(null), at("2026-10-08T10:35:58.000Z"), posted), "did not quiesce");
  // No report: 60 minutes after the post.
  const none: Pick<JobRecord, "report" | "times"> = { report: null, times: { ...record(null).times, reportAt: null } };
  assert.equal(capClose(none, at("2026-10-08T10:59:59.999Z"), posted), null);
  assert.equal(capClose(none, at("2026-10-08T11:00:00.000Z"), posted), "no report");
});
