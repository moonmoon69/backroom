/**
 * The browser rehearsal on a throwaway service (stage 4/5 plan, item L5: `--step ui`; Z2 adds `--step room`; U1's
 * `--step keys`, keyboard only, is in rehearse-keys.ts).
 *
 *   node scripts/rehearse.ts --step ui|room|keys --as <rooms-browser key> [--browser backroom-dev] [--port 4471]
 *        [--data <dir>] [--out <dir>] [--keep]
 *
 * It starts its own service from this checkout (ROOMS_ADAPTER=fake ROOMS_PORT=<port>
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
 * The board's semantics are H5's ("members only answer", README.md): a member's final answers the requests its turn was
 * given and wakes the Consigliere, with its T3 status line at the top; members do not post (`rooms-board post` is
 * refused them); the Consigliere routes reviews (the worker answers him, he posts the result to the reviewer, the
 * reviewer answers him, he posts the findings to the worker); his first final after a user's message answers it, his
 * later ones are updates; a member's turn the room did not start is a follow-up that wakes him, and background work
 * that ends with no further turn gets one follow-up after 30 s of quiet. Nothing holds a request open.
 *
 * `--step room` (Z2) plays one whole job with nothing written by hand: the user's assignment from the composer, the
 * Consigliere hands it to the worker (his final answers the user), the worker's answer wakes him, he sends it to the
 * reviewer, the reviewer's finding wakes him, he sends the finding to the worker, the user's correction from the page
 * (a message from the composer: the assignment is answered by then, and a closed request takes no correction) passed on
 * by the Consigliere with `rooms-board correct` while the worker's turn runs (that final comes out superseded), the
 * service killed (SIGKILL) and started again while two turns run (the worker's on the correction and his on the user's
 * message), the second review, PASS, his report (an update in the room's news); then a turn T3 fails and the user's
 * Retry from the page, a reseat, and a retire (refused first while the member has work). The fake T3 keeps its threads
 * in <data>/fake-t3.json (ROOMS_FAKE_STATE), so it comes back from the kill as real T3 would, since T3 is not
 * Backroom's process; the script reads that file as T3's own record of what it ran.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EngineStore } from "../src/engine/index.ts";
import { rehearseKeys } from "./rehearse-keys.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------- options ----------------

interface Options {
  step: "ui" | "room" | "keys";
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
  if (step !== "ui" && step !== "room" && step !== "keys") fail("usage: node scripts/rehearse.ts --step ui|room|keys --as <rooms-browser key>");
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
      env: { ...process.env, ROOMS_ADAPTER: "fake", ROOMS_PORT: String(this.o.port), ROOMS_DATA_DIR: this.o.data, ROOMS_SPEECH: "off", ...kept },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      if (this.child === child) log(`the service exited by itself (code ${code}, signal ${signal}): see ${join(this.o.data, "service.log")}`);
    });
    await until("the service to answer", () => fetch(`${this.base}/api/status`).then((r) => r.ok), 30_000, 300);
  }

  /** Stopped, and gone once this returns: whoever reads its data next (sqlite3 in the Z2 gate) finds nothing locked. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
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
  /** What T3 lists in the thread's background from now on (POST /api/fake/background); [] for nothing. */
  background(threadId: string, taskIds: string[]): Promise<any> {
    return this.fake("background", { threadId, taskIds });
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
  /**
   * The composer's draft made exactly `text`, as a person makes it: the old draft selected and deleted with keys, then
   * the new one typed. `fill` alone first empties a non-empty field from script (puppeteer's Locator.fill sets
   * value = ''), which React does not see: a re-render in that moment (a room refetch) writes the old draft back, and
   * the typing lands after it ("/hold write it laterAlso mention…", refused, so Enter sent nothing: the H4 reviewer's
   * run, reproduced in backroom-handoff/Z2/probe-fill/).
   */
  compose(text: string): void {
    const value = "() => document.querySelector('textarea[aria-label=\"Message\"]')?.value ?? null";
    this.click(/textbox "Message"/);
    // Only a draft that is there is deleted: Backspace in an empty composer closes it (the overlay's own key).
    if (this.eval<string | null>(value)) {
      this.on("press", "Control+a");
      this.on("press", "Backspace");
    }
    this.poll<string | null>("the composer to be empty", value, (v) => v === "");
    this.fill(/textbox "Message"/, text);
    this.poll<string | null>(`the composer to hold ${JSON.stringify(text)}`, value, (v) => v === text);
  }
  /** Enter in the composer, once its Send button is enabled for what it holds. */
  send(): void {
    this.poll<boolean>("Send to be enabled", "() => [...document.querySelectorAll('.composer-toolbar button.primary')].some((b) => !b.disabled)", (enabled) => enabled === true);
    this.on("press", "Enter");
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
  /** Where the screenshots go (--out), and the step's other evidence files. */
  get outDir(): string {
    return this.o.out;
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
    return this.boardRaw(alias, ...args).trim();
  }
  /** The same, with its whole output as printed. */
  boardRaw(alias: Alias, ...args: string[]): string {
    try {
      const out = execFileSync(process.execPath, [join(repo, "bin", "rooms-board.mjs"), "--api", join(this.o.data, "browser-api.json"), "--as", this.key(alias), ...args], { encoding: "utf8" });
      log(`  @${alias}$ rooms-board ${args.join(" ").slice(0, 80)} → ${out.trim().split("\n")[0]}`);
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

// ---------------- what H5 puts on the board (members only answer) ----------------

/** The status line the host puts at the top of a member's post (src/runtime/status.ts): `[T3 status of @alias: idle]`. */
const STATUS = (alias: string, what = "idle") => `[T3 status of @${alias}: ${what}]`;
/** The body starts with that status line and a blank line. */
const hasStatus = (body: string, alias: string, what = "idle") => body.startsWith(`${STATUS(alias, what)}\n\n`);
/** A member's follow-ups (H5): progress posts with the milestone `follow-up`. */
const followUps = (s: Snapshot, author: string) => s.posts.filter((p) => p.kind === "progress" && p.author === author && p.progress?.milestone === "follow-up");
/** The final outputs of a run. */
const finalOf = (s: Snapshot, runId: string) => s.posts.filter((p) => p.kind === "output" && p.output.runId === runId && p.output.source === "final");
/** The newest request posted to a seat. */
const requestTo = (s: Snapshot, owner: string) => s.posts.filter((p) => p.kind === "request" && p.request.owner === owner).at(-1);

/**
 * What H5 holds across the whole board, checked where each step ends: no post has a parent, no member posted a request,
 * no claim is pending_activity, nothing is "working", every member final and follow-up starts with its T3 status line,
 * and none of the Consigliere's posts does.
 */
function membersOnlyAnswer(s: Snapshot): string {
  const his = new Set(s.seats.filter((x) => /^fable\d*$/.test(x.alias ?? "")).map((x) => x.seatId as string));
  const requests = s.posts.filter((p) => p.kind === "request");
  const parented = requests.filter((p) => p.request.parentId !== null);
  if (parented.length > 0) fail(`posts with a parent: ${parented.map((p) => `#${p.number} under ${p.request.parentId}`).join(", ")}`);
  const byMembers = requests.filter((p) => p.author !== "$user" && !his.has(p.author));
  if (byMembers.length > 0) fail(`requests posted by members: ${byMembers.map((p) => `#${p.number} by ${p.author}`).join(", ")}`);
  const pending = s.posts.filter((p) => p.kind === "output" && p.output.claims.some((c: any) => c.outcome === "pending_activity"));
  if (pending.length > 0) fail(`outputs with a pending_activity claim: ${pending.map((p) => `#${p.number}`).join(", ")}`);
  if (s.counts.working !== 0 || s.seats.some((x) => x.activities.length > 0)) fail(`work held: counts.working=${s.counts.working}, activities ${JSON.stringify(s.seats.flatMap((x) => x.activities))}`);
  const memberPosts = s.posts.filter((p) => !p.author.startsWith("$") && !his.has(p.author) && p.body && ((p.kind === "output" && p.output.source === "final") || (p.kind === "progress" && p.progress?.milestone === "follow-up")));
  const bare = memberPosts.filter((p) => !p.body.startsWith("[T3 status of @"));
  if (bare.length > 0) fail(`member posts without a status line: ${bare.map((p) => `#${p.number} ${JSON.stringify(p.body.slice(0, 60))}`).join(", ")}`);
  const hisPosts = s.posts.filter((p) => his.has(p.author) && p.body);
  const hisWithStatus = hisPosts.filter((p) => p.body.startsWith("[T3 status of @"));
  if (hisWithStatus.length > 0) fail(`the Consigliere's posts with a status line: ${hisWithStatus.map((p) => `#${p.number}`).join(", ")}`);
  const line = `${requests.length} requests, none under a parent, none posted by a member; no pending_activity; counts.working=0; ${memberPosts.length} member finals and follow-ups all start with a status line; none of his ${hisPosts.length} posts does`;
  log(`members only answer: ${line}`);
  return line;
}

// ---------------- the rehearsal (--step ui) ----------------

async function rehearseUi(service: Service, browser: Browser, room: Room): Promise<string[]> {
  const check = new Checks(room, browser);
  const { seat } = room;
  const claimOf = (s: Snapshot, requestId: string, outcome: string) => s.posts.find((p) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === requestId && c.outcome === outcome));
  /** The member's run now, if it has one. */
  const runOf = (s: Snapshot, alias: Alias) => {
    const at = s.seats.find((x) => x.seatId === seat[alias]);
    return at?.activeRunId ? s.runs.find((r) => r.id === at.activeRunId) : undefined;
  };
  /** The Consigliere's run now, when the post is among its inputs: the post woke him. */
  const wokeHim = (s: Snapshot, post: { seq: number } | undefined) => {
    const run = post ? runOf(s, "fable") : undefined;
    return run && run.inputs.includes(post!.seq) ? run : undefined;
  };
  /** His request to a member, as H5 posts it: his, under nothing. */
  const posted = async (owner: string, what: string) => {
    const p = requestTo(await room.snapshot(), owner);
    if (!p || p.author !== seat.fable || p.request.parentId !== null) fail(`${what}: the newest request to ${owner.slice(0, 8)} is not his under nothing: ${JSON.stringify(p ? { author: p.author, parentId: p.request.parentId } : null)}`);
    return p as { number: number; seq: number; request: { id: string } };
  };
  /** Whether the post's row on the page has this selector in it. */
  const rowHas = (number: number, selector: string) => browser.eval<boolean>(`() => Boolean(document.querySelector('.timeline [data-number="${number}"] ${selector}'))`);
  const rowText = (number: number) => browser.eval<string>(`() => document.querySelector('.timeline [data-number="${number}"]')?.textContent ?? ''`);
  /** The post is drawn as a follow-up bubble (Timeline's FollowUp), its tag saying so. */
  const followUpBubble = (number: number) => {
    const bubble = browser.eval<{ found: boolean; tag: string }>(`() => { const row = document.querySelector('.timeline .is-follow-up[data-number="${number}"]'); return { found: Boolean(row), tag: row?.querySelector('.chat-head .tag')?.textContent ?? '' }; }`);
    if (!bubble.found || !bubble.tag.includes("follow-up")) fail(`#${number} is not drawn as a follow-up bubble: ${JSON.stringify(bubble)}`);
    log(`  page: #${number} is a follow-up bubble, tagged ${JSON.stringify(bubble.tag.trim())}`);
  };

  // The standing rules each side is given (H5): a member answers and runs nothing else; the Consigliere is held nothing.
  const rules = { member: room.boardRaw("worker", "rules"), consigliere: room.boardRaw("fable", "rules") };
  mkdirSync(room.outDir, { recursive: true });
  writeFileSync(join(room.outDir, "rules-as-member.txt"), rules.member);
  writeFileSync(join(room.outDir, "rules-as-consigliere.txt"), rules.consigliere);
  const wanted: Array<[string, string, string[]]> = [
    ["@worker's", rules.member, ["There is nothing else to run", "You do not post to other members"]],
    ["@fable's", rules.consigliere, ["How the board works", "Nothing is held for you"]],
  ];
  for (const [who, text, phrases] of wanted) {
    const missing = phrases.filter((phrase) => !text.includes(phrase));
    if (missing.length > 0) fail(`${who} rooms-board rules lacks ${missing.map((m) => JSON.stringify(m)).join(" and ")} (see ${room.outDir})`);
  }
  log(`rules: @worker's (${rules.member.length} chars) and @fable's (${rules.consigliere.length} chars) written to ${room.outDir}/rules-as-{member,consigliere}.txt, each with its two phrases`);

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

  // 2. He hands it to the worker and ends his turn: his final answers the user's request (H5: nothing holds it open).
  room.board("fable", "post", "@worker fix the date parser in src/dates.ts");
  const fixPost = await posted(seat.worker, "his hand-off");
  const fix = fixPost.request.id;
  const R = fixPost.number;
  await room.finish("fable", "I asked @worker for the fix; I will report once it is reviewed.");
  await room.live("worker");
  let handOff = 0;
  await check.state("the Consigliere's hand-off answers the user's request", (x) => {
    const out = claimOf(x, ask, "answered");
    const run = runOf(x, "worker");
    if (!out || out.author !== seat.fable || out.body.startsWith("[T3 status") || room.post(x, ask).request.state !== "answered" || !run?.requestIds.includes(fix)) return null;
    handOff = room.post(x, ask).request.answer.number;
    return `#${out.number} by @fable answers #${U} (no status line; it wakes the user: to ${JSON.stringify(out.to)}); #${R} to @worker has parentId=null, its run ${run.id.slice(0, 8)} works on it`;
  }, [`answers #${U} from you`], { show: U, extra: () => browser.waitFor(`answered · #${handOff}`) });

  // 3. Members do not post (H5): the worker's `rooms-board post` is refused and appends nothing; answer, working and
  // follow are gone.
  await sleep(1500);
  const quiet = await room.snapshot();
  const refusal = room.refused("worker", "post", "@reviewer review the date parser fix");
  if (!refusal.startsWith("rooms-board: Only the Consigliere and the user post on the board.")) fail(`the worker's post was refused with another message: ${refusal}`);
  const gone: Array<[string, string[], string]> = [
    ["answer", ["the fix is in"], "your final reply is your answer"],
    ["working", ["wiring the fix"], "there is no working mark"],
    ["follow", [`#${R}`], "nobody follows requests"],
  ];
  for (const [command, args, words] of gone) {
    const message = room.refused("worker", command, ...args);
    if (!message.includes(words)) fail(`rooms-board ${command} was refused with another message: ${message}`);
  }
  await check.state("a member's rooms-board post is refused and appends nothing", (x) => {
    if (x.head !== quiet.head || x.posts.length !== quiet.posts.length) fail(`the refused commands appended to the journal: head ${quiet.head} → ${x.head}, posts ${quiet.posts.length} → ${x.posts.length}`);
    return `"${refusal.split("\n")[0]!.slice(0, 90)}…"; answer, working and follow refused too; journal head ${x.head} and ${x.posts.length} posts as before`;
  }, [], { show: R });

  // 4. The worker's final answers #R: its post starts with its T3 status, and it wakes the Consigliere.
  await room.finish("worker", "The fix is in: src/dates.ts handles two-digit years and leap days.");
  let W = 0;
  s = await check.state("the worker's answer wakes the Consigliere, its status line on the page", (x) => {
    const out = claimOf(x, fix, "answered");
    const run = wokeHim(x, out);
    if (!out || !hasStatus(out.body, "worker") || !run) return null;
    W = out.number;
    return `#${out.number} answers #${R}, its body starts "${STATUS("worker")}"; @fable's run ${run.id.slice(0, 8)} has it (inputs #${run.inputs.join(", #")})`;
  }, [`answers #${R} from @fable`, STATUS("worker")], {
    focus: (x) => claimOf(x, fix, "answered")?.number,
    extra: () => {
      if (!rowText(W).includes(STATUS("worker"))) fail(`#${W}'s own row does not show its status line`);
      log(`  page: #${W}'s own row starts with ${STATUS("worker")}`);
    },
  });

  // 5. He relays the work to the reviewer (members never post to each other): his post, and his final is an update.
  const relay = runOf(s, "fable")!;
  room.board("fable", "post", `@reviewer review the date parser fix: read #${W}`);
  const reviewPost = await posted(seat.reviewer, "his review request");
  const review = reviewPost.request.id;
  const V = reviewPost.number;
  await room.finish("fable", "I sent @worker's fix to @reviewer for review.");
  const reviewRun = await room.live("reviewer");
  let relayed = 0;
  await check.state("the Consigliere relays the review to the reviewer", (x) => {
    const his = finalOf(x, relay.id)[0];
    const run = runOf(x, "reviewer");
    if (!his || his.output.disposition !== "yield" || his.output.claims.length !== 0 || his.to.length !== 0 || !run?.requestIds.includes(review)) return null;
    relayed = his.number;
    return `#${V} by @fable to @reviewer (parentId=null); his final #${his.number} is an update (yield, no claims, to nobody); @reviewer's run ${run.id.slice(0, 8)} on #${V}`;
  }, ["review the date parser fix", "I sent @worker's fix to @reviewer for review."], {
    show: V,
    extra: () => {
      if (!rowHas(relayed, ".reply-yield")) fail(`his final #${relayed} is not tagged as an update: ${rowText(relayed).slice(0, 200)}`);
      log(`  page: #${V} is his request to @reviewer; his final #${relayed} is tagged as an update`);
    },
  });

  // 6. T3's acknowledgement of the reviewer's turn is lost: the run is uncertain while T3 still runs it.
  room.journal([{ type: "phase", actor: "$system", id: `rehearse:uncertain:${reviewRun.id}`, runId: reviewRun.id, phase: "uncertain", evidence: "rehearsal: T3's acknowledgement was lost" }]);
  await check.state("an uncertain run", (x) => {
    const run = x.runs.find((r) => r.id === reviewRun.id);
    return run?.phase === "uncertain" ? `run ${run.id.slice(0, 8)} of @reviewer phase=uncertain, requestIds=[${run.requestIds.length}]` : null;
  }, ["Uncertain: Backroom cannot tell whether T3 received this turn", "uncertain"]);

  // 7. What the T3 window showed: an approval, then a question, answered from the page.
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

  // 8. The review passes: the reviewer's answer wakes him, and his report is an update.
  await room.finish("reviewer", "PASS: the fix is right and the tests cover leap years.", {
    progress: ["Reading the diff of src/dates.ts.", "Ran the date tests: 48 passed."],
    files: [{ path: "tests/dates.test.ts", kind: "modified", additions: 6, deletions: 1 }],
  });
  s = await check.state("the reviewer's PASS wakes the Consigliere", (x) => {
    const pass = claimOf(x, review, "answered");
    const run = wokeHim(x, pass);
    return pass && hasStatus(pass.body, "reviewer") && run ? `#${pass.number} answers #${V}, body starts "${STATUS("reviewer")}"; @fable's run ${run.id.slice(0, 8)} has it` : null;
  }, [`answers #${V} from @fable`, "PASS: the fix is right and the tests cover leap years."], { focus: (x) => claimOf(x, review, "answered")?.number });
  const reportRun = runOf(s, "fable")!;
  await room.finish("fable", "Report: the date parser is fixed and reviewed (PASS).");
  s = await check.state("answered markers and 'answers #n'", (x) => {
    const done = [ask, fix, review].every((id) => room.post(x, id).request.state === "answered");
    const toUser = claimOf(x, ask, "answered");
    const toFable = claimOf(x, fix, "answered");
    const pass = claimOf(x, review, "answered");
    const report = finalOf(x, reportRun.id)[0];
    return done && toUser && toFable && pass && report?.output.disposition === "yield"
      ? `#${U}, #${R}, #${V} answered; #${toUser.number} claims #${U}, #${toFable.number} claims #${R}, #${pass.number} claims #${V} (outcome answered); his report #${report.number} is an update (yield)`
      : null;
  }, [`answers #${V} from @fable`, `answers #${R} from @fable`, `answers #${U} from you`]);
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
  const report = finalOf(s, reportRun.id)[0];
  browser.show(report.number);
  if (!rowHas(report.number, ".reply-yield")) fail(`his report #${report.number} is not tagged as an update on the page: ${rowText(report.number).slice(0, 200)}`);
  browser.on("eval", `() => { const d = document.querySelector('.timeline [data-number="${report.number}"] details.sent-to-t3'); if (d) d.open = true; return Boolean(d); }`);
  browser.waitFor("[Backroom briefing for @fable");
  browser.consoleClean();
  browser.screenshot("what-a-turn-was-sent");
  log("  page: the report (an update) opens to the briefing its turn was sent");

  // 9. The reviewer's agent goes on by itself after its answer (a self-started turn): a follow-up that wakes him.
  await service.fake("self-run", { threadId: room.thread.reviewer });
  await room.finish("reviewer", "One more thing: the fix also needs a test for 1900-02-29.");
  const selfStarted = (x: Snapshot) => followUps(x, seat.reviewer).find((p) => p.body.includes("One more thing"));
  let followUpNumber = 0;
  await check.state("a self-started turn is a follow-up that wakes the Consigliere", (x) => {
    const f = selfStarted(x);
    const run = wokeHim(x, f);
    if (!f || f.progress.t3?.threadId !== room.thread.reviewer || !hasStatus(f.body, "reviewer") || !f.about.some((r: any) => r.requestId === review) || !run) return null;
    followUpNumber = f.number;
    return `#${f.number} progress milestone=follow-up by @reviewer on #${V}, its T3 turn ${String(f.progress.t3.runId).slice(0, 12)}, status line on top; @fable's run ${run.id.slice(0, 8)} has it`;
  }, ["follow-up", "One more thing: the fix also needs a test for 1900-02-29."], {
    focus: (x) => selfStarted(x)?.number,
    extra: () => followUpBubble(followUpNumber),
  });
  await room.finish("fable", "Noted: I will have @worker add that test.");

  // 10. A turn the user stops fails: the notice needs the user, with Retry; Retry is clicked on the page.
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

  // 11. Another stopped turn: Dismiss takes it off "needs you"; then the user cancels the request from the page.
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

  // 12. The worker ends its turn with a background task listed in T3: its answer's status line names it, and it wakes
  // him at once (nothing is held). The task then ends with no further turn: after 30 s of quiet, one follow-up says so
  // and wakes him. (This replaces the old "working since": there is no working mark and no held request any more.)
  await room.settle("fable");
  room.board("fable", "post", "@worker add a --strict flag to the parser");
  const flagPost = await posted(seat.worker, "the flag request");
  const flag = flagPost.request.id;
  const F = flagPost.number;
  await room.live("worker");
  await service.background(room.thread.worker, ["strict-tests"]);
  const stillRunning = 'still running: background task "background strict-tests"';
  await room.finish("worker", "The --strict flag is in; its tests still run in the background.");
  let flagAnswer = 0;
  await check.state("the worker's status line names its background task", (x) => {
    const out = claimOf(x, flag, "answered");
    const run = wokeHim(x, out);
    if (!out || !hasStatus(out.body, "worker", stillRunning) || !run || x.counts.working !== 0 || !x.seats.every((w) => w.activities.length === 0) || room.post(x, flag).request.state !== "answered") return null;
    flagAnswer = out.number;
    return `#${out.number} answers #${F}; its body starts "${STATUS("worker", stillRunning)}"; @fable's run ${run.id.slice(0, 8)} has it; #${F} answered, counts.working=0, no activities`;
  }, [`answers #${F} from @fable`, "[T3 status of @worker: still running: background task"], {
    focus: (x) => claimOf(x, flag, "answered")?.number,
    extra: () => {
      const n = flagAnswer;
      if (!rowText(n).includes(STATUS("worker", stillRunning))) fail(`#${n}'s row does not show ${STATUS("worker", stillRunning)}`);
      if (browser.eval<boolean>("() => document.body.textContent.includes('working since')")) fail("the page still says 'working since'");
      log(`  page: #${n} shows the status line naming the background task; no 'working since' anywhere`);
    },
  });
  await room.finish("fable", "Noted: @worker's tests still run; its follow-up will say when they end.");
  await service.background(room.thread.worker, []);
  const cleared = Date.now();
  log("  T3 lists nothing in @worker's background any more; waiting for 30 s of quiet");
  const quietOf = (x: Snapshot) => followUps(x, seat.worker).filter((p) => p.body.includes("ended without a further turn"));
  const quietPost = await until("the quiet follow-up", async () => quietOf(await room.snapshot())[0], 75_000, 500);
  const quietAfter = (Date.now() - cleared) / 1000;
  if (quietAfter < 29.5) fail(`the quiet follow-up #${quietPost.number} came ${quietAfter.toFixed(1)} s after the task ended: before 30 s of quiet`);
  log(`  the quiet follow-up #${quietPost.number} came ${quietAfter.toFixed(1)} s after the task ended`);
  const quietBody = `${STATUS("worker")}\n\n(background task "background strict-tests" ended without a further turn.)`;
  await check.state("background work that ended without a turn: one quiet follow-up wakes the Consigliere", (x) => {
    const posts = quietOf(x);
    const run = wokeHim(x, posts[0]);
    return posts.length === 1 && posts[0].body === quietBody && posts[0].progress.t3 === null && posts[0].about.some((r: any) => r.requestId === flag) && run
      ? `one follow-up #${posts[0].number} on #${F} ${JSON.stringify(posts[0].body)}; @fable's run ${run.id.slice(0, 8)} has it`
      : null;
  }, ["ended without a further turn.", "follow-up"], { focus: (x) => quietOf(x)[0]?.number, extra: () => followUpBubble(quietPost.number) });
  await room.finish("fable", "Noted: @worker's tests have ended.");
  await room.settle("fable");
  if (quietOf(await room.snapshot()).length !== 1) fail("more than one quiet follow-up");

  // 13. He posts more work and cancels it while the worker's turn runs on it alone: the cancel stops that turn, whose
  // words wake nobody; an answer that arrives after that claims the request late. The cancel wakes the worker once, and
  // its reply to that is a follow-up that wakes him.
  room.board("fable", "post", "@worker also add a --lenient flag");
  const lenientPost = await posted(seat.worker, "the lenient request");
  const lenient = lenientPost.request.id;
  const L = lenientPost.number;
  const lateRun = await room.live("worker");
  room.board("fable", "cancel", `#${L}`);
  await check.state("a cancel stops the member's turn: what it wrote wakes nobody", (x) => {
    const stopped = finalOf(x, lateRun.id)[0];
    return room.post(x, lenient).request.state === "cancelled" && stopped && stopped.output.disposition === "yield" && stopped.to.length === 0 && x.runs.find((r) => r.id === lateRun.id)?.phase === "terminal"
      ? `#${L} cancelled; @worker's run ${lateRun.id.slice(0, 8)} stopped, its final #${stopped.number} ${JSON.stringify(stopped.body.split("\n").at(-1))} is a yield to nobody`
      : null;
  }, ["cancelled"], { show: L });
  room.journal([{ type: "output", actor: seat.worker, id: `rehearse:late:${randomUUID()}`, author: seat.worker, sourceKey: `answer:${seat.worker}:rehearse-late`, association: { kind: "run", id: lateRun.id }, body: "The --lenient flag is in.", disposition: { kind: "answer", requestIds: [lenient] } }]);
  await check.state("a late output", (x) => {
    const late = claimOf(x, lenient, "late");
    return late ? `#${late.number} by @worker claims #${L}: late (the request was cancelled)` : null;
  }, [`late for #${L}: it was cancelled`], { focus: (x) => claimOf(x, lenient, "late")?.number });
  // The late answer's attention notice wakes him; then the worker's turn on the cancel.
  await room.settle("fable");
  await room.live("worker");
  await room.finish("worker", "Noted: the --lenient flag is dropped.");
  // A turn the room started that has nothing left to answer: its final is the follow-up (an output with the milestone
  // follow-up, drawn as a reply "update on #n"), not a post of its own.
  const dropped = (x: Snapshot) => x.posts.find((p) => p.kind === "output" && p.author === seat.worker && p.output.source === "final" && p.body.includes("the --lenient flag is dropped"));
  await check.state("the worker's reply to the cancel is a follow-up that wakes the Consigliere", (x) => {
    const f = dropped(x);
    const run = wokeHim(x, f);
    return f && f.output.disposition === "progress" && f.output.claims.length === 0 && hasStatus(f.body, "worker") && f.about.some((r: any) => r.requestId === lenient) && f.to.includes(seat.fable) && run
      ? `#${f.number}, the final of @worker's turn on the cancel, is a follow-up on #${L} (disposition progress, no claims, to @fable) under its status line; @fable's run ${run.id.slice(0, 8)} has it`
      : null;
  }, ["Noted: the --lenient flag is dropped.", `update on #${L}`], { focus: (x) => dropped(x)?.number });
  await room.settle("fable");
  await room.settle("worker");
  await room.settle("fable");

  // 14. Someone types in T3 on the reviewer's thread; a post for the reviewer waits for that turn: the waiting backlog.
  await service.fake("external-run", { threadId: room.thread.reviewer, text: "Quick check from T3: is the build green?" });
  room.board("fable", "post", "@reviewer check the changelog wording");
  const wording = (await posted(seat.reviewer, "the wording request")).request.id;
  await check.state("waiting: unread backlog, no run", (x) => {
    const reviewer = x.seats.find((w) => w.seatId === seat.reviewer);
    return reviewer && reviewer.unread >= 1 && reviewer.activeRunId === null && x.counts.waiting >= 1 ? `@reviewer unread=${reviewer.unread} activeRunId=null; counts.waiting=${x.counts.waiting}` : null;
  }, ["Waiting ·", "1 unread", "Quick check from T3: is the build green?"]);

  // 15. A delivery over the byte budget: blocked.
  room.journal([{ type: "reserve", actor: "$system", id: `rehearse:blocked:${randomUUID()}`, seatId: seat.reviewer, runId: randomUUID(), dispatchCommandId: randomUUID(), dispatchMessageId: randomUUID(), maxBytes: 64 }]);
  await check.state("a blocked delivery", (x) => {
    const reviewer = x.seats.find((w) => w.seatId === seat.reviewer);
    const post = x.posts.find((p) => p.kind === "blocked" && p.blocked.seatId === seat.reviewer);
    return reviewer?.blocked && x.blocked.length >= 1 && post ? `seat.blocked #${reviewer.blocked.number} requiredBytes=${reviewer.blocked.requiredBytes}; blocked post #${post.number}; snapshot.blocked=${x.blocked.length}` : null;
  }, ["blocked delivery", "cannot reach @reviewer"], { focus: (x) => x.posts.find((p) => p.kind === "blocked")?.number });

  // 16. The turn typed in T3 ends: its prompt is the user's note, its reply a follow-up that wakes him; the waiting post
  // is then delivered and answered.
  await room.finish("reviewer", "Build is green.");
  const typedReply = (x: Snapshot) => followUps(x, seat.reviewer).find((p) => p.body.includes("Build is green."));
  let typedNumber = 0;
  await check.state("a turn typed in T3 ends as a follow-up; its prompt stays the user's note", (x) => {
    const prompt = x.posts.find((p) => p.kind === "note" && p.author === "$user" && p.note.source !== "post" && p.body.includes("Quick check from T3"));
    const reply = typedReply(x);
    const run = wokeHim(x, reply);
    if (!prompt || !reply || reply.progress.t3?.threadId !== room.thread.reviewer || !hasStatus(reply.body, "reviewer") || !run) return null;
    typedNumber = reply.number;
    return `#${prompt.number} note by the user (${prompt.note.source}); #${reply.number} follow-up by @reviewer from its T3 turn ${String(reply.progress.t3.runId).slice(0, 12)}, status line on top; @fable's run ${run.id.slice(0, 8)} has it`;
  }, ["Build is green.", "follow-up"], { focus: (x) => typedReply(x)?.number, extra: () => followUpBubble(typedNumber) });
  await room.live("reviewer");
  await room.finish("reviewer", "The changelog wording is fine.");
  await until("the reviewer's answer", async () => room.post(await room.snapshot(), wording).request.state === "answered");
  await room.settle("fable");

  // 17. The composer's plan rows (D2: "now" or "next", nothing else): "now" for an idle Consigliere; "next" for a T3
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
  browser.compose("Thanks for the report.");
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
      browser.compose("@worker /compact");
      pillReads("T3 command", "next", "a T3 command to a member in a turn typed in T3");
      browser.screenshot("plan-row-next");
      browser.compose("Also mention the parser fix.");
      pillReads("Also mention the parser fix.", "now", "a busy Consigliere (into his running turn)", "running turn");
      log(`  page: plan rows "now" (idle), "next" (@worker /compact while @worker is in a turn), "now" into @fable's running turn (${titles()[0]})`);
      browser.compose("/hold write it later");
      browser.waitFor("/hold is gone");
      if (browser.eval<boolean>("() => [...document.querySelectorAll('.composer-toolbar button.primary')].every((b) => b.disabled)") !== true) fail("Send is not disabled for a /hold message");
      log("  page: /hold refused before sending, Send disabled");
    },
  });
  // Its reply is a follow-up (H5), which wakes him after his running turn.
  await room.finish("worker", "Done looking.");

  // 17b. Sent from the composer: in his room every message is a steer. To the busy Consigliere it goes into his running
  // turn ("into the turn"); to him idle it starts a turn of its own (no such tag).
  const rowSays = (body: string, words: string) =>
    browser.eval<boolean>(`() => [...document.querySelectorAll('.timeline .chat-row.from-user')].some((row) => row.textContent.includes(${JSON.stringify(body)}) && row.textContent.includes(${JSON.stringify(words)}))`);
  const sent = (body: string) => async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === body);
  browser.compose("Also mention the parser fix.");
  browser.send();
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
  browser.compose("Please also tag v1.2.");
  browser.send();
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

  // 18. The conversation with the Consigliere: the user's requests and his answers to them, nothing between members.
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

  // 18b. The Consigliere reseats the worker (L4b): Backroom's checkpoint request and the handover are Backroom's on the
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
  // The fresh seat's first turn ends by itself (its thread is not held); its answer then wakes the Consigliere once.
  await room.settle("fable");

  // 19. The overview: member status while a turn runs, and the room's news when it ends.
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

  // 20. A room without a Consigliere: one message to two members, with an image, is one message on the board.
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

  // 21. The Consigliere reseats himself: a fresh seat of his takes over as Consigliere. The conversation with him keeps
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

  // 22. Talk to …: a conversation started with its first message (consigliere.start) makes a room with the saved crew
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

  membersOnlyAnswer(await room.snapshot());
  oldTablesAbsent(room.dataDir);
  return check.passed;
}

/** The old runtime's queue is gone (Z4; Z2 gated on its tables being empty): a fresh rooms.sqlite has none of its tables. */
function oldTablesAbsent(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "rooms.sqlite"), { readOnly: true });
  try {
    const old = ["tasks", "task_revisions", "runs"].filter((name) => db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined);
    if (old.length > 0) fail(`a fresh rooms.sqlite has old runtime tables: ${old.join(", ")}`);
    log("rooms.sqlite: no tasks, task_revisions or runs table");
  } finally {
    db.close();
  }
}

// ---------------- the whole room (--step room, Z2; H5: relayed by the Consigliere) ----------------

async function rehearseRoom(service: Service, browser: Browser, room: Room): Promise<string[]> {
  const check = new Checks(room, browser);
  const { seat } = room;
  const claimOf = (s: Snapshot, requestId: string, outcome: string) => s.posts.find((p) => p.kind === "output" && p.output.claims.some((c: any) => c.requestId === requestId && c.outcome === outcome));
  /** The member's run now, if it has one. */
  const runOf = (s: Snapshot, alias: Alias) => {
    const at = s.seats.find((x) => x.seatId === seat[alias]);
    return at?.activeRunId ? s.runs.find((r) => r.id === at.activeRunId) : undefined;
  };
  /** The Consigliere's run now, when the post is among its inputs: the post woke him. */
  const wokeHim = (s: Snapshot, post: { seq: number } | undefined) => {
    const run = post ? runOf(s, "fable") : undefined;
    return run && run.inputs.includes(post!.seq) ? run : undefined;
  };
  /** His request to a member, as H5 posts it: his, under nothing. */
  const posted = async (owner: string, what: string) => {
    const p = requestTo(await room.snapshot(), owner);
    if (!p || p.author !== seat.fable || p.request.parentId !== null) fail(`${what}: the newest request to ${owner.slice(0, 8)} is not his under nothing: ${JSON.stringify(p ? { author: p.author, parentId: p.request.parentId } : null)}`);
    return p as { number: number; seq: number; request: { id: string } };
  };
  /** His final for a run is an update: a yield, no claims, to nobody. */
  const update = (s: Snapshot, runId: string) => {
    const out = finalOf(s, runId)[0];
    return out && out.output.disposition === "yield" && out.output.claims.length === 0 && out.to.length === 0 ? out : undefined;
  };

  // Open the room as the user does: its card on the overview, then the board.
  browser.open();
  browser.openRoom(room.title);
  browser.click(/tab "Board/);
  browser.consoleClean();

  // 1. The assignment: the user types it to the Consigliere in the composer; his turn runs on it.
  const assignment = "Get the date parser fixed and reviewed, then report.";
  browser.click(/button "(Write a message|Continue your draft)"/);
  browser.compose(assignment);
  browser.send();
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

  // 2. He hands it to the worker and ends his turn: his final answers the assignment (H5: nothing holds it open).
  room.board("fable", "post", "@worker fix the date parser in src/dates.ts: two-digit years and leap days");
  const fixPost = await posted(seat.worker, "his hand-off");
  const fix = fixPost.request.id;
  const A = fixPost.number;
  await room.finish("fable", "I asked @worker for the fix; I will report once it is reviewed.");
  const fixRun = await room.live("worker");
  let handOff = 0;
  await check.state("handed to the worker: his final answers the assignment", (x) => {
    const out = claimOf(x, ask, "answered");
    const run = runOf(x, "worker");
    if (!out || out.author !== seat.fable || out.body.startsWith("[T3 status") || !run?.requestIds.includes(fix)) return null;
    handOff = out.number;
    return `#${out.number} by @fable answers #${U} (no status line), to ${JSON.stringify(out.to)}; #${A} to @worker under nothing, its run ${run.id.slice(0, 8)} on it`;
  }, [`answers #${U} from you`], { show: U, extra: () => browser.waitFor(`answered · #${handOff}`) });

  // 3. The worker's answer: its T3 status at the top, and it wakes him.
  await room.finish("worker", "The fix is in: src/dates.ts handles two-digit years and leap days.");
  let W1 = 0;
  s = await check.state("the worker's answer wakes him, with its T3 status at the top", (x) => {
    const out = claimOf(x, fix, "answered");
    const run = wokeHim(x, out);
    if (!out || !hasStatus(out.body, "worker") || !run) return null;
    W1 = out.number;
    return `#${out.number} answers #${A}, body starts "${STATUS("worker")}"; @fable's run ${run.id.slice(0, 8)} has it`;
  }, [`answers #${A} from @fable`, STATUS("worker")], { focus: (x) => claimOf(x, fix, "answered")?.number });

  // 4. He sends the worker's result to the reviewer (members never post to each other); his final is an update.
  const wake1 = runOf(s, "fable")!;
  room.board("fable", "post", `@reviewer review @worker's fix of the date parser: read #${W1}`);
  const review1Post = await posted(seat.reviewer, "his review request");
  const review1 = review1Post.request.id;
  const V1 = review1Post.number;
  await room.finish("fable", "I sent @worker's fix to @reviewer.");
  await room.live("reviewer");
  await check.state("he sends the worker's result to the reviewer", (x) => {
    const his = update(x, wake1.id);
    const run = runOf(x, "reviewer");
    return his && run?.requestIds.includes(review1) ? `#${V1} by @fable to @reviewer under nothing; his final #${his.number} is an update (yield, to nobody); @reviewer's run ${run.id.slice(0, 8)} on #${V1}` : null;
  }, ["fix of the date parser", "I sent @worker's fix to @reviewer."], { show: V1 });

  // 5. The review finds a fault: the finding answers his request and wakes him.
  const finding = "FINDING: 1900-02-29 parses as a valid date; 1900 is not a leap year, so it must be refused.";
  await room.finish("reviewer", finding);
  let F1 = 0;
  s = await check.state("a review finding: it answers his request and wakes him", (x) => {
    const out = claimOf(x, review1, "answered");
    const run = wokeHim(x, out);
    if (!out || out.body !== `${STATUS("reviewer")}\n\n${finding}` || !run) return null;
    F1 = out.number;
    return `#${out.number} by @reviewer answers #${V1} with the finding, under its status line; @fable's run ${run.id.slice(0, 8)} has it`;
  }, [`answers #${V1} from @fable`, "1900-02-29 parses as a valid date"], { focus: (x) => claimOf(x, review1, "answered")?.number });

  // 6. He sends the finding to the worker.
  const wake2 = runOf(s, "fable")!;
  room.board("fable", "post", `@worker fix the review's finding #${F1}: 1900-02-29 must be refused`);
  const fix2Post = await posted(seat.worker, "his finding for the worker");
  const fix2 = fix2Post.request.id;
  const A2 = fix2Post.number;
  await room.finish("fable", "I sent @reviewer's finding to @worker.");
  const findingRun = await until("@worker's turn on the finding", async () => {
    const run = runOf(await room.snapshot(), "worker");
    return run && run.id !== fixRun.id && run.phase === "running" && run.requestIds.includes(fix2) ? run : null;
  });
  await check.state("he sends the finding to the worker", (x) => {
    const his = update(x, wake2.id);
    const run = runOf(x, "worker");
    return his && run?.id === findingRun.id ? `#${A2} by @fable to @worker under nothing; his final #${his.number} an update; @worker's run ${run.id.slice(0, 8)} on #${A2}` : null;
  }, ["fix the review's finding", "I sent @reviewer's finding to @worker."], { show: A2 });

  // 7. The user's correction from the page while the worker's turn runs: a message typed in the composer. (#U is
  // answered by now, and a closed request takes no correction: Correct… is offered on open requests only.)
  const userCorrection = "Also make sure 30 February is refused in every year.";
  browser.click(/button "(Write a message|Continue your draft)"/);
  browser.compose(userCorrection);
  browser.send();
  const corrected = (await until("the user's correction on the board", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === userCorrection))).request.id as string;
  if (browser.eval<boolean>("() => Boolean(document.querySelector('.composer-overlay'))")) browser.on("press", "Escape");
  const relayRun = await room.live("fable");
  const C = room.post(await room.snapshot(), corrected).number as number;
  await check.state("the user's correction from the page reaches him while the worker's turn runs", (x) => {
    const post = room.post(x, corrected);
    const run = runOf(x, "fable");
    const w = runOf(x, "worker");
    return post.request.state === "open" && post.request.owner === seat.fable && run?.id === relayRun.id && run.requestIds.includes(corrected) && w?.id === findingRun.id && w.phase === "running"
      ? `#${C} by $user to @fable, open; his run ${run.id.slice(0, 8)} on it; @worker's run ${w.id.slice(0, 8)} still running on #${A2}`
      : null;
  }, [userCorrection, "open · @fable working"], { show: C });

  // 8. He passes it on with rooms-board correct while the worker's turn runs: that turn had not seen it, so its final
  // comes out superseded (and wakes nobody); #A2 stays open for the next turn.
  room.board("fable", "correct", `#${A2}`, `Also refuse 30 February in every year (the user's #${C}).`);
  await room.finish("worker", "Fixed the finding: 1900-02-29 is refused now.");
  await check.state("the correction came in during the worker's turn: its final is superseded", (x) => {
    const relayed = x.posts.find((p) => p.kind === "correction" && p.author === seat.fable && p.about.some((r: any) => r.requestId === fix2));
    const out = finalOf(x, findingRun.id)[0];
    const claim = out?.output.claims.find((c: any) => c.requestId === fix2);
    return relayed && claim?.outcome === "superseded" && out.to.length === 0 && room.post(x, fix2).request.state === "open" && room.post(x, fix2).request.corrections === 1
      ? `#${relayed.number} @fable corrects #${A2}; @worker's final #${out.number} claims #${A2}: superseded, to nobody; #${A2} open, corrected 1×`
      : null;
  }, [`@fable corrected #${A2}`, `#${A2} stays open: input it had not seen came in`], { focus: (x) => finalOf(x, findingRun.id)[0]?.number });

  // 9. The worker's next turn takes the correction while his turn on the user's message still runs: both are running
  // when the service is killed (SIGKILL) and started again. T3 (the fake, kept in its file) still runs both meanwhile.
  const correctionRun = await until("@worker's turn on the correction", async () => {
    const run = runOf(await room.snapshot(), "worker");
    return run && run.id !== findingRun.id && run.phase === "running" ? run : null;
  });
  const before = await check.state("two turns running before the kill", (x) => {
    const w = runOf(x, "worker");
    const f = runOf(x, "fable");
    const relayed = x.posts.find((p) => p.kind === "correction" && p.author === seat.fable);
    return w?.id === correctionRun.id && w.phase === "running" && relayed && w.inputs.includes(relayed.seq) && f?.id === relayRun.id && f.phase === "running" && f.requestIds.includes(corrected)
      ? `@worker's run ${w.id.slice(0, 8)} on the correction #${relayed.number}; @fable's run ${f.id.slice(0, 8)} on #${C}; journal head ${x.head}`
      : null;
  }, ["Working ·"], { show: A2 });
  const t3Before = Object.fromEntries(MEMBERS.map((a) => [a, service.t3Runs(room.thread[a])]));
  await service.kill();
  log("KILL: the service was killed with SIGKILL while @worker's and @fable's turns run");
  browser.screenshot("the-page-while-the-service-is-down");
  const logAt = service.logLength();
  await service.restart();
  log("the service started again on the same data; waiting 5 s (three ticks) before comparing");
  await sleep(5_000);
  await check.state("after the restart: the same turns go on, nothing sent or imported twice", (x) => {
    const w = runOf(x, "worker");
    const f = runOf(x, "fable");
    const t3Same = MEMBERS.every((a) => JSON.stringify(service.t3Runs(room.thread[a])) === JSON.stringify(t3Before[a]));
    return w?.id === correctionRun.id && w.phase === "running" && f?.id === relayRun.id && f.phase === "running" && x.head === before.head && x.runs.length === before.runs.length && t3Same
      ? `the same runs ${w.id.slice(0, 8)} and ${f.id.slice(0, 8)} running; journal head ${x.head} and ${x.runs.length} runs, as before; T3's runs per thread unchanged (${MEMBERS.map((a) => `@${a} ${t3Before[a]!.length}`).join(", ")})`
      : null;
  }, ["Working ·"], {
    show: A2,
    extra: () => {
      const lines = browser.acceptOutage();
      log(`  page: ${lines.length} console line(s) from Chrome for requests it made while the service was down${lines.length ? `, e.g. ${lines[0]!.slice(0, 160)}` : ""}`);
    },
  });

  // 10. After the restart the worker's turn ends: imported once, it answers #A2 (the page, never reloaded, shows it);
  // then his reply to the user's message answers it.
  await room.finish("worker", "1900-02-29 and 30 February are refused in every year now.");
  let W3 = 0;
  await check.state("after the restart the worker's turn is imported once and answers", (x) => {
    const outs = finalOf(x, correctionRun.id);
    const claim = outs[0]?.output.claims.find((c: any) => c.requestId === fix2);
    if (outs.length !== 1 || claim?.outcome !== "answered" || !hasStatus(outs[0].body, "worker")) return null;
    W3 = outs[0].number;
    return `#${outs[0].number}, the one final of run ${correctionRun.id.slice(0, 8)}, answers #${A2} under its status line`;
  }, [`answers #${A2} from @fable`, "30 February are refused in every year now"], { focus: (x) => finalOf(x, correctionRun.id)[0]?.number });
  await room.finish("fable", "I passed your correction on to @worker.");
  await check.state("his reply answers the user's correction", (x) => {
    const out = finalOf(x, relayRun.id)[0];
    return out && out.output.claims.some((c: any) => c.requestId === corrected && c.outcome === "answered") && room.post(x, corrected).request.state === "answered" ? `#${out.number} by @fable answers #${C}` : null;
  }, [`answers #${C} from you`], { focus: (x) => finalOf(x, relayRun.id)[0]?.number });

  // 11. The worker's answer wakes him: he sends the corrected fix to the reviewer again; the reviewer's PASS wakes him.
  const wake3 = await until("@worker's answer to wake him", async () => wokeHim(await room.snapshot(), finalOf(await room.snapshot(), correctionRun.id)[0]));
  room.board("fable", "post", `@reviewer review again: read #${W3}`);
  const review2Post = await posted(seat.reviewer, "his second review request");
  const review2 = review2Post.request.id;
  const V2 = review2Post.number;
  await room.finish("fable", "I sent the corrected fix to @reviewer.");
  await room.live("reviewer");
  await room.finish("reviewer", "PASS: 1900-02-29 and 30 February are refused, and the tests cover both.");
  s = await check.state("PASS: the second review answers him and wakes him", (x) => {
    const pass = claimOf(x, review2, "answered");
    const run = wokeHim(x, pass);
    return pass && hasStatus(pass.body, "reviewer") && run && update(x, wake3.id) ? `#${pass.number} answers #${V2} (PASS) under its status line; @fable's run ${run.id.slice(0, 8)} has it` : null;
  }, [`answers #${V2} from @fable`, "PASS: 1900-02-29 and 30 February are refused"], { focus: (x) => claimOf(x, review2, "answered")?.number });
  const failures = service.logSince(logAt).split("\n").filter((line) => /tick failed|room step failed|seat step failed|already bound|refused/.test(line));
  if (failures.length > 0) fail(`service.log since the restart:\n${failures.slice(0, 5).join("\n")}`);
  log("  service.log since the restart: no failed tick or step, nothing refused");

  // 12. His report: an update (his later replies after the user's message are), in the room's news on the overview and
  // in the chat with him.
  const reportRun = runOf(s, "fable")!;
  browser.click(/button "Back to the overview"/);
  const report = "Report: the date parser is fixed, your correction is in, and the review passed.";
  await room.finish("fable", report);
  s = await until("his report in the room's news", async () => {
    const x = await room.snapshot();
    const out = update(x, reportRun.id);
    return out && out.body === report && x.news.unseen >= 1 && x.news.latest?.seq === out.seq ? x : null;
  });
  await check.state("his report is an update in the room's news", (x) => {
    const out = update(x, reportRun.id);
    return out && x.news.latest?.seq === out.seq && x.news.unseen === s.news.unseen ? `#${out.number} yield (no claims, to nobody); news.unseen=${x.news.unseen}, latest #${x.news.latest!.number} (${x.news.latest!.kind})` : null;
  }, [`${s.news.unseen} new`], {
    extra: () => {
      // The tile's news (the room list) and its members (the overview's detail) come from two polls: the card is read
      // until both have caught up with his idle seat, so the screenshot shows no "busy" next to the news.
      browser.poll<{ news: string | null; busy: boolean; words: string } | null>(
        "the room's tile with his report as news and nobody busy",
        `() => { const card = [...document.querySelectorAll('article.ov-room')].find((c) => c.querySelector('.ov-room-title')?.textContent === ${JSON.stringify(room.title)}); return card ? { news: card.querySelector('.pill-new')?.textContent ?? null, busy: Boolean(card.querySelector('.pill-working')), words: card.textContent ?? '' } : null; }`,
        (tile) => tile !== null && tile.news === `${s.news.unseen} new` && !tile.busy && tile.words.includes(report.slice(0, 40)),
      );
      log("  page: the tile says the news, nobody busy, and shows his report's words");
    },
  });
  browser.openRoom(room.title);
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

  // 13. A turn T3 fails (a provider error); its notice offers Retry, and the user retries it from the page.
  await room.settle("fable");
  const tag = await room.message("Tag v1.2 now that the parser fix is in.");
  await room.live("fable");
  room.board("fable", "post", "@worker tag v1.2");
  const tagJob = (await posted(seat.worker, "his tag request")).request.id;
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
  const tagged = await until("the retried turn's answer to wake him", async () => {
    const x = await room.snapshot();
    return wokeHim(x, claimOf(x, tagJob, "answered"));
  });
  await room.finish("fable", "v1.2 is tagged.");
  await check.state("the retried turn answers him; his hand-off had answered the user", (x) => {
    const job = claimOf(x, tagJob, "answered");
    const user = claimOf(x, tag, "answered");
    const his = update(x, tagged.id);
    return job && user && user.author === seat.fable && user.seq < job.seq && his ? `#${job.number} answers #${B}; #${user.number}, his hand-off, answers #${T}; his reply #${his.number} is an update` : null;
  }, [`answers #${B} from @fable`, `answers #${T} from you`]);

  // 14. He reseats the worker: its checkpoint, then a fresh seat of it takes over and works.
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
  const strict = (await posted(seat.worker, "his request to the fresh worker")).request.id;
  await room.live("worker");
  await room.finish("worker", "The --strict flag is in.");
  await room.settle("fable");
  await check.state("the fresh seat's work lands", (x) => {
    const out = claimOf(x, strict, "answered");
    return out && out.author === seat.worker && hasStatus(out.body, room.name.worker) ? `#${out.number} by the fresh seat answers #${room.post(x, strict).number}, under "${STATUS(room.name.worker)}"` : null;
  }, ["The --strict flag is in."], { focus: (x) => claimOf(x, strict, "answered")?.number });
  // Back on the overview the old seat's kept thread has a card of its own ("<room> · worker"): the room's card is still
  // the one opened, by its exact title.
  browser.click(/button "Back to the overview"/);
  browser.poll<string[]>("the kept thread's card on the overview", "() => [...document.querySelectorAll('.ov-room-title')].map((t) => t.textContent)", (titles) => titles.includes(room.title) && titles.includes(`${room.title} · worker`));
  log(`  page: the overview has the room's card and the kept thread's "${room.title} · worker"`);
  browser.openRoom(room.title);
  browser.click(/tab "Board/);

  // 15. He retires the reviewer: refused while it has work open, done once it has none.
  room.board("fable", "post", "@reviewer check the --strict flag's help text");
  const help = (await posted(seat.reviewer, "his help-text request")).request.id;
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

  // Where the room ends: nothing open, no run unresolved, no background work pending; H5's rules held throughout;
  // no old runtime tables.
  const end = await room.snapshot();
  const unresolved = end.runs.filter((r) => r.phase !== "terminal");
  if (end.requests.length > 0 || unresolved.length > 0 || end.seats.some((x) => x.activities.length > 0)) {
    fail(`the room did not end quiet: ${end.requests.length} open request(s), ${unresolved.length} unresolved run(s), activities ${JSON.stringify(end.seats.flatMap((x) => x.activities))}`);
  }
  log(`the room ends quiet: ${end.posts.length} posts, ${end.runs.length} runs all terminal, no open request, no pending activity`);
  membersOnlyAnswer(end);
  oldTablesAbsent(room.dataDir);
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
    await room.create(o.step === "room" ? "Whole room" : "Rehearsal");
    passed =
      o.step === "ui" ? await rehearseUi(service, browser, room) : o.step === "keys" ? await rehearseKeys(service, browser, room, { log, fail, until, sleep }) : await rehearseRoom(service, browser, room);
    log(`DONE: ${passed.length} states checked in the API and on the page, console clean`);
  } finally {
    browser.close();
    if (o.keep) log(`--keep: the service stays on ${service.base}`);
    else await service.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`[rehearse] FAILED: ${error instanceof RehearsalFailure ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
