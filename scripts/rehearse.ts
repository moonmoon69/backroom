/**
 * The browser rehearsal on a throwaway service (stage 4/5 plan, item L5: `--step ui`; Z2 adds `--step room`).
 *
 *   node scripts/rehearse.ts --step ui|room --as <rooms-browser key> [--browser backroom-dev] [--port 4471]
 *        [--data <dir>] [--out <dir>] [--keep]
 *
 * It starts its own service from this checkout (ROOMS_ADAPTER=fake ROOMS_ENGINE=1 ROOMS_PORT=<port>
 * ROOMS_DATA_DIR=<dir>, the throwaway service of the plan's conventions; never the user's :4400), scripts a room with
 * a Consigliere, a worker and a reviewer, and for every state the page must show checks two things: the room snapshot
 * from the API (GET /api/rooms/:id) has the expected fields, and `rooms-browser … wait-for <text>` printed a match in
 * the user's view of it. After each step it reads `rooms-browser … console` and fails on any error-level line. The
 * first failure ends the run with exit code 1; a screenshot of each state goes to --out.
 *
 * How the room is played:
 * - The user's messages and controls go through /api/commands, the members' through `rooms-board` (bin/rooms-board.mjs,
 *   with their own keys), and the browser clicks Retry, Dismiss, Cancel and an approval as the user would.
 * - T3's side is the fake adapter, held per thread through its test controls (/api/fake/*, src/server/fakeControls.ts):
 *   each run stays running until the script ends it, so every state holds while it is checked.
 * - Members are seated by creating them (L4b seats them on the journal), and the Consigliere is designated with
 *   room.consigliere.set, which briefs the others with journal requests; nothing is seated or briefed by hand.
 * - Three states the L1 host never produces by itself are written as engine commands to the journal (board.sqlite,
 *   through a second connection, which the host replays): a run in phase "uncertain" (the host writes it only on its way
 *   to failing a run), an output whose claim comes out "late" (the host never names a closed request), and a blocked
 *   delivery (a reservation over a tiny byte budget; the real one is 4 MiB). Each is a command `decide` accepts.
 *   (`--step ui` only.)
 *
 * `--step room` (Z2) plays one whole job with nothing written by hand: the user's assignment from the composer, the
 * Consigliere hands it to the worker, the worker asks the reviewer, a review finding, the user's correction from the page
 * passed on by the Consigliere, the service killed (SIGKILL) and started again while two turns run, PASS, his report;
 * then a turn T3 fails and the user's Retry from the page, a reseat, and a retire (refused first while the member has
 * work). The fake T3 keeps its threads in <data>/fake-t3.json (ROOMS_FAKE_STATE), so it comes back from the kill as
 * real T3 would, since T3 is not Backroom's process; the script reads that file as T3's own record of what it ran.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EngineStore } from "../src/engine/index.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------- options ----------------

interface Options {
  step: "ui" | "room";
  as: string;
  browser: string;
  port: number;
  data: string;
  out: string;
  cli: string;
  keep: boolean;
}

function options(argv: string[]): Options {
  const take = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const step = take("--step");
  const as = take("--as");
  if (step !== "ui" && step !== "room") fail("usage: node scripts/rehearse.ts --step ui|room --as <rooms-browser key>");
  if (!as) fail("--as <key> is required: the rooms-browser key of the room whose browser this uses");
  const data = resolve(take("--data") ?? join(repo, "data", `rehearse-${step}`));
  return {
    step,
    as,
    browser: take("--browser") ?? "backroom-dev",
    port: Number(take("--port") ?? 4471),
    data,
    out: resolve(take("--out") ?? join(data, "screens")),
    cli: take("--browser-cli") ?? process.env.ROOMS_BROWSER_CLI ?? browserCli(),
    keep: argv.includes("--keep"),
  };
}

/** rooms-browser of the checkout whose service runs the shared browsers: this one's, else the main working tree's. */
function browserCli(): string {
  if (existsSync(join(repo, "data", "browser-api.json"))) return join(repo, "bin", "rooms-browser");
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
  return join(dirname(common), "bin", "rooms-browser");
}

// ---------------- plumbing ----------------

const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class RehearsalFailure extends Error {}
function fail(message: string): never {
  throw new RehearsalFailure(message);
}

/** Poll until `probe` gives a value (not null, undefined or false). */
async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 20_000, every = 200): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    await sleep(every);
  }
  fail(`timed out after ${ms / 1000} s waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ""}`);
}

// ---------------- the throwaway service ----------------

class Service {
  readonly base: string;
  private readonly o: Options;
  private child: ChildProcess | null = null;
  constructor(o: Options) {
    this.o = o;
    this.base = `http://127.0.0.1:${o.port}`;
  }

  async start(): Promise<void> {
    if (await fetch(`${this.base}/api/status`).then(() => true, () => false)) fail(`something already answers on ${this.base}: stop it or pass --port`);
    if (!existsSync(join(repo, "web", "dist", "index.html"))) fail("web/dist is missing: run npm run build:web first");
    if (existsSync(this.o.data)) {
      if (!existsSync(join(this.o.data, ".rehearse"))) fail(`${this.o.data} exists and is not a rehearsal's data directory; pass another --data`);
      rmSync(this.o.data, { recursive: true, force: true });
    }
    mkdirSync(this.o.data, { recursive: true });
    writeFileSync(join(this.o.data, ".rehearse"), "data of scripts/rehearse.ts; deleted by its next run\n");
    await this.spawn();
    log(`service on ${this.base} (data ${this.o.data}, log service.log there)`);
  }

  private async spawn(): Promise<void> {
    const logFd = openSync(join(this.o.data, "service.log"), "a");
    // The room step's fake T3 keeps its threads in a file, so they outlive a restart of the service as T3's do.
    const kept = this.o.step === "room" ? { ROOMS_FAKE_STATE: this.t3File } : {};
    // Its own process group: a signal meant for this script's group (a terminal's Ctrl-C aside) does not reach it.
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "src/server/index.ts"], {
      cwd: repo,
      env: { ...process.env, ROOMS_ADAPTER: "fake", ROOMS_ENGINE: "1", ROOMS_PORT: String(this.o.port), ROOMS_DATA_DIR: this.o.data, ROOMS_SPEECH: "off", ...kept },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      if (this.child === child) log(`the service exited by itself (code ${code}, signal ${signal}): see ${join(this.o.data, "service.log")}`);
    });
    await until("the service to answer", () => fetch(`${this.base}/api/status`).then((r) => r.ok), 30_000, 300);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill("SIGTERM");
  }

  /** The service dies as in a crash (SIGKILL: no shutdown of any kind), and nothing answers on its port any more. */
  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) fail("no service to kill");
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
    await until("the port to be free", () => fetch(`${this.base}/api/status`).then(() => false, () => true), 10_000);
  }

  /** Started again on the same data directory (and the fake T3's same file). */
  async restart(): Promise<void> {
    await this.spawn();
  }

  get t3File(): string {
    return join(this.o.data, "fake-t3.json");
  }
  /** The fake T3's own record (the room step only): each thread's runs, in order, as T3 keeps them. */
  t3Runs(threadId: string): Array<{ id: string; status: string }> {
    const state = JSON.parse(readFileSync(this.t3File, "utf8")) as { threads: Array<{ shell: { id: string }; runs: Array<{ id: string; status: string }> }> };
    return (state.threads.find((t) => t.shell.id === threadId)?.runs ?? []).map((r) => ({ id: r.id, status: r.status }));
  }
  /** service.log from a given length on: what the service logged since then. */
  logSince(offset: number): string {
    return readFileSync(join(this.o.data, "service.log"), "utf8").slice(offset);
  }
  logLength(): number {
    return readFileSync(join(this.o.data, "service.log"), "utf8").length;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const init = { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, init);
    } catch (error) {
      // A kept-alive connection the service closed while this script sat in a long browser step: the request never
      // reached it, so it is sent once more on a fresh connection. Anything else is a real failure.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      if (!/UND_ERR_SOCKET|ECONNRESET|other side closed/.test(`${cause?.code ?? ""} ${cause?.message ?? ""}`)) throw new Error(`${method} ${path}: ${(error as Error).message} (${cause?.code ?? cause?.message ?? "no cause"})`);
      log(`  (${method} ${path}: the kept-alive connection was closed; sent again)`);
      response = await fetch(`${this.base}${path}`, init);
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return json as T;
  }
  command<T = any>(command: Record<string, unknown>): Promise<T> {
    return this.call<T>("POST", "/api/commands", command);
  }
  fake(action: string, body: Record<string, unknown>): Promise<any> {
    return this.call("POST", `/api/fake/${action}`, body);
  }
}

// ---------------- the browser (rooms-browser, the room's shared Chrome) ----------------

class Browser {
  private tabId: string | null = null;
  private shots = 0;
  private readonly o: Options;
  private readonly url: string;
  constructor(o: Options, url: string) {
    this.o = o;
    this.url = url;
  }

