/**
 * The browser rehearsal on a throwaway service (stage 4/5 plan, item L5: `--step ui`; Z2 adds `--step room`; U1's
 * `--step keys`, keyboard only, is in rehearse-keys.ts).
 *
 *   node scripts/rehearse.ts --step ui|room|keys --as <rooms-browser key> [--browser backroom-dev] [--port 4471]
 *        [--data <dir>] [--out <dir>] [--keep] [--only <state>]… [--until <state>]
 *   node scripts/rehearse.ts --step all --as <key> [--browser general] [--keys-browser backroom-dev] [--port 4471] …
 *   node scripts/rehearse.ts --step ui|room|keys|all --list
 *
 * `--step all` starts the three steps together (runAll); `--only` and `--until` choose the states a step checks and
 * where it stops (scripts/rehearse-select.ts); `--list` prints each step's states, numbered.
 *
 * It starts its own service from this checkout (ROOMS_ADAPTER=fake ROOMS_PORT=<port>
 * ROOMS_DATA_DIR=<dir>, the throwaway service of the plan's conventions; never the user's :4400), scripts a room with
 * a Consigliere, a worker and a reviewer, and for every state the page must show checks two things: the room snapshot
 * from the API (GET /api/rooms/:id) has the expected fields, and `rooms-browser … wait-for <text>` printed a match in
 * the user's view of it. After each step it reads `rooms-browser … console` and fails on any error-level line. The
 * first failure ends the run with exit code 1; a screenshot of each state goes to --out. The page opens on
 * http://rehearse-<port>.localhost:<port> (REHEARSE_TAB_HOST names another host): a site of the run's own, so a
 * renderer of its own, which a crash in the run takes down alone.
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
 *   (`--step ui` only; `--step room` writes one the same way for B1: a briefing in the user's name, as journals from
 *   before B1 hold it.)
 *
 * The board's semantics are H5's ("members only answer", README.md): a member's final answers the requests its turn was
 * given and wakes the Consigliere, with its T3 status line at the top; members do not post (`rooms-board post` is
 * refused them); the Consigliere routes reviews (the worker answers him, he posts the result to the reviewer, the
 * reviewer answers him, he posts the findings to the worker); his first final after a user's message answers it, his
 * later ones are updates; a member's turn the room did not start is a follow-up that wakes him, and background work
 * that ends with no further turn gets one follow-up after 30 s of quiet. Nothing holds a request open.
 *
 * `--step ui` ends with A1's agents file (rehearseAgentsFile): a room created from the overview in a scratch project
 * without one writes it, keeps it out of git and installs the hook that copies it into new worktrees.
 * ROOMS_FAKE_PROJECT_DIR, which the service inherits, points the demo project every step uses at a folder of the
 * caller's (a scratch git repository, so the steps run where the agents file is written too).
 *
 * `--step room` ends with B3's state, the Browser panel of a room that may use two browsers (see rehearseBrowserPanel).
 *
 * `--step room` (Z2) plays one whole job with nothing written by hand: the user's assignment from the composer, the
 * Consigliere hands it to the worker (his final answers the user), the worker's answer wakes him, he sends it to the
 * reviewer, the reviewer's finding wakes him, he sends the finding to the worker, the user's correction from the page
 * (a message from the composer: the assignment is answered by then, and a closed request takes no correction) passed on
 * by the Consigliere with `rooms-board correct` while the worker's turn runs (that final comes out superseded), the
 * service killed (SIGKILL) and started again while two turns run (the worker's on the correction and his on the user's
 * message), the second review, PASS, his report (an update in the room's news); then a turn T3 fails and the user's
 * Retry from the page, a reseat, and a retire (refused first while the member has work); then B1's: a member seated
 * whose briefing fails (Backroom's request: the Consigliere's notice, nothing for the user) and whom he retires at once,
 * and the user's case (#438) on a journal from before B1, whose briefing in the user's name fails (his, as it reached
 * him), then the Consigliere's cancel wakes the member to fail again (needing nobody), and he retires the member; a
 * reseat's checkpoint the member fails (Backroom's request too: his notice), which he cancels; and his own failed turn
 * on the user's message, in the chat as in the status bar, dismissed there (the bar, the counts and the overview's tile
 * clear) and then retried there. The fake T3 keeps its threads
 * in <data>/fake-t3.json (ROOMS_FAKE_STATE), so it comes back from the kill as real T3 would, since T3 is not
 * Backroom's process; the script reads that file as T3's own record of what it ran.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EngineStore } from "../src/engine/index.ts";
import { rehearseKeys } from "./rehearse-keys.ts";
import { forSteps, sectionNames, Selection, SelectionDone, stateNames, stepSource } from "./rehearse-select.ts";
import { clearRecord, ourTabs, parseArgs, portOf, recordOf, recordText, serviceRecord, stepPassed, tabGone, type ServiceRecord } from "./rehearse-launch.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------- options ----------------

type Step = "ui" | "room" | "keys";
const STEPS: readonly Step[] = ["ui", "room", "keys"];
const USAGE = "usage: node scripts/rehearse.ts --step ui|room|keys|all --as <rooms-browser key> [--port <port>] [--only <state>]… [--until <state>] [--list] [--help]";
const HELP = `${USAGE}

  --step ui|room|keys   one step, on a throwaway service of its own (ROOMS_ADAPTER=fake) on --port (default 4471)
  --step all            the three together: ui on --port, room on the next, keys on the one after; ui and room in
                        --browser (default general), keys in --keys-browser (default backroom-dev); prints each
                        step's result, exits 1 if any failed, and cleans up after a failed or stopped one
  --as <key>            your rooms-browser key (from your briefing)
  --browser <name>      the shared browser (default backroom-dev for one step)
  --data <dir>          the run's data (default data/rehearse-<step>-<port>; --step all: data/rehearse-all-<port>/<step>)
  --out <dir>           screenshots (default <data>/screens; --step all: <out>/<step>, and each step's log beside it)
  --only <state>        check only this state (as often as wanted): its number from --list (under --step all, that
                        number in each step), a range (12-15), a /pattern/ or part of its name; the run jumps to its
                        section, sets up what the section reads, plays the states before it without screenshots or
                        console reads, and stops after the last state named (ui 1-12 and room 1-14 need the whole
                        story before them: --until is as quick for those)
  --until <state>       play the step, every check on, and stop after this state
  --list                print each step's states, numbered, and run nothing
  --keep                leave the service running at the end
  --browser-cli <path>  rooms-browser to use (default: the main checkout's bin/rooms-browser)`;

interface Options {
  step: Step | "all";
  as: string;
  browser: string;
  /** --step all: the browser keys has to itself (ui and room share --browser). */
  keysBrowser: string;
  port: number;
  data: string;
  out: string;
  /** Whether --out was given: --step all then writes each step's log beside its screenshots. */
  outGiven: boolean;
  cli: string;
  keep: boolean;
  /** --only, as often as given, and --until (scripts/rehearse-select.ts). */
  only: string[];
  until: string | null;
  /** --list: print the step's states, numbered, and run nothing. */
  list: boolean;
}

