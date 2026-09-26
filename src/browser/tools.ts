/**
 * Browser tools for agents: the engine behind bin/rooms-browser. Every harness has a shell, so agents drive the shared
 * browsers with a command line instead of harness-specific MCP configuration.
 *
 * The service runs one chrome-devtools-mcp (stdio MCP server) per running browser as its engine, attached to the
 * browser's DevTools port with --pageIdRouting, so every page command names its tab. Calls to one browser run one at a
 * time. Tabs belong to the agent that opened them (its key from the briefing, "sol1.2fa05e45"); acting on another tab
 * needs --force. Owners live with the engine: when the browser restarts, its restored tabs belong to nobody.
 *
 * The command line is parsed here, not in the CLI, so help, rules and tool mapping have one home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, Room } from "../domain/types.ts";
import type { RoomBrowsers } from "./roomBrowsers.ts";

const ENGINE_BIN = createRequire(import.meta.url).resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
const ENGINE_ARGS = [
  "--pageIdRouting",
  // Nothing leaves the machine: no usage statistics, no CrUX lookups; performance, memory and emulation tools are off.
  "--usageStatistics=false",
  "--performanceCrux=false",
  "--categoryPerformance=false",
  "--categoryMemory=false",
  "--categoryEmulation=false",
];
const CALL_TIMEOUT_MS = 90_000;
export const SCREENSHOT_DIR = join(tmpdir(), "rooms-browser");

export class BrowserToolError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BrowserToolError";
    this.status = status;
  }
}

interface McpContent {
  type: string;
  text?: string;
}

/** A chrome-devtools-mcp process attached to one running browser. */
class Engine {
  readonly browserStartedAt: string | null;
  /** Tab id (the engine's page id) → the agent key that opened it. */
  readonly owners = new Map<number, string>();
  private readonly child: ChildProcess;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  closed = false;