  private run(args: string[], timeoutMs = 60_000): { ok: boolean; out: string } {
    try {
      return { ok: true, out: execFileSync(this.o.cli, [this.o.browser, ...args, "--as", this.o.as], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
    }
  }
  /** Our tab: the one rooms-browser marks as ours on this service's URL (found again each time; ids may shift). */
  private tab(): string {
    const listing = this.run(["tabs"]).out;
    const mine = listing.split("\n").map((line) => /^(\d+): .*\((https?:\/\/[^)]*)\) \[yours\]/.exec(line)).filter((m): m is RegExpExecArray => m !== null && m[2]!.startsWith(this.url));
    const id = mine.at(-1)?.[1] ?? this.tabId;
    if (!id) fail(`no tab of ours on ${this.url}:\n${listing}`);
    this.tabId = id;
    return id;
  }
  on(...args: string[]): string {
    const result = this.run([this.tab(), ...args]);
    if (!result.ok) fail(`rooms-browser ${args[0]} failed: ${result.out.trim().slice(0, 400)}`);
    return result.out;
  }

  open(): void {
    const result = this.run(["open", `${this.url}/`]);
    if (!result.ok) fail(`could not open a tab: ${result.out}`);
    this.tab();
    // A fresh start: whatever an earlier rehearsal (or anyone) left in this origin's storage would open another room.
    this.on("eval", "() => { localStorage.clear(); sessionStorage.clear(); return true; }");
    this.on("reload");
  }
  close(): void {
    if (this.tabId) this.run([this.tab(), "close"]);
    this.tabId = null;
  }

  /** `wait-for` must print a match; it fails after its own 30 s. */
  waitFor(text: string): void {
    const result = this.run([this.tab(), "wait-for", text], 90_000);
    if (!result.ok || !/Element matching one of .* found\./.test(result.out)) fail(`the page never showed ${JSON.stringify(text)}: ${result.out.trim().split("\n")[0]}`);
    log(`  page: wait-for ${JSON.stringify(text)} matched`);
  }
  /** Error-level console lines accepted once: the browser's own, for requests it could not make while the service was down. */
  private readonly outage = new Set<string>();
  private errorLines(): string[] {
    return this.on("console").split("\n").filter((line) => /\[error\]/i.test(line));
  }
  /** Any error-level console line since the page loaded fails the rehearsal. */
  consoleClean(): void {
    const errors = this.errorLines().filter((line) => !this.outage.has(line));
    if (errors.length > 0) fail(`error-level console lines:\n${errors.join("\n")}`);
  }
  /**
   * After the service was down: the lines Chrome itself writes for requests to it that failed then (connection refused
   * or cut) are expected, are logged, and are not counted again; any other error-level line fails as always.
   */
  acceptOutage(): string[] {
    const fresh = this.errorLines().filter((line) => !this.outage.has(line));
    const other = fresh.filter((line) => !/net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED)/.test(line));
    if (other.length > 0) fail(`error-level console lines around the restart:\n${other.join("\n")}`);
    for (const line of fresh) this.outage.add(line);
    return fresh;
  }
  /** Poll the page (every half second) until `ok` holds for what `fn` reads; the last reading goes into the failure. */
  poll<T>(what: string, fn: string, ok: (value: T) => boolean, ms = 15_000): T {
    const start = Date.now();
    let reads = 1;
    let value = this.eval<T>(fn);
    while (!ok(value) && Date.now() < start + ms) {
      execFileSync("sleep", ["0.5"]);
      value = this.eval<T>(fn);
      reads += 1;
    }
    if (!ok(value)) fail(`${what}, after ${reads} reads in ${((Date.now() - start) / 1000).toFixed(1)} s: ${JSON.stringify(value)}`);
    if (reads > 1) log(`  page: ${what}: as expected on read ${reads}, after ${((Date.now() - start) / 1000).toFixed(1)} s`);
    return value;
  }
  /** Open a room from the overview by its card, matched on its exact title: a kept thread's card ("<room> · alias") and a
   *  room whose title only starts the same ("<room> B") are other cards. */
  openRoom(title: string): void {
    const exact = new RegExp(`button "[^"]*".* description="Open ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    this.waitFor(title);
    this.click(exact);
    this.poll<string | null>(`the room ${JSON.stringify(title)} to open`, "() => document.querySelector('.sheet-title h1')?.textContent ?? null", (t) => t === title);
    log(`  page: opened the room ${JSON.stringify(title)} by its card`);
  }
  eval<T>(fn: string): T {
    const out = this.on("eval", fn);
    const json = /```json\s*([\s\S]*?)```/.exec(out)?.[1] ?? /```\s*([\s\S]*?)```/.exec(out)?.[1] ?? out;
    try {
      return JSON.parse(json.trim()) as T;
    } catch {
      return json.trim() as T;
    }
  }
  /** The uid of the first element in the page snapshot whose line matches. */
  uid(pattern: RegExp): string {
    const snapshot = this.on("snapshot");
    const line = snapshot.split("\n").find((l) => pattern.test(l));
    const uid = line ? /uid=(\S+)/.exec(line)?.[1] : undefined;
    if (!uid) fail(`nothing on the page matches ${pattern}`);
    return uid;
  }
  click(pattern: RegExp): void {
    this.on("click", this.uid(pattern));
  }
  fill(pattern: RegExp, text: string): void {
    this.on("fill", this.uid(pattern), text);
  }
  /** Bring a post into view (the timeline follows the bottom). */
  show(number: number): void {
    this.on("eval", `() => { const el = document.querySelector('.timeline [data-number="${number}"]'); el?.scrollIntoView({ block: "center" }); return Boolean(el); }`);
  }
  screenshot(name: string): void {
    const out = this.on("screenshot");
    const path = /Saved screenshot to (.+?\.png)/.exec(out)?.[1];
    if (!path) fail(`no screenshot path in: ${out}`);
    mkdirSync(this.o.out, { recursive: true });
    const target = join(this.o.out, `${String(++this.shots).padStart(2, "0")}-${name}.png`);
    copyFileSync(path, target);
    try {
      unlinkSync(path);
    } catch {
      // rooms-browser's own folder; leaving it is harmless
    }
    log(`  screenshot ${target}`);
  }
}

// ---------------- the room ----------------

type Snapshot = {
  room: { id: string; title: string; consigliereId: string | null };
  bindings: Array<{ id: string; participantId: string; threadId: string }>;
  /** The journal's length: every event, posts and the board's own records. */
  head: number;
  posts: any[];
  requests: any[];
  runs: any[];
  seats: any[];
  needsYou: any[];
  blocked: any[];
  nativeRequests: any[];
  counts: { needsYou: number; busy: number; waiting: number; working: number; openRequests: number };
  notices: { through: number; ids: string[] };
  news: { seenSeq: number; unseen: number; latest: { seq: number; number: number; kind: string } | null };
};

const MEMBERS = ["fable", "worker", "reviewer"] as const;
type Alias = (typeof MEMBERS)[number];

class Room {
  roomId = "";
  title = "";
  readonly participant = {} as Record<Alias, string>;
  readonly seat = {} as Record<Alias, string>;
  readonly thread = {} as Record<Alias, string>;
  /** Each member's alias now: a reseat's fresh seat has a numbered one ("worker2"). */
  readonly name: Record<Alias, string> = { fable: "fable", worker: "worker", reviewer: "reviewer" };
  private readonly service: Service;
  private readonly o: Options;
  constructor(service: Service, o: Options) {
    this.service = service;
    this.o = o;
  }
  get dataDir(): string {
    return this.o.data;
  }

  async create(title: string): Promise<void> {
    const model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    this.title = title;
    this.roomId = (await this.service.command<{ roomId: string }>({ type: "room.create", projectId: "project_demo", title, consigliere: false })).roomId;
    for (const alias of MEMBERS) {
      this.participant[alias] = (await this.service.command<{ participantId: string }>({ type: "participant.create", roomId: this.roomId, alias, modelSelection: model, thread: { mode: "create" } })).participantId;
    }
    // Creating a member seats it on the journal (L4b): seat ID = its binding's ID. Nothing is seated by hand.
    let snap = await this.snapshot();
    for (const alias of MEMBERS) {
      const binding = snap.bindings.find((b) => b.participantId === this.participant[alias])!;
      this.seat[alias] = binding.id;
      this.thread[alias] = binding.threadId;
    }
    // T3's side waits for the script: no run ends by itself.
    for (const alias of MEMBERS) await this.service.fake("hold", { threadId: this.thread[alias], hold: true });
    snap = await until("the three seats on the journal", async () => {
      const s = await this.snapshot();
      return MEMBERS.every((alias) => s.seats.some((seat) => seat.seatId === this.seat[alias])) ? s : null;
    });
    // His designation briefs the other members (L4b): each acknowledges in a turn of its own.
    await this.service.command({ type: "room.consigliere.set", roomId: this.roomId, participantId: this.participant.fable });
    for (const alias of MEMBERS) await this.settle(alias);
    log(`room ${this.roomId}: ${MEMBERS.map((a) => `@${a}`).join(", ")} seated; @fable is the Consigliere; the others acknowledged their seat briefing`);
  }

  snapshot(): Promise<Snapshot> {
    return this.service.call<Snapshot>("GET", `/api/rooms/${this.roomId}`);
  }

  /** Another room, without a Consigliere, with these members (seated by L4b) and their runs held. */
  async second(title: string, aliases: string[]): Promise<{ roomId: string; participant: Record<string, string>; snapshot: () => Promise<Snapshot>; attach: () => Promise<string> }> {
    const model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    const roomId = (await this.service.command<{ roomId: string }>({ type: "room.create", projectId: "project_demo", title, consigliere: false })).roomId;
    const participant: Record<string, string> = {};
    for (const alias of aliases) participant[alias] = (await this.service.command<{ participantId: string }>({ type: "participant.create", roomId, alias, modelSelection: model, thread: { mode: "create" } })).participantId;
    const snapshot = () => this.service.call<Snapshot>("GET", `/api/rooms/${roomId}`);
    for (const binding of (await snapshot()).bindings) await this.service.fake("hold", { threadId: binding.threadId, hold: true });
    // A 1×1 PNG, uploaded as the composer uploads an image.
    const attach = async () => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const response = await fetch(`${this.service.base}/api/rooms/${roomId}/attachments`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "pixel.png" }, body: png });
      if (!response.ok) fail(`uploading an image: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { id: string }).id;
    };
    log(`room ${roomId}: ${aliases.map((a) => `@${a}`).join(", ")}, no Consigliere`);
    return { roomId, participant, snapshot, attach };
  }
  key(alias: Alias): string {
    return `${this.name[alias]}.${this.roomId.slice(0, 8)}`;
  }
  /** A member's rooms-board command, with its own key. */
  board(alias: Alias, ...args: string[]): string {
    try {
      const out = execFileSync(process.execPath, [join(repo, "bin", "rooms-board.mjs"), "--api", join(this.o.data, "browser-api.json"), "--as", this.key(alias), ...args], { encoding: "utf8" }).trim();
      log(`  @${alias}$ rooms-board ${args.join(" ").slice(0, 80)} → ${out.split("\n")[0]}`);
      return out;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      fail(`rooms-board ${args[0]} as @${alias} failed: ${(e.stderr || e.stdout || "").trim()}`);
    }
  }
  /** A member command the board must refuse: its message. */
  refused(alias: Alias, ...args: string[]): string {
    try {
      const out = execFileSync(process.execPath, [join(repo, "bin", "rooms-board.mjs"), "--api", join(this.o.data, "browser-api.json"), "--as", this.key(alias), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      fail(`rooms-board ${args.join(" ")} as @${alias} was not refused: ${out.trim()}`);
    } catch (error) {
      if (error instanceof RehearsalFailure) throw error;
      const message = ((error as { stderr?: string }).stderr ?? "").trim();
      log(`  @${alias}$ rooms-board ${args.join(" ")} → refused: ${message.split("\n")[0]}`);
      return message;
    }
  }
  /** After a reseat: the member's fresh seat ("worker2") and thread take the old ones' place; its runs are held too. */
  async rebind(alias: Alias): Promise<void> {
    const s = await this.snapshot();
    const fresh = s.seats.find((x) => new RegExp(`^${alias}\\d+$`).test(x.alias ?? "") && x.status === "active" && x.seatId !== this.seat[alias]);
    if (!fresh) fail(`no fresh seat for @${alias}: ${JSON.stringify(s.seats.map((x) => [x.alias, x.status]))}`);
    this.name[alias] = fresh.alias;
    this.seat[alias] = fresh.seatId;
    this.thread[alias] = fresh.threadId;
    this.participant[alias] = fresh.participantId;
    await this.service.fake("hold", { threadId: fresh.threadId, hold: true });
  }
  /** A user message to the Consigliere; its request ID. */
  async message(text: string): Promise<string> {
    const result = await this.service.command<{ requestIds: string[] }>({
      type: "message.create",
      roomId: this.roomId,
      sourceText: text,
      clientMessageId: randomUUID(),
      attachmentIds: [],
      assignments: [{ recipients: [this.participant.fable], instruction: text, schedule: { mode: "now" }, after: [] }],
    });
    return result.requestIds[0]!;
  }
  /** The member's run once T3 runs it (and the room's other phases with it). */
  live(alias: Alias, phases = ["running"]): Promise<any> {
    return until(`@${alias}'s run`, async () => {
      const s = await this.snapshot();
      const seat = s.seats.find((x) => x.seatId === this.seat[alias]);
      const run = seat?.activeRunId ? s.runs.find((r) => r.id === seat.activeRunId) : null;
      return run && phases.includes(run.phase) ? run : null;
    });
  }
  /** End what T3 runs on the member's thread now (the script holds every run), and wait for the host to import it. */
  async finish(alias: Alias, text: string, extra: { outcome?: "completed" | "error" | "interrupted"; progress?: string[]; files?: unknown[] } = {}): Promise<void> {
    const before = await this.snapshot();
    const runId = before.seats.find((x) => x.seatId === this.seat[alias])?.activeRunId ?? null;
    await until(`T3 to run @${alias}'s turn`, () => this.service.fake("complete", { threadId: this.thread[alias], text, ...extra }).then(() => true), 20_000, 300);
    if (runId) await until(`@${alias}'s run to end`, async () => (await this.snapshot()).runs.find((r) => r.id === runId)?.phase === "terminal");
  }
  /** Wait until the member is idle with nothing unread; a wake the script did not plan for is ended and logged. */
  async settle(alias: Alias): Promise<void> {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const s = await this.snapshot();
      const seat = s.seats.find((x) => x.seatId === this.seat[alias]);
      if (seat && seat.activeRunId === null && seat.unread === 0) return;
      const run = seat?.activeRunId ? s.runs.find((r) => r.id === seat.activeRunId) : null;
      if (run && (run.phase === "running" || run.phase === "accepted" || run.phase === "uncertain")) {
        log(`  @${alias} woke again (run ${run.id.slice(0, 8)} on ${run.requestIds.length} request(s), inputs #${run.inputs.join(", #")}): ended with a note`);
        await this.finish(alias, "Noted.");
      }
      await sleep(300);
    }
    fail(`@${alias} did not settle`);
  }
  /** Append engine commands to the journal through a second connection, as another process would. */
  journal(commands: Array<Record<string, unknown>>): void {
    const store = new EngineStore(join(this.o.data, "board.sqlite"));
    try {
      for (const command of commands) {
        const receipt = store.execute(this.roomId, command as never);
        if (receipt.outcome !== "appended" && receipt.outcome !== "blocked") fail(`the journal refused ${String(command.type)}: ${JSON.stringify(receipt).slice(0, 300)}`);
      }
    } finally {
      store.close();
    }
  }
  post(s: Snapshot, requestId: string): any {
    const post = s.posts.find((p) => p.request?.id === requestId);
    if (!post) fail(`no post for request ${requestId}`);
    return post;
  }
}

