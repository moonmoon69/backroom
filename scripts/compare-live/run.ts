/**
 * The comparison runner (plan stage45, item R0). One job: a fresh clone of the fixture at fixture-v1 as a throwaway
 * T3 project; a room on one instance with the Consigliere, W1 and V (and W2 in T4) seated first; the task's prompt
 * posted verbatim as the user; the board watched for member answers and the Consigliere's JOB-DONE report, the job
 * folder copied and checked at each; then the room watched until it has been quiet for 3 minutes (no active run, no
 * pending approval or question and no background work on any of the job's threads in T3, and no pending work on the
 * instance), and everything measure.ts reads copied into the job's evidence folder. Before each job the campaign's
 * measured spend is added up, and no job starts once it has reached the cap.
 *
 *   node scripts/compare-live/run.ts --campaign r0 --side old --jobs T1:1,T2:1,T3:1,T4:1 [--cap 100]
 *   node scripts/compare-live/run.ts --dry          the plumbing on two ROOMS_ADAPTER=fake instances (4 tasks each)
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isRunActive, type T3ThreadDetail, type T3ThreadShell } from "../../src/adapter/types.ts";
import type { HttpT3Adapter } from "../../src/adapter/http.ts";
import { TranscriptTokens } from "./tokens.ts";
import {
  AFTER_REPORT_CAP_MS,
  COMPARE_ROOT,
  CREW,
  FIXTURE_REPO,
  FIXTURE_TAG,
  INSTANCES,
  NO_REPORT_CAP_MS,
  QUIET_MS,
  capCheck,
  jobThreads,
  jobsDir,
  listJobs,
  type JobRecord,
  type Seat,
  type Side,
  type Snapshot,
} from "./campaign.ts";
import { MEMBER_PARTS, checkTask, type CheckInput } from "./checkers.ts";
import { LegacyInstance, type BoardPost } from "./instance.ts";
import { measureJob, type ThreadRecord } from "./measure.ts";
import { CLAUDE_PROJECTS, RATES, STATE_DB, copyTranscripts, exportStateSubset, liveT3 } from "./t3.ts";
import { TASKS, TASK_IDS, hasJobDoneLine, type TaskId } from "./tasks.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const log = (message: string) => console.log(`[compare ${iso()}] ${message}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// ---------------- the spend cap ----------------

/** What a job has spent so far at list price: every call on its threads, seating included (T3's records, live). */
export function jobSpend(job: JobRecord, costs: TranscriptTokens): number {
  const threads = jobThreads(job);
  return threads.length === 0 ? 0 : costs.between(threads, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY).costUsd;
}

/** The cap, as main() applies it before each job: every job of the campaign so far, whatever its outcome. */
export function capGate(campaign: string, cap: number, spendOf: (job: JobRecord) => number): { spent: number; allowed: boolean } {
  return capCheck(listJobs(campaign).map(({ job }) => spendOf(job)), cap);
}

const liveCosts = () => new TranscriptTokens({ stateDb: STATE_DB, projectsDir: CLAUDE_PROJECTS, ratesPath: RATES });

// ---------------- one job ----------------

interface JobOptions {
  campaign: string;
  side: Side;
  task: TaskId;
  run: number;
  instance: LegacyInstance;
  worktree: string;
  /** The live T3 (paid jobs); null in the dry run, whose T3 is the fake inside each instance. */
  t3: HttpT3Adapter | null;
  cap: number;
  quietMs: number;
  dry: boolean;
}

class Job {
  readonly record: JobRecord;
  readonly dir: string;
  private readonly options: JobOptions;
  private readonly seen = new Set<string>();
  private readonly checks: Array<Promise<void>> = [];