function options(argv: string[]): Options {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(`${(error as Error).message}\n${USAGE}`);
  }
  if (args.has("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  const step = args.value("--step");
  const as = args.value("--as");
  const list = args.has("--list");
  if (step !== "ui" && step !== "room" && step !== "keys" && step !== "all") fail(USAGE);
  if (!as && !list) fail("--as <key> is required: the rooms-browser key of the room whose browser this uses");
  const all = step === "all";
  let port: number;
  try {
    port = portOf(args.value("--port"), 4471);
  } catch (error) {
    fail((error as Error).message);
  }
  // A run's own folder by default, named by its port: runs side by side (another step, a launcher, a trial) never share
  // one (a run deletes its folder's old data as it starts).
  const data = resolve(args.value("--data") ?? join(repo, "data", `rehearse-${step}-${port}`));
  const out = args.value("--out");
  return {
    step,
    as: as ?? "",
    browser: args.value("--browser") ?? (all ? "general" : "backroom-dev"),
    keysBrowser: args.value("--keys-browser") ?? "backroom-dev",
    port,
    data,
    out: resolve(out ?? (all ? data : join(data, "screens"))),
    outGiven: out !== undefined,
    cli: args.value("--browser-cli") ?? process.env.ROOMS_BROWSER_CLI ?? (list ? "" : browserCli()),
    keep: args.has("--keep"),
    only: args.all("--only"),
    until: args.value("--until") ?? null,
    list,
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

/** The record of the service a rehearsal runs on a data folder (scripts/rehearse-launch.ts), if there is one. */
function readRecord(data: string): ServiceRecord | null {
  const file = join(data, "service.pid");
  return existsSync(file) ? serviceRecord(readFileSync(file, "utf8")) : null;
}
/** Whether a process is a Backroom service still (not gone, nor its pid taken by another program since). */
function isService(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("src/server/index.ts");
  } catch {
    return false;
  }
}

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
      const running = readRecord(this.o.data);
      if (running && isService(running.service)) fail(`${this.o.data} is in use: another rehearsal's service (pid ${running.service}, port ${running.port}) runs on it; pass another --data`);
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
    // For the launcher: what to stop if this script is ended before it stops the service itself; and so another run
    // does not take this folder while the service runs.
    writeFileSync(join(this.o.data, "service.pid"), recordText({ service: child.pid!, owner: process.pid, port: this.o.port }));
    child.on("exit", (code, signal) => {
      if (this.child === child) log(`the service exited by itself (code ${code}, signal ${signal}): see ${join(this.o.data, "service.log")}`);
    });
    await until("the service to answer", () => fetch(`${this.base}/api/status`).then((r) => r.ok), 30_000, 300);
  }

  /** Stopped, and gone once this returns: whoever reads its data next (sqlite3 in the Z2 gate) finds nothing locked. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    // Also when there was nothing to stop (stopped between the room step's kill and its restart).
    clearRecord(this.o.data, process.pid, isService);
  }

  /** The service dies as in a crash (SIGKILL: no shutdown of any kind), and nothing answers on its port any more. */
  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) fail("no service to kill");
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
    clearRecord(this.o.data, process.pid, isService);
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
  /**
   * Our tab: the number `open` printed, kept (rooms-browser never reuses a number while the browser runs). Only when
   * rooms-browser answers that it has no such tab of ours is it looked up again, among the tabs it marks as ours on
   * this service's URL.
   */
  private tab(): string {
    return this.tabId ?? this.lookup();
  }
  private lookup(): string {
    const listing = this.run(["tabs"]).out;
    const id = ourTabs(listing, this.url).at(-1);
    if (!id) fail(`no tab of ours on ${this.url}:\n${listing}`);
    this.tabId = id;
    return id;
  }
  /** A command on our tab; refused for the tab (gone, or not ours: the browser restarted), it is tried once more on the tab found again. */
  private onTab(args: string[], timeoutMs?: number): { ok: boolean; out: string } {
    const kept = this.tab();
    const result = this.run([kept, ...args], timeoutMs);
    if (result.ok || !tabGone(result.out)) return result;
    const found = this.lookup();
    log(`  (rooms-browser: ${result.out.trim().split("\n")[0]}; our tab on ${this.url} is ${found} now)`);
    return found === kept ? result : this.run([found, ...args], timeoutMs);
  }
  on(...args: string[]): string {
    const result = this.onTab(args);
    if (!result.ok) fail(`rooms-browser ${args[0]} failed: ${result.out.trim().slice(0, 400)}`);
    return result.out;
  }

  open(): void {
    const result = this.run(["open", `${this.url}/`]);
    if (!result.ok) fail(`could not open a tab: ${result.out}`);
    this.tabId = /^Opened tab (\d+) in /m.exec(result.out)?.[1] ?? null;
    this.tab();
    // A fresh start: whatever an earlier rehearsal (or anyone) left in this origin's storage would open another room.
    this.on("eval", "() => { localStorage.clear(); sessionStorage.clear(); return true; }");
    this.on("reload");
  }
  close(): void {
    if (this.tabId) this.run([this.tabId, "close"]);
    this.tabId = null;
  }

  /** `wait-for` must print a match; it fails after its own 30 s. */
  waitFor(text: string): void {
    const result = this.onTab(["wait-for", text], 90_000);
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
  room: { id: string; title: string; consigliereId: string | null; browserEnabled: boolean; allowedBrowserIds: string[] | null };
  /** The room's default browser and its process; null when it has none. */
  browser: { browser: { id: string; name: string }; status: { state: string } } | null;
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
      assignments: [{ recipients: [this.participant.fable], instruction: text }],
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
  private readonly selection: Selection;
  constructor(room: Pick<Room, "snapshot">, browser: Browser, selection: Selection) {
    this.room = room;
    this.browser = browser;
    this.selection = selection;
  }

  /**
   * One state: the snapshot has it (polled until `api` returns a description of the fields that show it), then the page
   * shows it (`wait-for` each text), the console is clean, and a screenshot is kept.
   *
   * A state --only does not name, played before one it names, is set up silently: the snapshot is polled and the texts
   * waited for as always (the story goes on from both), and `always` runs, but nothing else of the page is checked, and
   * `silently` stands in for what `extra` does that the story needs.
   */
  async state(
    name: string,
    api: (s: Snapshot) => string | null | false,
    page: string[],
    options: { show?: number; focus?: (s: Snapshot) => number | undefined; extra?: () => void; always?: () => void; silently?: () => void } = {},
  ): Promise<Snapshot> {
    const { index, loud } = this.selection.enter(name);
    log(`${loud ? "CHECK" : "SET UP (silently)"} ${this.selection.label(index)}`);
    let described = "";
    const snap = await until(`the snapshot to show: ${name}`, async () => {
      const s = await this.room.snapshot();
      const found = api(s);
      if (!found) return null;
      described = found;
      return s;
    });
    log(`  api: ${described}`);
    const show = loud ? (options.show ?? options.focus?.(snap)) : undefined;
    if (show !== undefined) this.browser.show(show);
    for (const text of page) this.browser.waitFor(text);
    options.always?.();
    if (loud) {
      options.extra?.();
      this.browser.consoleClean();
      if (show !== undefined) this.browser.show(show);
      this.browser.screenshot(name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase());
      this.passed.push(name);
      log(`PASS ${name}`);
    } else {
      options.silently?.();
    }
    return snap;
  }

  /** A state whose checks are written out where it is played (B3's): its place in the selection, and whether to check it. */
  begin(name: string): { index: number; loud: boolean } {
    const entered = this.selection.enter(name);
    log(`${entered.loud ? "CHECK" : "SET UP (checked as always)"} ${this.selection.label(entered.index)}`);
    return entered;
  }
  /** Its end, all its checks done: passed, and the step stops here if it is the last one played. */
  pass(entered: { index: number; loud: boolean }): void {
    const name = this.selection.names[entered.index]!;
    if (entered.loud) this.passed.push(name);
    log(`PASS ${name}`);
    this.selection.leave(entered.index);
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
  const byMembers = requests.filter((p) => p.author !== "$user" && p.author !== "$system" && !his.has(p.author));
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

async function rehearseUi(service: Service, browser: Browser, room: Room, selection: Selection): Promise<string[]> {
  const check = new Checks(room, browser, selection);
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
  /**
   * A section of the story begins, named by its first state (scripts/rehearse-select.ts): false when a run jumps past it,
   * and the step stops here once the last state it plays is behind. A run that jumps into it starts from the room as
   * created, its board open (below): the setup checks that, and brings the page where the section starts (`place`).
   * In a run that jumped, a section has what the skipped sections made and it reads made through the API (`replay`, which
   * makes only what is missing: a later section may read what the one jumped into made too).
   */
  const section = async (first: string, setup: { replay?: () => Promise<void>; place?: () => void } = {}): Promise<boolean> => {
    selection.stopIfDone();
    const how = selection.section(first);
    if (how === "skip") return false;
    if (how === "jump") {
      log(`JUMP to the section of "${first}": its setup`);
      const x = await room.snapshot();
      const going = x.runs.filter((r) => r.phase !== "terminal");
      const unread = x.seats.filter((w) => w.unread > 0);
      if (going.length > 0 || x.requests.length > 0 || x.needsYou.length > 0 || x.nativeRequests.length > 0 || unread.length > 0) {
        fail(`a jump starts from the room as created, quiet; it has ${going.length} run(s) going, ${x.requests.length} open request(s), ${x.needsYou.length} needing you, ${x.nativeRequests.length} T3 request(s), ${unread.length} seat(s) with unread posts`);
      }
      browser.poll<{ title: string | null; view: string | null }>("the room's board, where a jump starts", "() => ({ title: document.querySelector('.sheet-title h1')?.textContent ?? null, view: document.querySelector('.timeline')?.getAttribute('aria-label') ?? null })", (v) => v.title === room.title && v.view === "Board", 5_000);
    }
    if (selection.jumps) await setup.replay?.();
    if (how === "jump") setup.place?.();
    return true;
  };
  // What the sections share: a section that reads one, jumped into, has its setup make it.
  let s!: Snapshot;
  /** Your first request and its post (#U); his hand-off to @worker (#R) and his request to @reviewer (#V). */
  let ask!: string;
  let U!: number;
  let R!: number;
  let V!: number;
  /**
   * A jump's replay of the first job chain through the API, as the chat with him reads it, unless the first section made
   * it or it was replayed already: your request, his hand-off to @worker that answers it, @worker's answer, his request
   * to @reviewer, its PASS and his report. With `typedInT3`, also a turn typed in T3 on @reviewer's thread (state 24's),
   * which the chat must not show.
   */
  const replayChain = async (options: { typedInT3?: boolean } = {}): Promise<void> => {
    if (ask !== undefined) return;
    for (const alias of MEMBERS) await room.settle(alias);
    // A jump into the worker's reseat (section 8) leaves his old seat retired: the chain goes to the fresh one.
    if ((await room.snapshot()).seats.find((x) => x.seatId === seat.worker)?.status === "retired") await room.rebind("worker");
    const report = "Report: the date parser is fixed and reviewed (PASS).";
    ask = await room.message("Get the date parser fixed and reviewed, then report.");
    await room.live("fable");
    U = room.post(await room.snapshot(), ask).number as number;
    room.board("fable", "post", `@${room.name.worker} fix the date parser in src/dates.ts`);
    R = (await posted(seat.worker, "his hand-off")).number;
    await room.finish("fable", "I asked @worker for the fix; I will report once it is reviewed.");
    await room.live("worker");
    await room.finish("worker", "The fix is in: src/dates.ts handles two-digit years and leap days.");
    await room.live("fable");
    room.board("fable", "post", "@reviewer review the date parser fix");
    V = (await posted(seat.reviewer, "his review request")).number;
    await room.finish("fable", "I sent @worker's fix to @reviewer for review.");
    await room.live("reviewer");
    await room.finish("reviewer", "PASS: the fix is right and the tests cover leap years.");
    await room.live("fable");
    await room.finish("fable", report);
    // Unless an earlier section (5) typed it already: one such turn, as in the full run.
    if (options.typedInT3 && !(await room.snapshot()).posts.some((p) => p.kind === "note" && p.body.includes("Quick check from T3"))) {
      await service.fake("external-run", { threadId: room.thread.reviewer, text: "Quick check from T3: is the build green?" });
      await room.finish("reviewer", "Build is green.");
      await until("the turn typed in T3 on the board", async () => {
        const x = await room.snapshot();
        return x.posts.some((p) => p.kind === "note" && p.body.includes("Quick check from T3")) && followUps(x, seat.reviewer).some((p) => p.body.includes("Build is green."));
      });
    }
    for (const alias of MEMBERS) await room.settle(alias);
    const x = await room.snapshot();
    if (room.post(x, ask).request.state !== "answered" || !x.posts.some((p) => p.author === seat.fable && p.body === report)) fail(`the replayed job chain did not leave #${U} answered and his report on the board`);
    log(`  replayed: #${U} answered by his hand-off; #${R} to @worker and #${V} to @reviewer answered; his report${options.typedInT3 ? "; a turn typed in T3 on @reviewer's thread" : ""}`);
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

  if (await section("Backroom's seat briefing, not the user's message")) {
    // 0. Backroom's seat briefings (L4b; its own requests since B1) are Backroom's on the board, and so are their
    // acknowledgements, which go to nobody.
    await check.state("Backroom's seat briefing, not the user's message", (x) => {
      const briefing = x.posts.find((p) => p.kind === "request" && p.author === "$system" && p.request.id.startsWith("seat-briefing:") && p.request.owner === seat.worker);
      const ack = briefing && claimOf(x, briefing.request.id, "answered");
      return briefing && briefing.request.returnTo === "$system" && ack && ack.to.length === 0 ? `#${briefing.number} request ${briefing.request.id.slice(0, 24)}… by $system, answered by #${ack.number} (to nobody)` : null;
    }, ["Backroom → @worker: seat briefing", "(seat briefing)"]);

    // 1. The user asks the Consigliere; his turn runs: an open request, with who is on it.
    ask = await room.message("Get the date parser fixed and reviewed, then report.");
    await room.live("fable");
    s = await room.snapshot();
    U = room.post(s, ask).number as number;
    await check.state("open marker on the user's request", (x) => {
      const post = room.post(x, ask);
      const run = x.runs.find((r) => r.seatId === seat.fable && r.phase === "running" && r.requestIds.includes(ask));
      return post.request.state === "open" && run && x.requests.some((q) => q.id === ask && q.runId === run.id) ? `#${post.number} request.state=open, run ${run.id.slice(0, 8)} phase=running works on it` : null;
    }, ["open · @fable working", "Working ·"], { show: U });

    // 2. He hands it to the worker and ends his turn: his final answers the user's request (H5: nothing holds it open).
    room.board("fable", "post", "@worker fix the date parser in src/dates.ts");
    const fixPost = await posted(seat.worker, "his hand-off");
    const fix = fixPost.request.id;
    R = fixPost.number;
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
    V = reviewPost.number;
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
  }

  if (await section("a failed turn that needs you, with Retry and Dismiss")) {
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
  }

  if (await section("the worker's status line names its background task")) {
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
  }

  if (await section("a cancel stops the member's turn: what it wrote wakes nobody")) {
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
  }

  if (await section("waiting: unread backlog, no run")) {
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
  }

  if (await section("plan rows: no timing, only what is gone (M1)")) {
    // 17. The composer's plan rows (M1): a message goes now, into the recipient's running turn when it works, so a row
    // shows no timing: no pill for a message to the idle or the busy Consigliere; a T3 command to a member mid-turn in
    // T3 is marked "T3 command" and the hint says it runs after the current turn; /steer and /hold are refused, with
    // their fix on the row's pill, before anything is sent.
    await room.settle("fable");
    await room.settle("worker");
    const pills = () => browser.eval<string[]>("() => [...document.querySelectorAll('.plan-pill')].map((pill) => pill.textContent.trim())");
    const hint = () => browser.eval<string>("() => document.querySelector('.composer-hint')?.textContent ?? ''");
    /**
     * The plan for what was just typed shows `expected` pills (and the composer's hint says `said`), polled: the page
     * learns of a member's state on its next read of the room (a turn typed in T3 appends nothing to the journal, so
     * only the room's timer brings it).
     */
    const planReads = (typed: string, expected: string[], what: string, said?: string) => {
      browser.waitFor(typed);
      const ok = () => JSON.stringify(pills()) === JSON.stringify(expected) && (said === undefined || hint().includes(said));
      const end = Date.now() + 15_000;
      while (!ok() && Date.now() < end) execFileSync("sleep", ["0.5"]);
      if (!ok()) fail(`plan rows for ${what}: ${JSON.stringify(pills())} ${JSON.stringify(hint())}`);
    };
    browser.click(/button "(Write a message|Continue your draft)"/);
    browser.compose("Thanks for the report.");
    planReads("Thanks for the report.", [], "an idle Consigliere");
    await service.fake("external-run", { threadId: room.thread.worker, text: "Looking at something in T3." });
    const notes = await room.message("Draft the release notes.");
    await room.live("fable");
    await check.state("plan rows: no timing, only what is gone (M1)", (x) => {
      const run = x.runs.find((r) => r.seatId === seat.fable && r.phase === "running" && r.requestIds.includes(notes));
      const worker = (x as unknown as { participantStatus: Record<string, { externalActivity: boolean }> }).participantStatus[room.participant.worker];
      return run && worker?.externalActivity ? `@fable run ${run.id.slice(0, 8)} running; @worker in a turn typed in T3 (externalActivity=true)` : null;
    }, [], {
      extra: () => {
        browser.compose("@worker /compact");
        planReads("T3 command", [], "a T3 command to a member in a turn typed in T3", "a T3 command runs after the current turn");
        browser.screenshot("plan-row-t3-command");
        browser.compose("Also mention the parser fix.");
        planReads("Also mention the parser fix.", [], "a busy Consigliere (it goes into his running turn)");
        if (/next|steer/i.test(hint())) fail(`the hint for a message to the busy Consigliere: ${hint()}`);
        log("  page: no pill for a message to the idle or the busy Consigliere; @worker /compact while @worker is in a turn: the hint says it runs after the current turn");
        browser.compose("@fable /steer also mention the parser fix");
        browser.waitFor("/steer is gone");
        planReads("/steer is gone", ["/steer"], "a /steer message");
        if (browser.eval<boolean>("() => [...document.querySelectorAll('.composer-toolbar button.primary')].every((b) => b.disabled)") !== true) fail("Send is not disabled for a /steer message");
        browser.compose("/hold write it later");
        browser.waitFor("/hold is gone");
        if (browser.eval<boolean>("() => [...document.querySelectorAll('.composer-toolbar button.primary')].every((b) => b.disabled)") !== true) fail("Send is not disabled for a /hold message");
        log("  page: /steer and /hold refused before sending, each with its pill, Send disabled");
      },
    });
    // Its reply is a follow-up (H5), which wakes him after his running turn.
    await room.finish("worker", "Done looking.");

    // 17b. Sent from the composer: to the busy Consigliere a message goes into his running turn ("into the turn"); to him
    // idle it starts a turn of its own (no such tag). Both are ordinary msg: requests (M1).
    const rowSays = (body: string, words: string) =>
      browser.eval<boolean>(`() => [...document.querySelectorAll('.timeline .chat-row.from-user')].some((row) => row.textContent.includes(${JSON.stringify(body)}) && row.textContent.includes(${JSON.stringify(words)}))`);
    const sent = (body: string) => async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === body);
    browser.compose("Also mention the parser fix.");
    browser.send();
    await check.state("a message into the running turn", (x) => {
      const p = x.posts.find((q) => q.kind === "request" && q.author === "$user" && q.body === "Also mention the parser fix.");
      const run = p && x.runs.find((r) => r.reservedSeq < p.seq && r.inputs.includes(p.seq));
      return p && String(p.request.id).startsWith("msg:") && run ? `#${p.number} (${String(p.request.id).slice(0, 4)}) delivered by run ${run.id.slice(0, 8)} reserved at #${run.reservedSeq} (before it)` : null;
    }, ["into the turn"], {
      focus: (x) => x.posts.find((q) => q.kind === "request" && q.body === "Also mention the parser fix.")?.number,
      extra: () => {
        if (!rowSays("Also mention the parser fix.", "into the turn")) fail("the message's row does not say 'into the turn'");
        log("  page: the message's own row says into the turn");
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
      return p && String(p.request.id).startsWith("msg:") && run && run.reservedSeq > p.seq ? `#${p.number} delivered by run ${run.id.slice(0, 8)} reserved at #${run.reservedSeq} (after it)` : null;
    }, ["Please also tag v1.2."], {
      focus: (x) => x.posts.find((q) => q.kind === "request" && q.body === "Please also tag v1.2.")?.number,
      extra: () => {
        if (rowSays("Please also tag v1.2.", "into the turn")) fail("a message that started a turn of its own says 'into the turn'");
        log("  page: no 'into the turn' on it");
      },
    });
    if (browser.eval<string>("() => document.querySelector('textarea[aria-label=\"Message\"]')?.value ?? ''") !== "") fail("the composer kept a draft");
    // Sending closes the composer; Escape closes it should it still be open (it never leaves the room).
    if (browser.eval<boolean>("() => Boolean(document.querySelector('.composer-overlay'))")) browser.on("press", "Escape");
    await room.finish("fable", "Tagged v1.2.");
  }

  if (await section("the chat view with the Consigliere", { replay: () => replayChain({ typedInT3: true }) })) {
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
  }

  if (await section("Backroom's reseat checkpoint, not the user's message")) {
    // 18b. The Consigliere reseats the worker (L4b): Backroom's checkpoint request (its own since B1) and the handover are
    // Backroom's on the board, never the user's messages.
    browser.click(/tab "Board/);
    room.board("fable", "reseat", "worker");
    const checkpoint = await until("the reseat's checkpoint request", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.request.id.startsWith("reseat:") && p.request.owner === seat.worker));
    await check.state("Backroom's reseat checkpoint, not the user's message", (x) => {
      const p = x.posts.find((q) => q.id === checkpoint.id);
      return p && p.author === "$system" && p.request.returnTo === "$system" ? `#${p.number} request ${p.request.id.slice(0, 16)}… by $system: Backroom's` : null;
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
  }

  if (await section("the overview: a member working, then news")) {
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
  }

  if (await section("one message to two members, with its image", { place: () => browser.click(/button "Back to the overview"/) })) {
    // 20. A room without a Consigliere: one message to two members, with an image, is one message on the board.
    const second = await room.second("Rehearsal B", ["alpha", "beta"]);
    const image = await second.attach();
    const both = await service.command<{ messageId: string; requestIds: string[] }>({
      type: "message.create",
      roomId: second.roomId,
      sourceText: "@alpha @beta independently check the date tests",
      clientMessageId: randomUUID(),
      attachmentIds: [image],
      assignments: [{ recipients: [second.participant.alpha!, second.participant.beta!], instruction: "independently check the date tests" }],
    });
    browser.openRoom("Rehearsal B");
    const two = new Checks(second, browser, selection);
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
  }

  if (await section("the chat keeps his history after he is reseated", { replay: () => replayChain() })) {
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
  }

  if (await section("Talk to …: the first message is the Consigliere's request and his turn runs on it")) {
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
    const talked = new Checks({ snapshot: talkSnapshot }, browser, selection);
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
  }

  if (await section("the model picker: Antigravity's windows in two family rows, Claude's three meters whole")) {
    // 22b. The model picker's provider header (Providers.tsx, usageFamilies.ts): windows whose labels share a family
    // before " · " are one row, the family named once and its meters by their short labels; the tooltip keeps the whole
    // label. Antigravity reports four windows in two families, interleaved; Claude's three have no family and stay whole.
    const usage = check.begin("the model picker: Antigravity's windows in two family rows, Claude's three meters whole");
    const providers = await service.call<Array<{ instanceId: string; usageWindows: Array<{ id: string; label: string }> }>>("GET", "/api/t3/providers");
    const reported = providers.find((p) => p.instanceId === "antigravity")?.usageWindows.map((w) => w.id).join(", ");
    if (reported !== "3p-5h, gemini-5h, 3p-weekly, gemini-weekly") fail(`the fake T3 reports Antigravity's windows as ${reported}`);
    log(`  api: Antigravity reports ${reported}`);
    type Head = { account: number; families: Array<{ name: string; top: number; lines: number; meters: Array<{ shown: string; title: string; aria: string }> }>; lone: string[]; rows: number };
    const head = `() => {
      const h = document.querySelector('.model-section-head');
      if (!h) return null;
      // Lines as the children's middles (each line is centred), apart by more than a few pixels.
      const lines = (children) => {
        const middles = children.map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }).sort((a, b) => a - b);
        return middles.filter((m, i) => i === 0 || m - middles[i - 1] > 4).length;
      };
      const tops = (el) => lines([...el.children]);
      const families = [...h.querySelectorAll('.usage-family')].map((f) => ({
        name: f.querySelector('.usage-family-name')?.textContent ?? '',
        top: Math.round(f.getBoundingClientRect().top),
        lines: tops(f),
        meters: [...f.querySelectorAll('.usage-meter')].map((m) => ({ shown: m.querySelector('.usage-label')?.textContent ?? '', title: m.getAttribute('title') ?? '', aria: m.getAttribute('aria-label') ?? '' })),
      }));
      const line = h.querySelector('.provider-line');
      const lone = [...line.querySelectorAll(':scope > .usage-meter')];
      const rows = lines([...line.querySelectorAll(':scope > *')]);
      return { account: line.querySelector('.provider-auth') ? 1 : 0, families, lone: lone.map((m) => m.querySelector('.usage-label')?.textContent ?? ''), rows };
    }`;
    const openPicker = () => {
      browser.click(/button "New crew member"/);
      browser.waitFor("Add to crew");
      browser.poll<boolean>("the crew member's model button", "() => Boolean(document.querySelector('.dialog .model-trigger:not(:disabled)'))", (ready) => ready);
      browser.click(/button "[^"]*" expandable haspopup="dialog"/);
      browser.poll<boolean>("the model picker to open", "() => Boolean(document.querySelector('.model-menu .model-rail'))", (open) => open);
    };
    const showProvider = (name: string) => {
      browser.click(new RegExp(`button "${name}" description="${name}"`));
      browser.poll<string | null>(`the picker on ${name}`, "() => document.querySelector('.model-list')?.getAttribute('aria-label') ?? null", (shown) => shown === name);
    };
    const families = (look: string) => {
      const read = browser.poll<Head | null>(`Antigravity's header in the ${look} look`, head, (h) => Boolean(h && h.families.length === 2));
      const h = read!;
      const names = h.families.map((f) => f.name);
      if (names.join(" | ") !== "Claude & GPT (shared) | Gemini") fail(`the family rows are ${JSON.stringify(names)}`);
      for (const f of h.families) {
        if (f.meters.map((m) => m.shown).join(" | ") !== "5-hour | Weekly") fail(`${f.name}'s meters are labelled ${JSON.stringify(f.meters.map((m) => m.shown))}`);
        for (const m of f.meters) {
          if (!m.title.startsWith(`${f.name} · ${m.shown} `) || m.aria !== m.title) fail(`${f.name}'s ${m.shown} meter lost its whole label: title ${JSON.stringify(m.title)}, aria-label ${JSON.stringify(m.aria)}`);
        }
        if (f.lines !== 1) fail(`${f.name}'s row takes ${f.lines} lines in the ${look} look`);
      }
      if (h.lone.length > 0) fail(`Antigravity's header has meters outside a family: ${JSON.stringify(h.lone)}`);
      if (h.rows !== 3) fail(`Antigravity's header takes ${h.rows} rows in the ${look} look, not the account line and two families`);
      log(`  page (${look}): the account line, then ${h.families.map((f) => `${f.name}: ${f.meters.map((m) => m.shown).join(", ")}`).join("; ")}, each on one line; the tooltips name the whole window (${JSON.stringify(h.families[1]!.meters[1]!.title)})`);
    };
    const claudeWhole = (look: string) => {
      const h = browser.poll<Head | null>(`Claude's header in the ${look} look`, head, (x) => Boolean(x && x.lone.length === 3))!;
      if (h.families.length > 0 || h.lone.join(" | ") !== "Session | Weekly | Weekly · Fable") fail(`Claude's header changed: families ${JSON.stringify(h.families.map((f) => f.name))}, meters ${JSON.stringify(h.lone)}`);
      log(`  page (${look}): Claude's three meters whole: ${h.lone.join(", ")}`);
    };
    const closePicker = () => {
      browser.on("press", "Escape");
      browser.poll<boolean>("the model picker to close", "() => !document.querySelector('.model-menu')", (closed) => closed);
      browser.click(/button "Cancel"/);
      browser.poll<boolean>("the New crew member dialog to close", "() => !document.querySelector('.dialog')", (closed) => closed);
    };

    browser.click(/button "Back to the overview"/);
    openPicker();
    showProvider("Antigravity");
    families("plain");
    browser.screenshot("the-model-picker-antigravity-two-family-rows");
    showProvider("Claude");
    claudeWhole("plain");
    browser.screenshot("the-model-picker-claude-three-meters-whole");
    closePicker();

    // The pixel look, the user's (#233): its monospace is wider, and each family still fits on one line.
    browser.on("eval", "() => { localStorage.setItem('backroom.skin', 'pixel'); return true; }");
    browser.on("reload");
    await until("the pixel look", () => browser.eval<string>("() => document.documentElement.dataset.skin ?? ''") === "pixel");
    browser.waitFor("New crew member");
    openPicker();
    showProvider("Antigravity");
    families("pixel");
    browser.screenshot("the-model-picker-antigravity-in-the-pixel-look");
    showProvider("Claude");
    claudeWhole("pixel");
    closePicker();
    browser.on("eval", "() => { localStorage.removeItem('backroom.skin'); return true; }");
    browser.on("reload");
    await until("the plain look", () => browser.eval<string>("() => document.documentElement.dataset.skin ?? ''") !== "pixel");
    browser.consoleClean();
    browser.openRoom(room.title);
    check.pass(usage);
  }

  // 23. A1: a room created from the page in a project whose folder has no AGENTS.md: Backroom writes it, out of git.
  if (await section("a room created in a project without AGENTS.md: written, kept out of git, the worktree hook installed, said in a toast")) {
    check.passed.push(...(await rehearseAgentsFile(service, browser, room, selection)));
  }

  // 24. A project's browsers for its new rooms, set on its section of the overview (its section opens in the function).
  check.passed.push(...(await rehearseProjectBrowsers(service, browser, room, selection, section)));

  membersOnlyAnswer(await room.snapshot());
  oldTablesAbsent(room.dataDir);
  return check.passed;
}

/**
 * A1, the agents file (src/app/agentsFile.ts), on a scratch project: a git repository with one commit in this run's
 * own data folder (deleted with it by the next run), added to the fake T3. A room created from the overview's + writes
 * AGENTS.md and a CLAUDE.md importing it, keeps them out of git in the repository's .git/info/exclude, installs the
 * post-checkout hook, opens at once and says so in a toast; a worktree added then holds the two files, copied by the hook.
 */
/**
 * As Checks.state, for states that read the service through a probe of their own rather than a room's snapshot: a state
 * --only does not name is set up silently (the service polled, the texts waited for). Each state passed goes in `passed`.
 */
function probedStates(browser: Browser, selection: Selection, passed: string[]) {
  return async (name: string, probe: () => Promise<string | null>, page: string[], extra?: () => void): Promise<void> => {
    const { index, loud } = selection.enter(name);
    log(`${loud ? "CHECK" : "SET UP (silently)"} ${selection.label(index)}`);
    log(`  api: ${await until(`the service to show: ${name}`, probe)}`);
    for (const text of page) browser.waitFor(text);
    if (!loud) return;
    extra?.();
    browser.consoleClean();
    browser.screenshot(name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase());
    passed.push(name);
    log(`PASS ${name}`);
  };
}

async function rehearseAgentsFile(service: Service, browser: Browser, room: Room, selection: Selection): Promise<string[]> {
  const passed: string[] = [];
  const state = probedStates(browser, selection, passed);
  const folder = join(room.dataDir, "agents-project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "scratch", scripts: { test: "node --test" } }, null, 2)}\n`);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  git(folder, "config", "user.name", "Rehearsal");
  git(folder, "config", "user.email", "rehearsal@example.com");
  git(folder, "config", "commit.gpgsign", "false");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "First commit");
  const title = "agents-scratch";
  await service.command<{ projectId: string }>({ type: "project.create", workspaceRoot: folder, title });
  const sheetTitle = "() => document.querySelector('.sheet-title h1')?.textContent ?? null";

  browser.click(/button "Back to the overview"/);
  browser.waitFor(title);
  browser.click(new RegExp(`button "New room in ${title}"`));
  browser.waitFor("Create room");
  // The dialog fills the title with the project's name once it has read the projects, and only then takes Create room.
  browser.poll<boolean>(
    "the new room dialog to be ready",
    `() => { const form = document.getElementById('new-room-form'); return Boolean(form && form.querySelector('input[type="text"]')?.value === ${JSON.stringify(title)} && !form.querySelector('button[type="submit"]')?.disabled); }`,
    (ready) => ready,
  );
  browser.click(/button "Create room"/);
  await state(
    "a room created in a project without AGENTS.md: written, kept out of git, the worktree hook installed, said in a toast",
    async () => {
      if (!existsSync(join(folder, "AGENTS.md")) || !existsSync(join(folder, ".git", "hooks", "post-checkout"))) return null;
      if (readFileSync(join(folder, "CLAUDE.md"), "utf8") !== "@AGENTS.md\n") fail("CLAUDE.md is not the one line importing AGENTS.md");
      if (!readFileSync(join(folder, "AGENTS.md"), "utf8").includes("`npm run test`")) fail("AGENTS.md does not name the project's check");
      const exclude = readFileSync(join(folder, ".git", "info", "exclude"), "utf8");
      if (!/^# >>> Backroom agents file.*\n\/AGENTS\.md\n\/CLAUDE\.md\n# <<< Backroom agents file$/m.test(exclude)) fail(`.git/info/exclude: ${JSON.stringify(exclude)}`);
      const status = git(folder, "status", "--porcelain", "--untracked-files=all").trim();
      if (status !== "") fail(`git status should show nothing, the files kept out of git: ${JSON.stringify(status)}`);
      if (existsSync(join(folder, ".gitignore"))) fail("a .gitignore was written");
      const hook = join(folder, ".git", "hooks", "post-checkout");
      if (!readFileSync(hook, "utf8").includes("Installed by Backroom (A1)")) fail("the post-checkout hook is not Backroom's");
      if ((statSync(hook).mode & 0o111) === 0) fail("the post-checkout hook cannot run");
      if (git(folder, "log", "--oneline").trim().split("\n").length !== 1) fail("something was committed");
      return `AGENTS.md and CLAUDE.md written in ${folder}; git status clean (both in .git/info/exclude's Backroom block); .git/hooks/post-checkout is Backroom's and runs; nothing committed`;
    },
    ["Backroom wrote AGENTS.md and CLAUDE.md"],
    () => {
      browser.poll<string | null>("the room to open at once, with no question", sheetTitle, (t) => t === title);
      log("  page: the room opened at once, and the toast says what was written");
    },
  );
  const worktree = join(room.dataDir, "agents-worktree");
  git(folder, "worktree", "add", "-q", "-b", "feature", worktree);
  await state(
    "a worktree added to the project holds the two files, copied by the hook",
    async () => {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        if (!existsSync(join(worktree, name))) fail(`${name} is not in the new worktree`);
        if (readFileSync(join(worktree, name), "utf8") !== readFileSync(join(folder, name), "utf8")) fail(`${name} in the worktree differs from the main checkout's`);
      }
      const status = git(worktree, "status", "--porcelain", "--untracked-files=all").trim();
      if (status !== "") fail(`the worktree's git status: ${JSON.stringify(status)}`);
      return `${worktree} holds AGENTS.md and CLAUDE.md as the main checkout has them; its git status is clean`;
    },
    [],
  );
  return passed;
}

/**
 * A project's browsers for its new rooms (board #74, #123), on a scratch project of its own: the globe on its section of
 * the overview opens a room's choices; turned on there, with "preview" ticked alone and made the default, the project
 * reads that back (GET /api/t3/projects), the globe says it, Esc gives the focus back to the globe, and a reload keeps
 * it. A room made from the section's + then opens with browsers on and "preview" its default, as the API and the room's
 * own Browser button say. Its section begins here, before its states.
 */
async function rehearseProjectBrowsers(service: Service, browser: Browser, room: Room, selection: Selection, section: (first: string) => Promise<boolean>): Promise<string[]> {
  const passed: string[] = [];
  if (!(await section("a project's browsers for new rooms, set on its section: on, preview alone and its default, read back"))) return passed;
  const state = probedStates(browser, selection, passed);
  const folder = join(room.dataDir, "browsers-project");
  mkdirSync(folder, { recursive: true });
  const title = "browsers-scratch";
  const { projectId } = await service.command<{ projectId: string }>({ type: "project.create", workspaceRoot: folder, title });
  const preview = (await service.command<{ browserId: string }>({ type: "browser.create", name: "preview", description: "The preview deploy, logged in as the test user." })).browserId;
  const setting = async () => (await service.call<Array<{ id: string; browsers: { enabled: boolean; defaultBrowserId: string | null; allowedBrowserIds: string[] | null } | null }>>("GET", "/api/t3/projects")).find((p) => p.id === projectId)?.browsers;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const globe = (words: string) => new RegExp(`button "Browsers for new rooms in ${escaped}: ${words}`);
  const globeRead = `() => { const b = document.querySelector('[data-nav-key="head:project-browsers:${projectId}"]'); return b ? { label: b.getAttribute('aria-label'), checked: Boolean(b.querySelector('.globe-check')), focused: document.activeElement === b } : null; }`;
  type GlobeRead = { label: string; checked: boolean; focused: boolean } | null;
  const boxes = `() => [...document.querySelectorAll('.project-browsers-panel .browser-choice')].map((card) => ({
    name: card.querySelector('.browser-choice-head .mono')?.textContent ?? '',
    ticked: card.querySelector('input[type=checkbox]')?.checked === true,
    isDefault: [...card.querySelectorAll('.browser-choice-head .pill')].some((pill) => pill.textContent === 'default'),
  }))`;
  const boxOf = (name: string) => `() => { const card = [...document.querySelectorAll('.project-browsers-panel .browser-choice')].find((c) => c.querySelector('.browser-choice-head .mono')?.textContent === ${JSON.stringify(name)}); return card ?? null; }`;
  const press = (name: string, what: "checkbox" | "make default") =>
    browser.on("eval", `() => { const card = (${boxOf(name)})(); const el = ${what === "checkbox" ? "card?.querySelector('input[type=checkbox]')" : "[...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'make default')"}; el?.click(); return Boolean(el); }`);

  browser.click(/button "Back to the overview"/);
  browser.waitFor(title);
  // A new project has no setting (null; a service without project settings has no field at all, the globe fails below).
  if ((await setting()) ?? null) fail("a new project has a browser setting before any is chosen");
  browser.click(globe("off \\(no setting\\)"));
  browser.waitFor("New rooms start with browsers on");
  browser.click(/checkbox "New rooms start with browsers on/);
  await until("the project's setting to be on", async () => (await setting())?.enabled === true);
  browser.poll("preview's box to offer make default", `() => Boolean([...((${boxOf("preview")})()?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'make default' && !b.disabled))`, (v) => v === true);
  press("preview", "make default");
  await until("preview to be the project's default", async () => (await setting())?.defaultBrowserId === preview);
  browser.poll("general's box to be enabled", `() => (${boxOf("general")})()?.querySelector('input[type=checkbox]')?.disabled === false`, (v) => v === true);
  press("general", "checkbox");
  await state(
    "a project's browsers for new rooms, set on its section: on, preview alone and its default, read back",
    async () => {
      const read = await setting();
      return read?.enabled && read.defaultBrowserId === preview && JSON.stringify(read.allowedBrowserIds) === JSON.stringify([preview])
        ? `GET /api/t3/projects: ${title} browsers on, default preview, allowed [preview]`
        : null;
    },
    ["Browsers its new rooms can use"],
    () => {
      browser.poll<Array<{ name: string; ticked: boolean; isDefault: boolean }>>("the dialog's boxes: preview ticked and the default, general unticked", boxes, (read) =>
        read.some((b) => b.name === "preview" && b.ticked && b.isDefault) && read.some((b) => b.name === "general" && !b.ticked && !b.isDefault),
      );
      browser.poll<GlobeRead>("the globe to say on, default preview, with its check", globeRead, (g) => g?.label === `Browsers for new rooms in ${title}: on · default "preview"` && g.checked);
      log("  page: the dialog shows preview ticked and the default, general a plain unticked box; the globe says on · default \"preview\" with its check");
    },
  );
  // Esc is the story's (a state played silently skips its checks, and the dialog must close for what follows).
  browser.on("press", "Escape");
  await state(
    "Esc closes the project's browsers and gives the focus back to its globe; a reload keeps the setting",
    async () => ((await setting())?.enabled ? "the project's setting is still on" : null),
    [],
    () => {
      browser.poll<GlobeRead>("the dialog closed, the focus back on the globe", `() => document.querySelector('.project-browsers-panel') ? null : (${globeRead})()`, (g) => Boolean(g?.focused));
      log("  page: Esc closed the dialog and the focus is back on the globe");
      browser.on("reload");
      browser.poll<GlobeRead>("the globe after a reload", globeRead, (g) => g?.label === `Browsers for new rooms in ${title}: on · default "preview"` && g.checked);
      log("  page: after a reload the globe still says on · default \"preview\"");
    },
  );
  browser.click(new RegExp(`button "New room in ${escaped}"`));
  browser.waitFor("Create room");
  browser.poll<boolean>(
    "the new room dialog to be ready, saying the project gives browsers",
    `() => { const form = document.getElementById('new-room-form'); return Boolean(form && form.querySelector('input[type="text"]')?.value === ${JSON.stringify(title)} && form.querySelector('.new-room-browsers') && !form.querySelector('button[type="submit"]')?.disabled); }`,
    (ready) => ready,
  );
  browser.click(/button "Create room"/);
  await state(
    "a room made from the project's + starts with its browsers: on, preview its default",
    async () => {
      const made = (await service.call<Array<{ id: string; title: string; projectId: string }>>("GET", "/api/rooms")).find((r) => r.projectId === projectId);
      if (!made) return null;
      const x = await service.call<Snapshot>("GET", `/api/rooms/${made.id}`);
      return x.room.browserEnabled && JSON.stringify(x.room.allowedBrowserIds) === JSON.stringify([preview]) && x.browser?.browser.name === "preview"
        ? `room ${made.id.slice(0, 8)}: browsers on, default preview, allowed [preview], as the project's setting`
        : null;
    },
    [],
    () => {
      browser.poll<string | null>("the room to open", "() => document.querySelector('.sheet-title h1')?.textContent ?? null", (t) => t === title);
      browser.poll<string | null>("the room's Browser button to say on, preview the default", "() => document.querySelector('.room-browser-button')?.getAttribute('aria-label') ?? null", (label) => Boolean(label?.startsWith("Browser: on for this room's agents · preview (default)")));
      log("  page: the room opened with its Browser button on, preview (default)");
    },
  );
  // Clear setting removes the button that has the focus: the focus goes to the toggle, not the page's body (review #479).
  // From the room just made (open by now also when state 42 was played silently).
  browser.poll<string | null>("the new room to be open", "() => document.querySelector('.sheet-title h1')?.textContent ?? null", (t) => t === title);
  browser.click(/button "Back to the overview"/);
  browser.click(globe('on · default "preview"'));
  browser.waitFor("Clear setting");
  browser.click(/button "Clear setting"/);
  const toggleRead = `() => { const box = document.querySelector('.project-browsers-panel input[type=checkbox]'); const active = document.activeElement; return { focused: Boolean(box) && active === box, checked: box?.checked ?? null, clear: [...document.querySelectorAll('.project-browsers-panel button')].some((b) => b.textContent === 'Clear setting'), active: active ? active.tagName + (active.getAttribute('aria-label') ? ' ' + active.getAttribute('aria-label') : '') : null }; }`;
  type ToggleRead = { focused: boolean; checked: boolean | null; clear: boolean; active: string | null };
  await state(
    "Clear setting: the project has no setting again, and the focus is on the toggle",
    async () => ((await setting()) === null ? `GET /api/t3/projects: ${title} browsers null (no setting)` : null),
    ["No setting yet"],
    () => {
      browser.poll<ToggleRead>("the toggle off and focused, Clear setting gone", toggleRead, (v) => v.focused && v.checked === false && !v.clear);
      log("  page: Clear setting is gone, the toggle is off and has the focus");
      browser.on("press", "Escape");
      browser.poll<GlobeRead>("the globe to say off (no setting), the focus back on it", globeRead, (g) => g?.label === `Browsers for new rooms in ${title}: off (no setting)` && !g.checked && g.focused);
      log("  page: Esc closed the dialog; the globe says off (no setting) and has the focus");
    },
  );
  return passed;
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

// ---------------- B3: the Browser panel of a room that may use two browsers (--step room) ----------------

/** What the panel draws for one browser's box, read from the page. */
interface BrowserCard {
  name: string;
  ticked: boolean;
  isDefault: boolean;
  status: string | null;
  power: string | null;
  powerName: string | null;
  watch: string | null;
  watchText: string | null;
  watchName: string | null;
  copy: boolean;
  copyText: string | null;
  copyName: string | null;
  agents: string | null;
  tabs: string[];
}

const BROWSER_CARDS = `() => [...document.querySelectorAll('.browser-panel .browser-choice')].map((card) => ({
  name: card.querySelector('.browser-choice-head .mono')?.textContent ?? '',
  ticked: card.querySelector('input[type=checkbox]')?.checked === true,
  isDefault: [...card.querySelectorAll('.browser-choice-head .pill')].some((pill) => pill.textContent === 'default'),
  status: card.querySelector('.browser-state')?.textContent ?? null,
  power: card.querySelector('.browser-status button')?.textContent ?? null,
  powerName: card.querySelector('.browser-status button')?.getAttribute('aria-label') ?? null,
  watch: card.querySelector('.browser-row a')?.href ?? null,
  watchText: card.querySelector('.browser-row a')?.textContent ?? null,
  watchName: card.querySelector('.browser-row a')?.getAttribute('aria-label') ?? null,
  copy: Boolean(card.querySelector('.browser-row button[aria-label^="Copy"]')),
  copyText: card.querySelector('.browser-row button')?.textContent ?? null,
  copyName: card.querySelector('.browser-row button')?.getAttribute('aria-label') ?? null,
  agents: card.querySelector('.browser-row code')?.textContent ?? null,
  tabs: [...card.querySelectorAll('.browser-tabs li')].map((li) => li.title),
}))`;

/** The room header's Browser button: what it says and the number beside the globe. */
const BROWSER_BUTTON = `() => {
  const button = document.querySelector('.room-browser-button');
  const badge = button?.querySelector('.globe-badge');
  const count = button?.querySelector('.panel-count');
  return {
    label: button?.getAttribute('aria-label') ?? null,
    count: count?.textContent ?? null,
    covered: Boolean(badge && count && count.getBoundingClientRect().left < badge.getBoundingClientRect().right - 0.5),
  };
}`;
type BrowserButtonRead = { label: string | null; count: string | null; covered: boolean };

/**
 * The colour a state word should have (the CSS variable the look colours running with: --ok in the plain look,
 * --px-st-new in the pixel look), as the page computes it, and each state word in the panel with its colour and, where
 * the look draws one, the square before it.
 */
const stateColours = (variable: string) => `() => {
  const probe = document.createElement('span');
  probe.style.color = 'var(${variable})';
  document.body.append(probe);
  const want = getComputedStyle(probe).color;
  probe.remove();
  return {
    want,
    states: [...document.querySelectorAll('.browser-panel .browser-state')].map((word) => {
      const square = getComputedStyle(word, '::before');
      return { text: word.textContent, color: getComputedStyle(word).color, square: square.content === 'none' || square.content === 'normal' ? null : { background: square.backgroundColor, width: square.width } };
    }),
  };
}`;
type StateColours = { want: string; states: Array<{ text: string; color: string; square: { background: string; width: string } | null }> };

interface BrowserApi {
  id: string;
  name: string;
  status: { state: string; mode: string | null; cdpUrl: string | null; watchHost: string | null; watchPort: number | null; watchPath: string | null; tabs: Array<{ url: string }> };
}

/**
 * B3 (the user's report, board #530): a room that may use two browsers shows both in its Browser panel, each with its
 * status, Start or Stop, Watch link and Copy, DevTools address and tabs, the default marked; the browser it may not use is
 * a plain line. The browsers are real Chromes on virtual screens (the service's own mode here) started through the API;
 * their ports and displays are the browser layer's to pick, free and kept by no other Backroom, and the state checks that
 * each is recorded as this rehearsal's in the folder all Backrooms share (so two rehearsals at once never share one);
 * they get tabs over DevTools and are stopped again at the end, whatever happens. Each state reads the panel's boxes and
 * the room header's Browser button (its count and its words speak for every browser the room may use) from the page and
 * compares them with GET /api/browsers; the Watch link, Copy and Start or Stop are named with the words they show and the
 * browser they are for; running is drawn in the look's green, and in the pixel look with a filled square (off: a hollow
 * one); a tab opened in the second browser with the panel closed must reach the room's stream and the button; the
 * panel's own Stop, Start and checkbox are pressed as the user would.
 */
async function rehearseBrowserPanel(service: Service, browser: Browser, room: Room, check: Checks): Promise<void> {
  const staging = (await service.command<{ browserId: string }>({ type: "browser.create", name: "staging", description: "Staging site, logged in as the test admin." })).browserId;
  const scratch = (await service.command<{ browserId: string }>({ type: "browser.create", name: "scratch", description: "Throwaway browsing." })).browserId;
  const ids = ["general", staging];
  const listed = () => service.call<BrowserApi[]>("GET", "/api/browsers");
  const stopAll = async () => {
    for (const id of ids) await service.call("POST", `/api/browsers/${id}/stop`).catch(() => undefined);
  };
  /** The boxes the page draws against what the API says, for the browsers named: ticked ones in full, the rest a plain line. */
  const mismatch = (cards: BrowserCard[], api: BrowserApi[], want: { ticked: string[]; default: string }): string | null => {
    for (const b of api) {
      const card = cards.find((c) => c.name === b.name);
      if (!card) return `no box for ${b.name}`;
      const ticked = want.ticked.includes(b.name);
      if (card.ticked !== ticked) return `${b.name}: ticked ${card.ticked}, expected ${ticked}`;
      if (card.isDefault !== (b.name === want.default)) return `${b.name}: default mark ${card.isDefault}`;
      if (!ticked) {
        if (card.status || card.power || card.watch || card.agents || card.tabs.length > 0) return `${b.name} is not ticked and shows a process: ${JSON.stringify(card)}`;
        continue;
      }
      const s = b.status;
      // An accessible name holds the words the control shows and the browser it is for (label in name).
      const named = (what: string, name: string | null, shown: string | null): string | null =>
        name && shown && name.toLowerCase().includes(shown.replace(/…/g, "").trim().toLowerCase()) && name.includes(b.name) ? null : `${b.name}: the ${what} shows ${JSON.stringify(shown)} but is named ${JSON.stringify(name)}`;
      if (s.state !== "running") {
        if (card.status !== "off" || card.power !== "Start" || card.watch || card.agents || card.tabs.length > 0) return `${b.name} is ${s.state}: ${JSON.stringify(card)}`;
        const power = named("Start button", card.powerName, card.power);
        if (power) return power;
        continue;
      }
      const labels = named("Watch link", card.watchName, card.watchText) ?? named("Copy button", card.copyName, card.copyText) ?? named("Stop button", card.powerName, card.power);
      if (labels) return labels;
      const watch = `http://${s.watchHost}:${s.watchPort}${s.watchPath}`;
      if (card.status !== "running · virtual screen") return `${b.name}: status ${JSON.stringify(card.status)}`;
      if (card.power !== "Stop") return `${b.name}: power button ${JSON.stringify(card.power)}`;
      if (card.watch !== watch) return `${b.name}: watch link ${card.watch}, API ${watch}`;
      if (!card.copy) return `${b.name}: no Copy for the watch link`;
      if (card.agents !== s.cdpUrl) return `${b.name}: DevTools address ${card.agents}, API ${s.cdpUrl}`;
      const tabs = s.tabs.slice(0, 5).map((tab) => tab.url);
      if (JSON.stringify(card.tabs) !== JSON.stringify(tabs)) return `${b.name}: tabs ${JSON.stringify(card.tabs)}, API ${JSON.stringify(tabs)}`;
    }
    return null;
  };
  /** The header's button against the API: a line per ticked browser, in the list's order, and the tabs of the running ones added up. */
  const buttonMismatch = (read: BrowserButtonRead, api: BrowserApi[], want: { ticked: string[]; default: string }): string | null => {
    const shown = api.filter((b) => want.ticked.includes(b.name));
    const tabs = (b: BrowserApi) => (b.status.state === "running" ? b.status.tabs.length : 0);
    const line = (b: BrowserApi) => `${b.name}${b.name === want.default ? " (default)" : ""} ${b.status.state === "running" ? "running" : "off"}${tabs(b) > 0 ? `, ${tabs(b)} tab${tabs(b) === 1 ? "" : "s"}` : ""}`;
    const label = `Browser: on for this room's agents · ${shown.map(line).join("; ")}`;
    const total = shown.reduce((n, b) => n + tabs(b), 0);
    if (read.label !== label) return `the Browser button says ${JSON.stringify(read.label)}, the API ${JSON.stringify(label)}`;
    if ((read.count ?? "0") !== String(total)) return `the Browser button counts ${read.count ?? "nothing"}, the API ${total}`;
    if (read.covered) return "the Browser button's count sits under the globe's badge";
    return null;
  };
  /**
   * Until the page agrees with the API: the header's button always, the panel's boxes while it is open (the panel reads
   * the API every four seconds; the service looks at tabs every five and tells the room).
   */
  const agree = async (what: string, want: { ticked: string[]; default: string }, options: { panel?: boolean } = {}): Promise<{ cards: BrowserCard[]; api: BrowserApi[] }> => {
    const end = Date.now() + 40_000;
    let last = "";
    for (;;) {
      const api = await listed();
      const cards = options.panel === false ? [] : browser.eval<BrowserCard[]>(BROWSER_CARDS);
      const found = (options.panel === false ? null : mismatch(cards, api, want)) ?? buttonMismatch(browser.eval<BrowserButtonRead>(BROWSER_BUTTON), api, want);
      if (found === null) return { cards, api };
      last = found;
      if (Date.now() > end) fail(`the Browser panel, ${what}: ${last}`);
      await sleep(700);
    }
  };
  /** The panel's own scroll, to its end (staging's box and the hints) or back to its top, for a screenshot of each half. */
  const scrollPanel = (to: "end" | "top") => browser.on("eval", `() => { const body = document.querySelector('.inspector .queue-body'); body.scrollTop = ${to === "end" ? "body.scrollHeight" : "0"}; return true; }`);
  /**
   * Running reads as running by colour in both looks: the word in the look's green (--ok, --px-st-new in the pixel look),
   * and in the pixel look a filled square of it before the word; a browser that is off has neither.
   */
  const checkColours = (look: "plain" | "pixel", expect: { running: number; off: number }) => {
    const read = browser.eval<StateColours>(stateColours(look === "pixel" ? "--px-st-new" : "--ok"));
    const running = read.states.filter((word) => word.text.startsWith("running"));
    const off = read.states.filter((word) => word.text === "off");
    if (running.length !== expect.running || off.length !== expect.off) fail(`${look} look: ${running.length} running and ${off.length} off state words, expected ${expect.running} and ${expect.off}: ${JSON.stringify(read.states)}`);
    for (const word of running) {
      if (word.color !== read.want) fail(`${look} look: "${word.text}" is ${word.color}, not the look's green ${read.want}`);
      if (look === "pixel" && (word.square?.background !== read.want || word.square.width !== "6px")) fail(`${look} look: "${word.text}" has no filled square of the green before it: ${JSON.stringify(word.square)}`);
    }
    for (const word of off) {
      if (word.color === read.want) fail(`${look} look: "off" is drawn in the running colour ${read.want}`);
      if (look === "pixel" && (word.square?.background !== "rgba(0, 0, 0, 0)" || word.square.width !== "6px")) fail(`${look} look: "off" does not have a hollow square before it: ${JSON.stringify(word.square)}`);
    }
    log(`  page: ${look} look: ${running.length} running in ${read.want}${look === "pixel" ? " with a filled square" : ""}, ${off.length} off in another colour${look === "pixel" ? " with a hollow one" : ""}`);
  };
  const openPanel = () => {
    if (!browser.eval<boolean>("() => Boolean(document.querySelector('.browser-panel'))")) browser.click(/button "Browser: on for this room's agents/);
    browser.poll<number>("the Browser panel's boxes", "() => document.querySelectorAll('.browser-panel .browser-choice').length", (n) => n === 3);
  };
  const reachDefault = async (name: string): Promise<void> => {
    await until(`the room's default browser to be ${name}`, async () => (await room.snapshot()).browser?.browser.name === name);
  };

  // The room's stream as the page has it (GET /api/rooms/:id/stream): how many room.changed events it has carried.
  const listener = new AbortController();
  let carried = 0;
  const changes = () => carried;
  void (async () => {
    try {
      const response = await fetch(`${service.base}/api/rooms/${room.roomId}/stream`, { signal: listener.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
        const events = text.split("\n\n");
        text = events.pop() ?? "";
        carried += events.filter((event) => event.split("\n").includes("event: room.changed")).length;
      }
    } catch {
      // aborted at the end
    }
  })();

  try {
    // The room may use general (its default) and staging; scratch stays unticked.
    await service.command({ type: "room.browser", roomId: room.roomId, enabled: true, allowed: ["general", staging], browserId: "general" });
    // One after the other, as a person presses Start: two starts at once may pick the same virtual display.
    const started: Array<BrowserApi["status"] & { cdpPort: number }> = [];
    for (const id of ids) started.push(await service.call<BrowserApi["status"] & { cdpPort: number }>("POST", `/api/browsers/${id}/start`));
    started.forEach((status, index) => {
      if (status.mode !== "vnc") fail(`this step needs browsers on virtual screens (Xvfb, x11vnc, websockify, noVNC); ${ids[index]} runs as ${status.mode}`);
    });
    // Ports and displays are the machine's. The browser layer picks ones that are free and that no other Backroom keeps,
    // and records them in the folder every Backroom shares (ROOMS_BROWSER_PORTS_DIR, src/browser/ports.ts), so rehearsals
    // running at once, whatever their service ports, never share one: nothing is chosen here, only checked.
    const owner = resolve(room.dataDir, "browsers");
    const portsDir = process.env.ROOMS_BROWSER_PORTS_DIR === "off" ? null : (process.env.ROOMS_BROWSER_PORTS_DIR ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "backroom", "browser-ports"));
    const kept = ids.map((id) => JSON.parse(readFileSync(join(owner, id, "ports.json"), "utf8")) as { cdp: number; vnc: number; web: number; display: number });
    const mine = kept.flatMap((k) => [k.cdp, k.vnc, k.web]);
    if (new Set(mine).size !== mine.length || kept[0]!.display === kept[1]!.display) fail(`the two browsers share a port or display: ${JSON.stringify(kept)}`);
    if (started.some((status, index) => status.cdpPort !== kept[index]!.cdp || status.watchPort !== kept[index]!.web)) fail(`the browsers run on other ports than they saved: ${JSON.stringify(kept)}`);
    if (portsDir) {
      const recorded = [...mine.map((port) => `port-${port}`), ...kept.map((k) => `display-${k.display}`)];
      const strangers = recorded.filter((file) => !existsSync(join(portsDir, file)) || readFileSync(join(portsDir, file), "utf8").trim() !== owner);
      if (strangers.length > 0) fail(`not recorded as this rehearsal's in ${portsDir}: ${strangers.join(", ")}`);
      log(`  ports: general ${kept[0]!.cdp}/${kept[0]!.vnc}/${kept[0]!.web} :${kept[0]!.display}, staging ${kept[1]!.cdp}/${kept[1]!.vnc}/${kept[1]!.web} :${kept[1]!.display}, each recorded as this rehearsal's in ${portsDir}`);
    } else {
      log("  ports: ROOMS_BROWSER_PORTS_DIR=off, so only this service's own are checked");
    }
    // Tabs, opened over DevTools as any program on the box may: two in general, one in staging, each beside its blank one.
    const open = async (cdpUrl: string, url: string) => {
      const response = await fetch(`${cdpUrl}/json/new?${url}`, { method: "PUT" });
      if (!response.ok) fail(`opening ${url} over DevTools: ${response.status}`);
    };
    await open(started[0]!.cdpUrl!, `${service.base}/`);
    await open(started[0]!.cdpUrl!, `${service.base}/api/status`);
    await open(started[1]!.cdpUrl!, `${service.base}/api/browsers`);
    await until("the service to list the three tabs", async () => {
      const api = await listed();
      const count = (name: string) => api.find((b) => b.name === name)?.status.tabs.length ?? 0;
      return count("general") === 3 && count("staging") === 2;
    }, 30_000);
    await reachDefault("general");

    // The page has the last room of the step open (the Talk to… one): back to the overview, then this room's card.
    browser.click(/button "Back to the overview"/);
    browser.openRoom(room.title);
    openPanel();
    const both = { ticked: ["general", "staging"], default: "general" };
    const first = await agree("both running", both);
    await check.state("the Browser panel with two browsers", (s) => {
      const allowed = s.room.allowedBrowserIds;
      return s.room.browserEnabled && allowed?.length === 2 && allowed.includes("general") && allowed.includes(staging) && !allowed.includes(scratch) && s.browser?.browser.name === "general"
        ? `browsers on; allowed general and staging (not scratch); the default is general, ${s.browser.status.state}`
        : null;
    }, ["running · virtual screen", "Open the browser screen", "Browsers they can use"]);
    log(`  page: general and staging each show running · virtual screen, Stop, Watch link with Copy, DevTools address, ${first.cards.filter((c) => c.ticked).map((c) => `${c.tabs.length} tab(s)`).join(" and ")}; scratch is a plain line`);
    checkColours("plain", { running: 2, off: 0 });
    if (!browser.eval<string>("() => document.querySelector('.browser-panel')?.textContent ?? ''").includes("Watch opens the browser's screen")) fail("the panel does not say once what Watch opens");
    scrollPanel("end");
    browser.screenshot("the-browser-panel-with-two-browsers-scrolled-to-staging");
    scrollPanel("top");
    log(`  page: the Browser button counts ${first.api.filter((b) => both.ticked.includes(b.name)).reduce((n, b) => n + b.status.tabs.length, 0)} tabs across general and staging, and says each one's state`);

    const panelControls = check.begin("the Browser panel: Stop, Start and the checkbox of a second browser from the panel");
    // A tab opened in staging, which is not the default, with the panel closed: the service tells the room (its stream
    // carries a room.changed, nothing else is going on in the room) and the button follows without waiting for a poll.
    browser.click(/button "Browser: on for this room's agents/);
    browser.poll<boolean>("the panel to close", "() => !document.querySelector('.browser-panel')", (closed) => closed === true);
    const before = changes();
    await open(started[1]!.cdpUrl!, `${service.base}/api/rooms`);
    await until("the room's stream to carry a room.changed for the tab opened in staging", () => changes() > before, 20_000);
    await agree("a tab opened in staging, the panel closed", both, { panel: false });
    log(`  page: a tab opened in staging (not the default) reached the room's stream and the Browser button, the panel closed`);
    browser.screenshot("the-browser-button-after-a-tab-in-staging");
    openPanel();
    await agree("the panel opened again", both);

    // Stop staging from the panel: it goes off, general stays.
    browser.click(/button "Stop staging"/);
    await until("staging to stop", async () => (await listed()).find((b) => b.id === staging)?.status.state === "stopped", 30_000);
    await agree("staging stopped from the panel", both);
    log("  page: staging stopped from the panel: off, Start, no Watch, no tabs; general still running");
    checkColours("plain", { running: 1, off: 1 });
    browser.screenshot("staging-stopped-from-the-panel");

    // Start it again from the panel.
    browser.click(/button "Start staging"/);
    await until("staging to run again", async () => (await listed()).find((b) => b.id === staging)?.status.state === "running", 40_000);
    await agree("staging started from the panel", both);
    log("  page: staging started from the panel: running again with its Watch link and tabs");

    // Untick staging: it becomes a plain line, general stays ticked and cannot be unticked (one stays).
    browser.click(/checkbox "staging"/);
    await until("staging unticked", async () => JSON.stringify((await room.snapshot()).room.allowedBrowserIds) === JSON.stringify(["general"]));
    const plain = await agree("staging unticked", { ticked: ["general"], default: "general" });
    if (plain.cards.find((c) => c.name === "general")?.power !== "Stop") fail("general lost its status when staging was unticked");
    log("  page: staging unticked: a plain line again; general keeps its status");
    browser.screenshot("staging-unticked-a-plain-line");
    browser.click(/checkbox "staging"/);
    await until("staging ticked again", async () => (await room.snapshot()).room.allowedBrowserIds?.length === 2);
    await agree("staging ticked again", both);
    check.pass(panelControls);

    // The pixel look draws the same boxes.
    const pixelPanel = check.begin("the Browser panel in the pixel look");
    browser.on("eval", "() => { localStorage.setItem('backroom.skin', 'pixel'); return true; }");
    browser.on("reload");
    // The page reopens the room it had open; if it did not, the overview is there and its card is pressed.
    const shown = browser.poll<string | null>("the page after the reload", "() => document.querySelector('.sheet-title h1')?.textContent ?? (document.querySelector('.ov-room-title') ? '' : null)", (t) => t !== null);
    if (shown !== room.title) browser.openRoom(room.title);
    await until("the pixel look", () => browser.eval<string>("() => document.documentElement.dataset.skin ?? ''") === "pixel");
    openPanel();
    await agree("in the pixel look", both);
    checkColours("pixel", { running: 2, off: 0 });
    browser.consoleClean();
    browser.screenshot("the-browser-panel-in-the-pixel-look");
    scrollPanel("end");
    browser.screenshot("the-browser-panel-in-the-pixel-look-scrolled-to-staging");
    // Staging off, in the pixel look too: its word and square differ from general's running ones.
    browser.click(/button "Stop staging"/);
    await until("staging to stop", async () => (await listed()).find((b) => b.id === staging)?.status.state === "stopped", 30_000);
    await agree("staging stopped in the pixel look", both);
    checkColours("pixel", { running: 1, off: 1 });
    browser.screenshot("the-browser-panel-in-the-pixel-look-staging-off");
    check.pass(pixelPanel);
    browser.on("eval", "() => { localStorage.removeItem('backroom.skin'); return true; }");
  } finally {
    listener.abort();
    await stopAll();
  }
}

// ---------------- the whole room (--step room, Z2; H5: relayed by the Consigliere) ----------------

async function rehearseRoom(service: Service, browser: Browser, room: Room, selection: Selection): Promise<string[]> {
  const check = new Checks(room, browser, selection);
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
  /**
   * A section of the story begins, named by its first state (scripts/rehearse-select.ts): false when a run jumps past it,
   * and the step stops here once the last state it plays is behind. A run that jumps into it starts from the room as
   * created, its board open (below): the setup checks that, and brings the page where the section starts (`place`).
   * In a run that jumped, a section has what the skipped sections made and it reads made through the API (`replay`, which
   * makes only what is missing: a later section may read what the one jumped into made too).
   */
  const section = async (first: string, setup: { replay?: () => Promise<void>; place?: () => void } = {}): Promise<boolean> => {
    selection.stopIfDone();
    const how = selection.section(first);
    if (how === "skip") return false;
    if (how === "jump") {
      log(`JUMP to the section of "${first}": its setup`);
      const x = await room.snapshot();
      const going = x.runs.filter((r) => r.phase !== "terminal");
      const unread = x.seats.filter((w) => w.unread > 0);
      if (going.length > 0 || x.requests.length > 0 || x.needsYou.length > 0 || x.nativeRequests.length > 0 || unread.length > 0) {
        fail(`a jump starts from the room as created, quiet; it has ${going.length} run(s) going, ${x.requests.length} open request(s), ${x.needsYou.length} needing you, ${x.nativeRequests.length} T3 request(s), ${unread.length} seat(s) with unread posts`);
      }
      browser.poll<{ title: string | null; view: string | null }>("the room's board, where a jump starts", "() => ({ title: document.querySelector('.sheet-title h1')?.textContent ?? null, view: document.querySelector('.timeline')?.getAttribute('aria-label') ?? null })", (v) => v.title === room.title && v.view === "Board", 5_000);
    }
    if (selection.jumps) await setup.replay?.();
    if (how === "jump") setup.place?.();
    return true;
  };
  /** A jump's replay of state 20's retire, unless it is done: the reviewer gone, so the room has the two members B1's retires count on. */
  const retireReviewer = async (): Promise<void> => {
    if ((await room.snapshot()).seats.find((w) => w.seatId === seat.reviewer)?.status === "retired") return;
    room.board("fable", "retire", "reviewer");
    await until("the reviewer's seat to retire", async () => (await room.snapshot()).seats.find((w) => w.seatId === seat.reviewer)?.status === "retired");
    await room.settle("fable");
    log("  replayed: @reviewer retired, two members left");
  };

  // Open the room as the user does: its card on the overview, then the board.
  browser.open();
  browser.openRoom(room.title);
  browser.click(/tab "Board/);
  browser.consoleClean();

  if (await section("the assignment, typed in the composer: his open request, his turn on it")) {
    // 1. The assignment: the user types it to the Consigliere in the composer; his turn runs on it.
    const assignment = "Get the date parser fixed and reviewed, then report.";
    browser.click(/button "(Write a message|Continue your draft)"/);
    browser.compose(assignment);
    browser.send();
    const ask = (await until("the user's message on the board", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.author === "$user" && p.body === assignment))).request.id as string;
    // Sending closes the composer; Escape closes it should it still be open (it never leaves the room).
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

    // 8. He passes it on with rooms-board correct while the worker's turn runs: it goes into that turn (M1), confirmed
    // once T3 shows the worker working after it; no turn of its own.
    room.board("fable", "correct", `#${A2}`, `Also refuse 30 February in every year (the user's #${C}).`);
    await check.state("the correction goes into the worker's running turn", (x) => {
      const relayed = x.posts.find((p) => p.kind === "correction" && p.author === seat.fable && p.about.some((r: any) => r.requestId === fix2));
      const w = runOf(x, "worker");
      return relayed && w?.id === findingRun.id && w.phase === "running" && w.inputs.includes(relayed.seq) && room.post(x, fix2).request.state === "open" && room.post(x, fix2).request.corrections === 1
        ? `#${relayed.number} @fable corrects #${A2}; delivered into @worker's running run ${w.id.slice(0, 8)} (no turn of its own); #${A2} open, corrected 1×`
        : null;
    }, [`@fable corrected #${A2}`], { show: A2 });

    // 9. Both turns run when the service is killed (SIGKILL) and started again: the worker's, with the correction in it,
    // and his on the user's message. T3 (the fake, kept in its file) still runs both meanwhile.
    const correctionRun = findingRun;
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
      // Silent too: every later state's console check counts on it.
      always: () => {
        const lines = browser.acceptOutage();
        log(`  page: ${lines.length} console line(s) from Chrome for requests it made while the service was down${lines.length ? `, e.g. ${lines[0]!.slice(0, 160)}` : ""}`);
      },
    });

    // 10. After the restart the worker's turn ends: imported once, it answers #A2 with the correction seen (the page,
    // never reloaded, shows it); then his reply to the user's message answers it.
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
  }

  if (await section("a turn T3 failed: its notice offers Retry")) {
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
  }

  if (await section("a reseat: a fresh seat of the worker takes over")) {
    // 14. He reseats the worker: its checkpoint, then a fresh seat of it takes over and works.
    await room.settle("fable");
    const oldWorker = seat.worker;
    room.board("fable", "reseat", "worker", "carry on with the parser follow-ups");
    const workerCheckpoint = await until("the reseat's checkpoint request", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.request.id.startsWith("reseat:") && p.request.owner === oldWorker));
    if (workerCheckpoint.author !== "$system" || workerCheckpoint.request.returnTo !== "$system") fail(`the checkpoint #${workerCheckpoint.number} is not Backroom's: by ${workerCheckpoint.author}, to ${workerCheckpoint.request.returnTo}`);
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
  }

  if (await section("a retire: the reviewer leaves the room")) {
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
  }

  // B1's helpers, for each of its sections below.
  const model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  /** A member seated now (L4b): in a room with a Consigliere Backroom briefs it at once. Its runs are held. */
  const seatNew = async (alias: string) => {
    const participantId = (await service.command<{ participantId: string }>({ type: "participant.create", roomId: room.roomId, alias, modelSelection: model, thread: { mode: "create" } })).participantId;
    const binding = (await room.snapshot()).bindings.find((b) => b.participantId === participantId)!;
    await service.fake("hold", { threadId: binding.threadId, hold: true });
    return { alias, seatId: binding.id, threadId: binding.threadId };
  };
  type Seated = Awaited<ReturnType<typeof seatNew>>;
  const liveOf = (m: Seated) => until(`@${m.alias}'s run`, async () => {
    const x = await room.snapshot();
    const id = x.seats.find((w) => w.seatId === m.seatId)?.activeRunId;
    const run = id ? x.runs.find((r) => r.id === id) : null;
    return run?.phase === "running" ? run : null;
  });
  /** T3 ends the member's running turn (failed with `error`, or completed), and the host imports it. */
  const endTurn = async (m: Seated, text: string, outcome: "error" | "completed") => {
    const run = await liveOf(m);
    await service.fake("complete", { threadId: m.threadId, text, outcome });
    await until(`@${m.alias}'s run ${run.id.slice(0, 8)} to end`, async () => (await room.snapshot()).runs.find((r) => r.id === run.id)?.phase === "terminal");
    return run;
  };
  const noticeOf = (x: Snapshot, runId: string) => x.posts.find((p) => p.kind === "notice" && p.notice.runId === runId);
  /** The uid of a button in one post's row of the page (its lines up to the next post's), named `name`, if it has one. */
  const rowButtonUid = (number: number, name: string): string | undefined => {
    const rows = browser.on("snapshot").split("\n");
    const at = rows.findIndex((line) => line.includes(`"#${number}, `));
    if (at < 0) fail(`no row of #${number} on the page`);
    const next = rows.findIndex((line, i) => i > at && /"#\d+, /.test(line));
    const line = rows.slice(at + 1, next < 0 ? undefined : next).find((l) => l.includes(`button "${name}"`));
    return line ? /uid=(\S+)/.exec(line)?.[1] : undefined;
  };
  const rowButton = (number: number, name: string): string => {
    const uid = rowButtonUid(number, name);
    if (!uid) fail(`no ${name} in the row of #${number}`);
    return uid;
  };
  const noNeedsInBar = () => browser.poll<boolean>("no 'Needs you' in the status bar", "() => !document.querySelector('.work-bar .work-needs')", (none) => none === true);
  if (await section("B1: a seat's briefing fails: Backroom's request, the Consigliere's notice, nothing needs the user", { replay: retireReviewer })) {
    // 16. B1: a seat's briefing is Backroom's request. A member whose thread cannot run fails it: the notice is the
    // Consigliere's and nothing reaches the user; he retires the member at once, and the briefing it never answered goes
    // with it.
    const sol = await seatNew("sol");
    const solBriefing = `seat-briefing:${sol.seatId}:seated`;
    const solFailed = await endTurn(sol, "You've hit your usage limit. Try again at Oct 14th, 2026.", "error");
    await check.state("B1: a seat's briefing fails: Backroom's request, the Consigliere's notice, nothing needs the user", (x) => {
      const briefing = x.posts.find((p) => p.request?.id === solBriefing);
      const notice = noticeOf(x, solFailed.id);
      return briefing?.author === "$system" && briefing.request.returnTo === "$system" && briefing.request.state === "open" && notice && notice.to.length === 1 && notice.to[0] === seat.fable && !notice.notice.needsYou && x.needsYou.length === 0 && x.counts.needsYou === 0
        ? `#${briefing.number} by $system to @sol, open; its failure #${notice.number} to @fable only, needsYou=false; the room's needsYou empty, counts.needsYou=0`
        : null;
    }, ["Backroom → @sol: seat briefing", "You've hit your usage limit"], { focus: (x) => noticeOf(x, solFailed.id)?.number, extra: noNeedsInBar });
    // The notice woke him; he takes note of it.
    await room.settle("fable");
    // He reseats it: the checkpoint is Backroom's request too, and its failure his notice. He cancels the checkpoint, the
    // reseat is called off, and the cancel's wake fails on nothing anyone asked: no notice for the user either.
    room.board("fable", "reseat", "sol");
    const solCheckpoint = (await until("@sol's checkpoint request", async () => (await room.snapshot()).posts.find((p) => p.kind === "request" && p.request.id.startsWith("reseat:") && p.request.owner === sol.seatId))).request.id as string;
    const checkpointFailed = await endTurn(sol, "You've hit your usage limit. Try again at Oct 14th, 2026.", "error");
    await check.state("B1: a reseat's checkpoint fails: Backroom's request, the Consigliere's notice, nothing needs the user", (x) => {
      const cp = x.posts.find((p) => p.request?.id === solCheckpoint);
      const notice = noticeOf(x, checkpointFailed.id);
      return cp?.author === "$system" && cp.request.returnTo === "$system" && notice && notice.to.length === 1 && notice.to[0] === seat.fable && !notice.notice.needsYou && x.needsYou.length === 0
        ? `checkpoint #${cp.number} by $system to @sol; its failure #${notice.number} to @fable only, needsYou=false; the room's needsYou empty`
        : null;
    }, ["Backroom → @sol: reseat checkpoint"], { focus: (x) => noticeOf(x, checkpointFailed.id)?.number, extra: noNeedsInBar });
    await room.settle("fable");
    room.board("fable", "cancel", `#${room.post(await room.snapshot(), solCheckpoint).number}`);
    const checkpointCancelWake = await endTurn(sol, "You've hit your usage limit. Try again at Oct 14th, 2026.", "error");
    await room.settle("fable");
    await check.state("B1: he cancels the checkpoint: the reseat is called off, and the cancel's wake needs nobody", (x) => {
      const off = x.posts.find((p) => p.id === `reseat-off:${solCheckpoint}`);
      const recovery = noticeOf(x, checkpointCancelWake.id);
      return off && x.posts.find((p) => p.request?.id === solCheckpoint)?.request.state === "cancelled" && recovery && recovery.to.length === 0 && !recovery.notice.needsYou && recovery.notice.retryRunId === null && x.needsYou.length === 0 && x.seats.find((w) => w.seatId === sol.seatId)?.status === "active"
        ? `#${off.number} "${off.body.slice(0, 40)}…"; the cancel's wake failed: #${recovery.number} to nobody, needsYou=false, no Retry; @sol keeps its seat`
        : null;
    }, ["Reseat of @sol called off"], { focus: (x) => x.posts.find((p) => p.id === `reseat-off:${solCheckpoint}`)?.number, extra: noNeedsInBar });
    const solRuns = service.t3Runs(sol.threadId).length;
    room.board("fable", "retire", "sol");
    await sleep(1_500);
    await check.state("B1: the Consigliere retires the member: the briefing it never answered goes with it", (x) => {
      const left = x.seats.find((w) => w.seatId === sol.seatId);
      const briefing = x.posts.find((p) => p.request?.id === solBriefing);
      return left?.status === "retired" && briefing?.request.state === "cancelled" && service.t3Runs(sol.threadId).length === solRuns && x.needsYou.length === 0
        ? `@sol's seat retired; #${briefing.number} cancelled with it; @sol not woken again (${solRuns} T3 run); needsYou empty`
        : null;
    }, [], {
      extra: () => {
        browser.poll<string | null>("the members after the retire", "() => document.querySelector('[aria-label^=\"Members (\"]')?.getAttribute('aria-label') ?? null", (label) => label === "Members (2)");
        log("  page: Members (2)");
      },
    });
  }

  if (await section("B1: a briefing in the user's name (before B1) fails: it reached the Consigliere, so it is his: not in the chat or the status bar, Retry kept", { replay: retireReviewer })) {
    // 17. The user's case (#438), on a journal from before B1, where a briefing was a request in the user's name: it
    // fails, and as it reached the Consigliere it is his (not in the chat or the status bar; Retry stays on the board);
    // his request to the member fails (his); his cancel of it wakes the member, which fails once more on the cancel
    // alone: that needs nobody. Nothing of the member's reaches the user; the Consigliere retires the member.
    const grok = await seatNew("grok");
    await endTurn(grok, "Acknowledged.", "completed");
    const beforeB1 = `seat-briefing:${grok.seatId}:before-b1`;
    room.journal([{ type: "request", actor: "$user", id: beforeB1, to: grok.seatId, body: "You are seated in a room whose Consigliere is @fable (a briefing as journals from before B1 hold it: in the user's name)." }]);
    const grokFailed = await endTurn(grok, "Cursor Agent SDK open failed.", "error");
    const firstNotice = await until("@grok's failure notice", async () => noticeOf(await room.snapshot(), grokFailed.id));
    browser.click(/tab "[^"]*fable/);
    await check.state("B1: a briefing in the user's name (before B1) fails: it reached the Consigliere, so it is his: not in the chat or the status bar, Retry kept", (x) => {
      const notice = noticeOf(x, grokFailed.id);
      return notice && notice.to.includes("$user") && notice.to.includes(seat.fable) && notice.notice.backroom && !notice.notice.needsYou && notice.notice.retryRunId === grokFailed.id && x.needsYou.length === 0
        ? `#${notice.number} to ${notice.to.join(", ")}, backroom=true, needsYou=false, Retry offered; the room's needsYou empty`
        : null;
    }, [], {
      extra: () => {
        noNeedsInBar();
        browser.poll<{ chat: string | null; row: boolean }>(
          "the chat without the failure",
          `() => { const log = document.querySelector('.timeline'); return { chat: log?.getAttribute('aria-label') ?? null, row: Boolean(log?.querySelector('[data-number="${firstNotice.number}"]')) }; }`,
          (v) => v.chat === "Conversation with the Consigliere" && !v.row,
        );
        browser.click(/tab "Board/);
        browser.waitFor("Cursor Agent SDK open failed");
        browser.show(firstNotice.number);
        rowButton(firstNotice.number, "Retry");
        if (rowButtonUid(firstNotice.number, "Dismiss")) fail(`#${firstNotice.number} offers Dismiss: it does not wait on the user`);
        log(`  page: no 'Needs you', not in the chat; on the board #${firstNotice.number} has Retry and no Dismiss`);
      },
      // The extra leaves the board shown, where the next state's notice is (it goes to nobody, so not to the chat).
      silently: () => browser.click(/tab "Board/),
    });
    await room.settle("fable");
    room.board("fable", "post", "@grok design K1, a keyboard-only Backroom");
    const k1 = (await posted(grok.seatId, "his request to @grok")).request.id;
    const k1Failed = await endTurn(grok, "Cursor Agent SDK open failed.", "error");
    await room.settle("fable");
    room.board("fable", "cancel", `#${room.post(await room.snapshot(), k1).number}`);
    const cancelWake = await endTurn(grok, "Cursor Agent SDK open failed.", "error");
    await room.settle("fable");
    await check.state("B1: the cancel's wake fails too: a recovery failure that needs nobody; nothing of the member's needs the user", (x) => {
      const his = noticeOf(x, k1Failed.id);
      const recovery = noticeOf(x, cancelWake.id);
      const wake = x.runs.find((r) => r.id === cancelWake.id);
      const onlyCancel = wake?.inputs.every((seq: number) => x.posts.find((p) => p.seq === seq)?.kind === "cancel");
      return his && his.to.length === 1 && his.to[0] === seat.fable && recovery && onlyCancel && recovery.to.length === 0 && !recovery.notice.needsYou && recovery.notice.retryRunId === null && x.needsYou.length === 0 && x.counts.needsYou === 0
        ? `#${his.number} to @fable only; the cancel's wake ${cancelWake.id.slice(0, 8)} carried only the cancel and its #${recovery.number} ("${recovery.body.slice(0, 18)}…") is to nobody, needsYou=false, no Retry; needsYou empty`
        : null;
    }, ["Recovery failure"], { focus: (x) => noticeOf(x, cancelWake.id)?.number, extra: noNeedsInBar });
    room.board("fable", "retire", "grok");
    await check.state("B1: the Consigliere retires the member whose briefing (in the user's name) failed", (x) => {
      const left = x.seats.find((w) => w.seatId === grok.seatId);
      const briefing = x.posts.find((p) => p.request?.id === beforeB1);
      return left?.status === "retired" && briefing?.request.state === "cancelled" && x.needsYou.length === 0
        ? `@grok's seat retired; #${briefing.number} (the user's, from before B1) cancelled with it; needsYou empty`
        : null;
    }, [], {
      extra: () => {
        browser.poll<string | null>("the members after the retire", "() => document.querySelector('[aria-label^=\"Members (\"]')?.getAttribute('aria-label') ?? null", (label) => label === "Members (2)");
        log("  page: Members (2)");
      },
    });
  }

  if (await section("B1: his own failed turn on your message: in the chat with Retry and Dismiss, the status bar's notice")) {
    // 18. B1: the Consigliere's own failed turn on the user's message is in the chat as well as in the status bar, one
    // notice: one Dismiss in the chat clears it everywhere (the bar, the room's count, the room list, the overview's tile),
    // and Retry there sends his turn again.
    await room.settle("fable");
    browser.click(/tab "[^"]*fable/);
    const release = await room.message("Plan the v1.3 release.");
    await room.live("fable");
    const hisFailed = runOf(await room.snapshot(), "fable")!;
    await room.finish("fable", "provider error: the model is overloaded", { outcome: "error" });
    const his = await check.state("B1: his own failed turn on your message: in the chat with Retry and Dismiss, the status bar's notice", (x) => {
      const notice = noticeOf(x, hisFailed.id);
      return notice && notice.to.length === 1 && notice.to[0] === "$user" && notice.notice.needsYou && notice.notice.retryRunId === hisFailed.id && x.needsYou.length === 1 && x.needsYou[0].id === notice.id
        ? `#${notice.number} to the user, needsYou=true, Retry offered; the room's needsYou is it alone`
        : null;
    }, ["the model is overloaded", "Needs you · 1"], { focus: (x) => noticeOf(x, hisFailed.id)?.number });
    const hisNotice = noticeOf(his, hisFailed.id)!;
    browser.poll<{ chat: string | null; row: boolean }>(
      "his failure's notice in the chat, with its buttons",
      `() => { const log = document.querySelector('.timeline'); return { chat: log?.getAttribute('aria-label') ?? null, row: Boolean(log?.querySelector('[data-number="${hisNotice.number}"] .notice-actions')) }; }`,
      (v) => v.chat === "Conversation with the Consigliere" && v.row,
    );
    browser.show(hisNotice.number);
    rowButton(hisNotice.number, "Retry");
    log(`  page: #${hisNotice.number} is in the chat with Retry and Dismiss`);
    const tileNeeds = async () => ({
      overview: (await service.call<{ rooms: Array<{ id: string; needs: number }> }>("GET", "/api/overview")).rooms.find((r) => r.id === room.roomId)?.needs,
      list: (await service.call<Array<{ id: string; counts: { needsYou: number } }>>("GET", "/api/rooms")).find((r) => r.id === room.roomId)?.counts.needsYou,
    });
    const beforeDismiss = await tileNeeds();
    if (beforeDismiss.overview !== 1 || beforeDismiss.list !== 1) fail(`the overview and the room list should count his failure once: ${JSON.stringify(beforeDismiss)}`);
    browser.on("click", rowButton(hisNotice.number, "Dismiss"));
    await check.state("B1: one Dismiss in the chat clears his failure from the status bar and the room's count", (x) => {
      const notice = x.posts.find((p) => p.id === hisNotice.id);
      return notice?.notice.dismissed && notice.notice.retryRunId === hisFailed.id && x.needsYou.length === 0 && x.counts.needsYou === 0 ? `#${notice.number} dismissed, Retry still offered; needsYou empty, counts.needsYou=0` : null;
    }, ["dismissed"], { show: hisNotice.number, extra: noNeedsInBar });
    const afterDismiss = await tileNeeds();
    if (afterDismiss.overview !== 0 || afterDismiss.list !== 0) fail(`the overview or the room list still counts his failure: ${JSON.stringify(afterDismiss)}`);
    browser.click(/button "Back to the overview"/);
    browser.poll<{ pill: string | null } | null>(
      "the room's tile without a 'needs you' pill",
      `() => { const card = [...document.querySelectorAll('article.ov-room')].find((c) => c.querySelector('.ov-room-title')?.textContent === ${JSON.stringify(room.title)}); return card ? { pill: card.querySelector('.pill-input')?.textContent ?? null } : null; }`,
      (tile) => tile !== null && tile.pill === null,
    );
    browser.screenshot("b1-the-tile-after-one-dismiss");
    log("  page: the overview's tile has no 'needs you'; GET /api/overview and /api/rooms counted 1 before the Dismiss, 0 after");
    browser.openRoom(room.title);
    browser.click(/tab "[^"]*fable/);
    browser.show(hisNotice.number);
    browser.on("click", rowButton(hisNotice.number, "Retry"));
    const retried = await until("his retried turn", async () => {
      const run = runOf(await room.snapshot(), "fable");
      return run && run.id !== hisFailed.id && run.phase === "running" ? run : null;
    });
    await room.finish("fable", "The v1.3 release plan: tag, changelog, announce.");
    await check.state("B1: Retry from the chat: his turn runs again and answers your message", (x) => {
      const out = finalOf(x, retried.id)[0];
      const claim = out?.output.claims.find((c: any) => c.requestId === release);
      return claim?.outcome === "answered" && room.post(x, release).request.state === "answered" ? `retried run ${retried.id.slice(0, 8)}; #${out.number} answers #${room.post(x, release).number}` : null;
    }, ["The v1.3 release plan"], { focus: (x) => finalOf(x, retried.id)[0]?.number });
    browser.click(/tab "Board/);
  }

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

  // B3: the Browser panel of a room that may use two browsers (not started, with its real Chromes, past the last state
  // --only or --until names).
  selection.stopIfDone();
  if (await section("the Browser panel with two browsers")) await rehearseBrowserPanel(service, browser, room, check);
  return check.passed;
}

// ---------------- main ----------------

/** A step's states, in the order it plays them, from the scripts' source (scripts/rehearse-select.ts). */
function stepStates(step: Step): string[] {
  return stepSource(step, (file) => readFileSync(join(repo, "scripts", file), "utf8")).flatMap(stateNames);
}
/** The first states of a step's sections, from the scripts' source as stepStates reads its states. */
function stepSections(step: Step): string[] {
  return stepSource(step, (file) => readFileSync(join(repo, "scripts", file), "utf8")).flatMap(sectionNames);
}

/**
 * The service's address as our tab opens it: on rehearse-<port>.localhost (Chrome takes any *.localhost to this
 * machine), not 127.0.0.1, a site of the run's own, so a renderer of its own, and a crash in the run takes no other
 * tab with it, another run's or anyone's on 127.0.0.1 (C1). REHEARSE_TAB_HOST names another host.
 */
function tabUrl(base: string): string {
  const url = new URL(base);
  url.hostname = process.env.REHEARSE_TAB_HOST || `rehearse-${url.port}.localhost`;
  return url.origin;
}

/**
 * What a step left behind when it was ended before it could clean up (killed, or stopped by a signal while a browser
 * call held it): its service, by the record it wrote in its data folder, and its tabs on its service's address in the
 * shared browser. Only a record of this child's for its port counts: a child refused at the start (its port taken, its
 * folder in use) left nothing, and what it finds there is another run's. With --keep the service stays.
 */
async function leftBehind(data: string, port: number, browser: string, child: number | undefined, o: Options): Promise<string[]> {
  const record = readRecord(data);
  if (!recordOf(record, child, port)) return [];
  const done: string[] = [];
  const base = `http://127.0.0.1:${port}`;
  if (!o.keep && isService(record.service)) {
    // Its real browsers (B3's) outlive the service by design: stopped through it first.
    const browsers = await fetch(`${base}/api/browsers`).then((r) => r.json() as Promise<Array<{ id: string; status: { state: string } }>>, () => []);
    for (const b of browsers.filter((x) => x.status.state !== "stopped")) await fetch(`${base}/api/browsers/${b.id}/stop`, { method: "POST" }).catch(() => undefined);
    try {
      process.kill(-record.service, "SIGTERM");
    } catch {
      process.kill(record.service, "SIGTERM");
    }
    for (let i = 0; i < 50 && isService(record.service); i += 1) await sleep(200);
    if (isService(record.service)) process.kill(record.service, "SIGKILL");
    rmSync(join(data, "service.pid"), { force: true });
    done.push(`its service (pid ${record.service}) stopped`);
  }
  let listing = "";
  try {
    listing = execFileSync(o.cli, [browser, "tabs", "--as", o.as], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // rooms-browser unreachable: nothing more to do here
  }
  for (const tab of ourTabs(listing, tabUrl(base))) {
    try {
      execFileSync(o.cli, [browser, tab, "close", "--as", o.as], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      done.push(`its tab ${tab} closed`);
    } catch {
      // closed meanwhile
    }
  }
  return done;
}

/**
 * --step all: the three steps started together, each a process of its own on a port and a data folder of its own (ui
 * on --port, room on the next, keys on the one after), keys in a browser of its own (a tab behind another one's in the
 * same window scrolls late: the End-scroll flake). Each step's output goes to its log; this prints each step's result
 * and fails if any step failed. With --only or --until, a step runs only if they name one of its states. A step that
 * failed or was stopped has its service and tabs cleaned up after it, if it left them; a signal to the launcher stops
 * every step and does the same.
 */
async function runAll(o: Options): Promise<void> {
  if (o.keysBrowser === o.browser) fail(`keys needs a browser of its own: --keys-browser ${o.keysBrowser} is also --browser`);
  let plan: Record<Step, { run: boolean; only: string[]; until: string | null }>;
  try {
    plan = forSteps({ ui: stepStates("ui"), room: stepStates("room"), keys: stepStates("keys") }, o.only, o.until);
  } catch (error) {
    fail((error as Error).message);
  }
  // Refused before anything is written: ports already answering (the live service among them), or a launcher already
  // running on this data folder (its logs would be overwritten).
  for (const [i, step] of STEPS.entries()) {
    const port = o.port + i;
    if (plan[step].run && (await fetch(`http://127.0.0.1:${port}/api/status`).then(() => true, () => false))) fail(`${step}'s port ${port} answers already: pass another --port (the three steps take it and the next two)`);
  }
  const lock = join(o.data, "launcher.pid");
  const holder = existsSync(lock) ? Number(readFileSync(lock, "utf8").trim()) : NaN;
  if (Number.isInteger(holder) && holder !== process.pid && existsSync(`/proc/${holder}`) && readFileSync(`/proc/${holder}/cmdline`, "utf8").includes("rehearse.ts")) fail(`a launcher (pid ${holder}) runs on ${o.data}: pass another --data or --port`);
  const begun = Date.now();
  mkdirSync(o.data, { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  process.on("exit", () => rmSync(lock, { force: true }));
  if (o.outGiven) mkdirSync(o.out, { recursive: true });
  const children = new Set<ChildProcess>();
  let stopping: string | null = null;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = signal;
    console.log(`all: ${signal}: stopping the steps`);
    for (const child of children) child.kill("SIGTERM");
    // A step held in a browser call reads the signal only when the call returns: then it is killed, and cleaned up after.
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 20_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  const runs = STEPS.map((step, i) => {
    const { run: chosen, only, until } = plan[step];
    const port = o.port + i;
    const browser = step === "keys" ? o.keysBrowser : o.browser;
    const data = join(o.data, step);
    const logFile = join(o.outGiven ? o.out : o.data, `${step}.log`);
    if (!chosen) {
      console.log(`${step}: not run (no state of it matches ${[...o.only.map((x) => `--only ${x}`), ...(o.until === null ? [] : [`--until ${o.until}`])].join(" ")})`);
      return Promise.resolve({ step, ok: true });
    }
    const args = [
      "--no-warnings=ExperimentalWarning", join(repo, "scripts", "rehearse.ts"),
      "--step", step, "--as", o.as, "--browser", browser, "--port", String(port), "--data", data, "--browser-cli", o.cli,
      ...(o.outGiven ? ["--out", join(o.out, step)] : []),
      ...only.flatMap((pattern) => ["--only", pattern]),
      ...(until === null ? [] : ["--until", until]),
      ...(o.keep ? ["--keep"] : []),
    ];
    console.log(`${step}: port ${port}, browser ${browser}, log ${logFile}`);
    const fd = openSync(logFile, "w");
    // Its own process group: a Ctrl-C reaches the launcher, which stops each step and cleans up after it.
    const child = spawn(process.execPath, args, { cwd: repo, stdio: ["ignore", fd, fd], detached: true });
    children.add(child);
    return new Promise<{ step: Step; ok: boolean }>((done) => {
      let ended = false;
      // Once, whichever comes: "close" (it ran and ended), or "error" alone (it could not start; "close" may not follow).
      const end = async (code: number | null, signal: NodeJS.Signals | null, startError: Error | null) => {
        if (ended) return;
        ended = true;
        children.delete(child);
        const seconds = Math.round((Date.now() - begun) / 1000);
        const ok = stepPassed(code, signal, startError);
        const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : [];
        const why = startError ? `could not start: ${startError.message}` : (lines.find((l) => l.startsWith("[rehearse] FAILED: "))?.slice("[rehearse] FAILED: ".length) ?? "see its log");
        console.log(
          ok
            ? `${step}: PASS after ${seconds} s: ${lines.findLast((l) => /\] DONE: /.test(l))?.replace(/^.*\] DONE: /, "") ?? "done"} (log ${logFile})`
            : `${step}: FAILED after ${seconds} s (${startError ? "not started" : signal ? `ended by ${signal}` : `exit ${code}`}): ${why} (log ${logFile})`,
        );
        if (!ok) {
          const cleaned = await leftBehind(data, port, browser, child.pid, o);
          if (cleaned.length > 0) console.log(`${step}: cleaned up after it: ${cleaned.join(", ")}`);
        }
        done({ step, ok });
      };
      child.on("error", (error) => void end(null, null, error));
      child.on("close", (code, signal) => void end(code, signal, null));
    });
  });
  const results = await Promise.all(runs);
  const failed = results.filter((r) => !r.ok);
  console.log(`all: ${failed.length === 0 && !stopping ? "PASS" : `FAILED (${stopping ? `stopped by ${stopping}` : failed.map((r) => r.step).join(", ")})`} after ${Math.round((Date.now() - begun) / 1000)} s`);
  process.exit(failed.length > 0 || stopping ? 1 : 0);
}

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  if (o.list) {
    for (const step of o.step === "all" ? STEPS : [o.step]) stepStates(step).forEach((name, i) => console.log(`${step} ${i + 1}: ${name}`));
    return;
  }
  if (o.step === "all") return runAll(o);
  const step = o.step;
  let selection: Selection;
  try {
    selection = new Selection(stepStates(step), o.only, o.until, stepSections(step));
  } catch (error) {
    fail(`${step}: ${(error as Error).message}`);
  }
  if (!selection.whole) {
    const loud = selection.names.map((_, i) => i).filter((i) => selection.loud(i));
    log(`${o.only.length > 0 ? "--only" : "--until"}: checks ${loud.length === selection.last + 1 ? `states 1 to ${selection.last + 1}` : loud.map((i) => selection.label(i)).join("; ")}; the step stops after state ${selection.last + 1}`);
  }
  const service = new Service(o);
  const browser = new Browser(o, tabUrl(service.base));
  let passed: string[] = [];
  // Stopped from outside (Ctrl-C, or the launcher): the tab closed and the service stopped all the same.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stoppedBy = signal;
      // Said at once: the step may be ended before its stopped flow gets to say anything (the launcher reads this line).
      console.error(`[rehearse] FAILED: stopped by ${signal}`);
      log(`${signal}: closing our tab${o.keep ? "; --keep: the service stays" : " and stopping the service"}`);
      browser.close();
      void (o.keep ? Promise.resolve() : service.stop()).finally(() => process.exit(1));
    });
  }
  try {
    await service.start();
    const room = new Room(service, o);
    await room.create(step === "room" ? "Whole room" : "Rehearsal");
    try {
      passed =
        step === "ui" ? await rehearseUi(service, browser, room, selection) : step === "keys" ? await rehearseKeys(service, browser, room, { log, fail, until, sleep, selection }) : await rehearseRoom(service, browser, room, selection);
      log(`DONE: ${selection.whole ? `${passed.length} states checked in the API and on the page, console clean` : selection.summary()}`);
    } catch (error) {
      if (!(error instanceof SelectionDone)) throw error;
      log(`DONE: ${error.message}`);
    }
    if (!selection.whole && selection.checked === 0) fail("no state was checked: --only and --until named states the step never reached");
  } finally {
    browser.close();
    if (o.keep) log(`--keep: the service stays on ${service.base}`);
    else await service.stop();
  }
}

/** The signal that stopped the run, if one did: what failed after it failed because of it. */
let stoppedBy: string | null = null;

main().then(
  // Stopped by a signal, a run that ends by itself meanwhile is still a stopped one.
  () => process.exit(stoppedBy ? 1 : 0),
  (error: unknown) => {
    if (stoppedBy) return; // said by the signal's handler
    console.error(`[rehearse] FAILED: ${error instanceof RehearsalFailure ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