// ---------------- the checks ----------------

class Checks {
  readonly passed: string[] = [];
  private readonly room: Pick<Room, "snapshot">;
  private readonly browser: Browser;
  constructor(room: Pick<Room, "snapshot">, browser: Browser) {
    this.room = room;
    this.browser = browser;
  }

  /**
   * One state: the snapshot has it (polled until `api` returns a description of the fields that show it), then the page
   * shows it (`wait-for` each text), the console is clean, and a screenshot is kept.
   */
  async state(name: string, api: (s: Snapshot) => string | null | false, page: string[], options: { show?: number; focus?: (s: Snapshot) => number | undefined; extra?: () => void } = {}): Promise<Snapshot> {
    log(`CHECK ${name}`);
    let described = "";
    const snap = await until(`the snapshot to show: ${name}`, async () => {
      const s = await this.room.snapshot();
      const found = api(s);
      if (!found) return null;
      described = found;
      return s;
    });
    log(`  api: ${described}`);
    const show = options.show ?? options.focus?.(snap);
    if (show !== undefined) this.browser.show(show);
    for (const text of page) this.browser.waitFor(text);
    options.extra?.();
    this.browser.consoleClean();
    if (show !== undefined) this.browser.show(show);
    this.browser.screenshot(name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase());
    this.passed.push(name);
    log(`PASS ${name}`);
    return snap;
  }
}

// ---------------- the rehearsal (--step ui) ----------------