  constructor(options: JobOptions, spentBefore: number) {
    this.options = options;
    const jobId = randomBytes(3).toString("hex");
    this.dir = join(jobsDir(options.campaign), `${options.side}-${options.task}-${options.run}-${jobId}`);
    const fixtureCommit = git(FIXTURE_REPO, "rev-parse", `${FIXTURE_TAG}^{commit}`);
    let instanceCommit: string | null = null;
    try {
      instanceCommit = git(options.worktree, "rev-parse", "HEAD");
    } catch {
      // Recorded when it can be read.
    }
    this.record = {
      campaign: options.campaign,
      side: options.side,
      task: options.task,
      run: options.run,
      jobId,
      status: "running",
      close: null,
      dry: options.dry,
      instance: { url: options.instance.url, worktree: options.worktree, commit: instanceCommit },
      // A name that does not tell the members which side they are on.
      folder: join(COMPARE_ROOT, ...(options.dry ? ["dry"] : []), "jobs", jobId, "tally"),
      fixture: { tag: FIXTURE_TAG, commit: fixtureCommit },
      prompt: TASKS[options.task].prompt,
      projectId: null,
      roomId: null,
      crew: CREW,
      seats: [],
      childThreads: [],
      t3: { start: null, end: null },
      times: { createdAt: iso(), seatingStart: null, seatingEnd: null, postedAt: null, reportAt: null, reportObservedAt: null, quietSince: null, closeAt: null },
      report: null,
      snapshots: [],
      overlap: { samples: 0, threads: [] },
      spend: { campaignBefore: spentBefore, cap: options.cap },
      notes: [],
    };
    mkdirSync(this.dir, { recursive: true });
    this.save();
  }

  save(): void {
    writeFileSync(join(this.dir, "job.json"), `${JSON.stringify(this.record, null, 2)}\n`);
  }

  private note(text: string): void {
    log(`${this.record.side} ${this.record.task}#${this.record.run}: ${text}`);
    this.record.notes.push(`${iso()} ${text}`);
    this.save();
  }

  private async versions(): Promise<Record<string, unknown>> {
    if (!this.options.t3) return { serverVersion: "fake", harnesses: [] };
    const versions = await this.options.t3.versions(true);
    return { serverVersion: versions.serverVersion, harnesses: versions.harnesses.filter((h) => h.enabled).map((h) => ({ instanceId: h.instanceId, version: h.version })), at: iso() };
  }

  async run(): Promise<JobRecord> {
    const { instance, task } = this.options;
    const spec = TASKS[task];
    this.record.t3.start = await this.versions();

    // The job folder: a fresh clone at fixture-v1, on a branch of its own, with no remote.
    mkdirSync(join(this.record.folder, ".."), { recursive: true });
    execFileSync("git", ["clone", "--quiet", FIXTURE_REPO, this.record.folder]);
    git(this.record.folder, "checkout", "--quiet", "-B", "main", FIXTURE_TAG);
    git(this.record.folder, "remote", "remove", "origin");
    if (git(this.record.folder, "rev-parse", "HEAD") !== this.record.fixture.commit) throw new Error("the clone is not at fixture-v1");

    // Crew, project, room; seating is measured apart from the job.
    const consigliere = await instance.ensurePreset(CREW.consigliere.name, CREW.consigliere.modelSelection, CREW.runtimeMode);
    const member = await instance.ensurePreset(CREW.member.name, CREW.member.modelSelection, CREW.runtimeMode);
    await instance.setConsiglierePreset(consigliere);
    this.record.projectId = await instance.createProject(this.record.folder, `tally-${this.record.jobId}`);
    this.record.times.seatingStart = iso();
    const room = await instance.createRoom(this.record.projectId, `tally ${this.record.jobId}`);
    this.record.roomId = room.roomId;
    this.record.seats.push({ role: "C", participantId: room.consigliere.id, alias: room.consigliere.alias, threadId: room.consigliere.threadId });
    for (const alias of spec.members) {
      const seat = await instance.seat(room.roomId, member, alias);
      this.record.seats.push({ role: alias as Seat["role"], participantId: seat.id, alias: seat.alias, threadId: seat.threadId });
    }
    this.save();
    await this.waitForSeating();
    this.record.times.seatingEnd = iso();
    this.note(`seated ${this.record.seats.map((s) => `@${s.alias}`).join(", ")}`);

    // The prompt, as the user.
    for (const post of await instance.posts(room.roomId)) this.seen.add(post.id);
    this.record.times.postedAt = iso();
    await instance.postAsUser(room.roomId, spec.prompt);
    this.save();
    this.note("prompt posted");

    await this.watch();
    await Promise.all(this.checks);
    await this.finish();
    return this.record;
  }

