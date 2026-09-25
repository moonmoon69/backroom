/**
 * Room browsers: one shared Chrome per room, started by the room service on the machine it runs on (the same machine
 * as the T3 server and the agents). Agents attach over Chrome's DevTools port on localhost; the user watches and takes
 * over through noVNC (Linux, on an Xvfb display) or the visible Chrome window (macOS / desktop Linux).
 *
 * Ports and the profile are stable per room (data/browsers/<roomId>), so the address in a briefing stays valid across
 * restarts and logins survive. Browsers outlive a restart of the room service (an agent may be mid-task): their process
 * groups are recorded in state.json and adopted when the service starts again. Nothing here is room state: the room
 * only stores whether its browser is enabled.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";

export type BrowserMode = "vnc" | "window" | "headless";

export interface BrowserEnvironment {
  /** Mode the next start will use; null when the browser cannot run here (see missing). */
  mode: BrowserMode | null;
  chromePath: string | null;
  /** Programs needed for the preferred mode that are not installed. */
  missing: string[];
  /** Host part of watch links, when configured; null means "the host the UI was opened on". */
  watchHost: string | null;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface RoomBrowserStatus {
  roomId: string;
  state: "stopped" | "starting" | "running" | "error";
  mode: BrowserMode | null;
  /** DevTools endpoint on this machine, for agents. */
  cdpUrl: string | null;
  cdpPort: number | null;
  /** noVNC port and path; the UI completes the link with its own host when watchHost is null. */
  watchPort: number | null;
  watchPath: string | null;
  watchHost: string | null;
  tabs: BrowserTab[];
  startedAt: string | null;
  lastActivityAt: string | null;
  error: string | null;
}

/** What a briefing needs to point an agent at the room's browser. */
export interface BrowserBriefing {
  cdpUrl: string;
  cdpPort: number;
  mode: BrowserMode;
  /** Full watch link when the host is known; otherwise null (the room UI shows it). */
  watchUrl: string | null;
}

export interface RoomBrowserOptions {
  dataDir: string;
  /** Forced mode, or "off"; default picks vnc on Linux with Xvfb, a window otherwise. */
  mode?: BrowserMode | "off" | null;
  chromePath?: string | null;
  /** Address noVNC listens on (default 127.0.0.1; set a Tailscale IP to watch from other devices). */
  bindHost?: string;
  /** Host used in watch links; defaults to bindHost unless that is a wildcard. */
  watchHost?: string | null;
  noVncDir?: string;
  idleMinutes?: number;
  /** True while the room has work in flight; a busy room's browser is never stopped for idleness. */
  isRoomBusy?: (roomId: string) => boolean;
  onChange?: (roomId: string) => void;
  log?: (message: string, detail?: unknown) => void;
}

interface Ports {
  cdp: number;
  vnc: number;
  web: number;
  display: number;
}

interface Instance {
  roomId: string;
  mode: BrowserMode;
  ports: Ports;
  password: string | null;
  /** Process groups started for this browser (Xvfb, x11vnc, websockify, Chrome); Chrome's is last. */
  groups: number[];
  state: RoomBrowserStatus["state"];
  error: string | null;
  tabs: BrowserTab[];
  tabSignature: string;
  startedAt: string;
  lastActivityAt: string;
  starting: Promise<void> | null;
}

const CHROME_CANDIDATES_DARWIN = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];
const CHROME_COMMANDS_LINUX = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
const SCREEN = { width: 1440, height: 900 };
const POLL_MS = 5000;

const which = (command: string): string | null => {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  const path = result.status === 0 ? result.stdout.trim() : "";
  return path.length > 0 ? path : null;
};

const isWildcard = (host: string): boolean => host === "0.0.0.0" || host === "::" || host === "";

export class RoomBrowsers {
  private readonly instances = new Map<string, Instance>();
  private readonly options: Required<Pick<RoomBrowserOptions, "dataDir" | "bindHost" | "noVncDir" | "idleMinutes">> & RoomBrowserOptions;
  private timer: NodeJS.Timeout | null = null;
  private cachedEnvironment: BrowserEnvironment | null = null;