  constructor(cdpUrl: string, browserStartedAt: string | null) {
    this.browserStartedAt = browserStartedAt;
    const child = spawn(process.execPath, [ENGINE_BIN, "--browserUrl", cdpUrl, ...ENGINE_ARGS], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    this.child.on("exit", () => this.fail(new BrowserToolError(`the browser engine exited${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`, 502)));
    this.child.on("error", (error) => this.fail(new BrowserToolError(`the browser engine could not start: ${error.message}`, 502)));
    this.ready = (async () => {
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3-rooms", version: "1" } }, 30_000);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    })();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!waiter || message.id === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new BrowserToolError(message.error.message ?? "the browser engine refused the call", 502));
      else waiter.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new BrowserToolError("the browser engine is closed", 502));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserToolError(`the browser did not answer within ${Math.round(timeoutMs / 1000)}s`, 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  /** One tool call, after the calls before it (one at a time per browser). */
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const run = async () => {
      await this.ready;
      const result = (await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS)) as { content?: McpContent[]; isError?: boolean };
      const text = (result.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
        .join("\n")
        .trim();
      return { text, isError: Boolean(result.isError) };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }
}

/** A page line of the engine's "## Pages" listing: "3: Title (https://…) [selected]" or "3: about:blank". */
const PAGE_LINE = /^(\d+): (.*?)(?: \[selected\])?$/;

export interface ToolCaller {
  /** The agent's key from its briefing ("sol1.2fa05e45", "thread.1a2b3c4d"); null when none was given. */
  as: string | null;
  force: boolean;
}

export interface BrowserToolsDeps {
  browsers: RoomBrowsers;
  /** Resolve a browser by name (or id); null when there is none. */
  findBrowser: (nameOrId: string) => Browser | null;
  listBrowsers: () => Browser[];
  /** The room an agent key belongs to ("sol1.2fa05e45" → the room whose id starts with 2fa05e45). */
  roomForKey: (key: string) => Room | null;
  /** Browsers a room may use (its allowed list, or all). */
  browsersForRoom: (room: Room) => Browser[];
  log?: (message: string, detail?: unknown) => void;
}

export class BrowserTools {
  private readonly engines = new Map<string, Engine>();
  private readonly deps: BrowserToolsDeps;

  constructor(deps: BrowserToolsDeps) {
    this.deps = deps;
  }

  /** Stop the engine of a browser that stopped (its tabs and owners go with it). */
  browserChanged(browserId: string): void {
    const engine = this.engines.get(browserId);
    if (!engine) return;
    const status = this.deps.browsers.status(browserId);
    if (status.state !== "running" || status.startedAt !== engine.browserStartedAt) {
      engine.close();
      this.engines.delete(browserId);
    }
  }

  closeAll(): void {
    for (const engine of this.engines.values()) engine.close();
    this.engines.clear();
  }

  /** Run one rooms-browser command line (argv without the program name). Returns the text to print. */
  async run(argv: string[], caller: ToolCaller): Promise<string> {
    const [first, second, third, ...rest] = argv;
    if (!first || first === "help" || first === "--help" || first === "-h") return HELP;
    if (first === "list") return this.list(caller);
    const browser = this.deps.findBrowser(first);
    if (!browser) throw new BrowserToolError(`No browser named "${first}". ${this.list(caller)}`, 404);
    this.checkAllowed(browser, caller);
    if (second === undefined) throw new BrowserToolError(`Say what to do with "${browser.name}": tabs, open <url>, or <tab> <command>. Run "help" for all commands.`);
    if (second === "tabs") return this.tabs(browser, caller);
    if (second === "open") return this.open(browser, [third, ...rest].filter((x): x is string => x !== undefined), caller);
    if (!/^\d+$/.test(second)) throw new BrowserToolError(`"${second}" is not a tab id. Use "${browser.name} tabs" to list tabs, or "${browser.name} open <url>" to open yours.`);
    if (third === undefined) throw new BrowserToolError(`Say what to do on tab ${second}. Run "help" for the commands.`);
    return this.onTab(browser, Number(second), third, rest, caller);
  }

  private list(caller: ToolCaller): string {
    const room = caller.as ? this.deps.roomForKey(caller.as) : null;
    const browsers = room ? this.deps.browsersForRoom(room) : this.deps.listBrowsers();
    const lines = browsers.map((b) => {
      const state = this.deps.browsers.status(b.id).state;
      return `- ${b.name} (${state === "running" ? "running" : state === "error" ? "failed" : "stopped; starts on first use"})${b.description ? `: ${b.description}` : ""}`;
    });
    return lines.length > 0 ? `Browsers:\n${lines.join("\n")}` : "No browsers are available.";
  }

  private checkAllowed(browser: Browser, caller: ToolCaller): void {
    if (!caller.as) return;
    const room = this.deps.roomForKey(caller.as);
    if (!room) return;
    if (!room.browserEnabled) throw new BrowserToolError(`Browsers are turned off for the room "${room.title}".`, 403);
    const allowed = this.deps.browsersForRoom(room);
    if (!allowed.some((b) => b.id === browser.id)) {
      throw new BrowserToolError(`The room "${room.title}" can't use "${browser.name}". Its browsers: ${allowed.map((b) => b.name).join(", ") || "none"}.`, 403);
    }
  }

  /** The engine for a browser, starting the browser (and a fresh engine after a browser restart) as needed. */
  private async engineFor(browser: Browser): Promise<Engine> {
    let status = this.deps.browsers.status(browser.id);
    if (status.state !== "running") {
      try {
        status = await this.deps.browsers.ensure(browser.id);
      } catch (error) {
        throw new BrowserToolError(`"${browser.name}" could not start: ${(error as Error).message}`, 503);
      }
    }
    this.deps.browsers.touch(browser.id);
    const existing = this.engines.get(browser.id);
    if (existing && !existing.closed && existing.browserStartedAt === status.startedAt) return existing;
    existing?.close();
    if (!status.cdpUrl) throw new BrowserToolError(`"${browser.name}" has no DevTools address`, 503);
    const engine = new Engine(status.cdpUrl, status.startedAt);
    this.engines.set(browser.id, engine);
    this.deps.log?.("browser engine started", { browser: browser.name });
    return engine;
  }

  private async call(browser: Browser, tool: string, args: Record<string, unknown>): Promise<string> {
    const engine = await this.engineFor(browser);
    const { text, isError } = await engine.callTool(tool, args);
    if (isError) throw new BrowserToolError(text || `${tool} failed`, 422);
    return text;
  }

  private async tabs(browser: Browser, caller: ToolCaller): Promise<string> {
    const engine = await this.engineFor(browser);
    const { text } = await engine.callTool("list_pages", {});
    return this.annotatePages(text, engine, caller);
  }

  /** Mark each tab of a "## Pages" listing with its owner, so an agent sees which tabs are its own. */
  private annotatePages(text: string, engine: Engine, caller: ToolCaller): string {
    return text
      .split("\n")
      .map((line) => {
        const match = PAGE_LINE.exec(line.trim());
        if (!match) return line;
        const owner = engine.owners.get(Number(match[1]));
        const mark = owner === undefined ? "not opened by an agent" : owner === caller.as ? "yours" : `${owner}'s`;
        return `${match[1]}: ${match[2]} [${mark}]`;
      })
      .join("\n");
  }

  private async open(browser: Browser, args: string[], caller: ToolCaller): Promise<string> {
    if (!caller.as) throw new BrowserToolError('Pass --as <your key> (it is in your briefing) so the tab is yours.');
    const url = args.find((a) => !a.startsWith("--"));
    if (!url) throw new BrowserToolError(`Give a URL: ${browser.name} open <url>`);
    const engine = await this.engineFor(browser);
    const { text, isError } = await engine.callTool("new_page", { url, ...(args.includes("--background") ? { background: true } : {}) });
    if (isError) throw new BrowserToolError(text || "the tab did not open", 422);
    const selected = text.split("\n").map((l) => l.trim()).find((l) => l.endsWith("[selected]"));
    const id = selected ? Number(PAGE_LINE.exec(selected)?.[1]) : Number.NaN;
    if (!Number.isFinite(id)) return text;
    engine.owners.set(id, caller.as);
    this.deps.log?.("browser tab opened", { browser: browser.name, tab: id, as: caller.as });
    return `Opened tab ${id} in "${browser.name}" (yours). Next: ${browser.name} ${id} snapshot\n\n${this.annotatePages(text, engine, caller)}`;
  }

  private async onTab(browser: Browser, tab: number, command: string, args: string[], caller: ToolCaller): Promise<string> {
    const spec = TAB_COMMANDS[command];
    if (!spec) throw new BrowserToolError(`Unknown command "${command}". Run "help" for the commands.`);
    const engine = await this.engineFor(browser);
    const owner = engine.owners.get(tab);
    if (!caller.force && (owner === undefined || owner !== caller.as)) {
      const whose = owner === undefined ? "was not opened by an agent (it may be the user's)" : `belongs to ${owner}`;
      throw new BrowserToolError(`Tab ${tab} ${whose}. Open your own with "${browser.name} open <url>", or add --force if you really must use it.`, 403);
    }
    if (caller.force && owner !== caller.as) this.deps.log?.("browser tab forced", { browser: browser.name, tab, as: caller.as, owner: owner ?? null });
    const { tool, args: toolArgs } = spec.build(args, { tab, browser });
    const { text, isError } = await engine.callTool(tool, { pageId: tab, ...toolArgs });
    if (isError) throw new BrowserToolError(text || `${command} failed`, 422);
    if (command === "close") engine.owners.delete(tab);
    // Page lists in the answer (after close or navigation) get the same owner marks as "tabs".
    return text.includes("## Pages") ? this.annotatePages(text, engine, caller) : text || "Done.";
  }
}

type TabCommand = { usage: string; build: (args: string[], context: { tab: number; browser: Browser }) => { tool: string; args: Record<string, unknown> } };

const need = (value: string | undefined, usage: string): string => {
  if (value === undefined || value === "") throw new BrowserToolError(`Usage: <browser> <tab> ${usage}`);
  return value;
};
const words = (args: string[]): string[] => args.filter((a) => !a.startsWith("--"));
const flagValue = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const TAB_COMMANDS: Record<string, TabCommand> = {
  snapshot: { usage: "snapshot [--verbose]", build: (a) => ({ tool: "take_snapshot", args: a.includes("--verbose") ? { verbose: true } : {} }) },
  click: { usage: "click <uid> [--double]", build: (a) => ({ tool: "click", args: { uid: need(words(a)[0], "click <uid>"), ...(a.includes("--double") ? { dblClick: true } : {}) } }) },
  fill: { usage: "fill <uid> <value>", build: (a) => ({ tool: "fill", args: { uid: need(a[0], "fill <uid> <value>"), value: a.slice(1).join(" ") } }) },
  type: {
    usage: "type <text> [--submit <key>]",
    build: (a) => {
      const submit = flagValue(a, "--submit");
      const text = a.filter((x, i) => x !== "--submit" && a[i - 1] !== "--submit").join(" ");
      return { tool: "type_text", args: { text: need(text, "type <text>"), ...(submit ? { submitKey: submit } : {}) } };
    },
  },
  press: { usage: "press <key>", build: (a) => ({ tool: "press_key", args: { key: need(a[0], "press <key> (e.g. Enter, Control+a)") } }) },
  hover: { usage: "hover <uid>", build: (a) => ({ tool: "hover", args: { uid: need(a[0], "hover <uid>") } }) },
  drag: { usage: "drag <from-uid> <to-uid>", build: (a) => ({ tool: "drag", args: { from_uid: need(a[0], "drag <from> <to>"), to_uid: need(a[1], "drag <from> <to>") } }) },
  navigate: { usage: "navigate <url>", build: (a) => ({ tool: "navigate_page", args: { type: "url", url: need(words(a)[0], "navigate <url>") } }) },
  back: { usage: "back", build: () => ({ tool: "navigate_page", args: { type: "back" } }) },
  forward: { usage: "forward", build: () => ({ tool: "navigate_page", args: { type: "forward" } }) },
  reload: { usage: "reload", build: () => ({ tool: "navigate_page", args: { type: "reload" } }) },
  "wait-for": { usage: "wait-for <text> [<or text>…]", build: (a) => ({ tool: "wait_for", args: { text: [need(a[0], "wait-for <text>"), ...a.slice(1)] } }) },
  eval: { usage: 'eval "() => document.title"', build: (a) => ({ tool: "evaluate_script", args: { function: need(a.join(" "), 'eval "() => …"') } }) },
  screenshot: {
    usage: "screenshot [--full] [--out <file.png>]",
    build: (a, { tab, browser }) => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const out = flagValue(a, "--out") ?? join(SCREENSHOT_DIR, `${browser.name}-tab${tab}-${Date.now()}.png`);
      return { tool: "take_screenshot", args: { filePath: out, ...(a.includes("--full") ? { fullPage: true } : {}) } };
    },
  },
  console: { usage: "console", build: () => ({ tool: "list_console_messages", args: {} }) },
  network: { usage: "network", build: () => ({ tool: "list_network_requests", args: {} }) },
  request: { usage: "request <reqid>", build: (a) => ({ tool: "get_network_request", args: { reqid: Number(need(a[0], "request <reqid>")) } }) },
  upload: { usage: "upload <uid> <file>…", build: (a) => ({ tool: "upload_file", args: { uid: need(a[0], "upload <uid> <file>"), filePaths: a.slice(1) } }) },
  dialog: {
    usage: "dialog accept|dismiss [text]",
    build: (a) => ({ tool: "handle_dialog", args: { action: need(a[0], "dialog accept|dismiss") === "dismiss" ? "dismiss" : "accept", ...(a[1] ? { promptText: a.slice(1).join(" ") } : {}) } }),
  },
  front: { usage: "front", build: () => ({ tool: "select_page", args: { bringToFront: true } }) },
  close: { usage: "close", build: () => ({ tool: "close_page", args: {} }) },
};

export const HELP = `rooms-browser: drive the shared Chrome browsers on this machine.

  rooms-browser list                               browsers you can use, what each is for, running or not
  rooms-browser <browser> tabs                     tabs, marked yours / another agent's / not opened by an agent
  rooms-browser <browser> open <url> --as <key>    open your own tab; prints its id
  rooms-browser <browser> <tab> <command> --as <key>

Commands on your tab:
${Object.values(TAB_COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}

snapshot prints the page as text with element uids (1_4); click, fill, hover and upload take those uids, from the
latest snapshot. screenshot saves a PNG and prints its path. A stopped browser starts on first use; its logins persist.
Work only in tabs you opened: other tabs belong to other agents or to the user, and are refused without --force.
Close your tabs when you are done.`;