  /** Seat briefings answered, every seat idle in T3, nothing pending on the instance. */
  private async waitForSeating(): Promise<void> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const roomId = this.record.roomId as string;
      const seated = await this.options.instance.seatingDone(roomId);
      const pending = await this.options.instance.pendingWork(roomId);
      const threads = await this.threadStates();
      if (seated && pending.length === 0 && Object.values(threads).every((t) => !t.active && !t.request && t.background === 0)) {
        await sleep(5000);
        return;
      }
      await sleep(3000);
    }
    throw new Error("seating did not finish in 15 minutes");
  }

  /** Each job thread as T3 shows it now; on a dry run, as the instance's fake T3 does. */
  private async threadStates(shells?: T3ThreadShell[]): Promise<Record<string, { status: string; active: boolean; request: boolean; background: number }>> {
    const out: Record<string, { status: string; active: boolean; request: boolean; background: number }> = {};
    for (const seat of this.record.seats) {
      if (this.options.t3) {
        const shell = (shells ?? (await this.options.t3.listThreads())).find((t) => t.id === seat.threadId);
        out[seat.alias] = shell
          ? { status: shell.status, active: shell.activeRunId !== null || isRunActive(shell.status), request: shell.pendingRequest !== null, background: shell.pendingBackgroundTasks.length }
          : { status: "missing", active: false, request: false, background: 0 };
      } else {
        const { thread } = await this.options.instance.thread(seat.threadId);
        out[seat.alias] = { status: thread.status, active: thread.activeRunId !== null, request: thread.pendingRequest !== null, background: thread.pendingBackgroundTasks.length };
      }
    }
    return out;
  }

  /** The board until the report, then T3 and the instance until the room has been quiet for the quiet period. */
  private async watch(): Promise<void> {
    const { instance, task } = this.options;
    const roomId = this.record.roomId as string;
    const postedMs = Date.parse(this.record.times.postedAt as string);
    const overlap = new Set<string>();
    const consigliere = this.record.seats.find((s) => s.role === "C") as Seat;
    const dry = this.options.dry ? new DryConsigliere(this.options.instance, consigliere, TASKS[task].members) : null;
    let quietSince: number | null = null;
    let lastOverlapSample = 0;
    for (;;) {
      const now = Date.now();
      const posts = await instance.posts(roomId);
      for (const post of posts) {
        if (this.seen.has(post.id) || Date.parse(post.at) < postedMs) continue;
        this.seen.add(post.id);
        if (!post.isAnswer) continue;
        if (post.fromConsigliere) {
          const isReport = dry ? dry.isReport(post, posts) : hasJobDoneLine(post.text);
          if (isReport && !this.record.report) {
            this.record.report = { postId: post.id, text: post.text };
            this.record.times.reportAt = post.at;
            this.record.times.reportObservedAt = iso();
            this.snapshot("report", consigliere.alias, post);
            this.note(`JOB-DONE report #${post.number}`);
          }
        } else {
          this.snapshot("answer", post.from, post);
          this.note(`@${post.from} answered #${post.number}`);
        }
      }
      if (dry) await dry.step(posts);

      // T3: the job's threads, and every other thread that is running (the overlap), from one read of the shell.
      const shells = this.options.t3 ? await this.options.t3.listThreads() : undefined;
      const jobThreadIds = new Set(this.record.seats.map((s) => s.threadId));
      if (shells && now - lastOverlapSample >= 10_000) {
        lastOverlapSample = now;
        this.record.overlap.samples += 1;
        for (const shell of shells) {
          if (jobThreadIds.has(shell.id) || jobThreadIds.has(shell.lineage.rootThreadId) || shell.projectId === this.record.projectId) continue;
          if (shell.activeRunId !== null || isRunActive(shell.status)) overlap.add(shell.id);
        }
        this.record.overlap.threads = [...overlap].sort();
      }
      if (this.record.report) {
        const threads = await this.threadStates(shells);
        const pending = await instance.pendingWork(roomId);
        const quiet = pending.length === 0 && Object.values(threads).every((t) => !t.active && !t.request && t.background === 0);
        if (!quiet) quietSince = null;
        else quietSince ??= now;
        appendFileSync(join(this.dir, "quiet.jsonl"), `${JSON.stringify({ at: iso(now), quiet, quietForMs: quietSince === null ? 0 : now - quietSince, pending, threads })}\n`);
        if (quietSince !== null && now - quietSince >= this.options.quietMs) {
          this.record.close = "quiet";
          this.record.times.quietSince = iso(quietSince);
          this.record.times.closeAt = iso(now);
          return;
        }
        if (now - Date.parse(this.record.times.reportAt as string) >= AFTER_REPORT_CAP_MS) {
          this.record.close = "did not quiesce";
          this.record.times.closeAt = iso(now);
          this.note("not quiet 30 minutes after the report: closed as did not quiesce");
          return;
        }
      } else if (now - postedMs >= NO_REPORT_CAP_MS) {
        this.record.close = "no report";
        this.record.times.closeAt = iso(now);
        this.note("no JOB-DONE report in 60 minutes: closed");
        return;
      }
      this.save();
      await sleep(2000);
    }
  }

  /** Copy the job folder now (no node_modules; the final copy keeps .git) and run the task's checker on the copy. */
  private snapshot(kind: Snapshot["kind"], alias: string, post: BoardPost | null): void {
    const observedAt = iso();
    const dir = join(this.dir, "snapshots", `${String(this.record.snapshots.length + 1).padStart(2, "0")}-${kind}${alias ? `-${alias}` : ""}`);
    cpSync(this.record.folder, dir, { recursive: true, filter: (source) => !/\/node_modules(\/|$)/.test(source) && (kind === "final" || !/\/\.git(\/|$)/.test(source)) });
    const task = this.options.task;
    const entry: Snapshot = { kind, alias, postId: post?.id ?? null, at: post?.at ?? observedAt, observedAt, dir, check: { pass: false, parts: {} } };
    if (kind === "answer") entry.ownParts = ownPartsFor(task, this.record.seats.find((s) => s.alias === alias)?.role ?? null);
    this.record.snapshots.push(entry);
    const input = checkInputFor(task, kind, dir, post, this.record.report?.text ?? null, this.record.times.reportAt);
    this.checks.push(
      checkTask(task, input).then(
        (result) => {
          entry.check = result;
          if (entry.ownParts && entry.ownParts.length > 0) entry.ownPass = entry.ownParts.every((part) => result.parts[part]?.pass === true);
          this.save();
        },
        (error: unknown) => {
          entry.check = { pass: false, parts: { error: { pass: false, detail: String(error) } } };
          this.save();
        },
      ),
    );
  }

  /** Evidence: the final copy and its check, T3's threads and rows, the transcripts, the board, the instance's runs. */
  private async finish(): Promise<void> {
    const { instance, t3 } = this.options;
    this.snapshot("final", "", null);
    await Promise.all(this.checks);
    this.record.t3.end = await this.versions();
    const evidence = join(this.dir, "t3");
    mkdirSync(evidence, { recursive: true });
    const seatIds = new Set(this.record.seats.map((s) => s.threadId));
    const records: ThreadRecord[] = [];
    if (t3) {
      // Threads the seats started in T3 (its subagent or delegated threads) belong to the job too.
      const all = [...(await t3.listThreads()), ...(await t3.listArchivedThreads())];
      this.record.childThreads = all.filter((t) => !seatIds.has(t.id) && (seatIds.has(t.lineage.rootThreadId) || t.projectId === this.record.projectId)).map((t) => t.id);
      for (const threadId of [...seatIds, ...this.record.childThreads]) {
        const detail = await t3.getThreadDetail(threadId);
        if (!detail) continue;
        writeFileSync(join(evidence, `${threadId}.json`), `${JSON.stringify(detail)}\n`);
        records.push(threadRecord(detail, this.record.seats.find((s) => s.threadId === threadId) ?? null));
      }
      writeFileSync(join(evidence, "state-subset.json"), `${JSON.stringify(exportStateSubset(jobThreads(this.record), join(evidence, "state-subset.sqlite")), null, 2)}\n`);
      const copied = copyTranscripts(this.record.folder, join(this.dir, "transcripts"));
      this.note(`copied ${copied.length} transcript entries`);
    } else {
      for (const seat of this.record.seats) records.push(fakeThreadRecord(await instance.thread(seat.threadId), seat));
    }
    writeFileSync(join(evidence, "threads.json"), `${JSON.stringify(records, null, 2)}\n`);
    // The board and the instance's own run records (with the briefings it sent), for the briefing cross-check.
    const roomId = this.record.roomId as string;
    const snapshot = await instance.snapshot(roomId);
    const runs = await Promise.all(snapshot.runs.map((run) => instance.run(roomId, run.id)));
    writeFileSync(join(this.dir, "instance-room.json"), `${JSON.stringify({ ...snapshot, runs }, null, 2)}\n`);
    // Everything the members changed, committed or not, against the tag.
    git(this.record.folder, "add", "--all", "--intent-to-add");
    writeFileSync(join(this.dir, "final.diff"), git(this.record.folder, "diff", FIXTURE_TAG));
    this.record.status = "closed";
    this.save();
    const measured = measureJob(this.dir);
    writeFileSync(join(this.dir, "measure.json"), `${JSON.stringify(measured, null, 2)}\n`);
    this.note(`closed (${this.record.close}); report ${this.record.times.reportAt ?? "none"}; spend $${measured.spend.totalUsd.toFixed(2)}`);
  }
}