async function rehearseUi(service: Service, browser: Browser, room: Room): Promise<string[]> {
  const check = new Checks(room, browser);
  const { seat } = room;
  const claimOf = (s: Snapshot, requestId: string, outcome: string) => s.posts.find((p) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === requestId && c.outcome === outcome));

  // Open the room as the user does: from the overview, then the board.
  browser.open();
  browser.openRoom(room.title);
  browser.consoleClean();
  browser.waitFor("Board");
  browser.click(/tab "Board/);
  browser.consoleClean();

  // 0. Backroom's seat briefings (L4b, in the user's name) are Backroom's on the board, and so are their acknowledgements.
  await check.state("Backroom's seat briefing, not the user's message", (x) => {
    const briefing = x.posts.find((p) => p.kind === "request" && p.author === "$user" && p.request.id.startsWith("seat-briefing:") && p.request.owner === seat.worker);
    const ack = briefing && claimOf(x, briefing.request.id, "answered");
    return briefing && ack ? `#${briefing.number} request ${briefing.request.id.slice(0, 24)}… by $user, answered by #${ack.number}` : null;
  }, ["Backroom → @worker: seat briefing", "(seat briefing)"]);

  // 1. The user asks the Consigliere; his turn runs: an open request, with who is on it.
  const ask = await room.message("Get the date parser fixed and reviewed, then report.");
  await room.live("fable");
  let s = await room.snapshot();
  const U = room.post(s, ask).number as number;
  await check.state("open marker on the user's request", (x) => {
    const post = room.post(x, ask);
    const run = x.runs.find((r) => r.seatId === seat.fable && r.phase === "running" && r.requestIds.includes(ask));
    return post.request.state === "open" && run && x.requests.some((q) => q.id === ask && q.runId === run.id) ? `#${post.number} request.state=open, run ${run.id.slice(0, 8)} phase=running works on it` : null;
  }, ["open · @fable working", "Working ·"], { show: U });

  // 2. He hands it to the worker and ends his turn: his final cannot answer it while that request is open.
  room.board("fable", "post", "@worker fix the date parser in src/dates.ts");
  s = await room.snapshot();
  const fix = s.requests.find((q) => q.owner === seat.worker && q.parentId === ask)?.id as string;
  if (!fix) fail("the Consigliere's post is not a child of the user's request");
  await room.finish("fable", "I asked @worker for the fix; I will report once it is reviewed.");
  await room.live("worker");
  const R = room.post(await room.snapshot(), fix).number as number;
  await check.state("a final that cannot answer yet (pending_activity)", (x) => {
    const out = claimOf(x, ask, "pending_activity");
    return out && room.post(x, ask).request.state === "open" ? `#${out.number} claims #${U}: pending_activity; #${U} still open with open child #${R}` : null;
  }, [`#${U} stays open: a review or background work is still running`, `waits on #${R}`], { show: U });

  // 3. The worker asks the reviewer; the reviewer's turn runs.
  room.board("worker", "post", "@reviewer review the date parser fix");
  s = await room.snapshot();
  const review = s.requests.find((q) => q.owner === seat.reviewer && q.parentId === fix)?.id as string;
  if (!review) fail("the worker's review request is not a child of its request");
  await room.finish("worker", "The fix is in; I asked @reviewer for a review.");
  const reviewRun = await room.live("reviewer");
  const V = room.post(await room.snapshot(), review).number as number;

  // 4. T3's acknowledgement of the reviewer's turn is lost: the run is uncertain while T3 still runs it.
  room.journal([{ type: "phase", actor: "$system", id: `rehearse:uncertain:${reviewRun.id}`, runId: reviewRun.id, phase: "uncertain", evidence: "rehearsal: T3's acknowledgement was lost" }]);
  await check.state("an uncertain run", (x) => {
    const run = x.runs.find((r) => r.id === reviewRun.id);
    return run?.phase === "uncertain" ? `run ${run.id.slice(0, 8)} of @reviewer phase=uncertain, requestIds=[${run.requestIds.length}]` : null;
  }, ["Uncertain: Backroom cannot tell whether T3 received this turn", "uncertain"]);

  // 5. What the T3 window showed: an approval, then a question, answered from the page.
  await service.fake("approval", { threadId: room.thread.reviewer });
  await check.state("an approval from T3, answered here", (x) => {
    const approval = x.nativeRequests.find((n) => n.participantId === room.participant.reviewer && n.kind === "approval");
    return approval && x.counts.needsYou >= 1 ? `nativeRequests: approval ${approval.requestId.slice(0, 8)} for @reviewer; counts.needsYou=${x.counts.needsYou}` : null;
  }, ["Accept for session", "Needs you ·"]);
  browser.click(/button "Accept"/);
  await until("the approval to be answered", async () => (await room.snapshot()).nativeRequests.length === 0);
  await service.fake("question", { threadId: room.thread.reviewer });
  await check.state("a question from T3, answered here", (x) => {
    const question = x.nativeRequests.find((n) => n.participantId === room.participant.reviewer && n.kind === "user-input");
    return question ? `nativeRequests: question ${question.requestId.slice(0, 8)} for @reviewer` : null;
  }, ["Proceed?", "Submit answers"]);
  browser.click(/radio "yes"/);
  browser.click(/button "Submit answers"/);
  await until("the question to be answered", async () => (await room.snapshot()).nativeRequests.length === 0);
  browser.consoleClean();

  // 6. The review passes; the worker's next final answers its request; the Consigliere reports.
  await room.finish("reviewer", "PASS: the fix is right and the tests cover leap years.", {
    progress: ["Reading the diff of src/dates.ts.", "Ran the date tests: 48 passed."],
    files: [{ path: "tests/dates.test.ts", kind: "modified", additions: 6, deletions: 1 }],
  });
  await room.live("worker");
  await room.finish("worker", "Fixed and reviewed: PASS from @reviewer.");
  await room.live("fable");
  await room.finish("fable", "Report: the date parser is fixed and reviewed (PASS).");
  s = await check.state("answered markers and 'answers #n'", (x) => {
    const done = [ask, fix, review].every((id) => room.post(x, id).request.state === "answered");
    const toUser = claimOf(x, ask, "answered");
    const toFable = claimOf(x, fix, "answered");
    const toWorker = claimOf(x, review, "answered");
    return done && toUser && toFable && toWorker
      ? `#${U}, #${R}, #${V} answered; #${toWorker.number} claims #${V}, #${toFable.number} claims #${R}, #${toUser.number} claims #${U} (outcome answered); markers point at them`
      : null;
  }, [`answers #${V} from @worker`, `answers #${R} from @fable`, `answers #${U} from you`]);
  const answeredBy = room.post(s, ask).request.answer.number as number;
  browser.show(U);
  browser.waitFor(`answered · #${answeredBy}`);
  // The turn behind the review's answer, as T3 shows it: its earlier messages and the files it changed.
  const reviewAnswer = claimOf(s, review, "answered");
  browser.show(reviewAnswer.number);
  browser.on("eval", `() => { const d = document.querySelector('.timeline [data-number="${reviewAnswer.number}"] details.turn-in-t3'); if (d) d.open = true; return Boolean(d); }`);
  browser.waitFor("Ran the date tests: 48 passed.");
  browser.waitFor("1 file changed");
  browser.consoleClean();
  browser.screenshot("the-turn-in-t3-behind-a-reply");
  log("  page: the review's reply opens to its turn in T3 (earlier messages, files changed)");
  // What the Consigliere was sent for the turn that reported: the exact briefing T3 received.
  const report = claimOf(s, ask, "answered");
  browser.show(report.number);
  browser.on("eval", `() => { const d = document.querySelector('.timeline [data-number="${report.number}"] details.sent-to-t3'); if (d) d.open = true; return Boolean(d); }`);
  browser.waitFor("[Backroom briefing for @fable");
  browser.consoleClean();
  browser.screenshot("what-a-turn-was-sent");
  log("  page: the report opens to the briefing its turn was sent");

  // 7. The reviewer's agent goes on by itself after its answer (a self-started turn): a note marked "after answer".
  await service.fake("self-run", { threadId: room.thread.reviewer });
  await room.finish("reviewer", "One more thing: the fix also needs a test for 1900-02-29.");
  await check.state("'after answer' on a note from a self-started turn", (x) => {
    const note = x.posts.find((p) => p.kind === "note" && p.author === seat.reviewer && p.note.source === "t3-turn" && p.note.afterAnswer);
    return note ? `#${note.number} note by @reviewer source=t3-turn afterAnswer=true about #${note.about.map((r: any) => r.number).join(", #")}` : null;
  }, ["after answer", "continued on its own", "One more thing: the fix also needs a test for 1900-02-29."], {
    focus: (x) => x.posts.find((p) => p.kind === "note" && p.author === seat.reviewer && p.note.afterAnswer)?.number,
  });

  // 8. A turn the user stops fails: the notice needs the user, with Retry; Retry is clicked on the page.
  await room.settle("fable");
  const changelog = await room.message("Also update the changelog.");
  await room.live("fable");
  await service.command({ type: "run.stop", roomId: room.roomId, participantId: room.participant.fable });
  s = await check.state("a failed turn that needs you, with Retry and Dismiss", (x) => {
    const notice = x.needsYou.find((p) => p.notice.retryRunId && p.about.some((r: any) => r.requestId === changelog));
    return notice && x.counts.needsYou >= 1 ? `needsYou #${notice.number} intent=${notice.notice.intent} retryRunId=${notice.notice.retryRunId.slice(0, 8)}; counts.needsYou=${x.counts.needsYou}` : null;
  }, ["Needs you ·", "Retry", "Dismiss"], { focus: (x) => x.needsYou.find((p) => p.about.some((r: any) => r.requestId === changelog))?.number });
  browser.click(/button "Retry"/);
  await check.state("Retry: the run sent again", (x) => {
    const retried = x.posts.find((p) => p.kind === "notice" && p.notice.retried && p.about.some((r: any) => r.requestId === changelog));
    const retry = x.posts.find((p) => p.kind === "retry");
    return retried && retry && !x.needsYou.some((p) => p.id === retried.id) ? `notice #${retried.number} retried=true, retry post #${retry.number}, needsYou no longer lists it` : null;
  }, ["retried a failed turn"], { focus: (x) => x.posts.find((p) => p.kind === "retry")?.number });
  await room.live("fable");
  await room.finish("fable", "Changelog updated.");

  // 9. Another stopped turn: Dismiss takes it off "needs you"; then the user cancels the request from the page.
  await room.settle("fable");
  const tag = await room.message("Tag the release.");
  await room.live("fable");
  await service.command({ type: "run.stop", roomId: room.roomId, participantId: room.participant.fable });
  s = await until("the second notice", async () => {
    const x = await room.snapshot();
    return x.needsYou.some((p) => p.about.some((r: any) => r.requestId === tag)) ? x : null;
  });
  const T = room.post(s, tag).number as number;
  browser.show(T);
  browser.waitFor("Dismiss");
  browser.click(/button "Dismiss"/);
  await check.state("Dismiss: off 'needs you', still on the board", (x) => {
    const notice = x.posts.find((p) => p.kind === "notice" && p.about.some((r: any) => r.requestId === tag));
    return notice && notice.notice.dismissed && !notice.notice.needsYou && !x.needsYou.some((p) => p.id === notice.id) ? `notice #${notice.number} dismissed=true needsYou=false; marks ${JSON.stringify(x.notices)}` : null;
  }, ["dismissed"], { show: T });
  browser.click(/button "Cancel" description="Withdraw it/);
  await check.state("Cancel from the page: the request's marker", (x) => {
    const post = room.post(x, tag);
    return post.request.state === "cancelled" ? `#${post.number} request.state=cancelled` : null;
  }, ["cancelled", `you cancelled #${T}`], { show: T });

  // 10. The Consigliere asks for more; the worker says it is still working: "working since" on the request and member.
  room.board("fable", "post", "@worker add a --strict flag to the parser");
  s = await room.snapshot();
  const flag = s.requests.find((q) => q.owner === seat.worker && q.parentId === null)?.id as string;
  if (!flag) fail("no request to the worker for the flag");
  const flagRun = await room.live("worker");
  const F = room.post(await room.snapshot(), flag).number as number;
  room.board("worker", "working", `#${F}`, "wiring the --strict flag through the CLI");
  await room.finish("worker", "Started on the flag; it is not done yet.");
  await check.state("'working since' on the request and the member", (x) => {
    const request = x.requests.find((q) => q.id === flag);
    const worker = x.seats.find((w) => w.seatId === seat.worker);
    const activity = worker?.activities.find((a: any) => a.requestIds.includes(flag));
    return request?.activityIds.length && activity?.memberHeld && x.counts.working >= 1
      ? `#${F} activityIds=[${request.activityIds.join(", ")}]; @worker seat activity ${activity.id.slice(0, 18)} memberHeld=true since=${activity.since}; counts.working=${x.counts.working}`
      : null;
  }, ["working since", "wiring the --strict flag through the CLI"], {
    show: F,
    extra: () => {
      // On the request's own row, not only the status bar's chip.
      const row = browser.eval<boolean>(`() => Boolean(document.querySelector('.timeline [data-number="${F}"]')?.textContent.includes('working since'))`);
      if (row !== true) fail(`#${F}'s row on the board does not say 'working since'`);
      log(`  page: #${F}'s own row says working since`);
      browser.click(/button "Members \(/);
      browser.waitFor(`on #${F}`);
      const member = browser.eval<boolean>(`() => [...document.querySelectorAll('.participant-chip')].some((chip) => chip.textContent.includes('worker') && chip.textContent.includes('working since') && chip.textContent.includes('on #${F}'))`);
      if (member !== true) fail("the worker's card does not say 'working since … on #n'");
      log("  page: the worker's card says working since … on the request");
      browser.screenshot("working-since-on-the-member");
      browser.click(/button "Members \(/);
    },
  });

  // 11. The Consigliere cancels it; the worker's answer arrives after that: its claim comes out late.
  room.board("fable", "cancel", `#${F}`);
  await until("the flag request cancelled", async () => room.post(await room.snapshot(), flag).request.state === "cancelled");
  room.journal([{ type: "output", actor: seat.worker, id: `rehearse:late:${randomUUID()}`, author: seat.worker, sourceKey: `answer:${seat.worker}:rehearse-late`, association: { kind: "run", id: flagRun.id }, body: "The --strict flag is in.", disposition: { kind: "answer", requestIds: [flag] } }]);
  await check.state("a late output", (x) => {
    const late = claimOf(x, flag, "late");
    return late ? `#${late.number} by @worker claims #${F}: late (the request was cancelled)` : null;
  }, [`late for #${F}: it was cancelled`], { focus: (x) => claimOf(x, flag, "late")?.number });
  // The late answer's attention notice wakes the Consigliere once, and the cancel told the worker.
  await room.settle("fable");
  await room.settle("worker");

  // 12. Someone types in T3 on the reviewer's thread; a post for the reviewer waits for that turn: the waiting backlog.
  await service.fake("external-run", { threadId: room.thread.reviewer, text: "Quick check from T3: is the build green?" });
  room.board("fable", "post", "@reviewer check the changelog wording");
  s = await room.snapshot();
  const wording = s.requests.find((q) => q.owner === seat.reviewer && q.parentId === null)?.id as string;
  await check.state("waiting: unread backlog, no run", (x) => {
    const reviewer = x.seats.find((w) => w.seatId === seat.reviewer);
    return reviewer && reviewer.unread >= 1 && reviewer.activeRunId === null && x.counts.waiting >= 1 ? `@reviewer unread=${reviewer.unread} activeRunId=null; counts.waiting=${x.counts.waiting}` : null;
  }, ["Waiting ·", "1 unread", "Quick check from T3: is the build green?"]);

  // 13. A delivery over the byte budget: blocked.
  room.journal([{ type: "reserve", actor: "$system", id: `rehearse:blocked:${randomUUID()}`, seatId: seat.reviewer, runId: randomUUID(), dispatchCommandId: randomUUID(), dispatchMessageId: randomUUID(), maxBytes: 64 }]);
  await check.state("a blocked delivery", (x) => {
    const reviewer = x.seats.find((w) => w.seatId === seat.reviewer);
    const post = x.posts.find((p) => p.kind === "blocked" && p.blocked.seatId === seat.reviewer);
    return reviewer?.blocked && x.blocked.length >= 1 && post ? `seat.blocked #${reviewer.blocked.number} requiredBytes=${reviewer.blocked.requiredBytes}; blocked post #${post.number}; snapshot.blocked=${x.blocked.length}` : null;
  }, ["blocked delivery", "cannot reach @reviewer"], { focus: (x) => x.posts.find((p) => p.kind === "blocked")?.number });

  // 14. The turn typed in T3 ends: imported as notes; the waiting post is then delivered and answered.
  await room.finish("reviewer", "Build is green.");
  await check.state("a turn typed in T3, on the board", (x) => {
    const prompt = x.posts.find((p) => p.kind === "note" && p.author === "$user" && p.note.source !== "post" && p.body.includes("Quick check from T3"));
    const reply = x.posts.find((p) => p.kind === "note" && p.author === seat.reviewer && p.note.source === "t3-turn" && p.body.includes("Build is green."));
    return prompt && reply ? `#${prompt.number} note by the user (${prompt.note.source}), #${reply.number} note by @reviewer (t3-turn)` : null;
  }, ["Build is green."], { focus: (x) => x.posts.find((p) => p.kind === "note" && p.body.includes("Build is green."))?.number });
  await room.live("reviewer");
  await room.finish("reviewer", "The changelog wording is fine.");
  await until("the reviewer's answer", async () => room.post(await room.snapshot(), wording).request.state === "answered");
  await room.live("fable");
  await room.finish("fable", "Thanks, all done.");

  // 15. The composer's plan rows (D2: "now" or "next", nothing else): "now" for an idle Consigliere; "next" for a T3
  // command to a member mid-turn in T3 (it queues behind that turn); "now" into the turn for a busy Consigliere (in his
  // room a message goes into his running turn); and /hold refused before anything is sent.
  await room.settle("fable");
  await room.settle("worker");
  const pills = () => browser.eval<string[]>("() => [...document.querySelectorAll('.plan-pill')].map((pill) => pill.textContent.trim())");
  const titles = () => browser.eval<string[]>("() => [...document.querySelectorAll('.plan-pill')].map((pill) => pill.title)");
  /**
   * The plan row for what was just typed reads `expected` (and its title says `title`), polled on the pill itself: the
   * page learns of a member's state on its next read of the room (a turn typed in T3 appends nothing to the journal,
   * so only the room's timer brings it), and the words "now" and "next" also occur elsewhere on the page.
   */
  const pillReads = (typed: string, expected: string, what: string, title?: string) => {
    browser.waitFor(typed);
    const ok = () => JSON.stringify(pills()) === JSON.stringify([expected]) && (title === undefined || (titles()[0] ?? "").includes(title));
    const end = Date.now() + 15_000;
    while (!ok() && Date.now() < end) execFileSync("sleep", ["0.5"]);
    if (!ok()) fail(`plan rows for ${what}: ${JSON.stringify(pills())} ${JSON.stringify(titles())}`);
  };
  browser.click(/button "(Write a message|Continue your draft)"/);
  browser.fill(/textbox "Message"/, "Thanks for the report.");
  pillReads("Thanks for the report.", "now", "an idle Consigliere");
  await service.fake("external-run", { threadId: room.thread.worker, text: "Looking at something in T3." });
  const notes = await room.message("Draft the release notes.");
  await room.live("fable");
  await check.state("plan rows: now and next only (D2)", (x) => {
    const run = x.runs.find((r) => r.seatId === seat.fable && r.phase === "running" && r.requestIds.includes(notes));
    const worker = (x as unknown as { participantStatus: Record<string, { externalActivity: boolean }> }).participantStatus[room.participant.worker];
    return run && worker?.externalActivity ? `@fable run ${run.id.slice(0, 8)} running; @worker in a turn typed in T3 (externalActivity=true)` : null;
  }, [], {
    extra: () => {
      browser.fill(/textbox "Message"/, "@worker /compact");
      pillReads("T3 command", "next", "a T3 command to a member in a turn typed in T3");
      browser.screenshot("plan-row-next");
      browser.fill(/textbox "Message"/, "Also mention the parser fix.");
      pillReads("Also mention the parser fix.", "now", "a busy Consigliere (into his running turn)", "running turn");
      log(`  page: plan rows "now" (idle), "next" (@worker /compact while @worker is in a turn), "now" into @fable's running turn (${titles()[0]})`);
      browser.fill(/textbox "Message"/, "/hold write it later");
      browser.waitFor("/hold is gone");
      if (browser.eval<boolean>("() => [...document.querySelectorAll('.composer-toolbar button.primary')].every((b) => b.disabled)") !== true) fail("Send is not disabled for a /hold message");
      log("  page: /hold refused before sending, Send disabled");
    },
  });
  await room.finish("worker", "Done looking.");

  // 15b. Sent from the composer: in his room every message is a steer. To the busy Consigliere it goes into his running
  // turn ("into the turn"); to him idle it starts a turn of its own (no such tag).
  const rowSays = (body: string, words: string) =>
    browser.eval<boolean>(`() => [...document.querySelectorAll('.timeline .chat-row.from-user')].some((row) => row.textContent.includes(${JSON.stringify(body)}) && row.textContent.includes(${JSON.stringify(words)}))`);
  const sent = (body: string) => async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === body);
  browser.fill(/textbox "Message"/, "Also mention the parser fix.");
  browser.on("press", "Enter");
  await check.state("a message steered into the running turn", (x) => {
    const p = x.posts.find((q) => q.kind === "request" && q.author === "$user" && q.body === "Also mention the parser fix.");
    const run = p && x.runs.find((r) => r.reservedSeq < p.seq && r.inputs.includes(p.seq));
    return p && p.request.message?.steer && run ? `#${p.number} request.message.steer=true, delivered by run ${run.id.slice(0, 8)} reserved at #${run.reservedSeq} (before it)` : null;
  }, ["into the turn"], {
    focus: (x) => x.posts.find((q) => q.kind === "request" && q.body === "Also mention the parser fix.")?.number,
    extra: () => {
      if (!rowSays("Also mention the parser fix.", "into the turn")) fail("the steered message's row does not say 'into the turn'");
      log("  page: the steered message's own row says into the turn");
    },
  });
  await room.finish("fable", "Release notes drafted, with the parser fix.");
  await room.settle("fable");
  browser.click(/button "(Write a message|Continue your draft)"/);
  browser.fill(/textbox "Message"/, "Please also tag v1.2.");
  browser.on("press", "Enter");
  await until("the message to the idle Consigliere", sent("Please also tag v1.2."));
  await check.state("a message to the idle Consigliere starts a turn of its own", (x) => {
    const p = x.posts.find((q) => q.kind === "request" && q.author === "$user" && q.body === "Please also tag v1.2.");
    const run = p && x.runs.find((r) => r.inputs.includes(p.seq));
    return p && p.request.message?.steer && run && run.reservedSeq > p.seq ? `#${p.number} request.message.steer=true, delivered by run ${run.id.slice(0, 8)} reserved at #${run.reservedSeq} (after it)` : null;
  }, ["Please also tag v1.2."], {
    focus: (x) => x.posts.find((q) => q.kind === "request" && q.body === "Please also tag v1.2.")?.number,
    extra: () => {
      if (rowSays("Please also tag v1.2.", "into the turn")) fail("a message that started a turn of its own says 'into the turn'");
      log("  page: no 'into the turn' on it");
    },
  });
  if (browser.eval<string>("() => document.querySelector('textarea[aria-label=\"Message\"]')?.value ?? ''") !== "") fail("the composer kept a draft");
  // Sending closes the composer; Escape now would close the room.
  if (browser.eval<boolean>("() => Boolean(document.querySelector('.composer-overlay'))")) browser.on("press", "Escape");
  await room.finish("fable", "Tagged v1.2.");

  // 16. The conversation with the Consigliere: the user's requests and his answers to them, nothing between members.
  browser.click(/tab "[^"]*fable/);
  await check.state("the chat view with the Consigliere", (x) => {
    const out = claimOf(x, ask, "answered");
    return out ? `#${out.number} answers #${U}; chat holds the user's posts and @fable's replies to the user` : null;
  }, [`answers #${U} from you`], {
    extra: () => {
      const leaked = browser.eval<boolean>(`() => Boolean(document.querySelector('.timeline [data-number="${R}"], .timeline [data-number="${V}"]'))`);
      if (leaked) fail("the chat shows requests between members");
      const typedElsewhere = browser.eval<boolean>("() => document.querySelector('.timeline').textContent.includes('Quick check from T3')");
      if (typedElsewhere) fail("the chat shows what was typed in T3 on another member's thread");
      log("  page: no member-to-member request, nothing typed on another member's thread, in the chat");
    },
  });

  // 16b. The Consigliere reseats the worker (L4b): Backroom's checkpoint request and the handover are Backroom's on the
  // board, never the user's messages.
  browser.click(/tab "Board/);
  room.board("fable", "reseat", "worker");
  const checkpoint = await until("the reseat's checkpoint request", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.request.id.startsWith("reseat:") && p.request.owner === seat.worker));
  await check.state("Backroom's reseat checkpoint, not the user's message", (x) => {
    const p = x.posts.find((q) => q.id === checkpoint.id);
    return p && p.author === "$user" && p.request.message === null ? `#${p.number} request ${p.request.id.slice(0, 16)}… by $user with no user message: Backroom's` : null;
  }, ["Backroom → @worker: reseat checkpoint"], {
    focus: () => checkpoint.number,
    extra: () => {
      const asUsers = browser.eval<boolean>(`() => [...document.querySelectorAll('.timeline .chat-row.from-user')].some((row) => row.getAttribute('data-number') === '${checkpoint.number}')`);
      if (asUsers) fail("the checkpoint shows as the user's message");
      log("  page: the checkpoint is Backroom's line, not a message of yours");
    },
  });
  await room.settle("worker");
  await check.state("the reseat's handover", (x) => {
    const handover = x.posts.find((p) => p.kind === "transfer" && p.transfer.oldSeatId === seat.worker);
    return handover ? `#${handover.number} transfer ${handover.transfer.oldSeatId.slice(0, 8)} → ${handover.transfer.newSeatId.slice(0, 8)}` : null;
  }, ["open work handed to its fresh seat"], { focus: (x) => x.posts.find((p) => p.kind === "transfer")?.number });
  // The fresh seat's first turn ends by itself (its thread is not held); then the Consigliere is woken once.
  await room.settle("fable");

  // 17. The overview: member status while a turn runs, and the room's news when it ends.
  await room.settle("fable");
  const ping = await room.message("One more: confirm the tag.");
  await room.live("fable");
  browser.click(/button "Back to the overview"/);
  await check.state("the overview: a member working, then news", (x) => (x.runs.some((r) => r.seatId === seat.fable && r.phase === "running" && r.requestIds.includes(ping)) ? "@fable running" : null), ["1 busy"]);
  await room.finish("fable", "Tag confirmed.");
  // News is the Consigliere's finishes since the room was last seen (one per turn, by journal sequence): the tile counts them.
  s = await until("the Consigliere's last reply", async () => {
    const x = await room.snapshot();
    return claimOf(x, ping, "answered") && x.news.unseen >= 1 ? x : null;
  });
  await check.state("news on the room's tile", (x) => (x.news.unseen === s.news.unseen ? `news.unseen=${x.news.unseen} seenSeq=${x.news.seenSeq} latest #${x.news.latest?.number} (${x.news.latest?.kind})` : null), [`${s.news.unseen} new`]);

  // 18. A room without a Consigliere: one message to two members, with an image, is one message on the board.
  const second = await room.second("Rehearsal B", ["alpha", "beta"]);
  const image = await second.attach();
  const both = await service.command<{ messageId: string; requestIds: string[] }>({
    type: "message.create",
    roomId: second.roomId,
    sourceText: "@alpha @beta independently check the date tests",
    clientMessageId: randomUUID(),
    attachmentIds: [image],
    assignments: [{ recipients: [second.participant.alpha!, second.participant.beta!], instruction: "independently check the date tests", schedule: { mode: "now" }, after: [] }],
  });
  browser.openRoom("Rehearsal B");
  const two = new Checks(second, browser);
  await two.state("one message to two members, with its image", (x) => {
    const posts = x.posts.filter((p) => p.kind === "request" && p.request.message?.id === both.messageId);
    return posts.length === 2 && posts.every((p) => p.request.message.attachmentIds.includes(image))
      ? `#${posts.map((p) => p.number).join(", #")} share message ${both.messageId.slice(0, 8)} with attachment ${image.slice(0, 8)}`
      : null;
  }, ["→ @alpha, @beta", "independently check the date tests"], {
    extra: () => {
      const shape = browser.eval<{ rows: number; images: number }>(`() => ({ rows: [...document.querySelectorAll('.timeline .chat-row.from-user')].filter((row) => row.textContent.includes('independently check the date tests')).length, images: document.querySelectorAll('.timeline img[src="/api/attachments/${image}"]').length })`);
      if (shape.rows !== 1 || shape.images !== 1) fail(`the message is not one row with its image: ${JSON.stringify(shape)}`);
      log("  page: one row for both requests, the image once");
    },
  });
  check.passed.push(...two.passed);

  // 19. The Consigliere reseats himself: a fresh seat of his takes over as Consigliere. The conversation with him keeps
  // everything from before the reseat (L5 review B3): the user's first message and his first report.
  room.board("fable", "reseat", "fable");
  await room.settle("fable");
  await until("his handover to the fresh seat", async () => (await room.snapshot()).posts.some((p) => p.kind === "transfer" && p.transfer.oldSeatId === seat.fable), 60_000);
  browser.click(/button "Back to the overview"/);
  // By the room card's exact title: after the reseats the overview also holds the kept threads "Rehearsal · fable" and
  // "Rehearsal · worker", and a card for "Rehearsal B".
  browser.openRoom(room.title);
  browser.click(/tab "[^"]*fable/);
  await check.state("the chat keeps his history after he is reseated", (x) => {
    const handover = x.posts.find((p) => p.kind === "transfer" && p.transfer.oldSeatId === seat.fable);
    return handover && x.room.consigliereId && x.room.consigliereId !== room.participant.fable
      ? `#${handover.number} handed seat ${seat.fable.slice(0, 8)} to ${handover.transfer.newSeatId.slice(0, 8)}; the Consigliere is now participant ${x.room.consigliereId.slice(0, 8)}`
      : null;
  }, ["Get the date parser fixed and reviewed, then report.", "Report: the date parser is fixed and reviewed (PASS)."], {
    extra: () => {
      // Polled: the same texts are on the board too, so they can match before the chat view has replaced it.
      browser.poll<{ label: string | null; first: boolean; report: boolean }>(
        "the chat after his reseat",
        "() => { const log = document.querySelector('.timeline'); const text = log?.textContent ?? ''; return { label: log?.getAttribute('aria-label') ?? null, first: text.includes('Get the date parser fixed and reviewed, then report.'), report: text.includes('Report: the date parser is fixed and reviewed (PASS).') }; }",
        (chat) => chat.label === "Conversation with the Consigliere" && chat.first && chat.report,
      );
      log("  page: the chat with the fresh Consigliere still holds the first message and his first report");
    },
  });

  // 20. Talk to …: a conversation started with its first message (consigliere.start) makes a room with the saved crew
  // member the setting names as its Consigliere, and the message is his request on the board, which wakes him (H2).
  const preset = await service.command<{ presetId: string }>({ type: "preset.create", name: "astra", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", workspaceMode: "local" });
  await service.command({ type: "consigliere.preset.set", presetId: preset.presetId });
  const opening = "Plan the next release: the date parser fix, the v1.2 tag and the notes.";
  const startId = randomUUID();
  const talk = await service.command<{ roomId: string; participantId: string }>({ type: "consigliere.start", projectId: "project_demo", text: opening, requestId: startId });
  const talkSnapshot = () => service.call<Snapshot>("GET", `/api/rooms/${talk.roomId}`);
  const astra = (await talkSnapshot()).bindings.find((b) => b.participantId === talk.participantId)!;
  // Held before the fake T3's 4 s auto-reply can end his first turn, so the turn holds while it is checked.
  await service.fake("hold", { threadId: astra.threadId, hold: true });
  browser.click(/button "Back to the overview"/);
  browser.openRoom((await talkSnapshot()).room.title);
  browser.click(/tab "[^"]*astra/);
  const chatHas = (text: string, row: string) => browser.eval<boolean>(`() => [...document.querySelectorAll('.timeline .chat-row.${row}')].some((r) => r.textContent.includes(${JSON.stringify(text)}))`);
  const talked = new Checks({ snapshot: talkSnapshot }, browser);
  const first = await talked.state("Talk to …: the first message is the Consigliere's request and his turn runs on it", (x) => {
    const post = x.posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === opening);
    const run = post && x.runs.find((r) => r.seatId === astra.id && r.phase === "running" && r.inputs.includes(post.seq));
    return post && post.request.owner === astra.id && post.request.message?.id === startId && run
      ? `#${post.number} request by $user to his seat ${astra.id.slice(0, 8)}, message ${startId.slice(0, 8)} (the start's ID), run ${run.id.slice(0, 8)} running on it`
      : null;
  }, [opening], {
    extra: () => {
      if (!chatHas(opening, "from-user")) fail("the conversation does not show the first message as the user's");
      log("  page: the first message is the user's in the conversation with him");
    },
  });
  const firstPost = first.posts.find((p) => p.kind === "request" && p.body === opening);
  await service.fake("complete", { threadId: astra.threadId, text: "Here is the release plan: parser fix, tag, notes." });
  await talked.state("Talk to …: his reply answers the first message", (x) => {
    const out = claimOf(x, firstPost.request.id, "answered");
    return out ? `#${out.number} answers #${firstPost.number}` : null;
  }, ["Here is the release plan: parser fix, tag, notes."], {
    extra: () => {
      if (!chatHas("Here is the release plan: parser fix, tag, notes.", "from-agent")) fail("the conversation does not show his reply");
      log("  page: his reply is in the conversation");
    },
  });
  check.passed.push(...talked.passed);

  oldTablesEmpty(room.dataDir);
  return check.passed;
}