  constructor(options: RoomBrowserOptions) {
    this.options = {
      bindHost: "127.0.0.1",
      noVncDir: "/usr/share/novnc",
      idleMinutes: 30,
      ...options,
    };
  }

  /** What this machine can run; computed once (installing programs needs a service restart to be noticed). */
  environment(): BrowserEnvironment {
    if (this.cachedEnvironment) return this.cachedEnvironment;
    const forced = this.options.mode ?? null;
    const watchHost = this.options.watchHost ?? (isWildcard(this.options.bindHost) ? null : this.options.bindHost);
    if (forced === "off") {
      this.cachedEnvironment = { mode: null, chromePath: null, missing: ["disabled (ROOMS_BROWSER_MODE=off)"], watchHost };
      return this.cachedEnvironment;
    }
    const chromePath = this.options.chromePath ?? this.findChrome();
    const missing: string[] = chromePath ? [] : ["Google Chrome or Chromium"];
    let mode: BrowserMode | null;
    if (process.platform === "linux") {
      const vncTools = ["Xvfb", "x11vnc", "websockify"].filter((tool) => !which(tool));
      if (!existsSync(join(this.options.noVncDir, "vnc.html"))) vncTools.push(`noVNC (${this.options.noVncDir})`);
      if (forced) mode = forced;
      else if (vncTools.length === 0) mode = "vnc";
      else mode = process.env.DISPLAY ? "window" : "headless";
      if (mode === "vnc" || (!forced && mode === "headless")) missing.push(...vncTools);
    } else {
      mode = forced ?? "window";
    }
    this.cachedEnvironment = { mode: chromePath ? mode : null, chromePath, missing, watchHost };
    return this.cachedEnvironment;
  }

  /** Adopt browsers left running by a previous run of the service, then watch tabs and idleness. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.adopt();
  }

  status(roomId: string): RoomBrowserStatus {
    const instance = this.instances.get(roomId);
    const environment = this.environment();
    if (!instance) {
      return {
        roomId,
        state: "stopped",
        mode: environment.mode,
        cdpUrl: null,
        cdpPort: null,
        watchPort: null,
        watchPath: null,
        watchHost: environment.watchHost,
        tabs: [],
        startedAt: null,
        lastActivityAt: null,
        error: environment.mode ? null : `Cannot start a browser here: missing ${environment.missing.join(", ")}`,
      };
    }
    const vnc = instance.mode === "vnc";
    return {
      roomId,
      state: instance.state,
      mode: instance.mode,
      cdpUrl: `http://127.0.0.1:${instance.ports.cdp}`,
      cdpPort: instance.ports.cdp,
      watchPort: vnc ? instance.ports.web : null,
      watchPath: vnc ? `/vnc.html?autoconnect=1&resize=scale&password=${instance.password ?? ""}` : null,
      watchHost: environment.watchHost,
      tabs: instance.tabs,
      startedAt: instance.startedAt,
      lastActivityAt: instance.lastActivityAt,
      error: instance.error,
    };
  }

  /** Start the room's browser if needed and wait until agents can attach. */
  async ensure(roomId: string): Promise<RoomBrowserStatus> {
    const existing = this.instances.get(roomId);
    if (existing?.state === "running") return this.status(roomId);
    if (existing?.starting) {
      await existing.starting;
      return this.status(roomId);
    }
    const environment = this.environment();
    if (!environment.mode || !environment.chromePath) {
      throw new Error(`Cannot start a browser here: missing ${environment.missing.join(", ")}`);
    }
    const ports = await this.portsFor(roomId, environment.mode);
    const instance: Instance = {
      roomId,
      mode: environment.mode,
      ports,
      password: environment.mode === "vnc" ? randomBytes(6).toString("base64url").slice(0, 8) : null,
      groups: [],
      state: "starting",
      error: null,
      tabs: [],
      tabSignature: "",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      starting: null,
    };
    this.instances.set(roomId, instance);
    this.changed(roomId);
    instance.starting = this.launch(instance, environment.chromePath)
      .then(() => {
        instance.state = "running";
        this.saveState(instance);
        this.log("room browser started", { roomId, mode: instance.mode, cdp: ports.cdp });
      })
      .catch((error: Error) => {
        instance.state = "error";
        instance.error = error.message;
        this.kill(instance);
        this.log("room browser failed to start", { roomId, error: error.message });
      })
      .finally(() => {
        instance.starting = null;
        this.changed(roomId);
      });
    await instance.starting;
    if (instance.state !== "running") throw new Error(instance.error ?? "the browser did not start");
    await this.refreshTabs(instance);
    return this.status(roomId);
  }