/**
 * What the task's checker judges for one copy: the folder (T1 has none), the text (T1: the answer or the report; T4:
 * the report only, members' answers are judged on the folder), and the time T3's slow-check log is read up to (the
 * post's time; for the final copy, the report's).
 */
export function checkInputFor(task: TaskId, kind: Snapshot["kind"], dir: string, post: Pick<BoardPost, "text" | "at"> | null, reportText: string | null, reportAt: string | null): CheckInput {
  const text = kind === "final" ? reportText : (post?.text ?? null);
  const cutoff = kind === "final" ? reportAt : (post?.at ?? null);
  return {
    folder: task === "T1" ? null : dir,
    text: task === "T1" || (task === "T4" && kind !== "answer") ? text : null,
    ...(cutoff ? { cutoff } : {}),
  };
}

/**
 * The parts of the checker that are a member's own, for early answers: by role; T1's facts for whichever worker
 * answers (W1 or W2). The reviewer V has none: reviewers' answers are not checked.
 */
export const ownPartsFor = (task: TaskId, role: string | null): string[] =>
  role === "V" || role === null ? [] : (MEMBER_PARTS[task][task === "T1" ? "any" : role] ?? []);

/** A thread as measure.ts reads it, from T3's detail. */
export function threadRecord(detail: T3ThreadDetail, seat: Seat | null): ThreadRecord {
  return {
    threadId: detail.shell.id,
    alias: seat?.alias ?? null,
    role: seat?.role ?? "child",
    source: "t3-http",
    runs: detail.runs.map((r) => ({ id: r.id, requestedAt: r.requestedAt, startedAt: r.startedAt, completedAt: r.completedAt, status: r.status })),
    messages: detail.messages.map((m) => ({ id: m.id, role: m.role, runId: m.runId, createdAt: m.createdAt, text: m.text })),
    subagents: detail.subagents.map((s) => ({ id: s.id, runId: s.runId, status: s.status, startedAt: s.startedAt, childThreadId: s.childThreadId })),
    partial: detail.partial,
  };
}