/** Nothing of the old runtime's queue was written (Z2 gates on it): no tasks, no task revisions, no old runs. */
function oldTablesEmpty(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "rooms.sqlite"), { readOnly: true });
  try {
    const count = (table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    const old = { tasks: count("tasks"), task_revisions: count("task_revisions"), runs: count("runs") };
    if (old.tasks + old.task_revisions + old.runs !== 0) fail(`the old runtime's tables are not empty: ${JSON.stringify(old)}`);
    log(`rooms.sqlite: tasks ${old.tasks}, task_revisions ${old.task_revisions}, runs ${old.runs}`);
  } finally {
    db.close();
  }
}

// ---------------- the whole room (--step room, Z2) ----------------

async function rehearseRoom(service: Service, browser: Browser, room: Room): Promise<string[]> {
  const check = new Checks(room, browser);
  const { seat } = room;
  const claimOf = (s: Snapshot, requestId: string, outcome: string) => s.posts.find((p) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === requestId && c.outcome === outcome));
  /** The newest request to `owner` under `parentId` (null: not under any). */
  const requestTo = (s: Snapshot, owner: string, parentId: string | null) => s.posts.filter((p) => p.kind === "request" && p.request.owner === owner && p.request.parentId === parentId).at(-1);
  /** The member's run now, if it has one. */
  const runOf = (s: Snapshot, alias: Alias) => {
    const at = s.seats.find((x) => x.seatId === seat[alias]);
    return at?.activeRunId ? s.runs.find((r) => r.id === at.activeRunId) : undefined;
  };
  const finalOf = (s: Snapshot, runId: string) => s.posts.filter((p) => p.kind === "output" && p.output.runId === runId && p.output.source === "final");

  // Open the room as the user does: its card on the overview, then the board.
  browser.open();
  browser.openRoom(room.title);
  browser.click(/tab "Board/);
  browser.consoleClean();

  // 1. The assignment: the user types it to the Consigliere in the composer; his turn runs on it.
  const assignment = "Get the date parser fixed and reviewed, then report.";
  browser.click(/button "(Write a message|Continue your draft)"/);
  browser.fill(/textbox "Message"/, assignment);
  browser.on("press", "Enter");
  const ask = (await until("the user's message on the board", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === assignment))).request.id as string;
  // Sending closes the composer; Escape now would close the room.
  if (browser.eval<boolean>("() => Boolean(document.querySelector('.composer-overlay'))")) browser.on("press", "Escape");
  await room.live("fable");
  let s = await room.snapshot();
  const U = room.post(s, ask).number as number;
  await check.state("the assignment, typed in the composer: his open request, his turn on it", (x) => {
    const post = room.post(x, ask);
    const run = runOf(x, "fable");
    return post.request.owner === seat.fable && post.request.state === "open" && run?.phase === "running" && run.requestIds.includes(ask)
      ? `#${post.number} by $user to @fable, open; his run ${run.id.slice(0, 8)} running on it`
      : null;
  }, [assignment, "open · @fable working"], { show: U });

  // 2. He hands it to the worker and ends his turn: his final cannot answer while that request is open.
  room.board("fable", "post", "@worker fix the date parser in src/dates.ts: two-digit years and leap days");
  s = await room.snapshot();
  const fix = requestTo(s, seat.worker, ask)?.request.id as string;
  if (!fix) fail("his post is not a child of the user's request");
  await room.finish("fable", "I asked @worker for the fix; I will report once it is reviewed.");
  await room.live("worker");
  const A = room.post(await room.snapshot(), fix).number as number;
  await check.state("handed to the worker: his final leaves the assignment open", (x) => {
    const out = claimOf(x, ask, "pending_activity");
    const run = runOf(x, "worker");
    return out && room.post(x, ask).request.state === "open" && run?.requestIds.includes(fix) ? `#${out.number} claims #${U}: pending_activity; @worker's run ${run.id.slice(0, 8)} works on #${A}` : null;
  }, [`#${U} stays open: a review or background work is still running`, `waits on #${A}`], { show: U });

  // 3. The worker asks the reviewer for a review and ends its turn.
  room.board("worker", "post", "@reviewer review the date parser fix in src/dates.ts");
  s = await room.snapshot();
  const review1 = requestTo(s, seat.reviewer, fix)?.request.id as string;
  if (!review1) fail("the worker's review request is not a child of its request");
  await room.finish("worker", "The fix is in; I asked @reviewer for a review.");
  await room.live("reviewer");
  const V1 = room.post(await room.snapshot(), review1).number as number;
  await check.state("the worker asks for a review: its request waits on it", (x) => {
    const out = claimOf(x, fix, "pending_activity");
    const run = runOf(x, "reviewer");
    return out && run?.requestIds.includes(review1) ? `#${out.number} claims #${A}: pending_activity; @reviewer's run ${run.id.slice(0, 8)} works on #${V1}` : null;
  }, [`#${A} stays open: a review or background work is still running`, `waits on #${V1}`], { show: A });

  // 4. The review finds a fault: its answer closes the review request and wakes the worker with it.
  const finding = "FINDING: 1900-02-29 parses as a valid date; 1900 is not a leap year, so it must be refused.";
  await room.finish("reviewer", finding);
  const fixRun = await room.live("worker");
  await check.state("a review finding: it answers the review request and wakes the worker", (x) => {
    const out = claimOf(x, review1, "answered");
    const run = runOf(x, "worker");
    return out && out.body === finding && run?.id === fixRun.id && run.inputs.includes(out.seq) && room.post(x, fix).request.state === "open"
      ? `#${out.number} by @reviewer answers #${V1} with the finding; @worker's run ${run.id.slice(0, 8)} has it (inputs #${run.inputs.join(", #")}); #${A} open`
      : null;
  }, [`answers #${V1} from @worker`, "1900-02-29 parses as a valid date"], { focus: (x) => claimOf(x, review1, "answered")?.number });

  // 5. The correction: the user adds to the assignment from the page, and the Consigliere passes it on while the
  // worker's turn on the finding still runs. That turn had not seen it, so its final cannot answer the request.
  const userCorrection = "Also make sure 30 February is refused in every year.";
  browser.show(U);
  browser.click(/button "Correct…"/);
  browser.fill(new RegExp(`textbox "Correction to #${U}"`), userCorrection);
  browser.click(/button "Send correction"/);
  await room.live("fable");
  await check.state("the user's correction from the page reaches the Consigliere", (x) => {
    const c = x.posts.find((p) => p.kind === "correction" && p.author === "$user" && p.about.some((r: any) => r.requestId === ask));
    const run = runOf(x, "fable");
    return c && c.body === userCorrection && run?.inputs.includes(c.seq) && room.post(x, ask).request.corrections === 1 ? `#${c.number} correction by the user on #${U}; @fable's run ${run.id.slice(0, 8)} has it` : null;
  }, [`you corrected #${U}`, "corrected 1×"], { focus: (x) => x.posts.find((p) => p.kind === "correction" && p.author === "$user")?.number });
  room.board("fable", "correct", `#${A}`, "Also refuse 30 February in every year (the user's correction).");
  await room.finish("fable", "I passed your correction on to @worker.");
  room.board("worker", "post", "@reviewer review again: 1900-02-29 is refused now");
  s = await room.snapshot();
  const review2 = requestTo(s, seat.reviewer, fix)?.request.id as string;
  if (!review2 || review2 === review1) fail("the worker's second review request is not a child of its request");
  await room.finish("worker", "Fixed the finding; I asked @reviewer to review again.");
  await check.state("the correction came in during the worker's turn: its final leaves the request open", (x) => {
    const relayed = x.posts.find((p) => p.kind === "correction" && p.author === seat.fable && p.about.some((r: any) => r.requestId === fix));
    const his = x.posts.filter((p) => p.kind === "output" && p.author === seat.fable && p.output.claims.some((c: any) => c.requestId === ask && c.outcome === "pending_activity"));
    const out = finalOf(x, fixRun.id)[0];
    const claim = out?.output.claims.find((c: any) => c.requestId === fix);
    return relayed && his.length === 2 && claim?.outcome === "superseded"
      ? `#${relayed.number} @fable corrects #${A}; his final #${his[1].number} leaves #${U} pending_activity; @worker's final #${out.number} claims #${A}: superseded`
      : null;
  }, [`@fable corrected #${A}`, `#${A} stays open: input it had not seen came in`], { focus: (x) => finalOf(x, fixRun.id)[0]?.number });

  // 6. The worker's next turn takes the correction, the reviewer's runs on the second review: both are running when the
  // service is killed (SIGKILL) and started again. T3 (the fake, kept in its file) still runs both turns meanwhile.
  const correctionRun = await until("@worker's turn on the correction", async () => {
    const run = runOf(await room.snapshot(), "worker");
    return run && run.id !== fixRun.id && run.phase === "running" ? run : null;
  });
  const reviewRun2 = await room.live("reviewer");
  const V2 = room.post(await room.snapshot(), review2).number as number;
  const before = await check.state("two turns running before the kill", (x) => {
    const w = runOf(x, "worker");
    const r = runOf(x, "reviewer");
    const relayed = x.posts.find((p) => p.kind === "correction" && p.author === seat.fable);
    return w?.id === correctionRun.id && w.phase === "running" && relayed && w.inputs.includes(relayed.seq) && r?.id === reviewRun2.id && r.phase === "running" && r.requestIds.includes(review2)
      ? `@worker's run ${w.id.slice(0, 8)} on the correction #${relayed.number}; @reviewer's run ${r.id.slice(0, 8)} on #${V2}; journal head ${x.head}`
      : null;
  }, ["Working ·"], { show: A });
  const t3Before = Object.fromEntries(MEMBERS.map((a) => [a, service.t3Runs(room.thread[a])]));
  await service.kill();
  log("KILL: the service was killed with SIGKILL while @worker's and @reviewer's turns run");
  browser.screenshot("the-page-while-the-service-is-down");
  const logAt = service.logLength();
  await service.restart();
  log("the service started again on the same data; waiting 5 s (three ticks) before comparing");
  await sleep(5_000);
  await check.state("after the restart: the same turns go on, nothing sent or imported twice", (x) => {
    const w = runOf(x, "worker");
    const r = runOf(x, "reviewer");
    const t3Same = MEMBERS.every((a) => JSON.stringify(service.t3Runs(room.thread[a])) === JSON.stringify(t3Before[a]));
    return w?.id === correctionRun.id && w.phase === "running" && r?.id === reviewRun2.id && r.phase === "running" && x.head === before.head && x.runs.length === before.runs.length && t3Same
      ? `the same runs ${w.id.slice(0, 8)} and ${r.id.slice(0, 8)} running; journal head ${x.head} and ${x.runs.length} runs, as before; T3's runs per thread unchanged (${MEMBERS.map((a) => `@${a} ${t3Before[a]!.length}`).join(", ")})`
      : null;
  }, ["Working ·"], {
    show: A,
    extra: () => {
      const lines = browser.acceptOutage();
      log(`  page: ${lines.length} console line(s) from Chrome for requests it made while the service was down${lines.length ? `, e.g. ${lines[0]!.slice(0, 160)}` : ""}`);
    },
  });
  // The worker's turn ends after the restart: imported once, and the page (never reloaded) shows it.
  await room.finish("worker", "30 February is refused in every year now; the second review is still running.");
  await check.state("after the restart the worker's turn is imported once: its request waits on the second review", (x) => {
    const outs = finalOf(x, correctionRun.id);
    const claim = outs[0]?.output.claims.find((c: any) => c.requestId === fix);
    return outs.length === 1 && claim?.outcome === "pending_activity" ? `#${outs[0].number}, the one final of run ${correctionRun.id.slice(0, 8)}, claims #${A}: pending_activity (#${V2} open)` : null;
  }, ["30 February is refused in every year now"], { focus: (x) => finalOf(x, correctionRun.id)[0]?.number });

  // 7. PASS: the second review answers; the worker's final answers the assignment.
  await room.finish("reviewer", "PASS: 1900-02-29 and 30 February are refused, and the tests cover both.");
  const passRun = await room.live("worker");
  await room.finish("worker", "Fixed, corrected and reviewed: PASS from @reviewer.");
  await check.state("PASS: the second review answers, and the worker's final answers its request", (x) => {
    const pass = claimOf(x, review2, "answered");
    const done = claimOf(x, fix, "answered");
    return pass && done && done.output.runId === passRun.id ? `#${pass.number} answers #${V2} (PASS); #${done.number} answers #${A}` : null;
  }, [`answers #${V2} from @worker`, `answers #${A} from @fable`]);
  const failures = service.logSince(logAt).split("\n").filter((line) => /tick failed|room step failed|seat step failed|already bound|refused/.test(line));
  if (failures.length > 0) fail(`service.log since the restart:\n${failures.slice(0, 5).join("\n")}`);
  log("  service.log since the restart: no failed tick or step, nothing refused");

  // 8. His report answers the user.
  await room.live("fable");
  const report = "Report: the date parser is fixed, your correction is in, and the review passed.";
  await room.finish("fable", report);
  s = await check.state("the report answers the user's assignment", (x) => {
    const out = claimOf(x, ask, "answered");
    return out && out.body === report && room.post(x, ask).request.state === "answered" ? `#${out.number} answers #${U}` : null;
  }, [`answers #${U} from you`]);
  browser.show(U);
  browser.waitFor(`answered · #${room.post(s, ask).request.answer.number}`);
  browser.click(/tab "[^"]*fable/);
  browser.poll<{ label: string | null; assignment: boolean; report: boolean }>(
    "the chat with him",
    `() => { const log = document.querySelector('.timeline'); const text = log?.textContent ?? ''; return { label: log?.getAttribute('aria-label') ?? null, assignment: text.includes(${JSON.stringify(assignment)}), report: text.includes(${JSON.stringify(report)}) }; }`,
    (chat) => chat.label === "Conversation with the Consigliere" && chat.assignment && chat.report,
  );
  browser.consoleClean();
  browser.screenshot("the-chat-with-his-report");
  log("  page: the chat with him holds the assignment and his report");
  browser.click(/tab "Board/);

  // 9. A turn T3 fails (a provider error); its notice offers Retry, and the user retries it from the page.
  await room.settle("fable");
  const tag = await room.message("Tag v1.2 now that the parser fix is in.");
  await room.live("fable");
  room.board("fable", "post", "@worker tag v1.2");
  s = await room.snapshot();
  const tagJob = requestTo(s, seat.worker, tag)?.request.id as string;
  if (!tagJob) fail("his post is not a child of the user's request");
  await room.finish("fable", "I asked @worker to tag v1.2.");
  const failing = await room.live("worker");
  const T = room.post(await room.snapshot(), tag).number as number;
  const B = room.post(await room.snapshot(), tagJob).number as number;
  await room.finish("worker", "provider error: the model is overloaded", { outcome: "error" });
  await check.state("a turn T3 failed: its notice offers Retry", (x) => {
    const notice = x.posts.find((p) => p.kind === "notice" && p.notice.retryRunId === failing.id);
    return notice && notice.about.some((r: any) => r.requestId === tagJob) && room.post(x, tagJob).request.state === "open"
      ? `notice #${notice.number} (${notice.notice.intent}) to ${notice.to.join(", ")}, retryRunId=${failing.id.slice(0, 8)}, about #${B}; #${B} still open`
      : null;
  }, ["Retry", "the model is overloaded"], { focus: (x) => x.posts.find((p) => p.kind === "notice" && p.notice.retryRunId === failing.id)?.number });
  browser.click(/button "Retry"/);
  await check.state("Retry from the page: the failed turn is sent again", (x) => {
    const retry = x.posts.find((p) => p.kind === "retry" && p.retry.runId === failing.id);
    const notice = x.posts.find((p) => p.kind === "notice" && p.notice.runId === failing.id);
    const run = runOf(x, "worker");
    return retry && notice?.notice.retried && !notice.notice.retryRunId && run && run.id !== failing.id && run.requestIds.includes(tagJob)
      ? `retry #${retry.number} by ${retry.author}; notice #${notice.number} retried=true; @worker's new run ${run.id.slice(0, 8)} works on #${B}`
      : null;
  }, ["retried a failed turn"], { focus: (x) => x.posts.find((p) => p.kind === "retry")?.number });
  // The failure's notice woke him (requester and Consigliere): he takes note while the retried turn runs.
  await room.settle("fable");
  await room.finish("worker", "Tagged v1.2.");
  await room.live("fable");
  await room.finish("fable", "v1.2 is tagged.");
  await check.state("the retried turn answers, and his reply the user's request", (x) => {
    const job = claimOf(x, tagJob, "answered");
    const user = claimOf(x, tag, "answered");
    return job && user ? `#${job.number} answers #${B}; #${user.number} answers #${T}` : null;
  }, [`answers #${B} from @fable`, `answers #${T} from you`]);

  // 10. He reseats the worker: its checkpoint, then a fresh seat of it takes over and works.
  await room.settle("fable");
  const oldWorker = seat.worker;
  room.board("fable", "reseat", "worker", "carry on with the parser follow-ups");
  await until("the reseat's checkpoint request", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.request.id.startsWith("reseat:") && p.request.owner === oldWorker));
  await room.live("worker");
  await room.finish("worker", "Checkpoint: the parser fix and the v1.2 tag are done and answered; nothing is open.");
  const handover = await until("the handover to the fresh seat", async () => (await room.snapshot()).posts.find((p) => p.kind === "transfer" && p.transfer.oldSeatId === oldWorker), 60_000);
  await room.rebind("worker");
  // The fresh seat's first turn (the takeover he asked for) ends; its answer wakes him once.
  await room.settle("worker");
  await room.settle("fable");
  await check.state("a reseat: a fresh seat of the worker takes over", (x) => {
    const old = x.seats.find((w) => w.seatId === oldWorker);
    const fresh = x.seats.find((w) => w.seatId === seat.worker);
    const takeover = x.posts.find((p) => p.kind === "request" && p.request.owner === seat.worker && p.author === seat.fable);
    return old?.status === "retired" && fresh?.status === "active" && fresh.threadId !== old.threadId && takeover?.request.state === "answered"
      ? `#${handover.number} hands ${oldWorker.slice(0, 8)} to ${seat.worker.slice(0, 8)}; the old seat retired, the fresh one active on its own thread; takeover #${takeover.number} answered`
      : null;
  }, ["open work handed to its fresh seat"], { focus: () => handover.number });
  room.board("fable", "post", `@${room.name.worker} add a --strict flag to the parser`);
  const strict = requestTo(await room.snapshot(), seat.worker, null)?.request.id as string;
  if (!strict) fail("no request to the fresh worker");
  await room.live("worker");
  await room.finish("worker", "The --strict flag is in.");
  await room.settle("fable");
  await check.state("the fresh seat's work lands", (x) => {
    const out = claimOf(x, strict, "answered");
    return out && out.author === seat.worker ? `#${out.number} by the fresh seat answers #${room.post(x, strict).number}` : null;
  }, ["The --strict flag is in."], { focus: (x) => claimOf(x, strict, "answered")?.number });
  // Back on the overview the old seat's kept thread has a card of its own ("<room> · worker"): the room's card is still
  // the one opened, by its exact title.
  browser.click(/button "Back to the overview"/);
  browser.poll<string[]>("the kept thread's card on the overview", "() => [...document.querySelectorAll('.ov-room-title')].map((t) => t.textContent)", (titles) => titles.includes(room.title) && titles.includes(`${room.title} · worker`));
  log(`  page: the overview has the room's card and the kept thread's "${room.title} · worker"`);
  browser.openRoom(room.title);
  browser.click(/tab "Board/);

  // 11. He retires the reviewer: refused while it has work open, done once it has none.
  room.board("fable", "post", "@reviewer check the --strict flag's help text");
  const help = requestTo(await room.snapshot(), seat.reviewer, null)?.request.id as string;
  if (!help) fail("no request to the reviewer");
  await room.live("reviewer");
  const H = room.post(await room.snapshot(), help).number as number;
  const refusal = room.refused("fable", "retire", "reviewer");
  if (!/cannot be retired now/.test(refusal) || !refusal.includes(`#${H}`)) fail(`the refusal does not name the open work #${H}: ${refusal}`);
  await room.finish("reviewer", "The help text is fine.");
  await room.settle("reviewer");
  await room.settle("fable");
  room.board("fable", "retire", "reviewer");
  await check.state("a retire: the reviewer leaves the room", (x) => {
    const r = x.seats.find((w) => w.seatId === seat.reviewer);
    return r?.status === "retired" && claimOf(x, help, "answered") ? `@reviewer's seat ${seat.reviewer.slice(0, 8)} retired after answering #${H}` : null;
  }, [], {
    extra: () => {
      browser.poll<string | null>("the members after the retire", "() => document.querySelector('[aria-label^=\"Members (\"]')?.getAttribute('aria-label') ?? null", (label) => label === "Members (2)");
      log("  page: Members (2)");
    },
  });

  // Where the room ends: nothing open, no run unresolved, no background work pending; nothing in the old tables.
  const end = await room.snapshot();
  const unresolved = end.runs.filter((r) => r.phase !== "terminal");
  if (end.requests.length > 0 || unresolved.length > 0 || end.seats.some((x) => x.activities.length > 0)) {
    fail(`the room did not end quiet: ${end.requests.length} open request(s), ${unresolved.length} unresolved run(s), activities ${JSON.stringify(end.seats.flatMap((x) => x.activities))}`);
  }
  log(`the room ends quiet: ${end.posts.length} posts, ${end.runs.length} runs all terminal, no open request, no pending activity`);
  oldTablesEmpty(room.dataDir);
  return check.passed;
}

// ---------------- main ----------------

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  const service = new Service(o);
  const browser = new Browser(o, service.base);
  let passed: string[] = [];
  try {
    await service.start();
    const room = new Room(service, o);
    await room.create(o.step === "ui" ? "Rehearsal" : "Whole room");
    passed = o.step === "ui" ? await rehearseUi(service, browser, room) : await rehearseRoom(service, browser, room);
    log(`DONE: ${passed.length} states checked in the API and on the page, console clean`);
  } finally {
    browser.close();
    if (o.keep) log(`--keep: the service stays on ${service.base}`);
    else service.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[rehearse] FAILED: ${error instanceof RehearsalFailure ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