  /** The briefing section's facts, starting the browser if needed; null when it cannot run. */
  async briefingFor(roomId: string): Promise<BrowserBriefing | null> {
    try {
      const status = await this.ensure(roomId);
      if (!status.cdpUrl || !status.cdpPort || !status.mode) return null;
      const watchUrl =
        status.watchPort && status.watchPath && status.watchHost ? `http://${status.watchHost}:${status.watchPort}${status.watchPath}` : null;
      return { cdpUrl: status.cdpUrl, cdpPort: status.cdpPort, mode: status.mode, watchUrl };
    } catch (error) {
      this.log("room browser unavailable for briefing", { roomId, error: (error as Error).message });
      return null;
    }
  }

  /** Stop the room's browser and wait until its processes are gone (SIGKILL after a few seconds). */
  async stop(roomId: string): Promise<void> {
    const instance = this.instances.get(roomId);
    if (!instance) return;
    this.instances.delete(roomId);
    rmSync(join(this.roomDir(roomId), "state.json"), { force: true });
    const groups = [...instance.groups];
    this.kill(instance);
    this.log("room browser stopped", { roomId });
    this.changed(roomId);
    const deadline = Date.now() + 5000;
    while (groups.some(groupAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const group of groups.filter(groupAlive)) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // gone
      }
    }
  }

  /** Stop the browser and delete its profile (logins, history). Used when the room is deleted. */
  async remove(roomId: string): Promise<void> {
    await this.stop(roomId);
    rmSync(this.roomDir(roomId), { recursive: true, force: true });
  }

  /** Service shutdown: stop watching but leave the browsers running; the next start adopts them. */
  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.instances.clear();
  }

  /** Stop every browser (tests, or an explicit shutdown of all rooms). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((roomId) => this.stop(roomId)));
    this.detach();
  }

  // ---------------- internals ----------------

  private roomDir(roomId: string): string {
    return join(this.options.dataDir, "browsers", roomId);
  }

  private findChrome(): string | null {
    if (process.platform === "darwin") return CHROME_CANDIDATES_DARWIN.find((path) => existsSync(path)) ?? null;
    for (const command of CHROME_COMMANDS_LINUX) {
      const path = which(command);
      if (path) return path;
    }
    return null;
  }

  /** Stable per room: reuse the saved ports when they are free, otherwise pick new ones and save them. */
  private async portsFor(roomId: string, mode: BrowserMode): Promise<Ports> {
    const dir = this.roomDir(roomId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ports.json");
    const taken = new Set<number>([...this.instances.values()].flatMap((i) => [i.ports.cdp, i.ports.vnc, i.ports.web]));
    const takenDisplays = new Set([...this.instances.values()].map((i) => i.ports.display));
    let saved: Partial<Ports> = {};
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Ports>;
    } catch {
      saved = {};
    }
    const pick = async (preferred: number | undefined, base: number, host: string): Promise<number> => {
      // The saved port keeps the address agents were given; a browser that was just stopped may still hold it briefly.
      if (preferred && !taken.has(preferred)) {
        const deadline = Date.now() + 5000;
        while (!(await portFree(preferred, host)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        if (await portFree(preferred, host)) {
          taken.add(preferred);
          return preferred;
        }
      }
      for (let port = base; port < base + 500; port += 1) {
        if (!taken.has(port) && (await portFree(port, host))) {
          taken.add(port);
          return port;
        }
      }
      throw new Error(`no free port near ${base}`);
    };
    const cdp = await pick(saved.cdp, 9300, "127.0.0.1");
    const vnc = mode === "vnc" ? await pick(saved.vnc, 5950, "127.0.0.1") : saved.vnc ?? 0;
    const web = mode === "vnc" ? await pick(saved.web, 6100, this.options.bindHost) : saved.web ?? 0;
    let display = saved.display ?? 0;
    if (mode === "vnc") {
      const free = (n: number) => !takenDisplays.has(n) && !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`);
      if (!display || !free(display)) {
        display = 0;
        for (let n = 100; n < 400; n += 1) {
          if (free(n)) {
            display = n;
            break;
          }
        }
        if (!display) throw new Error("no free X display");
      }
    }
    const ports: Ports = { cdp, vnc, web, display };
    writeFileSync(file, JSON.stringify(ports, null, 2));
    return ports;
  }

  private async launch(instance: Instance, chromePath: string): Promise<void> {
    const dir = this.roomDir(instance.roomId);
    const profile = join(dir, "profile");
    mkdirSync(profile, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    const { ports } = instance;

    if (instance.mode === "vnc") {
      const display = `:${ports.display}`;
      instance.groups.push(this.spawnTool(instance, "Xvfb", [display, "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp"]));
      await waitFor(() => existsSync(`/tmp/.X11-unix/X${ports.display}`), 10_000, "the virtual display did not come up");
      env.DISPLAY = display;
      const passwordFile = join(dir, "vncpasswd");
      const stored = spawnSync("x11vnc", ["-storepasswd", instance.password ?? "", passwordFile], { encoding: "utf8" });
      if (stored.status !== 0) throw new Error(`x11vnc could not store the password: ${stored.stderr.trim()}`);
      instance.groups.push(
        this.spawnTool(instance, "x11vnc", ["-display", display, "-rfbport", String(ports.vnc), "-localhost", "-forever", "-shared", "-rfbauth", passwordFile, "-quiet"]),
      );
      instance.groups.push(
        this.spawnTool(instance, "websockify", ["--web", this.options.noVncDir, `${this.options.bindHost}:${ports.web}`, `127.0.0.1:${ports.vnc}`]),
      );
    }

    const args = [
      `--remote-debugging-port=${ports.cdp}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      `--window-size=${SCREEN.width},${SCREEN.height}`,
    ];
    if (instance.mode === "vnc") args.push("--window-position=0,0", "--start-maximized");
    if (instance.mode === "headless") args.push("--headless=new");
    if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
    args.push("about:blank");
    const chrome = this.spawnTool(instance, chromePath, args, env, true);
    instance.groups.push(chrome);
    await waitFor(
      async () => {
        if (!groupAlive(chrome)) throw new Error(`Chrome exited during start: ${this.logTail(instance.roomId, "chrome")}`);
        return (await fetchJson(`http://127.0.0.1:${ports.cdp}/json/version`)) !== null;
      },
      20_000,
      "Chrome did not open its DevTools port",
    );
  }

  /**
   * Spawn in its own process group (the group id is the child's pid) so stopping kills everything it started: Chrome
   * forks many helpers. Returns the group id.
   */
  private spawnTool(instance: Instance, command: string, args: string[], env: NodeJS.ProcessEnv = process.env, isChrome = false): number {
    // Output goes to a per-room log (data/browsers/<roomId>/<tool>.log) for diagnosing a browser that will not start.
    const logFd = openSync(join(this.roomDir(instance.roomId), `${isChrome ? "chrome" : basename(command)}.log`), "w");
    const child: ChildProcess = spawn(command, args, { env, detached: true, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    if (child.pid === undefined) throw new Error(`${command} could not be started`);
    child.on("error", (error) => {
      instance.error = `${command}: ${error.message}`;
    });
    child.on("exit", (code) => {
      if (!isChrome || this.instances.get(instance.roomId) !== instance || instance.state === "starting") return;
      // Closing the Chrome window (or a crash) ends the room browser; the next task or Start brings it back.
      this.log("room browser exited", { roomId: instance.roomId, code });
      void this.stop(instance.roomId);
    });
    child.unref();
    return child.pid;
  }

  /** Last meaningful lines of a tool's log, for error messages. */
  private logTail(roomId: string, tool: string): string {
    try {
      const lines = readFileSync(join(this.roomDir(roomId), `${tool}.log`), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.slice(-3).join(" | ").slice(0, 400) || "no output";
    } catch {
      return "no output";
    }
  }

  private kill(instance: Instance): void {
    for (const group of [...instance.groups].reverse()) {
      try {
        process.kill(-group, "SIGTERM");
      } catch {
        // already gone
      }
    }
    instance.groups = [];
  }

  private saveState(instance: Instance): void {
    const state = { mode: instance.mode, ports: instance.ports, password: instance.password, groups: instance.groups, startedAt: instance.startedAt };
    writeFileSync(join(this.roomDir(instance.roomId), "state.json"), JSON.stringify(state, null, 2));
  }

  /** Browsers from a previous run: adopt the ones still answering, clean up the rest. */
  private async adopt(): Promise<void> {
    const root = join(this.options.dataDir, "browsers");
    if (!existsSync(root)) return;
    for (const roomId of readdirSync(root)) {
      const file = join(root, roomId, "state.json");
      if (!existsSync(file) || this.instances.has(roomId)) continue;
      let state: { mode: BrowserMode; ports: Ports; password: string | null; groups: number[]; startedAt: string };
      try {
        state = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      const chromeGroup = state.groups[state.groups.length - 1];
      const answering = chromeGroup !== undefined && groupAlive(chromeGroup) && (await fetchJson(`http://127.0.0.1:${state.ports.cdp}/json/version`)) !== null;
      if (!answering) {
        for (const group of state.groups) {
          try {
            process.kill(-group, "SIGTERM");
          } catch {
            // gone
          }
        }
        rmSync(file, { force: true });
        continue;
      }
      const instance: Instance = {
        roomId,
        mode: state.mode,
        ports: state.ports,
        password: state.password,
        groups: state.groups,
        state: "running",
        error: null,
        tabs: [],
        tabSignature: "",
        startedAt: state.startedAt,
        lastActivityAt: new Date().toISOString(),
        starting: null,
      };
      this.instances.set(roomId, instance);
      await this.refreshTabs(instance);
      this.log("room browser adopted", { roomId, cdp: state.ports.cdp });
      this.changed(roomId);
    }
  }

  private async refreshTabs(instance: Instance): Promise<boolean> {
    const list = await fetchJson(`http://127.0.0.1:${instance.ports.cdp}/json/list`);
    if (!Array.isArray(list)) return false;
    const tabs = (list as Array<Record<string, unknown>>)
      .filter((target) => target.type === "page")
      .map((target) => ({ id: String(target.id), title: String(target.title ?? ""), url: String(target.url ?? "") }));
    const signature = tabs.map((t) => `${t.id} ${t.url} ${t.title}`).join("\n");
    if (signature === instance.tabSignature) return false;
    instance.tabs = tabs;
    instance.tabSignature = signature;
    instance.lastActivityAt = new Date().toISOString();
    return true;
  }

  private async poll(): Promise<void> {
    const idleMs = this.options.idleMinutes * 60_000;
    for (const instance of [...this.instances.values()]) {
      if (instance.state !== "running") continue;
      const chromeGroup = instance.groups[instance.groups.length - 1];
      if (chromeGroup === undefined || !groupAlive(chromeGroup)) {
        // An adopted browser has no exit listener; notice it went away here.
        this.log("room browser went away", { roomId: instance.roomId });
        await this.stop(instance.roomId);
        continue;
      }
      if (await this.refreshTabs(instance)) this.changed(instance.roomId);
      const idle = Date.now() - Date.parse(instance.lastActivityAt) > idleMs;
      if (idleMs > 0 && idle && !(this.options.isRoomBusy?.(instance.roomId) ?? false)) {
        this.log("room browser idle; stopping", { roomId: instance.roomId });
        await this.stop(instance.roomId);
      }
    }
  }

  private changed(roomId: string): void {
    this.options.onChange?.(roomId);
  }

  private log(message: string, detail?: unknown): void {
    this.options.log?.(message, detail);
  }
}

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}