/** The dry run's thread: the fake T3 inside the instance, as its /api/threads view shows it (each reply has its run). */
function fakeThreadRecord(view: Awaited<ReturnType<LegacyInstance["thread"]>>, seat: Seat): ThreadRecord {
  const runs: ThreadRecord["runs"] = [];
  const messages: ThreadRecord["messages"] = [];
  let prompt: { id: string; at: string; text: string } | null = null;
  for (const item of view.items) {
    if (item.kind === "user") prompt = { id: item.id, at: item.at, text: item.text };
    if (item.kind !== "reply" || !item.runId) continue;
    runs.push({ id: item.runId, requestedAt: prompt?.at ?? item.at, startedAt: prompt?.at ?? item.at, completedAt: item.at, status: "completed" });
    if (prompt) messages.push({ id: prompt.id, role: "user", runId: item.runId, createdAt: prompt.at, text: prompt.text });
    messages.push({ id: item.id, role: "assistant", runId: item.runId, createdAt: item.at, text: item.text });
    prompt = null;
  }
  return { threadId: seat.threadId, alias: seat.alias, role: seat.role, source: "fake-instance", runs, messages, subagents: [], partial: false };
}

/**
 * The dry run plays the Consigliere's part a fake cannot: once his first reply lands, it posts one piece of work to
 * each member through rooms-board with his key; his report is his first reply after every member has answered.
 */
class DryConsigliere {
  private key: string | null = null;
  private posted: string[] = [];
  private readonly instance: LegacyInstance;
  private readonly consigliere: Seat;
  private readonly members: string[];

  constructor(instance: LegacyInstance, consigliere: Seat, members: string[]) {
    this.instance = instance;
    this.consigliere = consigliere;
    this.members = members;
  }

  async step(posts: BoardPost[]): Promise<void> {
    if (this.posted.length > 0 || !posts.some((p) => p.fromConsigliere && p.isAnswer)) return;
    const view = await this.instance.thread(this.consigliere.threadId);
    const briefing = view.items.find((i) => i.kind === "user")?.text ?? "";
    this.key = /--as ([A-Za-z0-9._-]+)/.exec(briefing)?.[1] ?? null;
    if (!this.key) throw new Error("dry run: no board key in the Consigliere's briefing");
    for (const alias of this.members) {
      await this.instance.board(["post", `@${alias} dry run: your part of the task`], this.key);
      this.posted.push(alias);
    }
  }

  isReport(post: BoardPost, posts: BoardPost[]): boolean {
    if (this.posted.length === 0) return false;
    const answers = posts.filter((p) => p.isAnswer && !p.fromConsigliere && this.posted.includes(p.from));
    if (new Set(answers.map((a) => a.from)).size < this.posted.length) return false;
    const last = answers.reduce((max, a) => (a.at > max ? a.at : max), "");
    return post.at > last;
  }
}

// ---------------- instances for the dry run ----------------

function startFake(side: Side, port: number): { process: ChildProcess; url: string; dataDir: string } {
  const dataDir = join(COMPARE_ROOT, "dry", side, "data");
  rmSync(join(COMPARE_ROOT, "dry", side), { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const out = join(COMPARE_ROOT, "dry", side, "service.log");
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "src/server/index.ts"], {
    cwd: INSTANCES[side].worktree,
    env: { ...process.env, ROOMS_ADAPTER: "fake", ROOMS_PORT: String(port), ROOMS_DATA_DIR: dataDir, ROOMS_BROWSER_MODE: "off", ROOMS_SPEECH: "off", ...(side === "new" ? { ROOMS_ENGINE: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => appendFileSync(out, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendFileSync(out, chunk));
  return { process: child, url: `http://127.0.0.1:${port}`, dataDir };
}

async function waitForInstance(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${url}/api/status`)).ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(500);
  }
  throw new Error(`${url} did not start`);
}

const boardToken = (dataDir: string): string | null => {
  try {
    return (JSON.parse(readFileSync(join(dataDir, "browser-api.json"), "utf8")) as { token: string }).token;
  } catch {
    return null;
  }
};

/** A job that throws is recorded as aborted (its spend still counts against the cap), and the campaign stops. */
async function runOrAbort(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (error) {
    job.record.status = "aborted";
    job.record.notes.push(`${iso()} aborted: ${(error as Error).stack ?? String(error)}`);
    job.save();
    throw error;
  }
}

// ---------------- command line ----------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      campaign: { type: "string" },
      side: { type: "string" },
      jobs: { type: "string" },
      cap: { type: "string" },
      dry: { type: "boolean", default: false },
      "quiet-ms": { type: "string" },
    },
  });
  if (values.dry) {
    const campaign = values.campaign ?? "dry";
    const quietMs = Number(values["quiet-ms"] ?? 20_000);
    const fakes = { old: startFake("old", 4491), new: startFake("new", 4492) };
    try {
      for (const side of ["old", "new"] as const) await waitForInstance(fakes[side].url);
      // Fake instances write browser-api.json once listening.
      await sleep(1000);
      for (const task of TASK_IDS) {
        for (const side of ["old", "new"] as const) {
          const instance = new LegacyInstance(fakes[side].url, boardToken(fakes[side].dataDir));
          const job = new Job({ campaign, side, task, run: 1, instance, worktree: INSTANCES[side].worktree, t3: null, cap: Number.POSITIVE_INFINITY, quietMs, dry: true }, 0);
          await runOrAbort(job);
        }
      }
    } finally {
      fakes.old.process.kill("SIGTERM");
      fakes.new.process.kill("SIGTERM");
    }
    return;
  }
  const campaign = values.campaign;
  const side = values.side as Side | undefined;
  if (!campaign || (side !== "old" && side !== "new") || !values.jobs) throw new Error("usage: run.ts --campaign <name> --side old|new --jobs T1:1,T2:1,… [--cap <usd>]  |  run.ts --dry");
  const cap = Number(values.cap ?? (campaign === "r0" ? 100 : NaN));
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("--cap <usd> is required for this campaign");
  const quietMs = Number(values["quiet-ms"] ?? QUIET_MS);
  const instanceInfo = INSTANCES[side];
  const instance = new LegacyInstance(instanceInfo.url, boardToken(join(instanceInfo.worktree, "data")));
  const t3 = liveT3(join(instanceInfo.worktree, "data"));
  for (const spec of values.jobs.split(",")) {
    const [task, run] = spec.split(":") as [TaskId, string];
    if (!TASK_IDS.includes(task) || !Number.isInteger(Number(run))) throw new Error(`bad job ${spec}`);
    const costs = liveCosts();
    const { spent, allowed } = capGate(campaign, cap, (job) => jobSpend(job, costs));
    log(`campaign ${campaign}: $${spent.toFixed(2)} spent of the $${cap} cap`);
    if (!allowed) {
      log(`cap reached: ${side} ${task}#${run} not started`);
      process.exitCode = 3;
      return;
    }
    const job = new Job({ campaign, side, task, run: Number(run), instance, worktree: instanceInfo.worktree, t3, cap, quietMs, dry: false }, spent);
    await runOrAbort(job);
  }
}

export const promptSha256 = (task: TaskId) => createHash("sha256").update(TASKS[task].prompt).digest("hex");

if (import.meta.main) {
  await main();
}

